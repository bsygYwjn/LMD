// Unit coverage for incremental MP4 box reading and initialization rewriting.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boxes, parseInitialization, rewriteInitializationDuration, readMp4Boxes } from "./playback-mp4.mjs";

const ffmpeg = process.env.LMD_FFMPEG || path.join(process.cwd(), "tools", "ffmpeg", "bin", "ffmpeg.exe");

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}
// Real ISO-BMFF view payloads: mvhd/mdhd carry their own timescale, tkhd does
// not (it uses the movie timescale from mvhd).
const movieView = (type, duration, scale, timescaleOffset) => {
  const payload = Buffer.alloc(24);
  payload[0] = 0;
  payload.writeUInt32BE(scale, timescaleOffset);
  payload.writeUInt32BE(duration, timescaleOffset + 4);
  return box(type, payload);
};
const mvhdV0 = (duration, scale = 1000) => movieView("mvhd", duration, scale, 12);
const mdhdV0 = (duration, scale = 90_000) => movieView("mdhd", duration, scale, 12);
const tkhdV0 = (duration) => {
  const payload = Buffer.alloc(24);
  payload[0] = 0;
  payload.writeUInt32BE(duration, 16);
  return box("tkhd", payload);
};

{
  // Nested traversal must not touch unrelated boxes that reuse tkhd field
  // layouts deeper inside the sample tables.
  const trak = box("trak", Buffer.concat([tkhdV0(10_000), box("mdia", Buffer.concat([mdhdV0(900_000), box("minf", Buffer.alloc(4))]))]));
  const mov = box("moov", Buffer.concat([mvhdV0(10_000), trak]));
  const patched = rewriteInitializationDuration(mov, 42.5);
  const moov = boxes(patched).find(item => item.type === "moov").data;
  const header = boxes(moov).find(item => item.type === "mvhd").data;
  assert.equal(header.readUInt32BE(16), 42_500, "mvhd 时长按每毫秒刻度写入");
  const trakBox = boxes(moov).find(item => item.type === "trak").data;
  assert.equal(boxes(trakBox).find(item => item.type === "tkhd").data.readUInt32BE(16), 42_500, "tkhd 时长使用影片时间刻度");
  const mdhd = boxes(boxes(trakBox).find(item => item.type === "mdia").data).find(item => item.type === "mdhd").data;
  assert.equal(mdhd.readUInt32BE(16), 42 * 90_000 + 45_000, "mdhd 时长按媒体时间刻度写入");
  assert.ok(mov.length === patched.length, "改写不改变初始化段长度");
  console.log("PASS 初始化段时长改写（v0 嵌套结构）");
}

{
  // Version 1 headers use 64-bit timestamps: mvhd v1 timescale sits at 20 and
  // duration at 24, mdhd v1 at the same relative offsets.
  const v1 = (type, duration, scale) => {
    const payload = Buffer.alloc(40); payload[0] = 1;
    payload.writeUInt32BE(scale, 20); payload.writeBigUInt64BE(BigInt(duration), 24);
    return box(type, payload);
  };
  const tkhd1 = box("tkhd", (() => { const payload = Buffer.alloc(40); payload[0] = 1; payload.writeBigUInt64BE(10_000n, 24); return payload; })());
  const mov = box("moov", Buffer.concat([v1("mvhd", 10_000, 1000),
    box("trak", Buffer.concat([tkhd1, box("mdia", v1("mdhd", 900_000, 90_000))]))]));
  const patched = rewriteInitializationDuration(mov, 12.5);
  const moov = boxes(patched).find(item => item.type === "moov").data;
  assert.equal(Number(boxes(moov).find(item => item.type === "mvhd").data.readBigUInt64BE(24)), 12_500);
  const trakBox = boxes(moov).find(item => item.type === "trak").data;
  // tkhd v1: version+flags(4) + creation(8) + modification(8) + trackId(4) + reserved(4) → duration at 16.
  assert.equal(Number(boxes(trakBox).find(item => item.type === "tkhd").data.readBigUInt64BE(16)), 12_500, "tkhd v1 时长使用影片时间刻度");
  assert.equal(Number(boxes(boxes(trakBox).find(item => item.type === "mdia").data).find(item => item.type === "mdhd").data.readBigUInt64BE(24)), 12 * 90_000 + 45_000);
  console.log("PASS 初始化段时长改写（v1 64 位头）");
}

{
  const unknown = box("moov", box("mvhd", Buffer.alloc(100)));
  assert.equal(rewriteInitializationDuration(unknown, 10).equals(unknown), true, "未知结构保持原样");
  assert.equal(rewriteInitializationDuration(mvhdV0(0), Number.NaN).readUInt32BE(16), 0, "非法时长不写入");
  console.log("PASS 初始化段改写对异常输入安全");
}

