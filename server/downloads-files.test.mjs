import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDownloadService, archiveEntryNames, validateDownloadSource } from "./downloads.mjs";
import { createFileService } from "./files.mjs";
import { createMusicService } from "./music.mjs";

const root = await mkdtemp(path.join(tmpdir(), "lmd-download-files-"));
const libraryPath = path.join(root, "资料");
const library2Path = path.join(root, "第二库");
await mkdir(path.join(libraryPath, "专辑", "空目录"), { recursive: true });
await mkdir(path.join(libraryPath, ".lmd-uploads"), { recursive: true });
await mkdir(library2Path);
const content = Buffer.from("原始文件\0二进制内容\r\n", "utf8");
const source = path.join(libraryPath, "专辑", "中文歌曲.flac");
const lyrics = path.join(libraryPath, "专辑", "中文歌曲.lrc");
const cover = path.join(libraryPath, "cover.jpg");
await Promise.all([writeFile(source, content), writeFile(lyrics, "[00:01]歌词"), writeFile(cover, "原封面"), writeFile(path.join(libraryPath, ".lmd-uploads", "private.part"), "暂存"), writeFile(path.join(libraryPath, "pending.bin"), "半文件"), writeFile(path.join(library2Path, "中文歌曲.flac"), "第二库")]);
let clock = Date.now();
let allowed = true;
let saveFail = false;
let shouldHidePending = true;
const context = (request) => request.headers["x-user"] === "anonymous" ? null : { user: { id: request.headers["x-user"] || "alice" }, mode: "user", fullAccess: request.headers["x-user"] === "admin" };
const sendJson = (response, status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
const readJson = async (request) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString()); };
const requireViewerAccess = (request, response) => { const value = context(request); if (!value) sendJson(response, 401, { error: "登录" }); return value; };
const shouldHidePath = (filePath) => filePath.split(path.sep).includes(".lmd-uploads") || shouldHidePending && path.basename(filePath) === "pending.bin";
const original = { id: "song", path: source, fileName: path.basename(source), libraryId: "lib", libraryPath, libraryName: "资料" };
let largeOriginal = null;
const sidecar = { path: lyrics, libraryId: "lib", libraryPath, libraryName: "资料" };
const downloads = createDownloadService({ requireViewerAccess, sendJson, readJson, shouldHidePath, now: () => clock, tokenTtlMs: 1000,
  resolveOriginal: (viewer, kind, id) => allowed && viewer.user.id !== "mallory" && kind === "music" ? id === "song" ? original : id === "large" ? largeOriginal : null : null,
  resolveRelated: () => ({ files: [sidecar, sidecar], omittedKeys: [cover, cover] }),
});
const appState = { settings: {}, accessControl: { categories: [], users: [] }, fileLibraries: [{ id: "lib", path: libraryPath, name: "资料" }] };
const stableId = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const inside = (candidate, parent) => { const value = path.relative(parent, candidate); return value === "" || value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value); };
const files = createFileService({ appState, saveState: async () => { if (saveFail) throw new Error("test-save-error"); }, stableId, sendJson, readJson, requireViewerAccess, requireLocalManagement: (request, response) => { if (context(request)?.fullAccess) return true; sendJson(response, 403, {}); return false; }, canAccessFolderId: (viewer, id) => viewer?.user.id === "alice" && id === files.folderId("lib", path.join(libraryPath, "专辑", "空目录")), pathIsSameOrDescendant: inside, shouldHidePath, withDownloadSlot: downloads.withDownloadSlot,
  streamFile: async (request, response, filePath, _tracking, options) => { const data = await readFile(filePath); response.writeHead(200, { "Content-Disposition": `${options.disposition}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`, "Content-Length": data.length }); response.end(request.method === "HEAD" ? undefined : data); },
});
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (await downloads.handleRequest(request, response, url, url.pathname)) return;
    if (await files.handleRequest(request, response, url, url.pathname)) return;
    sendJson(response, 404, {});
  } catch (error) { sendJson(response, error.statusCode || 500, { error: error.message }); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const json = async (pathname, options = {}) => { const response = await fetch(base + pathname, options); return { status: response.status, data: await response.json(), headers: response.headers }; };
const prepare = (body = { kind: "music", ids: ["song"], includeRelated: true }, user = "alice") => json("/api/downloads/archives", { method: "POST", headers: { "Content-Type": "application/json", "x-user": user }, body: JSON.stringify(body) });

function zipEntries(buffer) {
  const entries = [];
  for (let offset = 0; offset + 46 < buffer.length; offset++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localOffset = buffer.readUInt32LE(offset + 42);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const length = buffer.readUInt32LE(offset + 20);
    entries.push({ name, method: buffer.readUInt16LE(offset + 10), body: buffer.subarray(start, start + length) });
  }
  return entries;
}

try {
  const result = await prepare();
  assert.equal(result.status, 201);
  assert.equal(result.data.fileCount, 2, "sidecars deduplicate by canonical path");
  assert.equal(result.data.omittedRelatedCount, 1, "inaccessible shared cover is counted once without exposing its path");
  assert.equal(JSON.stringify(result.data).includes(libraryPath), false);
  const downloaded = await fetch(base + result.data.downloadUrl);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("accept-ranges"), "none");
  assert.match(downloaded.headers.get("content-disposition"), /filename\*=UTF-8''/);
  const entries = zipEntries(Buffer.from(await downloaded.arrayBuffer()));
  assert.deepEqual(entries.map((entry) => entry.name), ["专辑/中文歌曲.flac", "专辑/中文歌曲.lrc"]);
  assert.ok(entries.every((entry) => entry.method === 0));
  assert.deepEqual(entries[0].body, content);
  const head = await fetch(base + result.data.downloadUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(base + result.data.downloadUrl, { headers: { Range: "bytes=2-3" } });
  assert.equal(range.status, 200);
  await range.arrayBuffer();
  assert.equal((await json(result.data.downloadUrl, { headers: { "x-user": "bob" } })).status, 403);
  assert.equal((await json(result.data.downloadUrl, { headers: { "x-user": "anonymous" } })).status, 401);
  allowed = false;
  assert.equal((await json(result.data.downloadUrl)).status, 404, "revocation rechecked at GET");
  allowed = true;
  clock += 1001;
  assert.equal((await json(result.data.downloadUrl)).status, 410);
  assert.equal((await prepare({ kind: "files", ids: ["song"] })).status, 400);
  assert.equal((await prepare({ kind: "music", ids: ["missing"] })).status, 404);
  assert.equal((await prepare({ kind: "music", ids: ["song", "song"], includeRelated: false })).data.fileCount, 1);
  const musicState = { settings: {}, musicLibraries: [{ id: "lib", path: libraryPath, name: "资料" }], musicTracks: [original] };
  const musicGrants = new Set();
  const music = createMusicService({ appState: musicState, cacheDirectory: path.join(root, "music-cache"), saveState: async () => {}, stableId, pathIsSameOrDescendant: inside, canAccessFolderId: (_viewer, id) => musicGrants.has(id), shouldHidePath });
  musicGrants.add(music.folderId("lib", path.join(libraryPath, "专辑")));
  assert.ok(music.resolveOriginal({ user: { id: "alice" } }, "song"));
  const restrictedRelated = await music.resolveRelated({ user: { id: "alice" } }, original);
  assert.deepEqual(restrictedRelated.files.map((file) => file.path), [lyrics], "an album grant includes its LRC, not an inherited parent cover");
  assert.deepEqual(restrictedRelated.omittedKeys, [cover.toLowerCase()]);
  musicGrants.add(music.folderId("lib", libraryPath));
  const allowedRelated = await music.resolveRelated({ user: { id: "alice" } }, original);
  assert.deepEqual(new Set(allowedRelated.files.map((file) => file.path)), new Set([lyrics, cover]), "separately authorized parent cover is included from its original path");
  const naming = archiveEntryNames([original, { ...original, path: path.join(library2Path, "中文歌曲.flac"), libraryId: "other", libraryPath: library2Path }]);
  assert.deepEqual(naming.map((item) => item.entryName), ["资料/专辑/中文歌曲.flac", "资料 (2)/中文歌曲.flac"]);
  await assert.rejects(validateDownloadSource({ ...original, path: path.join(root, "outside.txt") }), /授权目录/);
  await assert.rejects(validateDownloadSource({ ...original, path: path.join(libraryPath, "pending.bin") }, shouldHidePath), /授权目录/);
  const linked = path.join(libraryPath, "外部链接");
  try {
    await symlink(library2Path, linked, "junction");
    await assert.rejects(validateDownloadSource({ ...original, path: path.join(linked, "中文歌曲.flac") }), /链接目录/);
  } catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }

  await files.scanLibraries();
  assert.equal(appState.fileItems.length, 3, "pending and temporary files are excluded");
  assert.ok(files.accessFolderSummaries().some((folder) => folder.path === path.join(libraryPath, "专辑", "空目录")), "empty permission buckets are inventoried");
  const catalog = await json("/api/files/catalog");
  assert.equal(catalog.data.items.length, 0);
  assert.ok(catalog.data.folders.some((folder) => folder.name === "空目录"));
  assert.ok(catalog.data.folders.some((folder) => folder.title === "资料"), "navigable ancestors are included");
  assert.equal(JSON.stringify(catalog.data).includes(libraryPath), false);
  const adminCatalog = await json("/api/files/catalog", { headers: { "x-user": "admin" } });
  assert.equal(adminCatalog.data.items.length, 3);
  const publicSource = adminCatalog.data.items.find((item) => item.fileName === "中文歌曲.flac");
  assert.equal((await json(publicSource.downloadUrl)).status, 404, "navigable ancestors do not confer download permission");
  const raw = await fetch(base + publicSource.downloadUrl, { headers: { "x-user": "admin" } });
  assert.match(raw.headers.get("content-disposition"), /^attachment;/);
  assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), content);
  const before = appState.fileItems;
  shouldHidePending = false;
  saveFail = true;
  await assert.rejects(files.scanLibraries(), /test-save-error/);
  assert.deepEqual(appState.fileItems, before, "failed save restores published catalog");
  saveFail = false;

  class Response extends EventEmitter {
    setHeader() {}
    setTimeout() {}
    writeHead(status) { this.status = status; }
    end() { this.emit("finish"); }
  }
  const request = { method: "GET", socket: { remoteAddress: "127.0.0.1" } };
  const viewer = { user: { id: "slots" } };
  const held = [new Response(), new Response(), new Response()];
  for (const response of held) await downloads.withDownloadSlot(request, response, viewer, async () => {});
  assert.equal(downloads.activeCount(), 3);
  const rejected = new Response();
  await downloads.withDownloadSlot(request, rejected, viewer, async () => assert.fail("must not run fourth download"));
  assert.equal(rejected.status, 429);
  held.forEach((response) => response.emit("close"));
  assert.equal(downloads.activeCount(), 0, "disconnect releases all slots");
  const archiveHeld = new Response();
  await downloads.withDownloadSlot(request, archiveHeld, viewer, async () => {}, { archive: true });
  const archiveRejected = new Response();
  await downloads.withDownloadSlot(request, archiveRejected, viewer, async () => assert.fail("one ZIP per user"), { archive: true });
  assert.equal(archiveRejected.status, 429);
  archiveHeld.emit("close");
  assert.equal(downloads.activeCount(), 0);

  const largePath = path.join(library2Path, "断开测试.flac");
  await writeFile(largePath, Buffer.alloc(16 * 1024 * 1024, 0x4c));
  largeOriginal = { id: "large", path: largePath, fileName: path.basename(largePath), libraryId: "large-library", libraryPath: library2Path, libraryName: "第二库" };
  const largeArchive = await prepare({ kind: "music", ids: ["large"], includeRelated: false });
  assert.equal(largeArchive.status, 201);
  await new Promise((resolve, reject) => {
    let received = false;
    const request = http.get(base + largeArchive.data.downloadUrl, response => {
      assert.equal(response.statusCode, 200);
      response.once("data", () => { received = true; response.destroy(); request.destroy(); });
      response.once("close", resolve);
      response.once("error", error => { if (!received) reject(error); });
    });
    request.once("error", error => { if (!received) reject(error); });
    request.setTimeout(5000, () => request.destroy(new Error("disconnect test timeout")));
  });
  for (let attempt = 0; downloads.activeCount() && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(downloads.activeCount(), 0, "aborting an actual ZIP stream releases its download slot");
  const missingArchive = await prepare({ kind: "music", ids: ["large"], includeRelated: false });
  assert.equal(missingArchive.status, 201);
  await rm(largePath);
  assert.equal((await json(missingArchive.data.downloadUrl)).status, 404, "a main file removed after preparation prevents GET instead of producing a partial archive");
  const removed = await json("/api/files/libraries/lib", { method: "DELETE", headers: { "x-user": "admin" } });
  assert.equal(removed.status, 200);
  assert.deepEqual(await readFile(source), content, "removing a share never deletes originals");
  console.log("downloads/files: STORE streaming, identity/expiry/revocation, original bytes, Chinese paths, sidecar dedup, permissions, empty directories, pending exclusion, rollback, junction rejection and concurrency passed");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith("lmd-download-files-")) throw new Error("Unsafe test cleanup");
  await rm(resolved, { recursive: true, force: true });
}
