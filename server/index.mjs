import { createServer, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { availableParallelism, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLabelService } from "./labels.mjs";
import { createMusicService } from "./music.mjs";
import { createReadingService } from "./reading.mjs";
import { createPhotoService } from "./photos.mjs";
import { detectedEpisodeNumber, quickSelectionsForFolder } from "./video-selection.mjs";
import { createPlaybackService } from "./playback.mjs";
import { createDanmakuService } from "./danmaku.mjs";
import { createPlayerTestService } from "./player-test.mjs";
import { createBitmapSubtitleService } from "./bitmap-subtitles.mjs";
import { METADATA_VERSION, normalizeProbe } from "./playback-planner.mjs";

// 这台电脑既是“视频硬盘”，也是局域网服务器。这个文件负责全部本地 API。
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");
const DATA_DIR = process.env.LMD_DATA_DIR ? path.resolve(process.env.LMD_DATA_DIR) : path.join(PROJECT_DIR, "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const SUBTITLE_CACHE_DIR = path.join(CACHE_DIR, "subtitles");
const FONT_CACHE_DIR = path.join(CACHE_DIR, "fonts");
const THUMBNAIL_CACHE_DIR = path.join(CACHE_DIR, "thumbnails");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const WEB_DIR = path.join(PROJECT_DIR, "dist");
const PORT = Number(process.env.LMD_PORT || process.env.LANTERN_PORT || 8096);
const HOST = process.env.LMD_HOST || "0.0.0.0";
const AUTO_SCAN_MIN_INTERVAL_SECONDS = 15;
const AUTO_SCAN_MAX_INTERVAL_SECONDS = 3600;
const AUTO_SCAN_SCHEDULER_TICK_MS = 5000;
const STANDARD_SCAN_CONCURRENCY = 3;
const LOGICAL_PROCESSOR_COUNT = Math.max(1, availableParallelism());
const TURBO_SCAN_CONCURRENCY = Number(process.env.LMD_TURBO_SCAN_CONCURRENCY) > 0
  ? Math.max(STANDARD_SCAN_CONCURRENCY, Math.round(Number(process.env.LMD_TURBO_SCAN_CONCURRENCY)))
  : Math.min(256, Math.max(32, LOGICAL_PROCESSOR_COUNT * 8));
const STANDARD_SCAN_MEDIA_TOOL_CONCURRENCY = STANDARD_SCAN_CONCURRENCY;
const TURBO_SCAN_MEDIA_TOOL_CONCURRENCY = Number(process.env.LMD_TURBO_SCAN_MEDIA_TOOL_CONCURRENCY) > 0
  ? Math.max(STANDARD_SCAN_MEDIA_TOOL_CONCURRENCY, Math.round(Number(process.env.LMD_TURBO_SCAN_MEDIA_TOOL_CONCURRENCY)))
  : Math.min(32, Math.max(8, LOGICAL_PROCESSOR_COUNT));
const STANDARD_REMUX_CONCURRENCY = 1;
const ACCELERATED_REMUX_CONCURRENCY = 3;
const REMUX_ACCELERATION_DURATION_MS = process.env.NODE_ENV === "test" && Number(process.env.LMD_REMUX_ACCELERATION_DURATION_MS) > 0
  ? Number(process.env.LMD_REMUX_ACCELERATION_DURATION_MS)
  : 12 * 60 * 60 * 1000;
const ACCESS_CODE_PATTERN = /^\d{6}$/;
const ACCESS_SESSION_COOKIE = "lmd_access_session";
const ACCESS_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const UNCATEGORIZED_ACCESS_CATEGORY_ID = "__uncategorized__";
const UNCATEGORIZED_ACCESS_CATEGORY_NAME = "未分类";
const LOGIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
// 全局登录防爆破：窗口内失败总数超过阈值即锁定所有登录，抵御分布式尝试。
const GLOBAL_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_LOGIN_MAX_FAILURES = 20;
const GLOBAL_LOGIN_LOCK_MS = 10 * 60 * 1000;
const STARTUP_DIRECTORY = process.env.LMD_STARTUP_DIR || path.join(process.env.APPDATA || PROJECT_DIR, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const AUTOSTART_FILE = path.join(STARTUP_DIRECTORY, "LMD-开机自启.vbs");
const TRAY_LAUNCHER = path.join(PROJECT_DIR, "启动LMD.vbs");
const trackedChildProcesses = new Set();
let sharingServiceIsStopping = false;
const scryptAsync = promisify(scryptCallback);

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".mov", ".m4v", ".webm", ".avi", ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".flv",
]);
const SUBTITLE_EXTENSIONS = new Set([".ass", ".ssa", ".srt"]);
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);
const FONT_ARCHIVE_EXTENSIONS = new Set([".rar"]);
const FONT_PACK_DIRECTORY_PATTERN = /^(?:fonts?|字体)$/iu;
const FONT_ARCHIVE_NAME_PATTERN = /(?:fonts?|字体)/iu;
const MAX_FONT_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_FONT_BYTES = 512 * 1024 * 1024;
const MAX_FONT_PACK_FILES = 256;
const EMBEDDED_SUBTITLE_CODECS = new Map([
  ["ass", { extension: ".ass", format: "ASS" }],
  ["ssa", { extension: ".ssa", format: "SSA" }],
  ["subrip", { extension: ".srt", format: "SRT" }],
  // Bitmap tracks are extracted as-is so the bitmap renderer can decode them.
  ["hdmv_pgs_subtitle", { extension: ".sup", format: "PGS" }],
  ["pgssub", { extension: ".sup", format: "PGS" }],
  ["dvd_subtitle", { extension: ".sub", format: "VOBSUB" }],
  ["dvb_subtitle", { extension: ".sub", format: "DVB" }],
]);
const MP4_FAMILY_EXTENSIONS = new Set(["MP4", "M4V", "MOV"]);
const WEBM_VIDEO_CODECS = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODECS = new Set(["opus", "vorbis"]);
const MP4_COPYABLE_VIDEO_CODECS = new Set(["h264", "hevc", "av1", "mpeg4"]);
const MP4_BROWSER_AUDIO_CODECS = new Set(["aac", "mp3"]);
const COMPATIBLE_COPY_VERSION = 2;
const LEGACY_CACHE_MTIME_TOLERANCE_MS = 2000;
const SCAN_CHECKPOINT_ITEM_COUNT = 12;
const SCAN_CHECKPOINT_INTERVAL_MS = 2000;
const TURBO_SCAN_CHECKPOINT_ITEM_COUNT = Math.max(64, TURBO_SCAN_CONCURRENCY);
const TURBO_SCAN_CHECKPOINT_INTERVAL_MS = 5000;
const TEST_SCAN_FILE_DELAY_MS = process.env.NODE_ENV === "test"
  ? Math.max(0, Number(process.env.LMD_TEST_SCAN_FILE_DELAY_MS) || 0)
  : 0;
const TEST_FAIL_FINAL_SCAN_SAVE_NUMBER = process.env.NODE_ENV === "test"
  ? Math.max(0, Math.round(Number(process.env.LMD_TEST_FAIL_FINAL_SCAN_SAVE_NUMBER) || 0))
  : 0;
const TEST_FAIL_STATE_REPLACE_NUMBER = process.env.NODE_ENV === "test"
  ? Math.max(0, Math.round(Number(process.env.LMD_TEST_FAIL_STATE_REPLACE_NUMBER) || 0))
  : 0;
let testFinalScanSaveCount = 0;
let testStateReplaceCount = 0;

await mkdir(DATA_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(SUBTITLE_CACHE_DIR, { recursive: true });
await mkdir(FONT_CACHE_DIR, { recursive: true });
await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });

function defaultAccessCategories() {
  const now = new Date().toISOString();
  return ["全年龄", "R-18"].map((name) => ({ id: randomUUID(), name, folderIds: [], createdAt: now, updatedAt: now }));
}

const STATE_VERSION = 11;

function defaultState() {
  return {
    version: STATE_VERSION,
    libraries: [],
    media: [],
    musicLibraries: [],
    musicTracks: [],
    readingLibraries: [],
    readingItems: [],
    photoLibraries: [],
    photoItems: [],
    jobs: [],
    displayGroups: [],
    accessControl: {
      enabled: false,
      users: [],
      sessions: [],
      categories: defaultAccessCategories(),
    },
    settings: {
      cacheDirectory: CACHE_DIR,
      compatibleCopyDirectory: CACHE_DIR,
      maxStreams: 10,
      autoPrepareCompatibleCopies: true,
      autoScanEnabled: true,
      autoScanIntervalSeconds: 30,
      remuxAccelerationExpiresAt: null,
    },
  };
}

async function loadState() {
  let stored;
  try {
    stored = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (error) {
    // 首次启动（文件不存在）属于正常情况；解析失败说明文件损坏，先备份原文件
    // 再从默认状态重建，避免静默覆盖导致媒体库数据无法找回。
    if (error.code !== "ENOENT") {
      try {
        const backupPath = `${STATE_FILE}.corrupt-${Date.now()}`;
        await copyFile(STATE_FILE, backupPath);
        console.error(`data/state.json 无法解析，已备份到 ${backupPath} 并从默认状态重建。`);
      } catch (backupError) {
        console.error(`data/state.json 无法解析且备份失败：${backupError.message}`);
      }
    }
    return defaultState();
  }
  const storedVersion = Number(stored.version) || 0;
  if (storedVersion < STATE_VERSION) {
    console.log(`媒体状态将从版本 ${storedVersion} 迁移到 ${STATE_VERSION}。`);
  }
  const defaults = defaultState();
  const storedAccessControl = stored.accessControl || {};
  const now = Date.now();
  return {
    version: STATE_VERSION,
    libraries: Array.isArray(stored.libraries) ? stored.libraries : defaults.libraries,
    media: Array.isArray(stored.media) ? stored.media : defaults.media,
    musicLibraries: Array.isArray(stored.musicLibraries) ? stored.musicLibraries : defaults.musicLibraries,
    musicTracks: Array.isArray(stored.musicTracks) ? stored.musicTracks : defaults.musicTracks,
    readingLibraries: Array.isArray(stored.readingLibraries) ? stored.readingLibraries : defaults.readingLibraries,
    readingItems: Array.isArray(stored.readingItems) ? stored.readingItems : defaults.readingItems,
    photoLibraries: Array.isArray(stored.photoLibraries) ? stored.photoLibraries : defaults.photoLibraries,
    photoItems: Array.isArray(stored.photoItems) ? stored.photoItems : defaults.photoItems,
    jobs: Array.isArray(stored.jobs) ? stored.jobs : defaults.jobs,
    displayGroups: Array.isArray(stored.displayGroups) ? stored.displayGroups : defaults.displayGroups,
    accessControl: {
      enabled: Boolean(storedAccessControl.enabled),
      users: Array.isArray(storedAccessControl.users) ? storedAccessControl.users : defaults.accessControl.users,
      sessions: Array.isArray(storedAccessControl.sessions)
        ? storedAccessControl.sessions.filter((session) => Date.parse(session.expiresAt || "") > now)
        : defaults.accessControl.sessions,
      categories: Array.isArray(storedAccessControl.categories)
        ? storedAccessControl.categories
        : defaults.accessControl.categories,
    },
    settings: {
      ...defaults.settings,
      ...(stored.settings || {}),
      cacheDirectory: CACHE_DIR,
      compatibleCopyDirectory: path.resolve(stored.settings?.compatibleCopyDirectory || CACHE_DIR),
      maxStreams: 10,
      remuxAccelerationExpiresAt: Date.parse(stored.settings?.remuxAccelerationExpiresAt || "") > now
        ? new Date(stored.settings.remuxAccelerationExpiresAt).toISOString()
        : null,
    },
  };
}

let appState = await loadState();
const labelService = await createLabelService({ directory: DATA_DIR, getState: () => appState, folderForMedia: folderPathForMedia, stableId, episodeForMedia: m => detectedEpisodeNumber(m.fileName) });
let musicService = null;
let readingService = null;
let photoService = null;

// A queued/running FFmpeg process cannot survive a server restart. Mark old
// records clearly instead of leaving the management page stuck at “processing”.
for (const job of appState.jobs) {
  if (job.status === "queued" || job.status === "running") {
    job.status = "failed";
    job.message = "服务曾重启，请重新加入处理队列";
  }
}
trimJobHistory();

for (const user of appState.accessControl.users) {
  user.categoryIds = [...new Set(Array.isArray(user.categoryIds) ? user.categoryIds.map(String) : [])];
  user.folderIds = [...new Set(Array.isArray(user.folderIds) ? user.folderIds.map(String) : [])];
}
const categorizedFolderIds = new Set();
for (const category of appState.accessControl.categories) {
  category.folderIds = [...new Set(Array.isArray(category.folderIds) ? category.folderIds.map(String) : [])]
    .filter((folderId) => {
      if (categorizedFolderIds.has(folderId)) return false;
      categorizedFolderIds.add(folderId);
      return true;
    });
}

let stateSaveScheduled = false;
let stateSaveInFlight = null;
let stateSaveDirty = false;
const STATE_REPLACE_RETRY_DELAYS_MS = [40, 80, 160, 320, 640, 1000];

async function replaceStateFile(temporaryFile) {
  testStateReplaceCount += 1;
  if (TEST_FAIL_STATE_REPLACE_NUMBER === testStateReplaceCount) {
    const error = new Error("测试触发：替换状态文件失败");
    error.code = "EPERM";
    throw error;
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryFile, STATE_FILE);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!retryable || attempt >= STATE_REPLACE_RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, STATE_REPLACE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// 状态持久化采用合并写：同 tick 内的多次 saveState 合并为一次磁盘写入，
// 序列化在写入队列内执行（大媒体库不再阻塞调用方的事件循环）；写盘期间
// 产生的新保存请求会触发下一轮写入，始终落盘最新状态，调用方 await 返回
// 的 promise 保证本次修改已保存。Windows 杀毒软件或索引服务可能短暂占用
// state.json，因此替换文件会有限重试；即使最终失败也必须复位队列，让后续
// 保存可以重新开始，不能永久复用一个已拒绝的 promise。
function saveState() {
  stateSaveDirty = true;
  if (stateSaveScheduled) return stateSaveInFlight;
  stateSaveScheduled = true;
  const saveOperation = Promise.resolve()
    .then(async () => {
      while (true) {
        if (!stateSaveDirty) return;
        stateSaveDirty = false;
        const temporaryFile = `${STATE_FILE}.tmp`;
        const snapshot = JSON.stringify(appState, null, 2);
        await writeFile(temporaryFile, snapshot, "utf8");
        await replaceStateFile(temporaryFile);
      }
    });
  stateSaveInFlight = saveOperation.finally(() => {
    stateSaveScheduled = false;
    stateSaveInFlight = null;
  });
  return stateSaveInFlight;
}

// 版本 8 支持把浏览器兼容视频保存到自定义目录。
await saveState();

function stableId(value) {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 20);
}

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requestIpAddress(request) {
  const address = String(request.socket.remoteAddress || "").split("%")[0];
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isLanRequest(request) {
  if (isLoopbackRequest(request)) return true;
  const address = requestIpAddress(request).toLowerCase();
  const ipv4 = address.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return ipv4[0] === 10
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
      || (ipv4[0] === 169 && ipv4[1] === 254);
  }
  return address.startsWith("fc")
    || address.startsWith("fd")
    || address.startsWith("fe8")
    || address.startsWith("fe9")
    || address.startsWith("fea")
    || address.startsWith("feb");
}

function requireLocalManagement(request, response) {
  if (isLoopbackRequest(request)) return true;
  sendJson(response, 403, { error: "管理端只能在服务器电脑本机操作。", code: "LOCAL_ADMIN_ONLY" });
  return false;
}

function parseCookies(request) {
  const cookies = {};
  for (const pair of String(request.headers.cookie || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(pair.slice(separator + 1).trim()); }
    catch { cookies[key] = ""; }
  }
  return cookies;
}

function accessSessionDigest(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
}

function normalizeAccessCategoryName(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

function publicAccessUser(user) {
  return {
    id: user.id,
    categoryIds: Array.isArray(user.categoryIds) ? user.categoryIds : [],
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

async function accessCodeCredentials(accessCode) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scryptAsync(String(accessCode), salt, 64);
  return { accessSalt: salt, accessHash: Buffer.from(derived).toString("base64url") };
}

async function accessCodeMatches(accessCode, user) {
  const expected = Buffer.from(String(user?.accessHash || ""), "base64url");
  const derived = Buffer.from(await scryptAsync(String(accessCode), user?.accessSalt || "lmd-invalid-access-user", 64));
  return Boolean(user && expected.length === derived.length && expected.length > 0 && timingSafeEqual(expected, derived));
}

async function userForAccessCode(accessCode, excludedUserId = null, includeDisabled = false) {
  const candidates = appState.accessControl.users.filter((user) => user.id !== excludedUserId && (includeDisabled || user.enabled !== false));
  if (!candidates.length) {
    await accessCodeMatches(accessCode, null);
    return null;
  }
  for (const user of candidates) {
    if (await accessCodeMatches(accessCode, user)) return user;
  }
  return null;
}

function accessSessionCookie(token, maxAge = ACCESS_SESSION_TTL_SECONDS) {
  const value = token ? encodeURIComponent(token) : "";
  return `${ACCESS_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function accessContextForRequest(request) {
  if (!appState.accessControl.enabled) return { fullAccess: true, mode: "simple", user: null };
  if (isLoopbackRequest(request)) return { fullAccess: true, mode: "protected", user: null, localAdmin: true };
  if (!isLanRequest(request)) return null;
  const token = parseCookies(request)[ACCESS_SESSION_COOKIE];
  if (!token) return null;
  const digest = accessSessionDigest(token);
  const now = Date.now();
  const session = appState.accessControl.sessions.find((item) => item.tokenHash === digest && Date.parse(item.expiresAt || "") > now);
  if (!session) return null;
  const user = appState.accessControl.users.find((item) => item.id === session.userId && item.enabled !== false);
  if (!user) return null;
  return {
    fullAccess: false,
    mode: "protected",
    user,
    categoryIds: new Set(Array.isArray(user.categoryIds) ? user.categoryIds : []),
    legacyFolderIds: new Set(Array.isArray(user.folderIds) ? user.folderIds : []),
    allowedFolderIds: accessFolderIdsForUser(user),
  };
}

function requireViewerAccess(request, response) {
  const context = accessContextForRequest(request);
  if (context) return context;
  if (!isLanRequest(request)) {
    sendJson(response, 403, { error: "访问控制已开启，只允许局域网设备连接。", code: "LAN_ONLY" });
  } else {
    sendJson(response, 401, { error: "请先使用管理员提供的六位访问码登录。", code: "AUTH_REQUIRED" });
  }
  return null;
}

function canAccessFolderId(context, folderId) {
  if (context?.fullAccess) return true;
  return Boolean(context?.allowedFolderIds?.has(folderId));
}

function canAccessMedia(context, media) {
  return canAccessFolderId(context, videoAccessFolderId(media));
}

function accessibleMedia(context) {
  return appState.media.filter((media) => canAccessMedia(context, media));
}

function authorizedMediaForRequest(request, response, mediaId) {
  const context = requireViewerAccess(request, response);
  if (!context) return null;
  const media = appState.media.find((item) => item.id === mediaId);
  if (!media || !canAccessMedia(context, media)) {
    sendJson(response, 404, { error: "找不到视频，或当前用户没有这个文件夹的访问权限。" });
    return null;
  }
  return media;
}

const loginFailures = new Map();
// 访问码级失败记录：防止针对单个访问码的集中尝试（即使换 IP）。
const accessCodeLoginFailures = new Map();
// 全局失败记录：滑动窗口内总失败数超限即锁定所有登录，抵御分布式爆破。
let globalLoginFailures = { count: 0, windowStartedAt: 0, lockedUntil: 0 };

function loginFailureKey(request) {
  return requestIpAddress(request);
}

function currentLoginThrottle(key) {
  const record = loginFailures.get(key);
  if (!record) return null;
  if (record.lockedUntil > Date.now()) return record;
  if (Date.now() - record.firstFailureAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(key);
    return null;
  }
  return record;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const current = currentLoginThrottle(key);
  const record = current || { count: 0, firstFailureAt: now, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= LOGIN_MAX_FAILURES) record.lockedUntil = now + LOGIN_LOCK_MS;
  loginFailures.set(key, record);
  return record;
}

function currentAccessCodeThrottle(accessCodeKey) {
  const record = accessCodeLoginFailures.get(accessCodeKey);
  if (!record) return null;
  if (record.lockedUntil > Date.now()) return record;
  if (Date.now() - record.firstFailureAt > LOGIN_FAILURE_WINDOW_MS) {
    accessCodeLoginFailures.delete(accessCodeKey);
    return null;
  }
  return record;
}

function recordAccessCodeLoginFailure(accessCodeKey) {
  const now = Date.now();
  const current = currentAccessCodeThrottle(accessCodeKey);
  const record = current || { count: 0, firstFailureAt: now, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= LOGIN_MAX_FAILURES) record.lockedUntil = now + LOGIN_LOCK_MS;
  accessCodeLoginFailures.set(accessCodeKey, record);
  return record;
}

function currentGlobalLoginThrottle() {
  const now = Date.now();
  if (globalLoginFailures.lockedUntil > now) return globalLoginFailures;
  if (now - globalLoginFailures.windowStartedAt > GLOBAL_LOGIN_WINDOW_MS) {
    globalLoginFailures = { count: 0, windowStartedAt: now, lockedUntil: 0 };
  }
  return globalLoginFailures;
}

function recordGlobalLoginFailure() {
  const now = Date.now();
  const record = currentGlobalLoginThrottle();
  record.count += 1;
  if (record.count >= GLOBAL_LOGIN_MAX_FAILURES) record.lockedUntil = now + GLOBAL_LOGIN_LOCK_MS;
  return record;
}

function sameOriginMutation(request) {
  if (!["POST", "PATCH", "DELETE"].includes(request.method || "")) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function getLanAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")) addresses.push(`http://${item.address}:${PORT}`);
    }
  }
  return [...new Set(addresses)];
}

async function getAutostartStatus() {
  return { enabled: await access(AUTOSTART_FILE).then(() => true).catch(() => false), path: AUTOSTART_FILE };
}

function quoteForVbs(value) {
  return String(value).replaceAll('"', '""');
}

function spawnTracked(executable, args, options = {}) {
  if (sharingServiceIsStopping) throw new Error("共享服务正在关闭，不能再启动子进程");
  const child = spawn(executable, args, options);
  trackedChildProcesses.add(child);
  const forgetChild = () => trackedChildProcesses.delete(child);
  child.once("close", forgetChild);
  child.once("error", forgetChild);
  return child;
}

async function setAutostart(enabled) {
  if (!enabled) {
    await unlink(AUTOSTART_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return getAutostartStatus();
  }
  await mkdir(STARTUP_DIRECTORY, { recursive: true });
  const launchCommand = `wscript.exe "${TRAY_LAUNCHER}" /autostart`;
  const script = [
    "Set lmdShell = CreateObject(\"WScript.Shell\")",
    `lmdShell.Run "${quoteForVbs(launchCommand)}", 0, False`,
    "Set lmdShell = Nothing",
    "",
  ].join("\r\n");
  await writeFile(AUTOSTART_FILE, script, "utf8");
  return getAutostartStatus();
}

let activeFolderPicker = null;

function selectFolderWithWindowsDialog() {
  if (process.platform !== "win32") return Promise.reject(new Error("文件夹选择器只支持 Windows。"));
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = '选择 LMD 媒体或阅读文件夹'",
    "$dialog.ShowNewFolderButton = $false",
    "$dialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.ShowInTaskbar = $false",
    "$owner.TopMost = $true",
    "$owner.Opacity = 0",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$owner.Show()",
    "$owner.Activate()",
    "try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } }",
    "finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
  ].join("\r\n");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const picker = spawnTracked("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", encodedScript], { windowsHide: true });
    let output = "";
    let errors = "";
    let settled = false;
    const timeout = setTimeout(() => {
      picker.kill();
      finish(reject, new Error("文件夹选择窗口等待超时，请重试。"));
    }, 10 * 60 * 1000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    picker.stdout.setEncoding("utf8");
    picker.stderr.setEncoding("utf8");
    picker.stdout.on("data", (chunk) => { output += chunk; });
    picker.stderr.on("data", (chunk) => { errors += chunk; });
    picker.on("error", (error) => finish(reject, error));
    picker.on("close", (code) => {
      if (code !== 0) return finish(reject, new Error(errors.trim() || "无法打开 Windows 文件夹选择器。"));
      finish(resolve, output.replace(/^\uFEFF/, "").trim() || null);
    });
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runCommand(executable, args, timeoutMs = 15000, options = {}) {
  return new Promise((resolve, reject) => {
    const { onChild = null, ...spawnOptions } = options;
    const child = spawnTracked(executable, args, { windowsHide: true, ...spawnOptions });
    onChild?.(child);
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (timedOut) return finish(reject, new Error(`${path.basename(executable)} 运行超时`));
      if (code === 0) return finish(resolve, { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      return finish(reject, new Error(Buffer.concat(stderr).toString("utf8").trim() || `${path.basename(executable)} 退出码 ${code}`));
    });
  });
}

// FFmpeg 本地安装目录。默认放在项目 tools/ffmpeg 下；测试或特殊部署可通过
// LMD_FFMPEG_INSTALL_DIR 指向其他位置。
const FFMPEG_INSTALL_DIR = process.env.LMD_FFMPEG_INSTALL_DIR
  ? path.resolve(process.env.LMD_FFMPEG_INSTALL_DIR)
  : path.join(PROJECT_DIR, "tools", "ffmpeg");

async function findMediaTools() {
  const localBin = path.join(FFMPEG_INSTALL_DIR, "bin");
  const candidates = process.platform === "win32"
    ? [
        { source: "local", ffmpeg: path.join(localBin, "ffmpeg.exe"), ffprobe: path.join(localBin, "ffprobe.exe") },
        { source: "path", ffmpeg: "ffmpeg.exe", ffprobe: "ffprobe.exe" },
      ]
    : [
        { source: "local", ffmpeg: path.join(localBin, "ffmpeg"), ffprobe: path.join(localBin, "ffprobe") },
        { source: "path", ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
      ];

  for (const candidate of candidates) {
    try {
      const [ffmpegResult] = await Promise.all([
        runCommand(candidate.ffmpeg, ["-version"], 5000),
        runCommand(candidate.ffprobe, ["-version"], 5000),
      ]);
      const versionLine = ffmpegResult.stdout.split(/\r?\n/)[0];
      return {
        available: true,
        ffmpeg: candidate.ffmpeg,
        ffprobe: candidate.ffprobe,
        version: versionLine,
        installedVersion: parseFfmpegVersion(versionLine),
        source: candidate.source,
        installable: process.platform === "win32",
      };
    } catch {
      // 继续检查下一个位置。
    }
  }
  return {
    available: false,
    ffmpeg: null,
    ffprobe: null,
    version: null,
    installedVersion: null,
    source: null,
    installable: process.platform === "win32",
    hint: "点击下方“自动安装 FFmpeg”即可联网下载并安装最新版本；也可以手动把 ffmpeg.exe 与 ffprobe.exe 放入 tools/ffmpeg/bin。",
  };
}

let mediaTools = await findMediaTools();

// ---- FFmpeg 自动安装 / 自动更新 ------------------------------------------------
// 从 gyan.dev 下载 Windows 最新 release 版（essentials 构建），解压后替换
// tools/ffmpeg/bin。安装过程在后台执行，管理端通过 /api/tools/install/status
// 轮询进度，下载/解压期间可以取消。下载地址可通过环境变量覆盖：
// LMD_FFMPEG_DOWNLOAD_URL / LMD_FFMPEG_VERSION_URL。
const FFMPEG_DOWNLOAD_URL = process.env.LMD_FFMPEG_DOWNLOAD_URL || "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_VERSION_URL = process.env.LMD_FFMPEG_VERSION_URL || "https://www.gyan.dev/ffmpeg/builds/release-version";
const FFMPEG_BIN_DIR = path.join(FFMPEG_INSTALL_DIR, "bin");
const FFMPEG_INSTALL_WORK_DIR = path.join(FFMPEG_INSTALL_DIR, ".install");
const FFMPEG_INSTALL_ACTIVE_STATUSES = new Set(["downloading", "extracting", "installing"]);

const mediaToolsInstall = {
  status: "idle", // idle | downloading | extracting | installing | completed | failed | cancelled
  progress: 0,
  message: "",
  error: "",
  version: null,
  installedVersion: null,
  latestVersion: null,
  bytesDownloaded: 0,
  bytesTotal: 0,
  startedAt: null,
  finishedAt: null,
  runningPromise: null,
  activeRequest: null,
  activeChild: null,
  cancelRequested: false,
};

let ffmpegLatestVersionCache = { version: null, fetchedAt: 0 };

function parseFfmpegVersion(versionLine) {
  const match = String(versionLine || "").match(/version\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : null;
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").split(".").map((part) => Number(part) || 0);
  const leftParts = parse(left);
  const rightParts = parse(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function fetchText(url, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? httpsGet : httpGet;
    const request = client(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("响应内容过大"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("网络连接中断")));
    });
    request.on("error", reject);
    request.setTimeout(15000, () => request.destroy(new Error("网络连接超时")));
  });
}

async function latestFfmpegReleaseVersion() {
  const now = Date.now();
  if (ffmpegLatestVersionCache.version && now - ffmpegLatestVersionCache.fetchedAt < 10 * 60 * 1000) {
    return ffmpegLatestVersionCache.version;
  }
  const version = (await fetchText(FFMPEG_VERSION_URL)).trim();
  if (version) ffmpegLatestVersionCache = { version, fetchedAt: now };
  return version || null;
}

function downloadFile(url, destinationPath, onProgress) {
  return new Promise((resolve, reject) => {
    const fetchUrl = (currentUrl, redirectCount) => {
      const client = currentUrl.startsWith("https:") ? httpsGet : httpGet;
      const request = client(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= 5) return reject(new Error("下载地址重定向次数过多"));
          return fetchUrl(new URL(response.headers.location, currentUrl).toString(), redirectCount + 1);
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`下载失败（HTTP ${response.statusCode}）`));
        }
        const totalBytes = Number(response.headers["content-length"]) || 0;
        let receivedBytes = 0;
        let ended = false;
        let finished = false;
        const output = createWriteStream(destinationPath);
        response.on("data", (chunk) => {
          receivedBytes += chunk.length;
          onProgress?.(receivedBytes, totalBytes);
        });
        response.on("end", () => { ended = true; });
        response.pipe(output);
        output.on("error", (error) => { request.destroy(); reject(error); });
        output.on("finish", () => {
          finished = true;
          output.close(() => resolve({ bytes: receivedBytes }));
        });
        response.on("error", (error) => { output.destroy(); reject(error); });
        response.on("aborted", () => {
          if (ended || finished) return;
          output.destroy();
          reject(new Error("下载连接中断"));
        });
        response.on("close", () => {
          // 正常完成时 response 的 close 会先于输出文件流的 finish 触发，
          // 因此只有响应没有正常结束（end）时才算下载失败。
          if (ended || finished) return;
          output.destroy();
          reject(new Error("下载连接提前关闭"));
        });
      });
      request.on("error", reject);
      request.setTimeout(30000, () => request.destroy(new Error("下载连接超时，请检查网络后重试")));
      mediaToolsInstall.activeRequest = request;
      request.once("close", () => {
        if (mediaToolsInstall.activeRequest === request) mediaToolsInstall.activeRequest = null;
      });
    };
    fetchUrl(url, 0);
  });
}

