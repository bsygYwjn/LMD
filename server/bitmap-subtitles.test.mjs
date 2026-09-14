// Bitmap subtitle service regression tests: RGBA fidelity, alpha cropping,
// window-bounded FFmpeg work, signed cache URLs, cancellation and cooldown.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBitmapSubtitleService, parseFrameIndex, BITMAP_SUBTITLE_FORMATS } from "./bitmap-subtitles.mjs";
import { cropTransparentRgbaPng, decodeRgbaPng, encodeRgbaPng } from "./png-alpha-crop.mjs";

function rgbaFixture() {
  const pixels = Buffer.alloc(4 * 3 * 4);
  const set = (x, y, rgba) => Buffer.from(rgba).copy(pixels, (y * 4 + x) * 4);
  set(1, 1, [240, 20, 30, 128]);
  set(2, 1, [10, 220, 40, 255]);
  set(1, 2, [20, 30, 230, 64]);
  return encodeRgbaPng(4, 3, pixels);
}

function showinfo(entries) {
  return entries.map(entry => `[Parsed_showinfo_1 @ 0x1] n:${String(entry.n).padStart(4)} pts:${entry.pts || 0} pts_time:${entry.time} duration:100 duration_time:1 fmt:rgba cl:unspecified sar:1/1 s:${entry.width || 4}x${entry.height || 3} i:P iskey:1 type:I`).join("\n");
}

function response() {
  return { headersSent: false, destroyed: false, statusCode: 200, headers: null, body: null, ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(body) { this.ended = true; this.body = body ?? null; return this; } };
}

export function createHarness({ frames = [], fail = null, root, customRunCommand = null } = {}) {
  let runCount = 0;
  const invocations = [];
  const runCommand = customRunCommand || (async (_binary, args) => {
    runCount += 1; invocations.push(args);
    if (fail) throw Object.assign(new Error(fail), { code: "STUB" });
    const pattern = args[args.length - 1];
    mkdirSync(path.dirname(pattern), { recursive: true });
    for (const frame of frames) writeFileSync(pattern.replace("%05d", String(frame.n + 1).padStart(5, "0")), frame.png || rgbaFixture());
    return { stdout: "", stderr: showinfo(frames) };
  });
  const requests = [];
  const service = createBitmapSubtitleService({ cacheDirectory: root, getMediaTools: () => ({ available: true, ffmpeg: "ffmpeg" }), runCommand });
  const media = { id: "media-1", path: path.join(root, "movie.mkv"), size: 100, modifiedAt: "2024-01-01T00:00:00.000Z" };
  const metadata = { duration: 360, tracks: [
    { index: 2, type: "subtitle", codec: "hdmv_pgs_subtitle", text: false, width: 4, height: 3 },
    { index: 3, type: "subtitle", codec: "subrip", text: true },
  ] };
  const deps = {
    authorizedMediaForRequest: () => media,
    playbackInfo: async () => metadata,
    sendJson: (res, code, payload) => { res.statusCode = code; res.body = payload; res.headersSent = true; requests.push({ code, payload }); },
    streamFile: async (_req, res, file) => { res.body = { file }; res.headersSent = true; requests.push({ file }); },
  };
  return { service, deps, media, metadata, requests, invocations, runCount: () => runCount };
}

