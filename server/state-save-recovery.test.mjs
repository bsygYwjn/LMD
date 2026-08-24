import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(SERVER_DIR, "index.mjs");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "lmd-state-save-recovery-"));
const dataDirectory = path.join(temporaryRoot, "data");

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待测试服务启动超时");
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  return { response, result: await response.json() };
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [SERVER_ENTRY], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    LMD_HOST: "127.0.0.1",
    LMD_PORT: String(port),
    LMD_DATA_DIR: dataDirectory,
    LMD_STARTUP_DIR: path.join(temporaryRoot, "startup"),
    LMD_TEST_FAIL_STATE_REPLACE_NUMBER: "2",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { serverOutput += chunk; });
child.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  await waitForHealth(baseUrl, child);

  let request = await jsonRequest(baseUrl, "/api/access-control", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(request.response.status, 500, "注入的首次状态替换失败应返回 500");
  assert.match(request.result.error, /替换状态文件失败/);

  request = await jsonRequest(baseUrl, "/api/access-control", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(request.response.status, 200, "失败后的下一次保存必须重新启动队列并成功");
  assert.equal(request.result.enabled, false);

  let storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(storedState.accessControl.enabled, false, "恢复后的保存结果必须真正写入磁盘");

  request = await jsonRequest(baseUrl, "/api/access-control", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(request.response.status, 200, "保存队列恢复后应能持续处理后续保存");
  storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(storedState.accessControl.enabled, true);

  console.log("状态保存恢复测试通过：一次替换失败不会永久阻塞后续持久化。");
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  child.kill();
  await new Promise((resolve) => child.once("close", resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
