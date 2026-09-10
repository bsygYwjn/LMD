import { access, mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";

const inflateRawAsync = promisify(inflateRaw);
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_COVER_BYTES = 24 * 1024 * 1024;
const MAX_FB2_BYTES = 32 * 1024 * 1024;
const IMAGE_EXTENSION_PATTERN = /\.(?:avif|gif|jpe?g|png|webp)$/i;

function normalizeArchivePath(value) {
  return path.posix.normalize(String(value || "").replaceAll("\\", "/").replace(/^\/+/, "")).replace(/^\.\//, "");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function xmlAttribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeXml(match[2]) : "";
}

function imageKind(buffer, fileName = "") {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: ".jpg", contentType: "image/jpeg" };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: ".png", contentType: "image/png" };
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return { extension: ".gif", contentType: "image/gif" };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { extension: ".webp", contentType: "image/webp" };
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".avif") return { extension, contentType: "image/avif" };
  return null;
}

async function readAt(handle, length, position) {
  const output = Buffer.alloc(length);
  const { bytesRead } = await handle.read(output, 0, length, position);
  return output.subarray(0, bytesRead);
}

async function openZip(filePath) {
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    const tailLength = Math.min(fileStat.size, 65_557);
    const tail = await readAt(handle, tailLength, fileStat.size - tailLength);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === ZIP_END_SIGNATURE) { endOffset = index; break; }
    }
    if (endOffset < 0) throw new Error("找不到 ZIP 中央目录");
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > fileStat.size) throw new Error("ZIP 中央目录超出安全范围");
    const central = await readAt(handle, centralSize, centralOffset);
    const entries = [];
    for (let cursor = 0; cursor + 46 <= central.length;) {
      if (central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) break;
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = normalizeArchivePath(nameBuffer.toString(flags & 0x0800 ? "utf8" : "latin1"));
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    const byName = new Map(entries.map((entry) => [entry.name.toLocaleLowerCase("en-US"), entry]));
    return {
      entries,
      async readEntry(entryOrName, maxBytes = MAX_COVER_BYTES) {
        const entry = typeof entryOrName === "string" ? byName.get(normalizeArchivePath(entryOrName).toLocaleLowerCase("en-US")) : entryOrName;
        if (!entry || entry.compressedSize > maxBytes || entry.uncompressedSize > maxBytes) return null;
        const local = await readAt(handle, 30, entry.localOffset);
        if (local.length < 30 || local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) return null;
        const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const compressed = await readAt(handle, entry.compressedSize, dataOffset);
        if (compressed.length !== entry.compressedSize) return null;
        const result = entry.method === 0 ? compressed : entry.method === 8 ? await inflateRawAsync(compressed, { maxOutputLength: maxBytes }) : null;
        return result && result.length <= maxBytes ? result : null;
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function resolveArchiveHref(baseFile, href) {
  const cleanHref = decodeXml(href).split(/[?#]/, 1)[0];
  let decoded = cleanHref;
  try { decoded = decodeURIComponent(cleanHref); } catch { /* 保留原始路径。 */ }
  return normalizeArchivePath(path.posix.join(path.posix.dirname(baseFile), decoded));
}

async function extractEpubCover(filePath) {
  const archive = await openZip(filePath);
  try {
    const container = await archive.readEntry("META-INF/container.xml", 1024 * 1024);
    const rootFile = container?.toString("utf8").match(/<rootfile\b[^>]*>/i)?.[0];
    const packagePath = normalizeArchivePath(xmlAttribute(rootFile, "full-path"));
    const packageBuffer = packagePath ? await archive.readEntry(packagePath, 4 * 1024 * 1024) : null;
    const packageXml = packageBuffer?.toString("utf8") || "";
    const manifestItems = [...packageXml.matchAll(/<item\b[^>]*>/gi)].map(([tag]) => ({
      id: xmlAttribute(tag, "id"),
      href: xmlAttribute(tag, "href"),
      mediaType: xmlAttribute(tag, "media-type"),
      properties: xmlAttribute(tag, "properties"),
    }));
    let manifestItem = manifestItems.find((item) => item.properties.split(/\s+/).includes("cover-image"));
    if (!manifestItem) {
      const coverMeta = [...packageXml.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag).find((tag) => xmlAttribute(tag, "name").toLowerCase() === "cover");
      const coverId = xmlAttribute(coverMeta, "content");
      if (coverId) manifestItem = manifestItems.find((item) => item.id === coverId);
    }
    manifestItem ||= manifestItems.find((item) => item.mediaType.startsWith("image/") && /(?:^|[\/_\-.])(cover|front|封面)(?:[\/_\-.]|$)/iu.test(item.href));
    const declaredPath = manifestItem?.href && packagePath ? resolveArchiveHref(packagePath, manifestItem.href) : "";
    const fallback = archive.entries
      .filter((entry) => IMAGE_EXTENSION_PATTERN.test(entry.name))
      .sort((left, right) => Number(!/(?:^|[\/_\-.])(cover|front|封面)(?:[\/_\-.]|$)/iu.test(left.name)) - Number(!/(?:^|[\/_\-.])(cover|front|封面)(?:[\/_\-.]|$)/iu.test(right.name)) || left.name.localeCompare(right.name, "en", { numeric: true }))[0];
    const selected = declaredPath || fallback;
    if (!selected) return null;
    const buffer = await archive.readEntry(selected);
    const kind = buffer && imageKind(buffer, typeof selected === "string" ? selected : selected.name);
    return kind ? { buffer, ...kind } : null;
  } finally {
    await archive.close();
  }
}

async function extractCbzCover(filePath) {
  const archive = await openZip(filePath);
  try {
    const selected = archive.entries
      .filter((entry) => IMAGE_EXTENSION_PATTERN.test(entry.name))
      .sort((left, right) => Number(!/(?:^|[\/_\-.])(cover|front|封面)(?:[\/_\-.]|$)/iu.test(left.name)) - Number(!/(?:^|[\/_\-.])(cover|front|封面)(?:[\/_\-.]|$)/iu.test(right.name)) || left.name.localeCompare(right.name, "en", { numeric: true }))[0];
    if (!selected) return null;
    const buffer = await archive.readEntry(selected);
    const kind = buffer && imageKind(buffer, selected.name);
    return kind ? { buffer, ...kind } : null;
  } finally {
    await archive.close();
  }
}

async function extractFb2Cover(filePath) {
  const handle = await open(filePath, "r");
  let file;
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_FB2_BYTES) return null;
    // 读取长度固定为已检查的大小，避免文件增长后产生无界读取。
    file = await readAt(handle, fileStat.size, 0);
    if (file.length !== fileStat.size) return null;
  } finally {
    await handle.close();
  }
  const xml = file.toString("utf8");
  const coverTag = xml.match(/<coverpage\b[\s\S]*?<\/coverpage>/i)?.[0] || "";
  const imageTag = coverTag.match(/<image\b[^>]*>/i)?.[0] || "";
  const reference = xmlAttribute(imageTag, "(?:xlink:)?href").replace(/^#/, "");
  if (!reference) return null;
  const binary = [...xml.matchAll(/<binary\b[^>]*>([\s\S]*?)<\/binary>/gi)].find(([tag]) => xmlAttribute(tag, "id") === reference);
  if (!binary) return null;
  const buffer = Buffer.from(binary[1].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_COVER_BYTES) return null;
  const kind = imageKind(buffer);
  return kind ? { buffer, ...kind } : null;
}

export async function prepareReadingCover({ item, previous, cacheDirectory, stableId }) {
  const signature = stableId(`reading-cover:${item.id}:${item.modifiedAt}:${item.size}`);
  if (previous?.coverSignature === signature) {
    if (!previous.coverPath || await access(previous.coverPath).then(() => true).catch(() => false)) {
      return { coverPath: previous.coverPath || null, coverSignature: signature };
    }
  }
  let extracted = null;
  try {
    if (item.extension === "EPUB") extracted = await extractEpubCover(item.path);
    else if (item.extension === "CBZ") extracted = await extractCbzCover(item.path);
    else if (item.extension === "FB2") extracted = await extractFb2Cover(item.path);
  } catch (error) {
    console.warn(`无法在服务端提取阅读封面“${item.fileName}”：${error.message}`);
  }
  if (!extracted) return { coverPath: null, coverSignature: signature };
  const directory = path.join(cacheDirectory, "reading-covers");
  await mkdir(directory, { recursive: true });
  const coverPath = path.join(directory, `${item.id}-${signature}${extracted.extension}`);
  if (!await access(coverPath).then(() => true).catch(() => false)) {
    const temporaryPath = `${coverPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, extracted.buffer);
    await rename(temporaryPath, coverPath);
  }
  return { coverPath, coverSignature: signature };
}
