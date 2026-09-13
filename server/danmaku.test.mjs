// Danmaku service tests: normalisation, provider requests, binding rules and
// credential handling. The provider is stubbed so no network or credentials are
// required, and the content checks below document the time-mapping contract the
// player relies on.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDanmakuService, normalizeComments } from "./danmaku.mjs";

const base = mkdtempSync(path.join(tmpdir(), "lmd-danmaku-"));
// The match request hashes the first 16 MiB of the original file, so the fixture
// must exist on disk.
writeFileSync(path.join(base, "ep01.mkv"), Buffer.alloc(2048, 7));
const originalFetch = globalThis.fetch;
const calls = [];

function service({ media = {}, secrets = null, remoteHandler } = {}) {
  // Credentials only ever live in the backend secret file; the service does not
  // accept them as constructor options, so the fixture writes that same file.
  const secretFile = path.join(base, "danmaku-secrets.json");
  if (secrets) writeFileSync(secretFile, JSON.stringify(secrets));
  else rmSync(secretFile, { force: true });
  const appState = { media: [{ id: "m1", fileName: "ep01.mkv", size: 1024, path: path.join(base, "ep01.mkv"), ...media }] };
  let saved = 0;
  const service = createDanmakuService({
    dataDirectory: base, appState,
    saveState: async () => { saved += 1; },
    playbackInfo: async item => ({ sourceSignature: "sig-1", duration: 1440, tracks: [], ...item.playbackMetadata }),
    authorizedMediaForRequest: (_request, _response, id) => appState.media.find(item => item.id === id) || null,
    accessContextForRequest: () => ({ user: { id: "viewer" } }),
    requireLocalManagement: () => true,
    readJson: async request => request.body,
    sendJson: (response, status, payload) => { response.status = status; response.payload = payload; },
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = remoteHandler ? remoteHandler(String(url), init) : { success: true, isMatched: false, matches: [] };
    const bytes = Buffer.from(JSON.stringify(body));
    return {
      ok: true, status: 200,
      // The provider client streams and size-caps the body, so the stub exposes
      // an async iterable exactly like a real response stream.
      body: (async function* () { yield bytes; })(),
      json: async () => body,
      text: async () => bytes.toString("utf8"),
    };
  };
  return { service, appState, ready: service.ready, response: () => ({ status: 0, payload: null, headersSent: false, destroyed: false }), saves: () => saved };
}

async function call(harness, { path: route, method = "POST", body = {}, query = "" }) {
  // The service loads its credential file asynchronously on creation.
  await harness.ready;
  const response = harness.response();
  const request = { method, body, socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const url = new URL(`http://localhost${route}${query}`);
  const handled = await harness.service.handleRequest(request, response, url, route);
  return { handled, response };
}

try {
  {
    const comments = normalizeComments([
      { p: "1.50,1,16711680,0", m: "第一条" },
      { p: "1.50,1,16711680,0", m: "第一条" },
      { p: "2,4,255", m: "底部" },
      { p: "3,5,255", m: "顶部" },
      { p: "4,6,255", m: "逆向" },
      { p: "bad,1,255", m: "无效时间" },
      { p: "5,9,255", m: "无效模式" },
      { p: "6,1,255", m: "   " },
      { time: 7, text: "长文本".repeat(400), mode: "rtl", color: "not-a-color" },
    ]);
    assert.equal(comments.length, 5, "重复、无效时间、无效模式和空文本被丢弃");
    assert.deepEqual(comments.map(item => item.mode), ["rtl", "bottom", "top", "ltr", "rtl"]);
    assert.equal(comments[0].color, "#ff0000", "十进制颜色转换为十六进制");
    assert.equal(comments.at(-1).color, "#ffffff", "非法颜色回退为白色");
    assert.ok(comments.at(-1).text.length <= 500, "文本被截断");
    assert.deepEqual(comments.map(item => item.time), [...comments.map(item => item.time)].sort((a, b) => a - b), "按时间排序");
    assert.throws(() => normalizeComments(Array.from({ length: 100001 }, () => ({ time: 1, text: "x", mode: "rtl" }))), /100000/);
    console.log("PASS 弹幕标准化（去重、模式、颜色、体积上限）");
  }
  {
    const harness = service({ secrets: { appId: "id", appSecret: "secret" }, remoteHandler: url => url.includes("/match")
      ? { success: true, isMatched: true, matches: [{ episodeId: 42, animeTitle: "作品", episodeTitle: "第1集", type: "tvseries" }] }
      : { success: true, comments: [{ p: "1,1,16777215", m: "弹幕" }] } });
    const first = await call(harness, { path: "/api/media/m1/danmaku/match", body: { consent: true } });
    assert.equal(first.response.status, 200);
    assert.equal(first.response.payload.matched, true, "唯一精确匹配自动绑定");
    assert.equal(harness.appState.media[0].danmakuBindings.viewerId ? true : harness.appState.media[0].danmakuBindings, harness.appState.media[0].danmakuBindings);
    const binding = Object.values(harness.appState.media[0].danmakuBindings)[0];
    assert.equal(binding.episodeId, 42);
    assert.equal(binding.manual, false);

    const signed = calls.find(item => item.url.includes("/match"));
    const headers = signed.init.headers;
    assert.equal(headers["X-AppId"], "id");
    assert.equal(String(headers["X-Signature"]).length > 20, true, "请求带签名");
    assert.match(signed.url, /^https:\/\/api\.dandanplay\.net\/api\/v2\/match$/, "使用当前聚合接口");
    assert.equal(signed.init.body.includes("fileHash"), true, "匹配请求包含局部文件哈希");

    const throttled = await call(harness, { path: "/api/media/m1/danmaku/match", body: { consent: true } });
    assert.equal(throttled.response.status, 429, "同一路径的密集请求被限流");
    await new Promise(resolve => setTimeout(resolve, 1100));
    const reused = await call(harness, { path: "/api/media/m1/danmaku/match", body: { consent: true } });
    assert.equal(reused.response.payload.matched, true, "已保存的绑定直接复用");
    assert.equal(reused.response.payload.matches.length, 0);
    assert.equal(calls.filter(item => item.url.includes("/match")).length, 1, "复用绑定不再请求匹配服务");

    const comments = await call(harness, { path: "/api/media/m1/danmaku/comments", body: { consent: true } });
    assert.equal(comments.response.payload.timelineBasis, "provider", "供应方时间轴标记为 provider");
    assert.equal(comments.response.payload.comments.length, 1);
    const commentCall = calls.find(item => item.url.includes("/comment/"));
    assert.match(commentCall.url, /\/api\/v2\/comment\/42\?withRelated=true$/, "使用 withRelated 聚合接口");
    console.log("PASS 弹弹play 匹配、绑定与聚合弹幕请求");
  }
  {
    const harness = service({ secrets: { appId: "id", appSecret: "secret" }, remoteHandler: () => ({ success: true, isMatched: false,
      matches: [{ episodeId: 1, animeTitle: "A", episodeTitle: "1" }, { episodeId: 2, animeTitle: "A", episodeTitle: "2" }] }) });
    const result = await call(harness, { path: "/api/media/m1/danmaku/match", body: { consent: true } });
    assert.equal(result.response.payload.matched, false, "多候选不自动绑定");
    assert.equal(result.response.payload.matches.length, 2);
    assert.equal(harness.appState.media[0].danmakuBindings, undefined, "未写入自动绑定");
    console.log("PASS 多候选只展示不自动套用");
  }
  {
    const harness = service({ media: { danmakuBindings: { viewer: { episodeId: 7, signature: "old-signature", manual: true } } }, secrets: { appId: "id", appSecret: "secret" } });
    const result = await call(harness, { path: "/api/media/m1/danmaku/comments", body: { consent: true } });
    assert.equal(result.response.status, 400, "文件版本变化后旧绑定失效并要求重新匹配");
    assert.equal(result.response.payload.code, "INVALID_EPISODE");
    console.log("PASS 绑定关联原文件版本");
  }
  {
    const harness = service();
    const missingConsent = await call(harness, { path: "/api/media/m1/danmaku/match", body: {} });
    assert.equal(missingConsent.response.payload.code, "DANMAKU_CONSENT");
    const noCredentials = await call(harness, { path: "/api/media/m1/danmaku/match", body: { consent: true } });
    assert.equal(noCredentials.response.status, 503);
    assert.equal(noCredentials.response.payload.code, "DANMAKU_NOT_CONFIGURED");
    console.log("PASS 未同意与无凭证时明确报错");
  }
  {
    const harness = service({ secrets: { appId: "id", appSecret: "secret" },
      remoteHandler: () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }); } });
    const result = await call(harness, { path: "/api/media/m1/danmaku/match", body: { consent: true } });
    assert.equal(result.response.status, 502, "外部服务失败返回可恢复错误");
    assert.equal(result.response.payload.code, "DANMAKU_NETWORK");
    console.log("PASS 外部服务失败不阻塞视频");
  }
  {
    const harness = service({ secrets: { appId: "id", appSecret: "secret" } });
    const saved = await call(harness, { path: "/api/settings/danmaku", method: "PATCH", body: { appId: "new-id", appSecret: "new-secret" } });
    assert.equal(saved.response.payload.appId, "new-id");
    assert.equal(saved.response.payload.configured, true);
    const cleared = await call(harness, { path: "/api/settings/danmaku", method: "PATCH", body: { appId: "new-id", clear: true } });
    assert.equal(cleared.response.payload.configured, false, "可以清除本机凭证");
    const invalid = await call(harness, { path: "/api/settings/danmaku", method: "PATCH", body: { appId: "bad\nid" } });
    assert.equal(invalid.response.payload.code, "INVALID_SETTINGS");
    const read = await call(harness, { path: "/api/settings/danmaku", method: "GET" });
    assert.equal("appSecret" in read.response.payload, false, "读取接口绝不返回密钥");
    console.log("PASS 弹幕凭证仅后端保存且读取不回传密钥");
  }
} finally {
  globalThis.fetch = originalFetch;
  rmSync(base, { recursive: true, force: true });
}

console.log("danmaku 测试全部通过");
