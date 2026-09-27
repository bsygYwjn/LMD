import { randomBytes } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import yazl from "yazl";

const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_SELECTION = 10000;
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const inside = (candidate, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};
const fail = (message, status = 404) => Object.assign(new Error(message), { statusCode: status });

// Catalog entries are only hints: re-check their filesystem boundary immediately
// before download, including junctions substituted since the last library scan.
export async function validateDownloadSource(file, shouldHidePath = () => false) {
  if (!file?.path || !file.libraryPath || !inside(file.path, file.libraryPath) || shouldHidePath(file.path)) {
    throw fail("文件已不可用，或已离开授权目录。");
  }
  let cursor = path.resolve(file.path);
  let fileStat;
  while (true) {
    const info = await lstat(cursor).catch(() => null);
    if (!info || info.isSymbolicLink()) throw fail("文件不存在或包含不允许的链接目录。");
    if (!fileStat) {
      if (!info.isFile()) throw fail("下载对象不是普通文件。");
      fileStat = info;
    } else if (!info.isDirectory()) throw fail("文件目录不可用。");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const canonical = await realpath(file.path);
  const root = await realpath(file.libraryPath);
  if (!inside(canonical, root)) throw fail("文件已离开授权目录。");
  return { ...file, path: path.resolve(file.path), size: fileStat.size, modifiedAt: fileStat.mtime.toISOString(), stat: fileStat };
}

function safeComponent(value) {
  return String(value || "共享目录").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[ .]+$/g, "").slice(0, 100) || "共享目录";
}

export function archiveEntryNames(files) {
  const libraries = new Map(files.map((file) => [file.libraryId || file.libraryPath, file]));
  const prefixes = new Map();
  const occupiedPrefixes = new Set();
  for (const [id, library] of libraries) {
    const base = safeComponent(library.libraryName || path.basename(library.libraryPath));
    let prefix = base;
    let index = 2;
    while (occupiedPrefixes.has(prefix.toLowerCase())) prefix = `${base} (${index++})`;
    occupiedPrefixes.add(prefix.toLowerCase());
    prefixes.set(id, prefix);
  }
  const occupied = new Set();
  return files.map((file) => {
    const relative = path.relative(file.libraryPath, file.path).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || relative.split("/").includes("..") || path.isAbsolute(relative)) throw fail("ZIP 文件路径无效。", 400);
    const prefix = libraries.size > 1 ? `${prefixes.get(file.libraryId || file.libraryPath)}/` : "";
    const entryName = `${prefix}${relative}`;
    // Reject ambiguous names instead of silently renaming a sidecar away from
    // its original main file. Cross-library conflicts are handled as a group.
    if (occupied.has(entryName.toLowerCase())) throw fail("ZIP 内存在大小写冲突的文件名，请分别下载。", 409);
    occupied.add(entryName.toLowerCase());
    return { ...file, entryName };
  });
}

