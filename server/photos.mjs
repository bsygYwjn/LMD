import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const PHOTO_FORMATS = new Map([
  [".jpg", { native: true }],
  [".jpeg", { native: true }],
  [".jpe", { native: true }],
  [".jfif", { native: true }],
  [".png", { native: true }],
  [".apng", { native: true }],
  [".gif", { native: true }],
  [".webp", { native: true }],
  [".avif", { native: true }],
  [".bmp", { native: true }],
  [".dib", { native: true }],
  [".ico", { native: true }],
  [".svg", { native: true }],
  [".tif", { native: false }],
  [".tiff", { native: false }],
]);
const MAX_ITEMS = 10000;
const MAX_DEPTH = 10;
const STANDARD_SCAN_CONCURRENCY = 3;
const TURBO_SCAN_CONCURRENCY = 12;
const HEADER_BYTES = 512 * 1024;
const THUMBNAIL_SIZES = [512, 1024];

async function mapWithConcurrency(items, limit, mapper, onSettled = null) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
      onSettled?.(results[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, worker));
  return results;
}

async function walkPhotoFiles(rootDirectory, depth = 0, output = [], status = { complete: true, errors: [], truncated: false }) {
  if (depth > MAX_DEPTH || output.length >= MAX_ITEMS) {
    status.complete = false;
    status.truncated = true;
    return output;
  }
  let entries;
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error) {
    status.complete = false;
    status.errors.push({ path: rootDirectory, message: error.message || "无法读取目录" });
    return output;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) await walkPhotoFiles(fullPath, depth + 1, output, status);
    else if (entry.isFile() && PHOTO_FORMATS.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
    if (output.length >= MAX_ITEMS) {
      status.complete = false;
      status.truncated = true;
      break;
    }
  }
  return output;
}

function finiteDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function exifValue(buffer, tiffOffset, littleEndian, type, count, valueOffset) {
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
  const size = sizes[type];
  if (!size || !count) return null;
  const byteLength = size * count;
  const offset = byteLength <= 4 ? valueOffset : tiffOffset + (littleEndian ? buffer.readUInt32LE(valueOffset) : buffer.readUInt32BE(valueOffset));
  if (offset < 0 || offset + byteLength > buffer.length) return null;
  if (type === 2) return buffer.subarray(offset, offset + byteLength).toString("ascii").replace(/\0.*$/, "").trim() || null;
  if (type === 5) {
    const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const values = [];
    for (let index = 0; index < count; index += 1) {
      const numerator = read32.call(buffer, offset + index * 8);
      const denominator = read32.call(buffer, offset + index * 8 + 4);
      if (!denominator) return null;
      values.push(numerator / denominator);
    }
    return count === 1 ? values[0] : values;
  }
  const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  if (count !== 1) return null;
  return type === 3 ? read16.call(buffer, offset) : type === 4 ? read32.call(buffer, offset) : buffer[offset];
}

function exifEntries(buffer, tiffOffset, littleEndian, ifdOffset) {
  const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  if (ifdOffset < 0 || ifdOffset + 2 > buffer.length) return new Map();
  const count = read16.call(buffer, ifdOffset);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = ifdOffset + 2 + index * 12;
    if (offset + 12 > buffer.length) break;
    entries.set(read16.call(buffer, offset), exifValue(buffer, tiffOffset, littleEndian, read16.call(buffer, offset + 2), littleEndian ? buffer.readUInt32LE(offset + 4) : buffer.readUInt32BE(offset + 4), offset + 8));
  }
  return entries;
}

