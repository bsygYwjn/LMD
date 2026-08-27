import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    localParts.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function buildPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 480] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 52 >>\nstream\nBT /F1 20 Tf 48 400 Td (LMD PDF Reader) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-reading-library-test-"));
const dataDirectory = path.join(temporaryRoot, "data");
const readingRoot = path.join(temporaryRoot, "Reading");
const booksFolder = path.join(readingRoot, "书籍");
const nestedLibrary = path.join(readingRoot, "私密资料");
const formats = ["pdf", "epub", "mobi", "azw", "azw3", "fb2", "cbz", "txt", "xlsx", "xls", "xlsm", "xlsb", "csv", "ods"];

await mkdir(dataDirectory, { recursive: true });
await mkdir(booksFolder, { recursive: true });
await mkdir(nestedLibrary, { recursive: true });
for (const extension of formats) {
  const destination = extension === "azw3" ? nestedLibrary : booksFolder;
  await writeFile(path.join(destination, `样例.${extension}`), Buffer.from(`lmd-${extension}-fixture`));
}
await writeFile(path.join(booksFolder, "样例.pdf"), buildPdf());
await writeFile(path.join(booksFolder, "样例.txt"), "LMD 文本阅读器\n\n支持 UTF-8、UTF-16 与 GB18030 自动识别。\n", "utf8");
await writeFile(path.join(booksFolder, "样例.fb2"), "<?xml version=\"1.0\" encoding=\"utf-8\"?><FictionBook xmlns=\"http://www.gribuser.ru/xml/fictionbook/2.0\"><description><title-info><book-title>LMD FB2</book-title><author><first-name>LMD</first-name></author></title-info></description><body><section><title><p>第一章</p></title><p>这是合法的小型 FB2 测试书籍。</p></section></body></FictionBook>", "utf8");
const epubParagraphs = Array.from({ length: 180 }, (_, index) => `<p>第 ${index + 1} 段：用于验证点击书页时每次只前进或后退一页。</p>`).join("");
await writeFile(path.join(booksFolder, "样例.epub"), buildStoredZip([
  { name: "mimetype", data: "application/epub+zip" },
  { name: "META-INF/container.xml", data: "<?xml version=\"1.0\"?><container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>" },
  { name: "OEBPS/content.opf", data: "<?xml version=\"1.0\"?><package version=\"3.0\" unique-identifier=\"id\" xmlns=\"http://www.idpf.org/2007/opf\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:identifier id=\"id\">lmd-epub</dc:identifier><dc:title>LMD EPUB Reader</dc:title><dc:language>zh-CN</dc:language><dc:creator>Codex</dc:creator></metadata><manifest><item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/><item id=\"chapter\" href=\"chapter.xhtml\" media-type=\"application/xhtml+xml\"/></manifest><spine><itemref idref=\"chapter\"/></spine></package>" },
  { name: "OEBPS/nav.xhtml", data: "<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><body><nav epub:type=\"toc\"><ol><li><a href=\"chapter.xhtml\">第一章</a></li></ol></nav></body></html>" },
  { name: "OEBPS/chapter.xhtml", data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1>${epubParagraphs}</body></html>` },
]));
await writeFile(path.join(booksFolder, "样例.cbz"), buildStoredZip([{ name: "001.png", data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZoqsAAAAASUVORK5CYII=", "base64") }]));
const sheetRows = [["名称", "数值", "日期"], ["安全文本 <img src=x onerror=alert(1)>", 42, new Date("2026-08-26T00:00:00Z")], ["缓存公式结果", 84, "只读"]];
const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet(sheetRows, { cellDates: true });
worksheet.B3 = { t: "n", f: "B2*2", v: 84, w: "84" };
worksheet["!merges"] = [{ s: { r: 2, c: 1 }, e: { r: 2, c: 2 } }];
XLSX.utils.book_append_sheet(workbook, worksheet, "数据预览");
for (const [extension, bookType] of [["xlsx", "xlsx"], ["xls", "xls"], ["xlsm", "xlsm"], ["xlsb", "xlsb"], ["ods", "ods"], ["csv", "csv"]]) {
  await writeFile(path.join(booksFolder, `样例.${extension}`), XLSX.write(workbook, { type: "buffer", bookType, bookVBA: false }));
}
await writeFile(path.join(dataDirectory, "state.json"), JSON.stringify({
  version: 9,
  libraries: [],
  media: [],
  musicLibraries: [],
  musicTracks: [],
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

  let request = await jsonRequest(localBaseUrl, "/api/reading/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: readingRoot, name: "阅读资料" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const rootLibraryId = request.result.library.id;
  request = await jsonRequest(localBaseUrl, "/api/reading/libraries", {
    method: "POST",
    body: JSON.stringify({ folderPath: nestedLibrary, name: "私密阅读" }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  const nestedLibraryId = request.result.library.id;

  request = await jsonRequest(localBaseUrl, "/api/reading/catalog/scan?mode=turbo", { method: "POST" });
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.count, formats.length, "重叠阅读目录中的文件只能建立一次索引");

  request = await jsonRequest(lanBaseUrl, "/api/reading/catalog");
  assert.equal(request.response.status, 200, request.result.error);
  assert.equal(request.result.items.length, formats.length);
  assertNoPaths(request.result);
  assert.equal(JSON.stringify(request.result).includes(temporaryRoot), false, "观看端阅读目录不得包含绝对路径");
  assert.deepEqual(new Set(request.result.items.map((item) => item.extension)), new Set(formats.map((extension) => extension.toUpperCase())));
  assert.equal(request.result.items.filter((item) => item.kind === "ebook").length, 8);
  assert.equal(request.result.items.filter((item) => item.kind === "spreadsheet").length, 6);
  assert.equal(request.result.items.find((item) => item.extension === "AZW3").libraryId, nestedLibraryId, "最深层注册目录应拥有重叠文件");
  assert.ok(request.result.folders.some((folder) => folder.parentId), "阅读目录应保留嵌套文件夹树");
  for (const folder of request.result.folders.filter((candidate) => candidate.ebookCount)) {
    assert.equal(request.result.items.find((item) => item.id === folder.coverMediaId)?.kind, "ebook", "文件夹缩略图应继承第一本电子书，而不是表格文件");
  }

  const pdf = request.result.items.find((item) => item.extension === "PDF");
  const xlsx = request.result.items.find((item) => item.extension === "XLSX");
  const hidden = request.result.items.find((item) => item.extension === "AZW3");
  let fileResponse = await fetch(`${lanBaseUrl}${pdf.fileUrl}`, { method: "HEAD" });
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get("content-type"), "application/pdf");
  assert.equal(fileResponse.headers.get("accept-ranges"), "bytes");
  assert.equal((await fileResponse.arrayBuffer()).byteLength, 0);
  fileResponse = await fetch(`${lanBaseUrl}${xlsx.fileUrl}`, { headers: { Range: "bytes=0-3" } });
  assert.equal(fileResponse.status, 206);
  assert.equal(fileResponse.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.match(fileResponse.headers.get("content-range") || "", /^bytes 0-3\//);
  assert.equal((await fileResponse.arrayBuffer()).byteLength, 4);
  const parallelReadingResponses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${lanBaseUrl}${pdf.fileUrl}`, { headers: { Range: "bytes=0-0" } })));
  assert.ok(parallelReadingResponses.every((response) => response.status === 206), "阅读文件传输不应占用或受限于 10 路音视频配额");
  await Promise.all(parallelReadingResponses.map((response) => response.arrayBuffer()));

  const incrementalPath = path.join(booksFolder, "增量.pdf");
  await writeFile(incrementalPath, Buffer.from("incremental-reading-fixture"));
  request = await jsonRequest(localBaseUrl, "/api/reading/catalog/scan", { method: "POST" });
  assert.equal(request.result.count, formats.length + 1);
  await unlink(incrementalPath);
  request = await jsonRequest(localBaseUrl, "/api/reading/catalog/scan", { method: "POST" });
  assert.equal(request.result.count, formats.length, "增量扫描应清理已删除文件的索引");

  const storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(storedState.version, 10);
  assert.equal(storedState.readingLibraries.length, 2);
  assert.equal(storedState.readingItems.length, formats.length);

  const overview = (await jsonRequest(localBaseUrl, "/api/overview?compact=1")).result;
  const authorizedFolder = overview.displayFolders.find((folder) => folder.kind === "reading" && folder.path === readingRoot);
  const hiddenFolder = overview.displayFolders.find((folder) => folder.kind === "reading" && folder.path === nestedLibrary);
  assert.ok(authorizedFolder && hiddenFolder, "访问控制总览应包含阅读库根目录");
  const category = (await jsonRequest(localBaseUrl, "/api/access-control/categories", {
    method: "POST",
    body: JSON.stringify({ name: "阅读授权" }),
  })).result;
  request = await jsonRequest(localBaseUrl, `/api/access-control/folders/${authorizedFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: category.id }),
  });
  assert.equal(request.response.status, 200, request.result.error);
  request = await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "357913", categoryIds: [category.id] }),
  });
  assert.equal(request.response.status, 201, request.result.error);
  await jsonRequest(localBaseUrl, "/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled: true }) });

  const noCookie = await fetch(`${lanBaseUrl}/api/reading/catalog`);
  assert.equal(noCookie.status, 401);
  const login = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "357913" }),
  });
  assert.equal(login.response.status, 200, login.result.error);
  const cookie = (login.response.headers.get("set-cookie") || "").split(";")[0];
  request = await jsonRequest(lanBaseUrl, "/api/reading/catalog", { headers: { Cookie: cookie } });
  assert.equal(request.response.status, 200, request.result.error);
  assert.ok(request.result.items.every((item) => item.libraryId === rootLibraryId), "访问码用户只能看到已授权阅读目录");
  const denied = await fetch(`${lanBaseUrl}${hidden.fileUrl}`, { headers: { Cookie: cookie } });
  assert.equal(denied.status, 404, "未授权阅读文件直链必须返回 404");
  const allowed = await fetch(`${lanBaseUrl}${pdf.fileUrl}`, { headers: { Cookie: cookie, Range: "bytes=0-0" } });
  assert.equal(allowed.status, 206, "已授权阅读文件仍应支持 Range 读取");

  request = await jsonRequest(localBaseUrl, `/api/reading/libraries/${nestedLibraryId}`, { method: "DELETE" });
  assert.equal(request.response.status, 200, request.result.error);
  const afterDelete = (await jsonRequest(localBaseUrl, "/api/reading/overview")).result;
  assert.equal(afterDelete.libraries.length, 1);
  assert.ok(afterDelete.items.every((item) => item.libraryId !== nestedLibraryId), "删除目录应同步清理其索引");

  const browserHoldMilliseconds = Math.max(0, Number(process.env.LMD_READING_BROWSER_HOLD_MS) || 0);
  if (browserHoldMilliseconds) {
    console.log(`READING_BROWSER_TEST_URL=${localBaseUrl}`);
    await new Promise((resolve) => setTimeout(resolve, browserHoldMilliseconds));
  }

  console.log("阅读库集成测试通过：迁移、嵌套/重叠目录、增量扫描、删除清理、脱敏、MIME、HEAD/Range 与访问码隔离均符合预期。");
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
