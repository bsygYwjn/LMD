import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, statfs, truncate, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const UPLOAD_MAX_FILE_BYTES = 100 * 1024 ** 3;
export const UPLOAD_RESERVE_BYTES = 2 * 1024 ** 3;
export const UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_STAGING_DIRECTORY = ".lmd-upload-staging";
const KINDS = new Set(["video", "music", "reading", "photos", "files"]);
const FINISHED = new Set(["published", "indexing", "complete", "index_failed", "cancelled"]);
const HASH = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class UploadError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(status, code, message, extra) { throw new UploadError(status, code, message, extra); }
function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function pathKey(value) { return path.resolve(value).toLocaleLowerCase("en-US"); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }

/** Apply Windows filename rules on every host, including Linux-based isolated tests. */
export function validateUploadRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\\") || path.posix.isAbsolute(value)) {
    fail(400, "INVALID_UPLOAD_PATH", "上传路径必须是以 / 分隔的相对路径。");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.length > 255 || /[<>:"|?*\x00-\x1f\x7f]/.test(segment)
      || /[. ]$/.test(segment) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
      || [UPLOAD_STAGING_DIRECTORY, ".lmd-uploads"].includes(segment.toLowerCase()) || /^(?:\.git|\.codex|\.agents)$/i.test(segment)) {
      fail(400, "INVALID_UPLOAD_PATH", "上传路径包含不安全或 Windows 不支持的文件名。");
    }
  }
  return segments;
}

function publicTask(task) {
  const chunks = task.chunks.map((chunk) => ({ ...chunk }));
  return { id: task.id, groupId: task.groupId, kind: task.kind, targetId: task.targetId, libraryId: task.libraryId,
    relativePath: task.relativePath, size: task.size, lastModified: task.lastModified, receivedBytes: task.receivedBytes,
    received: task.receivedBytes, chunks, blocks: chunks, status: task.status, error: task.error || null,
    errorCode: task.errorCode || null, sha256: task.sha256 || null, createdAt: task.createdAt, updatedAt: task.updatedAt };
}

async function defaultReadJson(request) {
  let length = 0;
  const buffers = [];
  for await (const buffer of request) {
    length += buffer.length;
    if (length > 4 * 1024 * 1024) fail(413, "BODY_TOO_LARGE", "请求内容过大。");
    buffers.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString("utf8") || "{}"); }
  catch { fail(400, "INVALID_JSON", "请求内容不是有效 JSON。"); }
}

function defaultSendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const buffer of createReadStream(filePath)) hash.update(buffer);
  return hash.digest("hex");
}

/**
 * Paths only originate from trusted adapters; clients send opaque target IDs.
 * identify and resolveTarget MUST re-evaluate current authentication/authorization.
 * authorizePath additionally enforces bucket boundaries beneath a writable target.
 */
