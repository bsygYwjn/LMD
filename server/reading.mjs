import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { prepareReadingCover } from "./reading-cover.mjs";

const READING_FORMATS = new Map([
  [".pdf", "ebook"],
  [".epub", "ebook"],
  [".mobi", "ebook"],
  [".azw", "ebook"],
  [".azw3", "ebook"],
  [".fb2", "ebook"],
  [".cbz", "ebook"],
  [".txt", "ebook"],
  [".xlsx", "spreadsheet"],
  [".xls", "spreadsheet"],
  [".xlsm", "spreadsheet"],
  [".xlsb", "spreadsheet"],
  [".csv", "spreadsheet"],
  [".ods", "spreadsheet"],
]);
const MAX_ITEMS = 10000;
const MAX_DEPTH = 10;
const STANDARD_SCAN_CONCURRENCY = 3;
const TURBO_SCAN_CONCURRENCY = 24;

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

async function walkReadingFiles(rootDirectory, depth = 0, output = [], status = { complete: true, errors: [], truncated: false }) {
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
    if (entry.isDirectory()) await walkReadingFiles(fullPath, depth + 1, output, status);
    else if (entry.isFile() && READING_FORMATS.has(path.extname(entry.name).toLowerCase())) output.push(fullPath);
    if (output.length >= MAX_ITEMS) {
      status.complete = false;
      status.truncated = true;
      break;
    }
  }
  return output;
}