async function extractZipArchive(archivePath, destinationDirectory) {
  await mkdir(destinationDirectory, { recursive: true });
  try {
    // Windows 10/11 自带的 bsdtar 不依赖 PowerShell.Archive 模块，在精简版
    // PowerShell 或模块损坏时仍可可靠解压下载的 FFmpeg ZIP。
    return await runCommand("tar.exe", ["-xf", archivePath, "-C", destinationDirectory], 5 * 60 * 1000, {
      onChild: (child) => { mediaToolsInstall.activeChild = child; },
    });
  } catch (tarError) {
    const script = `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${destinationDirectory.replaceAll("'", "''")}' -Force`;
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    try {
      return await runCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], 5 * 60 * 1000, {
        onChild: (child) => { mediaToolsInstall.activeChild = child; },
      });
    } catch (powerShellError) {
      throw new Error(`无法解压 FFmpeg：${tarError.message}; ${powerShellError.message}`);
    }
  }
}

function throwIfInstallCancelled() {
  if (!mediaToolsInstall.cancelRequested) return;
  const error = new Error("FFmpeg 安装已取消。");
  error.cancelled = true;
  throw error;
}

// 旧版 exe 在 Windows 上可能仍被短暂占用，删除失败时后台重试一段时间。
function cleanupInstallBackupDirectory(backupDirectory) {
  (async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await rm(backupDirectory, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    console.warn(`FFmpeg 旧版本备份目录未能自动清理，可手动删除：${backupDirectory}`);
  })();
}

async function installMediaTools() {
  let backupDirectory = null;
  let swapped = false;
  let terminalInstallState = null;
  try {
    if (process.platform !== "win32") throw new Error("自动安装目前只支持 Windows 系统，其他平台请手动安装 FFmpeg。");
    if (activeScan || pendingScanMode || remuxTasksByMediaId.size > 0) {
      throw new Error("当前有扫描或重封装任务正在运行，请等待任务结束后再安装 FFmpeg。");
    }

    await mkdir(FFMPEG_INSTALL_WORK_DIR, { recursive: true });
    const archivePath = path.join(FFMPEG_INSTALL_WORK_DIR, "ffmpeg-release-essentials.zip");
    const extractDirectory = path.join(FFMPEG_INSTALL_WORK_DIR, "extracted");
    await rm(archivePath, { force: true }).catch(() => {});
    await rm(extractDirectory, { recursive: true, force: true }).catch(() => {});

    mediaToolsInstall.status = "downloading";
    mediaToolsInstall.progress = 1;
    mediaToolsInstall.message = "正在从 gyan.dev 下载 FFmpeg 最新版（约 90 MB）…";
    const download = await downloadFile(FFMPEG_DOWNLOAD_URL, archivePath, (receivedBytes, totalBytes) => {
      if (mediaToolsInstall.cancelRequested) {
        mediaToolsInstall.activeRequest?.destroy();
        return;
      }
      mediaToolsInstall.bytesDownloaded = receivedBytes;
      mediaToolsInstall.bytesTotal = totalBytes;
      mediaToolsInstall.progress = totalBytes ? Math.max(1, Math.min(80, Math.round((receivedBytes / totalBytes) * 80))) : 1;
    });
    if (download.bytes === 0) throw new Error("下载的文件为空，安装失败。");
    throwIfInstallCancelled();

    mediaToolsInstall.status = "extracting";
    mediaToolsInstall.progress = 84;
    mediaToolsInstall.message = "正在解压 FFmpeg…";
    await extractZipArchive(archivePath, extractDirectory);
    throwIfInstallCancelled();

    const extractedEntries = await readdir(extractDirectory, { withFileTypes: true });
    const extractedRoot = extractedEntries.find((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith("ffmpeg-"));
    if (!extractedRoot) throw new Error("下载的 FFmpeg 压缩包结构不符合预期，无法安装。");
    const extractedBinDirectory = path.join(extractDirectory, extractedRoot.name, "bin");
    const executables = process.platform === "win32" ? ["ffmpeg.exe", "ffprobe.exe", "ffplay.exe"] : ["ffmpeg", "ffprobe", "ffplay"];
    for (const executable of executables) {
      await access(path.join(extractedBinDirectory, executable)).catch(() => {
        throw new Error(`解压结果缺少 ${executable}，安装失败。`);
      });
    }

    mediaToolsInstall.status = "installing";
    mediaToolsInstall.progress = 90;
    mediaToolsInstall.message = "正在替换本地 FFmpeg…";
    try {
      await rename(FFMPEG_BIN_DIR, backupDirectory = path.join(FFMPEG_INSTALL_DIR, `bin.old-${Date.now()}`));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      backupDirectory = null; // 首次安装：还没有旧版本目录
    }
    swapped = true;
    await mkdir(FFMPEG_BIN_DIR, { recursive: true });
    for (const executable of executables) {
      await copyFile(path.join(extractedBinDirectory, executable), path.join(FFMPEG_BIN_DIR, executable));
    }

    mediaToolsInstall.progress = 95;
    mediaToolsInstall.message = "正在验证新版本…";
    const refreshedTools = await findMediaTools();
    if (!refreshedTools.available) throw new Error("安装后无法运行新版本 FFmpeg，已恢复原版本。");
    mediaTools = refreshedTools;

    terminalInstallState = {
      status: "completed",
      progress: 100,
      version: refreshedTools.version,
      installedVersion: refreshedTools.installedVersion,
      error: "",
      message: "FFmpeg 安装完成，可以直接使用新版本。",
    };
  } catch (error) {
    // 替换失败时回滚旧版本目录，避免本地 FFmpeg 缺失。
    if (backupDirectory) {
      await rm(FFMPEG_BIN_DIR, { recursive: true, force: true }).catch(() => {});
      try {
        await rename(backupDirectory, FFMPEG_BIN_DIR);
        backupDirectory = null;
      } catch {
        console.warn(`FFmpeg 安装失败后回滚目录未完成，备份保留在：${backupDirectory}`);
      }
    } else if (swapped) {
      // 首次安装失败：删除刚写入的临时文件，避免残留半成品。
      await rm(FFMPEG_BIN_DIR, { recursive: true, force: true }).catch(() => {});
    }
    const cancelled = Boolean(error.cancelled) || mediaToolsInstall.cancelRequested;
    const installError = cancelled ? "" : error.message || "FFmpeg 安装失败。";
    terminalInstallState = {
      status: cancelled ? "cancelled" : "failed",
      progress: 0,
      error: installError,
      message: cancelled ? "FFmpeg 安装已取消。" : installError,
    };
    if (!cancelled) console.error(`FFmpeg 安装失败：${error.message}`);
  } finally {
    mediaToolsInstall.runningPromise = null;
    mediaToolsInstall.activeRequest = null;
    mediaToolsInstall.activeChild = null;
    if (backupDirectory) cleanupInstallBackupDirectory(backupDirectory);
    // 终止状态暴露给轮询端之前必须完成临时目录清理；否则快速轮询会在
    // status=cancelled/failed 后短暂看到 .install，造成不稳定状态与测试竞态。
    await rm(FFMPEG_INSTALL_WORK_DIR, { recursive: true, force: true }).catch(() => {});
    if (terminalInstallState) Object.assign(mediaToolsInstall, terminalInstallState, { finishedAt: new Date().toISOString() });
  }
}

async function walkDirectory(rootDirectory, depth = 0, output = [], status = { complete: true, errors: [], truncated: false }, onVideoFound = null) {
  if (depth > 10) {
    status.complete = false;
    status.truncated = true;
    return output;
  }
  if (output.length >= 10000) {
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
    if (entry.isDirectory()) await walkDirectory(fullPath, depth + 1, output, status, onVideoFound);
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      output.push(fullPath);
      onVideoFound?.(fullPath);
    }
    if (output.length >= 10000) {
      status.complete = false;
      status.truncated = true;
      break;
    }
  }
  return output;
}

function pathIsSameOrDescendant(candidatePath, rootPath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === ""
    || (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
}

function mostSpecificLibraryForPath(filePath, libraries = appState.libraries) {
  let owner = null;
  let ownerPathLength = -1;
  for (const library of libraries) {
    if (!pathIsSameOrDescendant(filePath, library.path)) continue;
    const libraryPathLength = path.resolve(library.path).length;
    if (libraryPathLength > ownerPathLength || (libraryPathLength === ownerPathLength && library.id.localeCompare(owner?.id || "") < 0)) {
      owner = library;
      ownerPathLength = libraryPathLength;
    }
  }
  return owner;
}

let fontArchiveExtractorPromise = null;
const reportedFontArchiveErrors = new Set();
const fontAliasCache = new Map();

function decodeFontName(bytes, platformId) {
  if (!bytes.length) return "";
  if (platformId === 0 || platformId === 3) {
    const evenLength = bytes.length - (bytes.length % 2);
    if (!evenLength) return "";
    const littleEndian = Buffer.from(bytes.subarray(0, evenLength));
    littleEndian.swap16();
    return littleEndian.toString("utf16le");
  }
  return Buffer.from(bytes).toString("latin1");
}

async function readSfntFontAliases(handle, sfntOffset) {
  const header = Buffer.alloc(12);
  if ((await handle.read(header, 0, header.length, sfntOffset)).bytesRead !== header.length) return [];
  const tableCount = header.readUInt16BE(4);
  if (!tableCount || tableCount > 512) return [];
  const directory = Buffer.alloc(tableCount * 16);
  if ((await handle.read(directory, 0, directory.length, sfntOffset + 12)).bytesRead !== directory.length) return [];

  let nameTableOffset = 0;
  let nameTableLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = index * 16;
    if (directory.toString("ascii", recordOffset, recordOffset + 4) !== "name") continue;
    nameTableOffset = directory.readUInt32BE(recordOffset + 8);
    nameTableLength = directory.readUInt32BE(recordOffset + 12);
    break;
  }
  if (!nameTableOffset || nameTableLength < 6 || nameTableLength > 8 * 1024 * 1024) return [];
  const table = Buffer.alloc(nameTableLength);
  if ((await handle.read(table, 0, table.length, nameTableOffset)).bytesRead !== table.length) return [];
  const recordCount = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  if (recordCount > 4096 || 6 + recordCount * 12 > table.length || stringOffset > table.length) return [];

  const aliases = new Set();
  const families = new Set();
  const subfamilies = new Set();
  for (let index = 0; index < recordCount; index += 1) {
    const recordOffset = 6 + index * 12;
    const platformId = table.readUInt16BE(recordOffset);
    const nameId = table.readUInt16BE(recordOffset + 6);
    if (![1, 2, 4, 6, 16, 17].includes(nameId)) continue;
    const byteLength = table.readUInt16BE(recordOffset + 8);
    const byteOffset = stringOffset + table.readUInt16BE(recordOffset + 10);
    if (!byteLength || byteOffset < stringOffset || byteOffset + byteLength > table.length) continue;
    const value = decodeFontName(table.subarray(byteOffset, byteOffset + byteLength), platformId)
      .replaceAll("\0", "")
      .replace(/\s+/g, " ")
      .trim();
    if (!value || value.length > 160) continue;
    if (nameId === 1 || nameId === 16) families.add(value);
    else if (nameId === 2 || nameId === 17) subfamilies.add(value);
    else aliases.add(value);
  }
  for (const family of families) aliases.add(family);
  for (const family of families) {
    for (const subfamily of subfamilies) {
      if (!/^(?:regular|normal|roman|book|常规|標準|标准)$/iu.test(subfamily)) aliases.add(`${family} ${subfamily}`);
    }
  }
  return [...aliases];
}

async function readFontAliases(filePath, fileStat = null) {
  const resolvedPath = path.resolve(filePath);
  const currentStat = fileStat || await stat(resolvedPath).catch(() => null);
  if (!currentStat?.isFile() || !currentStat.size) return [];
  const cacheKey = `${resolvedPath}\0${currentStat.size}\0${currentStat.mtimeMs}`;
  let aliasesPromise = fontAliasCache.get(cacheKey);
  if (aliasesPromise) return aliasesPromise;
  aliasesPromise = (async () => {
    const handle = await open(resolvedPath, "r");
    try {
      const header = Buffer.alloc(12);
      if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) return [];
      let sfntOffsets = [0];
      if (header.toString("ascii", 0, 4) === "ttcf") {
        const fontCount = header.readUInt32BE(8);
        if (!fontCount || fontCount > 64) return [];
        const offsetTable = Buffer.alloc(fontCount * 4);
        if ((await handle.read(offsetTable, 0, offsetTable.length, 12)).bytesRead !== offsetTable.length) return [];
        sfntOffsets = Array.from({ length: fontCount }, (_, index) => offsetTable.readUInt32BE(index * 4));
      }
      const aliases = new Set();
      for (const sfntOffset of sfntOffsets) {
        for (const alias of await readSfntFontAliases(handle, sfntOffset)) aliases.add(alias);
      }
      return [...aliases].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
    } catch {
      return [];
    } finally {
      await handle.close();
    }
  })();
  fontAliasCache.set(cacheKey, aliasesPromise);
  return aliasesPromise;
}

