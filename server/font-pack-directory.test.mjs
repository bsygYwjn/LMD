import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers,
  });
  return { response, result: await response.json() };
}

function testFont() {
  const names = [
    [1, "Series Font"],
    [2, "Regular"],
    [4, "Series Font Regular"],
    [6, "SeriesFont-Regular"],
  ].map(([nameId, value]) => {
    const bytes = Buffer.from(value, "utf16le");
    bytes.swap16();
    return { nameId, bytes };
  });
  const recordBytes = names.length * 12;
  const stringOffset = 6 + recordBytes;
  const stringBytes = names.reduce((total, name) => total + name.bytes.length, 0);
  const nameTable = Buffer.alloc(stringOffset + stringBytes);
  nameTable.writeUInt16BE(0, 0);
  nameTable.writeUInt16BE(names.length, 2);
  nameTable.writeUInt16BE(stringOffset, 4);
  let currentStringOffset = 0;
  names.forEach((name, index) => {
    const recordOffset = 6 + index * 12;
    nameTable.writeUInt16BE(3, recordOffset);
    nameTable.writeUInt16BE(1, recordOffset + 2);
    nameTable.writeUInt16BE(0x0409, recordOffset + 4);
    nameTable.writeUInt16BE(name.nameId, recordOffset + 6);
    nameTable.writeUInt16BE(name.bytes.length, recordOffset + 8);
    nameTable.writeUInt16BE(currentStringOffset, recordOffset + 10);
    name.bytes.copy(nameTable, stringOffset + currentStringOffset);
    currentStringOffset += name.bytes.length;
  });

  const font = Buffer.alloc(28 + nameTable.length);
  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(1, 4);
  font.write("name", 12, "ascii");
  font.writeUInt32BE(28, 20);
  font.writeUInt32BE(nameTable.length, 24);
  nameTable.copy(font, 28);
  return font;
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-font-pack-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const libraryDirectory = path.join(temporaryRoot, "FontPackLibrary");
const fontDirectory = path.join(libraryDirectory, "Fonts", "SeriesFonts");
const expectedFont = testFont();
await mkdir(fontDirectory, { recursive: true });
await writeFile(path.join(libraryDirectory, "episode.mp4"), Buffer.from("test-video"));
await writeFile(path.join(libraryDirectory, "episode.ass"), Buffer.from("[Script Info]\nScriptType: v4.00+\n"));
await writeFile(path.join(fontDirectory, "series-font.ttf"), expectedFont);

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
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
  await waitForHealth(baseUrl, serverProcess);
  await jsonRequest(baseUrl, "/api/settings/auto-scan", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });
  let request = await jsonRequest(baseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: libraryDirectory, name: "字体包测试" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  request = await jsonRequest(baseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);

  const catalog = await (await fetch(`${baseUrl}/api/catalog`)).json();
  assert.equal(catalog.media.length, 1);
  assert.deepEqual(catalog.media[0].fonts.map((font) => font.name), ["series-font.ttf"]);
  assert.deepEqual(catalog.media[0].fonts[0].aliases, ["Series Font", "Series Font Regular", "SeriesFont-Regular"]);
  const fontResponse = await fetch(`${baseUrl}${catalog.media[0].fonts[0].url}`);
  assert.equal(fontResponse.status, 200);
  assert.deepEqual(Buffer.from(await fontResponse.arrayBuffer()), expectedFont);
  console.log("font pack directory test passed");
} finally {
  await fetch(`${baseUrl}/api/service/stop`, { method: "POST" }).catch(() => {});
  await new Promise((resolve) => {
    if (serverProcess.exitCode !== null) return resolve();
    serverProcess.once("exit", resolve);
    setTimeout(() => {
      serverProcess.kill();
      resolve();
    }, 5000).unref();
  });
  await rm(temporaryRoot, { recursive: true, force: true });
  if (serverErrors) process.stderr.write(serverErrors);
}
