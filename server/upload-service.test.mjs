import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { copyFile, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUploadService, validateUploadRelativePath } from "./uploads.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const rejected = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lmd-upload-test-"));
  const dataDirectory = path.join(root, "data");
  const directories = { a: path.join(root, "shared-a"), b: path.join(root, "shared-b") };
  await Promise.all([mkdir(dataDirectory), ...Object.values(directories).map((directory) => mkdir(directory))]);
  const changes = []; const publications = []; const errors = [];
  const permissions = { alice: true, bob: true }; const targetPermissions = { a: true, b: true };
  let currentTime = Date.now();
  const options = { dataDirectory, chunkBytes: 4, reserveBytes: 16, retentionMs: 86400000,
    identify: async (request) => {
      const userId = request.headers["x-user"] || "alice";
      if (!permissions[userId]) throw rejected(userId === "guest" ? 401 : 403, "UPLOAD_FORBIDDEN");
      return { userId };
    },
    listTargets: async (_request, kind) => Object.entries(directories).map(([id, directory]) => ({ id, kind, path: directory, rootPath: directory, label: id, libraryId: id })),
    resolveTarget: async (_request, kind, id) => {
      if (!targetPermissions[id]) throw rejected(403, "TARGET_FORBIDDEN");
      if (!directories[id]) throw rejected(404, "TARGET_MISSING");
      return { id, kind, path: directories[id], rootPath: directories[id], libraryId: id };
    },
    authorizePath: async () => {}, onDirectoriesCreated: async (_request, _kind, _target, paths) => { changes.push(...paths); },
    isSupported: (kind, relative) => kind === "files" || !relative.endsWith(".unsupported"),
    onPublished: async (filePath, details) => { publications.push({ filePath, ...details }); },
    getSettings: () => ({ uploadMaxFileBytes: 1000 }), getFreeBytes: async () => 1000000,
    now: () => currentTime, onError: (error) => errors.push(error), ...overrides,
  };
  let service = createUploadService(options); await service.init();
  const server = createServer((request, response) => {
    void service.handleRequest(request, response, new URL(request.url, "http://localhost"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await service.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("lmd-upload-test-"));
    await rm(root, { recursive: true, force: true });
  });
  async function api(route, { method = "GET", body, user = "alice", headers = {}, raw } = {}) {
    const response = await fetch(`${base}/api/uploads${route}`, { method, headers: { "x-user": user, ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: response.status, body: await response.json() };
  }
  async function create(relativePath = "test.bin", size = 8, extra = {}) {
    return api("", { method: "POST", body: { kind: "files", targetId: "a", relativePath, size, lastModified: 42, ...extra } });
  }
  async function chunk(task, data, offset = 0, token = task.resumeToken, user = "alice", hash = sha(data)) {
    return api(`/${task.task.id}/chunks?offset=${offset}`, { method: "PUT", raw: Buffer.from(data), user,
      headers: { "x-chunk-sha256": hash, "x-upload-token": token || "" } });
  }
  async function complete(task, contents) {
    return api(`/${task.task.id}/complete`, { method: "POST", body: { resumeToken: task.resumeToken, sha256: sha(contents) } });
  }
  return { root, dataDirectory, directories, changes, publications, permissions, targetPermissions, errors, base, api, create, chunk, complete,
    get service() { return service; }, options,
    advanceTime(ms) { currentTime += ms; },
    async restart() { await service.close(); service = createUploadService(options); await service.init(); },
    async manifest(id) { return JSON.parse(await readFile(path.join(dataDirectory, "uploads", "tasks", `${id}.json`), "utf8")); },
    async saveManifest(task) { await writeFile(path.join(dataDirectory, "uploads", "tasks", `${task.id}.json`), JSON.stringify(task)); },
  };
}

test("Windows paths reject traversal, devices, ADS, hidden staging, and trailing aliases", () => {
  for (const name of ["../file", "a/../file", "/file", "C:/file", "C:\\file", "a\\file", "a//file", "NUL.txt", "com1.MP4", "LPT².txt", "CONOUT$", "a:stream", "file.", "file ", ".git/config", ".lmd-upload-staging/file", ".lmd-uploads/file", "a/\0b"]) {
    assert.throws(() => validateUploadRelativePath(name), { code: "INVALID_UPLOAD_PATH" }, name);
  }
  assert.deepEqual(validateUploadRelativePath("最外层/第二层/正常 文件.mp4"), ["最外层", "第二层", "正常 文件.mp4"]);
});

test("all five kinds publish exact bytes and preserve directory hierarchy", async (t) => {
  const f = await fixture(t);
  const targets = await f.api("/targets?kind=video");
  assert.equal(targets.status, 200); assert.equal(targets.body.limits.chunkBytes, 4);
  assert.ok(targets.body.targets.every((target) => !target.path && !target.rootPath));
  for (const kind of ["video", "music", "reading", "photos", "files"]) {
    const made = await f.create(`外层/${kind}/中文.bin`, 6, { kind }); assert.equal(made.status, 201);
    assert.equal((await f.chunk(made.body, "abcd")).status, 200);
    assert.equal((await f.chunk(made.body, "ef", 4)).status, 200);
    assert.equal((await f.complete(made.body, "abcdef")).status, 200);
    await f.service.waitForIdle();
    assert.equal((await f.api(`/${made.body.task.id}`)).body.task.status, "complete");
    assert.equal(await readFile(path.join(f.directories.a, "外层", kind, "中文.bin"), "utf8"), "abcdef");
  }
  assert.equal(f.publications.length, 5);
  assert.equal(f.errors.length, 0);
  assert.equal(f.changes.filter((item) => path.basename(item) === "外层").length, 1);
});

test("chunk checks are sequential, idempotent, and reject mismatching prefix after refresh and restart", async (t) => {
  const f = await fixture(t); const made = await f.create();
  assert.equal((await f.chunk(made.body, "abcd", 4)).body.code, "UPLOAD_OFFSET_MISMATCH");
  assert.equal((await f.chunk(made.body, "abcd", 0, "é".repeat(36))).body.code, "UPLOAD_RESUME_REQUIRED");
  assert.equal((await f.chunk(made.body, "abc", 0)).body.code, "UPLOAD_CHUNK_SIZE_MISMATCH");
  assert.equal((await f.chunk(made.body, "abcd", 0, undefined, "alice", sha("xxxx"))).body.code, "UPLOAD_CHUNK_HASH_MISMATCH");
  const first = await f.chunk(made.body, "abcd"); assert.equal(first.body.task.receivedBytes, 4);
  assert.equal((await f.chunk(made.body, "abcd")).body.duplicate, true);
  assert.equal((await f.chunk(made.body, "xxxx")).body.code, "UPLOAD_CHUNK_CONFLICT");
  assert.equal((await f.complete(made.body, "abcdefgh")).body.code, "UPLOAD_INCOMPLETE");
  await f.restart();
  assert.equal((await f.chunk(made.body, "efgh", 4)).body.code, "UPLOAD_RESUME_REQUIRED");
  assert.equal((await f.api(`/${made.body.task.id}/resume`, { method: "POST", body: { prefixHashes: [sha("xxxx")] } })).body.code, "UPLOAD_PREFIX_MISMATCH");
  const resumed = await f.api(`/${made.body.task.id}/resume`, { method: "POST", body: { prefixHashes: [sha("abcd")] } });
  assert.equal(resumed.status, 200); assert.equal((await f.chunk(resumed.body, "efgh", 4)).status, 200);
  assert.equal((await f.complete(resumed.body, "abcdefghX")).body.code, "UPLOAD_FILE_HASH_MISMATCH");
  assert.equal((await f.complete(resumed.body, "abcdefgh")).status, 200);
  await f.service.waitForIdle();
  assert.equal(await readFile(path.join(f.directories.a, "test.bin"), "utf8"), "abcdefgh");
});

test("task ownership and current upload/directory permissions are rechecked", async (t) => {
  const f = await fixture(t); const made = await f.create(); const id = made.body.task.id;
  assert.equal((await f.api(`/${id}`, { user: "bob" })).status, 404);
  assert.equal((await f.api("", { user: "bob" })).body.tasks.length, 0);
  assert.equal((await f.chunk(made.body, "abcd", 0, undefined, "bob")).status, 404);
  f.permissions.alice = false;
  for (const method of ["GET", "DELETE", "PATCH"]) assert.equal((await f.api(`/${id}`, { method, ...(method === "PATCH" ? { body: { relativePath: "other.bin" } } : {}) })).status, 403);
  f.permissions.alice = true; f.targetPermissions.a = false;
  assert.equal((await f.chunk(made.body, "abcd")).status, 403);
  assert.equal((await f.api("")).body.tasks.length, 0);
  f.targetPermissions.a = true;
  assert.equal((await f.chunk(made.body, "abcd")).status, 200);
  assert.equal((await f.api("/targets", { user: "guest" })).status, 401);
});

test("empty directories inherit only each newly created layer; existing directories are untouched", async (t) => {
  const inherited = new Set();
  const f = await fixture(t, {
    authorizePath: async (_request, _kind, target, relative, flags) => {
      if (relative === "One/Two" && flags.directory) assert.ok(inherited.has(path.join(target.path, "One")));
    },
    onDirectoriesCreated: async (_request, _kind, _target, paths) => { for (const value of paths) inherited.add(value); },
  });
  const response = await f.api("/directories", { method: "POST", body: { kind: "video", targetId: "a", relativePath: "One/Two/空目录" } });
  assert.equal(response.status, 201); assert.equal(response.body.createdCount, 3); assert.equal(inherited.size, 3);
  assert.equal((await stat(path.join(f.directories.a, "One", "Two", "空目录"))).isDirectory(), true);
  assert.equal((await f.api("/directories", { method: "POST", body: { kind: "video", targetId: "a", relativePath: "One" } })).status, 409);
  assert.equal(inherited.size, 3);
});

test("existing files and case aliases pause conflicts; rename target preserves originals", async (t) => {
  const f = await fixture(t); await writeFile(path.join(f.directories.a, "Original.bin"), "original");
  const made = await f.create("original.BIN", 4); assert.equal(made.status, 409); assert.equal(made.body.task.status, "conflict");
  const id = made.body.task.id;
  const changed = await f.api(`/${id}`, { method: "PATCH", body: { relativePath: "Different.bin" } }); assert.equal(changed.status, 200);
  const resumed = await f.api(`/${id}/resume`, { method: "POST", body: { prefixHashes: [] } });
  assert.equal((await f.chunk(resumed.body, "new!")).status, 200); assert.equal((await f.complete(resumed.body, "new!")).status, 200);
  assert.equal(await readFile(path.join(f.directories.a, "Original.bin"), "utf8"), "original");
  assert.equal(await readFile(path.join(f.directories.a, "Different.bin"), "utf8"), "new!");
});

test("related conflict suspends the group and group retarget keeps subtitle naming", async (t) => {
  const f = await fixture(t); await writeFile(path.join(f.directories.a, "movie.srt"), "original subtitle");
  const main = await f.create("movie.mp4", 4);
  const sub = await f.create("movie.srt", 4, { groupId: main.body.task.groupId }); assert.equal(sub.status, 409);
  assert.equal((await f.chunk(main.body, "abcd")).body.code, "UPLOAD_GROUP_CONFLICT");
  const move = await f.api(`/${main.body.task.id}`, { method: "PATCH", body: { relativePath: "new/movie-new.mp4", includeGroup: true } });
  assert.equal(move.status, 200); assert.deepEqual(move.body.tasks.map((item) => item.relativePath), ["new/movie-new.mp4", "new/movie-new.srt"]);
  assert.equal((await f.chunk(main.body, "abcd")).status, 200);
  assert.equal((await f.api(`/${main.body.task.id}?includeGroup=1`, { method: "DELETE" })).body.tasks.length, 2);
  assert.equal(await readFile(path.join(f.directories.a, "movie.srt"), "utf8"), "original subtitle");
});

test("disk reservations account for incomplete tasks and configured max size", async (t) => {
  let freeBytes = 28;
  const f = await fixture(t, { getFreeBytes: async () => freeBytes, getSettings: () => ({ uploadMaxFileBytes: 12 }) });
  assert.equal((await f.create("large.bin", 13)).status, 413);
  const first = await f.create("one.bin", 8); assert.equal(first.status, 201);
  assert.equal((await f.create("two.bin", 8)).body.code, "UPLOAD_DISK_FULL");
  await f.api(`/${first.body.task.id}`, { method: "DELETE" });
  assert.equal((await f.create("two.bin", 8)).status, 201);
  freeBytes = 16;
  assert.equal((await f.create("three.bin", 0)).status, 507);
});

test("simultaneously created tasks cannot over-reserve the same disk", async (t) => {
  const f = await fixture(t, { getFreeBytes: async () => { await delay(15); return 28; } });
  const responses = await Promise.all([f.create("one.bin", 8), f.create("two.bin", 8), f.create("three.bin", 8)]);
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 507).length, 2);
});