function indexedFontEntry(fullPath, name = path.basename(fullPath), fileStat = null) {
  const extension = path.extname(name).toLowerCase();
  return {
    name,
    extension,
    stem: path.basename(name, extension).toLowerCase(),
    fullPath,
    episode: null,
    statPromise: fileStat ? Promise.resolve(fileStat) : null,
  };
}

async function findFontArchiveExtractor() {
  if (fontArchiveExtractorPromise) return fontArchiveExtractorPromise;
  fontArchiveExtractorPromise = (async () => {
    const executableName = process.platform === "win32" ? "UnRAR.exe" : "unrar";
    const candidates = [
      process.env.LMD_UNRAR_PATH,
      process.env.ProgramW6432 && path.join(process.env.ProgramW6432, "WinRAR", executableName),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "WinRAR", executableName),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "WinRAR", executableName),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "WinRAR", executableName),
      ...(process.env.PATH || "").split(path.delimiter).map((directory) => {
        const cleanDirectory = directory.trim().replace(/^"|"$/g, "");
        return cleanDirectory ? path.join(cleanDirectory, executableName) : null;
      }),
    ].filter(Boolean);
    for (const candidate of [...new Set(candidates.map((item) => path.resolve(item)))]) {
      if (await access(candidate).then(() => true).catch(() => false)) return candidate;
    }
    return null;
  })();
  return fontArchiveExtractorPromise;
}

function safeCachedFontName(fileName) {
  const safeName = path.basename(fileName).replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
  return (safeName || `font${path.extname(fileName).toLowerCase()}`).slice(-160);
}

async function cachedArchiveFontEntries(archivePath, archiveStat) {
  const archiveId = stableId(path.resolve(archivePath));
  const archiveSignature = stableId(`${archiveStat.size}\0${archiveStat.mtimeMs}`);
  const prefix = `${archiveId}-${archiveSignature}-`;
  const cachedFiles = await readdir(FONT_CACHE_DIR, { withFileTypes: true }).catch(() => []);
  const entries = [];
  for (const entry of cachedFiles) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const fullPath = path.join(FONT_CACHE_DIR, entry.name);
    const fileStat = await stat(fullPath).catch(() => null);
    if (!fileStat?.isFile() || !fileStat.size) continue;
    const originalName = entry.name.slice(prefix.length).replace(/^\d{3}-/, "");
    entries.push(indexedFontEntry(fullPath, originalName, fileStat));
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  return { archiveId, archiveSignature, entries };
}

async function extractFontArchive(archivePath) {
  const archiveStat = await stat(archivePath).catch(() => null);
  if (!archiveStat?.isFile() || !archiveStat.size || archiveStat.size > MAX_FONT_ARCHIVE_BYTES) return [];
  const cached = await cachedArchiveFontEntries(archivePath, archiveStat);
  if (cached.entries.length) return cached.entries;
  const extractor = await findFontArchiveExtractor();
  if (!extractor) {
    const warningKey = "missing-extractor";
    if (!reportedFontArchiveErrors.has(warningKey)) {
      reportedFontArchiveErrors.add(warningKey);
      console.warn("检测到 RAR 字体包，但未找到 UnRAR；安装 WinRAR 或通过 LMD_UNRAR_PATH 指定 UnRAR 后可自动载入字体。");
    }
    return [];
  }

  const temporaryDirectory = path.join(CACHE_DIR, "font-extract", randomUUID());
  await mkdir(temporaryDirectory, { recursive: true });
  try {
    // `e` 会丢弃压缩包内目录，只允许把文件写入这次扫描的临时目录，避免
    // 恶意或损坏的相对路径越出缓存；原压缩包与媒体目录始终保持只读。
    await runCommand(extractor, ["e", "-idq", "-o+", "-y", "--", archivePath, `${temporaryDirectory}${path.sep}`], 180000);
    const extractedEntries = (await readdir(temporaryDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    if (!extractedEntries.length || extractedEntries.length > MAX_FONT_PACK_FILES) return [];

    const extractedFiles = [];
    let extractedBytes = 0;
    for (const entry of extractedEntries) {
      const sourcePath = path.join(temporaryDirectory, entry.name);
      const fileStat = await stat(sourcePath).catch(() => null);
      if (!fileStat?.isFile() || !fileStat.size) continue;
      extractedBytes += fileStat.size;
      if (extractedBytes > MAX_EXTRACTED_FONT_BYTES) return [];
      extractedFiles.push({ entry, sourcePath, fileStat });
    }

    const publishedEntries = [];
    for (let index = 0; index < extractedFiles.length; index += 1) {
      const { entry, sourcePath, fileStat } = extractedFiles[index];
      const safeName = safeCachedFontName(entry.name);
      const cachedName = `${cached.archiveId}-${cached.archiveSignature}-${String(index).padStart(3, "0")}-${safeName}`;
      const outputPath = path.join(FONT_CACHE_DIR, cachedName);
      await copyFile(sourcePath, outputPath);
      publishedEntries.push(indexedFontEntry(outputPath, entry.name, fileStat));
    }
    if (publishedEntries.length) console.log(`已从字体包 ${path.basename(archivePath)} 载入 ${publishedEntries.length} 个字幕字体。`);
    return publishedEntries;
  } catch (error) {
    const warningKey = path.resolve(archivePath).toLowerCase();
    if (!reportedFontArchiveErrors.has(warningKey)) {
      reportedFontArchiveErrors.add(warningKey);
      console.warn(`无法读取字幕字体包 ${archivePath}: ${error.message}`);
    }
    return [];
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function indexFontPackDirectory(fontDirectory, depth = 0) {
  if (depth > 3) return [];
  const entries = await readdir(fontDirectory, { withFileTypes: true }).catch(() => []);
  const fontEntries = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(fontDirectory, entry.name);
    const extension = path.extname(entry.name).toLowerCase();
    if (entry.isFile() && FONT_EXTENSIONS.has(extension)) {
      fontEntries.push(indexedFontEntry(fullPath, entry.name));
    } else if (entry.isFile() && FONT_ARCHIVE_EXTENSIONS.has(extension)) {
      fontEntries.push(...await extractFontArchive(fullPath));
    } else if (entry.isDirectory()) {
      fontEntries.push(...await indexFontPackDirectory(fullPath, depth + 1));
    }
    if (fontEntries.length >= MAX_FONT_PACK_FILES) return fontEntries.slice(0, MAX_FONT_PACK_FILES);
  }
  return fontEntries;
}

async function findSidecarFiles(videoPath, directoryEntryCache = null) {
  const directory = path.dirname(videoPath);
  const videoStem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  const directoryKey = process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  let directoryIndexPromise = directoryEntryCache?.get(directoryKey);
  if (!directoryIndexPromise) {
    directoryIndexPromise = readdir(directory, { withFileTypes: true }).then(async (entries) => {
      const subtitleEntries = [];
      const fontEntries = [];
      const videoEpisodeCounts = new Map();
      let siblingVideoCount = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const extension = path.extname(entry.name).toLowerCase();
        const indexedEntry = {
          name: entry.name,
          extension,
          stem: path.basename(entry.name, extension).toLowerCase(),
          fullPath: path.join(directory, entry.name),
          episode: null,
          statPromise: null,
        };
        if (VIDEO_EXTENSIONS.has(extension)) {
          siblingVideoCount += 1;
          indexedEntry.episode = detectedEpisodeNumber(entry.name);
          if (indexedEntry.episode !== null) {
            videoEpisodeCounts.set(indexedEntry.episode, (videoEpisodeCounts.get(indexedEntry.episode) || 0) + 1);
          }
        } else if (SUBTITLE_EXTENSIONS.has(extension)) {
          indexedEntry.episode = detectedEpisodeNumber(entry.name);
          subtitleEntries.push(indexedEntry);
        } else if (FONT_EXTENSIONS.has(extension)) {
          fontEntries.push(indexedEntry);
        }
      }
      const fontPackDirectories = entries
        .filter((entry) => entry.isDirectory() && FONT_PACK_DIRECTORY_PATTERN.test(entry.name))
        .map((entry) => path.join(directory, entry.name));
      const rootFontArchives = entries
        .filter((entry) => entry.isFile()
          && FONT_ARCHIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          && FONT_ARCHIVE_NAME_PATTERN.test(path.basename(entry.name, path.extname(entry.name))))
        .map((entry) => path.join(directory, entry.name));
      const discoveredFontEntries = await Promise.all([
        ...fontPackDirectories.map((fontDirectory) => indexFontPackDirectory(fontDirectory)),
        ...rootFontArchives.map((archivePath) => extractFontArchive(archivePath)),
      ]);
      const knownFontPaths = new Set(fontEntries.map((entry) => path.resolve(entry.fullPath).toLowerCase()));
      for (const entry of discoveredFontEntries.flat()) {
        const fontPathKey = path.resolve(entry.fullPath).toLowerCase();
        if (knownFontPaths.has(fontPathKey)) continue;
        knownFontPaths.add(fontPathKey);
        fontEntries.push(entry);
      }
      return { subtitleEntries, fontEntries, videoEpisodeCounts, siblingVideoCount };
    }).catch(() => ({ subtitleEntries: [], fontEntries: [], videoEpisodeCounts: new Map(), siblingVideoCount: 0 }));
    directoryEntryCache?.set(directoryKey, directoryIndexPromise);
  }
  const directoryIndex = await directoryIndexPromise;
  const readEntryStat = (entry) => {
    entry.statPromise ||= stat(entry.fullPath).catch(() => null);
    return entry.statPromise;
  };
  const readEntryAliases = (entry, fileStat) => {
    entry.aliasesPromise ||= readFontAliases(entry.fullPath, fileStat);
    return entry.aliasesPromise;
  };

  const subtitles = [];
  const fonts = [];
  const videoEpisode = detectedEpisodeNumber(videoPath);
  const videosWithSameEpisode = videoEpisode === null
    ? 0
    : directoryIndex.videoEpisodeCounts.get(videoEpisode) || 0;
  for (const entry of directoryIndex.subtitleEntries) {
    const subtitleMatchesStem = entry.stem === videoStem || entry.stem.startsWith(`${videoStem}.`);
    const subtitleMatchesEpisode = directoryIndex.siblingVideoCount === 1
      || (videoEpisode !== null && videosWithSameEpisode === 1 && entry.episode === videoEpisode);
    if (subtitleMatchesStem || subtitleMatchesEpisode) {
      const fileStat = await readEntryStat(entry);
      if (!fileStat?.isFile()) continue;
      subtitles.push({
        id: stableId(entry.fullPath),
        name: entry.name,
        format: entry.extension.slice(1).toUpperCase(),
        path: entry.fullPath,
        language: inferSubtitleLanguage(entry.name),
        size: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
      });
    }
  }
  for (const entry of directoryIndex.fontEntries) {
    const fileStat = await readEntryStat(entry);
    if (fileStat?.isFile()) fonts.push({
      id: stableId(entry.fullPath),
      name: entry.name,
      path: entry.fullPath,
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      aliases: await readEntryAliases(entry, fileStat),
    });
  }
  subtitles.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  fonts.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  return { subtitles, fonts };
}

function inferSubtitleLanguage(fileName) {
  const name = fileName.toLowerCase();
  if (/zh[-_.]?(cn|hans)|chs|简|(^|[._-])(chi|zho)([._-]|$)/.test(name)) return "简体中文";
  if (/zh[-_.]?(tw|hant)|cht|繁/.test(name)) return "繁体中文";
  if (/(^|[._-])en(g)?([._-]|$)/.test(name)) return "English";
  if (/(^|[._-])(ja|jpn)([._-]|$)/.test(name)) return "日本語";
  return "未标记";
}

function parseBitDepth(pixelFormat = "") {
  const match = pixelFormat.match(/p(\d{2})(?:le|be)?$/i);
  return match ? Number(match[1]) : 8;
}

async function probeVideo(filePath, executeCommand = runCommand) {
  if (!mediaTools.available) return {};
  try {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration,format_name,start_time,bit_rate:stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,bits_per_raw_sample,avg_frame_rate,r_frame_rate,bit_rate,start_time,time_base,channels,channel_layout,sample_rate,color_space,color_transfer,color_primaries,extradata_size:stream_disposition:stream_tags=language,title,filename,mimetype",
      "-of", "json",
      filePath,
    ];
    const result = await executeCommand(mediaTools.ffprobe, args, 20000);
    const data = JSON.parse(result.stdout);
    const video = data.streams?.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const audio = data.streams?.find((stream) => stream.codec_type === "audio");
    const embeddedSubtitleStreams = (data.streams || []).filter((stream) => stream.codec_type === "subtitle" && EMBEDDED_SUBTITLE_CODECS.has(stream.codec_name)).map((stream) => ({
      index: stream.index,
      codec: stream.codec_name,
      format: EMBEDDED_SUBTITLE_CODECS.get(stream.codec_name).format,
      extension: EMBEDDED_SUBTITLE_CODECS.get(stream.codec_name).extension,
      language: stream.tags?.language || "",
      title: stream.tags?.title || "",
    }));
    const embeddedFontStreams = (data.streams || []).filter((stream) => stream.codec_type === "attachment").map((stream) => ({
      index: stream.index,
      fileName: stream.tags?.filename || `font-${stream.index}`,
      mimeType: stream.tags?.mimetype || "",
      size: Number(stream.extradata_size) || null,
    })).filter((stream) => FONT_EXTENSIONS.has(path.extname(stream.fileName).toLowerCase()));
    const transfer = video?.color_transfer || "";
    const headerFile = await open(filePath, "r");
    let webm = false;
    try { const header = Buffer.alloc(4096); const { bytesRead } = await headerFile.read(header, 0, header.length, 0); webm = header.subarray(0, bytesRead).includes(Buffer.from("webm")); }
    finally { await headerFile.close(); }
    const fileStat = await stat(filePath);
    return {
      playbackMetadata: normalizeProbe(data, { webm, sourceSignature: `${fileStat.size}:${fileStat.mtime.toISOString()}` }),
      durationSeconds: Number(data.format?.duration || 0),
      container: data.format?.format_name?.split(",")[0] || path.extname(filePath).slice(1),
      width: video?.width || null,
      height: video?.height || null,
      videoCodec: video?.codec_name || null,
      videoProfile: video?.profile || null,
      audioCodec: audio?.codec_name || null,
      pixelFormat: video?.pix_fmt || null,
      bitDepth: parseBitDepth(video?.pix_fmt),
      hdr: transfer === "smpte2084" ? "HDR10" : transfer === "arib-std-b67" ? "HLG" : null,
      colorPrimaries: video?.color_primaries || null,
      embeddedSubtitleStreams,
      embeddedFontStreams,
    };
  } catch (error) {
    return { probeError: error.message };
  }
}

async function usableCacheFile(filePath, { expectedSize = null, sourceModifiedAt = 0, signatureBound = false } = {}) {
  if (!filePath) return null;
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size <= 0) return null;
  if (expectedSize && fileStat.size !== expectedSize) return null;
  if (!signatureBound && sourceModifiedAt && fileStat.mtimeMs + LEGACY_CACHE_MTIME_TOLERANCE_MS < sourceModifiedAt) return null;
  return { path: filePath, stat: fileStat };
}

async function reusableGeneratedCachePath(primaryPath, legacyPath, { allowLegacyCache = true, ...options } = {}) {
  const primary = await usableCacheFile(primaryPath, { ...options, signatureBound: true });
  if (primary) return primary;
  if (!allowLegacyCache || legacyPath === primaryPath) return null;
  return usableCacheFile(legacyPath, { ...options, signatureBound: false });
}

