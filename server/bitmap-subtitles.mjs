// Bitmap subtitle codecs carry pictures rather than text. The server decodes
// only the requested time window to RGBA PNGs, crops each image to its alpha
// bounds, and publishes the original canvas coordinates for browser drawing.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cropTransparentRgbaPng } from "./png-alpha-crop.mjs";
import { playbackError } from "./playback-planner.mjs";

export const BITMAP_SUBTITLE_FORMATS = new Set(["PGS", "VOBSUB", "DVB", "DVD_SUBTITLE", "HDMV_PGS_SUBTITLE", "DVB_SUBTITLE"]);
const MAX_BITMAP_CUES = 8000;
const MAX_WINDOW_SECONDS = 60;
const WINDOW_PREROLL_SECONDS = 2;
const RENDER_TTL_MS = 6 * 3600 * 1000;
const FAILURE_COOLDOWN_MS = 15_000;
const INDEX_VERSION = 2;

const codecOf = track => String(track.codec || "").toLowerCase();
const isBitmapTrack = track => track.type === "subtitle" && !track.text
  && ["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub"].includes(codecOf(track));
const digest = value => createHash("sha256").update(String(value)).digest("hex");
const sourceSignatureOf = (media, metadata) => String(metadata?.sourceSignature || `${Number(media.size)}:${media.modifiedAt}`);
const signatureHashOf = signature => digest(signature).slice(0, 16);
const windowIdOf = (start, duration) => `w${Math.round(start * 1000)}-d${Math.round(duration * 1000)}`;
const abortError = () => Object.assign(new Error("位图字幕窗口请求已取消"), { name: "AbortError", code: "REQUEST_ABORTED" });

/** Parse ordered `showinfo` records emitted after the RGBA conversion. */
export function parseFrameIndex(text) {
  const frames = [];
  const pattern = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)[^\n]*?\bs:(\d+)x(\d+)/g;
  for (const match of String(text).matchAll(pattern)) {
    frames.push({ n: Number(match[1]), time: Number(match[3]), width: Number(match[4]), height: Number(match[5]) });
  }
  frames.sort((a, b) => a.n - b.n);
  return frames;
}

