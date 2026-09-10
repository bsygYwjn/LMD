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

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-access-test-"));
const testDataDirectory = path.join(temporaryRoot, "data");
const firstLibrary = path.join(temporaryRoot, "AccessA");
const secondLibrary = path.join(temporaryRoot, "AccessB");
const animeLibrary = path.join(temporaryRoot, "アニメ");
const bakemonogatariFolder = path.join(animeLibrary, "Monogatari Series", "01. Bakemonogatari");
const bakemonogatariPvFolder = path.join(bakemonogatariFolder, "PV");
const kizumonogatariFolder = path.join(animeLibrary, "Monogatari Series", "02. Kizumonogatari");
await mkdir(firstLibrary, { recursive: true });
await mkdir(secondLibrary, { recursive: true });
await mkdir(bakemonogatariPvFolder, { recursive: true });
await mkdir(kizumonogatariFolder, { recursive: true });
await writeFile(path.join(firstLibrary, "first.mp4"), Buffer.from("first-video-test-content"));
await writeFile(path.join(secondLibrary, "second.mp4"), Buffer.from("second-video-test-content"));
await writeFile(path.join(bakemonogatariFolder, "episode.mp4"), Buffer.from("bakemonogatari-episode"));
await writeFile(path.join(bakemonogatariPvFolder, "trailer.mp4"), Buffer.from("bakemonogatari-trailer"));
await writeFile(path.join(kizumonogatariFolder, "movie.mp4"), Buffer.from("kizumonogatari-movie"));