async function publishGeneratedCacheFile(temporaryPath, outputPath, expectedSize = null) {
  const temporaryFile = await usableCacheFile(temporaryPath, { expectedSize, signatureBound: true });
  if (!temporaryFile) return null;
  await unlink(outputPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rename(temporaryPath, outputPath);
  return usableCacheFile(outputPath, { expectedSize, signatureBound: true });
}

async function extractEmbeddedAssets(filePath, mediaId, probe, sidecars, sourceSignature = "", sourceModifiedAt = 0, allowLegacyCache = true, executeCommand = runCommand) {
  if (!mediaTools.available) return sidecars;
  const subtitles = [...sidecars.subtitles];
  const fonts = [...sidecars.fonts];
  const signaturePart = sourceSignature ? `-${sourceSignature}` : "";

  const subtitlePlans = await Promise.all((probe.embeddedSubtitleStreams || []).map(async (stream) => {
    const legacyPath = path.join(SUBTITLE_CACHE_DIR, `${mediaId}-${stream.index}${stream.extension}`);
    const outputPath = path.join(SUBTITLE_CACHE_DIR, `${mediaId}${signaturePart}-${stream.index}${stream.extension}`);
    const cached = await reusableGeneratedCachePath(outputPath, legacyPath, { sourceModifiedAt, allowLegacyCache });
    return { stream, outputPath, cachedPath: cached?.path || null, temporaryName: `${stream.index}${stream.extension}` };
  }));
  const missingSubtitles = subtitlePlans.filter((plan) => !plan.cachedPath);
  if (missingSubtitles.length) {
    const temporaryDirectory = path.join(CACHE_DIR, "subtitle-extract", randomUUID());
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", filePath];
      for (const plan of missingSubtitles) args.push("-map", `0:${plan.stream.index}`, "-c", "copy", plan.temporaryName);
      await executeCommand(mediaTools.ffmpeg, args, 180000, { cwd: temporaryDirectory });
      for (const plan of missingSubtitles) {
        const published = await publishGeneratedCacheFile(path.join(temporaryDirectory, plan.temporaryName), plan.outputPath);
        plan.cachedPath = published?.path || null;
      }
    } catch (error) {
      console.error(`无法批量提取内嵌字幕 ${filePath}: ${error.message}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const { stream, cachedPath } of subtitlePlans) {
    if (!cachedPath) continue;
    subtitles.push({
      id: `embedded-subtitle-${mediaId}-${stream.index}`,
      name: stream.title || `内嵌字幕 ${stream.index}`,
      format: stream.format,
      path: cachedPath,
      language: inferSubtitleLanguage(`${stream.language}.${stream.title}`),
      source: "embedded",
      streamIndex: stream.index,
    });
  }

  const fontPlans = await Promise.all((probe.embeddedFontStreams || []).map(async (stream) => {
    const safeName = path.basename(stream.fileName).replace(/[^\p{L}\p{N}._ -]/gu, "_");
    const legacyPath = path.join(FONT_CACHE_DIR, `${mediaId}-${stream.index}-${safeName}`);
    const outputPath = path.join(FONT_CACHE_DIR, `${mediaId}${signaturePart}-${stream.index}-${safeName}`);
    const cached = await reusableGeneratedCachePath(outputPath, legacyPath, { expectedSize: stream.size, sourceModifiedAt, allowLegacyCache });
    return { stream, safeName, outputPath, cachedPath: cached?.path || null, temporaryName: `${stream.index}.part` };
  }));
  const missingFonts = fontPlans.filter((plan) => !plan.cachedPath);
  if (missingFonts.length) {
    const temporaryDirectory = path.join(CACHE_DIR, "attachment-extract", randomUUID());
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
      for (const plan of missingFonts) args.push(`-dump_attachment:${plan.stream.index}`, plan.temporaryName);
      args.push("-i", filePath, "-map", "0:v:0?", "-c", "copy", "-t", "0", "-f", "null", "-");
      await executeCommand(mediaTools.ffmpeg, args, 60000, { cwd: temporaryDirectory });
      for (const plan of missingFonts) {
        const published = await publishGeneratedCacheFile(path.join(temporaryDirectory, plan.temporaryName), plan.outputPath, plan.stream.size);
        plan.cachedPath = published?.path || null;
      }
    } catch (error) {
      console.error(`无法批量提取内嵌字体 ${filePath}: ${error.message}`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const { stream, safeName, cachedPath } of fontPlans) {
    if (!cachedPath) continue;
    const fontStat = await stat(cachedPath).catch(() => null);
    fonts.push({
      id: `embedded-font-${mediaId}-${stream.index}`,
      name: safeName,
      path: cachedPath,
      size: fontStat?.size || stream.size || null,
      aliases: await readFontAliases(cachedPath, fontStat),
      sourceSignature,
      source: "embedded",
      streamIndex: stream.index,
    });
  }
  return { subtitles, fonts };
}

// Generate one real preview frame per video. The JPG lives in data/cache, so
// original videos are never modified and later scans can reuse the same image.
async function ensureVideoThumbnail(filePath, mediaId, durationSeconds = 0, existingPath = null, sourceSignature = "", sourceModifiedAt = 0, allowLegacyCache = true, executeCommand = runCommand) {
  const legacyPath = path.join(THUMBNAIL_CACHE_DIR, `${mediaId}.jpg`);
  const outputPath = path.join(THUMBNAIL_CACHE_DIR, `${mediaId}${sourceSignature ? `-${sourceSignature}` : ""}.jpg`);
  const existingFile = existingPath && await usableCacheFile(existingPath, { signatureBound: true });
  if (existingFile) return existingFile.path;
  const cached = await reusableGeneratedCachePath(outputPath, legacyPath, { sourceModifiedAt, allowLegacyCache });
  if (cached) return cached.path;
  if (!mediaTools.available) return null;

  const seekSeconds = durationSeconds > 60
    ? Math.min(durationSeconds * 0.12, 300)
    : Math.min(Math.max(durationSeconds * 0.2, 0), 10);
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", seekSeconds.toFixed(3), "-i", filePath,
    "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn",
    "-vf", "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
    "-threads", "1", "-q:v", "3", outputPath,
  ];
  try {
    await executeCommand(mediaTools.ffmpeg, args, 60000);
    const thumbnailStat = await stat(outputPath).catch(() => null);
    return thumbnailStat?.size ? outputPath : null;
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    console.error(`无法生成视频缩略图 ${filePath}: ${error.message}`);
    return null;
  }
}

async function mapWithConcurrency(items, limit, mapper, onItemSettled = null) {
  const results = new Array(items.length);
  let cursor = 0;
  let firstError = null;
  async function worker() {
    while (!firstError && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      } finally {
        onItemSettled?.(items[index], index);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  if (firstError) throw firstError;
  return results;
}

async function mapWithResizableConcurrency(items, initialLimit, mapper, onItemSettled, control) {
  const results = new Array(items.length);
  let cursor = 0;
  let activeWorkers = 0;
  let desiredWorkers = Math.max(1, initialLimit);
  let firstError = null;
  let complete;
  const completion = new Promise((resolve) => { complete = resolve; });

  const finishIfReady = () => {
    if (activeWorkers === 0 && (firstError || cursor >= items.length)) complete();
  };
  const startWorkers = (nextLimit = desiredWorkers) => {
    desiredWorkers = Math.max(desiredWorkers, Math.max(1, nextLimit));
    while (!firstError && activeWorkers < desiredWorkers && cursor < items.length) {
      activeWorkers += 1;
      void (async () => {
        while (!firstError && cursor < items.length) {
          const index = cursor++;
          try {
            results[index] = await mapper(items[index], index);
          } catch (error) {
            if (!firstError) firstError = error;
          } finally {
            onItemSettled?.(items[index], index);
          }
          if (desiredWorkers > STANDARD_SCAN_CONCURRENCY) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      })().finally(() => {
        activeWorkers -= 1;
        finishIfReady();
      });
    }
    finishIfReady();
  };

  control.increaseTo = startWorkers;
  startWorkers(initialLimit);
  await completion;
  delete control.increaseTo;
  if (firstError) throw firstError;
  return results;
}

function createResizableTaskLimiter(initialLimit) {
  let limit = Math.max(1, Math.round(initialLimit));
  let activeTasks = 0;
  const queuedTasks = [];
  const schedule = () => {
    while (activeTasks < limit && queuedTasks.length) {
      const { task, resolve, reject } = queuedTasks.shift();
      activeTasks += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeTasks -= 1;
          schedule();
        });
    }
  };
  const run = (task) => new Promise((resolve, reject) => {
    queuedTasks.push({ task, resolve, reject });
    schedule();
  });
  run.increaseTo = (nextLimit) => {
    limit = Math.max(limit, Math.max(1, Math.round(nextLimit)));
    schedule();
  };
  return run;
}

let activeScan = null;
let activeScanContext = null;
let lastScanContext = null;
let pendingScanMode = null;
let lastScanStartedAt = null;
let lastScanCompletedAt = null;
let lastScanError = null;
let libraryRevision = 0;

function assertLibraryRevision(expectedRevision) {
  if (libraryRevision === expectedRevision) return;
  const error = new Error("视频目录已在扫描期间发生变化，本次旧扫描结果已丢弃，请重新扫描。");
  error.code = "LIBRARY_CHANGED_DURING_SCAN";
  throw error;
}

function normalizedAutoScanIntervalSeconds(value = appState.settings.autoScanIntervalSeconds) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 30;
  return Math.min(AUTO_SCAN_MAX_INTERVAL_SECONDS, Math.max(AUTO_SCAN_MIN_INTERVAL_SECONDS, Math.round(seconds)));
}

function normalizedScanMode(value = "standard") {
  const mode = String(value || "standard").trim().toLowerCase();
  if (mode === "standard" || mode === "turbo") return mode;
  const error = new Error("扫描模式无效，请使用 standard 或 turbo。");
  error.code = "INVALID_SCAN_MODE";
  throw error;
}

function scanCancellationError() {
  const error = new Error("本次最高性能扫描已手动停止");
  error.code = "SCAN_CANCELLED";
  return error;
}

function scanConcurrencyForMode(mode) {
  return mode === "turbo" ? TURBO_SCAN_CONCURRENCY : STANDARD_SCAN_CONCURRENCY;
}

function scanMediaToolConcurrencyForMode(mode) {
  return mode === "turbo" ? TURBO_SCAN_MEDIA_TOOL_CONCURRENCY : STANDARD_SCAN_MEDIA_TOOL_CONCURRENCY;
}

function scanCheckpointConfigForMode(mode) {
  return mode === "turbo"
    ? { itemCount: TURBO_SCAN_CHECKPOINT_ITEM_COUNT, intervalMs: TURBO_SCAN_CHECKPOINT_INTERVAL_MS }
    : { itemCount: SCAN_CHECKPOINT_ITEM_COUNT, intervalMs: SCAN_CHECKPOINT_INTERVAL_MS };
}

// 扫描取消或失败时，把已发布媒体物化进 appState.media：本次扫描库以
// publishedMediaById（含最新发布结果）为准，其他库沿用当前索引；同时
// 过滤掉扫描期间被删除的库，避免已删除库的媒体被“复活”。
function materializePublishedMedia(publishedMediaById, scanLibrariesSnapshot) {
  const scannedLibraryIds = new Set(scanLibrariesSnapshot.map((library) => library.id));
  const liveLibraryIds = new Set(appState.libraries.map((library) => library.id));
  const scannedLiveMedia = [...publishedMediaById.values()].filter((media) => scannedLibraryIds.has(media.libraryId));
  const unrelatedMedia = appState.media.filter((media) => !scannedLibraryIds.has(media.libraryId));
  appState.media = [...unrelatedMedia, ...scannedLiveMedia].filter((media) => liveLibraryIds.has(media.libraryId));
  return appState.media;
}

function createScanContext(mode, libraries, scanLibraryRevision) {
  return {
    id: randomUUID(),
    mode,
    phase: "discovering",
    progressPercent: null,
    discoveredFiles: 0,
    processedFiles: 0,
    totalFiles: 0,
    processedLibraries: 0,
    totalLibraries: libraries.length,
    maxParallelFiles: scanConcurrencyForMode(mode),
    maxParallelMediaTools: scanMediaToolConcurrencyForMode(mode),
    cancelRequested: false,
    libraryRevision: scanLibraryRevision,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
}

async function stopTurboScan() {
  let stopped = false;
  if (pendingScanMode === "turbo") {
    pendingScanMode = null;
    stopped = true;
  }
  const context = activeScanContext;
  const scanPromise = activeScan;
  if (scanPromise && context?.mode === "turbo") {
    stopped = true;
    context.cancelRequested = true;
    context.phase = "cancelling";
    context.cancelActiveMediaTools?.();
    try { await scanPromise; }
    catch { /* scanLibraries 会把用户取消转换成正常的 cancelled 状态。 */ }
    while (activeScan === scanPromise) await new Promise((resolve) => setImmediate(resolve));
  }
  return { stopped, scan: catalogScanStatus() };
}

function catalogScanStatus() {
  const context = activeScanContext || lastScanContext;
  return {
    enabled: Boolean(appState.settings.autoScanEnabled),
    scanning: Boolean(activeScan),
    intervalSeconds: normalizedAutoScanIntervalSeconds(),
    lastStartedAt: lastScanStartedAt,
    lastCompletedAt: lastScanCompletedAt,
    lastError: lastScanError,
    id: context?.id || null,
    mode: context?.mode || null,
    pendingMode: pendingScanMode,
    phase: context?.phase || "idle",
    progressPercent: context?.progressPercent ?? null,
    discoveredFiles: context?.discoveredFiles || 0,
    processedFiles: context?.processedFiles || 0,
    totalFiles: context?.totalFiles || 0,
    processedLibraries: context?.processedLibraries || 0,
    totalLibraries: context?.totalLibraries || appState.libraries.length,
    maxParallelFiles: context?.maxParallelFiles || STANDARD_SCAN_CONCURRENCY,
    maxParallelMediaTools: context?.maxParallelMediaTools || STANDARD_SCAN_MEDIA_TOOL_CONCURRENCY,
  };
}

async function scanLibraries({ mode: requestedMode = "standard" } = {}) {
  const mode = normalizedScanMode(requestedMode);
  if (sharingServiceIsStopping) throw new Error("共享服务正在关闭，已取消媒体扫描");
  if (activeScan) {
    if (mode === "turbo" && activeScanContext?.libraryRevision !== libraryRevision) {
      pendingScanMode = "turbo";
      const previousScan = activeScan;
      try { await previousScan; }
      catch { /* 旧扫描失败或目录已变化时，仍继续执行用户请求的急速扫描。 */ }
      return scanLibraries({ mode: "turbo" });
    }
    if (mode === "turbo" && activeScanContext?.mode !== "turbo") {
      activeScanContext.mode = "turbo";
      activeScanContext.maxParallelFiles = TURBO_SCAN_CONCURRENCY;
      activeScanContext.maxParallelMediaTools = TURBO_SCAN_MEDIA_TOOL_CONCURRENCY;
      activeScanContext.increaseConcurrency?.(TURBO_SCAN_CONCURRENCY);
      activeScanContext.increaseMediaToolConcurrency?.(TURBO_SCAN_MEDIA_TOOL_CONCURRENCY);
      pendingScanMode = null;
      return activeScan;
    }
    return activeScan;
  }
  if (mode === pendingScanMode) pendingScanMode = null;
  const scanLibraryRevision = libraryRevision;
  const scanLibrariesSnapshot = appState.libraries.map((library) => ({ ...library }));
  const scanContext = createScanContext(mode, scanLibrariesSnapshot, scanLibraryRevision);
  activeScanContext = scanContext;
  lastScanContext = scanContext;
  lastScanStartedAt = scanContext.startedAt;
  lastScanError = null;
  let rejectScanCancellation;
  const scanCancellationPromise = new Promise((_, reject) => { rejectScanCancellation = reject; });
  // scanWorkPromise 内部发布的媒体索引；提升到函数级作用域，供取消/失败
  // 路径在 Promise.race 抢先 reject 后仍能物化已发布媒体。
  let scanPublishedMediaById = null;
  const scanWorkPromise = (async () => {
    const sidecarDirectoryCache = new Map();
    const scanChildProcesses = new Set();
    const limitMediaToolTask = createResizableTaskLimiter(scanContext.maxParallelMediaTools);
    scanContext.increaseMediaToolConcurrency = (limit) => limitMediaToolTask.increaseTo(limit);
    scanContext.cancelActiveMediaTools = () => {
      rejectScanCancellation(scanCancellationError());
      for (const child of scanChildProcesses) {
        try { child.kill(); }
        catch { /* 子进程可能已经自行退出。 */ }
      }
    };
    const assertScanNotCancelled = () => {
      if (scanContext.cancelRequested) throw scanCancellationError();
    };
    const runScanMediaCommand = (executable, args, timeoutMs, options = {}) => limitMediaToolTask(() => {
      assertScanNotCancelled();
      return runCommand(executable, args, timeoutMs, {
        ...options,
        onChild: (child) => {
          scanChildProcesses.add(child);
          const forgetChild = () => scanChildProcesses.delete(child);
          child.once("close", forgetChild);
          child.once("error", forgetChild);
        },
      });
    });
    const oldMedia = new Map(appState.media.map((item) => [item.id, item]));
    const oldMediaByPath = new Map(appState.media.map((item) => [path.resolve(item.path).toLowerCase(), item]));
    const libraryOrderById = new Map(scanLibrariesSnapshot.map((library, index) => [library.id, index]));
    const filesByPath = new Map();
    const incompleteLibraries = [];
    for (const library of scanLibrariesSnapshot) {
      const walkStatus = { complete: true, errors: [], truncated: false };
      const found = await walkDirectory(library.path, 0, [], walkStatus, () => {
        assertScanNotCancelled();
        scanContext.discoveredFiles += 1;
      });
      assertScanNotCancelled();
      if (!walkStatus.complete) incompleteLibraries.push({ library, ...walkStatus });
      assertScanNotCancelled();
      assertLibraryRevision(scanLibraryRevision);
      const candidates = await mapWithConcurrency(found, scanContext.maxParallelFiles, async (filePath) => {
        assertScanNotCancelled();
        const resolvedFilePath = path.resolve(filePath);
        const previousMediaAtPath = oldMediaByPath.get(resolvedFilePath.toLowerCase());
        const identityPath = await realpath(resolvedFilePath).catch(() => null);
        assertScanNotCancelled();
        assertLibraryRevision(scanLibraryRevision);
        const owner = mostSpecificLibraryForPath(resolvedFilePath, scanLibrariesSnapshot) || library;
        const legacyId = stableId(resolvedFilePath);
        const identityId = identityPath ? stableId(identityPath) : (previousMediaAtPath?.id || legacyId);
        const previousMedia = oldMedia.get(identityId) || oldMedia.get(legacyId) || previousMediaAtPath;
        return {
          filePath: resolvedFilePath,
          identityId,
          legacyId,
          libraryId: owner.id,
          wasPreviousOwner: previousMedia?.libraryId === owner.id,
          libraryOrder: libraryOrderById.get(owner.id) ?? Number.MAX_SAFE_INTEGER,
        };
      });
      assertScanNotCancelled();
      assertLibraryRevision(scanLibraryRevision);
      for (const candidate of candidates) {
        const key = candidate.identityId;
        const current = filesByPath.get(key);
        const legacyIds = current?.legacyIds || new Set();
        legacyIds.add(candidate.legacyId);
        candidate.legacyIds = legacyIds;
        const candidateIsPreferred = !current
          || (candidate.wasPreviousOwner && !current.wasPreviousOwner)
          || (candidate.wasPreviousOwner === current.wasPreviousOwner && candidate.libraryOrder < current.libraryOrder)
          || (candidate.wasPreviousOwner === current.wasPreviousOwner && candidate.libraryOrder === current.libraryOrder && candidate.filePath.localeCompare(current.filePath) < 0);
        if (candidateIsPreferred) filesByPath.set(key, candidate);
      }
      scanContext.processedLibraries += 1;
    }
    assertScanNotCancelled();
    assertLibraryRevision(scanLibraryRevision);
    const files = [...filesByPath.values()];
    scanContext.phase = "processing";
    scanContext.totalFiles = files.length;
    scanContext.progressPercent = files.length ? 0 : 95;

    const scanSession = { cancelled: false, firstError: null };
    const publishedMediaById = new Map(appState.media.map((media) => [media.id, media]));
    scanPublishedMediaById = publishedMediaById;
    let publishedSinceCheckpoint = 0;
    let lastCheckpointAt = Date.now();
    const assertCurrentScan = () => {
      assertScanNotCancelled();
      if (scanSession.cancelled) throw scanSession.firstError || new Error("媒体扫描已取消");
      if (sharingServiceIsStopping) throw new Error("共享服务正在关闭，已取消媒体扫描");
      assertLibraryRevision(scanLibraryRevision);
    };
    const publishScannedMedia = async (media, migratedFromIds) => {
      assertCurrentScan();
      if (!appState.libraries.some((library) => library.id === media.libraryId)) {
        const error = new Error("视频目录已在扫描期间被删除，本次旧扫描结果已丢弃，请重新扫描。");
        error.code = "LIBRARY_CHANGED_DURING_SCAN";
        throw error;
      }
      for (const oldMediaId of migratedFromIds) publishedMediaById.delete(oldMediaId);
      publishedMediaById.set(media.id, media);
      for (const oldMediaId of migratedFromIds) {
        const oldMediaItem = oldMedia.get(oldMediaId);
        for (const job of appState.jobs) {
          if (job.mediaId !== oldMediaId) continue;
          if (oldMediaItem && job.sourceSignature === mediaSourceSignature(oldMediaItem)) {
            job.sourceSignature = mediaSourceSignature(media);
          }
          job.mediaId = media.id;
        }
        const task = remuxTasksByMediaId.get(oldMediaId);
        if (task && !remuxTasksByMediaId.has(media.id)) {
          remuxTasksByMediaId.delete(oldMediaId);
          task.mediaId = media.id;
          remuxTasksByMediaId.set(media.id, task);
        }
      }
      publishedSinceCheckpoint += 1;
      const checkpoint = scanCheckpointConfigForMode(scanContext.mode);
      if (publishedSinceCheckpoint >= checkpoint.itemCount || Date.now() - lastCheckpointAt >= checkpoint.intervalMs) {
        publishedSinceCheckpoint = 0;
        lastCheckpointAt = Date.now();
        // 只在 checkpoint 时物化一次数组，避免每个文件都全量重建（O(n²)）。
        appState.media = [...publishedMediaById.values()];
        await saveState();
        assertCurrentScan();
      }
      return media;
    };
    const scanOneMedia = async ({ filePath, identityId: id, legacyId, legacyIds, libraryId }) => {
      try {
        assertCurrentScan();
        if (TEST_SCAN_FILE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, TEST_SCAN_FILE_DELAY_MS));
        assertCurrentScan();
        const fileStat = await stat(filePath);
        assertCurrentScan();
        const modifiedAt = fileStat.mtime.toISOString();
        const sourceSignature = mediaSourceSignature({ id, size: fileStat.size, modifiedAt });
        const existing = oldMedia.get(id)
          || oldMedia.get(legacyId)
          || [...legacyIds].map((candidateId) => oldMedia.get(candidateId)).find(Boolean);
        const migratedFromIds = new Set([...legacyIds].filter((candidateId) => candidateId !== id && oldMedia.has(candidateId)));
        if (existing?.id !== undefined && existing.id !== id) migratedFromIds.add(existing.id);
        const unchanged = existing && existing.size === fileStat.size && existing.modifiedAt === modifiedAt;
        let scannedMedia;
        if (unchanged) {
          // Refresh metadata independently of file identity. Existing assets and
          // legacy compatible copies remain valid during this lazy migration.
          if (mediaTools.available && existing.playbackMetadata?.version !== METADATA_VERSION) {
            const updatedProbe = await probeVideo(filePath, runScanMediaCommand);
            if (updatedProbe.playbackMetadata) Object.assign(existing, updatedProbe);
          }
          // The record still describes this file on disk; refresh the identity
          // fields from the current stat so the catalog can never advertise a
          // stale size/mtime whose signature contradicts the file. Without this,
          // in-place probe refreshes leave playback sessions failing the
          // source-signature check for a file that never actually changed.
          existing.size = fileStat.size;
          existing.modifiedAt = modifiedAt;
          const sidecarsPromise = findSidecarFiles(filePath, sidecarDirectoryCache);
          const thumbnailPromise = ensureVideoThumbnail(filePath, id, existing.durationSeconds, existing.thumbnailPath, sourceSignature, fileStat.mtimeMs, true, runScanMediaCommand);
          const sidecars = await sidecarsPromise;
          assertCurrentScan();
          const hasEmbeddedProbeMetadata = Array.isArray(existing.embeddedSubtitleStreams) && Array.isArray(existing.embeddedFontStreams);
          const embeddedAssetsPromise = hasEmbeddedProbeMetadata
            ? extractEmbeddedAssets(filePath, id, existing, sidecars, sourceSignature, fileStat.mtimeMs, true, runScanMediaCommand)
            : Promise.resolve({
                subtitles: [...sidecars.subtitles, ...(existing.subtitles || []).filter((item) => item.source === "embedded")],
                fonts: [...sidecars.fonts, ...(existing.fonts || []).filter((item) => item.source === "embedded")],
              });
          const [embeddedAssets, thumbnailPath] = await Promise.all([embeddedAssetsPromise, thumbnailPromise]);
          assertCurrentScan();
          const mediaIdChanged = existing.id !== id;
          const oldSourceSignature = mediaSourceSignature(existing);
          const migratedRemuxFile = mediaIdChanged && existing.remuxPath
            ? await stat(existing.remuxPath).catch(() => null)
            : null;
          assertCurrentScan();
          const migratedRemuxMatchesSource = Boolean(
            existing.remuxPath
            && migratedRemuxFile?.isFile()
            && migratedRemuxFile.size > 0
            && existing.remuxVersion === COMPATIBLE_COPY_VERSION
            && existing.remuxSourceSignature === oldSourceSignature,
          );
          scannedMedia = {
            ...existing,
            id,
            libraryId,
            title: path.basename(filePath, path.extname(filePath)),
            fileName: path.basename(filePath),
            path: filePath,
            extension: path.extname(filePath).slice(1).toUpperCase(),
            posterHue: Number.parseInt(id.slice(0, 4), 16) % 360,
            remuxPath: !mediaIdChanged || migratedRemuxMatchesSource ? existing.remuxPath : null,
            remuxVersion: !mediaIdChanged || migratedRemuxMatchesSource ? existing.remuxVersion : null,
            remuxSourceSignature: !mediaIdChanged
              ? existing.remuxSourceSignature
              : (migratedRemuxMatchesSource ? sourceSignature : null),
            thumbnailPath,
            subtitles: embeddedAssets.subtitles,
            fonts: embeddedAssets.fonts,
          };
        } else {
          const probe = await probeVideo(filePath, runScanMediaCommand);
          assertCurrentScan();
          const allowLegacyCache = !existing;
          const sidecarsPromise = findSidecarFiles(filePath, sidecarDirectoryCache);
          const thumbnailPromise = ensureVideoThumbnail(filePath, id, probe.durationSeconds, null, sourceSignature, fileStat.mtimeMs, allowLegacyCache, runScanMediaCommand);
          const [sidecars, thumbnailPath] = await Promise.all([
            sidecarsPromise.then((sidecarFiles) => extractEmbeddedAssets(filePath, id, probe, sidecarFiles, sourceSignature, fileStat.mtimeMs, allowLegacyCache, runScanMediaCommand)),
            thumbnailPromise,
          ]);
          assertCurrentScan();
          const remuxMatchesSource = existing?.remuxSourceSignature === sourceSignature;
          const nextMedia = {
            id,
            libraryId,
            title: path.basename(filePath, path.extname(filePath)),
            fileName: path.basename(filePath),
            path: filePath,
            extension: path.extname(filePath).slice(1).toUpperCase(),
            size: fileStat.size,
            modifiedAt,
            tags: existing?.tags || [],
            posterHue: Number.parseInt(id.slice(0, 4), 16) % 360,
            remuxPath: remuxMatchesSource ? existing.remuxPath : null,
            remuxVersion: remuxMatchesSource ? existing.remuxVersion : null,
            remuxSourceSignature: remuxMatchesSource ? existing.remuxSourceSignature : null,
            thumbnailPath,
            subtitles: sidecars.subtitles,
            fonts: sidecars.fonts,
            ...probe,
          };
          scannedMedia = existing ? { ...existing, ...nextMedia } : nextMedia;
        }
        assertCurrentScan();
        return await publishScannedMedia(scannedMedia, migratedFromIds);
      } catch (error) {
        if (!scanSession.firstError) scanSession.firstError = error;
        scanSession.cancelled = true;
        throw error;
      }
    };

    const scanWorkerControl = {};
    scanContext.increaseConcurrency = (limit) => scanWorkerControl.increaseTo?.(limit);
    const scanned = await mapWithResizableConcurrency(files, scanContext.maxParallelFiles, scanOneMedia, () => {
      scanContext.processedFiles += 1;
      scanContext.progressPercent = scanContext.totalFiles
        ? Math.min(95, Math.round(scanContext.processedFiles / scanContext.totalFiles * 95))
        : 95;
    }, scanWorkerControl);
    delete scanContext.increaseConcurrency;
    delete scanContext.increaseMediaToolConcurrency;
    assertCurrentScan();
    if (incompleteLibraries.length) {
      await saveState();
      assertCurrentScan();
      const names = incompleteLibraries.map(({ library }) => library.name || library.path).join("、");
      const error = new Error(`部分视频目录未能完整读取（${names}），已保留旧索引并发布本次成功识别的视频。`);
      error.code = "SCAN_ENUMERATION_INCOMPLETE";
      throw error;
    }
    const scannedLibraryIds = new Set(scanLibrariesSnapshot.map((library) => library.id));
    // The freshly published object wins over any older copy held by the live
    // index or the scan checkpoint: it carries this scan's identity fields and
    // receives every in-place refresh (playback probe, thumbnail) as well. Any
    // other copy can describe older bytes and would make stored signatures
    // contradict the file on disk.
    const publishedForId = (id) => publishedMediaById.get(id) || liveMediaById.get(id) || null;
    const unrelatedMedia = appState.media.filter((media) => !scannedLibraryIds.has(media.libraryId));
    const finalMedia = [
      ...unrelatedMedia,
      ...scanned.map((media) => publishedForId(media.id) || media),
    ];
    const finalMediaIds = new Set(finalMedia.map((media) => media.id));
    const prunedMedia = appState.media.filter((media) => scannedLibraryIds.has(media.libraryId) && !finalMediaIds.has(media.id));
    appState.media = finalMedia;
    scanContext.phase = "finalizing";
    scanContext.progressPercent = 98;
    try {
      testFinalScanSaveCount += 1;
      if (TEST_FAIL_FINAL_SCAN_SAVE_NUMBER === testFinalScanSaveCount) {
        throw new Error("测试触发：最终扫描状态保存失败");
      }
      await saveState();
      assertCurrentScan();
    } catch (error) {
      const liveLibraryIds = new Set(appState.libraries.map((library) => library.id));
      const restoredMediaById = new Map(appState.media.map((media) => [media.id, media]));
      for (const media of prunedMedia) {
        if (liveLibraryIds.has(media.libraryId) && !restoredMediaById.has(media.id)) restoredMediaById.set(media.id, media);
      }
      appState.media = [...restoredMediaById.values()];
      await saveState().catch((restoreError) => console.error(`恢复最终扫描前的旧索引失败：${restoreError.message}`));
      throw error;
    }
    await queueAutomaticCompatibleCopies().catch((error) => console.error(`扫描后准备兼容副本失败：${error.message}`));
    await cleanOrphanedCacheFiles().catch((error) => console.error(`扫描后清理孤儿缓存失败：${error.message}`));
    assertCurrentScan();
    lastScanCompletedAt = new Date().toISOString();
    scanContext.phase = "completed";
    scanContext.progressPercent = 100;
    scanContext.completedAt = lastScanCompletedAt;
    return appState.media;
  })();
  // 文件系统调用本身无法可靠中断。取消信号会立刻结束对外任务；仍在返回途中的
  // 读取会在下一次状态断言处丢弃结果，不能再发布索引或启动媒体子进程。
  const scanPromise = Promise.race([scanWorkPromise, scanCancellationPromise]);
  activeScan = scanPromise;

  try {
    return await scanPromise;
  } catch (error) {
    if (error.code === "SCAN_CANCELLED" || scanContext.cancelRequested) {
      lastScanError = null;
      scanContext.phase = "cancelled";
      scanContext.error = null;
      scanContext.completedAt = new Date().toISOString();
      // 把已发布但尚未到达 checkpoint 的媒体物化进索引，保证“已完成的媒体
      // 信息已保留”的语义；不让 10MB 级索引的磁盘写入阻塞停止按钮。
      if (scanPublishedMediaById) materializePublishedMedia(scanPublishedMediaById, scanLibrariesSnapshot);
      // 保存仍按既有队列完成。
      void saveState().catch((saveError) => {
        lastScanError = saveError.message || "停止扫描时保存索引失败";
        scanContext.phase = "failed";
        scanContext.error = lastScanError;
        scanContext.completedAt = new Date().toISOString();
        console.error(`停止扫描时保存索引失败：${lastScanError}`);
      });
      return appState.media;
    }
    // 失败路径同样把已发布媒体物化，与取消路径保持一致的内存状态。
    if (scanPublishedMediaById) materializePublishedMedia(scanPublishedMediaById, scanLibrariesSnapshot);
    lastScanError = error.message || "扫描失败";
    scanContext.phase = "failed";
    scanContext.progressPercent ??= 0;
    scanContext.error = lastScanError;
    scanContext.completedAt = new Date().toISOString();
    throw error;
  } finally {
    delete scanContext.increaseConcurrency;
    delete scanContext.increaseMediaToolConcurrency;
    delete scanContext.cancelActiveMediaTools;
    if (activeScan === scanPromise) activeScan = null;
    if (activeScanContext === scanContext) activeScanContext = null;
  }
}

async function updateCatalogScanSettings(body) {
  if (typeof body.enabled !== "boolean") throw new Error("自动扫描开关参数无效。");
  appState.settings.autoScanEnabled = body.enabled;
  appState.settings.autoScanIntervalSeconds = normalizedAutoScanIntervalSeconds(body.intervalSeconds);
  await saveState();
  if (body.enabled && (appState.libraries.length || appState.musicLibraries.length || appState.readingLibraries.length || appState.photoLibraries.length)) {
    queueMicrotask(() => runScheduledAutoScan(true).catch((error) => console.error(`观看端自动扫描失败：${error.message}`)));
  }
  return catalogScanStatus();
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".m4s": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg; codecs=opus",
    ".ape": "audio/x-ape",
    ".wv": "audio/wavpack",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jpe": "image/jpeg",
    ".jfif": "image/jpeg",
    ".png": "image/png",
    ".apng": "image/apng",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".dib": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml; charset=utf-8",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".ass": "text/x-ssa; charset=utf-8",
    ".ssa": "text/x-ssa; charset=utf-8",
    ".srt": "application/x-subrip; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".ttc": "font/collection",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
    ".mobi": "application/x-mobipocket-ebook",
    ".azw": "application/vnd.amazon.ebook",
    ".azw3": "application/vnd.amazon.ebook",
    ".fb2": "application/x-fictionbook+xml; charset=utf-8",
    ".cbz": "application/vnd.comicbook+zip",
    ".txt": "text/plain; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    ".csv": "text/csv; charset=utf-8",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  }[extension] || "application/octet-stream";
}

const activeVideoTransfers = new Set();

// 视频传输的空闲超时：客户端挂起连接、不读取数据时会持续占用 10 路播放
// 配额。超过该时长没有网络活动即销毁响应，释放传输槽位与文件句柄。
const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// 统一的文件流式响应：源文件读取错误时销毁响应而不是让 unhandled error
// 终止服务进程；客户端断开时主动销毁读流，避免文件句柄滞留到读完为止。
function pipeFileToResponse(response, filePath, options = {}) {
  const stream = createReadStream(filePath, options);
  stream.on("error", (error) => {
    console.error(`读取文件失败 ${filePath}: ${error.message}`);
    response.destroy();
  });
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}

async function streamFile(request, response, filePath, trackPlayback = false, responseOptions = {}) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return sendJson(response, 404, { error: "文件不存在，可能已被移动。" });
  }

  if (trackPlayback && request.method !== "HEAD") {
    if (activeVideoTransfers.size >= appState.settings.maxStreams) return sendJson(response, 503, { error: "当前已有 10 路音视频正在传输，请稍后重试。", code: "STREAM_LIMIT" });
    const transferId = randomUUID();
    activeVideoTransfers.add(transferId);
    const release = () => activeVideoTransfers.delete(transferId);
    response.once("finish", release);
    response.once("close", release);
    // 慢连接防护：socket 空闲超过阈值（客户端停止读取数据）即断开，避免
    // 挂起连接无限占满视频传输配额。
    response.setTimeout(STREAM_IDLE_TIMEOUT_MS, () => {
      if (!response.writableEnded) response.destroy();
    });
  }

  const commonHeaders = {
    "Content-Type": contentTypeFor(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": responseOptions.cacheControl || "private, max-age=0, must-revalidate",
    "Last-Modified": fileStat.mtime.toUTCString(),
    "Content-Disposition": `${responseOptions.disposition === "attachment" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(responseOptions.fileName || path.basename(filePath))}`,
  };
  const rangeHeader = request.headers.range;
  if (!rangeHeader) {
    response.writeHead(200, { ...commonHeaders, "Content-Length": fileStat.size });
    if (request.method === "HEAD") return response.end();
    return pipeFileToResponse(response, filePath);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    return response.end();
  }
  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    start = Math.max(fileStat.size - suffixLength, 0);
    end = fileStat.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? fileStat.size - 1 : Math.min(Number(match[2]), fileStat.size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= fileStat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${fileStat.size}` });
    return response.end();
  }
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
    "Content-Length": end - start + 1,
  });
  if (request.method === "HEAD") return response.end();
  pipeFileToResponse(response, filePath, { start, end });
}