test("cancel and expiry remove only task staging and never published/user files", async (t) => {
  const f = await fixture(t); const made = await f.create(); await f.chunk(made.body, "abcd");
  const manifest = await f.manifest(made.body.task.id);
  await writeFile(path.join(f.directories.a, "keep.bin"), "keep");
  assert.equal((await f.api(`/${made.body.task.id}`, { method: "DELETE" })).body.task.status, "cancelled");
  await assert.rejects(stat(manifest.stagePath), { code: "ENOENT" });
  await assert.rejects(stat(path.dirname(manifest.stagePath)), { code: "ENOENT" });
  const expires = await f.create("expires.bin"); f.advanceTime(86400001);
  assert.equal((await f.api(`/${expires.body.task.id}`)).status, 410);
  assert.equal(await readFile(path.join(f.directories.a, "keep.bin"), "utf8"), "keep");
});

test("cross-root retarget copies and verifies before relinquishing confirmed bytes", async (t) => {
  let copyFails = true;
  const f = await fixture(t, { publishCopy: async (...args) => { if (copyFails) throw Object.assign(new Error("disk failed"), { code: "EIO" }); return copyFile(...args); } });
  const made = await f.create(); await f.chunk(made.body, "abcd"); const id = made.body.task.id;
  const old = await f.manifest(id);
  assert.equal((await f.api(`/${id}`, { method: "PATCH", body: { targetId: "b" } })).status, 500);
  assert.equal(await readFile(old.stagePath, "utf8"), "abcd");
  copyFails = false;
  assert.equal((await f.api(`/${id}`, { method: "PATCH", body: { targetId: "b", relativePath: "moved.bin" } })).status, 200);
  const moved = await f.manifest(id); assert.ok(moved.stagePath.startsWith(f.directories.b));
  assert.equal(await readFile(moved.stagePath, "utf8"), "abcd"); await assert.rejects(stat(old.stagePath), { code: "ENOENT" });
  assert.equal((await f.chunk(made.body, "efgh", 4)).status, 200);
  assert.equal((await f.complete(made.body, "abcdefgh")).status, 200);
  assert.equal(await readFile(path.join(f.directories.b, "moved.bin"), "utf8"), "abcdefgh");
});