function jpegExifMetadata(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return {};
  let offset = 2;
  while (offset + 10 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 8 || offset + 2 + length > buffer.length) break;
    if (marker === 0xe1 && buffer.subarray(offset + 4, offset + 10).toString("ascii") === "Exif\0\0") {
      const tiffOffset = offset + 10;
      const byteOrder = buffer.subarray(tiffOffset, tiffOffset + 2).toString("ascii");
      if (byteOrder !== "II" && byteOrder !== "MM") return {};
      const littleEndian = byteOrder === "II";
      const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
      const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
      if (read16.call(buffer, tiffOffset + 2) !== 42) return {};
      const root = exifEntries(buffer, tiffOffset, littleEndian, tiffOffset + read32.call(buffer, tiffOffset + 4));
      const exifPointer = root.get(0x8769);
      const gpsPointer = root.get(0x8825);
      const exif = typeof exifPointer === "number" ? exifEntries(buffer, tiffOffset, littleEndian, tiffOffset + exifPointer) : new Map();
      const gps = typeof gpsPointer === "number" ? exifEntries(buffer, tiffOffset, littleEndian, tiffOffset + gpsPointer) : new Map();
      const coordinate = (parts, reference) => Array.isArray(parts) && parts.length === 3 ? (parts[0] + parts[1] / 60 + parts[2] / 3600) * (reference === "S" || reference === "W" ? -1 : 1) : null;
      const latitude = coordinate(gps.get(2), gps.get(1));
      const longitude = coordinate(gps.get(4), gps.get(3));
      const altitude = typeof gps.get(6) === "number" ? gps.get(6) * (gps.get(5) === 1 ? -1 : 1) : null;
      return {
        capturedAt: typeof exif.get(0x9003) === "string" ? exif.get(0x9003) : null,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        altitude: Number.isFinite(altitude) ? altitude : null,
      };
    }
    offset += length + 2;
  }
  return {};
}

function tiffValue(buffer, littleEndian, type, count, valueOffset) {
  const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  if (type === 3 && count === 1) return read16.call(buffer, valueOffset);
  if (type === 4 && count === 1) return read32.call(buffer, valueOffset);
  const pointer = read32.call(buffer, valueOffset);
  if (pointer < 0 || pointer + (type === 3 ? 2 : 4) > buffer.length) return null;
  return type === 3 ? read16.call(buffer, pointer) : type === 4 ? read32.call(buffer, pointer) : null;
}

function tiffDimensions(buffer) {
  if (buffer.length < 16) return null;
  const signature = buffer.subarray(0, 2).toString("ascii");
  if (signature !== "II" && signature !== "MM") return null;
  const littleEndian = signature === "II";
  const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  if (read16.call(buffer, 2) !== 42) return null;
  const directoryOffset = read32.call(buffer, 4);
  if (directoryOffset + 2 > buffer.length) return null;
  const entryCount = read16.call(buffer, directoryOffset);
  let width = null;
  let height = null;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = directoryOffset + 2 + index * 12;
    if (offset + 12 > buffer.length) break;
    const tag = read16.call(buffer, offset);
    if (tag !== 256 && tag !== 257) continue;
    const value = tiffValue(buffer, littleEndian, read16.call(buffer, offset + 2), read32.call(buffer, offset + 4), offset + 8);
    if (tag === 256) width = finiteDimension(value);
    else height = finiteDimension(value);
  }
  return width && height ? { width, height } : null;
}

