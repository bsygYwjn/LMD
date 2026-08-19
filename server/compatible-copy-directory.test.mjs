import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SERVER_DIR, "..");

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return typeof address === "object" && address ? address.port : 0;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出，退出码 ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待测试服务启动超时");
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-compatible-directory-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const cacheDirectory = path.join(dataDirectory, "cache");
const destinationDirectory = path.join(temporaryRoot, "compatible-videos");
const cachedFileName = "existing-v2-test.mp4";
const cachedFile = path.join(cacheDirectory, cachedFileName);
await mkdir(cacheDirectory, { recursive: true });
await writeFile(cachedFile, Buffer.from("existing-compatible-video"));

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
  cwd: PROJECT_DIR,
  env: { ...process.env, LMD_PORT: String(port), LMD_DATA_DIR: dataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
serverProcess.stderr.setEncoding("utf8");
serverProcess.stderr.on("data", (chunk) => { serverErrors += chunk; });

try {
  await waitForHealth(baseUrl, serverProcess);
  const response = await fetch(`${baseUrl}/api/settings/compatible-copy-directory`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directoryPath: destinationDirectory, moveExisting: true }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.directory, path.resolve(destinationDirectory));
  assert.equal(result.movedFiles, 1);
  assert.equal(result.movedBytes, Buffer.byteLength("existing-compatible-video"));
  assert.equal((await stat(cachedFile).catch(() => null)), null, "旧缓存文件应被移走");
  assert.equal(await readFile(path.join(destinationDirectory, cachedFileName), "utf8"), "existing-compatible-video");

  const overview = await (await fetch(`${baseUrl}/api/overview`)).json();
  assert.equal(overview.settings.compatibleCopyDirectory, path.resolve(destinationDirectory));
  console.log("兼容视频自定义地址测试通过：新目录创建、现有副本迁移和设置持久化均正常。");
} finally {
  try { await fetch(`${baseUrl}/api/service/stop`, { method: "POST" }); }
  catch { /* 服务可能已经退出。 */ }
  await new Promise((resolve) => {
    if (serverProcess.exitCode !== null) return resolve();
    const timer = setTimeout(() => { serverProcess.kill(); resolve(); }, 4000);
    serverProcess.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (serverProcess.exitCode && serverProcess.exitCode !== 0) {
  throw new Error(serverErrors || `测试服务退出码 ${serverProcess.exitCode}`);
}
