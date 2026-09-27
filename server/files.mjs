import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { validateDownloadSource } from "./downloads.mjs";

const MAX_FILES = 100000;
const MAX_DEPTH = 64;

export function createFileService({ appState, saveState, stableId, streamFile, sendJson, readJson, requireLocalManagement, requireViewerAccess, canAccessFolderId, pathIsSameOrDescendant, shouldHidePath = () => false, decorateFolders = (_context, _kind, nodes) => nodes, withDownloadSlot = (_request, _response, _context, operation) => operation() }) {
  appState.fileLibraries ||= [];
  appState.fileItems ||= [];
  appState.fileDirectories ||= [];
  let revision = 0;
  let activeScan = null;
  let scanContext = null;
  let lastStartedAt = null;
  let lastCompletedAt = null;
  let lastError = null;

  const folderId = (libraryId, folderPath) => stableId(`files:${libraryId}:${path.resolve(folderPath).toLowerCase()}`);
  const libraryForItem = (item) => appState.fileLibraries.find((library) => library.id === item.libraryId) || null;
  function accessFolderIdForPath(libraryId, filePath) {
    const library = appState.fileLibraries.find((candidate) => candidate.id === libraryId);
    const directory = path.dirname(path.resolve(filePath));
    if (!library || !pathIsSameOrDescendant(directory, library.path)) return null;
    const relative = path.relative(library.path, directory).split(path.sep).filter(Boolean);
    return folderId(libraryId, path.join(library.path, ...relative.slice(0, 2)));
  }
  const canAccessItem = (context, item) => !shouldHidePath(item.path) && Boolean(libraryForItem(item)) && (context?.fullAccess || canAccessFolderId(context, accessFolderIdForPath(item.libraryId, item.path)));
  const canAccessDirectory = (context, directory) => Boolean(context?.fullAccess || canAccessFolderId(context, accessFolderIdForPath(directory.libraryId, path.join(directory.path, "__directory__"))));
  const accessibleItems = (context) => appState.fileItems.filter((item) => canAccessItem(context, item));

  function scanStatus() {
    return { enabled: true, scanning: Boolean(activeScan), intervalSeconds: Number(appState.settings?.autoScanIntervalSeconds) || 30, lastStartedAt, lastCompletedAt, lastError, id: scanContext?.id || null, mode: scanContext?.mode || null, pendingMode: null, phase: scanContext?.phase || "idle", progressPercent: scanContext?.progressPercent ?? null, discoveredFiles: scanContext?.discoveredFiles || 0, processedFiles: scanContext?.processedFiles || 0, totalFiles: scanContext?.totalFiles || 0, processedLibraries: scanContext?.processedLibraries || 0, totalLibraries: appState.fileLibraries.length, maxParallelFiles: 1, maxParallelMediaTools: 0 };
  }

  async function scanLibraries({ mode = "standard" } = {}) {
    if (activeScan) return activeScan;
    const startRevision = revision;
    const libraries = appState.fileLibraries.map((library) => ({ ...library }));
    lastStartedAt = new Date().toISOString();
    lastError = null;
    scanContext = { id: randomUUID(), mode: mode === "turbo" ? "turbo" : "standard", phase: "discovering", progressPercent: 0, discoveredFiles: 0, processedFiles: 0, totalFiles: 0, processedLibraries: 0, cancelRequested: false };
    activeScan = (async () => {
      const files = new Map();
      const directories = new Map();
      const ownerForPath = (filePath) => libraries.filter((library) => pathIsSameOrDescendant(filePath, library.path)).sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id))[0];
      async function walk(directory, library, depth) {
        if (scanContext.cancelRequested) throw Object.assign(new Error("其他文件扫描已停止。"), { code: "FILES_SCAN_CANCELLED" });
        if (depth > MAX_DEPTH || files.size >= MAX_FILES) throw new Error("共享目录过大或层级过深，已保留原索引。");
        if (shouldHidePath(directory) || path.basename(directory).toLowerCase() === ".lmd-uploads") return;
        const directoryStat = await lstat(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("共享根目录包含链接或不是普通目录。");
        directories.set(`${library.id}:${directory.toLowerCase()}`, { libraryId: library.id, path: directory });
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(directory, entry.name);
          if (entry.name.toLowerCase() === ".lmd-uploads" || shouldHidePath(fullPath) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(fullPath, library, depth + 1);
          else if (entry.isFile()) {
            const owner = ownerForPath(fullPath) || library;
            const info = await lstat(fullPath);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const identity = (await realpath(fullPath)).toLowerCase();
            files.set(identity, { id: stableId(`files-item:${identity}`), libraryId: owner.id, path: fullPath, fileName: entry.name, title: entry.name, extension: path.extname(entry.name).slice(1).toUpperCase(), kind: "files", size: info.size, modifiedAt: info.mtime.toISOString() });
            scanContext.discoveredFiles = files.size;
            if (files.size > MAX_FILES) throw new Error("共享文件数量过多，已保留原索引。");
          }
        }
      }
      for (const library of libraries) {
        await walk(path.resolve(library.path), library, 0);
        scanContext.processedLibraries += 1;
      }
      if (startRevision !== revision) throw new Error("共享目录在扫描期间发生变化，请重新扫描。");
      scanContext.phase = "finalizing";
      scanContext.totalFiles = files.size;
      scanContext.processedFiles = files.size;
      scanContext.progressPercent = 98;
      const previousItems = appState.fileItems;
      const previousDirectories = appState.fileDirectories;
      appState.fileItems = [...files.values()];
      appState.fileDirectories = [...directories.values()];
      try { await saveState(); }
      catch (error) {
        const liveIds = new Set(appState.fileLibraries.map((library) => library.id));
        appState.fileItems = previousItems.filter((item) => liveIds.has(item.libraryId));
        appState.fileDirectories = previousDirectories.filter((item) => liveIds.has(item.libraryId));
        throw error;
      }
      lastCompletedAt = new Date().toISOString();
      scanContext.phase = "completed";
      scanContext.progressPercent = 100;
      return appState.fileItems;
    })();
    try { return await activeScan; }
    catch (error) {
      scanContext.phase = error.code === "FILES_SCAN_CANCELLED" ? "cancelled" : "failed";
      lastError = error.code === "FILES_SCAN_CANCELLED" ? null : error.message;
      throw error;
    } finally { activeScan = null; }
  }

  function folderNodes(items = appState.fileItems, context = null) {
    const nodes = new Map();
    function ensure(library, directory) {
      if (!pathIsSameOrDescendant(directory, library.path) || shouldHidePath(directory)) return null;
      const relative = path.relative(library.path, directory).split(path.sep).filter(Boolean);
      const paths = [path.resolve(library.path)];
      for (const segment of relative) paths.push(path.join(paths.at(-1), segment));
      let parentId = null;
      for (const [index, current] of paths.entries()) {
        const id = folderId(library.id, current);
        if (!nodes.has(id)) nodes.set(id, { id, libraryId: library.id, parentId, name: path.basename(current) || library.name, title: index === 0 ? library.name : path.basename(current), configured: index === 0, directMediaCount: 0, mediaCount: 0, childCount: 0, coverMediaId: null, kind: "files", path: current });
        parentId = id;
      }
      return paths.map((current) => nodes.get(folderId(library.id, current)));
    }
    const directories = [...appState.fileLibraries.map((library) => ({ libraryId: library.id, path: library.path })), ...appState.fileDirectories];
    for (const directory of directories) {
      const library = libraryForItem(directory);
      if (library && (!context || canAccessDirectory(context, directory))) ensure(library, directory.path);
    }
    for (const item of items) {
      const library = libraryForItem(item);
      if (!library) continue;
      const chain = ensure(library, path.dirname(item.path));
      for (const node of chain || []) node.mediaCount += 1;
      if (chain?.length) chain.at(-1).directMediaCount += 1;
    }
    for (const node of nodes.values()) if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).childCount += 1;
    return [...nodes.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }

  function publicItem(item, includeLocalPath = false) {
    return { id: item.id, libraryId: item.libraryId, title: item.title, fileName: item.fileName, extension: item.extension, kind: "files", size: item.size, modifiedAt: item.modifiedAt, folderId: folderId(item.libraryId, path.dirname(item.path)), downloadUrl: `/api/files/items/${item.id}/download`, ...(includeLocalPath ? { path: item.path } : {}) };
  }

  function displayFolderSummaries() {
    return folderNodes().map((folder) => ({ ...folder, folderName: folder.name, season: 1, customTitle: "", sampleAlias: "" }));
  }

  function accessFolderSummaries() {
    const buckets = new Map();
    for (const folder of folderNodes()) {
      const library = libraryForItem(folder);
      const relative = path.relative(library.path, folder.path).split(path.sep).filter(Boolean);
      if (relative.length > 2) continue;
      const title = relative.length ? relative.join(" / ") : `${library.name}（直属文件）`;
      buckets.set(folder.id, { ...folder, title, folderName: relative.length ? folder.name : title, relativePath: relative.join(" / ") || "直属文件", libraryName: library.name, season: 1, configured: false, mediaCount: 0, customTitle: "", sampleAlias: "" });
    }
    for (const item of appState.fileItems) {
      const bucket = buckets.get(accessFolderIdForPath(item.libraryId, item.path));
      if (bucket) bucket.mediaCount += 1;
    }
    return [...buckets.values()];
  }

  async function handleRequest(request, response, url, pathname) {
    if (!pathname.startsWith("/api/files/")) return false;
    if (request.method === "GET" && pathname === "/api/files/catalog") {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      const items = accessibleItems(context);
      sendJson(response, 200, { items: items.map((item) => publicItem(item)), folders: decorateFolders(context, "files", folderNodes(items, context)).map(({ path: _path, ...folder }) => folder), scan: scanStatus() });
      return true;
    }
    if (request.method === "GET" && pathname === "/api/files/overview") {
      if (!requireLocalManagement(request, response)) return true;
      sendJson(response, 200, { libraries: appState.fileLibraries, items: appState.fileItems.map((item) => publicItem(item, true)), folders: folderNodes(), scanning: Boolean(activeScan), scan: scanStatus() });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/files/libraries") {
      if (!requireLocalManagement(request, response)) return true;
      const body = await readJson(request);
      if (typeof body.folderPath !== "string" || !path.isAbsolute(body.folderPath)) return sendJson(response, 400, { error: "请输入完整的共享目录路径。" }), true;
      const folderPath = path.resolve(body.folderPath);
      const info = await lstat(folderPath).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink() || shouldHidePath(folderPath)) return sendJson(response, 400, { error: "找不到这个普通目录，或目录不可共享。" }), true;
      let library = appState.fileLibraries.find((candidate) => candidate.path.toLowerCase() === folderPath.toLowerCase());
      const added = !library;
      if (added) {
        library = { id: stableId(`files-library:${folderPath.toLowerCase()}`), path: folderPath, name: String(body.name || path.basename(folderPath) || folderPath).trim() };
        appState.fileLibraries.push(library);
        revision += 1;
        try { await saveState(); } catch (error) { appState.fileLibraries = appState.fileLibraries.filter((candidate) => candidate !== library); revision += 1; throw error; }
      }
      sendJson(response, 201, { libraries: appState.fileLibraries, library, added });
      return true;
    }
    if (request.method === "DELETE" && /^\/api\/files\/libraries\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return true;
      const id = pathname.split("/").at(-1);
      if (!appState.fileLibraries.some((library) => library.id === id)) return sendJson(response, 404, { error: "找不到这个共享目录。" }), true;
      const removedFolderIds = new Set(folderNodes().filter((folder) => folder.libraryId === id).map((folder) => folder.id));
      const removedItemCount = appState.fileItems.filter((item) => item.libraryId === id).length;
      appState.fileLibraries = appState.fileLibraries.filter((library) => library.id !== id);
      appState.fileItems = appState.fileItems.filter((item) => item.libraryId !== id);
      appState.fileDirectories = appState.fileDirectories.filter((item) => item.libraryId !== id);
      for (const category of appState.accessControl?.categories || []) category.folderIds = category.folderIds.filter((folder) => !removedFolderIds.has(folder));
      for (const user of appState.accessControl?.users || []) user.folderIds = (user.folderIds || []).filter((folder) => !removedFolderIds.has(folder));
      revision += 1;
      await saveState();
      sendJson(response, 200, { ok: true, removedItemCount });
      return true;
    }
    if (request.method === "POST" && ["/api/files/catalog/scan", "/api/files/scan"].includes(pathname)) {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      await scanLibraries({ mode: url.searchParams.get("mode") || "standard" });
      sendJson(response, 200, { count: accessibleItems(context).length, scan: scanStatus() });
      return true;
    }
    if (request.method === "POST" && pathname === "/api/files/scan/stop") {
      if (!requireLocalManagement(request, response)) return true;
      if (scanContext) scanContext.cancelRequested = true;
      sendJson(response, 200, { scan: scanStatus() });
      return true;
    }
    if (["GET", "HEAD"].includes(request.method) && /^\/api\/files\/items\/[^/]+\/download$/.test(pathname)) {
      const context = requireViewerAccess(request, response);
      if (!context) return true;
      const item = appState.fileItems.find((candidate) => candidate.id === pathname.split("/")[4]);
      if (!item || !canAccessItem(context, item)) return sendJson(response, 404, { error: "找不到文件，或当前用户没有访问权限。" }), true;
      const library = libraryForItem(item);
      try { await validateDownloadSource({ ...item, libraryPath: library.path }, shouldHidePath); }
      catch { return sendJson(response, 404, { error: "文件不存在或已不在授权目录中。" }), true; }
      response.setHeader("X-Content-Type-Options", "nosniff");
      await withDownloadSlot(request, response, context, () => streamFile(request, response, item.path, false, { disposition: "attachment", fileName: item.fileName }));
      return true;
    }
    sendJson(response, 404, { error: "没有找到这个文件地址。" });
    return true;
  }

  return { handleRequest, scanLibraries, scanStatus, isScanning: () => Boolean(activeScan), requestStopScan: () => { if (scanContext) scanContext.cancelRequested = true; }, folderNodes, folderId, libraryForItem, canAccessItem, accessFolderIdForPath, displayFolderSummaries, accessFolderSummaries, accessFolderAliases: () => [], allFolderIds: () => accessFolderSummaries().map((folder) => folder.id) };
}
