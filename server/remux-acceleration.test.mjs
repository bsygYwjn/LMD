import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

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

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-remux-acceleration-test-"));
const testDataDirectory = path.join(temporaryRoot, "data");
await mkdir(testDataDirectory, { recursive: true });

let instance;
try {
  instance = await startTestServer(testDataDirectory);
  let request = await jsonRequest(instance.baseUrl, "/api/overview");
  assert.equal(request.response.status, 200);
  assert.equal(request.result.remuxAcceleration.enabled, false);
  assert.equal(request.result.remuxAcceleration.maxParallelJobs, 1);
  assert.equal(request.result.remuxAcceleration.acceleratedParallelJobs, 3);

  request = await jsonRequest(instance.baseUrl, "/api/settings/remux-acceleration", {
    method: "PATCH",
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(request.response.status, 400, "非布尔开关值必须被拒绝");

  assert.ok(instance.health.lanAddresses.length, "测试需要至少一个局域网 IPv4 地址");
  request = await jsonRequest(instance.health.lanAddresses[0], "/api/settings/remux-acceleration", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(request.response.status, 403, "局域网设备不能开启本机重封装加速");

  const enabledAfter = Date.now();
  request = await jsonRequest(instance.baseUrl, "/api/settings/remux-acceleration", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  const enabledBefore = enabledAfter - 1000;
  assert.equal(request.response.status, 200);
  assert.equal(request.result.remuxAcceleration.enabled, true);
  assert.equal(request.result.remuxAcceleration.maxParallelJobs, 3);
  const productionExpiresAt = Date.parse(request.result.remuxAcceleration.expiresAt);
  assert.ok(productionExpiresAt >= enabledBefore + TWELVE_HOURS_MS);
  assert.ok(productionExpiresAt <= Date.now() + TWELVE_HOURS_MS + 1000);
  await stopTestServer(instance);
  instance = null;

  instance = await startTestServer(testDataDirectory);
  request = await jsonRequest(instance.baseUrl, "/api/overview");
  assert.equal(request.result.remuxAcceleration.enabled, true, "服务重启后未到期的加速应继续生效");
  assert.equal(Date.parse(request.result.remuxAcceleration.expiresAt), productionExpiresAt, "重启不能重新延长 12 小时");
  request = await jsonRequest(instance.baseUrl, "/api/settings/remux-acceleration", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(request.result.remuxAcceleration.enabled, false);
  assert.equal(request.result.remuxAcceleration.maxParallelJobs, 1);
  await stopTestServer(instance);
  instance = null;

  instance = await startTestServer(testDataDirectory, {
    NODE_ENV: "test",
    LMD_REMUX_ACCELERATION_DURATION_MS: "300",
  });
  request = await jsonRequest(instance.baseUrl, "/api/settings/remux-acceleration", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(request.result.remuxAcceleration.enabled, true);
  await new Promise((resolve) => setTimeout(resolve, 800));
  let persistedState = JSON.parse(await readFile(path.join(testDataDirectory, "state.json"), "utf8"));
  assert.equal(persistedState.settings.remuxAccelerationExpiresAt, null, "服务端定时器必须主动持久化自动关闭结果");
  request = await jsonRequest(instance.baseUrl, "/api/overview");
  assert.equal(request.result.remuxAcceleration.enabled, false, "加速到期后应自动关闭");
  assert.equal(request.result.remuxAcceleration.expiresAt, null);
  assert.equal(request.result.remuxAcceleration.maxParallelJobs, 1);
  persistedState = JSON.parse(await readFile(path.join(testDataDirectory, "state.json"), "utf8"));
  assert.equal(persistedState.settings.remuxAccelerationExpiresAt, null, "自动关闭结果必须持久化");

  console.log("重封装并行加速集成测试通过：本机权限、3 路上限、12 小时期限、重启续期和自动关闭均正常。");
} finally {
  if (instance) await stopTestServer(instance);
  await rm(temporaryRoot, { recursive: true, force: true });
}