function normalizeTextSubtitle(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  const replacementRatio = (utf8.match(/�/g)?.length || 0) / Math.max(utf8.length, 1);
  if (replacementRatio < 0.002) return utf8;
  try {
    return new TextDecoder("gb18030").decode(buffer);
  } catch {
    return utf8;
  }
}

// Browsers only accept WebVTT in a native <track>. SRT and WebVTT contain the
// same basic cue information, so we change only the timestamp punctuation and
// add the WebVTT header. SRT has no ASS-style font or animation data to lose.
function srtToWebVtt(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimStart();
  return `WEBVTT\n\n${normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

function mediaCompatibility(media) {
  const extension = String(media.extension || "").toUpperCase();
  const videoCodec = String(media.videoCodec || "").toLowerCase();
  const audioCodec = String(media.audioCodec || "").toLowerCase();
  const audioIsAbsent = !audioCodec;
  const mp4Family = MP4_FAMILY_EXTENSIONS.has(extension);
  const webmDirect = extension === "WEBM"
    && WEBM_VIDEO_CODECS.has(videoCodec)
    && (audioIsAbsent || WEBM_AUDIO_CODECS.has(audioCodec));
  const safeMp4Direct = mp4Family
    && videoCodec === "h264"
    && (audioIsAbsent || MP4_BROWSER_AUDIO_CODECS.has(audioCodec));
  const needsContainerChange = !mp4Family && !webmDirect;
  const needsAudioChange = !webmDirect && !audioIsAbsent && !MP4_BROWSER_AUDIO_CODECS.has(audioCodec);
  const canRemuxToMp4 = MP4_COPYABLE_VIDEO_CODECS.has(videoCodec);
  const needsCompatibleCopy = canRemuxToMp4 && (needsContainerChange || needsAudioChange);
  const issues = [];
  if (needsContainerChange) issues.push(`${extension || "未知"} 容器`);
  if (needsAudioChange) issues.push(`${audioCodec.toUpperCase()} 音频`);
  if (!["h264", "vp8", "vp9"].includes(videoCodec)) issues.push(`${videoCodec.toUpperCase() || "未知"} 视频解码`);
  return {
    directPlayLikely: safeMp4Direct || webmDirect,
    needsCompatibleCopy,
    canRemuxToMp4,
    issues,
    deviceCodecDependent: ["hevc", "av1"].includes(videoCodec),
  };
}

function mediaSourceSignature(media) {
  return createHash("sha256")
    .update(`${media.id}\0${Number(media.size) || 0}\0${media.modifiedAt || ""}`)
    .digest("hex")
    .slice(0, 12);
}

function compatibleCopyDirectory() {
  return path.resolve(appState.settings.compatibleCopyDirectory || CACHE_DIR);
}

function compatibleCopyPath(media) {
  return path.join(compatibleCopyDirectory(), `${media.id}-v${COMPATIBLE_COPY_VERSION}-${mediaSourceSignature(media)}.mp4`);
}

function legacyCompatibleCopyPath(media) {
  return path.join(compatibleCopyDirectory(), `${media.id}.mp4`);
}

function originalCacheCompatibleCopyPaths(media) {
  return [
    path.join(CACHE_DIR, `${media.id}-v${COMPATIBLE_COPY_VERSION}-${mediaSourceSignature(media)}.mp4`),
    path.join(CACHE_DIR, `${media.id}.mp4`),
  ];
}

async function compatibleCopyIsUsable(media, filePath, { requireAac = true } = {}) {
  try {
    const fileStat = await stat(filePath);
    const sourceModifiedAt = Date.parse(media.modifiedAt || "") || 0;
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.mtimeMs + 1000 < sourceModifiedAt) return false;
    const result = await runCommand(mediaTools.ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,channels",
      "-of", "json",
      filePath,
    ], 20000);
    const probe = JSON.parse(result.stdout);
    const videoStreams = (probe.streams || []).filter((stream) => stream.codec_type === "video");
    const audioStreams = (probe.streams || []).filter((stream) => stream.codec_type === "audio");
    if (videoStreams.length !== 1) return false;
    const video = videoStreams[0];
    if (media.videoCodec && String(video.codec_name || "").toLowerCase() !== String(media.videoCodec).toLowerCase()) return false;
    if (media.width && Number(video.width) !== Number(media.width)) return false;
    if (media.height && Number(video.height) !== Number(media.height)) return false;
    if (!String(probe.format?.format_name || "").toLowerCase().split(",").some((name) => ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"].includes(name))) return false;
    const sourceDuration = Number(media.durationSeconds) || 0;
    const outputDuration = Number(probe.format?.duration) || 0;
    if (sourceDuration && (!outputDuration || Math.abs(outputDuration - sourceDuration) > Math.max(2, sourceDuration * 0.01))) return false;
    if (!media.audioCodec) return audioStreams.length === 0;
    if (audioStreams.length !== 1) return false;
    const expectedAudioCodec = requireAac ? "aac" : String(media.audioCodec).toLowerCase();
    if (String(audioStreams[0].codec_name || "").toLowerCase() !== expectedAudioCodec) return false;
    if (requireAac && Number(audioStreams[0].channels) !== 2) return false;
    return true;
  } catch {
    return false;
  }
}

function remuxAccelerationStatus(now = Date.now()) {
  const storedExpiresAt = appState.settings.remuxAccelerationExpiresAt;
  const expiresAtMilliseconds = Date.parse(storedExpiresAt || "") || 0;
  const remainingMilliseconds = Math.max(0, expiresAtMilliseconds - now);
  const enabled = remainingMilliseconds > 0;
  return {
    enabled,
    expiresAt: enabled ? storedExpiresAt : null,
    remainingSeconds: Math.ceil(remainingMilliseconds / 1000),
    maxParallelJobs: enabled ? ACCELERATED_REMUX_CONCURRENCY : STANDARD_REMUX_CONCURRENCY,
    acceleratedParallelJobs: ACCELERATED_REMUX_CONCURRENCY,
    activeJobs: activeRemuxJobs,
    queuedJobs: remuxQueue.length,
  };
}

function currentRemuxConcurrency() {
  return remuxAccelerationStatus().maxParallelJobs;
}

let remuxAccelerationTimer = null;

async function expireRemuxAccelerationIfNeeded() {
  const expiresAtMilliseconds = Date.parse(appState.settings.remuxAccelerationExpiresAt || "") || 0;
  if (!expiresAtMilliseconds || expiresAtMilliseconds > Date.now()) return false;
  const previousExpiresAt = appState.settings.remuxAccelerationExpiresAt;
  appState.settings.remuxAccelerationExpiresAt = null;
  try {
    await saveState();
  } catch (error) {
    appState.settings.remuxAccelerationExpiresAt = previousExpiresAt;
    throw error;
  }
  console.log("重封装并行加速已到期，后续任务恢复单任务处理。");
  return true;
}

function scheduleRemuxAccelerationExpiry() {
  if (remuxAccelerationTimer) {
    clearTimeout(remuxAccelerationTimer);
    remuxAccelerationTimer = null;
  }
  const expiresAtMilliseconds = Date.parse(appState.settings.remuxAccelerationExpiresAt || "") || 0;
  if (!expiresAtMilliseconds) return;
  const delay = expiresAtMilliseconds - Date.now();
  if (delay <= 0) {
    queueMicrotask(() => expireRemuxAccelerationIfNeeded().catch((error) => console.error(`关闭重封装并行加速失败：${error.message}`)));
    return;
  }
  remuxAccelerationTimer = setTimeout(() => {
    remuxAccelerationTimer = null;
    expireRemuxAccelerationIfNeeded()
      .then(() => queueMicrotask(drainRemuxQueue))
      .catch((error) => console.error(`关闭重封装并行加速失败：${error.message}`));
  }, delay);
  remuxAccelerationTimer.unref();
}

async function setRemuxAcceleration(enabled) {
  const previousExpiresAt = appState.settings.remuxAccelerationExpiresAt;
  appState.settings.remuxAccelerationExpiresAt = enabled
    ? new Date(Date.now() + REMUX_ACCELERATION_DURATION_MS).toISOString()
    : null;
  try {
    await saveState();
  } catch (error) {
    appState.settings.remuxAccelerationExpiresAt = previousExpiresAt;
    throw error;
  }
  scheduleRemuxAccelerationExpiry();
  queueMicrotask(drainRemuxQueue);
  return remuxAccelerationStatus();
}

function pathsAreEqual(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function ensureWritableCompatibleCopyDirectory(directoryPath) {
  const submittedPath = String(directoryPath || "").trim();
  if (!submittedPath || !path.isAbsolute(submittedPath)) throw new Error("请输入完整的兼容视频保存路径。");
  const resolvedPath = path.resolve(submittedPath);
  if (pathsAreEqual(resolvedPath, path.parse(resolvedPath).root)) throw new Error("请使用磁盘中的具体文件夹，不要直接使用磁盘根目录。");
  await mkdir(resolvedPath, { recursive: true });
  const directoryStat = await stat(resolvedPath).catch(() => null);
  if (!directoryStat?.isDirectory()) throw new Error("兼容视频保存路径不是文件夹。");
  const probePath = path.join(resolvedPath, `.lmd-write-test-${randomUUID()}.tmp`);
  try {
    await writeFile(probePath, "LMD", { encoding: "utf8", flag: "wx" });
  } finally {
    await unlink(probePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return resolvedPath;
}

async function moveFilePreservingData(sourcePath, destinationPath) {
  if (pathsAreEqual(sourcePath, destinationPath)) return { moved: false, bytes: 0 };
  const sourceStat = await stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) return { moved: false, bytes: 0 };
  const existingDestination = await stat(destinationPath).catch(() => null);
  if (existingDestination) throw new Error(`目标文件已存在，未覆盖：${destinationPath}`);
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    const temporaryPath = `${destinationPath}.${randomUUID()}.migration.partial`;
    try {
      await copyFile(sourcePath, temporaryPath);
      const copiedStat = await stat(temporaryPath);
      if (copiedStat.size !== sourceStat.size) throw new Error(`复制后的文件大小不一致：${path.basename(sourcePath)}`);
      await rename(temporaryPath, destinationPath);
      await unlink(sourcePath);
    } finally {
      await unlink(temporaryPath).catch((cleanupError) => { if (cleanupError.code !== "ENOENT") throw cleanupError; });
    }
  }
  return { moved: true, bytes: sourceStat.size };
}

async function updateCompatibleCopyDirectory(directoryPath, moveExisting) {
  if (activeScan || musicService?.isScanning()) throw new Error("媒体目录正在扫描，请等待扫描完成后再迁移兼容副本。");
  if (appState.jobs.some((job) => job.status === "queued" || job.status === "running")) throw new Error("仍有兼容副本处理任务，请等待任务完成后再迁移。");
  if (activeVideoTransfers.size) throw new Error("当前有音视频正在传输，请停止播放后再迁移。");

  const previousDirectory = compatibleCopyDirectory();
  const nextDirectory = await ensureWritableCompatibleCopyDirectory(directoryPath);
  const sources = new Set(appState.media.map((media) => media.remuxPath).filter(Boolean).map((filePath) => path.resolve(filePath)));
  const musicSources = new Set((musicService?.compatibleFiles() || []).map((filePath) => path.resolve(filePath).toLowerCase()));
  for (const filePath of musicService?.compatibleFiles() || []) sources.add(path.resolve(filePath));
  if (pathsAreEqual(previousDirectory, CACHE_DIR)) {
    const cacheEntries = await readdir(CACHE_DIR, { withFileTypes: true });
    for (const entry of cacheEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4") && !entry.name.toLowerCase().includes(".partial")) {
        sources.add(path.join(CACHE_DIR, entry.name));
      }
    }
  }

  let movedFiles = 0;
  let movedBytes = 0;
  if (moveExisting) {
    for (const sourcePath of sources) {
      const isMusicCopy = musicSources.has(path.resolve(sourcePath).toLowerCase());
      const destinationPath = isMusicCopy
        ? path.join(nextDirectory, "audio", path.basename(sourcePath))
        : path.join(nextDirectory, path.basename(sourcePath));
      await mkdir(path.dirname(destinationPath), { recursive: true });
      const result = await moveFilePreservingData(sourcePath, destinationPath);
      if (!result.moved) continue;
      movedFiles += 1;
      movedBytes += result.bytes;
      for (const media of appState.media) {
        if (media.remuxPath && pathsAreEqual(media.remuxPath, sourcePath)) media.remuxPath = destinationPath;
      }
      if (isMusicCopy) musicService?.replaceCompatiblePath(sourcePath, destinationPath);
      await saveState();
    }
  }

  appState.settings.compatibleCopyDirectory = nextDirectory;
  await saveState();
  return { directory: nextDirectory, movedFiles, movedBytes };
}

const remuxQueue = [];
const remuxTasksByMediaId = new Map();
let activeRemuxJobs = 0;

function trimJobHistory() {
  const runningJobs = appState.jobs.filter((job) => job.status === "running");
  const queuedJobs = appState.jobs.filter((job) => job.status === "queued");
  const finishedJobs = appState.jobs.filter((job) => job.status !== "queued" && job.status !== "running").slice(0, 50);
  appState.jobs = [...runningJobs, ...queuedJobs, ...finishedJobs];
}

async function currentMediaForRemux(mediaId, sourcePath, sourceSignature) {
  const currentMedia = appState.media.find((item) => item.id === mediaId);
  if (!currentMedia || currentMedia.path !== sourcePath) return null;
  const sourceStat = await stat(currentMedia.path).catch(() => null);
  if (!sourceStat?.isFile()) return null;
  const currentSourceSignature = mediaSourceSignature({
    ...currentMedia,
    size: sourceStat.size,
    modifiedAt: sourceStat.mtime.toISOString(),
  });
  return currentSourceSignature === sourceSignature ? currentMedia : null;
}

async function runRemuxJob({ job, mediaId, convertAudioToAac }) {
  if (!mediaTools.available) {
    job.status = "failed";
    job.message = mediaTools.hint;
    await saveState();
    return;
  }
  const media = appState.media.find((item) => item.id === mediaId);
  if (!media) throw new Error("视频已不在媒体库中，任务已取消");

  const sourcePath = media.path;
  const sourceSignature = mediaSourceSignature(media);
  const outputPath = compatibleCopyPath(media);
  const outputDirectory = compatibleCopyDirectory();
  const temporaryOutputPath = path.join(outputDirectory, `${media.id}-v${COMPATIBLE_COPY_VERSION}-${sourceSignature}.${job.id}.partial.mp4`);
  await mkdir(outputDirectory, { recursive: true });
  await unlink(temporaryOutputPath).catch((error) => { if (error.code !== "ENOENT") throw error; });

  // A browser-compatible copy must expose one deterministic audio track. Mapping
  // every source track can leave multiple tracks marked as default; some browser
  // and TV decoders then mix or switch between different masters, which sounds
  // like a large echo and can appear out of sync with the picture.
  const args = [
    "-hide_banner", "-y", "-i", sourcePath,
    "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "0", "-map_chapters", "0",
    "-sn", "-dn", "-c:v", "copy",
  ];
  if (String(media.videoCodec || "").toLowerCase() === "hevc") args.push("-tag:v", "hvc1");
  if (media.audioCodec) {
    if (convertAudioToAac) {
      args.push(
        "-c:a", "aac", "-b:a", "256k", "-ac:a", "2",
        "-af:a", "aresample=async=1:first_pts=0",
      );
    } else {
      args.push("-c:a", "copy");
    }
    args.push("-disposition:a:0", "default");
  }
  args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temporaryOutputPath);

  job.status = "running";
  job.message = "正在复制视频码流";
  job.sourceSignature = sourceSignature;
  trimJobHistory();
  await saveState();

  await new Promise((resolve) => {
    const child = spawnTracked(mediaTools.ffmpeg, args, { windowsHide: true });
    let progressBuffer = "";
    let errorBuffer = "";
    let spawnError = null;
    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const [key, value] = line.split("=");
        if ((key === "out_time_ms" || key === "out_time_us") && media.durationSeconds) {
          job.progress = Math.max(0, Math.min(99, Math.round(Number(value) / 1_000_000 / media.durationSeconds * 100)));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      errorBuffer = `${errorBuffer}${chunk.toString("utf8")}`.slice(-12000);
    });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (code) => {
      let outputWasPublished = false;
      try {
        if (code !== 0) throw new Error(spawnError?.message || errorBuffer.split(/\r?\n/).filter(Boolean).slice(-2).join(" · ") || `FFmpeg 退出码 ${code}`);
        let currentMedia = await currentMediaForRemux(mediaId, sourcePath, sourceSignature);
        if (!currentMedia) throw new Error("处理期间源视频发生变化，未发布这个兼容副本");
        if (!await compatibleCopyIsUsable(currentMedia, temporaryOutputPath, { requireAac: convertAudioToAac })) {
          throw new Error("FFmpeg 没有生成有效的兼容副本");
        }
        currentMedia = await currentMediaForRemux(mediaId, sourcePath, sourceSignature);
        if (!currentMedia) throw new Error("发布前源视频或媒体目录发生变化，未发布这个兼容副本");
        await unlink(outputPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
        await rename(temporaryOutputPath, outputPath);
        outputWasPublished = true;
        currentMedia = await currentMediaForRemux(mediaId, sourcePath, sourceSignature);
        if (!currentMedia) throw new Error("发布时媒体目录发生变化，已撤销这个兼容副本");
        job.status = "completed";
        job.progress = 100;
        job.message = convertAudioToAac
          ? "兼容副本已就绪（单音轨立体声 AAC，音画同步已校正）"
          : "无损重封装副本已就绪";
        job.completedAt = new Date().toISOString();
        currentMedia.remuxPath = outputPath;
        currentMedia.remuxVersion = COMPATIBLE_COPY_VERSION;
        currentMedia.remuxSourceSignature = sourceSignature;
      } catch (error) {
        job.status = "failed";
        job.message = error.message || "兼容副本生成失败";
        await unlink(temporaryOutputPath).catch(() => {});
        if (outputWasPublished) await unlink(outputPath).catch(() => {});
      }
      await saveState().catch((error) => console.error(`保存重封装任务状态失败：${error.message}`));
      resolve();
    });
  });
}

function drainRemuxQueue() {
  if (sharingServiceIsStopping) return;
  const concurrency = currentRemuxConcurrency();
  while (activeRemuxJobs < concurrency) {
    const task = remuxQueue.shift();
    if (!task) break;
    activeRemuxJobs += 1;
    task.executionPromise = runRemuxJob(task).catch(async (error) => {
      task.job.status = "failed";
      task.job.message = error.message || "处理失败";
      await saveState().catch(() => {});
    }).finally(() => {
      activeRemuxJobs -= 1;
      remuxTasksByMediaId.delete(task.mediaId);
      trimJobHistory();
      saveState().catch(() => {});
      queueMicrotask(drainRemuxQueue);
    });
    void task.executionPromise;
  }
}

function startRemuxJob(media, convertAudioToAac = true, saveImmediately = true) {
  if (sharingServiceIsStopping) throw new Error("共享服务正在关闭，不能再加入重封装任务");
  const existingTask = remuxTasksByMediaId.get(media.id);
  if (existingTask) return existingTask.job;
  const job = {
    id: randomUUID(),
    mediaId: media.id,
    title: media.title,
    type: convertAudioToAac ? "无损重封装 + AAC" : "无损重封装",
    status: "queued",
    progress: 0,
    message: "等待开始",
    createdAt: new Date().toISOString(),
  };
  const task = { job, mediaId: media.id, convertAudioToAac };
  remuxTasksByMediaId.set(media.id, task);
  appState.jobs.unshift(job);
  trimJobHistory();
  if (saveImmediately) saveState().catch(() => {});
  remuxQueue.push(task);
  queueMicrotask(drainRemuxQueue);
  return job;
}

async function recoverCompatibleCopy(media) {
  const sourceSignature = mediaSourceSignature(media);
  const currentFile = media.remuxPath ? await stat(media.remuxPath).catch(() => null) : null;
  if (
    currentFile?.isFile()
    && currentFile.size > 0
    && media.remuxVersion === COMPATIBLE_COPY_VERSION
    && media.remuxSourceSignature === sourceSignature
  ) {
    return { ready: true, changed: false, recovered: false };
  }

  const candidates = [...new Set([
    media.remuxPath,
    compatibleCopyPath(media),
    legacyCompatibleCopyPath(media),
    ...originalCacheCompatibleCopyPaths(media),
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
  for (const candidate of candidates) {
    if (!await compatibleCopyIsUsable(media, candidate, { requireAac: true })) continue;
    const changed = media.remuxPath !== candidate
      || media.remuxVersion !== COMPATIBLE_COPY_VERSION
      || media.remuxSourceSignature !== sourceSignature;
    media.remuxPath = candidate;
    media.remuxVersion = COMPATIBLE_COPY_VERSION;
    media.remuxSourceSignature = sourceSignature;
    return { ready: true, changed, recovered: changed };
  }

  const changed = Boolean(media.remuxPath || media.remuxVersion || media.remuxSourceSignature);
  media.remuxPath = null;
  media.remuxVersion = null;
  media.remuxSourceSignature = null;
  return { ready: false, changed, recovered: false };
}

let activeCompatibleCopyCheck = null;

// 视频播放改为按需生成：扫描与启动不再排队生成长期保存的完整兼容副本。
// 这个入口保留给原有调用点，避免扫描流程出现两套分支；手动重封装
// （/api/media/prepare-compatible 与单文件重封装接口）仍然照常工作。
// 音乐模块有自己的 queueAutomaticCompatibleCopies，不受影响。
async function queueAutomaticCompatibleCopies() {
  return { queued: 0, recovered: 0, onDemand: true };
}
void activeCompatibleCopyCheck;

// 清理缓存中的孤儿文件：源文件变化后，签名命名的旧缩略图/字幕/字体/兼容
// 副本不会再被任何媒体引用，长期积累会无限占用磁盘。这里反查当前媒体库
// 仍在引用的路径，删除其余 LMD 生成的文件——只认 LMD 的命名模式（20 位
// 十六进制媒体 id 前缀），绝不触碰其他文件；进行中的重封装任务临时文件
// 也会跳过。
async function cleanOrphanedCacheFiles() {
  const livePaths = new Set();
  for (const media of appState.media) {
    if (media.thumbnailPath) livePaths.add(path.resolve(media.thumbnailPath));
    if (media.remuxPath) livePaths.add(path.resolve(media.remuxPath));
    for (const subtitle of media.subtitles || []) if (subtitle.path) livePaths.add(path.resolve(subtitle.path));
    for (const font of media.fonts || []) if (font.path) livePaths.add(path.resolve(font.path));
  }
  const activePartialFiles = new Set();
  for (const task of remuxTasksByMediaId.values()) {
    const media = appState.media.find((item) => item.id === task.mediaId);
    if (!media) continue;
    const signature = mediaSourceSignature(media);
    activePartialFiles.add(path.resolve(path.join(compatibleCopyDirectory(), `${media.id}-v${COMPATIBLE_COPY_VERSION}-${signature}.${task.job.id}.partial.mp4`)));
  }
  const lmdFilePattern = /^[0-9a-f]{20}(?:-|\.)/i;
  const directories = new Set([
    THUMBNAIL_CACHE_DIR,
    SUBTITLE_CACHE_DIR,
    FONT_CACHE_DIR,
    compatibleCopyDirectory(),
  ]);
  let removedFiles = 0;
  let removedBytes = 0;
  for (const directory of directories) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fileName = entry.name;
      if (!lmdFilePattern.test(fileName)) continue;
      const fullPath = path.resolve(directory, fileName);
      if (livePaths.has(fullPath)) continue;
      if (activePartialFiles.has(fullPath)) continue;
      try {
        const fileStat = await stat(fullPath);
        await unlink(fullPath);
        removedFiles += 1;
        removedBytes += fileStat.size;
      } catch { /* 文件可能刚刚消失或不可删除，忽略。 */ }
    }
  }
  if (removedFiles) console.log(`已清理 ${removedFiles} 个孤儿缓存文件，释放约 ${(removedBytes / 1024 / 1024).toFixed(1)} MB。`);
  return { removedFiles, removedBytes };
}

function folderPathForMedia(media) {
  return path.dirname(media.path);
}

function catalogFolderId(libraryId, folderPath) {
  return stableId(`catalog-folder\0${libraryId || "unknown-library"}\0${path.resolve(folderPath)}`);
}

// 一次请求内共享的展示索引：把“每个媒体都全量过滤+排序”的 O(n²) 计算降为
// 单次分组 + 每组一次排序。folders 按小写路径映射到 { folderPath, items }，
// groups 按小写路径映射到作品组，供 displayGroupForFolder 等做 O(1) 查找。
function createDisplayIndex(mediaItems = appState.media) {
  const folders = new Map();
  for (const item of mediaItems) {
    const folderPath = folderPathForMedia(item);
    const key = path.resolve(folderPath).toLowerCase();
    let bucket = folders.get(key);
    if (!bucket) {
      bucket = { folderPath, items: [] };
      folders.set(key, bucket);
    }
    bucket.items.push(item);
  }
  for (const bucket of folders.values()) {
    bucket.items.sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" }));
    Object.assign(bucket, folderSelectionMetadata(bucket.folderPath, bucket.items));
  }
  const groups = new Map(appState.displayGroups.map((group) => [path.resolve(group.path).toLowerCase(), group]));
  return { folders, groups };
}

function folderSelectionMetadata(folderPath, folderItems) {
  const episodeNumberByMediaId = new Map();
  for (const item of folderItems) episodeNumberByMediaId.set(item.id, detectedEpisodeNumber(item.fileName));
  const resolvedSelections = quickSelectionsForFolder(folderPath, folderItems.map((item) => item.fileName));
  const quickSelectionByMediaId = new Map(folderItems.map((item, index) => [item.id, resolvedSelections[index] || null]));
  return { episodeNumberByMediaId, quickSelectionByMediaId };
}

function displayGroupForFolder(folderPath, displayIndex = null) {
  const normalized = path.resolve(folderPath).toLowerCase();
  if (displayIndex) return displayIndex.groups.get(normalized) || null;
  return appState.displayGroups.find((group) => path.resolve(group.path).toLowerCase() === normalized) || null;
}

function inferSeasonNumber(folderPath, mediaItems) {
  for (const item of mediaItems) {
    const match = path.basename(item.fileName, path.extname(item.fileName)).match(/(?:^|[^a-z0-9])s(\d{1,2})e\d{1,4}(?:[^a-z0-9]|$)/i);
    if (match) return Number(match[1]);
  }
  const folderName = path.basename(folderPath);
  const latin = folderName.match(/(?:^|[^a-z0-9])(?:s|season)[ ._-]?(\d{1,2})(?:[^a-z0-9]|$)/i);
  if (latin) return Number(latin[1]);
  const chinese = folderName.match(/第\s*(\d{1,2})\s*季/);
  return chinese ? Number(chinese[1]) : 1;
}

function sortedFolderMedia(folderPath, displayIndex = null) {
  const normalized = path.resolve(folderPath).toLowerCase();
  if (displayIndex) return displayIndex.folders.get(normalized)?.items || [];
  return appState.media
    .filter((item) => path.resolve(folderPathForMedia(item)).toLowerCase() === normalized)
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function mediaDisplayInfo(media, displayIndex = null) {
  const folderPath = folderPathForMedia(media);
  const group = displayGroupForFolder(folderPath, displayIndex);
  const folderItems = sortedFolderMedia(folderPath, displayIndex);
  const season = Number(group?.season) || inferSeasonNumber(folderPath, folderItems);
  const normalizedFolderPath = path.resolve(folderPath).toLowerCase();
  const folderBucket = displayIndex?.folders.get(normalizedFolderPath);
  const selectionMetadata = folderBucket || folderSelectionMetadata(folderPath, folderItems);
  const detectedEpisode = selectionMetadata.episodeNumberByMediaId.get(media.id) ?? null;
  const quickSelection = selectionMetadata.quickSelectionByMediaId.get(media.id) || null;
  const episode = detectedEpisode ?? folderItems.findIndex((item) => item.id === media.id) + 1;
  const labels = labelService.media(media);
  const seriesTitle = labels.title || labels.originalTitle || path.basename(folderPath);
  return {
    groupId: stableId(folderPath),
    ...labels,
    seriesTitle,
    season,
    episode,
    quickSelection,
    alias: `${seriesTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    configured: Boolean(labels.title || labels.originalTitle),
  };
}