export function createUploadService({ dataDirectory, identify, listTargets, resolveTarget,
  authorizePath = async () => {}, onDirectoriesCreated = async () => {}, isSupported = () => true,
  isProtectedPath = () => false, onPublished = async () => {}, getSettings = () => ({}),
  sendJson = defaultSendJson, readJson = defaultReadJson, chunkBytes = UPLOAD_CHUNK_BYTES,
  reserveBytes = UPLOAD_RESERVE_BYTES, retentionMs = UPLOAD_RETENTION_MS,
  getFreeBytes = async (directory) => { const info = await statfs(directory, { bigint: true }); return Number(info.bavail * info.bsize); },
  now = Date.now, publishLink = link, publishCopy = copyFile,
  protectedPaths = [dataDirectory, PROGRAM_ROOT], onError = () => {},
} = {}) {
  if (!dataDirectory || !identify || !listTargets || !resolveTarget) throw new TypeError("Upload service adapters are required.");
  const manifestsDirectory = path.join(dataDirectory, "uploads", "tasks");
  const retargetsDirectory = path.join(dataDirectory, "uploads", "retargets");
  const tasks = new Map();
  const locks = new Set();
  const transfers = new Map();
  const tokens = new Map();
  const pendingPaths = new Set();
  const indexing = new Map();
  const spaceReservations = new Map();
  let reservationTail = Promise.resolve();
  let initPromise;
  let pruneTimer;
  let closed = false;

  function maxFileBytes() {
    const configured = Number(getSettings()?.uploadMaxFileBytes ?? getSettings()?.maxUploadFileBytes ?? UPLOAD_MAX_FILE_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : UPLOAD_MAX_FILE_BYTES;
  }
  function limits() { return { chunkBytes, maxFileBytes: maxFileBytes(), retentionMs, reserveBytes, globalConcurrency: 4, userConcurrency: 2 }; }
  function manifestPath(task) { return path.join(manifestsDirectory, `${task.id}.json`); }
  function taskStageRoot(task, storageRoot = task.storageRoot) { return path.join(storageRoot, UPLOAD_STAGING_DIRECTORY, task.id); }
  function safeStage(task, filePath, storageRoot = task.storageRoot) { return typeof filePath === "string" && inside(taskStageRoot(task, storageRoot), filePath) && filePath !== taskStageRoot(task, storageRoot); }
  function isExcludedPath(filePath) {
    return path.resolve(filePath).split(/[\\/]/).some((part) => part.toLowerCase() === UPLOAD_STAGING_DIRECTORY) || pendingPaths.has(pathKey(filePath));
  }
  async function saveJson(filePath, value) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporaryPath, filePath); }
    catch (error) { await unlink(temporaryPath).catch(() => {}); throw error; }
  }
  async function save(task) { await saveJson(manifestPath(task), task); }
  function setStatus(task, status, error = null, code = null) {
    task.status = status; task.error = error; task.errorCode = code; task.updatedAt = now();
  }
  async function assertNotProtected(filePath) {
    if (protectedPaths.filter(Boolean).some((protectedPath) => inside(protectedPath, filePath)) || await isProtectedPath(filePath)) {
      fail(403, "PROTECTED_UPLOAD_PATH", "不能上传到程序、运行数据或受保护目录。");
    }
  }
  async function assertNoLinks(filePath) {
    const resolved = path.resolve(filePath);
    const root = path.parse(resolved).root;
    let current = root;
    for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) return;
      if (info.isSymbolicLink()) fail(403, "UNSAFE_UPLOAD_DIRECTORY", "上传目录不能经过符号链接或目录联接。");
      if (current !== resolved && !info.isDirectory()) fail(409, "UPLOAD_PARENT_NOT_DIRECTORY", "上传路径的父级不是文件夹。");
    }
    const actual = await realpath(resolved).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (actual && pathKey(actual) !== pathKey(resolved)) fail(403, "UNSAFE_UPLOAD_DIRECTORY", "上传路径指向了其他实际目录。");
  }
  async function principal(request) {
    const identity = await identify(request);
    const userId = identity?.userId ?? identity?.id;
    if (!userId) fail(401, "AUTH_REQUIRED", "请登录后上传。");
    return { ...identity, userId: String(userId) };
  }
  async function targetFor(request, kind, targetId, relativePath, create = false) {
    if (!KINDS.has(kind)) fail(400, "INVALID_UPLOAD_KIND", "不支持这个共享分类。");
    const target = await resolveTarget(request, kind, targetId);
    if (!target?.path || !path.isAbsolute(target.path)) fail(403, "UPLOAD_TARGET_FORBIDDEN", "当前目录不可上传。");
    const normalized = { ...target, path: path.resolve(target.path), rootPath: path.resolve(target.rootPath || target.path) };
    if (!inside(normalized.rootPath, normalized.path)) fail(403, "UNSAFE_UPLOAD_DIRECTORY", "上传目标不在共享目录中。");
    await assertNotProtected(normalized.rootPath);
    await assertNotProtected(normalized.path);
    await assertNoLinks(normalized.path);
    if (!(await stat(normalized.path)).isDirectory()) fail(409, "UPLOAD_TARGET_MISSING", "上传目标文件夹不存在。");
    normalized.volumeKey = String((await stat(normalized.rootPath)).dev);
    if (relativePath) {
      const segments = validateUploadRelativePath(relativePath);
      const destination = path.resolve(normalized.path, ...segments);
      if (!inside(normalized.path, destination)) fail(400, "INVALID_UPLOAD_PATH", "上传路径越过了目标目录。");
      await assertNotProtected(destination);
      await assertNoLinks(destination);
      await authorizePath(request, kind, normalized, relativePath, { create });
    }
    return normalized;
  }
  async function ownedTask(request, id) {
    const identity = await principal(request);
    const task = tasks.get(id);
    if (!task || task.ownerId !== identity.userId) fail(404, "UPLOAD_NOT_FOUND", "找不到这个上传任务。");
    if (task.updatedAt + retentionMs < now() && !locks.has(id) && !indexing.has(id)) {
      await discard(task); fail(410, "UPLOAD_EXPIRED", "上传任务已过期，请重新选择文件。");
    }
    const target = await targetFor(request, task.kind, task.targetId, task.relativePath, true);
    return { task, target, identity };
  }
  function assertMutable(task, allowPublication = false) {
    if (FINISHED.has(task.status)) fail(409, "UPLOAD_ALREADY_FINISHED", "这个上传任务已结束。", { task: publicTask(task) });
    if (task.status === "error") fail(409, "UPLOAD_DAMAGED", task.error || "暂存文件校验失败，请取消后重新上传。", { task: publicTask(task) });
    if (task.publication && !allowPublication) fail(409, "UPLOAD_PUBLICATION_PENDING", "文件的上次提交需要恢复，请重试提交后再操作。", { task: publicTask(task) });
  }
  function assertToken(task, supplied) {
    const actual = tokens.get(task.id);
    if (typeof supplied !== "string" || !UUID.test(supplied) || !actual || actual.length !== supplied.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(supplied))) {
      fail(409, "UPLOAD_RESUME_REQUIRED", "请重新选择原文件并校验已上传内容后继续。", { task: publicTask(task) });
    }
  }
  async function withLock(task, action, transfer = false) {
    if (locks.has(task.id)) fail(409, "UPLOAD_BUSY", "这个文件正在处理其他上传请求，请稍后重试。");
    if (transfer && (transfers.size >= 4 || [...transfers.values()].filter((id) => id === task.ownerId).length >= 2)) {
      fail(429, "UPLOAD_CONCURRENCY_LIMIT", "上传并发已满，请稍后重试。");
    }
    locks.add(task.id);
    if (transfer) transfers.set(task.id, task.ownerId);
    try { return await action(); }
    finally { locks.delete(task.id); transfers.delete(task.id); }
  }
  async function ensureCapacity(target, extraBytes = 0, excludeTaskId = null) {
    const freeBytes = await getFreeBytes(target.rootPath);
    if (!Number.isFinite(freeBytes) || freeBytes < 0) fail(507, "UPLOAD_DISK_UNKNOWN", "无法检查目标磁盘的剩余空间。");
    const replacedTasks = new Set([...spaceReservations.values()].filter((reservation) => reservation.volumeKey === target.volumeKey).map((reservation) => reservation.replaceTaskId));
    const reserved = [...tasks.values()].filter((task) => task.id !== excludeTaskId && !replacedTasks.has(task.id) && !FINISHED.has(task.status) && task.volumeKey === target.volumeKey)
      .reduce((sum, task) => sum + Math.max(0, task.size - task.receivedBytes), 0)
      + [...spaceReservations.values()].filter((reservation) => reservation.volumeKey === target.volumeKey).reduce((sum, reservation) => sum + reservation.bytes, 0);
    if (freeBytes - reserved - extraBytes < reserveBytes) fail(507, "UPLOAD_DISK_FULL", "目标磁盘空间不足，需要保留至少 2 GiB 空间并满足其他上传任务。");
  }
  async function reserveSpace(target, bytes, excludeTaskId = null) {
    const prior = reservationTail;
    let release;
    reservationTail = new Promise((resolve) => { release = resolve; });
    await prior;
    try {
      await ensureCapacity(target, bytes, excludeTaskId);
      const id = randomUUID();
      spaceReservations.set(id, { volumeKey: target.volumeKey, bytes, replaceTaskId: excludeTaskId });
      return () => spaceReservations.delete(id);
    } finally { release(); }
  }
  async function caseEntry(parent, name) {
    const entries = await readdir(parent).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    return entries.find((entry) => entry.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US")) || null;
  }
  async function checkParents(target, relativePath) {
    const segments = validateUploadRelativePath(relativePath);
    let current = target.path;
    for (const segment of segments.slice(0, -1)) {
      const present = await caseEntry(current, segment);
      if (present && present !== segment) fail(409, "UPLOAD_CASE_CONFLICT", "上传路径与已有文件夹的大小写冲突，请选择已有目录。", { conflictingName: present });
      current = path.join(current, segment);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) break;
      if (info.isSymbolicLink()) fail(403, "UNSAFE_UPLOAD_DIRECTORY", "上传路径不能经过符号链接或目录联接。");
      if (!info.isDirectory()) fail(409, "UPLOAD_PARENT_NOT_DIRECTORY", "上传路径的父级不是文件夹。");
    }
  }
  async function conflictAt(target, relativePath) {
    await checkParents(target, relativePath);
    const destination = path.join(target.path, ...validateUploadRelativePath(relativePath));
    return await caseEntry(path.dirname(destination), path.basename(destination));
  }
  async function createParents(request, task, target, includeLeaf = false) {
    const parts = validateUploadRelativePath(task.relativePath);
    const directories = includeLeaf ? parts : parts.slice(0, -1);
    const created = [];
    let current = target.path;
    try {
      for (const segment of directories) {
        const present = await caseEntry(current, segment);
        if (present && present !== segment) fail(409, "UPLOAD_CASE_CONFLICT", "上传路径与已有目录的大小写冲突。");
        current = path.join(current, segment);
        await assertNotProtected(current);
        await assertNoLinks(current);
        await authorizePath(request, task.kind, target, path.relative(target.path, current).split(path.sep).join("/"), { create: true, directory: true });
        try { await mkdir(current); created.push(current); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const info = await lstat(current);
          if (info.isSymbolicLink() || !info.isDirectory()) fail(409, "UPLOAD_PARENT_NOT_DIRECTORY", "路径已存在且不是安全的文件夹。");
        }
        // Persist inherited classification before a deeper directory's authorization is evaluated.
        if (created.at(-1) === current) await onDirectoriesCreated(request, task.kind, target, [current]);
      }
      return created;
    } catch (error) {
      // Only remove empty directories created by this request; never touch existing contents.
      for (const directory of created.reverse()) await rmdir(directory).catch(() => {});
      throw error;
    }
  }
  async function stageDirectory(task, storageRoot = task.storageRoot) {
    await assertNoLinks(storageRoot);
    const root = path.join(storageRoot, UPLOAD_STAGING_DIRECTORY);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertNoLinks(root);
    const directory = taskStageRoot(task, storageRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoLinks(directory);
    return directory;
  }
  async function safeUnlinkStage(task, filePath, storageRoot = task.storageRoot) {
    if (!safeStage(task, filePath, storageRoot)) return;
    await assertNoLinks(filePath);
    await unlink(filePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(taskStageRoot(task, storageRoot)).catch(() => {});
  }
  function groupMembers(task) {
    return [...tasks.values()].filter((candidate) => candidate.ownerId === task.ownerId && candidate.kind === task.kind
      && candidate.groupId === task.groupId && !FINISHED.has(candidate.status));
  }
  async function assertGroupReady(task, request) {
    const conflict = groupMembers(task).find((candidate) => candidate.status === "conflict");
    if (!conflict) return;
    // Do not disclose another task after its directory authorization was revoked.
    await targetFor(request, conflict.kind, conflict.targetId, conflict.relativePath, true);
    fail(409, "UPLOAD_GROUP_CONFLICT", "这个文件及关联配套中存在重名项，请一起跳过或调整目标。", { task: publicTask(task), conflictTaskId: conflict.id });
  }
  async function markConflict(task, message = "目标已存在同名文件，原件已保留。请跳过或修改上传目标。") {
    setStatus(task, "conflict", message, "UPLOAD_CONFLICT");
    await save(task);
    fail(409, "UPLOAD_CONFLICT", message, { task: publicTask(task) });
  }
  async function removeOwnedPending(task) {
    const publication = task.publication;
    if (!publication?.path) return false;
    const info = await lstat(publication.path).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    const stageInfo = publication.mode === "link" ? await stat(task.stagePath).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) : null;
    const ownLink = publication.mode === "link" && info && stageInfo && info.dev === stageInfo.dev && info.ino === stageInfo.ino;
    const ownCopy = publication.mode === "copy" && info && publication.identity && String(info.dev) === publication.identity.dev && String(info.ino) === publication.identity.ino;
    if (info && !info.isSymbolicLink() && (ownLink || ownCopy)) {
      await unlink(publication.path); return true;
    }
    return false;
  }
  async function cleanupStage(task) {
    if (task.stagePath) await safeUnlinkStage(task, task.stagePath).catch(onError);
    if (task.migration?.path) await safeUnlinkStage(task, task.migration.path, task.migration.storageRoot).catch(onError);
    for (const obsolete of task.obsoleteStages || []) await safeUnlinkStage(task, obsolete.path, obsolete.storageRoot).catch(onError);
    const roots = new Set([task.storageRoot, task.migration?.storageRoot, ...(task.obsoleteStages || []).map((item) => item.storageRoot)].filter(Boolean));
    for (const root of roots) await rmdir(taskStageRoot(task, root)).catch(() => {});
  }
  async function discard(task) {
    // The copy-create/identity-save crash gap cannot be resolved by deleting an
    // unknown file. Keep its durable shield until the original is inspected.
    if (locks.has(task.id) || indexing.has(task.id) || task.publication?.uncertain) return;
    if (task.publication?.commitAuthorized) { await recover(task); if (indexing.has(task.id)) return; }
    await removeOwnedPending(task);
    if (task.publication?.path) pendingPaths.delete(pathKey(task.publication.path));
    await cleanupStage(task);
    await unlink(manifestPath(task)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    tasks.delete(task.id); tokens.delete(task.id);
  }
  async function prune() {
    for (const task of tasks.values()) if (task.updatedAt + retentionMs < now()) await discard(task);
  }
  function startIndexing(task) {
    if (closed || indexing.has(task.id)) return;
    const work = (async () => {
      try {
        setStatus(task, "indexing"); await save(task);
        await onPublished(task.publishedPath, { kind: task.kind, taskId: task.id, libraryId: task.libraryId });
        setStatus(task, "complete"); await save(task);
      } catch (error) {
        setStatus(task, "index_failed", `已上传，索引失败：${errorMessage(error)}`, "UPLOAD_INDEX_FAILED");
        await save(task).catch(onError);
      } finally { indexing.delete(task.id); }
    })();
    indexing.set(task.id, work);
  }
  async function recover(task, request = null) {
    if (task.publication) {
      const destination = task.publication.path;
      pendingPaths.add(pathKey(destination));
      await assertNoLinks(destination);
      const finalInfo = await stat(destination).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      const sourceInfo = await stat(task.stagePath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      const sameLink = task.publication.mode === "link" && finalInfo && sourceInfo && finalInfo.dev === sourceInfo.dev && finalInfo.ino === sourceInfo.ino;
      const ownedCopy = task.publication.mode === "copy" && finalInfo && task.publication.identity
        && String(finalInfo.dev) === task.publication.identity.dev && String(finalInfo.ino) === task.publication.identity.ino;
      if (task.publication.mode === "copy" && finalInfo && !task.publication.identity) {
        task.publication.uncertain = true;
        setStatus(task, "error", "上次提交被中断，无法确认目标文件归属。暂存原件和目标屏蔽均已保留，请管理员检查后恢复。", "UPLOAD_PUBLICATION_UNCERTAIN");
        await save(task); return;
      }
      if ((sameLink || ownedCopy) && finalInfo.size === task.size && task.sha256 && await hashFile(destination) === task.sha256) {
        if (!task.publication.commitAuthorized) {
          if (!request) {
            setStatus(task, "publishing", "文件已经传完，上次提交的权限复核尚未完成。请重选原文件后继续提交。", "UPLOAD_COMMIT_RECHECK_REQUIRED");
            await save(task); return;
          }
          await principal(request); await targetFor(request, task.kind, task.targetId, task.relativePath, true); await assertGroupReady(task, request);
          task.publication.commitAuthorized = true; await save(task);
        }
        task.publishedPath = destination; delete task.publication;
        setStatus(task, "published"); await save(task); pendingPaths.delete(pathKey(destination));
        await cleanupStage(task);
      } else {
        await removeOwnedPending(task);
        pendingPaths.delete(pathKey(destination));
        delete task.publication;
        setStatus(task, finalInfo && !ownedCopy ? "conflict" : "uploading", finalInfo && !ownedCopy ? "提交时发现重名文件，原件已保留。" : null,
          finalInfo && !ownedCopy ? "UPLOAD_CONFLICT" : null);
        await save(task);
      }
    }
    if (!FINISHED.has(task.status)) {
      await assertNoLinks(task.stagePath);
      const info = await stat(task.stagePath).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info || info.size < task.receivedBytes) {
        setStatus(task, "error", "上传暂存文件缺失或长度不正确，请取消后重新上传。", "UPLOAD_DAMAGED"); await save(task);
      } else if (info.size > task.receivedBytes) await truncate(task.stagePath, task.receivedBytes);
    }
    if (task.migration) {
      await safeUnlinkStage(task, task.migration.path, task.migration.storageRoot).catch(onError);
      delete task.migration; await save(task);
    }
    for (const obsolete of task.obsoleteStages || []) await safeUnlinkStage(task, obsolete.path, obsolete.storageRoot).catch(onError);
    if (task.obsoleteStages?.length) { delete task.obsoleteStages; await save(task); }
    if (task.status === "published" || task.status === "indexing") startIndexing(task);
  }
  function validStoredTask(task, name) {
    if (!UUID.test(task?.id || "") || name !== `${task.id}.json` || !KINDS.has(task.kind) || typeof task.ownerId !== "string"
      || !path.isAbsolute(task.storageRoot || "") || !safeStage(task, task.stagePath) || !Number.isSafeInteger(task.size) || task.size < 0
      || !Number.isSafeInteger(task.receivedBytes) || task.receivedBytes < 0 || task.receivedBytes > task.size || !Array.isArray(task.chunks)) return false;
    try { validateUploadRelativePath(task.relativePath); } catch { return false; }
    let offset = 0;
    for (const chunk of task.chunks) {
      if (chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > chunkBytes || !HASH.test(chunk.sha256)) return false;
      offset += chunk.size;
    }
    if (offset !== task.receivedBytes || !Number.isFinite(task.updatedAt) || !Number.isFinite(task.createdAt)) return false;
    // A manifest can only designate destinations inside its original trusted library boundary.
    if (task.publication && (!inside(task.targetRoot || task.storageRoot, task.publication.path)
      || path.resolve(task.publication.path).split(/[\\/]/).some((part) => part.toLowerCase() === UPLOAD_STAGING_DIRECTORY))) return false;
    return true;
  }
  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await mkdir(manifestsDirectory, { recursive: true, mode: 0o700 });
      await mkdir(retargetsDirectory, { recursive: true, mode: 0o700 });
      for (const name of await readdir(manifestsDirectory)) {
        if (!name.endsWith(".json")) continue;
        try {
          const task = JSON.parse(await readFile(path.join(manifestsDirectory, name), "utf8"));
          if (!validStoredTask(task, name)) { onError(new Error(`Ignored invalid upload manifest: ${name}`)); continue; }
          tasks.set(task.id, task);
          if (task.publication?.path) pendingPaths.add(pathKey(task.publication.path));
        } catch (error) { onError(error); }
      }
      for (const name of await readdir(retargetsDirectory)) {
        if (!/^[a-f0-9-]+\.json$/i.test(name)) continue;
        const journalPath = path.join(retargetsDirectory, name);
        try {
          const journal = JSON.parse(await readFile(journalPath, "utf8"));
          if (!UUID.test(journal.id || "") || name !== `${journal.id}.json` || !Array.isArray(journal.snapshots)
            || !journal.snapshots.every((snapshot) => validStoredTask(snapshot, `${snapshot.id}.json`))) throw new Error("Invalid upload retarget journal.");
          if (!journal.committed) await rollbackRetarget(journal.snapshots);
          // Committed journals already have every new task manifest durable;
          // recover() below removes obsolete staging copies.
          await unlink(journalPath);
        } catch (error) { onError(error); }
      }
      for (const task of tasks.values()) {
        try { await recover(task); }
        catch (error) { setStatus(task, "error", "上传任务恢复失败，请取消后重新上传。", "UPLOAD_RECOVERY_FAILED"); await save(task).catch(onError); onError(error); }
      }
      await prune();
      if (!closed) { pruneTimer = setInterval(() => { void prune().catch(onError); }, Math.min(retentionMs, 60 * 60 * 1000)); pruneTimer.unref?.(); }
    })();
    return initPromise;
  }

  async function createTask(request, body) {
    const identity = await principal(request);
    const { kind, targetId, relativePath } = body;
    validateUploadRelativePath(relativePath);
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes()) fail(413, "UPLOAD_FILE_TOO_LARGE", "文件大小超过当前单文件上传上限。");
    if (!await isSupported(kind, relativePath)) fail(415, "UPLOAD_UNSUPPORTED_TYPE", "这个文件格式不属于所选共享分类，请移除或选择其他文件区。");
    const target = await targetFor(request, kind, targetId, relativePath, true);
    await checkParents(target, relativePath);
    const id = randomUUID();
    const groupId = body.groupId == null ? id : String(body.groupId);
    if (!groupId || groupId.length > 200 || /[\x00-\x1f]/.test(groupId)) fail(400, "INVALID_UPLOAD_GROUP", "上传分组无效。");
    const task = { id, groupId, ownerId: identity.userId, kind, targetId, libraryId: target.libraryId, relativePath, size,
      lastModified: Number.isFinite(Number(body.lastModified)) ? Number(body.lastModified) : 0,
      storageRoot: target.rootPath, targetRoot: target.rootPath, volumeKey: target.volumeKey, receivedBytes: 0, chunks: [], status: "uploading", createdAt: now(), updatedAt: now() };
    const releaseSpace = await reserveSpace(target, size);
    try {
      const directory = await stageDirectory(task);
      task.stagePath = path.join(directory, `${randomUUID()}.part`);
      const stage = await open(task.stagePath, "wx", 0o600); await stage.close();
      try { await save(task); } catch (error) { await cleanupStage(task); throw error; }
      tasks.set(id, task);
    } finally { releaseSpace(); }
    const resumeToken = randomUUID(); tokens.set(id, resumeToken);
    if (await conflictAt(target, relativePath)) await markConflict(task);
    return { task: publicTask(task), resumeToken };
  }
  async function resumeTask(request, id, body) {
    const { task } = await ownedTask(request, id);
    return withLock(task, async () => {
      assertMutable(task, true);
      const prefixHashes = body.prefixHashes ?? body.chunks?.map((chunk) => chunk.sha256);
      if (!Array.isArray(prefixHashes) || prefixHashes.length !== task.chunks.length
        || prefixHashes.some((hash, index) => typeof hash !== "string" || hash.toLowerCase() !== task.chunks[index].sha256)) {
        fail(409, "UPLOAD_PREFIX_MISMATCH", "所选文件已上传部分与原任务不同，不能续传这个任务。");
      }
      await assertNoLinks(task.stagePath);
      const handle = await open(task.stagePath, "r");
      try {
        for (const chunk of task.chunks) {
          const buffer = Buffer.allocUnsafe(chunk.size);
          const { bytesRead } = await handle.read(buffer, 0, chunk.size, chunk.offset);
          if (bytesRead !== chunk.size || digest(buffer) !== chunk.sha256) fail(409, "UPLOAD_DAMAGED", "上传暂存内容校验失败，请取消后重新上传。");
        }
      } finally { await handle.close(); }
      const resumeToken = randomUUID(); tokens.set(task.id, resumeToken);
      task.updatedAt = now(); await save(task);
      return { task: publicTask(task), resumeToken };
    });
  }
  async function uploadChunk(request, id, offset, expectedHash, token) {
    const { task, target } = await ownedTask(request, id);
    return withLock(task, async () => {
      assertMutable(task); assertToken(task, token); await assertGroupReady(task, request);
      if (!Number.isSafeInteger(offset) || offset < 0 || !HASH.test(expectedHash || "")) fail(400, "INVALID_UPLOAD_CHUNK", "分块偏移或 SHA-256 无效。");
      const prior = task.chunks.find((chunk) => chunk.offset === offset);
      const expectedSize = prior?.size ?? Math.min(chunkBytes, task.size - task.receivedBytes);
      if (!prior && (offset !== task.receivedBytes || expectedSize <= 0)) fail(409, "UPLOAD_OFFSET_MISMATCH", "上传偏移不匹配，请查询任务后继续。", { task: publicTask(task) });
      if (!prior) await ensureCapacity(target);
      const buffers = []; let length = 0;
      for await (const buffer of request) {
        length += buffer.length;
        if (length > expectedSize) fail(413, "UPLOAD_CHUNK_TOO_LARGE", "上传分块超过规定大小。");
        buffers.push(buffer);
      }
      if (length !== expectedSize) fail(400, "UPLOAD_CHUNK_SIZE_MISMATCH", "上传分块长度不完整。");
      const contents = Buffer.concat(buffers);
      const actualHash = digest(contents);
      if (actualHash !== expectedHash.toLowerCase()) fail(422, "UPLOAD_CHUNK_HASH_MISMATCH", "上传分块 SHA-256 校验失败，请重传。");
      if (prior) {
        if (prior.sha256 !== actualHash || prior.size !== length) fail(409, "UPLOAD_CHUNK_CONFLICT", "同一偏移已收到不同内容。");
        return { task: publicTask(task), duplicate: true };
      }
      // Authentication and paths may change while an HTTP body is in flight.
      await principal(request); await targetFor(request, task.kind, task.targetId, task.relativePath, true);
      await assertNoLinks(task.stagePath);
      const handle = await open(task.stagePath, "r+");
      const previousOffset = task.receivedBytes;
      try {
        let written = 0;
        while (written < contents.length) {
          const result = await handle.write(contents, written, contents.length - written, offset + written);
          if (!result.bytesWritten) throw new Error("The upload disk stopped accepting writes.");
          written += result.bytesWritten;
        }
        await handle.sync();
        task.chunks.push({ offset, size: length, sha256: actualHash }); task.receivedBytes += length; task.updatedAt = now();
        try { await save(task); }
        catch (error) { task.chunks.pop(); task.receivedBytes = previousOffset; throw error; }
      } catch (error) { await handle.truncate(previousOffset).catch(onError); throw error; }
      finally { await handle.close(); }
      return { task: publicTask(task) };
    }, true);
  }
  async function publish(request, task, target) {
    const destination = path.join(target.path, ...validateUploadRelativePath(task.relativePath));
    const previousStatus = task.status;
    task.publication = { path: destination, mode: "link" }; task.status = "publishing";
    pendingPaths.add(pathKey(destination)); await save(task);
    try {
      await publishLink(task.stagePath, destination);
    } catch (error) {
      if (error.code === "EEXIST") {
        pendingPaths.delete(pathKey(destination)); delete task.publication; task.status = previousStatus;
        await markConflict(task);
      }
      if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(error.code)) {
        pendingPaths.delete(pathKey(destination)); delete task.publication; task.status = previousStatus; await save(task); throw error;
      }
      let releaseSpace;
      try { releaseSpace = await reserveSpace(target, task.size); }
      catch (spaceError) {
        pendingPaths.delete(pathKey(destination)); delete task.publication; task.status = previousStatus; await save(task); throw spaceError;
      }
      let destinationHandle;
      try {
        task.publication = { path: destination, mode: "copy" }; await save(task);
        destinationHandle = await open(destination, "wx", 0o600);
        const info = await destinationHandle.stat();
        task.publication.identity = { dev: String(info.dev), ino: String(info.ino) }; await save(task);
        let offset = 0;
        for await (const buffer of createReadStream(task.stagePath)) {
          let written = 0;
          while (written < buffer.length) {
            const result = await destinationHandle.write(buffer, written, buffer.length - written, offset + written);
            if (!result.bytesWritten) throw new Error("The upload disk stopped accepting writes.");
            written += result.bytesWritten;
          }
          offset += buffer.length;
        }
        await destinationHandle.sync(); await destinationHandle.close(); destinationHandle = null;
        if (await hashFile(destination) !== task.sha256) fail(500, "UPLOAD_PUBLISH_HASH_MISMATCH", "上传原件复制校验失败。");
      } catch (copyError) {
        await destinationHandle?.close().catch(() => {});
        await removeOwnedPending(task);
        pendingPaths.delete(pathKey(destination)); delete task.publication; task.status = previousStatus; await save(task);
        if (copyError.code === "EEXIST") await markConflict(task);
        throw copyError;
      } finally { releaseSpace(); }
    }
    // A fallback copy can take minutes. Recheck after copying and before the
    // durable permission marker makes this original eligible for recovery.
    try {
      await principal(request); await targetFor(request, task.kind, task.targetId, task.relativePath, true); await assertGroupReady(task, request);
    } catch (permissionError) {
      await removeOwnedPending(task);
      pendingPaths.delete(pathKey(destination)); delete task.publication;
      setStatus(task, "uploading", "上传数据已保留，提交时权限发生变化。请恢复权限后继续。", permissionError.code || "UPLOAD_FORBIDDEN");
      await save(task); throw permissionError;
    }
    task.publication.commitAuthorized = true;
    try { await save(task); }
    catch (error) { task.publication.commitAuthorized = false; throw error; }
    // The manifest is durable before scanners may see the new original.
    const publication = task.publication;
    task.publishedPath = destination; delete task.publication; setStatus(task, "published");
    try { await save(task); }
    catch (error) { delete task.publishedPath; task.publication = publication; task.status = "publishing"; throw error; }
    pendingPaths.delete(pathKey(destination)); await cleanupStage(task);
    startIndexing(task);
  }
  async function completeTask(request, id, body) {
    const { task, target } = await ownedTask(request, id);
    return withLock(task, async () => {
      if (task.publication && !task.publication.uncertain) {
        assertToken(task, body.resumeToken);
        if (!HASH.test(body.sha256 || "") || body.sha256.toLowerCase() !== task.sha256) fail(422, "UPLOAD_FILE_HASH_MISMATCH", "恢复提交时的完整文件 SHA-256 不匹配。");
        await recover(task, request);
      }
      if (FINISHED.has(task.status) && task.status !== "cancelled") return { task: publicTask(task) };
      assertMutable(task); assertToken(task, body.resumeToken); await assertGroupReady(task, request);
      if (task.receivedBytes !== task.size) fail(409, "UPLOAD_INCOMPLETE", "文件尚未上传完整。");
      if (!HASH.test(body.sha256 || "")) fail(400, "INVALID_UPLOAD_HASH", "提交文件前必须提供完整文件 SHA-256。");
      await assertNoLinks(task.stagePath);
      if (await hashFile(task.stagePath) !== body.sha256.toLowerCase()) fail(422, "UPLOAD_FILE_HASH_MISMATCH", "文件完整 SHA-256 校验失败，请确认重选了同一原文件。");
      task.sha256 = body.sha256.toLowerCase();
      await principal(request); await targetFor(request, task.kind, task.targetId, task.relativePath, true);
      if (await conflictAt(target, task.relativePath)) await markConflict(task);
      await createParents(request, task, target);
      await targetFor(request, task.kind, task.targetId, task.relativePath, true);
      if (await conflictAt(target, task.relativePath)) await markConflict(task);
      await publish(request, task, target);
      return { task: publicTask(task) };
    }, true);
  }
  async function moveStage(task, target, deferCleanup = false) {
    if (pathKey(task.storageRoot) === pathKey(target.rootPath)) return;
    const releaseSpace = await reserveSpace(target, task.size, task.id);
    let newStage;
    try {
      const directory = await stageDirectory(task, target.rootPath);
      newStage = path.join(directory, `${randomUUID()}.part`);
      task.migration = { path: newStage, storageRoot: target.rootPath }; await save(task);
      await assertNoLinks(task.stagePath);
      await publishCopy(task.stagePath, newStage, constants.COPYFILE_EXCL);
      const handle = await open(newStage, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      const [oldHash, newHash] = await Promise.all([hashFile(task.stagePath), hashFile(newStage)]);
      if (oldHash !== newHash || (await stat(newStage)).size !== task.receivedBytes) fail(500, "UPLOAD_MOVE_HASH_MISMATCH", "更改目标时复制校验失败，原上传数据已保留。");
      const oldStage = { path: task.stagePath, storageRoot: task.storageRoot };
      task.obsoleteStages = [...(task.obsoleteStages || []), oldStage];
      task.stagePath = newStage; task.storageRoot = target.rootPath; task.volumeKey = target.volumeKey; delete task.migration;
      await save(task);
      if (!deferCleanup) {
        await safeUnlinkStage(task, oldStage.path, oldStage.storageRoot);
        delete task.obsoleteStages; await save(task);
      }
    } catch (error) {
      // Do not remove the only durable copy if the manifest switch has succeeded.
      if (newStage && task.stagePath !== newStage) { await safeUnlinkStage(task, newStage, target.rootPath).catch(onError); delete task.migration; await save(task).catch(onError); }
      throw error;
    } finally { releaseSpace(); }
  }
  async function retargetOne(request, task, targetId, relativePath, deferCleanup = false) {
    assertMutable(task);
    validateUploadRelativePath(relativePath);
    if (!await isSupported(task.kind, relativePath)) fail(415, "UPLOAD_UNSUPPORTED_TYPE", "目标文件名不属于所选共享分类。");
    const target = await targetFor(request, task.kind, targetId, relativePath, true);
    if (await conflictAt(target, relativePath)) fail(409, "UPLOAD_CONFLICT", "新的目标也存在同名文件，原件已保留。", { task: publicTask(task) });
    await moveStage(task, target, deferCleanup);
    task.targetId = targetId; task.libraryId = target.libraryId; task.relativePath = relativePath; task.targetRoot = target.rootPath;
    setStatus(task, "uploading"); await save(task);
    return publicTask(task);
  }
  async function rollbackRetarget(snapshots) {
    for (const snapshot of snapshots) {
      const current = tasks.get(snapshot.id);
      const discard = [];
      if (current && current.stagePath !== snapshot.stagePath) discard.push({ path: current.stagePath, storageRoot: current.storageRoot });
      if (current?.migration?.path !== snapshot.stagePath && current?.migration?.path) discard.push(current.migration);
      const restored = structuredClone(snapshot);
      await save(restored);
      if (current) { for (const key of Object.keys(current)) delete current[key]; Object.assign(current, restored); }
      else tasks.set(restored.id, restored);
      for (const copy of discard) await safeUnlinkStage(restored, copy.path, copy.storageRoot).catch(onError);
    }
  }
  async function retargetTask(request, id, body) {
    const { task } = await ownedTask(request, id);
    assertMutable(task);
    const members = body.includeGroup ? groupMembers(task) : [task];
    const targetId = body.targetId ?? task.targetId;
    const relativePath = body.relativePath ?? task.relativePath;
    validateUploadRelativePath(relativePath);
    const originalDirectory = path.posix.dirname(task.relativePath);
    const newDirectory = path.posix.dirname(relativePath);
    const primary = members.find((member) => path.posix.dirname(member.relativePath) === originalDirectory
      && /\.(?:mp4|mkv|mov|m4v|webm|avi|ts|m2ts|mts|mpg|mpeg|flv|mp3|aac|m4a|flac|wav|wave|aif|aiff|ogg|opus|ape|wv)$/i.test(member.relativePath));
    const selectedOldStem = path.posix.basename(task.relativePath, path.posix.extname(task.relativePath));
    const selectedNewStem = path.posix.basename(relativePath, path.posix.extname(relativePath));
    const primaryStem = primary ? path.posix.basename(primary.relativePath, path.posix.extname(primary.relativePath)) : null;
    const oldStem = primaryStem && (selectedOldStem === primaryStem || selectedOldStem.startsWith(`${primaryStem}.`)) ? primaryStem : selectedOldStem;
    const suffix = selectedOldStem.startsWith(`${oldStem}.`) ? selectedOldStem.slice(oldStem.length) : "";
    const newStem = suffix && selectedNewStem.endsWith(suffix) ? selectedNewStem.slice(0, -suffix.length) : selectedNewStem;
    const changes = [];
    for (const member of members) {
      await ownedTask(request, member.id);
      if (locks.has(member.id)) fail(409, "UPLOAD_BUSY", "分组中的文件正在上传，请暂停后修改目标。");
      let nextPath = member.id === task.id ? relativePath : member.relativePath;
      if (member.id !== task.id) {
        const relative = path.posix.relative(originalDirectory, member.relativePath);
        if (relative !== ".." && !relative.startsWith("../")) {
          let name = relative;
          if (!name.includes("/") && name.startsWith(`${oldStem}.`)) name = `${newStem}${name.slice(oldStem.length)}`;
          nextPath = newDirectory === "." ? name : `${newDirectory}/${name}`;
        }
      }
      const target = await targetFor(request, member.kind, targetId, nextPath, true);
      if (await conflictAt(target, nextPath)) fail(409, "UPLOAD_CONFLICT", "新的分组目标中存在同名文件，尚未调整目标。");
      changes.push({ member, nextPath });
    }
    const results = [];
    // Hold the whole group while moving so another request cannot publish half of a retarget.
    for (const { member } of changes) if (locks.has(member.id)) fail(409, "UPLOAD_BUSY", "分组中的文件正在上传，请暂停后修改目标。");
    for (const { member } of changes) locks.add(member.id);
    const journal = { id: randomUUID(), committed: false, snapshots: changes.map(({ member }) => structuredClone(member)) };
    const journalPath = path.join(retargetsDirectory, `${journal.id}.json`);
    try {
      await saveJson(journalPath, journal);
      for (const { member, nextPath } of changes) results.push(await retargetOne(request, member, targetId, nextPath, true));
      await saveJson(journalPath, { ...journal, committed: true }); journal.committed = true;
      for (const { member } of changes) {
        for (const obsolete of member.obsoleteStages || []) await safeUnlinkStage(member, obsolete.path, obsolete.storageRoot);
        delete member.obsoleteStages; await save(member);
      }
      await unlink(journalPath);
    } catch (error) {
      if (!journal.committed) {
        try { await rollbackRetarget(journal.snapshots); }
        catch (rollbackError) {
          for (const { member } of changes) setStatus(member, "error", "调整上传目标时无法保存恢复记录，请恢复磁盘状态后重启服务。已保留原暂存文件。", "UPLOAD_RETARGET_RECOVERY_REQUIRED");
          throw rollbackError;
        }
        await unlink(journalPath).catch((failure) => { if (failure.code !== "ENOENT") onError(failure); });
      }
      throw error;
    } finally { for (const { member } of changes) locks.delete(member.id); }
    return { task: publicTask(task), tasks: results };
  }
  async function cancelTask(request, id, includeGroup) {
    const { task } = await ownedTask(request, id);
    const members = includeGroup ? groupMembers(task) : [task];
    for (const member of members) {
      await ownedTask(request, member.id);
      if (locks.has(member.id)) fail(409, "UPLOAD_BUSY", "文件正在处理，请稍后取消。");
    }
    const results = [];
    for (const member of members) if (locks.has(member.id)) fail(409, "UPLOAD_BUSY", "文件正在处理，请稍后取消。");
    for (const member of members) locks.add(member.id);
    try {
      for (const member of members) {
        if (member.publication && !member.publication.uncertain) await recover(member);
        if (FINISHED.has(member.status) && member.status !== "cancelled") fail(409, "UPLOAD_ALREADY_FINISHED", "原文件已经发布，取消不会删除已上传原件。");
        if (member.publication?.uncertain) fail(409, "UPLOAD_PUBLICATION_UNCERTAIN", "中断提交的目标归属待确认，已保留暂存文件和目标屏蔽，请管理员检查后恢复。");
      }
      for (const member of members) {
        await removeOwnedPending(member);
        if (member.publication?.path) pendingPaths.delete(pathKey(member.publication.path));
        delete member.publication; setStatus(member, "cancelled"); await save(member);
        await cleanupStage(member); tokens.delete(member.id); results.push(publicTask(member));
      }
    } finally { for (const member of members) locks.delete(member.id); }
    return { task: publicTask(task), tasks: results };
  }
  async function createDirectory(request, body) {
    await principal(request);
    const target = await targetFor(request, body.kind, body.targetId, body.relativePath, true);
    if (await conflictAt(target, body.relativePath)) fail(409, "UPLOAD_DIRECTORY_EXISTS", "同名文件或文件夹已存在。");
    const created = await createParents(request, { kind: body.kind, relativePath: body.relativePath }, target, true);
    return { ok: true, relativePath: body.relativePath, createdCount: created.length, targetId: target.id ?? body.targetId };
  }
  async function handleRequest(request, response, url, pathname = url.pathname) {
    if (pathname !== "/api/uploads" && !pathname.startsWith("/api/uploads/")) return false;
    try {
      await init();
      let result; let status = 200;
      const suffix = pathname.slice("/api/uploads".length);
      if (request.method === "GET" && (suffix === "/targets" || suffix === "/directories")) {
        await principal(request);
        const kind = url.searchParams.get("kind");
        if (kind && !KINDS.has(kind)) fail(400, "INVALID_UPLOAD_KIND", "不支持这个共享分类。");
        const targets = await listTargets(request, kind);
        result = { targets: targets.map(({ path: _path, rootPath: _rootPath, ...target }) => target), limits: limits() };
      } else if (request.method === "POST" && suffix === "/directories") {
        result = await createDirectory(request, await readJson(request)); status = 201;
      } else if (request.method === "GET" && (suffix === "" || suffix === "/")) {
        const identity = await principal(request);
        const visible = [];
        for (const task of tasks.values()) {
          if (task.ownerId !== identity.userId || (url.searchParams.has("kind") && task.kind !== url.searchParams.get("kind"))) continue;
          try { await targetFor(request, task.kind, task.targetId, task.relativePath, true); visible.push(publicTask(task)); }
          catch (error) { if (![401, 403, 404, 410].includes(error.statusCode ?? error.status)) throw error; }
        }
        result = { tasks: visible, limits: limits() };
      } else if (request.method === "POST" && (suffix === "" || suffix === "/")) {
        result = await createTask(request, await readJson(request)); status = 201;
      } else {
        const match = /^\/([a-f0-9-]+)(?:\/(chunks|resume|complete|reindex|cancel))?\/?$/i.exec(suffix);
        if (!match || !UUID.test(match[1])) fail(404, "UPLOAD_NOT_FOUND", "没有找到这个上传地址。");
        const [, id, operation] = match;
        if (request.method === "GET" && !operation) result = { task: publicTask((await ownedTask(request, id)).task) };
        else if (request.method === "PUT" && operation === "chunks") {
          result = await uploadChunk(request, id, Number(url.searchParams.get("offset") ?? request.headers["x-upload-offset"]), request.headers["x-chunk-sha256"], request.headers["x-upload-token"]);
        } else if (request.method === "POST" && operation === "resume") result = await resumeTask(request, id, await readJson(request));
        else if (request.method === "POST" && operation === "complete") result = await completeTask(request, id, await readJson(request));
        else if (request.method === "PATCH" && !operation) result = await retargetTask(request, id, await readJson(request));
        else if ((request.method === "DELETE" && !operation) || (request.method === "POST" && operation === "cancel")) result = await cancelTask(request, id, url.searchParams.get("includeGroup") === "1");
        else if (request.method === "POST" && operation === "reindex") {
          const { task } = await ownedTask(request, id);
          if (!["published", "index_failed", "complete", "indexing"].includes(task.status)) fail(409, "UPLOAD_NOT_PUBLISHED", "文件尚未成功上传。");
          startIndexing(task); result = { task: publicTask(task) };
        } else fail(405, "METHOD_NOT_ALLOWED", "不支持这个上传操作。");
      }
      sendJson(response, status, result);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const status = Number(error.statusCode ?? error.status) || (error.code === "ENOSPC" ? 507 : 500);
        const body = { error: status >= 500 && status !== 507 ? "上传处理失败，已确认的分块仍然保留，可重试。" : errorMessage(error), code: error.code || "UPLOAD_FAILED" };
        if (error.task) body.task = error.task;
        if (error.conflictTaskId) body.conflictTaskId = error.conflictTaskId;
        if (status === 429) response.setHeader("Retry-After", "2");
        sendJson(response, status, body);
      }
      if (!(error instanceof UploadError) && !error.statusCode && !error.status) onError(error);
    }
    return true;
  }
  return { init, handleRequest, isExcludedPath, pendingPaths, limits,
    async close() { closed = true; clearInterval(pruneTimer); await Promise.allSettled([...indexing.values()]); },
    async waitForIdle() { await Promise.allSettled([...indexing.values()]); },
  };
}
