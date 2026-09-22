import assert from "node:assert/strict";
import { normalizeProbe, planPlayback, normalizePlaybackSettings } from "./playback-planner.mjs";
const probe = (container = "matroska,webm", v = "h264", a = "aac") => normalizeProbe({ format: { format_name: container, duration: "123.456" }, streams: [
  { index: 0, codec_type: "video", codec_name: v, profile: "High", level: 40, width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "24000/1001" },
  ...(a ? [{ index: 1, codec_type: "audio", codec_name: a, channels: 2, sample_rate: "48000" }] : [])] });
const caps = { mse: true, nativeHls: false, h264: true, aac: true, direct: { "0:1": true, "0:none": true }, tracks: { 0: { mse: true }, 1: { mse: true } } };
assert.equal(planPlayback(probe("mov,mp4,m4a"), caps).strategy, "DIRECT");
const remux = planPlayback(probe(), caps);
assert.equal(remux.strategy, "REMUX");
assert.equal(remux.audio.action, "COPY");
assert.equal(remux.video.action, "COPY");
const audio = planPlayback(probe("matroska", "h264", "dts"), caps);
assert.equal(audio.strategy, "PARTIAL_TRANSCODE");
assert.equal(audio.video.action, "COPY");
assert.equal(audio.audio.codec, "aac");
assert.equal(planPlayback(probe("matroska", "hevc"), caps).video.action, "COPY");
const noHevc = { ...caps, tracks: { ...caps.tracks, 0: { mse: false } } };
assert.equal(planPlayback(probe("matroska", "hevc"), noHevc).video.action, "ENCODE");
assert.equal(planPlayback(probe("matroska", "hevc"), noHevc).audio.action, "COPY");
assert.equal(planPlayback(probe(), caps, { fallbackLevel: 3 }).strategy, "TRANSCODE");
const nativeCaps = { ...caps, nativeHls: true };
const nativeFallback = planPlayback(probe("matroska", "vp9", "opus"), nativeCaps, { preferNativeHls: true });
assert.equal(nativeFallback.transport, "native-hls");
assert.equal(nativeFallback.video.action, "ENCODE", "原生 HLS 后备不能套用仅 MSE 支持的 VP9 能力");
assert.equal(nativeFallback.audio.action, "ENCODE", "原生 HLS 后备不能套用仅 MSE 支持的 Opus 能力");
const nativeCopy = planPlayback(probe(), { ...nativeCaps, tracks: { 0: { mse: false, file: true }, 1: { mse: false, file: true } } }, { preferNativeHls: true });
assert.equal(nativeCopy.strategy, "REMUX", "原生 HLS 使用其自身支持的 H.264/AAC 能力");
assert.equal(planPlayback(probe(), caps, { preferNativeHls: true }).transport, "mse", "原生 HLS 不可用时仍选择可用的 MSE");
assert.equal(planPlayback(probe("matroska", "h264", null), caps).strategy, "REMUX");
assert.equal(probe().duration, 123.456);
assert.equal(probe().tracks[0].frameRate, 24000 / 1001);
assert.equal(probe().container, "matroska", "matroska aliases alone must not imply WebM");
// A vanished audio track (file replaced, probe renumbered) must fall back to the
// default track, while an unknown video track is still a hard error.
assert.equal(planPlayback(probe(), caps, { audioTrackId: "99" }).audio.track.id, "1");
assert.equal(planPlayback(probe(), caps, { audioTrackId: "2" }).audio.track.id, "1");
assert.equal(planPlayback(probe(), caps, { audioTrackId: "none" }).audio, null);
assert.equal(planPlayback(probe("matroska", "h264", "dts"), caps, { audioTrackId: "none" }).strategy, "REMUX");
assert.throws(() => planPlayback(probe(), caps, { videoTrackId: "99" }), /轨道/);
assert.throws(() => normalizePlaybackSettings({ leaseSeconds: 15, heartbeatSeconds: 30 }), /心跳/);
console.log("Playback planner: direct/remux/partial/full, exact metadata and track validation passed");
