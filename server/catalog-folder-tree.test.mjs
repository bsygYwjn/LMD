import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

function folderByName(folders, name, parentId) {
  return folders.find((folder) => folder.name === name && folder.parentId === parentId);
}

function assertFolderShape(folder) {
  for (const key of ["id", "parentId", "name", "title", "directMediaCount", "mediaCount", "childCount", "coverMediaId"]) {
    assert.ok(Object.hasOwn(folder, key), `目录节点缺少 ${key} 字段`);
  }
}

function assertNoPathFields(value, location = "catalog") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPathFields(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    assert.doesNotMatch(key, /path$/i, `${location}.${key} 不应向播放端暴露本地路径字段`);
    assertNoPathFields(nestedValue, `${location}.${key}`);
  }
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-catalog-tree-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const libraryDirectory = path.join(temporaryRoot, "CatalogTreeLibrary");
const nestedLibraryDirectory = path.join(libraryDirectory, "作品A");
const aliasLibraryDirectory = path.join(temporaryRoot, "CatalogTreeAlias-With-A-Very-Long-Name-That-Must-Not-Steal-Ownership");
const hiddenLibraryDirectory = path.join(libraryDirectory, ".hidden");
const concurrentLibraryDirectory = path.join(temporaryRoot, "ConcurrentDeleteLibrary");
const mediaFiles = [
  ["root.mp4", "root-video"],
  [path.join("作品A", "第一季", "01.mp4"), "work-a-season-1"],
  [path.join("作品A", "第二季", "01.mp4"), "work-a-season-2"],
  [path.join("深层目录", "第二层", "第三层", "deep.mp4"), "three-level-video"],
  [path.join("混合目录", "直属.mp4"), "mixed-direct-video"],
  [path.join("混合目录", "子目录", "后代.mp4"), "mixed-descendant-video"],
];
for (const [relativePath, contents] of mediaFiles) {
  const filePath = path.join(libraryDirectory, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(contents));
}
await mkdir(hiddenLibraryDirectory, { recursive: true });
await writeFile(path.join(hiddenLibraryDirectory, "secret.mp4"), Buffer.from("hidden-video"));
await mkdir(concurrentLibraryDirectory, { recursive: true });
await writeFile(path.join(concurrentLibraryDirectory, "must-not-return.mp4"), Buffer.from("concurrent-delete-video"));
for (let index = 1; index <= 3; index += 1) {
  await writeFile(path.join(concurrentLibraryDirectory, `pending-${index}.mp4`), Buffer.from(`concurrent-pending-${index}`));
}
await symlink(nestedLibraryDirectory, aliasLibraryDirectory, process.platform === "win32" ? "junction" : "dir");

