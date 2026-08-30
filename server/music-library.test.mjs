import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedLyrics, parseLrc } from "./music.mjs";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");
const FFMPEG = process.platform === "win32"
  ? path.join(PROJECT_DIR, "tools", "ffmpeg", "bin", "ffmpeg.exe")
  : path.join(PROJECT_DIR, "tools", "ffmpeg", "bin", "ffmpeg");

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function run(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: PROJECT_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString("utf8") || `${executable} 退出码 ${code}`)));
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待测试服务启动超时");
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

async function waitForCompatibleCopy(baseUrl, trackId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const overview = await jsonRequest(baseUrl, "/api/music/overview");
    const track = overview.result.tracks?.find((item) => item.id === trackId);
    if (track?.compatibleStatus === "ready") return track;
    const failedJob = overview.result.jobs?.find((job) => job.mediaId === trackId && job.status === "failed");
    if (failedJob) throw new Error(`FLAC 兼容副本生成失败：${failedJob.message}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待 ALAC 的 FLAC 兼容副本超时");
}

function assertNoPaths(value, location = "catalog") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoPaths(item, `${location}[${index}]`));
  for (const [key, item] of Object.entries(value)) {
    assert.doesNotMatch(key, /path$/i, `${location}.${key} 不应暴露本地路径`);
    assertNoPaths(item, `${location}.${key}`);
  }
}

const enhancedLyrics = parseLrc("[ar:测试歌手]\n[00:01.00]<00:01.00>逐字<00:01.40>歌词\n[00:02.50]普通行");
assert.equal(enhancedLyrics.synchronized, true);
assert.equal(enhancedLyrics.wordTimed, true);
assert.equal(enhancedLyrics.lines[0].words.length, 2);
assert.equal(enhancedLyrics.lines[0].words[1].startMs, 1400);
assert.equal(enhancedLyrics.lines[0].endMs, 2500);

const embeddedPlainLrc = embeddedLyrics([{ text: "[00:01.00]第一句歌词\n[00:03.50]第二句歌词" }]);
assert.equal(embeddedPlainLrc.synchronized, true);
assert.equal(embeddedPlainLrc.lines.length, 2);
assert.equal(embeddedPlainLrc.lines[0].text, "第一句歌词");
assert.equal(embeddedPlainLrc.lines[0].startMs, 1000);
const embeddedPlainText = embeddedLyrics([{ text: "没有时间轴的普通文本歌词" }]);
assert.equal(embeddedPlainText.synchronized, false);
assert.equal(embeddedPlainText.plainText, "没有时间轴的普通文本歌词");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-music-library-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const firstLibrary = path.join(temporaryRoot, "MusicOne");
const firstAlbum = path.join(firstLibrary, "专辑甲");
const secondLibrary = path.join(temporaryRoot, "MusicTwo");
const secondAlbum = path.join(secondLibrary, "专辑乙");
await mkdir(firstAlbum, { recursive: true });
await mkdir(secondAlbum, { recursive: true });

await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x2388ff:s=600x600", "-frames:v", "1", "-q:v", "2", path.join(firstAlbum, "cover.jpg")]);
await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x7648ff:s=600x600", "-frames:v", "1", "-q:v", "2", path.join(secondAlbum, "folder.jpg")]);
await writeFile(path.join(firstAlbum, "02 - 本地歌曲.lrc"), "[ar:测试歌手]\n[al:本地专辑]\n[00:00.00]<00:00.00>第一<00:00.30>行\n[00:00.70]第二行\n", "utf8");

const flacPath = path.join(firstAlbum, "02 - 本地歌曲.flac");
const alacPath = path.join(firstAlbum, "03 - ALAC.m4a");
const hiddenPath = path.join(secondAlbum, "01 - 未授权.wav");
const legacyVideoDirectory = path.join(temporaryRoot, "LegacyVideo");
const legacyVideoPath = path.join(legacyVideoDirectory, "preserved.mp4");
await mkdir(legacyVideoDirectory, { recursive: true });
await mkdir(dataDirectory, { recursive: true });
await writeFile(legacyVideoPath, Buffer.from("legacy-video-record"));
await run(FFMPEG, [
  "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
  "-ar", "44100", "-sample_fmt", "s16", "-c:a", "flac",
  "-metadata", "title=本地歌曲", "-metadata", "artist=测试歌手", "-metadata", "album=本地专辑",
  "-metadata", "album_artist=专辑艺术家", "-metadata", "date=2026", "-metadata", "genre=原声",
  "-metadata", "disc=1/1", "-metadata", "track=2/9", flacPath,
]);
await run(FFMPEG, [
  "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=554:duration=1.2",
  "-ar", "48000", "-sample_fmt", "s16", "-c:a", "alac",
  "-metadata", "title=ALAC 测试", "-metadata", "artist=测试歌手", "-metadata", "album=本地专辑",
  "-metadata", "track=3/9", alacPath,
]);
await run(FFMPEG, [
  "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
  "-ar", "96000", "-sample_fmt", "s32", "-c:a", "pcm_s24le",
  "-metadata", "title=未授权歌曲", hiddenPath,
]);
await writeFile(path.join(dataDirectory, "state.json"), JSON.stringify({
  version: 8,
  libraries: [{ id: "legacy-library", name: "保留的视频库", path: legacyVideoDirectory }],
  media: [{
    id: "legacy-video", libraryId: "legacy-library", path: legacyVideoPath, fileName: "preserved.mp4",
    extension: "MP4", size: 19, modifiedAt: new Date(0).toISOString(), title: "迁移后保留的视频",
    width: 1920, height: 1080, durationSeconds: 1, videoCodec: "h264", audioCodec: "aac", bitDepth: 8,
    hdr: null, posterHue: 200, streamUrl: "", remuxPath: null, thumbnailPath: null, probeError: null,
    subtitles: [], fonts: [], embeddedSubtitleStreams: [], embeddedFontStreams: [], tags: [],
  }],
  jobs: [],
  displayGroups: [],
  accessControl: { enabled: false, users: [], sessions: [], categories: [] },
  settings: { autoScanEnabled: false, autoScanIntervalSeconds: 30, autoPrepareCompatibleCopies: true, maxStreams: 10, compatibleCopyDirectory: path.join(dataDirectory, "cache") },
}), "utf8");

const port = await freePort();
const localBaseUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    NODE_ENV: "test",
    LMD_PORT: String(port),
    LMD_DATA_DIR: dataDirectory,
    LMD_FFMPEG_INSTALL_DIR: path.join(PROJECT_DIR, "tools", "ffmpeg"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
serverProcess.stderr.setEncoding("utf8");
serverProcess.stderr.on("data", (chunk) => { serverErrors += chunk; });

try {
  const health = await waitForHealth(localBaseUrl, serverProcess);
  assert.ok(health.lanAddresses.length, "权限测试需要至少一个局域网 IPv4 地址");
  const lanBaseUrl = health.lanAddresses[0];

  await jsonRequest(localBaseUrl, "/api/settings/auto-scan", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  let request = await jsonRequest(localBaseUrl, "/api/music/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: firstLibrary, name: "第一音乐库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const firstLibraryId = request.result.library.id;
  request = await jsonRequest(localBaseUrl, "/api/music/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: secondLibrary, name: "第二音乐库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);

  request = await jsonRequest(localBaseUrl, "/api/music/catalog/scan?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, 3);

  request = await jsonRequest(lanBaseUrl, "/api/music/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.tracks.length, 3);
  assert.equal(request.result.folders.length, 4, "两个音乐库及其专辑目录都应保留磁盘层级");
  assertNoPaths(request.result);
  assert.equal(JSON.stringify(request.result).includes(temporaryRoot), false, "播放端音乐目录不得包含绝对路径");

  const localTrack = request.result.tracks.find((track) => track.title === "本地歌曲");
  const alacTrack = request.result.tracks.find((track) => track.title === "ALAC 测试");
  const hiddenTrack = request.result.tracks.find((track) => track.fileName === path.basename(hiddenPath));
  assert.ok(localTrack && alacTrack && hiddenTrack, `扫描应读取三首测试歌曲；实际：${request.result.tracks.map((track) => `${track.fileName}=${track.title}`).join("、")}`);
  assert.deepEqual(localTrack.artists, ["测试歌手"]);
  assert.equal(localTrack.album, "本地专辑");
  assert.equal(localTrack.albumArtist, "专辑艺术家");
  assert.equal(localTrack.year, 2026);
  assert.equal(localTrack.discNumber, 1);
  assert.equal(localTrack.trackNumber, 2);
  assert.equal(localTrack.sampleRate, 44100);
  assert.equal(localTrack.lossless, true);
  assert.ok(localTrack.coverUrls?.[256] && localTrack.coverUrls?.[1024], "目录 cover.png 应生成两种封面缓存");
  assert.equal(localTrack.lyrics?.source, "sidecar");
  assert.equal(localTrack.lyrics?.wordTimed, true);

  const coverResponse = await fetch(`${lanBaseUrl}${localTrack.coverUrls[256]}`);
  assert.equal(coverResponse.status, 200);
  assert.equal(coverResponse.headers.get("content-type"), "image/jpeg");
  assert.ok((await coverResponse.arrayBuffer()).byteLength > 0);

  const lyricsResponse = await fetch(`${lanBaseUrl}${localTrack.lyricsUrl}`);
  assert.equal(lyricsResponse.status, 200);
  const lyrics = await lyricsResponse.json();
  assert.equal(lyrics.source, "sidecar-lrc");
  assert.equal(lyrics.lines.length, 2);
  assert.equal(lyrics.lines[0].words.length, 2);

  const streamResponse = await fetch(`${lanBaseUrl}${localTrack.streamUrl}`, { headers: { Range: "bytes=0-31" } });
  assert.equal(streamResponse.status, 206);
  assert.equal(streamResponse.headers.get("content-type"), "audio/flac");
  assert.match(streamResponse.headers.get("content-range") || "", /^bytes 0-31\//);
  assert.equal((await streamResponse.arrayBuffer()).byteLength, 32);
  const headResponse = await fetch(`${lanBaseUrl}${localTrack.streamUrl}`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("accept-ranges"), "bytes");
  assert.ok(Number(headResponse.headers.get("content-length")) > 0);
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);

  const readyAlacTrack = await waitForCompatibleCopy(localBaseUrl, alacTrack.id);
  assert.equal(readyAlacTrack.compatibleUrl, `/api/music/tracks/${alacTrack.id}/stream?variant=flac`);
  const compatibleResponse = await fetch(`${lanBaseUrl}${readyAlacTrack.compatibleUrl}`, { headers: { Range: "bytes=-16" } });
  assert.equal(compatibleResponse.status, 206);
  assert.equal(compatibleResponse.headers.get("content-type"), "audio/flac");
  assert.equal((await compatibleResponse.arrayBuffer()).byteLength, 16);

  const storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(storedState.version, 11);
  assert.equal(storedState.libraries.length, 1, "版本 8 的视频 libraries 必须原样保留");
  assert.equal(storedState.libraries[0].id, "legacy-library");
  assert.equal(storedState.media.length, 1, "版本 8 的视频记录必须在音乐迁移后保留");
  assert.equal(storedState.media[0].id, "legacy-video");
  assert.equal(storedState.musicLibraries.length, 2);
  assert.equal(storedState.musicTracks.length, 3);
  assert.ok(storedState.musicTracks.every((track) => !Buffer.isBuffer(track.coverPaths) && !track.picture), "state.json 不应保存封面二进制");

  const browserHoldMilliseconds = Math.max(0, Number(process.env.LMD_MUSIC_BROWSER_HOLD_MS) || 0);
  if (browserHoldMilliseconds) {
    console.log(`MUSIC_BROWSER_TEST_URL=${localBaseUrl}`);
    await new Promise((resolve) => setTimeout(resolve, browserHoldMilliseconds));
  }

  const overview = (await jsonRequest(localBaseUrl, "/api/overview")).result;
  const authorizedFolder = overview.displayFolders.find((folder) => folder.kind === "music" && folder.path === firstLibrary);
  assert.ok(authorizedFolder, "访问控制总览应包含音乐库根目录");
  const category = (await jsonRequest(localBaseUrl, "/api/access-control/categories", {
    method: "POST",
    body: JSON.stringify({ name: "音乐授权" }),
  })).result;
  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${authorizedFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: category.id }),
  });
  assert.equal(request.response.status, 200, request.result.error);
  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246810", categoryIds: [category.id] }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  await jsonRequest(localBaseUrl, "/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled: true }) });

  const noCookie = await fetch(`${lanBaseUrl}/api/music/catalog`);
  assert.equal(noCookie.status, 401);
  const login = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246810" }),
  });
  assert.equal(login.response.status, 200, login.result.error);
  const cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
  request = await jsonRequest(lanBaseUrl, "/api/music/catalog", { headers: { Cookie: cookie } });
  assert.equal(request.response.status, 200, request.result.error);
  assert.deepEqual(new Set(request.result.tracks.map((track) => track.libraryId)), new Set([firstLibraryId]));
  assert.equal(request.result.tracks.length, 2, "访问码用户只能看到已授权音乐库");

  for (const endpoint of [
    `/api/music/tracks/${hiddenTrack.id}/stream?variant=original`,
    `/api/music/tracks/${hiddenTrack.id}/cover?size=256`,
    `/api/music/tracks/${hiddenTrack.id}/lyrics`,
  ]) {
    const denied = await fetch(`${lanBaseUrl}${endpoint}`, { headers: { Cookie: cookie } });
    assert.equal(denied.status, 404, `未授权音乐直链 ${endpoint} 应返回 404`);
  }
  const allowed = await fetch(`${lanBaseUrl}${localTrack.streamUrl}`, { headers: { Cookie: cookie, Range: "bytes=0-0" } });
  assert.equal(allowed.status, 206, "已授权歌曲仍应可播放");

  console.log("音乐库集成测试通过：迁移、目录树、标签、封面、增强 LRC、Range、ALAC→FLAC PCM 校验与访问码隔离均符合预期。");
} finally {
  try { await fetch(`${localBaseUrl}/api/service/stop`, { method: "POST" }); }
  catch { /* 服务可能已经退出。 */ }
  await new Promise((resolve) => {
    if (serverProcess.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      serverProcess.kill();
      resolve();
    }, 4000);
    serverProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (serverProcess.exitCode && serverProcess.exitCode !== 0) {
  throw new Error(serverErrors || `测试服务退出码 ${serverProcess.exitCode}`);
}
