// BUG-01/02 regression against a real isolated backend and a production build.
// Only /api/folders/select is mocked: Playwright supplies the result of the
// Windows native dialog. Library registration, validation, persistence, and
// React form handling use the real application. No requests reach port 8096.
// Run after build; optionally set LMD_FRONTEND_DIST / LMD_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = await import(process.env.LMD_PLAYWRIGHT_MODULE || "playwright");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.env.LMD_FRONTEND_DIST || path.join(project, "dist"));
await readFile(path.join(dist, "index.html"));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-files-admin-browser-"));
const dataDirectory = path.join(temporaryRoot, "state");
const selectedDirectory = path.join(temporaryRoot, "选择器添加的文件夹");
const correctedDirectory = path.join(temporaryRoot, "手填纠正的文件夹");
await Promise.all([dataDirectory, selectedDirectory, correctedDirectory].map(directory => mkdir(directory)));
await writeFile(path.join(dataDirectory, "state.json"), JSON.stringify({ settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false } }));
await writeFile(path.join(selectedDirectory, "原件保持不变.txt"), "isolated sentinel", "utf8");
const probe = createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
assert.notEqual(port, 8096, "regression must never address the live service");
const base = `http://127.0.0.1:${port}`;
let browser, child, serverErrors = "";

async function waitUntil(predicate, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${description}`);
}
async function overview() {
  const response = await fetch(`${base}/api/files/overview`);
  assert.equal(response.status, 200);
  return response.json();
}
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  await fetch(`${base}/api/service/stop`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => {});
  const stopped = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
  if (!stopped) { child.kill(); await Promise.race([exited, delay(5000)]); }
}

try {
  child = spawn(process.execPath, [path.join(project, "server/index.mjs")], {
    cwd: project, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, LMD_PORT: String(port), LMD_DATA_DIR: dataDirectory, LMD_WEB_DIR: dist },
  });
  child.stderr.on("data", bytes => { serverErrors += bytes; });
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`Isolated backend exited: ${serverErrors}`);
    try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, "isolated backend startup", 20000);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [], pickerReplies = [], registrations = [];
  let pickerCalls = 0;
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => {
    assert.ok(request.url().startsWith(`${base}/`) || /^(?:data|blob):/.test(request.url()), `Unexpected external request: ${request.url()}`);
    if (request.url() === `${base}/api/files/libraries` && request.method() === "POST") registrations.push(request.postDataJSON());
  });
  await page.route(`${base}/api/folders/select`, async route => {
    assert.equal(route.request().method(), "POST");
    const reply = pickerReplies.shift();
    assert.ok(reply, "Unexpected folder picker request");
    pickerCalls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply) });
  });
  const nextRegistration = () => page.waitForResponse(response => response.url() === `${base}/api/files/libraries` && response.request().method() === "POST");
  const nextPicker = () => page.waitForResponse(response => response.url() === `${base}/api/folders/select`);

  await page.goto(`${base}/admin`);
  const panel = page.locator(".adm-section").filter({ has: page.getByRole("heading", { name: "其他文件共享", exact: true }) });
  await panel.waitFor();
  const input = panel.getByLabel("其他文件共享目录");
  const choose = panel.getByRole("button", { name: "选择并添加文件夹", exact: true });
  const submit = panel.getByRole("button", { name: "添加路径", exact: true });
  assert.equal(await choose.count(), 1, "BUG-01: the files panel needs an independent native folder selection action");
  assert.equal(await input.inputValue(), "");
  assert.equal(await choose.isEnabled(), true, "BUG-01: picker must be usable before a path is typed");
  assert.equal(await submit.isDisabled(), true, "manual submit still requires a non-empty path");

  // Successful selector result must flow into the real API and persisted state.
  pickerReplies.push({ cancelled: false, path: selectedDirectory });
  let pendingRegistration = nextRegistration();
  await choose.click();
  let response = await pendingRegistration;
  assert.equal(response.status(), 201, await response.text());
  await panel.getByText(selectedDirectory, { exact: true }).waitFor();
  await waitUntil(async () => (await choose.isEnabled()) && (await input.inputValue()) === "", "picker success clears input and restores controls");
  assert.equal(pickerCalls, 1);
  assert.deepEqual(registrations, [{ folderPath: selectedDirectory }]);
  assert.deepEqual((await overview()).libraries.map(library => library.path), [selectedDirectory]);
  const persisted = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.deepEqual(persisted.fileLibraries.map(library => library.path), [selectedDirectory]);
  console.log("PASS BUG-01: an empty input can open the picker; its selected directory is registered and persisted by the real backend");

  // Cancelling selection neither submits a path nor loses a previously typed one.
  const preservedOnCancel = path.join(temporaryRoot, "尚未提交的路径");
  await input.fill(preservedOnCancel);
  pickerReplies.push({ cancelled: true, path: null });
  const pendingPicker = nextPicker();
  await choose.click(); await pendingPicker;
  await waitUntil(() => choose.isEnabled(), "picker cancellation restores controls");
  assert.equal(await input.inputValue(), preservedOnCancel);
  assert.equal(registrations.length, 1);
  assert.equal((await overview()).libraries.length, 1);
  console.log("PASS picker cancellation: no registration and the existing manual input is retained");

  // A real 400 response must retain the exact manually entered value, including
  // surrounding spaces, while the request itself receives the trimmed path.
  const nonexistentDirectory = path.join(temporaryRoot, "这个文件夹不存在");
  const entered = `  ${nonexistentDirectory}  `;
  await input.fill(entered);
  pendingRegistration = nextRegistration();
  await submit.click(); response = await pendingRegistration;
  assert.equal(response.status(), 400);
  const failure = await response.json();
  await page.getByText(failure.error, { exact: true }).waitFor();
  await waitUntil(() => submit.isEnabled(), "failed manual submit restores controls");
  assert.equal(await input.inputValue(), entered, "BUG-02: a rejected path must remain editable");
  assert.deepEqual(registrations.at(-1), { folderPath: nonexistentDirectory });
  assert.equal((await overview()).libraries.length, 1);
  console.log("PASS BUG-02: real directory-validation failure keeps the exact manual input and enables correction");

  // A picker result can become invalid before registration (for example, the
  // directory was removed). That failure must keep the selected path as well.
  const staleSelection = path.join(temporaryRoot, "选择后已消失的目录");
  pickerReplies.push({ cancelled: false, path: staleSelection });
  pendingRegistration = nextRegistration();
  await choose.click(); response = await pendingRegistration;
  assert.equal(response.status(), 400);
  await waitUntil(() => submit.isEnabled(), "failed picker registration restores controls");
  assert.equal(await input.inputValue(), staleSelection);
  assert.equal((await overview()).libraries.length, 1);

  // Correct the rejected path and use Enter to prove that the manual form
  // remains functional after both failures.
  await input.fill(correctedDirectory);
  pendingRegistration = nextRegistration();
  await input.press("Enter"); response = await pendingRegistration;
  assert.equal(response.status(), 201, await response.text());
  await panel.getByText(correctedDirectory, { exact: true }).waitFor();
  await waitUntil(async () => (await choose.isEnabled()) && (await input.inputValue()) === "", "successful retry clears only the accepted input");
  assert.deepEqual((await overview()).libraries.map(library => library.path), [selectedDirectory, correctedDirectory]);
  assert.equal(registrations.length, 4);
  assert.equal(pickerCalls, 3);
  assert.equal(pickerReplies.length, 0);
  assert.deepEqual(pageErrors, []);
  assert.equal(await readFile(path.join(selectedDirectory, "原件保持不变.txt"), "utf8"), "isolated sentinel");
  console.log("PASS picker registration failure retains its path; correcting it and pressing Enter succeeds without touching original files");
} finally {
  await browser?.close();
  await stopChild();
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("lmd-files-admin-browser-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}