test("group retarget rolls every task back if a later companion copy fails", async (t) => {
  let copies = 0;
  const f = await fixture(t, { publishCopy: async (...args) => { if (++copies === 2) throw Object.assign(new Error("copy interrupted"), { code: "EIO" }); return copyFile(...args); } });
  const main = await f.create("movie.mp4", 4); const sub = await f.create("movie.en.srt", 4, { groupId: main.body.task.groupId });
  await f.chunk(main.body, "abcd"); await f.chunk(sub.body, "sub!");
  const oldMain = await f.manifest(main.body.task.id), oldSub = await f.manifest(sub.body.task.id);
  const moved = await f.api(`/${sub.body.task.id}`, { method: "PATCH", body: { targetId: "b", relativePath: "moved/renamed.en.srt", includeGroup: true } });
  assert.equal(moved.status, 500);
  for (const previous of [oldMain, oldSub]) {
    const task = (await f.api(`/${previous.id}`)).body.task;
    assert.equal(task.targetId, "a"); assert.equal(task.relativePath, previous.relativePath);
    assert.equal((await stat(previous.stagePath)).size, 4);
  }
  assert.equal((await readdir(path.join(f.dataDirectory, "uploads", "retargets"))).length, 0);
  const retried = await f.api(`/${sub.body.task.id}`, { method: "PATCH", body: { targetId: "b", relativePath: "moved/renamed.en.srt", includeGroup: true } });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body.tasks.map((task) => task.relativePath), ["moved/renamed.mp4", "moved/renamed.en.srt"]);
});