export function createDownloadService({ requireViewerAccess, sendJson, readJson, resolveOriginal, resolveRelated, shouldHidePath = () => false, now = Date.now, tokenTtlMs = TOKEN_TTL_MS }) {
  const manifests = new Map();
  const active = new Set();
  const activeArchives = new Set();

  function identity(context, request) {
    return context?.user?.id ? `user:${context.user.id}` : `${context?.mode || "local"}:${request.socket?.remoteAddress || "local"}`;
  }

  function prune() {
    for (const [token, manifest] of manifests) if (manifest.expiresAt <= now()) manifests.delete(token);
  }

  async function withDownloadSlot(request, response, context, operation, { archive = false } = {}) {
    if (request.method === "HEAD") return operation();
    const owner = identity(context, request);
    if (active.size >= 3 || (archive && activeArchives.has(owner))) {
      response.setHeader("Retry-After", "3");
      return sendJson(response, 429, { error: archive && activeArchives.has(owner) ? "当前用户已有 ZIP 正在下载，请完成后重试。" : "当前下载通道已满，请稍后重试。", code: "DOWNLOAD_LIMIT" });
    }
    const slot = Symbol("download");
    active.add(slot);
    if (archive) activeArchives.add(owner);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active.delete(slot);
      if (archive) activeArchives.delete(owner);
      response.off("finish", release);
      response.off("close", release);
    };
    response.once("finish", release);
    response.once("close", release);
    response.setTimeout?.(120000, () => response.destroy());
    try { return await operation(); }
    catch (error) { release(); throw error; }
  }

  async function prepare(context, kind, ids, includeRelated) {
    const files = new Map();
    const omitted = new Set();
    let omittedUnknown = 0;
    for (const id of ids) {
      const item = await resolveOriginal(context, kind, id);
      if (!item) throw fail("选中的原文件不存在，或当前用户已没有访问权限。");
      const validated = await validateDownloadSource(item, shouldHidePath);
      const key = (await realpath(validated.path)).toLowerCase();
      files.set(key, validated);
      if (includeRelated) {
        const related = await resolveRelated?.(context, kind, item) || { files: [], omittedCount: 0 };
        omittedUnknown += Number(related.omittedCount) || 0;
        for (const key of related.omittedKeys || []) omitted.add(key);
        for (const file of related.files || []) {
          try {
            const checked = await validateDownloadSource(file, shouldHidePath);
            const relatedKey = (await realpath(checked.path)).toLowerCase();
            if (!files.has(relatedKey)) files.set(relatedKey, checked);
          } catch { omitted.add(path.resolve(file.path).toLowerCase()); }
        }
      }
    }
    return { files: archiveEntryNames([...files.values()]), omittedRelatedCount: omitted.size + omittedUnknown };
  }

  async function streamArchive(request, response, prepared, fileName) {
    const headers = { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "none", "X-LMD-Omitted-Related": String(prepared.omittedRelatedCount) };
    if (request.method === "HEAD") { response.writeHead(200, headers); response.end(); return; }
    const zip = new yazl.ZipFile();
    const streams = new Set();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const stream of streams) stream.destroy();
      streams.clear();
      zip.outputStream.destroy();
    };
    const onError = (error) => { stop(); if (!response.destroyed) response.destroy(error); };
    response.once("close", stop);
    zip.on("error", onError);
    zip.outputStream.on("error", onError);
    for (const file of prepared.files) {
      zip.addReadStreamLazy(file.entryName, { compress: false, size: file.size, mtime: new Date(file.modifiedAt) }, (callback) => {
        (async () => {
          if (stopped) throw fail("下载已断开。");
          const current = await validateDownloadSource(file, shouldHidePath);
          if (current.size !== file.size || current.stat.mtimeMs !== file.stat.mtimeMs || current.stat.ino !== file.stat.ino) throw fail("文件在 ZIP 准备后发生变化，请重新下载。");
          const handle = await open(file.path, "r");
          try {
            const opened = await handle.stat();
            if (stopped || opened.ino !== current.stat.ino || opened.dev !== current.stat.dev || opened.size !== current.size || opened.mtimeMs !== current.stat.mtimeMs) throw fail("文件在下载前发生变化。");
            const stream = handle.createReadStream({ autoClose: true });
            streams.add(stream);
            stream.once("close", () => streams.delete(stream));
            stream.once("error", onError);
            callback(null, stream);
          } catch (error) { await handle.close(); throw error; }
        })().catch(callback);
      });
    }
    response.writeHead(200, headers);
    zip.outputStream.pipe(response);
    // yazl automatically uses ZIP64 when an entry, offset, or count requires it.
    zip.end();
  }

  async function handleRequest(request, response, url, pathname) {
    if (!pathname.startsWith("/api/downloads/")) return false;
    const context = requireViewerAccess(request, response);
    if (!context) return true;
    try {
      prune();
      if (request.method === "POST" && pathname === "/api/downloads/archives") {
        const body = await readJson(request);
        if (!["video", "music"].includes(body.kind) || !Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_SELECTION || body.ids.some((id) => typeof id !== "string" || !id || id.length > 128)) throw fail("请选择视频或音乐原文件后再准备 ZIP。", 400);
        const ids = [...new Set(body.ids)];
        const includeRelated = body.includeRelated !== false;
        const prepared = await prepare(context, body.kind, ids, includeRelated);
        const owner = identity(context, request);
        const ownTokens = [...manifests].filter(([, item]) => item.owner === owner);
        for (const [token] of ownTokens.slice(0, Math.max(0, ownTokens.length - 19))) manifests.delete(token);
        if (manifests.size >= 1000) throw fail("下载准备任务较多，请稍后重试。", 429);
        const token = randomBytes(24).toString("base64url");
        const expiresAt = now() + tokenTtlMs;
        const fileName = `${body.kind === "music" ? "音乐" : "视频"}-${new Date(now()).toISOString().slice(0, 10)}.zip`;
        manifests.set(token, { owner, expiresAt, ids, kind: body.kind, includeRelated, fileName });
        sendJson(response, 201, { downloadUrl: `/api/downloads/archives/${token}`, expiresAt: new Date(expiresAt).toISOString(), fileName, fileCount: prepared.files.length, totalBytes: prepared.files.reduce((sum, file) => sum + file.size, 0), omittedRelatedCount: prepared.omittedRelatedCount });
        return true;
      }
      if (["GET", "HEAD"].includes(request.method) && /^\/api\/downloads\/archives\/[\w-]+$/.test(pathname)) {
        const manifest = manifests.get(pathname.split("/").at(-1));
        if (!manifest) throw fail("ZIP 下载地址已失效，请保留选择并重新准备。", 410);
        if (manifest.owner !== identity(context, request)) throw fail("此下载地址不属于当前用户。", 403);
        // Range is deliberately ignored, as permitted by HTTP: every GET starts
        // a new archive stream, with no resumability claim or partial response.
        await withDownloadSlot(request, response, context, async () => {
          const prepared = await prepare(context, manifest.kind, manifest.ids, manifest.includeRelated);
          await streamArchive(request, response, prepared, manifest.fileName);
        }, { archive: true });
        return true;
      }
      sendJson(response, 404, { error: "没有找到这个下载地址。" });
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "准备下载失败，请检查原文件后重试。" });
    }
    return true;
  }

  return { handleRequest, withDownloadSlot, prepare, activeCount: () => active.size };
}