function displayFolderSummaries(displayIndex = null) {
  const index = displayIndex || createDisplayIndex();
  const allFolders = new Map(index.folders);
  for (const item of appState.media) {
    const root = path.resolve(videoLibraryForMedia(item)?.path || folderPathForMedia(item));
    let current = path.resolve(folderPathForMedia(item));
    while (pathIsSameOrDescendant(current, root)) {
      if (!allFolders.has(current.toLowerCase())) allFolders.set(current.toLowerCase(), { folderPath: current, items: appState.media.filter(m => pathIsSameOrDescendant(folderPathForMedia(m), current)) });
      if (current === root) break;
      current = path.dirname(current);
    }
  }
  return [...allFolders.values()].map(({ folderPath, items }) => {
    const group = displayGroupForFolder(folderPath, index);
    const folderName = path.basename(folderPath);
    const season = Number(group?.season) || inferSeasonNumber(folderPath, items);
    const labels = labelService.folder(folderPath);
    const title = labels?.title || labels?.originalTitle || folderName;
    const firstDisplay = items[0] ? mediaDisplayInfo(items[0], index) : null;
    return {
      id: stableId(folderPath),
      path: folderPath,
      folderName,
      title,
      ...labels,
      customTitle: labelService.own(folderPath)?.title || "",
      season,
      configured: Boolean(labels?.title || labels?.originalTitle),
      mediaCount: items.length,
      sampleAlias: firstDisplay?.alias || "",
    };
  }).sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
}

const ACCESS_FOLDER_MAX_RELATIVE_DEPTH = 2;

function boundedAccessFolderPath(rootPath, mediaFolderPath) {
  const root = path.resolve(rootPath || mediaFolderPath);
  const folder = path.resolve(mediaFolderPath);
  if (!pathIsSameOrDescendant(folder, root)) return folder;
  const segments = path.relative(root, folder).split(path.sep).filter(Boolean);
  return segments.length ? path.join(root, ...segments.slice(0, ACCESS_FOLDER_MAX_RELATIVE_DEPTH)) : root;
}

function videoLibraryForMedia(media) {
  return appState.libraries.find((library) => library.id === media.libraryId) || null;
}

function videoAccessFolderPath(media) {
  const mediaFolderPath = folderPathForMedia(media);
  return boundedAccessFolderPath(videoLibraryForMedia(media)?.path || mediaFolderPath, mediaFolderPath);
}

function videoAccessFolderId(media) {
  return stableId(videoAccessFolderPath(media));
}