test("retarget journals recover interrupted groups on either side of their durable commit", async (t) => {
  for (const committed of [false, true]) {
    const f = await fixture(t); const made = await f.create("before.bin", 4); await f.chunk(made.body, "abcd");
    await f.service.close(); const before = await f.manifest(made.body.task.id);
    const newStage = path.join(f.directories.b, ".lmd-upload-staging", before.id, "migrated.part");
    await mkdir(path.dirname(newStage), { recursive: true }); await copyFile(before.stagePath, newStage);
    const after = { ...before, stagePath: newStage, storageRoot: f.directories.b, targetRoot: f.directories.b, targetId: "b", relativePath: "after.bin",
      obsoleteStages: [{ path: before.stagePath, storageRoot: before.storageRoot }] };
    await f.saveManifest(after);
    const journalId = "a2e3a390-84a2-4e61-a0c0-3a7b742a3f04";
    await writeFile(path.join(f.dataDirectory, "uploads", "retargets", `${journalId}.json`), JSON.stringify({ id: journalId, committed, snapshots: [before] }));
    await f.restart();
    const task = (await f.api(`/${before.id}`)).body.task;
    assert.equal(task.targetId, committed ? "b" : "a"); assert.equal(task.relativePath, committed ? "after.bin" : "before.bin");
    assert.equal(await readFile(committed ? newStage : before.stagePath, "utf8"), "abcd");
    await assert.rejects(stat(committed ? before.stagePath : newStage), { code: "ENOENT" });
  }
});

