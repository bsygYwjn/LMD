// Exercise the real PGS decoder, cropper, HTTP router and file responder. A
// synthetic two-pixel caption avoids copyrighted fixtures and external inputs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeRgbaPng } from "./png-alpha-crop.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = process.env.LMD_FFMPEG || path.join(project, "tools/ffmpeg/bin/ffmpeg.exe");
const temporary = await mkdtemp(path.join(tmpdir(), "lmd-bitmap-integration-"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (executable, args) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { windowsHide: true }); let stderr = "";
  child.stdout.resume(); child.stderr.on("data", chunk => stderr += chunk);
  child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
});
function segment(seconds, type, hex = "") {
  const data = Buffer.from(hex, "hex"), header = Buffer.alloc(13);
  header.write("PG"); header.writeUInt32BE(seconds * 90_000, 2); header[10] = type; header.writeUInt16BE(data.length, 11);
  return Buffer.concat([header, data]);
}
const caption = (start, end) => [
  segment(start, 0x16, "07800438100000800000010000000000640064"),
  segment(start, 0x17, "01000064006400020002"),
  segment(start, 0x14, "0000001080800001eb8080ff"),
  segment(start, 0x15, "000000c000000c000200020101000001010000"),
  segment(start, 0x80), segment(end, 0x16, "0780043810000100000000"), segment(end, 0x80),
];
let server, serverErrors = "";
try {
  const source = path.join(temporary, "captions.sup"), movie = path.join(temporary, "movie.mkv"), data = path.join(temporary, "data");
  await writeFile(source, Buffer.concat([...caption(1, 5), ...caption(31, 35)]));
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=size=320x180:rate=5:duration=40", "-i", source,
    "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-preset", "ultrafast", "-c:s", "copy", "-copyts", movie]);
  await mkdir(data);
  const file = await stat(movie);
  await writeFile(path.join(data, "state.json"), JSON.stringify({ libraries: [{ id: "library", path: temporary }], jobs: [],
    media: [{ id: "bitmap", libraryId: "library", path: movie, fileName: "movie.mkv", title: "PGS fixture", extension: "MKV",
      size: file.size, modifiedAt: file.mtime.toISOString(), subtitles: [], fonts: [] }],
    settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false } }));
  const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(project, "server/index.mjs")], {
    cwd: project, windowsHide: true, env: { ...process.env, LMD_DATA_DIR: data, LMD_PORT: String(port) },
  });
  server.stdout.resume(); server.stderr.on("data", chunk => serverErrors += chunk);
  const request = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(15_000) });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await request("/api/health")).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `isolated server did not start: ${serverErrors}`);
  for (const [windowStart, expectedStart, expectedEnd] of [[0, 1, 5], [30, 31, 35]]) {
    const response = await request(`/api/media/bitmap/bitmap-subtitles/1?start=${windowStart}&duration=10`);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result) + serverErrors);
    const cue = result.cues.find(item => Math.abs(item.start - expectedStart) < 0.001);
    assert.ok(cue, `caption at ${expectedStart}s missing: ${JSON.stringify(result)}`);
    assert.ok(Math.abs(cue.end - expectedEnd) < 0.001, "PGS clear event must end the caption");
    assert.deepEqual([cue.x, cue.y, cue.width, cue.height, cue.canvasWidth, cue.canvasHeight], [100, 100, 2, 2, 1920, 1080]);
    const image = await request(cue.url);
    assert.equal(image.status, 200, "PNG GET must not send duplicate headers");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "private, max-age=3600, immutable");
    const bytes = Buffer.from(await image.arrayBuffer()), decoded = decodeRgbaPng(bytes);
    assert.deepEqual([decoded.width, decoded.height], [2, 2]);
    assert.equal(decoded.pixels[3], 255, "caption alpha must survive real decoding");
    const head = await request(cue.url, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get("content-length")), bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await request(cue.url, { headers: { Range: "bytes=0-7" } });
    assert.equal(range.status, 206); assert.equal(Buffer.from(await range.arrayBuffer()).toString("hex"), "89504e470d0a1a0a");
  }
  await request("/api/service/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log("PASS real PGS decoding, seek windows, alpha/crop coordinates, PNG GET/HEAD/Range");
} finally {
  if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once("close", resolve)), delay(5000)]); }
  // This test only owns its mkdtemp directory; application data is never used.
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
