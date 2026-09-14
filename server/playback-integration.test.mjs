import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = process.env.LMD_FFMPEG || path.join(project, "tools/ffmpeg/bin/ffmpeg.exe");
const ffprobe = process.env.LMD_FFPROBE || path.join(project, "tools/ffmpeg/bin/ffprobe.exe");
const temporary = await mkdtemp(path.join(tmpdir(), "lmd-playback-test-"));
const run = (exe, args) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { windowsHide: true }); let out = "", err = "";
  child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
  child.on("error", reject); child.on("close", code => code === 0 ? resolve(out) : reject(new Error(err)));
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let serverErrors = "";
try {
  await mkdir(path.join(temporary, "data"));
  const source = path.join(temporary, "sample.mkv"), mp4 = path.join(temporary, "sample.mp4"), dts = path.join(temporary, "dts.mkv");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=70", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=70", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-bf", "2", "-c:a", "aac", source]);
  await run(ffmpeg, ["-v", "error", "-i", source, "-c", "copy", "-movflags", "+faststart", mp4]);
  await run(ffmpeg, ["-v", "error", "-i", source, "-c:v", "copy", "-c:a", "dca", "-strict", "-2", dts]);
  const media = await Promise.all([source, mp4, dts].map(async (file, i) => { const s = await stat(file); return {
    id: `media${i}`, libraryId: "library", path: file, fileName: path.basename(file), title: path.basename(file), extension: path.extname(file).slice(1).toUpperCase(), size: s.size, modifiedAt: s.mtime.toISOString(), subtitles: [], fonts: [] }; }));
  await writeFile(path.join(temporary, "data/state.json"), JSON.stringify({ libraries: [{ id: "library", path: temporary }], media, jobs: [], settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false,
    videoPlayback: { encoder: "libx264", releaseGraceSeconds: 0 } } }));
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(project, "server/index.mjs")], { cwd: project, env: { ...process.env, LMD_DATA_DIR: path.join(temporary, "data"), LMD_PORT: String(port) }, windowsHide: true });
  let errors = ""; server.stderr.on("data", b => { errors += b; serverErrors = errors; }); server.stdout.resume();
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await delay(100); }
  const json = async (url, body, method = body ? "POST" : "GET") => {
    const response = await fetch(`${base}${url}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(result)}\n${errors}`); return result;
  };
  const manifestTarget = manifest => Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(manifest)?.[1]);
  const manifestSequence = manifest => Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(manifest)?.[1]);
  const waitForManifest = async (url, predicate, message) => {
    let manifest = "";
    for (let i = 0; i < 100; i++) {
      manifest = await (await fetch(`${base}${url}`)).text();
      if (predicate(manifest)) return manifest;
      await delay(100);
    }
    assert.fail(`${message}\n${manifest}\n${errors}`);
  };
  const caps = { mse: true, h264: true, aac: true, nativeHls: true, direct: { "0:1": true }, tracks: { 0: { mse: true, file: true }, 1: { mse: true, file: true } } };
  const metadata = await json("/api/media/media0/info"); assert.equal(metadata.container, "matroska"); assert.equal(metadata.tracks.length, 2);
  const direct = await json("/api/media/media1/playback-sessions", { capabilities: caps });
  assert.equal(direct.strategy, "DIRECT");
  let range = await fetch(`${base}${direct.url}`, { headers: { Range: "bytes=0-31" } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  range = await fetch(`${base}${direct.url}`, { method: "HEAD", headers: { Range: "bytes=-32" } }); assert.equal(range.status, 206);
  assert.equal((await json("/api/settings/video-playback")).status.pipelinesCreated, 0);
  await json(`/api/playback-sessions/${direct.sessionId}`, undefined, "DELETE");
  const start = performance.now();
  const first = await json("/api/media/media0/playback-sessions", { capabilities: caps });
  assert.equal(first.strategy, "REMUX"); assert.equal(first.plan.audio.action, "COPY");
  const second = await json("/api/media/media0/playback-sessions", { capabilities: caps });
  assert.equal((await json("/api/settings/video-playback")).status.pipelinesCreated, 1, "identical consumers share producer");
  await json(`/api/playback-sessions/${second.sessionId}`, undefined, "DELETE");
  let manifest = await (await fetch(`${base}${first.url}`)).text();
  assert.match(manifest, /#EXT-X-MAP/); assert.match(manifest, /\.m4s/);
  assert.equal(manifest.includes("#EXT-X-PLAYLIST-TYPE:VOD"), false, "运行中的滑动清单不能声明 VOD");
  assert.equal(manifest.includes("#EXT-X-ENDLIST"), false, "bounded producer must not complete 70s file in background");
  const targetDuration = manifestTarget(manifest);
  assert.equal(targetDuration, 6, "会话创建时使用保守且固定的目标时长");
  assert.ok([...manifest.matchAll(/#EXTINF:([\d.]+)/g)].every(match => Math.round(Number(match[1])) <= targetDuration),
    "所有已发布分片的取整时长都必须受 TARGETDURATION 约束");
  await json(`/api/playback-sessions/${first.sessionId}`, { position: 35 }, "PATCH");
  manifest = await waitForManifest(first.url, value => manifestSequence(value) > 0 && /\.m4s/.test(value), "滑动窗口没有释放旧分片");
  assert.equal(manifestTarget(manifest), targetDuration, "滑动过程中 TARGETDURATION 不能变化");
  assert.equal(manifest.includes("#EXT-X-PLAYLIST-TYPE:VOD"), false, "滑动后的运行中清单仍不能声明 VOD");
  const liveSegment = manifest.split("\n").find(line => /^\d+\.m4s/.test(line));
  assert.equal((await fetch(`${base}/api/playback-sessions/${first.sessionId}/${liveSegment}`)).status, 200, "滑动后新分片应可读取");
  const seek = await json(`/api/playback-sessions/${first.sessionId}`, { generation: 1, seekTime: 51 }, "PATCH");
  assert.equal(seek.generation, 2); assert.ok(seek.sourceStart <= 51 && seek.sourceStart >= 48, JSON.stringify(seek));
  const stale = await fetch(`${base}${first.url}`); assert.equal(stale.status, 409);
  manifest = await (await fetch(`${base}${seek.url}`)).text();
  const segment = manifest.split("\n").find(line => /^\d+\.m4s/.test(line));
  const prefix = `/api/playback-sessions/${first.sessionId}/`;
  const initBytes = Buffer.from(await (await fetch(`${base}${prefix}init.mp4?generation=2`)).arrayBuffer());
  const segmentBytes = Buffer.from(await (await fetch(`${base}${prefix}${segment}`)).arrayBuffer());
  const fragmentFile = path.join(temporary, "fragment.mp4"); await writeFile(fragmentFile, Buffer.concat([initBytes, segmentBytes]));
  const decoded = JSON.parse(await run(ffprobe, ["-v", "error", "-show_streams", "-of", "json", fragmentFile]));
  assert.deepEqual(decoded.streams.map(item => item.codec_name), ["h264", "aac"]);
  await json(`/api/playback-sessions/${first.sessionId}`, { position: 69 }, "PATCH");
  manifest = await waitForManifest(seek.url, value => value.includes("#EXT-X-ENDLIST"), "FFmpeg 到达 EOF 后清单没有结束标记");
  assert.equal(manifestTarget(manifest), targetDuration, "EOF 前后 TARGETDURATION 必须保持固定");
  assert.equal(manifest.includes("#EXT-X-PLAYLIST-TYPE:VOD"), false, "滑动过的结束清单不能伪装成完整 VOD");
  await json(`/api/playback-sessions/${first.sessionId}`, undefined, "DELETE");
  const partial = await json("/api/media/media2/playback-sessions", { capabilities: caps, startTime: 21 });
  assert.equal(partial.strategy, "PARTIAL_TRANSCODE"); assert.equal(partial.plan.video.action, "COPY"); assert.equal(partial.plan.audio.action, "ENCODE");
  await json(`/api/playback-sessions/${partial.sessionId}`, undefined, "DELETE");
  const transcode = await json("/api/media/media0/playback-sessions", { capabilities: caps, fallbackLevel: 3, startTime: 21 });
  assert.equal(transcode.strategy, "TRANSCODE"); assert.ok(Math.abs(transcode.sourceStart - 21) < 0.1);
  await json(`/api/playback-sessions/${transcode.sessionId}`, undefined, "DELETE"); await delay(200);
  const status = (await json("/api/settings/video-playback")).status; assert.equal(status.sessions, 0); assert.equal(status.pipelines, 0);
  assert.ok(status.cacheBytes < 30 * 1024 ** 2);
  console.log(JSON.stringify({ result: "passed", tested: ["Range", "dual copy", "shared pipeline", "live HLS sliding", "fixed TARGETDURATION", "HLS EOF", "seek PTS", "stale generation", "DTS audio-only", "full transcode", "release"], elapsedMs: Math.round(performance.now() - start), status }));
  await json("/api/service/stop", {});
} finally {
  if (server?.exitCode !== null && serverErrors) console.error(serverErrors);
  if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once("close", resolve)), delay(5000)]); }
  // Only the mkdtemp directory created by this test is removed.
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
