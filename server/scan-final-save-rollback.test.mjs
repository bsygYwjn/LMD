import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`test server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for test server");
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  return { response, result: await response.json() };
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-final-save-rollback-"));
const dataDirectory = path.join(temporaryRoot, "data");
const libraryDirectory = path.join(temporaryRoot, "library");
const retainedVideo = path.join(libraryDirectory, "retained.mp4");
const removedVideo = path.join(libraryDirectory, "removed.mp4");
await mkdir(libraryDirectory, { recursive: true });
await writeFile(retainedVideo, Buffer.from("retained"));
await writeFile(removedVideo, Buffer.from("removed"));

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    NODE_ENV: "test",
    LMD_PORT: String(port),
    LMD_DATA_DIR: dataDirectory,
    LMD_TEST_FAIL_FINAL_SCAN_SAVE_NUMBER: "2",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
serverProcess.stderr.setEncoding("utf8");
serverProcess.stderr.on("data", (chunk) => { serverErrors += chunk; });

try {
  await waitForHealth(baseUrl, serverProcess);
  let request = await jsonRequest(baseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: libraryDirectory, name: "rollback library" }),
  });
  assert.equal(request.response.status, 201, request.result.error);

  request = await jsonRequest(baseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, 2);

  await rm(removedVideo);
  request = await jsonRequest(baseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 500, "the injected final save failure must fail the scan");
  assert.match(request.result.error, /最终扫描状态保存失败/);

  request = await jsonRequest(baseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.deepEqual(request.result.media.map((media) => media.fileName).sort(), ["removed.mp4", "retained.mp4"]);

  const storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.deepEqual(storedState.media.map((media) => media.fileName).sort(), ["removed.mp4", "retained.mp4"]);

  request = await jsonRequest(baseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, 1);
  assert.deepEqual(request.result.media.map((media) => media.fileName), ["retained.mp4"]);
  console.log("final scan save rollback test passed");
} finally {
  try { await fetch(`${baseUrl}/api/service/stop`, { method: "POST" }); }
  catch { /* The test server may already have exited. */ }
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
  throw new Error(serverErrors || `test server exited with code ${serverProcess.exitCode}`);
}