function videoAccessFolderSummaries() {
  const folders = new Map();
  for (const media of appState.media) {
    const library = videoLibraryForMedia(media);
    const folderPath = videoAccessFolderPath(media);
    const id = stableId(folderPath);
    const relativePath = library?.path && pathIsSameOrDescendant(folderPath, library.path)
      ? path.relative(path.resolve(library.path), folderPath).split(path.sep).filter(Boolean).join(" / ")
      : path.basename(folderPath);
    let folder = folders.get(id);
    if (!folder) {
      const title = relativePath || `${library?.name || path.basename(folderPath) || "视频目录"}（直属文件）`;
      folder = {
        id,
        path: folderPath,
        folderName: relativePath ? path.basename(folderPath) : title,
        title,
        customTitle: "",
        sampleAlias: "",
        season: 1,
        configured: false,
        mediaCount: 0,
        kind: "video",
        libraryName: library?.name || "视频目录",
        relativePath: relativePath || "直属文件",
      };
      folders.set(id, folder);
    }
    folder.mediaCount += 1;
  }
  return [...folders.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function videoAccessFolderAliases() {
  return appState.media.map((media) => [stableId(folderPathForMedia(media)), videoAccessFolderId(media)]);
}

function catalogFolderNodes(mediaItems, displayIndex = null) {
  const librariesById = new Map(appState.libraries.map((library) => [library.id, library]));
  const nodes = new Map();
  const sortedMedia = [...mediaItems].sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true, sensitivity: "base" }));

  for (const media of sortedMedia) {
    const mediaFolderPath = path.resolve(folderPathForMedia(media));
    const library = librariesById.get(media.libraryId);
    const configuredRootPath = library?.path ? path.resolve(library.path) : mediaFolderPath;
    const relativeFolderPath = path.relative(configuredRootPath, mediaFolderPath);
    const mediaIsInsideLibrary = pathIsSameOrDescendant(mediaFolderPath, configuredRootPath);
    const rootPath = mediaIsInsideLibrary ? configuredRootPath : mediaFolderPath;
    const relativeSegments = mediaIsInsideLibrary && relativeFolderPath
      ? relativeFolderPath.split(path.sep).filter(Boolean)
      : [];
    const libraryId = library?.id || media.libraryId || stableId(rootPath);
    const folderPaths = [rootPath];
    for (const segment of relativeSegments) folderPaths.push(path.join(folderPaths.at(-1), segment));

    let parentId = null;
    for (const [index, folderPath] of folderPaths.entries()) {
      const id = catalogFolderId(libraryId, folderPath);
      let node = nodes.get(id);
      if (!node) {
        const folderName = path.basename(folderPath) || library?.name || "视频目录";
        const group = labelService.folder(folderPath);
        node = {
          id,
          parentId,
          name: folderName,
          title: group?.title?.trim() || group?.originalTitle || (index === 0 ? library?.name?.trim() : "") || folderName,
          originalTitle: group?.originalTitle || "",
          configured: Boolean(group?.title || group?.originalTitle),
          directMediaCount: 0,
          mediaCount: 0,
          childCount: 0,
          coverMediaId: media.id,
        };
        nodes.set(id, node);
      }
      node.mediaCount += 1;
      if (index === folderPaths.length - 1) node.directMediaCount += 1;
      parentId = id;
    }
  }

  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).childCount += 1;
  }

  return [...nodes.values()].sort((left, right) => {
    const parentOrder = (left.parentId || "").localeCompare(right.parentId || "");
    return parentOrder || left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

function accessFolderInventory() {
  const folders = [
    ...videoAccessFolderSummaries(),
    ...(musicService?.accessFolderSummaries() || []),
    ...(readingService?.accessFolderSummaries() || []),
    ...(photoService?.accessFolderSummaries() || []),
  ];
  const availableIds = new Set(folders.map((folder) => folder.id));
  const aliases = new Map([...availableIds].map((id) => [id, new Set([id])]));
  const registerAliases = (pairs) => {
    for (const [sourceId, targetId] of pairs || []) {
      if (!availableIds.has(targetId)) continue;
      if (!aliases.has(sourceId)) aliases.set(sourceId, new Set());
      aliases.get(sourceId).add(targetId);
    }
  };
  registerAliases(videoAccessFolderAliases());
  registerAliases(musicService?.accessFolderAliases());
  registerAliases(readingService?.accessFolderAliases());
  registerAliases(photoService?.accessFolderAliases());
  return { folders, availableIds, aliases };
}

function resolveAccessFolderIds(folderIds, inventory = accessFolderInventory()) {
  const resolved = new Set();
  for (const rawId of Array.isArray(folderIds) ? folderIds.map(String) : []) {
    for (const folderId of inventory.aliases.get(rawId) || []) resolved.add(folderId);
  }
  return [...resolved].filter((id) => inventory.availableIds.has(id));
}

function accessCategoryFolderAssignments() {
  const inventory = accessFolderInventory();
  const claimed = new Set();
  const categories = appState.accessControl.categories.map((category) => {
    const folderIds = resolveAccessFolderIds(category.folderIds, inventory).filter((id) => !claimed.has(id));
    for (const id of folderIds) claimed.add(id);
    return { category, folderIds };
  });
  return { inventory, categories, claimed };
}

function accessFolderIdsForUser(user) {
  const categoryIds = new Set(Array.isArray(user?.categoryIds) ? user.categoryIds.map(String) : []);
  const { inventory, categories, claimed } = accessCategoryFolderAssignments();
  const allowed = new Set(resolveAccessFolderIds(user?.folderIds, inventory));
  for (const { category, folderIds } of categories) {
    if (categoryIds.has(category.id)) for (const folderId of folderIds) allowed.add(folderId);
  }
  if (categoryIds.has(UNCATEGORIZED_ACCESS_CATEGORY_ID)) {
    for (const folderId of inventory.availableIds) if (!claimed.has(folderId)) allowed.add(folderId);
  }
  return allowed;
}

function canonicalizeAccessCategoryFolders() {
  const { categories } = accessCategoryFolderAssignments();
  for (const { category, folderIds } of categories) category.folderIds = folderIds;
}

function validAccessCategoryIds(categoryIds) {
  const availableIds = new Set([
    UNCATEGORIZED_ACCESS_CATEGORY_ID,
    ...appState.accessControl.categories.map((category) => category.id),
  ]);
  return [...new Set(Array.isArray(categoryIds) ? categoryIds.map(String) : [])].filter((id) => availableIds.has(id));
}

function uncategorizedAccessFolderIds() {
  const { inventory, claimed } = accessCategoryFolderAssignments();
  return [...inventory.availableIds].filter((id) => !claimed.has(id));
}

function accessControlOverview() {
  const now = Date.now();
  const { categories } = accessCategoryFolderAssignments();
  return {
    enabled: appState.accessControl.enabled,
    users: appState.accessControl.users.map(publicAccessUser),
    categories: [
      {
        id: UNCATEGORIZED_ACCESS_CATEGORY_ID,
        name: UNCATEGORIZED_ACCESS_CATEGORY_NAME,
        folderIds: uncategorizedAccessFolderIds(),
        createdAt: "",
        updatedAt: "",
        system: true,
      },
      ...categories.map(({ category, folderIds }) => ({
        id: category.id,
        name: category.name,
        folderIds,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
        system: false,
      })),
    ],
    activeSessions: appState.accessControl.sessions.filter((session) => Date.parse(session.expiresAt || "") > now).length,
  };
}

function publicMedia(item, includeLocalPath = false, displayIndex = null) {
  const compatibility = mediaCompatibility(item);
  const latestJob = appState.jobs.find((job) => job.mediaId === item.id);
  const activeJob = latestJob && (latestJob.status === "queued" || latestJob.status === "running") ? latestJob : null;
  const compatibleCopyStatus = activeJob?.status || (item.remuxPath
    ? "ready"
    : latestJob?.status || (compatibility.needsCompatibleCopy ? "waiting" : "not-needed"));
  return {
    ...item,
    path: includeLocalPath ? item.path : undefined,
    danmakuBindings: undefined,
    remuxPath: includeLocalPath ? item.remuxPath : undefined,
    thumbnailPath: includeLocalPath ? item.thumbnailPath : undefined,
    probeError: includeLocalPath ? item.probeError : undefined,
    embeddedSubtitleStreams: undefined,
    embeddedFontStreams: undefined,
    streamUrl: `/api/media/${item.id}/stream`,
    remuxUrl: item.remuxPath ? `/api/media/${item.id}/stream?variant=remux` : null,
    thumbnailUrl: item.thumbnailPath ? `/api/media/${item.id}/thumbnail` : null,
    display: { ...mediaDisplayInfo(item, displayIndex), folderId: catalogFolderId(item.libraryId, folderPathForMedia(item)) },
    compatibility,
    compatibleCopyStatus,
    compatibleCopyProgress: activeJob?.progress ?? (item.remuxPath ? 100 : latestJob?.progress || 0),
    subtitles: item.subtitles.map((subtitle) => ({ ...subtitle, path: undefined, url: `/api/media/${item.id}/subtitles/${subtitle.id}` })),
    fonts: item.fonts.map((font) => ({ ...font, path: undefined, url: `/api/media/${item.id}/fonts/${font.id}` })),
  };
}

async function serveStatic(response, pathname) {
  let requestedPath = pathname === "/" ? "/index.html" : pathname;
  let filePath = path.resolve(WEB_DIR, `.${requestedPath}`);
  // 用“同目录或子孙目录”判断替代字符串前缀：前缀匹配会把 dist 的兄弟目录
  // （如 dist-evil）误判为站内路径。
  if (!pathIsSameOrDescendant(filePath, WEB_DIR)) return false;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return false;
  } catch {
    filePath = path.join(WEB_DIR, "index.html");
    try { await access(filePath); } catch { return false; }
  }
  const fileStat = await stat(filePath);
  response.writeHead(200, { "Content-Type": contentTypeFor(filePath), "Content-Length": fileStat.size });
  pipeFileToResponse(response, filePath);
  return true;
}

const playbackService = createPlaybackService({
  appState, cacheDirectory: CACHE_DIR, getMediaTools: () => mediaTools, probeVideo,
  saveState, spawnTracked, runCommand, authorizedMediaForRequest, accessContextForRequest,
  requireLocalManagement, readJson, sendJson, streamFile,
});
const danmakuService = createDanmakuService({ dataDirectory: DATA_DIR, appState, saveState,
  playbackInfo: playbackService.info, authorizedMediaForRequest, accessContextForRequest,
  requireLocalManagement, readJson, sendJson });
// Real-browser playback acceptance harness. It stays inert unless the operator
// starts the service with LMD_PLAYER_TEST=1.
const playerTestService = createPlayerTestService({ dataDirectory: DATA_DIR, appState,
  enabled: process.env.LMD_PLAYER_TEST === "1", readJson, sendJson, requireLocalManagement });
// Bitmap (PGS/VobSub/DVB) subtitles are decoded on demand through the media
// tools; nothing is burned into the video.
const bitmapSubtitleService = createBitmapSubtitleService({ cacheDirectory: CACHE_DIR,
  getMediaTools: () => mediaTools, runCommand, requireLocalManagement });

musicService = createMusicService({
  appState,
  cacheDirectory: CACHE_DIR,
  saveState,
  stableId,
  getMediaTools: () => mediaTools,
  getCompatibleCopyDirectory: compatibleCopyDirectory,
  runCommand,
  streamFile,
  sendJson,
  readJson,
  requireLocalManagement,
  requireViewerAccess,
  canAccessFolderId,
  pathIsSameOrDescendant,
});

readingService = createReadingService({
  appState,
  cacheDirectory: CACHE_DIR,
  saveState,
  stableId,
  streamFile,
  sendJson,
  readJson,
  requireLocalManagement,
  requireViewerAccess,
  canAccessFolderId,
  pathIsSameOrDescendant,
});

photoService = createPhotoService({
  appState,
  cacheDirectory: CACHE_DIR,
  saveState,
  stableId,
  getMediaTools: () => mediaTools,
  runCommand,
  streamFile,
  sendJson,
  readJson,
  requireLocalManagement,
  requireViewerAccess,
  canAccessFolderId,
  pathIsSameOrDescendant,
});

const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return response.end();
  }

  // 畸形 URL 编码或 Host 头会让 new URL / decodeURIComponent 抛异常。这里在
  // 主 try 之外单独兜底：直接返回 400，而不是让未捕获异常终止整个服务进程。
  let url;
  let pathname;
  try {
    url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(response, 400, { error: "请求地址无效。" });
  }

  try {
    if (!sameOriginMutation(request)) return sendJson(response, 403, { error: "已拒绝跨站操作。", code: "ORIGIN_REJECTED" });
    if (await playerTestService.handleRequest(request, response, url, pathname)) return;
    if (await playbackService.handleRequest(request, response, url, pathname)) return;
    if (await danmakuService.handleRequest(request, response, url, pathname)) return;
    if (await musicService.handleRequest(request, response, url, pathname)) return;
    if (await readingService.handleRequest(request, response, url, pathname)) return;
    if (await photoService.handleRequest(request, response, url, pathname)) return;
    if (pathname.startsWith("/api/labels/")) {
      if (!requireLocalManagement(request, response)) return;
      try {
        const action = pathname.slice("/api/labels/".length);
        if (request.method === "GET" && action === "status") return sendJson(response, 200, labelService.status());
        if (request.method === "GET" && action === "targets") return sendJson(response, 200, labelService.targets());
        if (request.method === "POST" && ["claim", "validate", "apply", "release"].includes(action)) return sendJson(response, 200, await labelService[action](await readJson(request)));
        if (request.method === "PATCH") return sendJson(response, 200, await labelService.manual(action, await readJson(request)));
        return sendJson(response, 404, { error: "未知打标操作" });
      } catch (error) { return sendJson(response, 400, { error: error.message }); }
    }
    if (request.method === "POST" && pathname === "/api/service/stop") {
      if (!requireLocalManagement(request, response)) return;
      sendJson(response, 202, { ok: true, message: "共享服务正在关闭，系统托盘会继续运行。" });
      setTimeout(() => stopSharingService().catch((error) => console.error(`关闭共享服务失败：${error.message}`)), 30);
      return;
    }
    if (request.method === "GET" && pathname === "/api/health") {
      if (appState.accessControl.enabled && !isLanRequest(request)) return sendJson(response, 403, { error: "访问控制已开启，只允许局域网设备连接。", code: "LAN_ONLY" });
      return sendJson(response, 200, { ok: true, name: "LMD", sharingService: "running", port: PORT, lanAddresses: getLanAddresses(), tools: mediaTools, playback: playbackService.status() });
    }
    if ((pathname === "/admin" || pathname.startsWith("/admin/")) && !requireLocalManagement(request, response)) return;
    if (request.method === "GET" && pathname === "/api/auth/status") {
      if (!appState.accessControl.enabled) {
        return sendJson(response, 200, { enabled: false, authenticated: true, localAdmin: isLoopbackRequest(request), user: null });
      }
      if (!isLanRequest(request)) return sendJson(response, 403, { error: "访问控制已开启，只允许局域网设备连接。", code: "LAN_ONLY" });
      const context = accessContextForRequest(request);
      return sendJson(response, 200, {
        enabled: true,
        authenticated: Boolean(context),
        localAdmin: Boolean(context?.localAdmin),
        user: context?.user ? { id: context.user.id } : null,
      });
    }
    if (request.method === "POST" && pathname === "/api/auth/login") {
      if (!appState.accessControl.enabled) return sendJson(response, 409, { error: "访问控制当前未开启，无需登录。", code: "ACCESS_CONTROL_DISABLED" });
      if (!isLanRequest(request) || isLoopbackRequest(request)) return sendJson(response, 403, { error: "访问登录只对局域网观看设备开放。", code: "LAN_ONLY" });
      const body = await readJson(request);
      const accessCode = String(body.accessCode || "").trim();
      if (!ACCESS_CODE_PATTERN.test(accessCode)) return sendJson(response, 400, { error: "访问码必须是六位数字。" });
      const failureKey = loginFailureKey(request);
      const accessCodeKey = stableId(accessCode);
      // 全局防爆破锁：窗口内失败总数超限时，所有登录尝试一律拒绝。
      const globalThrottle = currentGlobalLoginThrottle();
      if (globalThrottle.lockedUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((globalThrottle.lockedUntil - Date.now()) / 1000));
        response.setHeader("Retry-After", retryAfterSeconds);
        return sendJson(response, 429, { error: "登录尝试过于频繁，请稍后再试。", code: "LOGIN_RATE_LIMITED" });
      }
      // 访问码级锁：针对单个访问码的集中尝试（换 IP 也无法绕过）。
      const accessCodeThrottle = currentAccessCodeThrottle(accessCodeKey);
      if (accessCodeThrottle?.lockedUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((accessCodeThrottle.lockedUntil - Date.now()) / 1000));
        response.setHeader("Retry-After", retryAfterSeconds);
        return sendJson(response, 429, { error: `尝试次数过多，请在 ${Math.ceil(retryAfterSeconds / 60)} 分钟后重试。`, code: "LOGIN_RATE_LIMITED" });
      }
      const throttle = currentLoginThrottle(failureKey);
      if (throttle?.lockedUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((throttle.lockedUntil - Date.now()) / 1000));
        response.setHeader("Retry-After", retryAfterSeconds);
        return sendJson(response, 429, { error: `尝试次数过多，请在 ${Math.ceil(retryAfterSeconds / 60)} 分钟后重试。`, code: "LOGIN_RATE_LIMITED" });
      }
      const user = await userForAccessCode(accessCode);
      if (!user) {
        const failure = recordLoginFailure(failureKey);
        const accessCodeFailure = recordAccessCodeLoginFailure(accessCodeKey);
        const globalFailure = recordGlobalLoginFailure();
        const locked = failure.lockedUntil > Date.now() || accessCodeFailure.lockedUntil > Date.now() || globalFailure.lockedUntil > Date.now();
        const message = locked ? "尝试次数过多，请稍后重试。" : "访问码不正确。";
        return sendJson(response, locked ? 429 : 401, { error: message, code: locked ? "LOGIN_RATE_LIMITED" : "INVALID_CREDENTIALS" });
      }
      loginFailures.delete(failureKey);
      accessCodeLoginFailures.delete(accessCodeKey);
      const token = randomBytes(32).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ACCESS_SESSION_TTL_SECONDS * 1000).toISOString();
      const liveSessions = appState.accessControl.sessions.filter((session) => Date.parse(session.expiresAt || "") > now.getTime());
      const otherUserSessions = liveSessions.filter((session) => session.userId !== user.id);
      const recentUserSessions = liveSessions
        .filter((session) => session.userId === user.id)
        .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))
        .slice(0, 4);
      appState.accessControl.sessions = otherUserSessions
        .concat(recentUserSessions)
        .concat({ id: randomUUID(), userId: user.id, tokenHash: accessSessionDigest(token), createdAt: now.toISOString(), expiresAt });
      user.lastLoginAt = now.toISOString();
      await saveState();
      response.setHeader("Set-Cookie", accessSessionCookie(token));
      return sendJson(response, 200, { enabled: true, authenticated: true, localAdmin: false, user: { id: user.id } });
    }
    if (request.method === "POST" && pathname === "/api/auth/logout") {
      const token = parseCookies(request)[ACCESS_SESSION_COOKIE];
      if (token) {
        const digest = accessSessionDigest(token);
        appState.accessControl.sessions = appState.accessControl.sessions.filter((session) => session.tokenHash !== digest);
        await saveState();
      }
      response.setHeader("Set-Cookie", accessSessionCookie("", 0));
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && pathname === "/api/catalog") {
      const context = requireViewerAccess(request, response);
      if (!context) return;
      const media = accessibleMedia(context);
      const displayIndex = createDisplayIndex(media);
      const visibleFolderIds = new Set(media.map((item) => stableId(folderPathForMedia(item))));
      return sendJson(response, 200, {
        media: media.map((item) => publicMedia(item, false, displayIndex)),
        folders: catalogFolderNodes(media, displayIndex),
        groups: displayFolderSummaries(displayIndex)
          .filter((group) => visibleFolderIds.has(group.id))
          .map(({ path: _path, customTitle: _customTitle, sampleAlias: _sampleAlias, ...group }) => group),
        scan: catalogScanStatus(),
      });
    }
    if (request.method === "POST" && pathname === "/api/catalog/scan") {
      const context = requireViewerAccess(request, response);
      if (!context) return;
      await scanLibraries();
      return sendJson(response, 200, { count: accessibleMedia(context).length, scan: catalogScanStatus() });
    }
    if (request.method === "GET" && pathname === "/api/scan/status") {
      if (!requireLocalManagement(request, response)) return;
      await expireRemuxAccelerationIfNeeded();
      return sendJson(response, 200, {
        scanning: Boolean(activeScan),
        scan: catalogScanStatus(),
        jobs: appState.jobs,
        remuxAcceleration: remuxAccelerationStatus(),
      });
    }
    if (request.method === "GET" && pathname === "/api/overview") {
      if (!requireLocalManagement(request, response)) return;
      await expireRemuxAccelerationIfNeeded();
      const compact = url.searchParams.get("compact") === "1";
      const displayIndex = createDisplayIndex();
      return sendJson(response, 200, {
        libraries: appState.libraries,
        media: compact ? [] : appState.media.map((item) => publicMedia(item, true, displayIndex)),
        displayFolders: [...displayFolderSummaries(displayIndex), ...musicService.displayFolderSummaries(), ...readingService.displayFolderSummaries(), ...photoService.displayFolderSummaries()],
        accessFolders: accessFolderInventory().folders,
        jobs: appState.jobs,
        settings: appState.settings,
        tools: mediaTools,
        scanning: Boolean(activeScan),
        scan: catalogScanStatus(),
        activeVideoTransfers: activeVideoTransfers.size,
        lanAddresses: getLanAddresses(),
        autostart: await getAutostartStatus(),
        accessControl: accessControlOverview(),
        remuxAcceleration: remuxAccelerationStatus(),
      });
    }
    if (request.method === "POST" && pathname === "/api/tools/refresh") {
      if (!requireLocalManagement(request, response)) return;
      mediaTools = await findMediaTools();
      return sendJson(response, 200, mediaTools);
    }
    if (request.method === "POST" && pathname === "/api/tools/install") {
      if (!requireLocalManagement(request, response)) return;
      if (FFMPEG_INSTALL_ACTIVE_STATUSES.has(mediaToolsInstall.status)) {
        return sendJson(response, 409, { error: "FFmpeg 安装正在进行中，请等待完成或先取消当前安装。" });
      }
      if (activeScan || pendingScanMode || remuxTasksByMediaId.size > 0) {
        return sendJson(response, 409, { error: "当前有扫描或重封装任务正在运行，请等待任务结束后再安装或更新 FFmpeg。" });
      }
      const body = await readJson(request);
      const force = Boolean(body.force);
      let latestVersion = null;
      try { latestVersion = await latestFfmpegReleaseVersion(); } catch { /* 版本检查失败时仍允许直接安装最新版 */ }
      if (!force && mediaTools.available && latestVersion && mediaTools.installedVersion && compareVersions(mediaTools.installedVersion, latestVersion) >= 0) {
        return sendJson(response, 200, { ok: true, alreadyLatest: true, installedVersion: mediaTools.installedVersion, latestVersion });
      }
      mediaToolsInstall.status = "downloading";
      mediaToolsInstall.progress = 0;
      mediaToolsInstall.message = "正在准备下载 FFmpeg…";
      mediaToolsInstall.error = "";
      mediaToolsInstall.version = null;
      mediaToolsInstall.installedVersion = null;
      mediaToolsInstall.latestVersion = latestVersion;
      mediaToolsInstall.bytesDownloaded = 0;
      mediaToolsInstall.bytesTotal = 0;
      mediaToolsInstall.startedAt = new Date().toISOString();
      mediaToolsInstall.finishedAt = null;
      mediaToolsInstall.cancelRequested = false;
      mediaToolsInstall.runningPromise = installMediaTools();
      return sendJson(response, 200, { ok: true, started: true, latestVersion });
    }
    if (request.method === "GET" && pathname === "/api/tools/install/status") {
      if (!requireLocalManagement(request, response)) return;
      return sendJson(response, 200, {
        status: mediaToolsInstall.status,
        progress: mediaToolsInstall.progress,
        message: mediaToolsInstall.message,
        error: mediaToolsInstall.error,
        version: mediaToolsInstall.version,
        installedVersion: mediaToolsInstall.installedVersion || (mediaTools.available ? mediaTools.installedVersion : null),
        latestVersion: mediaToolsInstall.latestVersion,
        bytesDownloaded: mediaToolsInstall.bytesDownloaded,
        bytesTotal: mediaToolsInstall.bytesTotal,
        startedAt: mediaToolsInstall.startedAt,
        finishedAt: mediaToolsInstall.finishedAt,
      });
    }
    if (request.method === "POST" && pathname === "/api/tools/install/cancel") {
      if (!requireLocalManagement(request, response)) return;
      if (!FFMPEG_INSTALL_ACTIVE_STATUSES.has(mediaToolsInstall.status)) {
        return sendJson(response, 200, { ok: true, cancelled: false });
      }
      mediaToolsInstall.cancelRequested = true;
      mediaToolsInstall.activeRequest?.destroy();
      mediaToolsInstall.activeChild?.kill();
      return sendJson(response, 200, { ok: true, cancelled: true });
    }
    if (request.method === "POST" && pathname === "/api/folders/select") {
      if (!requireLocalManagement(request, response)) return;
      if (activeFolderPicker) return sendJson(response, 409, { error: "文件夹选择窗口已经打开，请先完成当前选择。" });
      activeFolderPicker = selectFolderWithWindowsDialog();
      let selectedPath;
      try { selectedPath = await activeFolderPicker; }
      finally { activeFolderPicker = null; }
      if (!selectedPath) return sendJson(response, 200, { cancelled: true, path: null });
      const folderStat = await stat(selectedPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "选择的文件夹已经不存在，或当前程序没有读取权限。" });
      return sendJson(response, 200, { cancelled: false, path: path.resolve(selectedPath) });
    }
    if (request.method === "POST" && pathname === "/api/autostart") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      return sendJson(response, 200, await setAutostart(Boolean(body.enabled)));
    }
    if (request.method === "PATCH" && pathname === "/api/access-control") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "请提供有效的访问控制开关状态。" });
      appState.accessControl.enabled = body.enabled;
      await saveState();
      return sendJson(response, 200, accessControlOverview());
    }
    if (request.method === "POST" && pathname === "/api/access-control/categories") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      const name = normalizeAccessCategoryName(body.name);
      if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return sendJson(response, 400, { error: "分类名称需为 1 到 40 个可见字符。" });
      if (name.toLocaleLowerCase("zh-CN") === UNCATEGORIZED_ACCESS_CATEGORY_NAME.toLocaleLowerCase("zh-CN")) {
        return sendJson(response, 409, { error: "“未分类”是自动收纳未归类文件夹的系统分类，无需重复建立。" });
      }
      if (appState.accessControl.categories.some((category) => normalizeAccessCategoryName(category.name).toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
        return sendJson(response, 409, { error: "这个分类已经存在。" });
      }
      const now = new Date().toISOString();
      const category = { id: randomUUID(), name, folderIds: [], createdAt: now, updatedAt: now };
      appState.accessControl.categories.push(category);
      await saveState();
      return sendJson(response, 201, category);
    }
    if (request.method === "PATCH" && /^\/api\/access-control\/categories\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const categoryId = pathname.split("/").pop();
      const category = appState.accessControl.categories.find((item) => item.id === categoryId);
      if (!category) return sendJson(response, 404, { error: "找不到这个文件夹分类。" });
      const body = await readJson(request);
      const name = normalizeAccessCategoryName(body.name);
      if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return sendJson(response, 400, { error: "分类名称需为 1 到 40 个可见字符。" });
      if (name.toLocaleLowerCase("zh-CN") === UNCATEGORIZED_ACCESS_CATEGORY_NAME.toLocaleLowerCase("zh-CN")) {
        return sendJson(response, 409, { error: "“未分类”是系统分类，请使用其他分类名称。" });
      }
      if (appState.accessControl.categories.some((item) => item.id !== category.id && normalizeAccessCategoryName(item.name).toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
        return sendJson(response, 409, { error: "这个分类已经存在。" });
      }
      category.name = name;
      category.updatedAt = new Date().toISOString();
      await saveState();
      return sendJson(response, 200, category);
    }
    if (request.method === "DELETE" && /^\/api\/access-control\/categories\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const categoryId = pathname.split("/").pop();
      if (!appState.accessControl.categories.some((category) => category.id === categoryId)) return sendJson(response, 404, { error: "找不到这个文件夹分类。" });
      appState.accessControl.categories = appState.accessControl.categories.filter((category) => category.id !== categoryId);
      for (const user of appState.accessControl.users) user.categoryIds = (user.categoryIds || []).filter((id) => id !== categoryId);
      await saveState();
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "PATCH" && /^\/api\/access-control\/folders\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const folderId = pathname.split("/").pop();
      const accessFolders = accessFolderInventory().folders;
      if (!accessFolders.some((folder) => folder.id === folderId)) return sendJson(response, 404, { error: "找不到这个媒体文件夹，请先重新扫描。" });
      const body = await readJson(request);
      const categoryId = body.categoryId === null || body.categoryId === "" ? null : String(body.categoryId || "");
      if (categoryId && !appState.accessControl.categories.some((category) => category.id === categoryId)) return sendJson(response, 400, { error: "选择的文件夹分类不存在。" });
      canonicalizeAccessCategoryFolders();
      for (const category of appState.accessControl.categories) {
        category.folderIds = (category.folderIds || []).filter((id) => id !== folderId);
        if (category.id === categoryId) category.folderIds.push(folderId);
        category.updatedAt = new Date().toISOString();
      }
      await saveState();
      return sendJson(response, 200, { folderId, categoryId });
    }
    if (request.method === "POST" && pathname === "/api/access-control/users") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      const accessCode = String(body.accessCode || "").trim();
      if (!ACCESS_CODE_PATTERN.test(accessCode)) return sendJson(response, 400, { error: "访问码必须是六位数字。" });
      if (await userForAccessCode(accessCode, null, true)) return sendJson(response, 409, { error: "这个访问码已经关联了一个用户，请换一个六位数字。" });
      const submittedCategoryIds = [...new Set(Array.isArray(body.categoryIds) ? body.categoryIds.map(String) : [])];
      const categoryIds = validAccessCategoryIds(submittedCategoryIds);
      if (categoryIds.length !== submittedCategoryIds.length) return sendJson(response, 400, { error: "部分文件夹分类已经不存在，请刷新控制端后重新选择。" });
      if (!categoryIds.length) return sendJson(response, 400, { error: "请至少为这个访问码选择一个文件夹分类。" });
      const now = new Date().toISOString();
      const user = {
        id: randomUUID(),
        categoryIds,
        folderIds: [],
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        ...await accessCodeCredentials(accessCode),
      };
      appState.accessControl.users.push(user);
      await saveState();
      return sendJson(response, 201, publicAccessUser(user));
    }
    if (request.method === "PATCH" && /^\/api\/access-control\/users\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const userId = pathname.split("/").pop();
      const user = appState.accessControl.users.find((item) => item.id === userId);
      if (!user) return sendJson(response, 404, { error: "找不到这位访问用户。" });
      const body = await readJson(request);
      if (body.categoryIds !== undefined) {
        const submittedCategoryIds = [...new Set(Array.isArray(body.categoryIds) ? body.categoryIds.map(String) : [])];
        const categoryIds = validAccessCategoryIds(submittedCategoryIds);
        if (categoryIds.length !== submittedCategoryIds.length) return sendJson(response, 400, { error: "部分文件夹分类已经不存在，请刷新控制端后重新选择。" });
        if (!categoryIds.length) return sendJson(response, 400, { error: "请至少为这个访问码选择一个文件夹分类。" });
        user.categoryIds = categoryIds;
        user.folderIds = [];
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "请提供有效的用户状态。" });
        user.enabled = body.enabled;
        if (!body.enabled) appState.accessControl.sessions = appState.accessControl.sessions.filter((session) => session.userId !== user.id);
      }
      if (body.accessCode !== undefined) {
        const accessCode = String(body.accessCode || "").trim();
        if (!ACCESS_CODE_PATTERN.test(accessCode)) return sendJson(response, 400, { error: "访问码必须是六位数字。" });
        if (await userForAccessCode(accessCode, user.id, true)) return sendJson(response, 409, { error: "这个访问码已经关联了另一个用户，请换一个六位数字。" });
        Object.assign(user, await accessCodeCredentials(accessCode));
        appState.accessControl.sessions = appState.accessControl.sessions.filter((session) => session.userId !== user.id);
      }
      user.updatedAt = new Date().toISOString();
      await saveState();
      return sendJson(response, 200, publicAccessUser(user));
    }
    if (request.method === "DELETE" && /^\/api\/access-control\/users\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const userId = pathname.split("/").pop();
      if (!appState.accessControl.users.some((user) => user.id === userId)) return sendJson(response, 404, { error: "找不到这位访问用户。" });
      appState.accessControl.users = appState.accessControl.users.filter((user) => user.id !== userId);
      appState.accessControl.sessions = appState.accessControl.sessions.filter((session) => session.userId !== userId);
      await saveState();
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && pathname === "/api/libraries") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      if (!body.folderPath || !path.isAbsolute(body.folderPath)) return sendJson(response, 400, { error: "请输入完整的 Windows 文件夹路径。" });
      const folderPath = path.resolve(body.folderPath);
      const folderStat = await stat(folderPath).catch(() => null);
      if (!folderStat?.isDirectory()) return sendJson(response, 400, { error: "找不到这个文件夹，或当前程序没有读取权限。" });
      let library = appState.libraries.find((item) => item.path.toLowerCase() === folderPath.toLowerCase()) || null;
      const added = !library;
      if (added) {
        library = { id: stableId(folderPath), path: folderPath, name: body.name || path.basename(folderPath) || folderPath };
        appState.libraries.push(library);
        libraryRevision += 1;
        await saveState();
      }
      return sendJson(response, 201, { libraries: appState.libraries, library, added });
    }
    if (request.method === "DELETE" && pathname.startsWith("/api/libraries/")) {
      if (!requireLocalManagement(request, response)) return;
      const id = pathname.split("/").pop();
      const library = appState.libraries.find((item) => item.id === id);
      if (!library) return sendJson(response, 404, { error: "找不到这个视频目录，它可能已经被删除。" });
      libraryRevision += 1;
      const removedMedia = appState.media.filter((media) => media.libraryId === id);
      appState.libraries = appState.libraries.filter((library) => library.id !== id);
      appState.media = appState.media.filter((media) => media.libraryId !== id);
      appState.media = [...new Map(appState.media.map((media) => [media.id, media])).values()];
      const remainingMediaIds = new Set(appState.media.map((media) => media.id));
      const removedMediaIds = new Set(removedMedia.filter((media) => !remainingMediaIds.has(media.id)).map((media) => media.id));
      const remainingFolderIds = new Set(appState.media.map((media) => stableId(folderPathForMedia(media))));
      const removedFolderIds = new Set(removedMedia
        .map((media) => stableId(folderPathForMedia(media)))
        .filter((folderId) => !remainingFolderIds.has(folderId)));
      appState.jobs = appState.jobs.filter((job) => !removedMediaIds.has(job.mediaId));
      appState.displayGroups = appState.displayGroups.filter((group) => !removedFolderIds.has(group.id));
      for (const category of appState.accessControl.categories) {
        category.folderIds = category.folderIds.filter((folderId) => !removedFolderIds.has(folderId));
      }
      await saveState();
      return sendJson(response, 200, { ok: true, removedMediaCount: removedMediaIds.size });
    }
    if (request.method === "PATCH" && /^\/api\/display-groups\/[^/]+$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const groupId = pathname.split("/").pop();
      const folder = displayFolderSummaries().find((item) => item.id === groupId);
      if (!folder) return sendJson(response, 404, { error: "找不到这个视频文件夹，请先重新扫描。" });
      const body = await readJson(request);
      const title = String(body.title || "").trim();
      const season = Number(body.season);
      if (!title) return sendJson(response, 400, { error: "请填写网页上显示的作品名。" });
      if (title.length > 120) return sendJson(response, 400, { error: "作品名不能超过 120 个字符。" });
      if (!Number.isInteger(season) || season < 1 || season > 99) return sendJson(response, 400, { error: "季度必须是 1 到 99 之间的整数。" });
      if (Object.keys(body).some(k => !["title", "season"].includes(k))) return sendJson(response, 400, { error: "不允许修改此字段" });
      await labelService.manual(groupId, { title });
      appState.displayGroups = appState.displayGroups.filter((group) => group.id !== groupId && path.resolve(group.path).toLowerCase() !== path.resolve(folder.path).toLowerCase());
      appState.displayGroups.push({ id: groupId, path: folder.path, title, season, updatedAt: new Date().toISOString() });
      await saveState();
      return sendJson(response, 200, displayFolderSummaries().find((item) => item.id === groupId));
    }
    if (request.method === "POST" && pathname === "/api/scan/start") {
      if (!requireLocalManagement(request, response)) return;
      const mode = normalizedScanMode(url.searchParams.get("mode") || "standard");
      scanLibraries({ mode }).catch((error) => console.error(`${mode === "turbo" ? "急速" : "普通"}扫描失败：${error.message}`));
      return sendJson(response, 202, { scan: catalogScanStatus() });
    }
    if (request.method === "POST" && pathname === "/api/scan/stop") {
      if (!requireLocalManagement(request, response)) return;
      return sendJson(response, 200, await stopTurboScan());
    }
    if (request.method === "POST" && pathname === "/api/scan") {
      if (!requireLocalManagement(request, response)) return;
      const mode = normalizedScanMode(url.searchParams.get("mode") || "standard");
      const media = await scanLibraries({ mode });
      const displayIndex = createDisplayIndex(media);
      return sendJson(response, 200, { count: media.length, media: media.map((item) => publicMedia(item, true, displayIndex)), scan: catalogScanStatus() });
    }
    if (request.method === "PATCH" && pathname === "/api/settings/auto-scan") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "请提供有效的自动扫描开关状态。" });
      return sendJson(response, 200, { scan: await updateCatalogScanSettings(body) });
    }
    if (request.method === "PATCH" && pathname === "/api/settings/compatible-copy-directory") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      const result = await updateCompatibleCopyDirectory(body.directoryPath, body.moveExisting !== false);
      return sendJson(response, 200, result);
    }
    if (request.method === "PATCH" && pathname === "/api/settings/remux-acceleration") {
      if (!requireLocalManagement(request, response)) return;
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") return sendJson(response, 400, { error: "请提供有效的重封装并行加速开关状态。" });
      return sendJson(response, 200, { remuxAcceleration: await setRemuxAcceleration(body.enabled) });
    }
    if (request.method === "POST" && pathname === "/api/media/prepare-compatible") {
      if (!requireLocalManagement(request, response)) return;
      if (!mediaTools.available) return sendJson(response, 503, { error: mediaTools.hint });
      const candidates = appState.media.filter((item) => mediaCompatibility(item).needsCompatibleCopy && !item.remuxPath);
      const jobs = candidates.map((item) => startRemuxJob(item, true));
      return sendJson(response, 202, { count: jobs.length, jobs });
    }
    if (request.method === "POST" && /^\/api\/media\/[^/]+\/remux$/.test(pathname)) {
      if (!requireLocalManagement(request, response)) return;
      const mediaId = pathname.split("/")[3];
      const media = appState.media.find((item) => item.id === mediaId);
      if (!media) return sendJson(response, 404, { error: "找不到视频。" });
      const body = await readJson(request);
      const job = startRemuxJob(media, body.convertAudioToAac !== false);
      return sendJson(response, 202, job);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[^/]+\/thumbnail$/.test(pathname)) {
      const mediaId = pathname.split("/")[3];
      const media = authorizedMediaForRequest(request, response, mediaId);
      if (!media) return;
      if (!media?.thumbnailPath) return sendJson(response, 404, { error: "这个视频还没有生成缩略图，请在管理端重新扫描。" });
      return streamFile(request, response, media.thumbnailPath);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[^/]+\/stream$/.test(pathname)) {
      const mediaId = pathname.split("/")[3];
      const media = authorizedMediaForRequest(request, response, mediaId);
      if (!media) return;
      const filePath = url.searchParams.get("variant") === "remux" && media.remuxPath ? media.remuxPath : media.path;
      return streamFile(request, response, filePath, true);
    }
    if (["GET", "HEAD"].includes(request.method) && /^\/api\/media\/[^/]+\/bitmap-subtitles\/[^/]+/.test(pathname)) {
      const handled = await bitmapSubtitleService.handleRequest(request, response, url, pathname,
        { authorizedMediaForRequest, playbackInfo: playbackService.info, sendJson, streamFile })
        .catch((error) => {
          if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 500, { error: error.status ? error.message : "位图字幕渲染失败", code: error.code || "BITMAP_SUBTITLE_ERROR" });
          return true;
        });
      if (handled) return;
    }
    if (request.method === "GET" && /^\/api\/media\/[^/]+\/subtitles\/[^/]+$/.test(pathname)) {
      const [, , , mediaId, , subtitleId] = pathname.split("/");
      const media = authorizedMediaForRequest(request, response, mediaId);
      if (!media) return;
      const subtitle = media?.subtitles.find((item) => item.id === subtitleId);
      if (!subtitle) return sendJson(response, 404, { error: "找不到字幕。" });
      // 字幕是文本文件，异常超大文件不应整体读入内存。
      const subtitleStat = await stat(subtitle.path).catch(() => null);
      if (!subtitleStat?.isFile()) return sendJson(response, 404, { error: "字幕文件不存在。" });
      if (subtitleStat.size > MAX_SUBTITLE_BYTES) return sendJson(response, 413, { error: "字幕文件过大，无法读取。" });
      const originalContent = normalizeTextSubtitle(await readFile(subtitle.path));
      const needsWebVtt = subtitle.format === "SRT" && url.searchParams.get("format") === "vtt";
      const content = needsWebVtt ? srtToWebVtt(originalContent) : originalContent;
      response.writeHead(200, {
        "Content-Type": needsWebVtt ? "text/vtt; charset=utf-8" : contentTypeFor(subtitle.path),
        "Content-Length": Buffer.byteLength(content),
        "Cache-Control": "no-store",
      });
      return response.end(content);
    }
    if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[^/]+\/fonts\/[^/]+$/.test(pathname)) {
      const [, , , mediaId, , fontId] = pathname.split("/");
      const media = authorizedMediaForRequest(request, response, mediaId);
      if (!media) return;
      const font = media?.fonts.find((item) => item.id === fontId);
      if (!font) return sendJson(response, 404, { error: "找不到字体。" });
      return streamFile(request, response, font.path);
    }
    if (!pathname.startsWith("/api/") && await serveStatic(response, pathname)) return;
    return sendJson(response, 404, { error: "没有找到这个地址。" });
  } catch (error) {
    console.error(error);
    const statusCode = error.code === "INVALID_SCAN_MODE"
      ? 400
      : ["LIBRARY_CHANGED_DURING_SCAN", "READING_LIBRARY_CHANGED_DURING_SCAN", "PHOTO_LIBRARY_CHANGED_DURING_SCAN"].includes(error.code) ? 409
        : ["READING_SCAN_CANCELLED", "PHOTO_SCAN_CANCELLED"].includes(error.code) ? 409 : 500;
    return sendJson(response, statusCode, { error: error.message || "服务器内部错误" });
  }
});

