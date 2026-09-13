// Bitmap subtitle (PGS/VobSub/DVB) rendering service tests.
//
// Bitmap subtitle codecs cannot be synthesised by FFmpeg's encoders, so the
// FFmpeg invocation is replaced by a stub that produces the same artefacts a
// real render would (numbered transparent PNGs plus ordered showinfo records).
// That keeps every other behaviour under test: the time index, the request
// window, per-cue URLs, publication, and error handling.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBitmapSubtitleService, parseFrameIndex, BITMAP_SUBTITLE_FORMATS } from "./bitmap-subtitles.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");

function showinfo(entries) {
  return entries.map(entry => `[Parsed_showinfo_2 @ 0x1] n:${String(entry.n).padStart(4)} pts:${entry.pts} pts_time:${entry.time} duration:100 duration_time:1 fmt:gray cl:unspecified sar:1/1 s:${entry.width}x${entry.height} i:P iskey:1 type:I`).join("\n");
}

export function createHarness({ frames = [], fail = null, root }) {
  const directory = root;
  const runCommand = async (_binary, args) => {
    if (fail) throw Object.assign(new Error(fail), { code: "STUB" });
    const pattern = args[args.length - 1];
    mkdirSync(path.dirname(pattern), { recursive: true });
    for (const frame of frames) writeFileSync(pattern.replace("%05d", String(frame.n + 1).padStart(5, "0")), PNG);
    return { stdout: "", stderr: showinfo(frames) };
  };
  const requests = [];
  const service = createBitmapSubtitleService({ cacheDirectory: root, getMediaTools: () => ({ available: true, ffmpeg: "ffmpeg" }), runCommand, requireLocalManagement: () => true });
  const media = { id: "media-1", path: path.join(root, "movie.mkv"), size: 100, modifiedAt: "2024-01-01T00:00:00.000Z" };
  const metadata = { duration: 60, tracks: [
    { index: 2, type: "subtitle", codec: "hdmv_pgs_subtitle", text: false },
    { index: 3, type: "subtitle", codec: "subrip", text: true },
  ] };
  const response = { headersSent: false, destroyed: false, statusCode: 200, headers: null, body: null, ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(body) { this.ended = true; this.body = body ?? null; return this; } };
  const deps = {
    authorizedMediaForRequest: () => media,
    playbackInfo: async () => metadata,
    sendJson: (res, code, payload) => { res.statusCode = code; res.body = payload; res.headersSent = true; requests.push({ code, payload }); },
    streamFile: async (_req, res, file) => { res.body = { file }; res.headersSent = true; requests.push({ file }); },
  };
  return { service, deps, response, requests, media, metadata };
}