// Real FFmpeg fragment: the initialization segment must survive the rewrite and
// keep its track table readable.
if (process.env.LMD_SKIP_FFMPEG_TEST !== "1") {
  const directory = mkdtempSync(path.join(tmpdir(), "lmd-mp4-"));
  try {
    const file = path.join(directory, "init.mp4");
    const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=10:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10",
      "-c:a", "aac", "-movflags", "+empty_moov+default_base_moof+frag_keyframe", "-f", "mp4", file], { encoding: "buffer" });
    assert.equal(result.status, 0, `FFmpeg 生成初始化段失败: ${result.stderr}`);
    const original = await import("node:fs/promises").then(fs => fs.readFile(file));
    const patched = rewriteInitializationDuration(original, 123.456);
    const tracks = parseInitialization(patched);
    assert.ok(tracks.size >= 2, "改写后仍能解析出视频与音频轨道");
    const moov = boxes(patched).find(item => item.type === "moov").data;
    const mvhd = boxes(moov).find(item => item.type === "mvhd").data;
    const version = mvhd[0];
    const seconds = version === 1 ? Number(mvhd.readBigUInt64BE(24)) / mvhd.readUInt32BE(20) : mvhd.readUInt32BE(16) / mvhd.readUInt32BE(12);
    assert.ok(Math.abs(seconds - 123.456) < 0.01, `mvhd 时长应为 123.456，实际 ${seconds}`);
    assert.equal(patched.length, original.length, "真实初始化段长度不变");
    console.log(`PASS 真实 FFmpeg 初始化段改写（${tracks.size} 条轨道，时长 ${seconds.toFixed(3)}s）`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

{
  // Incremental box reader: chunk boundaries must not corrupt box parsing.
  async function* chunks(buffer, size) { for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size); }
  const payload = Buffer.concat([box("ftyp", Buffer.from("isom")), box("moov", Buffer.alloc(64)), box("mdat", Buffer.alloc(200, 7))]);
  const seen = [];
  for await (const item of readMp4Boxes(chunks(payload, 7))) seen.push(item.type);
  assert.deepEqual(seen, ["ftyp", "moov", "mdat"], "分块读取应还原完整 box 序列");
  await assert.rejects(async () => { for await (const _ of readMp4Boxes(chunks(payload.subarray(0, 20), 5))) void _; }, /Incomplete MP4 fragment/);
  console.log("PASS 增量 box 读取与截断检测");
}

async function* syntheticMdat(payloadBytes, chunkBytes = 64 * 1024) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payloadBytes + 8, 0);
  header.write("mdat", 4, 4, "ascii");
  yield header;
  const block = Buffer.alloc(chunkBytes, 7);
  for (let remaining = payloadBytes, count = 0; remaining > 0; count++) {
    const size = Math.min(remaining, block.length);
    yield block.subarray(0, size);
    remaining -= size;
    if (count % 128 === 127) await new Promise(resolve => setImmediate(resolve));
  }
}

async function benchmarkMdat(payloadBytes, concurrency = 1) {
  const started = performance.now(), rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore, timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1);
  timer.unref();
  const parse = async () => {
    let total = 0, maxChunk = 0, count = 0;
    for await (const item of readMp4Boxes(syntheticMdat(payloadBytes))) {
      assert.equal(item.type, "mdat");
      for await (const chunk of item.chunks()) { total += chunk.length; maxChunk = Math.max(maxChunk, chunk.length); count++; }
    }
    assert.equal(total, payloadBytes + 8);
    assert.ok(maxChunk <= 64 * 1024, "大 mdat 必须保持分块消费，不能合并成完整 Buffer");
    return count;
  };
  const chunkCounts = await Promise.all(Array.from({ length: concurrency }, parse));
  clearInterval(timer); peakRss = Math.max(peakRss, process.memoryUsage().rss);
  return { boxMiB: Number(((payloadBytes + 8) / 1024 ** 2).toFixed(1)), concurrency, elapsedMs: Math.round(performance.now() - started),
    peakRssDeltaMiB: Number(((peakRss - rssBefore) / 1024 ** 2).toFixed(1)), chunks: chunkCounts.reduce((sum, count) => sum + count, 0) };
}

{
  const mib = 1024 ** 2;
  const linear64 = await benchmarkMdat(64 * mib - 8);
  const linear128 = await benchmarkMdat(128 * mib - 8);
  assert.ok(linear128.elapsedMs <= linear64.elapsedMs * 4 + 100,
    `128 MiB 处理时间应接近线性：64 MiB=${linear64.elapsedMs}ms，128 MiB=${linear128.elapsedMs}ms`);
  const concurrent5 = await benchmarkMdat(64 * mib - 8, 5);
  const concurrent10 = await benchmarkMdat(64 * mib - 8, 10);
  console.log(`PASS 大 mdat 流式基准 ${JSON.stringify([linear64, linear128, concurrent5, concurrent10])}`);
}

console.log("playback-mp4 测试全部通过");
