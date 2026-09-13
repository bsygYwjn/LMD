import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { METADATA_VERSION, normalizePlaybackSettings, planPlayback, playbackError } from "./playback-planner.mjs";
import { readMp4Boxes, parseInitialization, fragmentTiming, rewriteInitializationDuration } from "./playback-mp4.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const sourceSignature = media => `${Number(media.size)}:${media.modifiedAt}`;

export function createPlaybackService(deps) {
  const { appState, cacheDirectory, getMediaTools, probeVideo, saveState, spawnTracked, runCommand,
    authorizedMediaForRequest, accessContextForRequest, requireLocalManagement, readJson, sendJson, streamFile } = deps;  const root = path.join(cacheDirectory, "playback");
  const sessions = new Map(), pipelines = new Map(), probes = new Map(), entries = new Map();
  let stopped = false, cacheBytes = 0, cleaning = null, encoderProbe = null;
  let settings = normalizePlaybackSettings(appState.settings.videoPlayback);
  const metrics = { sessionsCreated: 0, pipelinesCreated: 0, cacheHits: 0, fallbacks: 0, seeks: 0, bytesGenerated: 0 };

  const ready = (async () => {
    await mkdir(root, { recursive: true });
    // Only service-owned SHA directories are inspected; no legacy cache paths.
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9]{64}$/.test(item.name)) continue;
      const dir = path.join(root, item.name);
      for (const file of await readdir(dir, { withFileTypes: true })) {
        if (!file.isFile() || !/^(?:init\.mp4|\d+\.m4s|.*\.part)$/.test(file.name)) continue;
        const filePath = path.join(dir, file.name), info = await stat(filePath);
        entries.set(filePath, { size: info.size, accessed: info.mtimeMs, pins: 0, pipeline: null }); cacheBytes += info.size;
      }
    }
  })();

  async function info(media) {
    const fileStat = await stat(media.path).catch(() => null);
    if (!fileStat?.isFile()) throw playbackError("SOURCE_MISSING", "原始视频不存在，可能已移动", 404);
    const signature = `${fileStat.size}:${fileStat.mtime.toISOString()}`;
    // The metadata is only reusable when it describes the bytes on disk now. A
    // catalog record whose identity fields lag behind (an interrupted scan, a
    // file replaced under a session) must be re-probed instead of trusting a
    // signature that was computed from older stat data.
    const recordSignature = media.size !== undefined ? `${Number(media.size)}:${media.modifiedAt}` : signature;
    if (media.playbackMetadata?.version === METADATA_VERSION && media.playbackMetadata.sourceSignature === signature
      && media.playbackMetadata.sourceSignature === recordSignature) return media.playbackMetadata;
    const key = `${media.id}:${signature}`;
    if (!probes.has(key)) probes.set(key, (async () => {
      if (!getMediaTools().available) throw playbackError("TOOLS_UNAVAILABLE", "FFmpeg 尚未就绪，请在服务器运行设置中安装", 503);
      const result = await probeVideo(media.path);
      if (!result.playbackMetadata?.tracks.some(track => track.type === "video" && !track.attachedPicture)) throw playbackError("PROBE_FAILED", "无法分析这个媒体文件", 422);
      const metadata = { ...result.playbackMetadata, sourceSignature: signature };
      const current = appState.media.find(item => item.id === media.id);
      if (current) {
        current.playbackMetadata = metadata;
        // Keep the catalog identity aligned with the probed bytes so later
        // session requests agree with the stored signature.
        current.size = fileStat.size; current.modifiedAt = fileStat.mtime.toISOString();
        await saveState();
      }
      media.playbackMetadata = metadata;
      return metadata;
    })().finally(() => probes.delete(key)));
    return probes.get(key);
  }

  async function clean(required = 0) {
    if (cleaning) { await cleaning; return clean(required); }
    cleaning = (async () => {
      const now = Date.now();
      const candidates = [...entries].sort((a, b) => a[1].accessed - b[1].accessed);
      for (const [file, entry] of candidates) {
        const pipeline = entry.pipeline;
        const protectedByManifest = pipeline && pipeline.consumers.size && pipeline.published.has(file);
        if (entry.pins || protectedByManifest) continue;
        if (now - entry.accessed < settings.cacheTtlSeconds * 1000 && cacheBytes + required <= settings.cacheMaxBytes) continue;
        await rm(file, { force: true }); entries.delete(file); cacheBytes -= entry.size;
        if (pipeline) pipeline.evicted = true;
      }
      for (const [key, pipeline] of pipelines) {
        if (!pipeline.consumers.size && !pipeline.child && (pipeline.evicted || now - pipeline.accessed > settings.cacheTtlSeconds * 1000)) pipelines.delete(key);
      }
      if (cacheBytes + required > settings.cacheMaxBytes) throw playbackError("CACHE_FULL", "播放缓存空间不足，请稍后重试或调整缓存容量", 507);
    })();
    try { await cleaning; } finally { cleaning = null; }
  }

  async function publish(pipeline, name, buffer) {
    await clean(buffer.length);
    if (pipeline.cancelled) throw playbackError("CANCELLED", "播放处理已取消", 409);
    const file = path.join(pipeline.directory, name);
    await writeFile(`${file}.part`, buffer);
    await rename(`${file}.part`, file);
    const previous = entries.get(file);
    cacheBytes += buffer.length - (previous?.size || 0);
    entries.set(file, { size: buffer.length, accessed: Date.now(), pins: 0, pipeline });
    metrics.bytesGenerated += buffer.length;
    return file;
  }

  async function chooseEncoder() {
    if (settings.encoder !== "auto") return settings.encoder;
    if (!encoderProbe) encoderProbe = (async () => {
      for (const name of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
        try {
          await runCommand(getMediaTools().ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=size=64x64:rate=1", "-frames:v", "1", "-c:v", name, "-f", "null", "-"], 3500);
          return name;
        } catch { /* Compiled-in encoders are not necessarily usable hardware. */ }
      }
      return "libx264";
    })();
    return encoderProbe;
  }

  function command(pipeline, encoder) {
    const { plan, metadata, target, media } = pipeline;
    const copy = plan.video.action === "COPY";
    const args = ["-hide_banner", "-nostdin", "-loglevel", "info", ...(copy ? ["-debug_ts"] : []),
      "-ss", String(target), "-i", media.path, "-map", `0:${plan.video.track.index}`];
    if (plan.audio) args.push("-map", `0:${plan.audio.track.index}`);
    args.push("-sn", "-dn", "-map_metadata", "-1");
    if (copy) args.push("-c:v", "copy");
    else {
      const filters = [];
      if (plan.video.toneMap) filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv");
      filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p", "showinfo");
      args.push("-vf", filters.join(","), "-c:v", encoder, "-g", String(Math.max(24, Math.round((plan.video.track.frameRate || 24) * 2))), "-force_key_frames", "expr:gte(t,n_forced*2)");
      if (encoder === "libx264") args.push("-preset", "veryfast", "-crf", "20");
      else if (encoder === "h264_nvenc") args.push("-preset", "p4", "-cq", "21", "-b:v", "0");
      else args.push("-b:v", String(Math.max(3000000, metadata.bitRate || 6000000)));
    }
    if (plan.video.codec === "hevc") args.push("-tag:v", "hvc1");
    if (plan.audio) {
      if (plan.audio.action === "COPY") args.push("-c:a", "copy");
      else args.push("-c:a", "aac", "-b:a", plan.audio.channels > 2 ? "384k" : "256k", "-ac", String(plan.audio.channels || 2), "-ar", "48000");
    } else args.push("-an");
    args.push("-avoid_negative_ts", "disabled", "-max_muxing_queue_size", "4096", "-movflags", "+empty_moov+default_base_moof+frag_keyframe", "-f", "mp4", "pipe:1");
    return args;
  }

  function wake(pipeline) { for (const resolve of pipeline.waiters) resolve(); pipeline.waiters.clear(); }
  function wait(pipeline, ms = 200) { return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); pipeline.waiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms); pipeline.waiters.add(finish);
  }); }
  function refreshPublished(pipeline) {
    const positions = [...pipeline.consumers].map(id => sessions.get(id)?.position).filter(Number.isFinite);
    const oldest = positions.length ? Math.min(...positions) - settings.backBufferSeconds : 0;
    pipeline.visible = pipeline.fragments.filter(fragment => fragment.sourceEnd > oldest);
    pipeline.published = new Set([pipeline.initPath, ...pipeline.visible.map(fragment => fragment.file)].filter(Boolean));
  }

  async function produce(pipeline, software = false) {
    let encoder = pipeline.plan.video.action === "COPY" ? "copy" : software ? "libx264" : await chooseEncoder();
    if (pipeline.cancelled) return;
    await mkdir(pipeline.directory, { recursive: true });
    const child = spawnTracked(getMediaTools().ffmpeg, command(pipeline, encoder), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    pipeline.child = child; pipeline.encoder = encoder; metrics.pipelinesCreated++;
    let stderr = "", lines = "", firstInputTime = null, moof = null, initialization = [], tracks = null;
    let lastOutput = Date.now(), backpressured = false, processError = null;
    const exited = new Promise(resolve => {
      child.once("error", error => { processError = error; resolve(-1); });
      child.once("close", code => resolve(code));
    });
    child.stderr.on("data", chunk => {
      const text = chunk.toString(); stderr = (stderr + text).slice(-8192); lines += text;
      const complete = lines.split(/\r?\n/); lines = complete.pop().slice(-16384);
      for (const line of complete) {
        if (firstInputTime != null) break;
        if (pipeline.plan.video.action === "COPY") {
          const match = /demuxer -> .*type:video .*pkt_pts_time:([-+\d.e]+)/.exec(line);
          if (match && Number.isFinite(Number(match[1]))) firstInputTime = Number(match[1]) - pipeline.metadata.startTime;
        } else {
          const match = /showinfo.*\bn:\s*0\s+pts:.*?pts_time:([-+\d.e]+)/.exec(line);
          if (match && Number.isFinite(Number(match[1]))) firstInputTime = pipeline.target + Number(match[1]);
        }
      }
    });
    const watchdog = setInterval(() => {
      if (!backpressured && Date.now() - lastOutput > settings.noOutputSeconds * 1000) {
        pipeline.error = playbackError("PIPELINE_TIMEOUT", "媒体处理长时间没有输出，请重试", 504); child.kill(); wake(pipeline);
      }
    }, 1000);
    try {
      for await (const box of readMp4Boxes(child.stdout)) {
        lastOutput = Date.now();
        if (pipeline.cancelled || stopped) break;
        if (!tracks) {
          initialization.push(box.buffer);
          if (box.type !== "moov") continue;
          const init = rewriteInitializationDuration(Buffer.concat(initialization), pipeline.metadata.duration);
          initialization = [];
          tracks = parseInitialization(init);
          pipeline.initPath = await publish(pipeline, "init.mp4", init);
          continue;
        }
        if (box.type === "moof") { moof = box.buffer; continue; }
        if (box.type !== "mdat" || !moof) continue;
        const timing = fragmentTiming(moof, tracks);
        if (pipeline.timeOffset == null) {
          // stderr and stdout are separate pipes: allow the first clock record to arrive.
          for (let i = 0; firstInputTime == null && i < 20; i++) await pause(10);
          if (firstInputTime == null) throw playbackError("TIMELINE_UNAVAILABLE", "无法确定视频的原始时间轴", 422);
          pipeline.timeOffset = firstInputTime - timing.start;
        }
        const sequence = pipeline.fragments.length;
        const file = await publish(pipeline, `${sequence}.m4s`, Buffer.concat([moof, box.buffer])); moof = null;
        const fragment = { sequence, file, start: timing.start, end: timing.end,
          sourceStart: timing.start + pipeline.timeOffset, sourceEnd: timing.end + pipeline.timeOffset };
        pipeline.fragments.push(fragment); pipeline.maxDuration = Math.max(pipeline.maxDuration, timing.end - timing.start);
        pipeline.accessed = Date.now(); refreshPublished(pipeline); wake(pipeline);
        // Backpressure reaches FFmpeg through its stdout pipe. It cannot keep
        // producing files while viewers pause or stop consuming this window.
        while (!pipeline.cancelled && !stopped) {
          const positions = [...pipeline.consumers].map(id => sessions.get(id)?.position).filter(Number.isFinite);
          const furthest = positions.length ? Math.max(...positions) : pipeline.target;
          if (fragment.sourceEnd < furthest + settings.aheadSeconds) break;
          backpressured = true; await wait(pipeline, 1000);
        }
        backpressured = false; lastOutput = Date.now();
      }
      if (pipeline.cancelled || stopped) child.kill();
      const exitCode = await exited;
      if (!pipeline.cancelled && !stopped && exitCode !== 0) throw processError || pipeline.error || playbackError("PIPELINE_FAILED", "媒体处理失败，请尝试兼容播放", 422);
      if (!pipeline.cancelled && !stopped) pipeline.eof = true;
    } catch (error) {
      child.kill(); await exited;
      if (!pipeline.cancelled && !stopped) {
        if (!pipeline.fragments.length && encoder !== "copy" && encoder !== "libx264") {
          clearInterval(watchdog); pipeline.child = null;
          return produce(pipeline, true);
        }
        pipeline.error = error.code ? error : playbackError("PIPELINE_FAILED", "媒体分片处理失败", 422);
        console.error(`[playback ${pipeline.key.slice(0, 10)}] ${error.message}\n${stderr.slice(-2000)}`);
      }
    } finally { clearInterval(watchdog); if (pipeline.child === child) pipeline.child = null; wake(pipeline); }
  }

  function releasePipeline(session) {
    const pipeline = session.pipeline;
    if (!pipeline) return;
    pipeline.consumers.delete(session.id); session.pipeline = null; refreshPublished(pipeline); wake(pipeline);
    if (!pipeline.consumers.size) {
      clearTimeout(pipeline.releaseTimer);
      pipeline.releaseTimer = setTimeout(() => {
        if (!pipeline.consumers.size && pipeline.child) { pipeline.cancelled = true; pipeline.child.kill(); wake(pipeline); }
      }, settings.releaseGraceSeconds * 1000);
    }
  }
  function release(session) { releasePipeline(session); sessions.delete(session.id); }

  async function attach(session, target) {
    const { media, metadata, plan } = session;
    const version = metadata.sourceSignature;
    const config = JSON.stringify({ version, video: plan.video, audio: plan.audio, encoder: settings.encoder, packaging: 1 });
    let pipeline = [...pipelines.values()].find(item => item.config === config && item.media.id === media.id && !item.cancelled && !item.error && !item.evicted
      && item.target <= target && (item.fragments.at(-1)?.sourceEnd || item.target) >= target);
    if (!pipeline) {
      const key = hash(`${media.id}:${config}:${target}:${randomUUID()}`);
      pipeline = { key, config, media, metadata, plan, target, directory: path.join(root, key), consumers: new Set(),
        waiters: new Set(), fragments: [], visible: [], published: new Set(), timeOffset: null, initPath: null, child: null,
        cancelled: false, eof: false, evicted: false, error: null, accessed: Date.now(), maxDuration: 1 };
      pipelines.set(key, pipeline);
    } else metrics.cacheHits++;
    clearTimeout(pipeline.releaseTimer); pipeline.consumers.add(session.id); session.pipeline = pipeline; session.position = target;
    refreshPublished(pipeline); wake(pipeline);
    if (!pipeline.promise) pipeline.promise = produce(pipeline).catch(error => { pipeline.error = error; wake(pipeline); });
  }

  function descriptor(session) {
    const pipeline = session.pipeline;
    return { sessionId: session.id, generation: session.generation, mediaId: session.media.id,
      strategy: session.plan.strategy, plan: session.plan, transport: session.plan.transport, duration: session.metadata.duration,
      requestedTime: session.position, timeOffset: pipeline?.timeOffset ?? 0,
      sourceStart: pipeline?.fragments[0]?.sourceStart ?? session.position,
      readyEnd: pipeline?.fragments.at(-1)?.sourceEnd ?? session.metadata.duration,
      state: pipeline?.error ? "error" : !pipeline || pipeline.fragments.some(item => item.sourceEnd > session.position) ? "ready" : "preparing",
      eof: pipeline?.eof ?? true, error: pipeline?.error ? { code: pipeline.error.code, message: pipeline.error.message } : null,
      url: `/api/playback-sessions/${session.id}/${session.plan.strategy === "DIRECT" ? "file" : "manifest.m3u8"}?generation=${session.generation}`,
      heartbeatSeconds: settings.heartbeatSeconds, buffer: { aheadSeconds: settings.aheadSeconds, backBufferSeconds: settings.backBufferSeconds, maxBufferBytes: settings.maxBufferBytes },
      encoder: pipeline?.encoder || null };
  }

  async function waitForReady(session, generation) {
    const pipeline = session.pipeline;
    if (!pipeline) return;
    const deadline = Date.now() + settings.noOutputSeconds * 1000;
    while (!pipeline.error && !pipeline.cancelled && !pipeline.fragments.some(item => item.sourceEnd > session.position + 0.05)) {
      if (stopped || !sessions.has(session.id) || session.generation !== generation) throw playbackError("STALE_SESSION", "播放请求已被替换", 409);
      if (pipeline.eof || Date.now() > deadline) throw playbackError("PLAYBACK_TIMEOUT", "暂未获得目标位置的播放数据", 504);
      await wait(pipeline);
    }
    if (pipeline.error) throw pipeline.error;
    if (pipeline.cancelled) throw playbackError("SESSION_EXPIRED", "播放会话已过期，请重新加载", 410);
  }

  const ownerFor = request => hash(`${accessContextForRequest(request)?.user?.id || "local"}:${request.socket.remoteAddress || ""}`);
  const timers = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      // A session whose original file was replaced can never serve another byte,
      // so it is released immediately instead of waiting out the whole lease.
      if (sourceSignature(session.media) !== session.metadata.sourceSignature) { release(session); continue; }
      if (now - session.lastSeen > settings.leaseSeconds * 1000) release(session);
    }
    for (const pipeline of pipelines.values()) refreshPublished(pipeline);
  }, 1000);
  timers.unref();
  let lastCleanup = 0;
  const cleaner = setInterval(() => {
    if (Date.now() - lastCleanup < settings.cleanupSeconds * 1000) return;
    lastCleanup = Date.now(); void ready.then(() => clean()).catch(error => console.error(`[playback cache] ${error.message}`));
  }, 5000); cleaner.unref();

  async function handleRequest(request, response, url, pathname) {
    if (!/^\/api\/(?:playback-sessions(?:\/|$)|media\/[^/]+\/(?:info|playback-sessions)$|settings\/video-playback$)/.test(pathname)) return false;
    try {
      await ready;
      if (stopped) throw playbackError("SERVICE_STOPPING", "媒体服务正在停止", 503);
      if (pathname === "/api/settings/video-playback") {
        if (!requireLocalManagement(request, response)) return true;
        if (request.method === "PATCH") {
          const body = await readJson(request); settings = normalizePlaybackSettings({ ...settings, ...body });
          appState.settings.videoPlayback = settings; encoderProbe = null; await saveState();
        } else if (request.method !== "GET") throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
        // Local management only: the descriptor doubles as the acceptance
        // harness' view of which sessions exist, so ids are listed here.
        sendJson(response, 200, { settings, status: status(), sessionIds: [...sessions.keys()],
          sessions: [...sessions.values()].map(item => ({ id: item.id.slice(0, 8), generation: item.generation, position: Number(item.position.toFixed(1)),
            ageSeconds: Math.round((Date.now() - item.createdAt) / 1000), idleSeconds: Math.round((Date.now() - item.lastSeen) / 1000),
            hasPipeline: Boolean(item.pipeline), transport: item.plan.transport })) }); return true;
      }
      const mediaRoute = /^\/api\/media\/([^/]+)\/(info|playback-sessions)$/.exec(pathname);
      if (mediaRoute) {
        const media = authorizedMediaForRequest(request, response, mediaRoute[1]); if (!media) return true;
        const metadata = await info(media);
        if (mediaRoute[2] === "info" && request.method === "GET") { sendJson(response, 200, { mediaId: media.id, ...metadata }); return true; }
        if (request.method !== "POST") throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
        if (sessions.size >= (appState.settings.maxStreams || 10)) throw playbackError("STREAM_LIMIT", "同时播放的会话已达上限", 503);
        const body = await readJson(request), capabilities = body.capabilities || {};
        const plan = planPlayback(metadata, capabilities, body);
        const session = { id: randomUUID(), generation: 1, owner: ownerFor(request), media, metadata, capabilities, plan,
          position: Math.max(0, Math.min(finite(body.startTime), Math.max(0, metadata.duration - 0.05))), lastSeen: Date.now(), pipeline: null,
          createdAt: Date.now() };
        sessions.set(session.id, session); metrics.sessionsCreated++; if (plan.fallbackLevel) metrics.fallbacks++;
        let completed = false;
        response.once("close", () => { if (!completed) release(session); });
        try {
          if (plan.strategy !== "DIRECT") await attach(session, session.position);
          await waitForReady(session, 1);
          if (response.destroyed) { release(session); return true; }
          completed = true; sendJson(response, 201, descriptor(session));
        } catch (error) { release(session); throw error; }
        return true;
      }
      const route = /^\/api\/playback-sessions\/([^/]+)(?:\/(file|manifest\.m3u8|init\.mp4|\d+\.m4s))?$/.exec(pathname);
      if (!route) throw playbackError("NOT_FOUND", "播放地址不存在", 404);
      const session = sessions.get(route[1]);
      if (!session) throw playbackError("SESSION_EXPIRED", "播放会话已过期", 410);
      if (!authorizedMediaForRequest(request, response, session.media.id)) { release(session); return true; }
      if (ownerFor(request) !== session.owner) throw playbackError("SESSION_OWNER", "不能访问其他设备的播放会话", 403);
      // A replaced original file invalidates the session, its pipeline and the
      // client that owns it, so the player can restart from a clean state.
      if (sourceSignature(session.media) !== session.metadata.sourceSignature) {
        release(session);
        throw playbackError("SOURCE_CHANGED", "视频文件已更新，请重新打开这个视频", 409);
      }
      const resource = route[2];
      if (!resource && request.method === "DELETE") { release(session); sendJson(response, 200, { ok: true }); return true; }
      if (!resource && request.method === "PATCH") {
        const body = await readJson(request); session.lastSeen = Date.now();
        if (body.position !== undefined) session.position = Math.max(0, Math.min(finite(body.position), session.metadata.duration));
        if (body.seekTime !== undefined || body.audioTrackId !== undefined) {
          if (body.generation !== session.generation) throw playbackError("STALE_SESSION", "播放请求已被替换", 409);
          releasePipeline(session); session.generation++; metrics.seeks++;
          session.position = Math.max(0, Math.min(finite(body.seekTime, session.position), Math.max(0, session.metadata.duration - 0.05)));
          session.plan = planPlayback(session.metadata, session.capabilities, { ...session.plan, audioTrackId: body.audioTrackId ?? session.plan.audio?.track.id, videoTrackId: session.plan.video.track.id });
          if (session.plan.strategy !== "DIRECT") await attach(session, session.position);
          const generation = session.generation; await waitForReady(session, generation);
          if (generation !== session.generation) throw playbackError("STALE_SESSION", "播放请求已被替换", 409);
        }
        if (session.pipeline) { refreshPublished(session.pipeline); wake(session.pipeline); }
        sendJson(response, 200, descriptor(session)); return true;
      }
      if (!resource && request.method === "GET") { session.lastSeen = Date.now(); sendJson(response, 200, descriptor(session)); return true; }
      if (!["GET", "HEAD"].includes(request.method)) throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
      if (Number(url.searchParams.get("generation")) !== session.generation) throw playbackError("STALE_SESSION", "旧播放地址已失效", 409);
      if (resource === "file" && session.plan.strategy === "DIRECT") { await streamFile(request, response, session.media.path, false); return true; }
      const pipeline = session.pipeline;
      if (!pipeline) throw playbackError("NOT_FOUND", "分片不存在", 404);
      pipeline.accessed = Date.now();
      if (resource === "manifest.m3u8") {
        if (pipeline.error) throw pipeline.error;
        // Only finished, readable fragments are ever listed: native HLS players
        // wait forever on announcements that never resolve. VOD type + ENDLIST
        // are added as soon as the window is complete so players treat the
        // timeline as final instead of as a live edge.
        const parts = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.ceil(pipeline.maxDuration)}`,
          "#EXT-X-PLAYLIST-TYPE:VOD", `#EXT-X-MEDIA-SEQUENCE:${pipeline.visible[0]?.sequence || 0}`,
          `#EXT-X-MAP:URI="init.mp4?generation=${session.generation}"`];
        for (const fragment of pipeline.visible) parts.push(`#EXTINF:${(fragment.end - fragment.start).toFixed(6)},`, `${fragment.sequence}.m4s?generation=${session.generation}`);
        if (pipeline.eof) parts.push("#EXT-X-ENDLIST");
        const content = parts.join("\n") + "\n";
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(content) }); response.end(request.method === "HEAD" ? undefined : content); return true;
      }
      const file = resource === "init.mp4" ? pipeline.initPath : pipeline.fragments[Number(resource?.split(".")[0])]?.file;
      const entry = entries.get(file);
      if (!entry || !pipeline.published.has(file)) throw playbackError("SEGMENT_EXPIRED", "该分片已过期，请重新定位", 410);
      entry.accessed = Date.now(); entry.pins++;
      let released = false; const unpin = () => { if (!released) { released = true; entry.pins--; } };
      response.once("close", unpin); response.once("finish", unpin);
      await streamFile(request, response, file, false); return true;
    } catch (error) {
      if (!response.destroyed && !response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : "播放服务发生错误", code: error.code || "PLAYBACK_ERROR" });
      return true;
    }
  }
  function status() { return { sessions: sessions.size, pipelines: [...pipelines.values()].filter(item => item.child).length, cacheBytes, cacheMaxBytes: settings.cacheMaxBytes, ...metrics }; }
  async function stop() {
    stopped = true; clearInterval(timers); clearInterval(cleaner);
    for (const session of [...sessions.values()]) release(session);
    for (const pipeline of pipelines.values()) { clearTimeout(pipeline.releaseTimer); pipeline.cancelled = true; pipeline.child?.kill(); wake(pipeline); }
    await Promise.allSettled([...pipelines.values()].map(item => item.promise));
  }
  return { handleRequest, info, status, stop };
}