const base = mkdtempSync(path.join(tmpdir(), "lmd-bitmap-"));
try {
  {
    // Ordered showinfo parsing, including the frame geometry used for cropping.
    const parsed = parseFrameIndex(showinfo([{ n: 3, pts: 300, time: 3, width: 1920, height: 200 }, { n: 1, pts: 100, time: 1, width: 1920, height: 200 }]));
    assert.deepEqual(parsed.map(item => item.n), [1, 3], "按帧序号排序");
    assert.equal(parsed[0].width, 1920);
    assert.equal(parsed[1].time, 3);
    console.log("PASS showinfo 帧索引解析");
  }
  {
    const root = path.join(base, "basic");
    const harness = createHarness({ frames: [
      { n: 0, pts: 0, time: 1, width: 640, height: 80 },
      { n: 1, pts: 0, time: 5, width: 640, height: 80 },
      { n: 2, pts: 0, time: 20, width: 640, height: 80 },
    ], root });
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=0&duration=35");
    assert.equal(await harness.service.handleRequest({ method: "GET" }, harness.response, url, url.pathname, harness.deps), true);
    const payload = harness.requests.at(-1).payload;
    assert.equal(payload.code, undefined);
    assert.equal(payload.cues.length, 3, "首个窗口返回全部三条字幕");
    assert.equal(payload.cues[0].start, 1);
    assert.equal(payload.cues[0].end, 5, "结束时间取下一帧的开始时间");
    assert.equal(payload.cues[2].end, 60, "最后一帧延续到媒体结尾");
    assert.match(payload.cues[0].url, /^\/api\/media\/media-1\/bitmap-subtitles\/2\/cue-00001\.png$/);
    assert.equal(payload.width, 640);
    assert.equal(payload.height, 80);
    console.log("PASS 位图字幕索引与窗口返回");

    // The published PNG must be servable, and the path must be restricted.
    const image = new URL("http://localhost" + payload.cues[0].url);
    const imageResponse = { headersSent: false, destroyed: false, writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }, end() { return this; } };
    const served = await harness.service.handleRequest({ method: "GET" }, imageResponse, image, image.pathname, harness.deps);
    assert.equal(served, true);
    assert.equal(imageResponse.statusCode, 200);
    assert.equal(imageResponse.headers["Content-Type"], "image/png");
    assert.ok(harness.requests.at(-1).file.includes("cue-00001.png"), "PNG 由服务端提供");
    await assert.rejects(
      harness.service.handleRequest({ method: "GET" }, harness.response, new URL("http://localhost/"),
        "/api/media/media-1/bitmap-subtitles/2/cue-00001.png.bak", harness.deps),
      error => error.code === "NOT_FOUND",
      "只允许规范的图片文件名");
    // The outer route must never hand a traversal path to the service at all.
    assert.equal(/^\/api\/media\/[^/]+\/bitmap-subtitles\/(\d+)(?:\/[\w.-]+)?$/.test("/api/media/media-1/bitmap-subtitles/2/..%2F..%2Fstate.json"), false,
      "路径穿越不匹配位图字幕路由");
    console.log("PASS 位图字幕图片服务与路径校验");

    const later = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=10&duration=35");
    await harness.service.handleRequest({ method: "GET" }, harness.response, later, later.pathname, harness.deps);
    const sliced = harness.requests.at(-1).payload.cues;
    // The caption that runs into the window is included; the one that ends
    // before it (start 1, end 5) is not.
    assert.deepEqual(sliced.map(cue => [cue.start, cue.end]), [[5, 20], [20, 60]], "窗口按字幕区间裁剪");
    const gap = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2?start=0&duration=1");
    await harness.service.handleRequest({ method: "GET" }, harness.response, gap, gap.pathname, harness.deps);
    assert.equal(harness.requests.at(-1).payload.cues.length, 0, "无字幕区间返回空列表");
    console.log("PASS 位图字幕窗口切片");

    // A non-bitmap track must not be rendered.
    await assert.rejects(
      harness.service.handleRequest({ method: "GET" }, harness.response, new URL("http://localhost/api/media/media-1/bitmap-subtitles/3"), "/api/media/media-1/bitmap-subtitles/3", harness.deps),
      error => error.code === "NOT_BITMAP_SUBTITLE");
    await assert.rejects(
      harness.service.handleRequest({ method: "GET" }, harness.response, new URL("http://localhost/api/media/media-1/bitmap-subtitles/9"), "/api/media/media-1/bitmap-subtitles/9", harness.deps),
      error => error.code === "NOT_BITMAP_SUBTITLE");
    console.log("PASS 非位图轨道被拒绝");
    await harness.service.stop();
  }
  {
    // An empty render must be reported instead of producing an unusable index.
    const harness = createHarness({ frames: [], root: path.join(base, "empty") });
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2");
    await assert.rejects(harness.service.handleRequest({ method: "GET" }, harness.response, url, url.pathname, harness.deps), error => error.code === "NO_BITMAP_CAPTIONS");
    console.log("PASS 无字幕图像时返回明确错误");
    await harness.service.stop();
  }
  {
    const harness = createHarness({ fail: "decoder exploded", root: path.join(base, "fail") });
    const url = new URL("http://localhost/api/media/media-1/bitmap-subtitles/2");
    await assert.rejects(harness.service.handleRequest({ method: "GET" }, harness.response, url, url.pathname, harness.deps), /decoder exploded/);
    console.log("PASS 渲染失败向上报告");
    await harness.service.stop();
  }
  {
    assert.ok(BITMAP_SUBTITLE_FORMATS.has("PGS") && BITMAP_SUBTITLE_FORMATS.has("VOBSUB"));
    console.log("PASS 支持格式清单");
  }
} finally { rmSync(base, { recursive: true, force: true }); }

console.log("bitmap-subtitles 测试全部通过");