let autoScanTimer = null;
let scheduledScanRunning = false;

async function runScheduledAutoScan(force = false) {
  if (!appState.settings.autoScanEnabled || (!appState.libraries.length && !appState.musicLibraries.length && !appState.readingLibraries.length && !appState.photoLibraries.length) || activeScan || musicService.isScanning() || readingService.isScanning() || photoService.isScanning() || pendingScanMode || scheduledScanRunning || sharingServiceIsStopping) return;
  const lastStartedMilliseconds = Math.max(
    Date.parse(lastScanStartedAt || "") || 0,
    Date.parse(musicService.scanStatus().lastStartedAt || "") || 0,
    Date.parse(readingService.scanStatus().lastStartedAt || "") || 0,
    Date.parse(photoService.scanStatus().lastStartedAt || "") || 0,
  );
  if (!force && Date.now() - lastStartedMilliseconds < normalizedAutoScanIntervalSeconds() * 1000) return;
  scheduledScanRunning = true;
  try {
    if (appState.libraries.length) await scanLibraries();
    if (appState.musicLibraries.length) await musicService.scanLibraries();
    if (appState.readingLibraries.length) await readingService.scanLibraries();
    if (appState.photoLibraries.length) await photoService.scanLibraries();
  } catch (error) {
    console.error(`自动扫描媒体目录失败：${error.message}`);
  } finally {
    scheduledScanRunning = false;
  }
}

function startAutoScanScheduler() {
  if (autoScanTimer) return;
  autoScanTimer = setInterval(() => void runScheduledAutoScan(), AUTO_SCAN_SCHEDULER_TICK_MS);
  autoScanTimer.unref();
  void runScheduledAutoScan();
}

async function prepareStartupMedia() {
  if (appState.settings.autoScanEnabled && (appState.libraries.length || appState.musicLibraries.length || appState.readingLibraries.length || appState.photoLibraries.length)) {
    if (appState.libraries.length) await scanLibraries();
    if (appState.musicLibraries.length) await musicService.scanLibraries();
    if (appState.readingLibraries.length) await readingService.scanLibraries();
    if (appState.photoLibraries.length) await photoService.scanLibraries();
    return;
  }
  await queueAutomaticCompatibleCopies();
  await musicService.queueAutomaticCompatibleCopies();
  await cleanOrphanedCacheFiles().catch((error) => console.error(`启动时清理孤儿缓存失败：${error.message}`));
  await musicService.cleanOrphanedCacheFiles().catch((error) => console.error(`启动时清理音乐缓存失败：${error.message}`));
  await photoService.cleanOrphanedCacheFiles().catch((error) => console.error(`启动时清理图片缓存失败：${error.message}`));
}

async function stopSharingService() {
  if (sharingServiceIsStopping) return;
  sharingServiceIsStopping = true;
  const playbackStopping = playbackService.stop();
  const bitmapSubtitleStopping = bitmapSubtitleService.stop();
  musicService.requestStopScan();
  readingService.requestStopScan();
  photoService.requestStopScan();
  let serverClosed = false;
  let cleanupComplete = false;
  const exitWhenReady = () => {
    if (serverClosed && cleanupComplete) process.exit(0);
  };
  server.once("close", () => {
    serverClosed = true;
    exitWhenReady();
  });
  if (server.listening) {
    server.close();
    server.closeIdleConnections?.();
  } else {
    serverClosed = true;
  }
  const forceStopTimer = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 4000);
  forceStopTimer.unref();
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
  if (remuxAccelerationTimer) {
    clearTimeout(remuxAccelerationTimer);
    remuxAccelerationTimer = null;
  }

  remuxQueue.length = 0;
  for (const job of appState.jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.message = "共享服务已从系统托盘停止，请重新加入处理队列";
    }
  }
  await saveState().catch((error) => console.error(`停止前保存状态失败：${error.message}`));

  for (const child of [...trackedChildProcesses]) {
    try { child.kill(); }
    catch { /* 子进程可能已经自行退出。 */ }
  }

  const activeTaskPromises = [...remuxTasksByMediaId.values()]
    .map((task) => task.executionPromise)
    .filter(Boolean);
  activeTaskPromises.push(playbackStopping);
  activeTaskPromises.push(bitmapSubtitleStopping);
  if (activeTaskPromises.length) {
    await Promise.race([
      Promise.allSettled(activeTaskPromises),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
  for (const job of appState.jobs) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "failed";
      job.message = "共享服务已停止，任务未能完成";
    }
  }
  trimJobHistory();
  await saveState().catch((error) => console.error(`停止时最终保存状态失败：${error.message}`));
  cleanupComplete = true;
  exitWhenReady();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopSharingService().catch((error) => {
      console.error(`响应 ${signal} 停止共享服务失败：${error.message}`);
      process.exit(1);
    });
  });
}

server.listen(PORT, HOST, () => {
  console.log(`LMD 本地服务已启动：http://127.0.0.1:${PORT}`);
  scheduleRemuxAccelerationExpiry();
  prepareStartupMedia()
    .catch((error) => console.error(`启动媒体准备失败：${error.message}`))
    .finally(startAutoScanScheduler);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`端口 ${PORT} 已被占用，LMD 可能已经启动。`);
  else console.error(error);
  process.exitCode = 1;
});
