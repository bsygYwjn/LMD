import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "lmd-user-mutations-"));
await writeFile(path.join(directory, "state.json"), JSON.stringify({ version: 11, settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false } }));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.mjs"], { cwd: project, env: { ...process.env, LMD_DATA_DIR: directory, LMD_PORT: String(port), LMD_HOST: "0.0.0.0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
async function request(route, body, method = body ? "POST" : "GET", headers = {}, origin = base) {
  // Use native HTTP because fetch can normalize or discard a custom Host header.
  return new Promise((resolve, reject) => {
    const pending = httpRequest(origin + route, { method, headers: { "Content-Type": "application/json", ...headers } }, response => {
      const chunks = [];
      response.on("data", data => chunks.push(data));
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: { get: name => { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(",") : value; } } });
        } catch (error) { reject(error); }
      });
    });
    pending.on("error", reject);
    pending.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  let health;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output);
    try { const result = await request("/api/health"); if (result.status === 200) { health = result.body; break; } } catch { /* Wait for the isolated server. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(health, output || "isolated server startup timed out");
  for (const localHost of ["localhost", "LOCALHOST.", "127.0.0.1", "[::1]", domainToASCII(hostname()), ...health.lanAddresses.map(address => new URL(address).hostname)]) {
    assert.equal((await request("/api/overview", undefined, "GET", { Host: `${localHost}:${port}` })).status, 200, `trusted local host ${localHost} remains supported`);
  }
  for (const route of ["/api/overview", "/api/catalog", "/api/labels/status"]) {
    const rejected = await request(route, undefined, "GET", { Host: `attacker.example:${port}` });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.code, "HOST_REJECTED");
  }
  assert.equal((await request("/api/access-control", { enabled: true }, "PATCH", { Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` })).status, 403);
  const lan = health.lanAddresses[0];
  assert.ok(lan, "access-control tests require a local LAN address");
  assert.equal((await request("/api/catalog", undefined, "GET", { Host: `media.example:${port}` }, lan)).status, 200, "legitimate LAN viewers may still use their configured DNS host");
  const overview = (await request("/api/overview")).body;
  const categories = overview.accessControl.categories.filter(category => !category.system);
  const firstCategories = [categories[0].id], secondCategories = [categories[1].id];
  const duplicate = await Promise.all([
    request("/api/access-control/users", { accessCode: "123456", categoryIds: firstCategories }),
    request("/api/access-control/users", { accessCode: "123456", categoryIds: secondCategories }),
  ]);
  assert.deepEqual(duplicate.map(result => result.status).sort(), [201, 409], "concurrent creates cannot assign the same access code to different users");
  const first = duplicate.find(result => result.status === 201).body;
  const second = (await request("/api/access-control/users", { accessCode: "234567", categoryIds: secondCategories })).body;
  await request("/api/access-control", { enabled: true }, "PATCH");
  const login = await request("/api/auth/login", { accessCode: "123456" }, "POST", {}, lan);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const original = (await request("/api/overview")).body.accessControl.users.find(user => user.id === first.id);
  for (const [body, status] of [
    [{ categoryIds: secondCategories, enabled: "invalid" }, 400],
    [{ categoryIds: secondCategories, enabled: false, accessCode: "invalid" }, 400],
    [{ categoryIds: secondCategories, enabled: false, accessCode: "234567" }, 409],
  ]) {
    assert.equal((await request(`/api/access-control/users/${first.id}`, body, "PATCH")).status, status);
    const after = (await request("/api/overview")).body.accessControl.users.find(user => user.id === first.id);
    assert.deepEqual(after, original, "a rejected update must preserve all permissions and timestamps");
    assert.equal((await request("/api/auth/status", undefined, "GET", { Cookie: cookie }, lan)).body.authenticated, true, "a rejected update must preserve live sessions");
  }
  const changed = await Promise.all([first, second].map(user => request(`/api/access-control/users/${user.id}`, { accessCode: "345678" }, "PATCH")));
  assert.deepEqual(changed.map(result => result.status).sort(), [200, 409], "concurrent code updates cannot produce duplicate credentials");
  assert.equal((await request(`/api/access-control/users/${first.id}`, { enabled: false }, "PATCH")).status, 200);
  assert.equal((await request("/api/auth/status", undefined, "GET", { Cookie: cookie }, lan)).body.authenticated, false);
  console.log("Access user mutations passed: trusted local hosts, LAN DNS compatibility, unique concurrent credentials, and atomic rejected permission/session updates.");
} finally {
  if (child.exitCode === null) {
    const exit = new Promise(resolve => child.once("exit", resolve));
    const timer = setTimeout(() => child.kill(), 5000);
    try { await request("/api/service/stop", {}); } catch { child.kill(); }
    await exit;
    clearTimeout(timer);
  }
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("lmd-user-mutations-"));
  await rm(directory, { recursive: true, force: true });
}