export function createBitmapSubtitleService({ cacheDirectory, getMediaTools, runCommand }) {
  const root = path.join(cacheDirectory, "playback", "bitmaps");
  const indexes = new Map(), running = new Map(), missing = new Map();
  let lastSweep = 0;

  const keyFor = (media, track, signatureHash, windowId) => `${media.id}:${track.index}:${signatureHash}:${windowId}`;
  const directoryFor = (media, track, signatureHash, windowId) => path.join(root, `${digest(media.id).slice(0, 16)}-${track.index}-${signatureHash}-${windowId}`);

  function publicCue(media, track, entry, cue) {
    return { start: cue.start, end: cue.end, x: cue.x, y: cue.y, width: cue.width, height: cue.height,
      canvasWidth: cue.canvasWidth, canvasHeight: cue.canvasHeight,
      url: `/api/media/${encodeURIComponent(media.id)}/bitmap-subtitles/${track.index}/${entry.signatureHash}/${entry.windowId}/${cue.fileName}` };
  }

  async function loadEntry(media, track, sourceSignature, signatureHash, start, duration) {
    const windowId = windowIdOf(start, duration), directory = directoryFor(media, track, signatureHash, windowId);
    let saved = null;
    try { saved = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8")); } catch { return null; }
    if (!saved || saved.version !== INDEX_VERSION || saved.sourceSignature !== sourceSignature || saved.signatureHash !== signatureHash
      || saved.trackIndex !== track.index || saved.windowId !== windowId || !Array.isArray(saved.cues)) return null;
    for (const cue of saved.cues) {
      if (!/^cue-\d{5}\.png$/.test(cue.fileName || "")) return null;
      const info = await stat(path.join(directory, cue.fileName)).catch(() => null);
      if (!info?.isFile() || !info.size) return null;
    }
    return { ...saved, spriteDir: directory, usedAt: Date.now() };
  }

  async function sweep() {
    const items = await readdir(root, { withFileTypes: true }).catch(() => []), now = Date.now();
    const activeDirectories = new Set([...indexes.values()].filter(entry => now - entry.usedAt < RENDER_TTL_MS).map(entry => entry.spriteDir));
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const directory = path.join(root, item.name);
      if (activeDirectories.has(directory)) continue;
      const info = await stat(directory).catch(() => null);
      if (info && now - info.mtimeMs < RENDER_TTL_MS) continue;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function renderWindow(media, track, metadata, sourceSignature, signatureHash, start, duration, job) {
    const tools = getMediaTools();
    if (!tools.available) throw playbackError("TOOLS_UNAVAILABLE", "FFmpeg 尚未就绪，暂时无法渲染位图字幕", 503);
    const windowId = windowIdOf(start, duration), directory = directoryFor(media, track, signatureHash, windowId);
    const temporaryDirectory = `${directory}.partial-${randomUUID()}`;
    const mediaDuration = Number(metadata?.duration) || 0;
    const decodeStart = Math.max(0, start - WINDOW_PREROLL_SECONDS);
    const requestedEnd = start + duration + WINDOW_PREROLL_SECONDS;
    const decodeEnd = mediaDuration > 0 ? Math.min(mediaDuration, requestedEnd) : requestedEnd;
    const decodeDuration = Math.max(0.1, decodeEnd - decodeStart);
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      const pattern = path.join(temporaryDirectory, "cue-%05d.png");
      const args = ["-hide_banner", "-nostdin", "-loglevel", "info", "-ss", decodeStart.toFixed(3), "-i", media.path,
        // A complex video graph activates FFmpeg's subtitle-to-video adapter;
        // mapping the subtitle stream directly asks image2 for a subtitle encoder.
        "-t", decodeDuration.toFixed(3), "-filter_complex", `[0:${track.index}]format=rgba,showinfo[caption]`,
        "-map", "[caption]", "-c:v", "png", "-fps_mode", "passthrough", "-f", "image2", "-y", pattern];
      const result = await runCommand(tools.ffmpeg, args, 120000, { onChild: child => {
        job.child = child;
        if (job.cancelled) child.kill();
      } });
      if (job.cancelled) throw abortError();
      const frames = parseFrameIndex(result.stderr || "");
      if (frames.length > MAX_BITMAP_CUES) throw playbackError("BITMAP_TOO_LARGE", "位图字幕数量异常，已停止渲染", 422);
      const prepared = [];
      for (let index = 0; index < frames.length; index++) {
        if (job.cancelled) throw abortError();
        const frame = frames[index], fileName = `cue-${String(frame.n + 1).padStart(5, "0")}.png`;
        const file = path.join(temporaryDirectory, fileName), source = await readFile(file).catch(() => null);
        if (!source?.length) continue;
        const cropped = cropTransparentRgbaPng(source);
        if (cropped.empty) { await rm(file, { force: true }); continue; }
        await writeFile(file, cropped.png);
        const frameStart = Math.max(0, decodeStart + frame.time);
        const nextStart = index + 1 < frames.length ? Math.max(frameStart, decodeStart + frames[index + 1].time) : decodeEnd;
        if (!(nextStart > frameStart)) continue;
        prepared.push({ start: frameStart, end: Math.min(nextStart, decodeEnd), x: cropped.x, y: cropped.y,
          width: cropped.width, height: cropped.height, canvasWidth: cropped.canvasWidth, canvasHeight: cropped.canvasHeight, fileName });
      }
      const entry = { version: INDEX_VERSION, sourceSignature, signatureHash, trackIndex: track.index, codec: track.codec,
        windowId, start, duration, cues: prepared, createdAt: Date.now() };
      await writeFile(path.join(temporaryDirectory, "index.json"), JSON.stringify(entry));
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      await rename(temporaryDirectory, directory);
      return { ...entry, spriteDir: directory, usedAt: Date.now() };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
      if (job.cancelled && error?.name !== "AbortError") throw abortError();
      throw error;
    }
  }

  async function indexFor(media, track, metadata, start, duration, request) {
    const sourceSignature = sourceSignatureOf(media, metadata), signatureHash = signatureHashOf(sourceSignature);
    const windowId = windowIdOf(start, duration), key = keyFor(media, track, signatureHash, windowId);
    const cached = indexes.get(key);
    if (cached) { cached.usedAt = Date.now(); return cached; }
    const recentFailure = missing.get(key);
    if (recentFailure && Date.now() - recentFailure.at < FAILURE_COOLDOWN_MS) throw recentFailure.error;
    if (recentFailure) missing.delete(key);
    const diskEntry = await loadEntry(media, track, sourceSignature, signatureHash, start, duration);
    if (diskEntry) { indexes.set(key, diskEntry); return diskEntry; }
    let job = running.get(key);
    if (!job) {
      job = { child: null, cancelled: false, consumers: new Set(), promise: null };
      job.promise = renderWindow(media, track, metadata, sourceSignature, signatureHash, start, duration, job)
        .then(entry => {
          indexes.set(key, entry); missing.delete(key);
          if (indexes.size > 16) for (const [oldestKey] of indexes) { if (indexes.size <= 16) break; if (oldestKey !== key) indexes.delete(oldestKey); }
          return entry;
        })
        .catch(error => {
          if (!job.cancelled && error?.name !== "AbortError") missing.set(key, { at: Date.now(), error });
          throw error;
        })
        .finally(() => { if (running.get(key) === job) running.delete(key); });
      running.set(key, job);
    }
    const consumer = {}, canAbort = typeof request?.once === "function";
    job.consumers.add(consumer);
    let rejectAbort = null, aborted = false;
    const abortedPromise = canAbort ? new Promise((_, reject) => { rejectAbort = reject; }) : null;
    const onAbort = () => {
      if (aborted) return;
      aborted = true; job.consumers.delete(consumer);
      if (!job.consumers.size) { job.cancelled = true; job.child?.kill(); }
      rejectAbort?.(abortError());
    };
    if (canAbort) request.once("aborted", onAbort);
    try { return await (abortedPromise ? Promise.race([job.promise, abortedPromise]) : job.promise); }
    finally {
      if (typeof request?.off === "function") request.off("aborted", onAbort);
      job.consumers.delete(consumer);
    }
  }

  async function handleRequest(request, response, url, pathname, deps) {
    const route = /^\/api\/media\/([^/]+)\/bitmap-subtitles\/(\d+)(?:\/([a-f0-9]{16})\/(w\d+-d\d+)\/(cue-\d{5}\.png))?$/.exec(pathname);
    if (!route) return false;
    if (!["GET", "HEAD"].includes(request.method)) throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
    const media = deps.authorizedMediaForRequest(request, response, route[1]);
    if (!media) return true;
    const metadata = await deps.playbackInfo(media);
    const track = metadata.tracks.find(item => item.index === Number(route[2]) && item.type === "subtitle");
    if (!track || !isBitmapTrack(track)) throw playbackError("NOT_BITMAP_SUBTITLE", "这不是可渲染的位图字幕轨道", 404);
    const sourceSignature = sourceSignatureOf(media, metadata), signatureHash = signatureHashOf(sourceSignature);
    const resource = route[5];
    if (resource) {
      if (route[3] !== signatureHash) throw playbackError("SEGMENT_EXPIRED", "字幕图片已过期，请重新定位", 410);
      const windowMatch = /^w(\d+)-d(\d+)$/.exec(route[4]);
      if (!windowMatch) throw playbackError("NOT_FOUND", "字幕图片不存在", 404);
      const start = Number(windowMatch[1]) / 1000, duration = Number(windowMatch[2]) / 1000;
      const key = keyFor(media, track, signatureHash, route[4]);
      let entry = indexes.get(key);
      if (!entry) entry = await loadEntry(media, track, sourceSignature, signatureHash, start, duration);
      if (entry) indexes.set(key, entry);
      const cue = entry?.cues.find(item => item.fileName === resource);
      const file = cue && path.join(entry.spriteDir, cue.fileName), info = file ? await stat(file).catch(() => null) : null;
      if (!info?.isFile()) throw playbackError("SEGMENT_EXPIRED", "字幕图片已过期，请重新定位", 410);
      entry.usedAt = Date.now();
      await deps.streamFile(request, response, file, false, { cacheControl: "private, max-age=3600, immutable" });
      return true;
    }
    const start = Math.max(0, Number(url.searchParams.get("start")) || 0);
    const duration = Math.min(MAX_WINDOW_SECONDS, Math.max(1, Number(url.searchParams.get("duration")) || 35));
    const entry = await indexFor(media, track, metadata, start, duration, request);
    if (Date.now() - lastSweep > 600000) { lastSweep = Date.now(); void sweep().catch(() => {}); }
    const cues = entry.cues.filter(cue => cue.end > start && cue.start < start + duration).map(cue => publicCue(media, track, entry, cue));
    const canvasWidth = Math.max(track.width || 0, ...cues.map(cue => cue.canvasWidth));
    const canvasHeight = Math.max(track.height || 0, ...cues.map(cue => cue.canvasHeight));
    deps.sendJson(response, 200, { trackIndex: track.index, codec: entry.codec, sourceSignature: entry.signatureHash,
      start, duration, canvas: { width: canvasWidth, height: canvasHeight }, total: entry.cues.length, cues,
      width: canvasWidth, height: canvasHeight });
    return true;
  }

  async function stop() {
    indexes.clear(); missing.clear();
    for (const job of running.values()) { job.cancelled = true; job.child?.kill(); }
    await Promise.allSettled([...running.values()].map(job => job.promise));
  }
  return { handleRequest, stop, isBitmapTrack, status: () => ({ indexed: indexes.size, rendering: running.size, failed: missing.size }) };
}
