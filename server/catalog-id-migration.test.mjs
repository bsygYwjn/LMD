import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");

function stableId(value) {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 20);
}

function mediaSourceSignature(media) {
  return createHash("sha256")
    .update(`${media.id}\0${Number(media.size) || 0}\0${media.modifiedAt || ""}`)
    .digest("hex")
    .slice(0, 12);
}

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

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, result: await response.json() };
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`迁移测试服务提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待迁移测试服务启动超时");
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-catalog-id-migration-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const physicalLibraryDirectory = path.join(temporaryRoot, "PhysicalLibrary");
const legacyAliasDirectory = path.join(temporaryRoot, "LegacyLibraryAlias");
const physicalVideoPath = path.join(physicalLibraryDirectory, "legacy.mp4");
const legacyVideoPath = path.join(legacyAliasDirectory, "legacy.mp4");
const physicalMissingVideoPath = path.join(physicalLibraryDirectory, "missing-copy.mp4");
const legacyMissingVideoPath = path.join(legacyAliasDirectory, "missing-copy.mp4");
const remuxPath = path.join(dataDirectory, "legacy-compatible-copy.mp4");
const missingRemuxPath = path.join(dataDirectory, "missing-compatible-copy.mp4");

await mkdir(physicalLibraryDirectory, { recursive: true });
await mkdir(dataDirectory, { recursive: true });
await writeFile(physicalVideoPath, Buffer.from("legacy-video"));
await writeFile(physicalMissingVideoPath, Buffer.from("legacy-video-with-missing-copy"));
await writeFile(remuxPath, Buffer.from("legacy-compatible-copy"));
await symlink(physicalLibraryDirectory, legacyAliasDirectory, process.platform === "win32" ? "junction" : "dir");

const canonicalVideoPath = await realpath(legacyVideoPath);
const canonicalMissingVideoPath = await realpath(legacyMissingVideoPath);
const legacyMediaId = stableId(legacyVideoPath);
const canonicalMediaId = stableId(canonicalVideoPath);
const legacyMissingMediaId = stableId(legacyMissingVideoPath);
const canonicalMissingMediaId = stableId(canonicalMissingVideoPath);
const libraryId = stableId(legacyAliasDirectory);
const videoStat = await stat(legacyVideoPath);
const modifiedAt = videoStat.mtime.toISOString();
const missingVideoStat = await stat(legacyMissingVideoPath);
const missingModifiedAt = missingVideoStat.mtime.toISOString();
const legacyMedia = {
  id: legacyMediaId,
  libraryId,
  title: "legacy",
  fileName: "legacy.mp4",
  path: legacyVideoPath,
  extension: "MP4",
  size: videoStat.size,
  modifiedAt,
  tags: ["必须保留的标签"],
  posterHue: 12,
  remuxPath,
  remuxVersion: 2,
  remuxSourceSignature: mediaSourceSignature({ id: legacyMediaId, size: videoStat.size, modifiedAt }),
  thumbnailPath: null,
  subtitles: [],
  fonts: [],
  durationSeconds: 10,
  format: "mp4",
  videoCodec: "h264",
  videoProfile: "High",
  width: 1920,
  height: 1080,
  pixelFormat: "yuv420p",
  colorSpace: "bt709",
  colorTransfer: "bt709",
  colorPrimaries: "bt709",
  audioCodec: "aac",
  audioChannels: 2,
  embeddedSubtitleStreams: [],
  embeddedFontStreams: [],
};
const missingCopyMedia = {
  ...legacyMedia,
  id: legacyMissingMediaId,
  title: "missing-copy",
  fileName: "missing-copy.mp4",
  path: legacyMissingVideoPath,
  size: missingVideoStat.size,
  modifiedAt: missingModifiedAt,
  tags: ["缺失副本标签"],
  remuxPath: missingRemuxPath,
  remuxSourceSignature: mediaSourceSignature({ id: legacyMissingMediaId, size: missingVideoStat.size, modifiedAt: missingModifiedAt }),
};

await writeFile(path.join(dataDirectory, "state.json"), JSON.stringify({
  version: 8,
  libraries: [{ id: libraryId, path: legacyAliasDirectory, name: "旧联接媒体库" }],
  media: [legacyMedia, missingCopyMedia],
  jobs: [
    {
      id: "legacy-completed-job",
      mediaId: legacyMediaId,
      title: "legacy",
      type: "无损重封装 + AAC",
      status: "completed",
      progress: 100,
      message: "已完成",
      createdAt: modifiedAt,
      completedAt: modifiedAt,
    },
    {
      id: "legacy-failed-job",
      mediaId: legacyMissingMediaId,
      title: "missing-copy",
      type: "无损重封装 + AAC",
      status: "failed",
      progress: 42,
      message: "旧任务失败记录",
      createdAt: missingModifiedAt,
      completedAt: missingModifiedAt,
    },
  ],
  displayGroups: [],
  accessControl: { enabled: false, users: [], sessions: [], categories: [] },
  settings: {
    autoScanEnabled: true,
    autoScanIntervalSeconds: 3600,
    autoPrepareCompatibleCopies: false,
    compatibleCopyDirectory: dataDirectory,
  },
}, null, 2), "utf8");

assert.notEqual(legacyMediaId, canonicalMediaId, "测试前提要求联接逻辑路径 ID 与真实路径 ID 不同");
assert.notEqual(legacyMissingMediaId, canonicalMissingMediaId, "缺失副本用例也必须触发真实路径 ID 迁移");

const port = await freePort();
const localBaseUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
  cwd: PROJECT_DIR,
  env: { ...process.env, NODE_ENV: "test", LMD_PORT: String(port), LMD_DATA_DIR: dataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
serverProcess.stderr.setEncoding("utf8");
serverProcess.stderr.on("data", (chunk) => { serverErrors += chunk; });

try {
  await waitForHealth(localBaseUrl, serverProcess);
  const deadline = Date.now() + 15000;
  let overview = null;
  while (Date.now() < deadline) {
    const request = await jsonRequest(localBaseUrl, "/api/overview");
    assert.equal(request.response.status, 200, request.result.error);
    overview = request.result;
    if (!overview.scanning && overview.media.some((media) => media.id === canonicalMediaId)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(overview?.media.length, 2, "升级扫描不应重复同一物理视频");
  const migratedOverviewMedia = overview?.media.find((media) => media.id === canonicalMediaId);
  const missingCopyOverviewMedia = overview?.media.find((media) => media.id === canonicalMissingMediaId);
  assert.deepEqual(migratedOverviewMedia?.tags, ["必须保留的标签"], "升级扫描应保留媒体标签");
  assert.equal(migratedOverviewMedia?.remuxPath, remuxPath, "升级扫描应保留有效兼容副本路径");
  assert.equal(missingCopyOverviewMedia?.remuxPath, null, "升级扫描不得保留实际已不存在的兼容副本路径");
  assert.deepEqual(
    overview?.jobs.map((job) => [job.id, job.mediaId, job.status]).sort(),
    [
      ["legacy-completed-job", canonicalMediaId, "completed"],
      ["legacy-failed-job", canonicalMissingMediaId, "failed"],
    ].sort(),
    "升级扫描应迁移全部历史任务的媒体 ID，同时保留任务状态",
  );
  const migratedRemuxResponse = await fetch(`${localBaseUrl}/api/media/${canonicalMediaId}/stream?variant=remux`);
  assert.equal(migratedRemuxResponse.status, 200, "新媒体 ID 应能继续读取已迁移的兼容副本");
  assert.equal(await migratedRemuxResponse.text(), "legacy-compatible-copy");
  const legacyIdResponse = await fetch(`${localBaseUrl}/api/media/${legacyMediaId}/stream?variant=remux`);
  assert.equal(legacyIdResponse.status, 404, "迁移完成后旧媒体 ID 应停止提供直链");

  const storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  const migratedMedia = storedState.media.find((media) => media.id === canonicalMediaId);
  const missingCopyMigratedMedia = storedState.media.find((media) => media.id === canonicalMissingMediaId);
  assert.equal(migratedMedia.id, canonicalMediaId);
  assert.equal(migratedMedia.remuxPath, remuxPath);
  assert.equal(migratedMedia.remuxVersion, 2);
  assert.equal(
    migratedMedia.remuxSourceSignature,
    mediaSourceSignature({ id: canonicalMediaId, size: videoStat.size, modifiedAt }),
    "升级扫描应把兼容副本签名迁移到新的媒体 ID",
  );
  assert.equal(missingCopyMigratedMedia.remuxPath, null);
  assert.equal(missingCopyMigratedMedia.remuxVersion, null);
  assert.equal(missingCopyMigratedMedia.remuxSourceSignature, null);
  assert.deepEqual(storedState.jobs.map((job) => job.mediaId).sort(), [canonicalMediaId, canonicalMissingMediaId].sort());

  console.log("目录真实路径 ID 迁移测试通过：标签、兼容副本与历史任务关联均已保留。");
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
  throw new Error(serverErrors || `迁移测试服务退出码 ${serverProcess.exitCode}`);
}