test("zero byte files publish with the full empty-file digest", async (t) => {
  const f = await fixture(t); const made = await f.create("empty.bin", 0);
  assert.equal((await f.complete(made.body, "")).status, 200);
  assert.equal((await stat(path.join(f.directories.a, "empty.bin"))).size, 0);
});

test("exclusive publication wins no overwrite races, including unsupported hardlinks", async (t) => {
  for (const fallback of [false, true]) {
    let raced = false;
    const f = await fixture(t, { publishLink: async (source, destination) => {
      if (!raced) { raced = true; await writeFile(destination, "competitor", { flag: "wx" }); }
      if (fallback) throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      return link(source, destination);
    } });
    const made = await f.create("race.bin", 4); await f.chunk(made.body, "abcd");
    assert.equal((await f.complete(made.body, "abcd")).body.code, "UPLOAD_CONFLICT");
    assert.equal(await readFile(path.join(f.directories.a, "race.bin"), "utf8"), "competitor");
    assert.equal(f.service.isExcludedPath(path.join(f.directories.a, "race.bin")), false);
  }
});

test("fallback publication excludes pending originals and releases visibility after durable success", async (t) => {
  let f; let pendingObserved = false;
  f = await fixture(t, { publishLink: async () => { throw Object.assign(new Error("unsupported"), { code: "EXDEV" }); },
    getFreeBytes: async () => { if (f?.service.isExcludedPath(path.join(f.directories.a, "fallback.bin"))) pendingObserved = true; return 1000000; } });
  const made = await f.create("fallback.bin", 4); await f.chunk(made.body, "abcd");
  assert.equal((await f.complete(made.body, "abcd")).status, 200); assert.ok(pendingObserved);
  assert.equal(f.service.isExcludedPath(path.join(f.directories.a, "fallback.bin")), false);
  assert.equal(f.service.isExcludedPath(path.join(f.directories.a, ".lmd-upload-staging", "anything")), true);
  assert.equal(await readFile(path.join(f.directories.a, "fallback.bin"), "utf8"), "abcd");
});

test("permissions revoked during publication prevent exposing either a copied or linked original", async (t) => {
  for (const fallback of [false, true]) {
    let f, revoke = true;
    f = await fixture(t, { publishLink: async (source, destination) => {
      if (fallback) {
        if (revoke) f.permissions.alice = false;
        throw Object.assign(new Error("unsupported"), { code: "EXDEV" });
      }
      await link(source, destination);
      if (revoke) f.permissions.alice = false;
    } });
    const made = await f.create("revoked.bin", 4); await f.chunk(made.body, "abcd");
    const before = await f.manifest(made.body.task.id);
    assert.equal((await f.complete(made.body, "abcd")).status, 403);
    await assert.rejects(stat(path.join(f.directories.a, "revoked.bin")), { code: "ENOENT" });
    assert.equal(await readFile(before.stagePath, "utf8"), "abcd");
    revoke = false; f.permissions.alice = true;
    assert.equal((await f.complete(made.body, "abcd")).status, 200);
    assert.equal(await readFile(path.join(f.directories.a, "revoked.bin"), "utf8"), "abcd");
  }
});