const port = await freePort();
const localBaseUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
  cwd: PROJECT_DIR,
  env: { ...process.env, LMD_PORT: String(port), LMD_DATA_DIR: testDataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverErrors = "";
serverProcess.stderr.setEncoding("utf8");
serverProcess.stderr.on("data", (chunk) => { serverErrors += chunk; });

try {
  const health = await waitForHealth(localBaseUrl, serverProcess);
  assert.ok(health.lanAddresses.length, "测试需要至少一个局域网 IPv4 地址");
  const lanBaseUrl = health.lanAddresses[0];

  let request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, "简洁版应允许局域网免登录访问");

  for (const folderPath of [firstLibrary, secondLibrary]) {
    request = await jsonRequest(localBaseUrl, "/api/libraries", { method: "POST", body: JSON.stringify({ folderPath }) });
    assert.equal(request.response.status, 201);
  }
  request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200);
  assert.equal(request.result.count, 2);

  request = await jsonRequest(localBaseUrl, "/api/overview");
  const overview = request.result;
  const firstFolder = overview.displayFolders.find((folder) => folder.folderName === "AccessA");
  const secondFolder = overview.displayFolders.find((folder) => folder.folderName === "AccessB");
  const secondMedia = overview.media.find((media) => media.fileName === "second.mp4");
  const firstMedia = overview.media.find((media) => media.fileName === "first.mp4");
  const allAgesCategory = overview.accessControl.categories.find((category) => category.name === "全年龄");
  const adultCategory = overview.accessControl.categories.find((category) => category.name === "R-18");
  const uncategorizedCategory = overview.accessControl.categories.find((category) => category.system);
  assert.ok(firstFolder && secondFolder && firstMedia && secondMedia);
  assert.ok(allAgesCategory && adultCategory, "新配置应预置“全年龄”和“R-18”分类");
  assert.equal(uncategorizedCategory?.name, "未分类", "访问控制应提供可直接授权的系统“未分类”分类");
  assert.deepEqual(new Set(uncategorizedCategory.folderIds), new Set([firstFolder.id, secondFolder.id]), "未归类文件夹应自动进入“未分类”");

  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "135790", categoryIds: [uncategorizedCategory.id] }),
  });
  assert.equal(request.response.status, 201);
  assert.deepEqual(request.result.categoryIds, [uncategorizedCategory.id]);

  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${firstFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: allAgesCategory.id }),
  });
  assert.equal(request.response.status, 200);
  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${secondFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: adultCategory.id }),
  });
  assert.equal(request.response.status, 200);

  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246810", categoryIds: [allAgesCategory.id] }),
  });
  assert.equal(request.response.status, 201);
  assert.deepEqual(request.result.categoryIds, [allAgesCategory.id]);
  assert.equal("name" in request.result, false, "访问用户不应再包含用户名");

  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246810", categoryIds: [adultCategory.id] }),
  });
  assert.equal(request.response.status, 409, "同一个六位访问码只能关联一个用户");

  request = await jsonRequest(localBaseUrl, "/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  assert.equal(request.response.status, 200);
  assert.equal(request.result.enabled, true);

  request = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "135790" }),
  });
  assert.equal(request.response.status, 200);
  const uncategorizedCookie = request.response.headers.get("set-cookie")?.split(";")[0];
  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: uncategorizedCookie } });
  assert.equal(request.result.media.length, 0, "所有文件夹已归类时，“未分类”授权不应泄露其他分类的视频");

  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${secondFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: null }),
  });
  assert.equal(request.response.status, 200);
  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: uncategorizedCookie } });
  assert.equal(request.result.media.length, 1, "移出自建分类的视频文件夹应立即对“未分类”授权用户可见");
  assert.equal(request.result.media[0].id, secondMedia.id);
  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${secondFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: adultCategory.id }),
  });
  assert.equal(request.response.status, 200);

  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 401, "开启访问控制后未登录请求应被拒绝");

  request = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "wrong-code" }),
  });
  assert.equal(request.response.status, 400, "非六位数字访问码应被拒绝");

  request = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "111111" }),
  });
  assert.equal(request.response.status, 401, "错误访问码应被拒绝");

  request = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246810" }),
  });
  assert.equal(request.response.status, 200);
  const cookie = request.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "登录应签发 HttpOnly 会话 Cookie");

  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: cookie } });
  assert.equal(request.response.status, 200);
  assert.equal(request.result.media.length, 1, "用户只能看到已授权分类中的视频");
  assert.equal(request.result.media[0].id, firstMedia.id);

  const allowedStream = await fetch(`${lanBaseUrl}/api/media/${firstMedia.id}/stream`, { headers: { Cookie: cookie, Range: "bytes=0-0" } });
  assert.equal(allowedStream.status, 206, "已授权视频应支持 Range 直传");
  const deniedStream = await fetch(`${lanBaseUrl}/api/media/${secondMedia.id}/stream`, { headers: { Cookie: cookie } });
  assert.equal(deniedStream.status, 404, "未授权视频直链也必须被后端拒绝");

  request = await jsonRequest(localBaseUrl, "/api/libraries", { method: "POST", body: JSON.stringify({ folderPath: animeLibrary }) });
  assert.equal(request.response.status, 201);
  const animeLibraryId = request.result.library.id;
  request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200);
  request = await jsonRequest(localBaseUrl, "/api/overview");
  const nestedOverview = request.result;
  const bakemonogatariAccessFolder = nestedOverview.accessFolders.find((folder) => folder.kind === "video" && folder.relativePath === "Monogatari Series / 01. Bakemonogatari");
  const kizumonogatariAccessFolder = nestedOverview.accessFolders.find((folder) => folder.kind === "video" && folder.relativePath === "Monogatari Series / 02. Kizumonogatari");
  assert.ok(bakemonogatariAccessFolder && kizumonogatariAccessFolder, "访问控制应列出大目录下最多两层的作品文件夹");
  assert.equal(bakemonogatariAccessFolder.mediaCount, 2, "作品文件夹应汇总更深层目录中的视频");
  assert.equal(nestedOverview.accessFolders.some((folder) => folder.relativePath?.endsWith(" / PV")), false, "更深层的 PV 文件夹不应成为独立权限项");

  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${bakemonogatariAccessFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: allAgesCategory.id }),
  });
  assert.equal(request.response.status, 200);
  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: cookie } });
  const visibleNames = new Set(request.result.media.map((media) => media.fileName));
  assert.equal(visibleNames.has("episode.mp4"), true, "授权作品文件夹后应允许其直属视频");
  assert.equal(visibleNames.has("trailer.mp4"), true, "授权作品文件夹后应允许更深层 PV 视频");
  assert.equal(visibleNames.has("movie.mp4"), false, "相邻作品文件夹不得因父目录相同而越权可见");
  request = await jsonRequest(localBaseUrl, `/api/libraries/${animeLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200);

  request = await jsonRequest(lanBaseUrl, "/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(request.response.status, 200);
  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: cookie } });
  assert.equal(request.response.status, 401, "退出后旧会话应立即失效");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    request = await jsonRequest(lanBaseUrl, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ accessCode: String(100000 + attempt) }),
    });
  }
  assert.equal(request.response.status, 429, "同一设备连续 5 次失败后应临时限制登录");
  assert.equal(request.result.code, "LOGIN_RATE_LIMITED");

  request = await jsonRequest(localBaseUrl, "/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(request.response.status, 200);
  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200);
  assert.equal(request.result.media.length, 2, "关闭访问控制应恢复原来的免登录简洁版");

  const secondLibraryId = overview.libraries.find((library) => library.path === secondLibrary)?.id;
  assert.ok(secondLibraryId, "应能找到待删除的视频目录");
  request = await jsonRequest(localBaseUrl, `/api/libraries/${secondLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200);
  assert.equal(request.result.removedMediaCount, 1, "删除目录应移除对应的媒体索引");
  request = await jsonRequest(localBaseUrl, "/api/overview");
  assert.equal(request.result.libraries.length, 1, "删除后目录列表应立即更新");
  assert.equal(request.result.media.length, 1, "删除后媒体列表应立即更新");
  assert.equal(request.result.accessControl.categories.some((category) => category.folderIds.includes(secondFolder.id)), false, "删除目录应清理旧的分类授权");

  request = await jsonRequest(localBaseUrl, `/api/libraries/${secondLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 404, "重复删除不存在的目录应给出明确结果");

  console.log("访问控制与目录删除集成测试通过：授权、直链拦截、限速、退出、关闭和安全移除目录均正常。");
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
  throw new Error(serverErrors || `测试服务退出码 ${serverProcess.exitCode}`);
}
