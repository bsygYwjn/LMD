import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
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
  const result = await response.json();
  return { response, result };
}

async function startTestServer(dataDirectory, extraEnvironment = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
    cwd: PROJECT_DIR,
    env: { ...process.env, LMD_PORT: String(port), LMD_DATA_DIR: dataDirectory, ...extraEnvironment },
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
    throw new Error(instance.errors() || `测试服务退出码 ${instance.child.exitCode}`);
  }
}

async function waitForInstallTerminal(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { result } = await jsonRequest(baseUrl, "/api/tools/install/status");
    last = result;
    if (!["downloading", "extracting", "installing"].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待 FFmpeg 安装状态超时，最后状态：${JSON.stringify(last)}`);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 生成一个“存储式”（不压缩）的最小合法 ZIP，供测试下载与解压流程使用。
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // 存储式，不压缩
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

// 模拟 gyan.dev：提供版本号文本与 FFmpeg 压缩包；chunkDelayMs 用于放慢下载以便测试取消。
function startFakeDownloadServer(zipBuffer, { chunkDelayMs = 0 } = {}) {
  const server = createHttpServer((request, response) => {
    response.on("error", () => {});
    if (request.url === "/release-version") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("99.0.0");
      return;
    }
    if (request.url === "/ffmpeg.zip") {
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zipBuffer.length });
      if (!chunkDelayMs) return response.end(zipBuffer);
      const chunkSize = Math.max(1, Math.ceil(zipBuffer.length / 6));
      let position = 0;
      const timer = setInterval(() => {
        const chunk = zipBuffer.subarray(position, position + chunkSize);
        position += chunkSize;
        response.write(chunk);
        if (position >= zipBuffer.length) {
          clearInterval(timer);
          response.end();
        }
      }, chunkDelayMs);
      request.on("close", () => clearInterval(timer));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` });
    });
  });
}

function closeFakeServer(fake) {
  fake.server.closeAllConnections?.();
  fake.server.close();
}

const dummyExecutable = Buffer.from("LMD-FFMPEG-INSTALL-TEST dummy executable\r\n", "utf8");
const fakeZip = buildStoredZip([
  { name: "ffmpeg-test-99.0.0/bin/ffmpeg.exe", data: dummyExecutable },
  { name: "ffmpeg-test-99.0.0/bin/ffprobe.exe", data: dummyExecutable },
  { name: "ffmpeg-test-99.0.0/bin/ffplay.exe", data: dummyExecutable },
]);

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-ffmpeg-install-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
await mkdir(dataDirectory, { recursive: true });

// 场景一：完整安装流程。压缩包里是假的 exe，安装后校验必然失败，
// 验证“下载 → 解压 → 替换 → 校验失败 → 回滚清理”整条链路。
{
  const fake = await startFakeDownloadServer(fakeZip);
  const installDirectory = path.join(temporaryRoot, "ffmpeg-a");
  const instance = await startTestServer(dataDirectory, {
    LMD_FFMPEG_DOWNLOAD_URL: `${fake.baseUrl}/ffmpeg.zip`,
    LMD_FFMPEG_VERSION_URL: `${fake.baseUrl}/release-version`,
    LMD_FFMPEG_INSTALL_DIR: installDirectory,
  });
  try {
    let request = await jsonRequest(instance.baseUrl, "/api/tools/install/status");
    assert.equal(request.response.status, 200);
    assert.equal(request.result.status, "idle");
    assert.equal(request.result.progress, 0);

    request = await jsonRequest(instance.baseUrl, "/api/overview?compact=1");
    assert.equal(request.response.status, 200);
    assert.equal(request.result.tools.available, false);
    assert.equal(request.result.tools.installable, true);
    assert.equal(request.result.tools.source, null);
    assert.match(request.result.tools.hint || "", /自动安装 FFmpeg/);

    request = await jsonRequest(instance.baseUrl, "/api/tools/install", { method: "POST" });
    assert.equal(request.response.status, 200);
    assert.equal(request.result.started, true);
    assert.equal(request.result.latestVersion, "99.0.0");

    // 安装进行中再次请求必须被拒绝。
    request = await jsonRequest(instance.baseUrl, "/api/tools/install", { method: "POST" });
    assert.equal(request.response.status, 409);

    const finalState = await waitForInstallTerminal(instance.baseUrl);
    assert.equal(finalState.status, "failed");
    assert.match(finalState.error, /无法运行新版本 FFmpeg/);
    assert.equal(finalState.latestVersion, "99.0.0");

    // 首次安装失败后不应残留半成品：bin 与 .install 都应被清理。
    await assert.rejects(() => stat(path.join(installDirectory, "bin")), { code: "ENOENT" });
    await assert.rejects(() => stat(path.join(installDirectory, ".install")), { code: "ENOENT" });

    // 媒体工具状态保持不变（仍不可用）。
    request = await jsonRequest(instance.baseUrl, "/api/overview?compact=1");
    assert.equal(request.result.tools.available, false);
  } finally {
    await stopTestServer(instance);
    closeFakeServer(fake);
  }
}

// 场景二：下载过程中取消安装。
{
  const fake = await startFakeDownloadServer(fakeZip, { chunkDelayMs: 250 });
  const installDirectory = path.join(temporaryRoot, "ffmpeg-b");
  const instance = await startTestServer(dataDirectory, {
    LMD_FFMPEG_DOWNLOAD_URL: `${fake.baseUrl}/ffmpeg.zip`,
    LMD_FFMPEG_VERSION_URL: `${fake.baseUrl}/release-version`,
    LMD_FFMPEG_INSTALL_DIR: installDirectory,
  });
  try {
    let request = await jsonRequest(instance.baseUrl, "/api/tools/install", { method: "POST" });
    assert.equal(request.result.started, true);

    // 等待下载开始后取消。
    await new Promise((resolve) => setTimeout(resolve, 400));
    request = await jsonRequest(instance.baseUrl, "/api/tools/install/cancel", { method: "POST" });
    assert.equal(request.response.status, 200);
    assert.equal(request.result.cancelled, true);

    const finalState = await waitForInstallTerminal(instance.baseUrl);
    assert.equal(finalState.status, "cancelled");
    assert.equal(finalState.error, "");

    // 取消时不应触碰 bin，也不应残留临时文件。
    await assert.rejects(() => stat(path.join(installDirectory, "bin")), { code: "ENOENT" });
    await assert.rejects(() => stat(path.join(installDirectory, ".install")), { code: "ENOENT" });
  } finally {
    await stopTestServer(instance);
    closeFakeServer(fake);
  }
}

await rm(temporaryRoot, { recursive: true, force: true });
console.log("FFmpeg 自动安装/更新测试全部通过。");
