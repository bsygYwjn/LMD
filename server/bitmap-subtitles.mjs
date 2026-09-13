// Bitmap (PGS / VobSub / DVB) subtitle rendering.
//
// Bitmap subtitle codecs carry pictures, not text: the browser has no decoder
// for them, so the server decodes each caption to a transparent PNG and hands
// the front end a timed display list. Burn-in is deliberately not the default
// path because it would force a full re-encode of the video.
//
// FFmpeg already ships every decoder needed here and is a required tool, so the
// renderer is a thin orchestrator instead of a separately compiled helper: the
// subtitle stream is decoded to RGBA frames, cropped to the caption's own
// bounding box, and published as one PNG per caption event.
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { playbackError } from "./playback-planner.mjs";

export const BITMAP_SUBTITLE_FORMATS = new Set(["PGS", "VOBSUB", "DVB", "DVD_SUBTITLE", "HDMV_PGS_SUBTITLE", "DVB_SUBTITLE"]);
// A feature-length film holds a few thousand caption events; anything far above
// this is a malformed stream and must not be allowed to exhaust the cache.
const MAX_BITMAP_CUES = 8000;
const RENDER_TTL_MS = 6 * 3600 * 1000;

const codecOf = (track) => String(track.codec || "").toLowerCase();
const isBitmapTrack = (track) => track.type === "subtitle" && !track.text
  && ["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub"].includes(codecOf(track));

/** Parses the ordered `showinfo` records FFmpeg writes while rendering frames. */
export function parseFrameIndex(text) {
  const frames = [];
  // ffmpeg -loglevel info 输出形如
  // `[Parsed_showinfo_2 @ ...] n:   0 pts:      0 pts_time:0 ... s:1920x1080`
  const pattern = /\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.]+)[^\n]*?\bs:(\d+)x(\d+)/g;
  for (const match of String(text).matchAll(pattern)) {
    frames.push({ n: Number(match[1]), time: Number(match[3]), width: Number(match[4]), height: Number(match[5]) });
  }
  frames.sort((a, b) => a.n - b.n);
  return frames;
}