const requestedPort = Number(process.env.LMD_CATALOG_BROWSER_PORT) || 0;
const port = requestedPort > 0 ? requestedPort : await freePort();
const localBaseUrl = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, [path.join(SERVER_DIR, "index.mjs")], {
  cwd: PROJECT_DIR,
  env: {
    ...process.env,
    NODE_ENV: "test",
    LMD_PORT: String(port),
    LMD_DATA_DIR: dataDirectory,
    // 每个文件的处理延迟必须超过服务端 2 秒的扫描 checkpoint 间隔：
    // 否则 6 个文件的扫描在 checkpoint 触发前就结束，播放端永远看不到
    // “扫描中逐步发布”的中间状态（增量发布只在 checkpoint 时物化索引）。
    LMD_TEST_SCAN_FILE_DELAY_MS: "2200",
  },
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

  // 关闭自动扫描：本测试每次扫描耗时数秒，不能让 30 秒的自动扫描
  // 与手动扫描/删除操作并发，否则会干扰目录变更冲突断言。
  await jsonRequest(localBaseUrl, "/api/settings/auto-scan", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  });

  let request = await jsonRequest(localBaseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: libraryDirectory, name: "树状测试媒体库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);

  const initialScanPromise = jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  const progressiveDeadline = Date.now() + 5000;
  let progressiveCatalog = null;
  while (Date.now() < progressiveDeadline) {
    const candidate = await jsonRequest(lanBaseUrl, "/api/catalog");
    if (candidate.result.scan?.scanning && candidate.result.media.length > 0 && candidate.result.media.length < mediaFiles.length) {
      progressiveCatalog = candidate.result;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(progressiveCatalog, "完整扫描结束前，播放端应逐步看到已经处理完成的视频");
  request = await initialScanPromise;
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, mediaFiles.length);

  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  const catalog = request.result;
  assert.equal(catalog.media.length, mediaFiles.length);
  assert.equal(catalog.folders.length, 9, "目录树应包含媒体库根节点和每一级实际目录");
  catalog.folders.forEach(assertFolderShape);
  assertNoPathFields(catalog);
  assert.equal(JSON.stringify(catalog).includes(temporaryRoot), false, "播放端目录数据不得包含媒体库绝对路径");

  const rootFolder = folderByName(catalog.folders, "CatalogTreeLibrary", null);
  assert.ok(rootFolder, "应生成媒体库根目录节点");
  assert.equal(rootFolder.title, "树状测试媒体库");
  assert.deepEqual(
    [rootFolder.directMediaCount, rootFolder.mediaCount, rootFolder.childCount],
    [1, 6, 3],
    "媒体库根节点应分别统计直属视频、全部后代视频和直属子目录",
  );

  const workA = folderByName(catalog.folders, "作品A", rootFolder.id);
  const seasonOne = workA && folderByName(catalog.folders, "第一季", workA.id);
  const seasonTwo = workA && folderByName(catalog.folders, "第二季", workA.id);
  assert.ok(workA && seasonOne && seasonTwo, "作品A 下应保留第一季和第二季的父子层级");
  assert.deepEqual([workA.directMediaCount, workA.mediaCount, workA.childCount], [0, 2, 2]);
  assert.deepEqual([seasonOne.directMediaCount, seasonOne.mediaCount, seasonOne.childCount], [1, 1, 0]);
  assert.deepEqual([seasonTwo.directMediaCount, seasonTwo.mediaCount, seasonTwo.childCount], [1, 1, 0]);

  const deepLevelOne = folderByName(catalog.folders, "深层目录", rootFolder.id);
  const deepLevelTwo = deepLevelOne && folderByName(catalog.folders, "第二层", deepLevelOne.id);
  const deepLevelThree = deepLevelTwo && folderByName(catalog.folders, "第三层", deepLevelTwo.id);
  assert.ok(deepLevelOne && deepLevelTwo && deepLevelThree, "三层嵌套目录应逐级生成节点");
  assert.deepEqual([deepLevelOne.directMediaCount, deepLevelOne.mediaCount, deepLevelOne.childCount], [0, 1, 1]);
  assert.deepEqual([deepLevelTwo.directMediaCount, deepLevelTwo.mediaCount, deepLevelTwo.childCount], [0, 1, 1]);
  assert.deepEqual([deepLevelThree.directMediaCount, deepLevelThree.mediaCount, deepLevelThree.childCount], [1, 1, 0]);

  const mixedFolder = folderByName(catalog.folders, "混合目录", rootFolder.id);
  const mixedChild = mixedFolder && folderByName(catalog.folders, "子目录", mixedFolder.id);
  assert.ok(mixedFolder && mixedChild, "混合目录应同时保留直属视频和子目录");
  assert.deepEqual([mixedFolder.directMediaCount, mixedFolder.mediaCount, mixedFolder.childCount], [1, 2, 1]);
  assert.deepEqual([mixedChild.directMediaCount, mixedChild.mediaCount, mixedChild.childCount], [1, 1, 0]);

  const folderIds = new Set(catalog.folders.map((folder) => folder.id));
  const directCounts = new Map();
  for (const media of catalog.media) {
    assert.ok(folderIds.has(media.display.folderId), `${media.fileName} 的 display.folderId 应指向目录树节点`);
    directCounts.set(media.display.folderId, (directCounts.get(media.display.folderId) || 0) + 1);
  }
  for (const folder of catalog.folders) {
    assert.equal(folder.directMediaCount, directCounts.get(folder.id) || 0, `${folder.name} 的直属视频计数应匹配媒体引用`);
    assert.ok(catalog.media.some((media) => media.id === folder.coverMediaId), `${folder.name} 的封面视频应来自当前目录树`);
  }
  assert.equal(catalog.media.find((media) => media.fileName === "root.mp4")?.display.folderId, rootFolder.id);
  assert.equal(catalog.media.find((media) => media.fileName === "deep.mp4")?.display.folderId, deepLevelThree.id);
  assert.equal(catalog.media.find((media) => media.fileName === "直属.mp4")?.display.folderId, mixedFolder.id);
  assert.equal(catalog.media.find((media) => media.fileName === "后代.mp4")?.display.folderId, mixedChild.id);

  const browserHoldMilliseconds = Math.max(0, Number(process.env.LMD_CATALOG_BROWSER_HOLD_MS) || 0);
  if (browserHoldMilliseconds) {
    console.log(`BROWSER_TEST_URL=${localBaseUrl}`);
    await new Promise((resolve) => setTimeout(resolve, browserHoldMilliseconds));
  }

  request = await jsonRequest(localBaseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: nestedLibraryDirectory, name: "独立作品A库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const parentLibraryId = request.result.libraries.find((library) => library.path === libraryDirectory)?.id;
  assert.ok(parentLibraryId, "应能找到父级媒体库 ID");

  request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  const firstOverlapCatalog = request.result;

  request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  const secondOverlapCatalog = request.result;

  for (const overlapCatalog of [firstOverlapCatalog, secondOverlapCatalog]) {
    assert.equal(overlapCatalog.media.length, mediaFiles.length, "重叠媒体库不得重复返回同一视频");
    assert.equal(new Set(overlapCatalog.media.map((media) => media.id)).size, mediaFiles.length, "媒体 ID 必须保持唯一");
    assert.equal(overlapCatalog.folders.filter((folder) => folder.parentId === null).length, 2, "父库与嵌套子库应各保留一个根节点");
    const overlapParentRoot = folderByName(overlapCatalog.folders, "CatalogTreeLibrary", null);
    const overlapNestedRoot = folderByName(overlapCatalog.folders, "作品A", null);
    assert.ok(overlapParentRoot && overlapNestedRoot, "重叠媒体库应生成两个互不重复的根节点");
    assert.equal(overlapNestedRoot.title, "独立作品A库");
    assert.deepEqual([overlapParentRoot.directMediaCount, overlapParentRoot.mediaCount, overlapParentRoot.childCount], [1, 4, 2]);
    assert.deepEqual([overlapNestedRoot.directMediaCount, overlapNestedRoot.mediaCount, overlapNestedRoot.childCount], [0, 2, 2]);
    assert.equal(folderByName(overlapCatalog.folders, "作品A", overlapParentRoot.id), undefined, "嵌套媒体库拥有的视频不应在父库中重复出现");
  }
  assert.deepEqual(
    firstOverlapCatalog.media.map((media) => [media.id, media.display.folderId]).sort(),
    secondOverlapCatalog.media.map((media) => [media.id, media.display.folderId]).sort(),
    "重复扫描后媒体 ID 与目录归属必须稳定",
  );
  assert.deepEqual(
    firstOverlapCatalog.folders.map((folder) => [folder.id, folder.parentId, folder.mediaCount]).sort(),
    secondOverlapCatalog.folders.map((folder) => [folder.id, folder.parentId, folder.mediaCount]).sort(),
    "重复扫描后目录树与计数必须稳定",
  );

  const stablePhysicalMediaIds = secondOverlapCatalog.media.map((media) => media.id).sort();
  request = await jsonRequest(localBaseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: aliasLibraryDirectory, name: "作品A联接别名" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const aliasLibraryId = request.result.libraries.find((library) => library.path === aliasLibraryDirectory)?.id;
  assert.ok(aliasLibraryId, "应能找到目录联接媒体库 ID");
  for (let scanIndex = 0; scanIndex < 2; scanIndex += 1) {
    request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
    assert.equal(request.response.status, 200, request.result.error);
    request = await jsonRequest(lanBaseUrl, "/api/catalog");
    assert.equal(request.response.status, 200, request.result.error);
    assert.equal(request.result.media.length, mediaFiles.length, "目录联接别名不得重复展示同一物理视频");
    assert.deepEqual(request.result.media.map((media) => media.id).sort(), stablePhysicalMediaIds, "真实路径去重后媒体 ID 应保持稳定");
    assert.deepEqual(
      request.result.media.map((media) => [media.id, media.display.folderId]).sort(),
      secondOverlapCatalog.media.map((media) => [media.id, media.display.folderId]).sort(),
      "更长的目录联接别名不得夺取既有目录归属",
    );
    assert.equal(request.result.folders.some((folder) => folder.title === "作品A联接别名"), false, "未拥有独立视频的目录联接不应生成重复根节点");
  }
  request = await jsonRequest(localBaseUrl, `/api/libraries/${aliasLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200, request.result.error);

  request = await jsonRequest(localBaseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: hiddenLibraryDirectory, name: "独立隐藏库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const hiddenLibraryId = request.result.libraries.find((library) => library.path === hiddenLibraryDirectory)?.id;
  assert.ok(hiddenLibraryId, "应能找到隐藏子库 ID");
  request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.media.length, mediaFiles.length + 1, "单独添加隐藏子库后应能扫描其中的视频");
  assert.ok(request.result.media.some((media) => media.fileName === "secret.mp4"), "隐藏子库视频应由该子库独立提供");

  request = await jsonRequest(localBaseUrl, `/api/libraries/${hiddenLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.removedMediaCount, 1, "删除隐藏子库必须立即撤销其唯一视频索引");
  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.media.some((media) => media.fileName === "secret.mp4"), false, "父库不得猜测性接管已删除隐藏子库的视频");
  request = await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, mediaFiles.length, "真实重扫后父库仍应跳过隐藏目录");

  request = await jsonRequest(localBaseUrl, "/api/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: concurrentLibraryDirectory, name: "并发删除测试库" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const concurrentLibraryId = request.result.libraries.find((library) => library.path === concurrentLibraryDirectory)?.id;
  assert.ok(concurrentLibraryId, "应能找到并发删除测试库 ID");
  const staleScanPromise = jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  // 增量发布只在 checkpoint（每 2 秒）物化索引，且并发测试库在目录遍历中
  // 排在最后、readdir 返回顺序不保证与创建顺序一致：只要“删除前已能看到
  // 该库任一视频被旧扫描增量发布”即可证明语义成立。以 2.2 秒/文件的延迟
  // 计算，库内文件大约在第 6.6 秒前后进入播放端可见索引，轮询窗口需覆盖
  // 整个扫描周期。
  const scanDeadline = Date.now() + 12000;
  let incrementallyPublishedBeforeDelete = false;
  while (Date.now() < scanDeadline) {
    const catalogDuringScan = await jsonRequest(lanBaseUrl, "/api/catalog");
    if (catalogDuringScan.result.scan?.scanning
      && catalogDuringScan.result.media.some((media) => media.fileName === "must-not-return.mp4" || media.fileName.startsWith("pending-"))) {
      incrementallyPublishedBeforeDelete = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(incrementallyPublishedBeforeDelete, true, "删除前应确认测试库视频已经由旧扫描增量发布");
  request = await jsonRequest(localBaseUrl, `/api/libraries/${concurrentLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200, request.result.error);
  const staleScan = await staleScanPromise;
  assert.equal(staleScan.response.status, 409, "目录变更后旧扫描必须以冲突结束，不能提交过期索引");
  request = await jsonRequest(localBaseUrl, "/api/overview");
  assert.equal(request.result.libraries.some((library) => library.id === concurrentLibraryId), false, "并发删除后的媒体库不得复活");
  assert.equal(request.result.media.some((media) => media.fileName === "must-not-return.mp4"), false, "旧扫描不得复活已删除媒体库的视频");
  request = await jsonRequest(lanBaseUrl, "/api/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.media.some((media) => media.fileName === "must-not-return.mp4"), false, "播放端不得看到旧扫描复活的视频");

  request = await jsonRequest(localBaseUrl, "/api/overview");
  assert.equal(request.response.status, 200, request.result.error);
  const firstSeasonDisplayFolder = request.result.displayFolders.find((folder) => folder.folderName === "第一季");
  const allowedCategory = request.result.accessControl.categories.find((category) => category.name === "全年龄");
  assert.ok(firstSeasonDisplayFolder && allowedCategory, "应找到第一季叶目录和默认全年龄分类");

  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${firstSeasonDisplayFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: allowedCategory.id }),
  });
  assert.equal(request.response.status, 200, request.result.error);

  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "314159", categoryIds: [allowedCategory.id] }),
  });
  assert.equal(request.response.status, 201, request.result.error);

  request = await jsonRequest(localBaseUrl, "/api/access-control", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(request.response.status, 200, request.result.error);

  request = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "314159" }),
  });
  assert.equal(request.response.status, 200, request.result.error);
  const cookie = request.response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "登录应签发访问会话 Cookie");

  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: cookie } });
  assert.equal(request.response.status, 200, request.result.error);
  const restrictedCatalog = request.result;
  assert.equal(restrictedCatalog.media.length, 1, "仅应返回获授权的第一季视频");
  assert.equal(restrictedCatalog.media[0].fileName, "01.mp4");
  assert.equal(restrictedCatalog.folders.length, 2, "受限目录树只应包含所属媒体库根和授权叶目录");
  assertNoPathFields(restrictedCatalog);

  const restrictedRoot = folderByName(restrictedCatalog.folders, "作品A", null);
  const restrictedSeasonOne = restrictedRoot && folderByName(restrictedCatalog.folders, "第一季", restrictedRoot.id);
  assert.ok(restrictedRoot && restrictedSeasonOne, "受限目录树应保留嵌套媒体库根→第一季");
  assert.equal(restrictedRoot.title, "独立作品A库");
  assert.deepEqual([restrictedRoot.directMediaCount, restrictedRoot.mediaCount, restrictedRoot.childCount], [0, 1, 1]);
  assert.deepEqual([restrictedSeasonOne.directMediaCount, restrictedSeasonOne.mediaCount, restrictedSeasonOne.childCount], [1, 1, 0]);
  assert.equal(restrictedCatalog.media[0].display.folderId, restrictedSeasonOne.id);

  const restrictedJson = JSON.stringify(restrictedCatalog);
  for (const hiddenName of ["树状测试媒体库", "CatalogTreeLibrary", "第二季", "深层目录", "第二层", "第三层", "混合目录", "子目录", "root.mp4", "deep.mp4", "直属.mp4", "后代.mp4"]) {
    assert.equal(restrictedJson.includes(hiddenName), false, `受限目录不得泄露 ${hiddenName}`);
  }

  request = await jsonRequest(localBaseUrl, `/api/libraries/${parentLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.removedMediaCount, 4, "删除父库只应移除不属于嵌套子库的四个视频");
  request = await jsonRequest(localBaseUrl, "/api/overview");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.libraries.length, 1, "删除父库后应保留嵌套子库");
  assert.equal(request.result.media.length, 2, "嵌套子库的视频索引不应被父库删除");
  const categoryAfterParentRemoval = request.result.accessControl.categories.find((category) => category.id === allowedCategory.id);
  assert.ok(categoryAfterParentRemoval?.folderIds.includes(firstSeasonDisplayFolder.id), "删除父库不得清除嵌套子库的分类授权");

  request = await jsonRequest(lanBaseUrl, "/api/catalog", { headers: { Cookie: cookie } });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.media.length, 1, "删除父库后授权用户仍应看到嵌套子库视频");
  assert.equal(request.result.folders.length, 2, "删除父库后受限目录链应保持稳定");

  console.log("目录树集成测试通过：嵌套层级、稳定联接归属、并发删除和访问控制裁剪均正常。");
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