const base = mkdtempSync(path.join(tmpdir(), "lmd-bitmap-"));
try {
  {
    const parsed = parseFrameIndex(showinfo([{ n: 3, time: 3, width: 1920, height: 1080 }, { n: 1, time: 1, width: 1920, height: 1080 }]));
    assert.deepEqual(parsed.map(item => item.n), [1, 3]);
    assert.equal(parsed[0].width, 1920);
    console.log("PASS showinfo 帧索引解析");
  }
  {
    const cropped = cropTransparentRgbaPng(rgbaFixture());
    assert.deepEqual({ x: cropped.x, y: cropped.y, width: cropped.width, height: cropped.height, canvasWidth: cropped.canvasWidth, canvasHeight: cropped.canvasHeight },
      { x: 1, y: 1, width: 2, height: 2, canvasWidth: 4, canvasHeight: 3 });
    const decoded = decodeRgbaPng(cropped.png);
    assert.deepEqual([...decoded.pixels], [240, 20, 30, 128, 10, 220, 40, 255, 20, 30, 230, 64, 0, 0, 0, 0],
      "裁剪后颜色、透明度和透明像素必须逐字节保真");
    const empty = cropTransparentRgbaPng(encodeRgbaPng(2, 2, Buffer.alloc(16)));
    assert.equal(empty.empty, true, "全透明清屏帧不应发布成遮罩图片");
    console.log("PASS RGBA 像素保真与 Alpha 真裁剪");
  }
  {
    const root = path.join(base, "basic"), harness = createHarness({ frames: [
      { n: 0, time: 1 }, { n: 1, time: 5 }, { n: 2, time: 20 },
    ], root });
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=0&duration=35"), res = response();
    assert.equal(await harness.service.handleRequest({ method: "GET" }, res, url, url.pathname, harness.deps), true);
    const payload = harness.requests.at(-1).payload;
    assert.equal(payload.cues.length, 3);
    assert.deepEqual([payload.cues[0].x, payload.cues[0].y, payload.cues[0].width, payload.cues[0].height], [1, 1, 2, 2]);
    assert.deepEqual([payload.cues[0].canvasWidth, payload.cues[0].canvasHeight], [4, 3]);
    assert.equal(payload.cues[0].start, 1);
    assert.equal(payload.cues[0].end, 5);
    assert.match(payload.cues[0].url, /^\/api\/media\/media-1\/bitmap-subtitles\/2\/[a-f0-9]{16}\/w0-d35000\/cue-00001\.png$/);
    assert.equal(payload.width, 4); assert.equal(payload.height, 3);
    const args = harness.invocations[0];
    assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), ["-ss", "0.000"]);
    assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "37.000"]);
    assert.ok(args.includes("format=rgba,showinfo"));
    assert.equal(args.some(value => String(value).includes("alphaextract") || String(value).includes("cropdetect")), false,
      "FFmpeg 不得丢弃 RGB，也不能把 cropdetect 误当成裁剪");
    console.log("PASS 窗口解码参数、坐标协议与签名 URL");

    const image = new URL("http://localhost" + payload.cues[0].url), imageResponse = response();
    await harness.service.handleRequest({ method: "GET" }, imageResponse, image, image.pathname, harness.deps);
    assert.equal(imageResponse.statusCode, 200);
    assert.equal(imageResponse.headers["Cache-Control"], "private, max-age=3600, immutable");
    const published = harness.requests.at(-1).file;
    assert.ok(published.endsWith("cue-00001.png") && existsSync(published));
    const unlisted = path.join(path.dirname(published), "cue-99999.png");
    writeFileSync(unlisted, rgbaFixture());
    const unlistedUrl = new URL(image.href.replace("cue-00001.png", "cue-99999.png"));
    await assert.rejects(harness.service.handleRequest({ method: "GET" }, response(), unlistedUrl, unlistedUrl.pathname, harness.deps),
      error => error.code === "SEGMENT_EXPIRED", "存在于磁盘但不属于索引的 PNG 不得提供");
    assert.equal(readdirSync(path.dirname(path.dirname(published))).some(name => name.includes(".partial-")), false, "发布后不得残留临时目录");
    console.log("PASS 原子缓存发布与图片成员校验");

    const middle = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=300&duration=35");
    await harness.service.handleRequest({ method: "GET" }, response(), middle, middle.pathname, harness.deps);
    const middleArgs = harness.invocations.at(-1);
    assert.deepEqual(middleArgs.slice(middleArgs.indexOf("-ss"), middleArgs.indexOf("-ss") + 2), ["-ss", "298.000"], "影片中段应直接输入 Seek");
    assert.deepEqual(middleArgs.slice(middleArgs.indexOf("-t"), middleArgs.indexOf("-t") + 2), ["-t", "39.000"], "中段只解码有限窗口");
    assert.equal(harness.requests.at(-1).payload.cues[0].start, 299, "窗口局部时间应还原为媒体绝对时间");
    console.log("PASS 中段首开不从影片开头线性渲染");

    const oldImageUrl = image;
    harness.media.size = 101;
    await harness.service.handleRequest({ method: "GET" }, response(), url, url.pathname, harness.deps);
    const replacementPayload = harness.requests.at(-1).payload;
    assert.notEqual(replacementPayload.sourceSignature, payload.sourceSignature);
    assert.notEqual(replacementPayload.cues[0].url, payload.cues[0].url);
    await assert.rejects(harness.service.handleRequest({ method: "GET" }, response(), oldImageUrl, oldImageUrl.pathname, harness.deps),
      error => error.code === "SEGMENT_EXPIRED", "替换同 media id 的源文件后旧 URL 必须失效");
    console.log("PASS 源签名隔离与旧图片失效");
    await harness.service.stop();
  }
  {
    const harness = createHarness({ frames: [], root: path.join(base, "empty") });
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=90&duration=35"), res = response();
    await harness.service.handleRequest({ method: "GET" }, res, url, url.pathname, harness.deps);
    assert.deepEqual(harness.requests.at(-1).payload.cues, [], "无字幕的窗口应快速返回空列表");
    console.log("PASS 空字幕窗口正常返回");
    await harness.service.stop();
  }
  {
    const harness = createHarness({ fail: "decoder exploded", root: path.join(base, "fail") });
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=30&duration=35");
    await assert.rejects(harness.service.handleRequest({ method: "GET" }, response(), url, url.pathname, harness.deps), /decoder exploded/);
    await assert.rejects(harness.service.handleRequest({ method: "GET" }, response(), url, url.pathname, harness.deps), /decoder exploded/);
    assert.equal(harness.runCount(), 1, "失败冷却期内不得重复启动昂贵渲染");
    console.log("PASS 渲染失败负缓存冷却");
    await harness.service.stop();
  }
  {
    let killed = false;
    let signalChildReady;
    const childReady = new Promise(resolve => { signalChildReady = resolve; });
    const runCommand = async (_binary, _args, _timeout, options) => new Promise((resolve, reject) => {
      options.onChild({ kill() { killed = true; reject(Object.assign(new Error("killed"), { code: "KILLED" })); } }); signalChildReady();
      void resolve;
    });
    const harness = createHarness({ root: path.join(base, "cancel"), customRunCommand: runCommand });
    const request = new EventEmitter(); request.method = "GET";
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=120&duration=35");
    const pending = harness.service.handleRequest(request, response(), url, url.pathname, harness.deps);
    await childReady;
    request.emit("aborted");
    await assert.rejects(pending, error => error.name === "AbortError");
    assert.equal(killed, true, "远距离 Seek 取消旧请求后应终止无人使用的 FFmpeg");
    await harness.service.stop();
    console.log("PASS 请求取消会终止旧窗口渲染");
  }
  {
    assert.ok(BITMAP_SUBTITLE_FORMATS.has("PGS") && BITMAP_SUBTITLE_FORMATS.has("VOBSUB"));
    console.log("PASS 支持格式清单");
  }
} finally { rmSync(base, { recursive: true, force: true }); }

console.log("bitmap-subtitles 测试全部通过");
