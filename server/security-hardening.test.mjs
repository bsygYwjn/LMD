// 安全加固集成测试：路径穿越、Range 边界、Cookie 属性、越权直链、
// XFF 伪造、CSRF/Origin、畸形 URL 崩溃防护、登录锁定层级与流媒体上限。
// 运行：node server/security-hardening.test.mjs
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

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "lmd-security-test-"));
const testDataDirectory = path.join(temporaryRoot, "data");
const firstLibrary = path.join(temporaryRoot, "SecureA");
const secondLibrary = path.join(temporaryRoot, "SecureB");
await mkdir(firstLibrary, { recursive: true });
await mkdir(secondLibrary, { recursive: true });
await writeFile(path.join(firstLibrary, "first.mp4"), Buffer.alloc(8 * 1024 * 1024, 0x61));
await writeFile(path.join(firstLibrary, "first.zh.srt"), Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n你好\n"));
await writeFile(path.join(secondLibrary, "second.mp4"), Buffer.from("second-video-test-content"));

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

  const pageResponse = await fetch(`${localBaseUrl}/`);
  const csp = pageResponse.headers.get("content-security-policy") || "";
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/, "页面应允许本地脚本与 JASSUB 所需的 WebAssembly 编译");
  assert.doesNotMatch(csp, /(?:^|[ ;])'unsafe-eval'(?:[ ;]|$)/, "不得为字幕放开通用 JavaScript eval");
  assert.match(csp, /object-src 'none'/, "页面应禁止对象嵌入");
  assert.match(csp, /worker-src 'self' blob:/, "PDF、字幕和表格 Worker 应受显式 CSP 约束");
  assert.match(csp, /connect-src 'self' blob:/, "电子书章节应只允许读取本地接口与受控 Blob 资源");
  assert.equal(pageResponse.headers.get("x-content-type-options"), "nosniff");
  const builtIndex = await readFile(path.join(PROJECT_DIR, "dist", "index.html"), "utf8");
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(builtIndex), false, "生产首页不得保留内联主题脚本");

  // ---------- 1. 畸形 URL 不再导致进程崩溃 ----------
  for (const badPath of ["/%zz", "/api/%E0%A4%A", "/test%2"]) {
    const response = await fetch(`${lanBaseUrl}${badPath}`);
    assert.equal(response.status, 400, `畸形 URL ${badPath} 应返回 400 而不是崩溃`);
  }
  const aliveAfterMalformed = await fetch(`${localBaseUrl}/api/health`);
  assert.equal(aliveAfterMalformed.status, 200, "畸形 URL 请求后服务应仍然存活");

  // ---------- 2. 静态文件路径穿越 ----------
  // 注意：WHATWG URL 解析会在服务端看到路径前就把 %2e/%2f 点段折叠掉，
  // 因此这类请求在服务端表现为站内路径（如 /Windows/win.ini），由 SPA
  // 回退返回 index.html（200）。真正要保证的是绝不返回站外文件内容。
  const traversalAttempts = [
    "/..%2f..%2f..%2fWindows%2fwin.ini",
    "/..%5c..%5c..%5cWindows%5cwin.ini",
    "/.%2e/.%2e/.%2e/Windows/win.ini",
    "/assets/..%2f..%2fpackage.json",
  ];
  for (const attempt of traversalAttempts) {
    const response = await fetch(`${lanBaseUrl}${attempt}`, { redirect: "manual" });
    assert.ok([200, 400, 403, 404].includes(response.status), `路径穿越 ${attempt} 应被拒绝，实际 ${response.status}`);
    if (response.status === 200) {
      const body = await response.text();
      assert.match(body, /<div id="root">/, `路径穿越 ${attempt} 返回 200 时只能是 SPA 页面，不能是站外文件内容`);
    }
  }

  // ---------- 3. Range 请求边界 ----------
  // 两个目录都注册：SecureA 授权给测试用户，SecureB 保持未分类，
  // 用于验证“已索引但未授权”的越权直链会被后端拒绝。
  await jsonRequest(localBaseUrl, "/api/libraries", { method: "POST", body: JSON.stringify({ folderPath: firstLibrary }) });
  await jsonRequest(localBaseUrl, "/api/libraries", { method: "POST", body: JSON.stringify({ folderPath: secondLibrary }) });
  await jsonRequest(localBaseUrl, "/api/scan", { method: "POST" });
  const overview = (await jsonRequest(localBaseUrl, "/api/overview")).result;
  const firstMedia = overview.media.find((media) => media.fileName === "first.mp4");
  assert.ok(firstMedia, "扫描应识别测试视频");
  const mediaUrl = `${lanBaseUrl}/api/media/${firstMedia.id}/stream`;

  // 合法 Range
  const okRange = await fetch(mediaUrl, { headers: { Range: "bytes=0-4" } });
  assert.equal(okRange.status, 206, "合法 Range 应返回 206");
  assert.equal(okRange.headers.get("content-range"), `bytes 0-4/${firstMedia.size}`);

  // 越界 Range（超过文件大小）
  const overflowRange = await fetch(mediaUrl, { headers: { Range: `bytes=${firstMedia.size + 100}-` } });
  assert.equal(overflowRange.status, 416, "超出文件大小的 Range 应返回 416");

  // 非法范围（起点大于终点）
  const invertedRange = await fetch(mediaUrl, { headers: { Range: "bytes=10-5" } });
  assert.equal(invertedRange.status, 416, "起点大于终点的 Range 应返回 416");

  // 非数字 Range
  const garbageRange = await fetch(mediaUrl, { headers: { Range: "bytes=abc-def" } });
  assert.equal(garbageRange.status, 416, "无法解析的 Range 应返回 416");

  // 后缀 Range（bytes=-3 取最后 3 字节）
  const suffixRange = await fetch(mediaUrl, { headers: { Range: "bytes=-3" } });
  assert.equal(suffixRange.status, 206, "后缀 Range 应返回 206");
  assert.equal(suffixRange.headers.get("content-range"), `bytes ${firstMedia.size - 3}-${firstMedia.size - 1}/${firstMedia.size}`);

  // ---------- 4. Cookie 安全属性 ----------
  await jsonRequest(localBaseUrl, "/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  const ov2 = (await jsonRequest(localBaseUrl, "/api/overview")).result;
  const uncategorized = ov2.accessControl.categories.find((category) => category.system);
  // 建立“授权目录”分类并放入 SecureA；SecureB 留在“未分类”，保证已索引但未授权。
  const authorizedCategory = (await jsonRequest(localBaseUrl, "/api/access-control/categories", {
    method: "POST",
    body: JSON.stringify({ name: "授权目录" }),
  })).result;
  const secureAFolder = ov2.displayFolders.find((folder) => folder.path === firstLibrary);
  assert.ok(secureAFolder, "扫描应列出 SecureA 文件夹");
  await jsonRequest(localBaseUrl, `/api/access-control/folders/${secureAFolder.id}`, {
    method: "PATCH",
    body: JSON.stringify({ categoryId: authorizedCategory.id }),
  });
  await jsonRequest(localBaseUrl, "/api/access-control/users", {
    method: "POST",
    body: JSON.stringify({ accessCode: "654321", categoryIds: [authorizedCategory.id] }),
  });
  const login = await jsonRequest(lanBaseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ accessCode: "654321" }),
  });
  assert.equal(login.response.status, 200, "正确访问码应登录成功");
  const setCookie = login.response.headers.get("set-cookie") || "";
  assert.ok(setCookie.toLowerCase().includes("httponly"), "会话 Cookie 应带 HttpOnly");
  assert.ok(setCookie.toLowerCase().includes("samesite=strict"), "会话 Cookie 应带 SameSite=Strict");
  assert.ok(setCookie.toLowerCase().includes("path=/"), "会话 Cookie 应限定 Path=/");
  const sessionCookie = setCookie.split(";")[0];

  // ---------- 5. 越权直链：字幕/缩略图/流 均应被后端拒绝 ----------
  const secondMedia = overview.media.find((media) => media.fileName === "second.mp4");
  assert.ok(secondMedia, "扫描应识别第二个测试视频");
  const unauthorizedUrls = [
    `${lanBaseUrl}/api/media/${secondMedia.id}/stream`,
    `${lanBaseUrl}/api/media/${secondMedia.id}/thumbnail`,
    ...(secondMedia.subtitles || []).map((subtitle) => `${lanBaseUrl}/api/media/${secondMedia.id}/subtitles/${subtitle.id}`),
  ];
  for (const url of unauthorizedUrls) {
    const response = await fetch(url, { headers: { Cookie: sessionCookie } });
    assert.equal(response.status, 404, `未授权直链 ${url} 应返回 404`);
  }

  // 已授权视频的字幕应可读
  const allowedSubtitle = firstMedia.subtitles.find((subtitle) => subtitle.name.endsWith(".srt"));
  assert.ok(allowedSubtitle, "已授权视频应关联外挂字幕");
  const subtitleResponse = await fetch(`${lanBaseUrl}/api/media/${firstMedia.id}/subtitles/${allowedSubtitle.id}`, { headers: { Cookie: sessionCookie } });
  assert.equal(subtitleResponse.status, 200, "已授权视频的字幕应可读取");

  // ---------- 6. X-Forwarded-For 不能伪造本机身份 ----------
  // 通过局域网地址发起请求（服务端看到的是非回环 remoteAddress），
  // 即使伪造 X-Forwarded-For 也不应获得本机管理权限。
  const forged = await fetch(`${lanBaseUrl}/api/overview`, { headers: { "X-Forwarded-For": "127.0.0.1" } });
  assert.equal(forged.status, 403, "伪造 X-Forwarded-For 不应绕过本机管理限制");

  // ---------- 7. CSRF/Origin 校验 ----------
  const crossOrigin = await fetch(`${localBaseUrl}/api/access-control/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
    body: JSON.stringify({ accessCode: "111222", categoryIds: [uncategorized.id] }),
  });
  assert.equal(crossOrigin.status, 403, "跨站 Origin 的写操作应被拒绝");

  // ---------- 8. 登录锁定层级：访问码级 ----------
  // 同一错误访问码连续失败 5 次后，该访问码被锁定（第 6 次仍 429）。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await jsonRequest(lanBaseUrl, "/api/auth/login", { method: "POST", body: JSON.stringify({ accessCode: "000000" }) });
  }
  const lockedCode = await jsonRequest(lanBaseUrl, "/api/auth/login", { method: "POST", body: JSON.stringify({ accessCode: "000000" }) });
  assert.equal(lockedCode.response.status, 429, "同一访问码连续失败 5 次后应被锁定");
  assert.equal(lockedCode.result.code, "LOGIN_RATE_LIMITED");

  // ---------- 9. 视频传输上限（maxStreams） ----------
  // 传输槽位在响应结束时才释放。10 路整文件传输保持“已返回响应头但未读完
  // 正文”，槽位始终被占用；此时发出的第 11 路请求应被拒绝。
  const streamRequests = [];
  for (let i = 0; i < 10; i += 1) {
    const controller = new AbortController();
    streamRequests.push({ controller, promise: fetch(`${lanBaseUrl}/api/media/${firstMedia.id}/stream`, { headers: { Cookie: sessionCookie, Range: "bytes=0-" }, signal: controller.signal }) });
  }
  const settled = await Promise.all(streamRequests.map((entry) => entry.promise));
  assert.ok(settled.every((response) => response.status === 206), "前 10 路视频传输应全部成功");
  const overflowResponse = await fetch(`${lanBaseUrl}/api/media/${firstMedia.id}/stream`, { headers: { Cookie: sessionCookie, Range: "bytes=0-0" } });
  assert.equal(overflowResponse.status, 503, "第 11 路视频传输应被拒绝");
  const overflowBody = await overflowResponse.json();
  assert.equal(overflowBody.code, "STREAM_LIMIT");
  for (const entry of streamRequests) entry.controller.abort();

  console.log("安全加固集成测试通过：畸形 URL、路径穿越、Range 边界、Cookie 属性、越权直链、XFF 伪造、CSRF、登录锁定与流媒体上限均符合预期。");
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
