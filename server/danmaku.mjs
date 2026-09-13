import { createHash } from "node:crypto";
import { open, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { playbackError } from "./playback-planner.mjs";

export function normalizeComments(input) {
  const list = Array.isArray(input) ? input : input?.comments;
  if (!Array.isArray(list) || list.length > 100000) throw playbackError("INVALID_DANMAKU", "弹幕格式无效或数量超过 100000 条", 400);
  const seen = new Set(), output = [];
  for (const item of list) {
    const fields = String(item.p || "").split(",");
    const time = Number(item.time ?? fields[0]), text = String(item.text ?? item.m ?? "").slice(0, 500);
    const mode = ["rtl", "ltr", "top", "bottom"].includes(item.mode) ? item.mode : ({ 1: "rtl", 4: "bottom", 5: "top", 6: "ltr" }[Number(fields[1])]);
    let color = item.color || `#${(Number(fields[2]) >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
    if (!/^#[\da-f]{6}$/i.test(color)) color = "#ffffff";
    if (!Number.isFinite(time) || time < 0 || time > 7 * 86400 || !text.trim() || !mode) continue;
    const key = `${Math.round(time * 10)}:${mode}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key); output.push({ time, text, mode, color });
  }
  return output.sort((a, b) => a.time - b.time);
}