test("fully copied originals without a final permission marker remain hidden until authorized resume", async (t) => {
  const f = await fixture(t); const made = await f.create("uncommitted.bin", 4); await f.chunk(made.body, "abcd");
  await f.service.close(); const stored = await f.manifest(made.body.task.id);
  const destination = path.join(f.directories.a, "uncommitted.bin"); await copyFile(stored.stagePath, destination); const info = await stat(destination);
  stored.status = "publishing"; stored.sha256 = sha("abcd"); stored.publication = { path: destination, mode: "copy", identity: { dev: String(info.dev), ino: String(info.ino) } };
  await f.saveManifest(stored); await f.restart();
  assert.ok(f.service.isExcludedPath(destination));
  assert.equal((await f.api(`/${stored.id}`)).body.task.errorCode, "UPLOAD_COMMIT_RECHECK_REQUIRED");
  f.permissions.alice = false;
  assert.equal((await f.complete(made.body, "abcd")).status, 403); assert.ok(f.service.isExcludedPath(destination));
  f.permissions.alice = true;
  const resumed = await f.api(`/${stored.id}/resume`, { method: "POST", body: { prefixHashes: [sha("abcd")] } });
  assert.equal(resumed.status, 200);
  assert.equal((await f.complete(resumed.body, "abcd")).status, 200); await f.service.waitForIdle();
  assert.equal(f.service.isExcludedPath(destination), false);
  assert.equal((await f.api(`/${stored.id}`)).body.task.status, "complete");
});

test("restart truncates unconfirmed chunk tails and removes only owned incomplete publications", async (t) => {
  const f = await fixture(t); const made = await f.create("crash.bin", 8); await f.chunk(made.body, "abcd");
  let stored = await f.manifest(made.body.task.id);
  await writeFile(stored.stagePath, "abcdTAIL"); await f.restart();
  assert.equal(await readFile(stored.stagePath, "utf8"), "abcd");
  await f.service.close();
  const destination = path.join(f.directories.a, "crash.bin"); await writeFile(destination, "ab"); const info = await stat(destination);
  stored = await f.manifest(made.body.task.id);
  stored.status = "publishing"; stored.sha256 = sha("abcdefgh");
  stored.publication = { path: destination, mode: "copy", identity: { dev: String(info.dev), ino: String(info.ino) } };
  await f.saveManifest(stored); await f.restart();
  await assert.rejects(stat(destination), { code: "ENOENT" });
  assert.equal((await f.api(`/${made.body.task.id}`)).body.task.status, "uploading");
  assert.equal(await readFile(stored.stagePath, "utf8"), "abcd");
});

test("restart recognizes fully published hardlinks and keeps unrelated collision files", async (t) => {
  for (const unrelated of [false, true]) {
    const f = await fixture(t); const made = await f.create("crash.bin", 4); await f.chunk(made.body, "abcd");
    await f.service.close(); const stored = await f.manifest(made.body.task.id); const destination = path.join(f.directories.a, "crash.bin");
    if (unrelated) await writeFile(destination, "someone else"); else await link(stored.stagePath, destination);
    stored.status = "publishing"; stored.sha256 = sha("abcd"); stored.publication = { path: destination, mode: "link", commitAuthorized: true };
    await f.saveManifest(stored); await f.restart(); await f.service.waitForIdle();
    assert.equal((await f.api(`/${made.body.task.id}`)).body.task.status, unrelated ? "conflict" : "complete");
    assert.equal(await readFile(destination, "utf8"), unrelated ? "someone else" : "abcd");
  }
});

test("unknown copy ownership after a crash stays shielded through cancellation and expiry", async (t) => {
  const f = await fixture(t); const made = await f.create("uncertain.bin", 4); await f.chunk(made.body, "abcd");
  await f.service.close(); const stored = await f.manifest(made.body.task.id);
  const destination = path.join(f.directories.a, "uncertain.bin"); await writeFile(destination, "ab");
  stored.status = "publishing"; stored.sha256 = sha("abcd"); stored.publication = { path: destination, mode: "copy" };
  await f.saveManifest(stored); await f.restart();
  assert.equal((await f.api(`/${made.body.task.id}`)).body.task.errorCode, "UPLOAD_PUBLICATION_UNCERTAIN");
  assert.ok(f.service.isExcludedPath(destination));
  assert.equal((await f.api(`/${made.body.task.id}`, { method: "DELETE" })).body.code, "UPLOAD_PUBLICATION_UNCERTAIN");
  f.advanceTime(86400001); await f.restart();
  assert.ok(f.service.isExcludedPath(destination));
  assert.equal(await readFile(destination, "utf8"), "ab");
  assert.equal(await readFile(stored.stagePath, "utf8"), "abcd");
});