export function createBitmapSubtitleService({ cacheDirectory, getMediaTools, runCommand, requireLocalManagement }) {
  const root = path.join(cacheDirectory, "playback", "bitmaps");
  const indexes = new Map(), running = new Map(), missing = new Map();
  let sweeps = 0;

  const signatureOf = (media, track) => `${media.size}:${media.modifiedAt}:${track.index}`;
  const directoryFor = (media, track) => path.join(root, `${media.id}-${track.index}`);

  async function sweep() {
    // Bounded, ownership-checked cleanup: only directories this service creates
    // under its own root are touched.
    sweeps += 1;
    const items = await readdir(root, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const directory = path.join(root, item.name);
      const keys = [...indexes.values()].filter(entry => path.dirname(entry.spriteDir) === directory);
      if (keys.some(entry => now - entry.usedAt < RENDER_TTL_MS)) continue;
      const info = await stat(directory).catch(() => null);
      if (info && now - info.mtimeMs < RENDER_TTL_MS) continue;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function render(media, track, metadata) {
    const tools = getMediaTools();
    if (!tools.available) throw playbackError("TOOLS_UNAVAILABLE", "FFmpeg 尚未就绪，暂时无法渲染位图字幕", 503);
    const directory = directoryFor(media, track);
    await mkdir(directory, { recursive: true });
    // `format=rgba` must precede alphaextract: bitmap subtitle decoders emit
    // paletted RGBA, and alphaextract refuses planes that are not present.
    // cropdetect trims the transparent margins so each caption stays small.
    const build = (cropped) => ["-hide_banner", "-nostdin", "-loglevel", "info", "-i", media.path,
      "-map", `0:${track.index}`,
      "-vf", cropped ? "format=rgba,alphaextract,showinfo,cropdetect=limit=0.02:round=2:reset=0" : "format=rgba,alphaextract,showinfo",
      "-fps_mode", "passthrough", "-f", "image2", "-y", path.join(directory, "cue-%05d.png")];
    let result;
    try { result = await runCommand(tools.ffmpeg, build(true), 600000); }
    catch (error) {
      // Uncroppable streams (a caption touching every edge) fail the graph, so
      // retry once with the full canvas before reporting failure.
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      await mkdir(directory, { recursive: true });
      result = await runCommand(tools.ffmpeg, build(false), 600000).catch(() => { throw error; });
    }
    const frames = parseFrameIndex(result.stderr || "");
    if (frames.length > MAX_BITMAP_CUES) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw playbackError("BITMAP_TOO_LARGE", "位图字幕数量异常，已停止渲染", 422);
    }
    if (!frames.length) throw playbackError("NO_BITMAP_CAPTIONS", "这条位图字幕轨道没有可显示的图像", 422);
    const duration = Number(metadata?.duration) || 0;
    const cues = [];
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      const name = `cue-${String(frame.n + 1).padStart(5, "0")}.png`;
      const info = await stat(path.join(directory, name)).catch(() => null);
      if (!info?.size) continue;
      const start = Math.max(0, frame.time);
      const end = index + 1 < frames.length ? frames[index + 1].time : (duration > start ? duration : start + 5);
      if (!(end > start)) continue;
      cues.push({ start, end, width: frame.width, height: frame.height, url: `/api/media/${media.id}/bitmap-subtitles/${track.index}/${name}` });
    }
    if (!cues.length) throw playbackError("NO_BITMAP_CAPTIONS", "这条位图字幕轨道没有可显示的图像", 422);
    return { cues, spriteDir: directory, createdAt: Date.now(), usedAt: Date.now(), codec: track.codec };
  }

  async function indexFor(media, track, metadata) {
    const key = signatureOf(media, track);
    const cached = indexes.get(key);
    if (cached) { cached.usedAt = Date.now(); return cached; }
    if (!running.has(key)) {
      running.set(key, render(media, track, metadata)
        .then(entry => {
          indexes.set(key, entry);
          if (indexes.size > 8) for (const [oldestKey, entry_] of indexes) { if (indexes.size <= 8) break; if (oldestKey !== key) indexes.delete(oldestKey); void entry_; }
          return entry;
        })
        .catch(error => { missing.set(key, { at: Date.now(), error }); throw error; })
        .finally(() => running.delete(key)));
    }
    return running.get(key);
  }

  async function handleRequest(request, response, url, pathname, deps) {
    const route = /^\/api\/media\/([^/]+)\/bitmap-subtitles\/(\d+)(?:\/([\w.-]+))?$/.exec(pathname);
    if (!route) return false;
    if (!["GET", "HEAD"].includes(request.method)) throw playbackError("METHOD_NOT_ALLOWED", "不支持的操作", 405);
    const media = deps.authorizedMediaForRequest(request, response, route[1]);
    if (!media) return true;
    const metadata = await deps.playbackInfo(media);
    const track = metadata.tracks.find(item => item.index === Number(route[2]) && item.type === "subtitle");
    if (!track || !isBitmapTrack(track)) throw playbackError("NOT_BITMAP_SUBTITLE", "这不是可渲染的位图字幕轨道", 404);
    const resource = route[3];
    if (resource) {
      if (!/^cue-\d{5}\.png$/.test(resource)) throw playbackError("NOT_FOUND", "字幕图片不存在", 404);
      const entry = indexes.get(signatureOf(media, track));
      const file = entry && path.join(entry.spriteDir, resource);
      const info = file ? await stat(file).catch(() => null) : null;
      if (!info?.isFile()) throw playbackError("SEGMENT_EXPIRED", "字幕图片已过期，请重新定位", 410);
      entry.usedAt = Date.now();
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": info.size, "Cache-Control": "private, max-age=3600" });
      if (request.method === "HEAD") return response.end(), true;
      await deps.streamFile(request, response, file, false);
      return true;
    }
    const start = Math.max(0, Number(url.searchParams.get("start")) || 0);
    const window = Math.min(600, Math.max(1, Number(url.searchParams.get("duration")) || 35));
    const entry = await indexFor(media, track, metadata);
    if (sweeps === 0 || Date.now() - (entry.lastSweep || 0) > 600000) { entry.lastSweep = Date.now(); void sweep().catch(() => {}); }
    const cues = entry.cues.filter(cue => cue.end > start && cue.start < start + window);
    // Canvas size only describes the source graphics; the front end scales by
    // each cue's own picture so cropped captions keep their true position.
    deps.sendJson(response, 200, { trackIndex: track.index, codec: entry.codec, start, duration: window,
      canvas: { width: track.width || 0, height: track.height || 0 }, total: entry.cues.length, cues,
      width: cues[0]?.width || track.width || 0, height: cues[0]?.height || track.height || 0 });
    return true;
  }

  async function stop() {
    indexes.clear();
    await Promise.allSettled([...running.values()]);
  }
  return { handleRequest, stop, isBitmapTrack, status: () => ({ indexed: indexes.size, rendering: running.size }) };
}