function dimensionsFromHeader(buffer, extension) {
  if ([".jpg", ".jpeg", ".jpe", ".jfif"].includes(extension)) return jpegDimensions(buffer);
  if ([".png", ".apng"].includes(extension) && buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (extension === ".gif" && buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if ([".bmp", ".dib"].includes(extension) && buffer.length >= 26) {
    const offset = extension === ".bmp" ? 18 : 4;
    return { width: Math.abs(buffer.readInt32LE(offset)), height: Math.abs(buffer.readInt32LE(offset + 4)) };
  }
  if (extension === ".ico" && buffer.length >= 8 && buffer.readUInt16LE(2) === 1) {
    return { width: buffer[6] || 256, height: buffer[7] || 256 };
  }
  if (extension === ".webp" && buffer.length >= 30 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    const kind = buffer.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (kind === "VP8 " && buffer.length >= 30) return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if ([".tif", ".tiff"].includes(extension)) return tiffDimensions(buffer);
  if (extension === ".svg") {
    const text = buffer.toString("utf8");
    const tag = text.match(/<svg\b[^>]*>/i)?.[0] || "";
    const width = finiteDimension(tag.match(/\bwidth\s*=\s*["']\s*([\d.]+)/i)?.[1]);
    const height = finiteDimension(tag.match(/\bheight\s*=\s*["']\s*([\d.]+)/i)?.[1]);
    if (width && height) return { width, height };
    const viewBox = tag.match(/\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (viewBox) return { width: finiteDimension(viewBox[1]), height: finiteDimension(viewBox[2]) };
  }
  return null;
}

async function readImageHeader(filePath) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function createPhotoService({
  appState,
  cacheDirectory,
  saveState,
  stableId,
  getMediaTools,
  runCommand,
  streamFile,
  sendJson,
  readJson,
  requireLocalManagement,
  requireViewerAccess,
  canAccessFolderId,
  pathIsSameOrDescendant,
}) {
  appState.photoLibraries ||= [];
  appState.photoItems ||= [];
  const photoCacheDirectory = path.join(cacheDirectory, "photos");
  const ready = mkdir(photoCacheDirectory, { recursive: true });
  let libraryRevision = 0;
  let activeScan = null;
  let scanContext = null;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastError = null;

  function photoFolderId(libraryId, folderPath) {
    return stableId(`photo:${libraryId}:${path.resolve(folderPath).toLowerCase()}`);
  }

  function libraryForItem(item) {
    return appState.photoLibraries.find((library) => library.id === item.libraryId) || null;
  }

  function folderPathForItem(item) {
    return path.dirname(item.path);
  }

  function ancestorFolderIds(item) {
    const library = libraryForItem(item);
    const rootPath = path.resolve(library?.path || folderPathForItem(item));
    const itemFolderPath = path.resolve(folderPathForItem(item));
    if (!pathIsSameOrDescendant(itemFolderPath, rootPath)) return [photoFolderId(item.libraryId, itemFolderPath)];
    const segments = path.relative(rootPath, itemFolderPath).split(path.sep).filter(Boolean);
    const paths = [rootPath];
    for (const segment of segments) paths.push(path.join(paths.at(-1), segment));
    return paths.map((folderPath) => photoFolderId(item.libraryId, folderPath));
  }

  function accessFolderPathForItem(item) {
    const library = libraryForItem(item);
    const itemFolderPath = path.resolve(folderPathForItem(item));
    const rootPath = path.resolve(library?.path || itemFolderPath);
    if (!pathIsSameOrDescendant(itemFolderPath, rootPath)) return itemFolderPath;
    const segments = path.relative(rootPath, itemFolderPath).split(path.sep).filter(Boolean);
    return segments.length ? path.join(rootPath, ...segments.slice(0, 2)) : rootPath;
  }

  function accessFolderIdForItem(item) {
    return photoFolderId(item.libraryId, accessFolderPathForItem(item));
  }

  function canAccessItem(context, item) {
    if (context?.fullAccess) return true;
    return canAccessFolderId(context, accessFolderIdForItem(item));
  }

  function accessibleItems(context) {
    return appState.photoItems.filter((item) => canAccessItem(context, item));
  }

  function authorizedItem(request, response, itemId) {
    const context = requireViewerAccess(request, response);
    if (!context) return null;
    const item = appState.photoItems.find((candidate) => candidate.id === itemId);
    if (!item || !canAccessItem(context, item)) {
      sendJson(response, 404, { error: "找不到图片，或当前用户没有这个图片文件夹的访问权限。" });
      return null;
    }
    return item;
  }

  function scanStatus() {
    return {
      enabled: true,
      scanning: Boolean(activeScan),
      intervalSeconds: Number(appState.settings.autoScanIntervalSeconds) || 30,
      lastStartedAt,
      lastCompletedAt,
      lastError,
      id: scanContext?.id || null,
      mode: scanContext?.mode || null,
      pendingMode: null,
      phase: scanContext?.phase || "idle",
      progressPercent: scanContext?.progressPercent ?? null,
      discoveredFiles: scanContext?.discoveredFiles || 0,
      processedFiles: scanContext?.processedFiles || 0,
      totalFiles: scanContext?.totalFiles || 0,
      processedLibraries: scanContext?.processedLibraries || 0,
      totalLibraries: scanContext?.totalLibraries || appState.photoLibraries.length,
      maxParallelFiles: scanContext?.maxParallelFiles || 0,
      maxParallelMediaTools: scanContext?.maxParallelFiles || 0,
    };
  }

  async function probeDimensions(filePath, extension) {
    const headerDimensions = dimensionsFromHeader(await readImageHeader(filePath).catch(() => Buffer.alloc(0)), extension);
    if (headerDimensions?.width && headerDimensions?.height) return headerDimensions;
    const tools = getMediaTools();
    if (!tools.available) return { width: null, height: null };
    try {
      const result = await runCommand(tools.ffprobe, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath,
      ], 30000);
      const stream = JSON.parse(result.stdout || "{}").streams?.[0] || {};
      return { width: finiteDimension(stream.width), height: finiteDimension(stream.height) };
    } catch {
      return { width: null, height: null };
    }
  }

  async function ensureVariant(sourcePath, outputPath, maximumSize) {
    const existing = await stat(outputPath).catch(() => null);
    if (existing?.isFile() && existing.size > 0) return outputPath;
    const tools = getMediaTools();
    if (!tools.available || path.extname(sourcePath).toLowerCase() === ".svg") return null;
    const partialPath = `${outputPath}.${randomUUID()}.partial.webp`;
    try {
      await runCommand(tools.ffmpeg, [
        "-y", "-v", "error", "-i", sourcePath, "-frames:v", "1",
        "-vf", `scale=${maximumSize}:${maximumSize}:force_original_aspect_ratio=decrease`,
        "-c:v", "libwebp", "-q:v", "78", partialPath,
      ], 120000);
      const partialStat = await stat(partialPath).catch(() => null);
      if (!partialStat?.isFile() || partialStat.size <= 0) return null;
      await rename(partialPath, outputPath);
      return outputPath;
    } catch (error) {
      console.error(`生成图片预览失败 ${sourcePath}: ${error.message}`);
      return null;
    } finally {
      await unlink(partialPath).catch(() => {});
    }
  }

  async function imageVariants(filePath, itemId, signature, browserNative) {
    await ready;
    const cacheKey = stableId(`photo-cache:${itemId}:${signature}`);
    const thumbnailPaths = {};
    for (const size of THUMBNAIL_SIZES) {
      const outputPath = path.join(photoCacheDirectory, `${cacheKey}-${size}.webp`);
      const generated = await ensureVariant(filePath, outputPath, size);
      if (generated) thumbnailPaths[size] = generated;
    }
    const previewPath = browserNative
      ? null
      : await ensureVariant(filePath, path.join(photoCacheDirectory, `${cacheKey}-preview.webp`), 4096);
    return { thumbnailPaths, previewPath };
  }

  async function scanItem(filePath, library, previous = null) {
    const fileStat = await stat(filePath);
    const identityPath = await realpath(filePath).catch(() => path.resolve(filePath));
    const extensionWithDot = path.extname(filePath).toLowerCase();
    const format = PHOTO_FORMATS.get(extensionWithDot);
    const signature = `${fileStat.size}:${Math.round(fileStat.mtimeMs)}`;
    const id = stableId(`photo-item:${identityPath.toLowerCase()}`);
    const unchanged = previous?.sourceSignature === signature;
    const header = unchanged ? null : await readImageHeader(filePath).catch(() => Buffer.alloc(0));
    const dimensions = unchanged
      ? { width: finiteDimension(previous.width), height: finiteDimension(previous.height) }
      : dimensionsFromHeader(header, extensionWithDot) || await probeDimensions(filePath, extensionWithDot);
    const metadata = unchanged ? previous : extensionWithDot === ".jpg" || extensionWithDot === ".jpeg" || extensionWithDot === ".jpe" || extensionWithDot === ".jfif" ? jpegExifMetadata(header) : {};
    const variants = unchanged
      ? { thumbnailPaths: previous.thumbnailPaths || {}, previewPath: previous.previewPath || null }
      : await imageVariants(filePath, id, signature, format.native);
    return {
      id,
      libraryId: library.id,
      path: path.resolve(filePath),
      fileName: path.basename(filePath),
      title: path.basename(filePath, extensionWithDot).trim() || path.basename(filePath),
      extension: extensionWithDot.slice(1).toUpperCase(),
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      sourceSignature: signature,
      browserNative: format.native,
      width: dimensions.width,
      height: dimensions.height,
      capturedAt: metadata.capturedAt || null,
      latitude: Number.isFinite(metadata.latitude) ? metadata.latitude : null,
      longitude: Number.isFinite(metadata.longitude) ? metadata.longitude : null,
      altitude: Number.isFinite(metadata.altitude) ? metadata.altitude : null,
      thumbnailPaths: variants.thumbnailPaths,
      previewPath: variants.previewPath,
    };
  }

  function mostSpecificLibrary(filePath, libraries) {
    return libraries
      .filter((library) => pathIsSameOrDescendant(filePath, library.path))
      .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length || left.id.localeCompare(right.id))[0] || null;
  }

  async function cleanOrphanedCacheFiles() {
    await ready;
    const referenced = new Set();
    for (const item of appState.photoItems) {
      if (item.previewPath) referenced.add(path.resolve(item.previewPath).toLowerCase());
      for (const filePath of Object.values(item.thumbnailPaths || {})) referenced.add(path.resolve(filePath).toLowerCase());
    }
    const entries = await readdir(photoCacheDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(photoCacheDirectory, entry.name);
      if (!referenced.has(path.resolve(filePath).toLowerCase())) await unlink(filePath).catch(() => {});
    }
  }

  async function scanLibraries({ mode = "standard" } = {}) {
    await ready;
    if (activeScan) return activeScan;
    const normalizedMode = mode === "turbo" ? "turbo" : "standard";
    const revision = libraryRevision;
    const libraries = appState.photoLibraries.map((library) => ({ ...library }));
    scanContext = {
      id: randomUUID(),
      mode: normalizedMode,
      phase: "discovering",
      progressPercent: 0,
      discoveredFiles: 0,
      processedFiles: 0,
      totalFiles: 0,
      processedLibraries: 0,
      totalLibraries: libraries.length,
      maxParallelFiles: normalizedMode === "turbo" ? TURBO_SCAN_CONCURRENCY : STANDARD_SCAN_CONCURRENCY,
      cancelRequested: false,
    };
    lastStartedAt = new Date().toISOString();
    lastError = null;
    activeScan = (async () => {
      const previousItems = new Map(appState.photoItems.map((item) => [path.resolve(item.path).toLowerCase(), item]));
      const filesByIdentity = new Map();
      const incompleteLibraries = [];
      for (const library of libraries) {
        if (scanContext.cancelRequested) throw Object.assign(new Error("图片库扫描已停止"), { code: "PHOTO_SCAN_CANCELLED" });
        const status = { complete: true, errors: [], truncated: false };
        const found = await walkPhotoFiles(library.path, 0, [], status);
        if (!status.complete) incompleteLibraries.push({ library, status });
        for (const filePath of found) {
          const identity = await realpath(filePath).catch(() => path.resolve(filePath));
          const owner = mostSpecificLibrary(filePath, libraries) || library;
          filesByIdentity.set(identity.toLowerCase(), { filePath: path.resolve(filePath), library: owner });
        }
        scanContext.discoveredFiles = filesByIdentity.size;
        scanContext.processedLibraries += 1;
      }
      if (revision !== libraryRevision) throw Object.assign(new Error("图片目录在扫描期间发生变化，请重新扫描。"), { code: "PHOTO_LIBRARY_CHANGED_DURING_SCAN" });
      scanContext.phase = "processing";
      const files = [...filesByIdentity.values()];
      scanContext.totalFiles = files.length;
      const scanned = await mapWithConcurrency(files, scanContext.maxParallelFiles, async ({ filePath, library }) => {
        if (scanContext.cancelRequested) throw Object.assign(new Error("图片库扫描已停止"), { code: "PHOTO_SCAN_CANCELLED" });
        return scanItem(filePath, library, previousItems.get(path.resolve(filePath).toLowerCase()));
      }, () => {
        scanContext.processedFiles += 1;
        scanContext.progressPercent = scanContext.totalFiles ? Math.min(95, Math.round(scanContext.processedFiles / scanContext.totalFiles * 95)) : 95;
      });
      if (incompleteLibraries.length) throw new Error(`部分图片目录未能完整读取：${incompleteLibraries.map(({ library }) => library.name).join("、")}`);
      if (revision !== libraryRevision) throw Object.assign(new Error("图片目录在扫描期间发生变化，请重新扫描。"), { code: "PHOTO_LIBRARY_CHANGED_DURING_SCAN" });
      scanContext.phase = "finalizing";
      scanContext.progressPercent = 98;
      appState.photoItems = scanned;
      await saveState();
      await cleanOrphanedCacheFiles();
      lastCompletedAt = new Date().toISOString();
      scanContext.phase = "completed";
      scanContext.progressPercent = 100;
      return appState.photoItems;
    })();
    try {
      return await activeScan;
    } catch (error) {
      if (error.code === "PHOTO_SCAN_CANCELLED") {
        scanContext.phase = "cancelled";
        lastError = null;
      } else {
        scanContext.phase = "failed";
        lastError = error.message;
      }
      throw error;
    } finally {
      activeScan = null;
    }
  }

  function folderNodes(items = appState.photoItems) {
    const librariesById = new Map(appState.photoLibraries.map((library) => [library.id, library]));
    const nodes = new Map();
    for (const item of [...items].sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true, sensitivity: "base" }))) {
      const library = librariesById.get(item.libraryId);
      const itemFolder = path.resolve(folderPathForItem(item));
      const root = library?.path && pathIsSameOrDescendant(itemFolder, library.path) ? path.resolve(library.path) : itemFolder;
      const segments = path.relative(root, itemFolder).split(path.sep).filter(Boolean);
      const paths = [root];
      for (const segment of segments) paths.push(path.join(paths.at(-1), segment));
      let parentId = null;
      for (const [index, folderPath] of paths.entries()) {
        const id = photoFolderId(item.libraryId, folderPath);
        let node = nodes.get(id);
        if (!node) {
          const name = path.basename(folderPath) || library?.name || "图片目录";
          node = {
            id,
            parentId,
            name,
            title: index === 0 ? library?.name || name : name,
            configured: false,
            directMediaCount: 0,
            mediaCount: 0,
            childCount: 0,
            coverMediaId: item.id,
            kind: "photo",
            path: folderPath,
          };
          nodes.set(id, node);
        }
        node.mediaCount += 1;
        if (index === paths.length - 1) node.directMediaCount += 1;
        parentId = id;
      }
    }
    for (const node of nodes.values()) if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).childCount += 1;
    return [...nodes.values()].sort((left, right) => (left.parentId || "").localeCompare(right.parentId || "") || left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function publicItem(item, includeLocalPath = false) {
    const hasThumbnail = Object.keys(item.thumbnailPaths || {}).length > 0;
    const previewAvailable = item.browserNative || Boolean(item.previewPath);
    return {
      id: item.id,
      libraryId: item.libraryId,
      title: item.title,
      fileName: item.fileName,
      ...(includeLocalPath ? { path: item.path } : {}),
      extension: item.extension,
      size: item.size,
      modifiedAt: item.modifiedAt,
      width: item.width || null,
      height: item.height || null,
      capturedAt: item.capturedAt || null,
      latitude: Number.isFinite(item.latitude) ? item.latitude : null,
      longitude: Number.isFinite(item.longitude) ? item.longitude : null,
      altitude: Number.isFinite(item.altitude) ? item.altitude : null,
      aspectRatio: item.width && item.height ? item.width / item.height : null,
      folderId: photoFolderId(item.libraryId, folderPathForItem(item)),
      thumbnailUrl: hasThumbnail ? `/api/photos/items/${item.id}/thumbnail?size=512` : previewAvailable ? `/api/photos/items/${item.id}/preview` : null,
      thumbnailSrcSet: hasThumbnail ? `/api/photos/items/${item.id}/thumbnail?size=512 512w, /api/photos/items/${item.id}/thumbnail?size=1024 1024w` : null,
      previewUrl: previewAvailable ? `/api/photos/items/${item.id}/preview` : null,
      downloadUrl: `/api/photos/items/${item.id}/file?download=1`,
      previewAvailable,
    };
  }

  function displayFolderSummaries() {
    return folderNodes().map((folder) => ({
      id: folder.id,
      path: folder.path,
      folderName: folder.name,
      title: folder.title,
      season: 1,
      configured: false,
      mediaCount: folder.mediaCount,
      customTitle: "",
      sampleAlias: "",
      kind: "photo",
    }));
  }

  function accessFolderSummaries() {
    const folders = new Map();
    for (const item of appState.photoItems) {
      const library = libraryForItem(item);
      const folderPath = accessFolderPathForItem(item);
      const id = photoFolderId(item.libraryId, folderPath);
      const relativePath = library?.path && pathIsSameOrDescendant(folderPath, library.path)
        ? path.relative(path.resolve(library.path), folderPath).split(path.sep).filter(Boolean).join(" / ")
        : path.basename(folderPath);
      let folder = folders.get(id);
      if (!folder) {
        const title = relativePath || `${library?.name || path.basename(folderPath) || "图片目录"}（直属文件）`;
        folder = {
          id,
          path: folderPath,
          folderName: relativePath ? path.basename(folderPath) : title,
          title,
          season: 1,
          configured: false,
          mediaCount: 0,
          customTitle: "",
          sampleAlias: "",
          kind: "photo",
          libraryName: library?.name || "图片目录",
          relativePath: relativePath || "直属文件",
        };
        folders.set(id, folder);
      }
      folder.mediaCount += 1;
    }
    return [...folders.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function accessFolderAliases() {
    return appState.photoItems.flatMap((item) => ancestorFolderIds(item).map((folderId) => [folderId, accessFolderIdForItem(item)]));
  }

  async function handleRequest(request, response, url, pathname) {
    if (!pathname.startsWith("/api/photos/")) return false;
    if (request.method === "GET" && pathname === "/api/photos/catalog") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      const items = accessibleItems(context);
      return sendJson(response, 200, { items: items.map((item) => publicItem(item)), folders: folderNodes(items).map(({ path: _path, ...folder }) => folder), scan: scanStatus() }), true;
    }
    if (request.method === "POST" && pathname === "/api/photos/catalog/scan") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      await scanLibraries({ mode: url.searchParams.get("mode") || "standard" });
      return sendJson(response, 200, { count: accessibleItems(context).length, scan: scanStatus() }), true;
    }
    if (request.method === "GET" && pathname === "/api/photos/overview") {
      if (!requireLocalManagement(request, response)) return true;
      return sendJson(response, 200, { libraries: appState.photoLibraries, items: appState.photoItems.map((item) => publicItem(item, true)), scanning: Boolean(activeScan), scan: scanStatus() }), true;
    }
    if (request.method === "POST" && pathname === "/api/photos/libraries") {
      if (!requireLocalManagement(request, response)) return true;
      const body = await readJson(request);
      if (!body.folderPath || !path.isAbsolute(body.folderPath)) return sendJson(response, 400, { error: "请输入完整的 Windows 图片文件夹路径。" }), true;
      const folderPath = path.resolve(body.folderPath);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "找不到这个图片文件夹，或当前程序没有读取权限。" }), true;
      let library = appState.photoLibraries.find((item) => item.path.toLowerCase() === folderPath.toLowerCase());
      const added = !library;
      if (added) {
        library = { id: stableId(`photo-library:${folderPath.toLowerCase()}`), path: folderPath, name: String(body.name || path.basename(folderPath) || folderPath).trim() };
        appState.photoLibraries.push(library);
        libraryRevision += 1;
        await saveState();
      }
      return sendJson(response, 201, { libraries: appState.photoLibraries, library, added }), true;
    }
    if (request.method === "DELETE" && /^\/api\/photos\/libraries\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return true;
      const id = pathname.split("/").pop();
      const library = appState.photoLibraries.find((item) => item.id === id);
      if (!library) return sendJson(response, 404, { error: "找不到这个图片目录，它可能已经被删除。" }), true;
      const removedItems = appState.photoItems.filter((item) => item.libraryId === id);
      const removedFolderIds = new Set(removedItems.flatMap((item) => ancestorFolderIds(item)));
      appState.photoLibraries = appState.photoLibraries.filter((item) => item.id !== id);
      appState.photoItems = appState.photoItems.filter((item) => item.libraryId !== id);
      for (const category of appState.accessControl.categories) category.folderIds = category.folderIds.filter((folderId) => !removedFolderIds.has(folderId));
      libraryRevision += 1;
      await saveState();
      await cleanOrphanedCacheFiles();
      return sendJson(response, 200, { ok: true, removedItemCount: removedItems.length }), true;
    }
    if (request.method === "POST" && pathname === "/api/photos/scan/stop") {
      if (!requireLocalManagement(request, response)) return true;
      if (scanContext) scanContext.cancelRequested = true;
      return sendJson(response, 200, { scan: scanStatus() }), true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/photos\/items\/[^/]+\/file$/.test(pathname)) {
      const item = authorizedItem(request, response, pathname.split("/")[4]);
      if (!item) return true;
      await streamFile(request, response, item.path, false, { disposition: url.searchParams.get("download") === "1" ? "attachment" : "inline" });
      return true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/photos\/items\/[^/]+\/preview$/.test(pathname)) {
      const item = authorizedItem(request, response, pathname.split("/")[4]);
      if (!item) return true;
      const filePath = item.browserNative ? item.path : item.previewPath;
      if (!filePath) return sendJson(response, 415, { error: "当前缺少 TIFF 兼容预览，请安装 FFmpeg 后重新扫描；原图仍可下载。" }), true;
      await streamFile(request, response, filePath, false, { cacheControl: item.browserNative ? "private, max-age=0, must-revalidate" : "private, max-age=31536000, immutable" });
      return true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/photos\/items\/[^/]+\/thumbnail$/.test(pathname)) {
      const item = authorizedItem(request, response, pathname.split("/")[4]);
      if (!item) return true;
      const size = url.searchParams.get("size") === "1024" ? 1024 : 512;
      const filePath = item.thumbnailPaths?.[size] || item.thumbnailPaths?.[1024] || item.thumbnailPaths?.[512] || (item.browserNative ? item.path : item.previewPath);
      if (!filePath) return sendJson(response, 404, { error: "这张图片暂时没有可用缩略图。" }), true;
      await streamFile(request, response, filePath, false, { cacheControl: item.thumbnailPaths?.[size] ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate" });
      return true;
    }
    sendJson(response, 404, { error: "没有找到这个图片地址。" });
    return true;
  }

  return {
    handleRequest,
    scanLibraries,
    scanStatus,
    isScanning: () => Boolean(activeScan),
    requestStopScan: () => { if (scanContext) scanContext.cancelRequested = true; },
    cleanOrphanedCacheFiles,
    folderNodes,
    displayFolderSummaries,
    accessFolderSummaries,
    accessFolderAliases,
    allFolderIds: () => accessFolderSummaries().map((folder) => folder.id),
  };
}