test("junctions/symlinks, protected directories, case parents, and unsupported types are refused", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.directories.a, "junction"); await symlink(f.directories.b, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.create("junction/escaped.bin", 4)).body.code, "UNSAFE_UPLOAD_DIRECTORY");
  await mkdir(path.join(f.directories.a, "Existing"));
  assert.equal((await f.create("existing/file.bin", 4)).body.code, "UPLOAD_CASE_CONFLICT");
  assert.equal((await f.create("bad.unsupported", 4, { kind: "video" })).status, 415);
  f.directories.b = f.dataDirectory;
  assert.equal((await f.create("data.bin", 4, { targetId: "b" })).body.code, "PROTECTED_UPLOAD_PATH");
});

test("index failure preserves original bytes and supports an explicit index retry", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { onPublished: async () => { if (++attempts === 1) throw new Error("scan failed"); } });
  const made = await f.create("indexed.bin", 4); await f.chunk(made.body, "abcd"); await f.complete(made.body, "abcd");
  await f.service.waitForIdle();
  assert.equal((await f.api(`/${made.body.task.id}`)).body.task.status, "index_failed");
  assert.equal(await readFile(path.join(f.directories.a, "indexed.bin"), "utf8"), "abcd");
  assert.equal((await f.api(`/${made.body.task.id}/reindex`, { method: "POST", body: {} })).status, 200);
  await f.service.waitForIdle(); assert.equal((await f.api(`/${made.body.task.id}`)).body.task.status, "complete");
});

test("same-offset concurrent writes are locked; upload concurrency is per-user and global", async (t) => {
  const f = await fixture(t); const made = await f.create();
  const pending = [];
  async function holdUpload(task, user = "alice") {
    const request = httpRequest(`${f.base}/api/uploads/${task.task.id}/chunks?offset=0`, { method: "PUT", headers: {
      "x-user": user, "x-upload-token": task.resumeToken, "x-chunk-sha256": sha("abcd"), "Content-Length": "4",
    } });
    const response = new Promise((resolve, reject) => { request.on("error", reject); request.on("response", (reply) => {
      const chunks = []; reply.on("data", (chunk) => chunks.push(chunk)); reply.on("end", () => resolve({ status: reply.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); });
    request.write("a"); pending.push(request); await delay(50); return { request, response };
  }
  t.after(() => { for (const request of pending) request.destroy(); });
  const first = await holdUpload(made.body);
  assert.equal((await f.chunk(made.body, "abcd")).body.code, "UPLOAD_BUSY");
  const secondTask = await f.create("second.bin"); const second = await holdUpload(secondTask.body);
  const thirdTask = await f.create("third.bin");
  assert.equal((await f.chunk(thirdTask.body, "abcd")).body.code, "UPLOAD_CONCURRENCY_LIMIT");
  const bobOne = await f.api("", { method: "POST", user: "bob", body: { kind: "files", targetId: "a", relativePath: "bob-one.bin", size: 8 } });
  const bobTwo = await f.api("", { method: "POST", user: "bob", body: { kind: "files", targetId: "a", relativePath: "bob-two.bin", size: 8 } });
  const third = await holdUpload(bobOne.body, "bob"); const fourth = await holdUpload(bobTwo.body, "bob");
  f.permissions.carol = true;
  const carol = await f.api("", { method: "POST", user: "carol", body: { kind: "files", targetId: "a", relativePath: "carol.bin", size: 8 } });
  assert.equal((await f.chunk(carol.body, "abcd", 0, undefined, "carol")).body.code, "UPLOAD_CONCURRENCY_LIMIT");
  for (const active of [first, second, third, fourth]) active.request.end("bcd");
  for (const active of [first, second, third, fourth]) assert.equal((await active.response).status, 200);
  assert.equal((await f.chunk(thirdTask.body, "abcd")).status, 200);
});
