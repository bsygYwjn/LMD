import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

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
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

function assertNoPaths(value, location = "catalog") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoPaths(item, `${location}[${index}]`));
  for (const [key, item] of Object.entries(value)) {
    assert.doesNotMatch(key, /path$/i, `${location}.${key} 不应暴露本地路径`);
    assertNoPaths(item, `${location}.${key}`);
  }
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-photos-library-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const photoRoot = path.join(temporaryRoot, "Photos");
const galleryFolder = path.join(photoRoot, "相册");
const nestedLibrary = path.join(photoRoot, "私密相册");
const brokenLibrary = path.join(temporaryRoot, "稍后移除");
const formats = ["jpg", "jpeg", "jpe", "jfif", "png", "apng", "gif", "webp", "avif", "bmp", "dib", "ico", "svg", "tif", "tiff"];
const pixel = Buffer.concat([
  Buffer.from("P6\n2 3\n255\n", "ascii"),
  Buffer.from([255, 90, 120, 64, 210, 255, 255, 210, 70, 98, 72, 255, 40, 40, 48, 240, 240, 245]),
]);

await mkdir(dataDirectory, { recursive: true });
await mkdir(galleryFolder, { recursive: true });
await mkdir(nestedLibrary, { recursive: true });
await mkdir(brokenLibrary, { recursive: true });
for (const extension of formats) {
  const destination = extension === "tiff" ? nestedLibrary : galleryFolder;
  const content = extension === "svg"
    ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#64d2ff"/></svg>')
    : pixel;
  await writeFile(path.join(destination, `样例.${extension}`), content);
}
await writeFile(path.join(galleryFolder, "忽略.heic"), pixel);
await writeFile(path.join(dataDirectory, "state.json"), JSON.stringify({
  version: 10,
  libraries: [],
  media: [],
  musicLibraries: [],
  musicTracks: [],
  readingLibraries: [],
  readingItems: [],
  jobs: [],
  displayGroups: [],
  accessControl: { enabled: false, users: [], sessions: [], categories: [] },
  settings: { autoScanEnabled: false, autoScanIntervalSeconds: 30, autoPrepareCompatibleCopies: false, maxStreams: 10 },
}), "utf8");