export function createReadingService({
  appState,
  cacheDirectory,
  saveState,
  stableId,
  streamFile,
  sendJson,
  readJson,
  requireLocalManagement,
  requireViewerAccess,
  canAccessFolderId,
  pathIsSameOrDescendant,
}) {
  appState.readingLibraries ||= [];
  appState.readingItems ||= [];
  let libraryRevision = 0;
  let activeScan = null;
  let scanContext = null;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastError = null;

  function readingFolderId(libraryId, folderPath) {
    return stableId(`reading:${libraryId}:${path.resolve(folderPath).toLowerCase()}`);
  }

  function libraryForItem(item) {
    return appState.readingLibraries.find((library) => library.id === item.libraryId) || null;
  }

  function folderPathForItem(item) {
    return path.dirname(item.path);
  }

  function ancestorFolderIds(item) {
    const library = libraryForItem(item);
    const rootPath = path.resolve(library?.path || folderPathForItem(item));
    const itemFolderPath = path.resolve(folderPathForItem(item));
    if (!pathIsSameOrDescendant(itemFolderPath, rootPath)) return [readingFolderId(item.libraryId, itemFolderPath)];
    const segments = path.relative(rootPath, itemFolderPath).split(path.sep).filter(Boolean);
    const paths = [rootPath];
    for (const segment of segments) paths.push(path.join(paths.at(-1), segment));
    return paths.map((folderPath) => readingFolderId(item.libraryId, folderPath));
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
    return readingFolderId(item.libraryId, accessFolderPathForItem(item));
  }

  function canAccessItem(context, item) {
    if (context?.fullAccess) return true;
    return canAccessFolderId(context, accessFolderIdForItem(item));
  }

  function accessibleItems(context) {
    return appState.readingItems.filter((item) => canAccessItem(context, item));
  }

  function authorizedItem(request, response, itemId) {
    const context = requireViewerAccess(request, response);
    if (!context) return null;
    const item = appState.readingItems.find((candidate) => candidate.id === itemId);
    if (!item || !canAccessItem(context, item)) {
      sendJson(response, 404, { error: "找不到文件，或当前用户没有这个阅读文件夹的访问权限。" });
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
      totalLibraries: scanContext?.totalLibraries || appState.readingLibraries.length,
      maxParallelFiles: scanContext?.maxParallelFiles || 0,
      maxParallelMediaTools: 0,
    };
  }

  async function scanItem(filePath, library, previous = null) {
    const fileStat = await stat(filePath);
    const identityPath = await realpath(filePath).catch(() => path.resolve(filePath));
    const extensionWithDot = path.extname(filePath).toLowerCase();
    const kind = READING_FORMATS.get(extensionWithDot);
    const item = {
      id: stableId(`reading-item:${identityPath.toLowerCase()}`),
      libraryId: library.id,
      path: path.resolve(filePath),
      fileName: path.basename(filePath),
      title: path.basename(filePath, extensionWithDot).trim() || path.basename(filePath),
      extension: extensionWithDot.slice(1).toUpperCase(),
      kind,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    };
    const cover = await prepareReadingCover({ item, previous, cacheDirectory, stableId });
    return { ...item, ...cover };
  }

  function mostSpecificLibrary(filePath, libraries) {
    return libraries
      .filter((library) => pathIsSameOrDescendant(filePath, library.path))
      .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length || left.id.localeCompare(right.id))[0] || null;
  }

  async function scanLibraries({ mode = "standard" } = {}) {
    if (activeScan) return activeScan;
    const normalizedMode = mode === "turbo" ? "turbo" : "standard";
    const revision = libraryRevision;
    const libraries = appState.readingLibraries.map((library) => ({ ...library }));
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
      const filesByIdentity = new Map();
      const incompleteLibraries = [];
      for (const library of libraries) {
        if (scanContext.cancelRequested) throw Object.assign(new Error("阅读库扫描已停止"), { code: "READING_SCAN_CANCELLED" });
        const status = { complete: true, errors: [], truncated: false };
        const found = await walkReadingFiles(library.path, 0, [], status);
        if (!status.complete) incompleteLibraries.push({ library, status });
        for (const filePath of found) {
          const identity = await realpath(filePath).catch(() => path.resolve(filePath));
          const owner = mostSpecificLibrary(filePath, libraries) || library;
          filesByIdentity.set(identity.toLowerCase(), { filePath: path.resolve(filePath), library: owner });
        }
        scanContext.discoveredFiles = filesByIdentity.size;
        scanContext.processedLibraries += 1;
      }
      if (revision !== libraryRevision) throw Object.assign(new Error("阅读目录在扫描期间发生变化，请重新扫描。"), { code: "READING_LIBRARY_CHANGED_DURING_SCAN" });
      scanContext.phase = "processing";
      const files = [...filesByIdentity.values()];
      const previousItems = new Map(appState.readingItems.map((item) => [path.resolve(item.path).toLowerCase(), item]));
      scanContext.totalFiles = files.length;
      const scanned = await mapWithConcurrency(files, scanContext.maxParallelFiles, async ({ filePath, library }) => {
        if (scanContext.cancelRequested) throw Object.assign(new Error("阅读库扫描已停止"), { code: "READING_SCAN_CANCELLED" });
        return scanItem(filePath, library, previousItems.get(path.resolve(filePath).toLowerCase()) || null);
      }, () => {
        scanContext.processedFiles += 1;
        scanContext.progressPercent = scanContext.totalFiles ? Math.min(95, Math.round(scanContext.processedFiles / scanContext.totalFiles * 95)) : 95;
      });
      if (incompleteLibraries.length) throw new Error(`部分阅读目录未能完整读取：${incompleteLibraries.map(({ library }) => library.name).join("、")}`);
      if (revision !== libraryRevision) throw Object.assign(new Error("阅读目录在扫描期间发生变化，请重新扫描。"), { code: "READING_LIBRARY_CHANGED_DURING_SCAN" });
      scanContext.phase = "finalizing";
      scanContext.progressPercent = 98;
      appState.readingItems = scanned;
      await saveState();
      lastCompletedAt = new Date().toISOString();
      scanContext.phase = "completed";
      scanContext.progressPercent = 100;
      return appState.readingItems;
    })();
    try {
      return await activeScan;
    } catch (error) {
      if (error.code === "READING_SCAN_CANCELLED") {
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

  function folderNodes(items = appState.readingItems) {
    const librariesById = new Map(appState.readingLibraries.map((library) => [library.id, library]));
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
        const id = readingFolderId(item.libraryId, folderPath);
        let node = nodes.get(id);
        if (!node) {
          const name = path.basename(folderPath) || library?.name || "阅读目录";
          node = {
            id,
            parentId,
            name,
            title: index === 0 ? library?.name || name : name,
            configured: false,
            directMediaCount: 0,
            mediaCount: 0,
            childCount: 0,
            coverMediaId: null,
            ebookCount: 0,
            spreadsheetCount: 0,
            kind: "reading",
            path: folderPath,
          };
          nodes.set(id, node);
        }
        node.mediaCount += 1;
        if (item.kind === "spreadsheet") node.spreadsheetCount += 1;
        else {
          node.ebookCount += 1;
          node.coverMediaId ||= item.id;
        }
        if (index === paths.length - 1) node.directMediaCount += 1;
        parentId = id;
      }
    }
    for (const node of nodes.values()) if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).childCount += 1;
    return [...nodes.values()].sort((left, right) => (left.parentId || "").localeCompare(right.parentId || "") || left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function publicItem(item, includeLocalPath = false) {
    return {
      id: item.id,
      libraryId: item.libraryId,
      title: item.title,
      fileName: item.fileName,
      ...(includeLocalPath ? { path: item.path } : {}),
      extension: item.extension,
      kind: item.kind,
      size: item.size,
      modifiedAt: item.modifiedAt,
      folderId: readingFolderId(item.libraryId, folderPathForItem(item)),
      fileUrl: `/api/reading/items/${item.id}/file`,
      thumbnailUrl: item.coverPath ? `/api/reading/items/${item.id}/cover?v=${encodeURIComponent(item.coverSignature || "1")}` : null,
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
      ebookCount: folder.ebookCount,
      spreadsheetCount: folder.spreadsheetCount,
      customTitle: "",
      sampleAlias: "",
      kind: "reading",
    }));
  }

  function accessFolderSummaries() {
    const folders = new Map();
    for (const item of appState.readingItems) {
      const library = libraryForItem(item);
      const folderPath = accessFolderPathForItem(item);
      const id = readingFolderId(item.libraryId, folderPath);
      const relativePath = library?.path && pathIsSameOrDescendant(folderPath, library.path)
        ? path.relative(path.resolve(library.path), folderPath).split(path.sep).filter(Boolean).join(" / ")
        : path.basename(folderPath);
      let folder = folders.get(id);
      if (!folder) {
        const title = relativePath || `${library?.name || path.basename(folderPath) || "阅读目录"}（直属文件）`;
        folder = {
          id,
          path: folderPath,
          folderName: relativePath ? path.basename(folderPath) : title,
          title,
          season: 1,
          configured: false,
          mediaCount: 0,
          ebookCount: 0,
          spreadsheetCount: 0,
          customTitle: "",
          sampleAlias: "",
          kind: "reading",
          libraryName: library?.name || "阅读目录",
          relativePath: relativePath || "直属文件",
        };
        folders.set(id, folder);
      }
      folder.mediaCount += 1;
      if (item.kind === "spreadsheet") folder.spreadsheetCount += 1;
      else folder.ebookCount += 1;
    }
    return [...folders.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function accessFolderAliases() {
    return appState.readingItems.flatMap((item) => ancestorFolderIds(item).map((folderId) => [folderId, accessFolderIdForItem(item)]));
  }

  async function handleRequest(request, response, url, pathname) {
    if (!pathname.startsWith("/api/reading/")) return false;
    if (request.method === "GET" && pathname === "/api/reading/catalog") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      const items = accessibleItems(context);
      return sendJson(response, 200, { items: items.map((item) => publicItem(item)), folders: folderNodes(items).map(({ path: _path, ...folder }) => folder), scan: scanStatus() }), true;
    }
    if (request.method === "POST" && pathname === "/api/reading/catalog/scan") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      await scanLibraries({ mode: url.searchParams.get("mode") || "standard" });
      return sendJson(response, 200, { count: accessibleItems(context).length, scan: scanStatus() }), true;
    }
    if (request.method === "GET" && pathname === "/api/reading/overview") {
      if (!requireLocalManagement(request, response)) return true;
      return sendJson(response, 200, { libraries: appState.readingLibraries, items: appState.readingItems.map((item) => publicItem(item, true)), scanning: Boolean(activeScan), scan: scanStatus() }), true;
    }
    if (request.method === "POST" && pathname === "/api/reading/libraries") {
      if (!requireLocalManagement(request, response)) return true;
      const body = await readJson(request);
      if (!body.folderPath || !path.isAbsolute(body.folderPath)) return sendJson(response, 400, { error: "请输入完整的 Windows 阅读文件夹路径。" }), true;
      const folderPath = path.resolve(body.folderPath);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "找不到这个阅读文件夹，或当前程序没有读取权限。" }), true;
      let library = appState.readingLibraries.find((item) => item.path.toLowerCase() === folderPath.toLowerCase());
      const added = !library;
      if (added) {
        library = { id: stableId(`reading-library:${folderPath.toLowerCase()}`), path: folderPath, name: String(body.name || path.basename(folderPath) || folderPath).trim() };
        appState.readingLibraries.push(library);
        libraryRevision += 1;
        await saveState();
      }
      return sendJson(response, 201, { libraries: appState.readingLibraries, library, added }), true;
    }
    if (request.method === "DELETE" && /^\/api\/reading\/libraries\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return true;
      const id = pathname.split("/").pop();
      const library = appState.readingLibraries.find((item) => item.id === id);
      if (!library) return sendJson(response, 404, { error: "找不到这个阅读目录，它可能已经被删除。" }), true;
      const removedItems = appState.readingItems.filter((item) => item.libraryId === id);
      const removedFolderIds = new Set(removedItems.flatMap((item) => ancestorFolderIds(item)));
      appState.readingLibraries = appState.readingLibraries.filter((item) => item.id !== id);
      appState.readingItems = appState.readingItems.filter((item) => item.libraryId !== id);
      for (const category of appState.accessControl.categories) category.folderIds = category.folderIds.filter((folderId) => !removedFolderIds.has(folderId));
      libraryRevision += 1;
      await saveState();
      return sendJson(response, 200, { ok: true, removedItemCount: removedItems.length }), true;
    }
    if (request.method === "POST" && pathname === "/api/reading/scan/stop") {
      if (!requireLocalManagement(request, response)) return true;
      if (scanContext) scanContext.cancelRequested = true;
      return sendJson(response, 200, { scan: scanStatus() }), true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/reading\/items\/[^/]+\/file$/.test(pathname)) {
      const itemId = pathname.split("/")[4];
      const item = authorizedItem(request, response, itemId);
      if (!item) return true;
      await streamFile(request, response, item.path);
      return true;
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/reading\/items\/[^/]+\/cover$/.test(pathname)) {
      const itemId = pathname.split("/")[4];
      const item = authorizedItem(request, response, itemId);
      if (!item) return true;
      if (!item.coverPath) return sendJson(response, 404, { error: "这本书没有可用的封面缩略图。" }), true;
      await streamFile(request, response, item.coverPath, false, {
        cacheControl: "private, max-age=31536000, immutable",
        fileName: `${item.title}-cover${path.extname(item.coverPath)}`,
      });
      return true;
    }
    sendJson(response, 404, { error: "没有找到这个阅读地址。" });
    return true;
  }

  return {
    handleRequest,
    scanLibraries,
    scanStatus,
    isScanning: () => Boolean(activeScan),
    requestStopScan: () => { if (scanContext) scanContext.cancelRequested = true; },
    folderNodes,
    displayFolderSummaries,
    accessFolderSummaries,
    accessFolderAliases,
    allFolderIds: () => accessFolderSummaries().map((folder) => folder.id),
  };
}
