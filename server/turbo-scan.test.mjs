import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");
const VIDEO_COUNT = 14;
const TURBO_CONCURRENCY = 4;
const TURBO_MEDIA_TOOL_CONCURRENCY = 4;
const REQUIRED_SCAN_FIELDS = [
  "mode",
  "pendingMode",
  "phase",
  "progressPercent",
  "discoveredFiles",
  "processedFiles",
  "totalFiles",
  "processedLibraries",
  "totalLibraries",
  "maxParallelFiles",
  "maxParallelMediaTools",
];

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
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  return { response, result: await response.json() };
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`极速扫描测试服务提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待极速扫描测试服务启动超时");
}

async function startTestServer(dataDirectory) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LMD_PORT: String(port),
      LMD_DATA_DIR: dataDirectory,
      LMD_TEST_SCAN_FILE_DELAY_MS: "180",
      LMD_TURBO_SCAN_CONCURRENCY: String(TURBO_CONCURRENCY),
      LMD_TURBO_SCAN_MEDIA_TOOL_CONCURRENCY: String(TURBO_MEDIA_TOOL_CONCURRENCY),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    const health = await waitForHealth(baseUrl, child);
    return { child, baseUrl, health, errors: () => errors };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function stopTestServer(instance) {
  try { await fetch(`${instance.baseUrl}/api/service/stop`, { method: "POST" }); }
  catch { /* 服务可能已经退出。 */ }
  await new Promise((resolve) => {
    if (instance.child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      instance.child.kill();
      resolve();
    }, 4000);
    instance.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (instance.child.exitCode && instance.child.exitCode !== 0) {
    throw new Error(instance.errors() || `极速扫描测试服务退出码 ${instance.child.exitCode}`);
  }
}

function assertScanShape(scan) {
  assert.ok(scan && typeof scan === "object", "overview.scan 必须返回扫描状态对象");
  for (const field of REQUIRED_SCAN_FIELDS) {
    assert.ok(Object.hasOwn(scan, field), `扫描状态缺少 ${field} 字段`);
  }
  assert.equal(typeof scan.phase, "string");
  assert.ok(scan.progressPercent === null || Number.isFinite(scan.progressPercent), "扫描进度必须是有限数字或发现阶段的 null");
  if (scan.progressPercent !== null) {
    assert.ok(scan.progressPercent >= 0 && scan.progressPercent <= 100, "扫描进度必须处于 0 到 100 之间");
  }
  for (const field of ["discoveredFiles", "processedFiles", "totalFiles", "processedLibraries", "totalLibraries", "maxParallelFiles", "maxParallelMediaTools"]) {
    assert.ok(Number.isInteger(scan[field]) && scan[field] >= 0, `${field} 必须是非负整数`);
  }
  assert.ok(scan.processedFiles <= scan.totalFiles || scan.totalFiles === 0, "已处理文件数不能超过总文件数");
  assert.ok(scan.processedLibraries <= scan.totalLibraries, "已处理目录数不能超过目录总数");
}

async function observeTurboScan(instance) {
  const deadline = Date.now() + 30000;
  let previousProgress = -1;
  let previousDiscovered = -1;
  let previousProcessed = -1;
  let previousProcessedLibraries = -1;
  let observedActive = false;
  let observedIntermediateProgress = false;

  while (Date.now() < deadline) {
    const request = await jsonRequest(instance.baseUrl, "/api/scan/status");
    assert.equal(request.response.status, 200, request.result.error);
    const { scan } = request.result;
    assertScanShape(scan);

    if (scan.progressPercent !== null) {
      assert.ok(scan.progressPercent >= previousProgress, "同一次极速扫描的进度百分比不能倒退");
      previousProgress = scan.progressPercent;
    }
    assert.ok(scan.discoveredFiles >= previousDiscovered, "同一次极速扫描发现的文件数不能减少");
    assert.ok(scan.processedFiles >= previousProcessed, "同一次极速扫描已处理文件数不能减少");
    assert.ok(scan.processedLibraries >= previousProcessedLibraries, "同一次极速扫描已处理目录数不能减少");
    previousDiscovered = scan.discoveredFiles;
    previousProcessed = scan.processedFiles;
    previousProcessedLibraries = scan.processedLibraries;

    if (request.result.scanning) {
      observedActive = true;
      assert.equal(scan.mode, "turbo", "运行中的极速扫描必须标记 turbo 模式");
      assert.equal(scan.maxParallelFiles, TURBO_CONCURRENCY, "测试环境必须采用 LMD_TURBO_SCAN_CONCURRENCY 覆盖值");
      assert.equal(scan.maxParallelMediaTools, TURBO_MEDIA_TOOL_CONCURRENCY, "测试环境必须采用媒体工具并发覆盖值");
      if (scan.progressPercent > 0 && scan.progressPercent < 100) observedIntermediateProgress = true;
    }

    if (!request.result.scanning && scan.phase === "completed" && scan.progressPercent === 100) {
      assert.equal(scan.mode, "turbo");
      assert.equal(scan.pendingMode, null);
      assert.equal(scan.maxParallelFiles, TURBO_CONCURRENCY);
      assert.equal(scan.maxParallelMediaTools, TURBO_MEDIA_TOOL_CONCURRENCY);
      assert.equal(scan.discoveredFiles, VIDEO_COUNT);
      assert.equal(scan.totalFiles, VIDEO_COUNT);
      assert.equal(scan.processedFiles, VIDEO_COUNT);
      assert.equal(scan.totalLibraries, 1);
      assert.equal(scan.processedLibraries, 1);
      assert.equal(observedActive, true, "异步极速扫描应能通过 overview 观察到运行状态");
      assert.equal(observedIntermediateProgress, true, "文件延迟应让测试观察到 0 与 100 之间的进度");
      return scan;
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("等待极速扫描完成超时");
}

async function waitForTurboScanProgress(instance) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const request = await jsonRequest(instance.baseUrl, "/api/scan/status");
    assert.equal(request.response.status, 200, request.result.error);
    if (request.result.scanning && request.result.scan.mode === "turbo" && request.result.scan.processedFiles > 0) {
      return request.result.scan;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待极速扫描产生可停止的中间进度超时");
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-turbo-scan-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const libraryDirectory = path.join(temporaryRoot, "TurboLibrary");
await mkdir(dataDirectory, { recursive: true });
await mkdir(path.join(libraryDirectory, "nested"), { recursive: true });
await Promise.all(Array.from({ length: VIDEO_COUNT }, (_, index) => {
  const directory = index % 2 === 0 ? libraryDirectory : path.join(libraryDirectory, "nested");
  return writeFile(path.join(directory, `video-${String(index + 1).padStart(2, "0")}.mp4`), Buffer.from(`dummy-video-${index + 1}`));
}));

let instance;
try {
  instance = await startTestServer(dataDirectory);

  let request = await jsonRequest(instance.baseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: libraryDirectory, name: "极速扫描测试库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  assert.equal(request.result.added, true, "首次添加目录必须返回 added=true");
  assert.equal(request.result.library?.path, path.resolve(libraryDirectory));
  assert.equal(request.result.libraries.length, 1);
  const libraryId = request.result.library?.id;
  assert.ok(libraryId, "首次添加目录必须返回 library");

  request = await jsonRequest(instance.baseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: libraryDirectory, name: "重复目录" }),
  });
  assert.ok(request.response.ok, request.result.error);
  assert.equal(request.result.added, false, "重复添加同一路径必须返回 added=false");
  assert.equal(request.result.library?.id, libraryId, "重复添加必须返回既有 library");
  assert.equal(request.result.libraries.length, 1, "重复添加不得创建第二条目录记录");

  request = await jsonRequest(instance.baseUrl, "/api/scan/start?mode=invalid", { method: "POST" });
  assert.equal(request.response.status, 400, "未知异步扫描模式必须被拒绝");

  request = await jsonRequest(instance.baseUrl, "/api/scan?mode=invalid", { method: "POST" });
  assert.equal(request.response.status, 400, "未知阻塞扫描模式必须被拒绝");

  assert.ok(instance.health.lanAddresses.length, "测试需要至少一个局域网 IPv4 地址");
  request = await jsonRequest(instance.health.lanAddresses[0], "/api/scan/start?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 403, "局域网设备不能启动本机极速扫描");

  request = await jsonRequest(instance.baseUrl, "/api/scan/start?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 202, request.result.error);
  assertScanShape(request.result.scan);
  assert.ok(
    request.result.scan.mode === "turbo" || request.result.scan.pendingMode === "turbo",
    "202 响应必须表明 turbo 已运行或已排队",
  );
  request = await jsonRequest(instance.baseUrl, "/api/overview?compact=1");
  assert.equal(request.response.status, 200, request.result.error);
  assert.deepEqual(request.result.media, [], "扫描中的紧凑总览不得传输完整媒体库");
  await observeTurboScan(instance);

  request = await jsonRequest(instance.baseUrl, "/api/scan/start?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 202, request.result.error);
  const partialScan = await waitForTurboScanProgress(instance);
  assert.ok(partialScan.processedFiles < VIDEO_COUNT, "测试应在极速扫描完成前发出停止请求");

  request = await jsonRequest(instance.health.lanAddresses[0], "/api/scan/stop", { method: "POST" });
  assert.equal(request.response.status, 403, "局域网设备不能停止本机极速扫描");

  const stopStartedAt = Date.now();
  request = await jsonRequest(instance.baseUrl, "/api/scan/stop", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.ok(Date.now() - stopStartedAt < 1000, "手动停止必须立即响应，不能等待底层文件读取自行结束");
  assert.equal(request.result.stopped, true, "运行中的极速扫描必须可以手动停止");
  assert.equal(request.result.scan.scanning, false);
  assert.equal(request.result.scan.phase, "cancelled");
  assert.equal(request.result.scan.lastError, null, "手动停止不得显示为扫描故障");

  request = await jsonRequest(instance.baseUrl, "/api/overview");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.media.length, VIDEO_COUNT, "停止重新扫描后必须保留已保存的媒体索引");

  request = await jsonRequest(instance.baseUrl, "/api/scan/stop", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.stopped, false, "重复停止应安全地返回无任务状态");
  assert.equal(request.result.scan.phase, "cancelled");

  request = await jsonRequest(instance.baseUrl, "/api/scan?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, VIDEO_COUNT, "阻塞式 turbo 扫描必须保留既有响应语义");
  request = await jsonRequest(instance.baseUrl, "/api/overview");
  assert.equal(request.response.status, 200, request.result.error);
  assertScanShape(request.result.scan);
  assert.equal(request.result.scan.mode, "turbo");
  assert.equal(request.result.scan.progressPercent, 100);
  assert.equal(request.result.scan.maxParallelFiles, TURBO_CONCURRENCY);
  assert.equal(request.result.scan.maxParallelMediaTools, TURBO_MEDIA_TOOL_CONCURRENCY);

  request = await jsonRequest(instance.baseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, VIDEO_COUNT, "不带 mode 的普通阻塞扫描必须继续工作");
  assert.equal(request.result.media.length, VIDEO_COUNT);
  request = await jsonRequest(instance.baseUrl, "/api/overview");
  assert.equal(request.response.status, 200, request.result.error);
  assertScanShape(request.result.scan);
  assert.equal(request.result.scan.mode, "standard");
  assert.equal(request.result.scan.phase, "completed");
  assert.equal(request.result.scan.progressPercent, 100);
  assert.equal(request.result.scan.processedFiles, VIDEO_COUNT);

  console.log("极速扫描集成测试通过：目录去重、本机权限、模式校验、异步进度、手动停止、并发覆盖和普通扫描均正常。");
} finally {
  if (instance) await stopTestServer(instance);
  await rm(temporaryRoot, { recursive: true, force: true });
}