const port = await freePort();
const localBaseUrl = `http://127.0.0.1:${port}`;
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
  const health = await waitForHealth(localBaseUrl, serverProcess);
  assert.ok(health.lanAddresses.length, "权限测试需要至少一个局域网 IPv4 地址");
  const lanBaseUrl = health.lanAddresses[0];

  let request = await jsonRequest(localBaseUrl, "/api/photos/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: photoRoot, name: "家庭图片" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const rootLibraryId = request.result.library.id;
  request = await jsonRequest(localBaseUrl, "/api/photos/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: nestedLibrary, name: "私密图片" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const nestedLibraryId = request.result.library.id;

  request = await jsonRequest(localBaseUrl, "/api/photos/catalog/scan?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, formats.length, "重叠图片目录中的文件只能建立一次索引");

  request = await jsonRequest(lanBaseUrl, "/api/photos/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.items.length, formats.length);
  assertNoPaths(request.result);
  assert.equal(JSON.stringify(request.result).includes(temporaryRoot), false, "观看端图片目录不得包含绝对路径");
  assert.deepEqual(new Set(request.result.items.map((item) => item.extension)), new Set(formats.map((extension) => extension.toUpperCase())));
  assert.equal(request.result.items.find((item) => item.extension === "TIFF").libraryId, nestedLibraryId, "最深层注册目录应拥有重叠图片");
  assert.ok(request.result.folders.some((folder) => folder.parentId), "图片目录应保留嵌套文件夹树");
  assert.ok(request.result.items.every((item) => item.downloadUrl.endsWith("?download=1")));
  assert.ok(request.result.items.every((item) => item.width && item.height), "有效图片应记录尺寸供瀑布流预留布局");

  const jpg = request.result.items.find((item) => item.extension === "JPG");
  const tiff = request.result.items.find((item) => item.extension === "TIFF");
  assert.ok(tiff.previewUrl, serverErrors || "TIFF 应生成浏览器兼容预览");
  let fileResponse = await fetch(`${lanBaseUrl}${jpg.downloadUrl}`, { method: "HEAD" });
  assert.equal(fileResponse.status, 200);
  assert.match(fileResponse.headers.get("content-disposition") || "", /^attachment;/);
  assert.equal(fileResponse.headers.get("content-type"), "image/jpeg");
  fileResponse = await fetch(`${lanBaseUrl}${jpg.downloadUrl}`, { headers: { Range: "bytes=0-3" } });
  assert.equal(fileResponse.status, 206);
  assert.equal((await fileResponse.arrayBuffer()).byteLength, 4);
  const tiffPreview = await fetch(`${lanBaseUrl}${tiff.previewUrl}`);
  assert.equal(tiffPreview.status, 200);
  assert.equal(tiffPreview.headers.get("content-type"), "image/webp");

  const cacheDirectory = path.join(dataDirectory, "cache", "photos");
  const cacheBefore = await readdir(cacheDirectory);
  assert.ok(cacheBefore.some((name) => name.endsWith("-512.webp")));
  const firstCachePath = path.join(cacheDirectory, cacheBefore[0]);
  const cacheModifiedAt = (await stat(firstCachePath)).mtimeMs;
  request = await jsonRequest(localBaseUrl, "/api/photos/catalog/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal((await stat(firstCachePath)).mtimeMs, cacheModifiedAt, "未变化图片应复用原有缩略图缓存");

  request = await jsonRequest(localBaseUrl, "/api/photos/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: brokenLibrary, name: "中断扫描" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const brokenLibraryId = request.result.library.id;
  await rm(brokenLibrary, { recursive: true, force: true });
  request = await jsonRequest(localBaseUrl, "/api/photos/catalog/scan", { method: "POST" });
  assert.equal(request.response.status, 500, "目录读取不完整时扫描必须失败而不是覆盖索引");
  const afterFailedScan = (await jsonRequest(localBaseUrl, "/api/photos/overview")).result;
  assert.equal(afterFailedScan.items.length, formats.length, "失败扫描必须保留上一版完整图片索引");
  await jsonRequest(localBaseUrl, `/api/photos/libraries/${brokenLibraryId}`, { method: "DELETE" });

  const storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(storedState.version, 11);
  assert.equal(storedState.photoItems.length, formats.length);

  const overview = (await jsonRequest(localBaseUrl, "/api/overview?compact=1")).result;
  const authorizedFolder = overview.displayFolders.find((folder) => folder.kind === "photo" && folder.path === photoRoot);
  const hiddenFolder = overview.displayFolders.find((folder) => folder.kind === "photo" && folder.path === nestedLibrary);
  assert.ok(authorizedFolder && hiddenFolder, "访问控制总览应包含图片库根目录");
  const category = (await jsonRequest(localBaseUrl, "/api/access-control/categories", {
    method: "POST",
    body: JSON.stringify({ name: "图片授权" }),
  })).result;
  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${authorizedFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: category.id }),
  });
  assert.equal(request.response.status, 200, request.result.error);
  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246802", categoryIds: [category.id] }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  await jsonRequest(localBaseUrl, "/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled: true }) });

  const noCookie = await fetch(`${lanBaseUrl}/api/photos/catalog`);
  assert.equal(noCookie.status, 401);
  const login = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "246802" }),
  });
  assert.equal(login.response.status, 200, login.result.error);
  const cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
  request = await jsonRequest(lanBaseUrl, "/api/photos/catalog", { headers: { Cookie: cookie } });
  assert.ok(request.result.items.every((item) => item.libraryId === rootLibraryId), "访问码用户只能看到已授权图片目录");
  const denied = await fetch(`${lanBaseUrl}${tiff.downloadUrl}`, { headers: { Cookie: cookie } });
  assert.equal(denied.status, 404, "未授权图片直链必须返回 404");
  const allowed = await fetch(`${lanBaseUrl}${jpg.downloadUrl}`, { headers: { Cookie: cookie, Range: "bytes=0-0" } });
  assert.equal(allowed.status, 206);

  request = await jsonRequest(localBaseUrl, `/api/photos/libraries/${nestedLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200, request.result.error);
  await access(path.join(nestedLibrary, "样例.tiff"));
  const afterDelete = (await jsonRequest(localBaseUrl, "/api/photos/overview")).result;
  assert.ok(afterDelete.items.every((item) => item.libraryId !== nestedLibraryId), "删除图片目录应清理索引但保留原图");

  console.log("图片库集成测试通过：迁移、格式、嵌套/重叠目录、缓存复用、回滚、MIME、下载、Range 与访问码隔离均符合预期。");
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