export function createDanmakuService({ dataDirectory, appState, saveState, playbackInfo, authorizedMediaForRequest, accessContextForRequest, requireLocalManagement, readJson, sendJson }) {
  const secretFile = path.join(dataDirectory, "danmaku-secrets.json"), cache = new Map(), pending = new Map(), lastCalls = new Map();
  let secrets = {};
  const ready = readFile(secretFile, "utf8").then(text => { secrets = JSON.parse(text); }).catch(error => { if (error.code !== "ENOENT") console.error("弹幕配置读取失败"); });
  const credentials = () => ({ appId: process.env.LMD_DANDANPLAY_APP_ID || secrets.appId || "", appSecret: process.env.LMD_DANDANPLAY_APP_SECRET || secrets.appSecret || "" });
  async function remote(apiPath, body) {
    const { appId, appSecret } = credentials();
    if (!appId || !appSecret) throw playbackError("DANMAKU_NOT_CONFIGURED", "请在服务器运行设置中配置弹弹play AppId 和 AppSecret；仍可导入本地弹幕", 503);
    const timestamp = String(Math.floor(Date.now() / 1000)), pathname = apiPath.split("?")[0];
    const signature = createHash("sha256").update(appId + timestamp + pathname + appSecret).digest("base64");
    const response = await fetch(`https://api.dandanplay.net${apiPath}`, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(12000),
      headers: { "X-AppId": appId, "X-Timestamp": timestamp, "X-Signature": signature, "Content-Type": "application/json", "User-Agent": "LMD/0.3" }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) { await response.body?.cancel(); throw playbackError(response.status === 429 ? "DANMAKU_QUOTA" : "DANMAKU_REMOTE", response.status === 429 ? "弹幕服务额度已达上限，请稍后再试" : "弹幕服务暂不可用，请检查服务器凭证或稍后重试", 502); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > 24 * 1024 ** 2) throw playbackError("DANMAKU_TOO_LARGE", "外部弹幕数据过大", 502); chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (result.success === false) throw playbackError("DANMAKU_REMOTE", "弹幕服务未能完成请求", 502);
    return result;
  }
  async function cached(key, work) {
    const saved = cache.get(key); if (saved && saved.until > Date.now()) return saved.value;
    if (!pending.has(key)) pending.set(key, work().then(value => {
      if (cache.size >= 50) cache.delete(cache.keys().next().value);
      cache.set(key, { value, until: Date.now() + 6 * 3600000 }); return value;
    }).finally(() => pending.delete(key)));
    return pending.get(key);
  }
  async function handleRequest(request, response, _url, pathname) {
    if (pathname !== "/api/settings/danmaku" && !/^\/api\/media\/[^/]+\/danmaku\/(match|comments|binding)$/.test(pathname)) return false;
    try {
      await ready;
      if (pathname === "/api/settings/danmaku") {
        if (!requireLocalManagement(request, response)) return true;
        if (request.method === "PATCH") {
          const body = await readJson(request);
          const appId = String(body.appId ?? secrets.appId ?? "").trim();
          const appSecret = body.clear ? "" : String(body.appSecret || secrets.appSecret || "").trim();
          if (appId.length > 128 || appSecret.length > 512 || /[\r\n]/.test(appId + appSecret)) throw playbackError("INVALID_SETTINGS", "弹幕凭证格式无效", 400);
          await mkdir(dataDirectory, { recursive: true });
          await writeFile(`${secretFile}.tmp`, JSON.stringify({ appId, appSecret }), { mode: 0o600 }); await rename(`${secretFile}.tmp`, secretFile);
          secrets = { appId, appSecret }; cache.clear();
        } else if (request.method !== "GET") throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
        sendJson(response, 200, { appId: credentials().appId, configured: Boolean(credentials().appId && credentials().appSecret), environmentManaged: Boolean(process.env.LMD_DANDANPLAY_APP_SECRET) }); return true;
      }
      const mediaId = pathname.split("/")[3], media = authorizedMediaForRequest(request, response, mediaId);
      if (!media) return true;
      if (request.method !== "POST") throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
      const body = await readJson(request);
      if (body.consent !== true) throw playbackError("DANMAKU_CONSENT", "请先启用联网弹幕匹配", 400);
      const metadata = await playbackInfo(media);
      const viewer = accessContextForRequest(request)?.user?.id || "local";
      const owner = createHash("sha256").update(viewer).digest("hex").slice(0, 16);
      const bindings = media.danmakuBindings || {};
      const binding = bindings[owner]?.signature === metadata.sourceSignature ? bindings[owner] : null;
      if (pathname.endsWith("/binding")) {
        const episodeId = Number(body.episodeId);
        if (!Number.isSafeInteger(episodeId) || episodeId <= 0) throw playbackError("INVALID_EPISODE", "请选择有效的番剧集数", 400);
        media.danmakuBindings = { ...bindings, [owner]: { episodeId, signature: metadata.sourceSignature, manual: true, title: String(body.title || "").slice(0, 200) } };
        await saveState(); sendJson(response, 200, { binding: media.danmakuBindings[owner] }); return true;
      }
      const limitKey = `${viewer}:${request.socket.remoteAddress}:${pathname}`;
      if (Date.now() - (lastCalls.get(limitKey) || 0) < 1000) throw playbackError("DANMAKU_RATE_LIMIT", "请稍后再请求弹幕", 429);
      lastCalls.set(limitKey, Date.now()); if (lastCalls.size > 1000) lastCalls.delete(lastCalls.keys().next().value);
      if (pathname.endsWith("/match")) {
        if (binding && !body.rematch) { sendJson(response, 200, { binding, matches: [], matched: true }); return true; }
        const result = await cached(`match:${mediaId}:${metadata.sourceSignature}`, async () => {
          const file = await open(media.path, "r"); let fileHash;
          try { const buffer = Buffer.alloc(Math.min(16 * 1024 ** 2, media.size)); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); fileHash = createHash("md5").update(buffer.subarray(0, bytesRead)).digest("hex"); }
          finally { await file.close(); }
          return remote("/api/v2/match", { fileName: media.fileName, fileHash, fileSize: media.size, videoDuration: Math.round(metadata.duration), matchMode: "hashAndFileName" });
        });
        const matches = (Array.isArray(result.matches) ? result.matches : []).slice(0, 50).map(item => ({ episodeId: Number(item.episodeId), animeTitle: String(item.animeTitle || ""), episodeTitle: String(item.episodeTitle || ""), type: String(item.type || "") })).filter(item => Number.isSafeInteger(item.episodeId) && item.episodeId > 0);
        // Only the provider's explicit exact match flag permits silent binding.
        const matched = result.isMatched === true && matches.length === 1;
        if (matched && !binding?.manual) {
          media.danmakuBindings = { ...bindings, [owner]: { episodeId: matches[0].episodeId, signature: metadata.sourceSignature, manual: false, title: `${matches[0].animeTitle} ${matches[0].episodeTitle}` } }; await saveState();
        }
        sendJson(response, 200, { matched, matches, binding: matched ? media.danmakuBindings[owner] : null }); return true;
      }
      const episodeId = Number(body.episodeId || binding?.episodeId);
      if (!Number.isSafeInteger(episodeId) || episodeId <= 0) throw playbackError("INVALID_EPISODE", "请先匹配或选择集数", 400);
      const comments = await cached(`comments:${episodeId}`, async () => normalizeComments(await remote(`/api/v2/comment/${episodeId}?withRelated=true`)));
      sendJson(response, 200, { source: "弹弹play聚合", timelineBasis: "provider", episodeId, comments }); return true;
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 502, { error: error.status ? error.message : "弹幕服务连接失败，请稍后再试", code: error.code || "DANMAKU_NETWORK" });
      return true;
    }
  }
  return { handleRequest, ready };
}
