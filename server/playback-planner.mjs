// Pure, client-specific planning. A file extension never decides whether a
// decoder can consume a track. Capabilities describe the actual track config.
export const METADATA_VERSION = 1;
export const STRATEGIES = ["DIRECT", "REMUX", "PARTIAL_TRANSCODE", "TRANSCODE"];
export const PLAYBACK_DEFAULTS = Object.freeze({
  cacheMaxBytes: 10 * 1024 ** 3, cacheTtlSeconds: 21600,
  aheadSeconds: 30, backBufferSeconds: 30, heartbeatSeconds: 10,
  leaseSeconds: 45, releaseGraceSeconds: 5, noOutputSeconds: 30,
  cleanupSeconds: 60, maxBufferBytes: 64 * 1024 ** 2, encoder: "auto",
});

export function playbackError(code, message, status = 422) {
  return Object.assign(new Error(message), { code, status });
}

export function normalizePlaybackSettings(raw = {}) {
  const result = { ...PLAYBACK_DEFAULTS };
  const ranges = { cacheMaxBytes: [64 * 1024 ** 2, 1024 ** 4], cacheTtlSeconds: [60, 604800],
    aheadSeconds: [6, 120], backBufferSeconds: [0, 120], heartbeatSeconds: [3, 30],
    leaseSeconds: [15, 180], releaseGraceSeconds: [0, 30], noOutputSeconds: [5, 120],
    cleanupSeconds: [5, 300], maxBufferBytes: [16 * 1024 ** 2, 256 * 1024 ** 2] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (raw[key] !== undefined) {
      const value = Number(raw[key]);
      if (!Number.isFinite(value) || value < min || value > max) throw playbackError("INVALID_SETTINGS", `${key} 超出允许范围`, 400);
      result[key] = value;
    }
  }
  if (["auto", "libx264", "h264_nvenc", "h264_qsv", "h264_amf"].includes(raw.encoder)) result.encoder = raw.encoder;
  if (result.leaseSeconds < result.heartbeatSeconds * 2) throw playbackError("INVALID_SETTINGS", "会话租约必须至少是心跳间隔的两倍", 400);
  return result;
}

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const ratio = value => { const [a, b = 1] = String(value || "0").split("/").map(Number); return b && Number.isFinite(a / b) ? a / b : 0; };

export function codecString(track) {
  const codec = track.codec;
  if (codec === "h264") {
    const profile = { Baseline: 66, "Constrained Baseline": 66, Main: 77, High: 100, "High 10": 110, "High 4:2:2": 122, "High 4:4:4 Predictive": 244 }[track.profile] || (track.bitDepth > 8 ? 110 : 100);
    return `avc1.${profile.toString(16).padStart(2, "0")}${track.profile === "Constrained Baseline" ? "E0" : "00"}${Math.max(10, track.level || 40).toString(16).padStart(2, "0")}`;
  }
  if (codec === "hevc") return `hvc1.${track.bitDepth > 8 ? "2.4" : "1.6"}.L${track.level > 0 ? track.level : 153}.B0`;
  if (codec === "av1") return `av01.0.${String(Math.max(0, track.level || 8)).padStart(2, "0")}M.${String(track.bitDepth || 8).padStart(2, "0")}`;
  if (codec === "vp9") return `vp09.${track.bitDepth > 8 ? "02" : "00"}.10.${String(track.bitDepth || 8).padStart(2, "0")}`;
  if (codec === "aac") return `mp4a.40.${/HE-AACv2/i.test(track.profile) ? 29 : /HE-AAC/i.test(track.profile) ? 5 : 2}`;
  return { vp8: "vp8", opus: "opus", vorbis: "vorbis", flac: "flac", mp3: "mp4a.40.34", ac3: "ac-3", eac3: "ec-3", alac: "alac" }[codec] || "";
}

export function normalizeProbe(data, { sourceSignature, webm = false } = {}) {
  const aliases = String(data.format?.format_name || "").split(",");
  const container = aliases.includes("matroska") ? (webm ? "webm" : "matroska") : aliases.includes("mp4") ? "mp4" : aliases[0];
  const tracks = (data.streams || []).map(stream => {
    const pixelFormat = stream.pix_fmt || "";
    const rawDepth = number(stream.bits_per_raw_sample);
    const pixelDepth = /(?:p|gray)(9|10|12|14|16)(?:le|be)?$/.exec(pixelFormat)?.[1];
    const track = {
      id: String(stream.index), index: stream.index, type: stream.codec_type, codec: stream.codec_name || "unknown",
      profile: stream.profile || "", level: number(stream.level), pixelFormat,
      bitDepth: rawDepth || number(pixelDepth, /(?:rgb|bgr)48|rgba64/.test(pixelFormat) ? 16 : 8),
      width: number(stream.width), height: number(stream.height), frameRate: ratio(stream.avg_frame_rate) || ratio(stream.r_frame_rate),
      bitRate: number(stream.bit_rate), timeBase: stream.time_base || "", startTime: number(stream.start_time),
      channels: number(stream.channels), channelLayout: stream.channel_layout || "", sampleRate: number(stream.sample_rate),
      language: stream.tags?.language || "und", title: stream.tags?.title || "", default: Boolean(stream.disposition?.default),
      forced: Boolean(stream.disposition?.forced), attachedPicture: Boolean(stream.disposition?.attached_pic),
      colorTransfer: stream.color_transfer || "", colorPrimaries: stream.color_primaries || "", colorSpace: stream.color_space || "",
      hdr: ["smpte2084", "arib-std-b67"].includes(stream.color_transfer),
    };
    return { ...track, codecString: codecString(track) };
  });
  return { version: METADATA_VERSION, sourceSignature, analyzedAt: new Date().toISOString(),
    container, formatAliases: aliases, duration: number(data.format?.duration), startTime: number(data.format?.start_time),
    bitRate: number(data.format?.bit_rate), tracks };
}

export function defaultTrack(metadata, type, { index = null } = {}) {
  const tracks = metadata.tracks.filter(track => track.type === type && !track.attachedPicture);
  if (index !== null) { const selected = tracks.find(track => track.index === Number(index)); if (selected) return selected; }
  return tracks.find(track => track.default) || tracks[0] || null;
}

const NO_AUDIO = new Set(["none", "off", "no", "-1", ""]);

export function planPlayback(metadata, capabilities = {}, options = {}) {
  // A request may reference a track that has since disappeared (the file was
  // replaced, or a probe produced a different track set). Falling back to the
  // default track keeps playback recoverable instead of failing the session.
  const select = (type, id, { allowNone = false } = {}) => {
    if (id == null) return defaultTrack(metadata, type);
    const key = String(id);
    if (allowNone && NO_AUDIO.has(key)) return null;
    const track = metadata.tracks.find(t => t.type === type && !t.attachedPicture && (t.id === key || String(t.index) === key));
    if (!track) { if (!allowNone) throw playbackError("INVALID_TRACK", "所选媒体轨道不存在", 400); return defaultTrack(metadata, type); }
    return track;
  };
  const video = select("video", options.videoTrackId);
  const audio = select("audio", options.audioTrackId, { allowNone: true });
  if (!video) throw playbackError("NO_VIDEO", "文件没有可播放的视频轨道");
  const failure = Math.min(3, Math.max(0, number(options.fallbackLevel)));
  const videoCap = capabilities.tracks?.[video.id] || {};
  const audioCap = audio ? capabilities.tracks?.[audio.id] || {} : null;
  const directKey = `${video.id}:${audio?.id || "none"}`;
  const direct = ["mp4", "webm", "ogg"].includes(metadata.container)
    && video.id === defaultTrack(metadata, "video")?.id && audio?.id === defaultTrack(metadata, "audio")?.id
    && capabilities.direct?.[directKey] === true && failure === 0;
  if (direct) return { strategy: "DIRECT", transport: "file", video: { track: video, action: "COPY", codec: video.codec },
    audio: audio ? { track: audio, action: "COPY", codec: audio.codec } : null, reason: "容器及所选轨道支持原生直放", fallbackLevel: failure };
  const nativeHls = capabilities.nativeHls === true;
  const mse = capabilities.mse === true;
  if (!mse && !nativeHls) throw playbackError("NO_TRANSPORT", "当前浏览器没有可用的流式媒体播放能力");
  const videoCopy = failure < 3 && ["h264", "hevc", "av1", "vp9"].includes(video.codec)
    && (mse ? videoCap.mse === true : videoCap.file === true && ["h264", "hevc"].includes(video.codec));
  const audioCopy = audio && failure < 2 && ["aac", "mp3", "ac3", "eac3", "opus", "flac", "alac"].includes(audio.codec)
    && (mse ? audioCap.mse === true : audioCap.file === true && ["aac", "ac3", "eac3"].includes(audio.codec));
  if (!videoCopy && capabilities.h264 !== true) throw playbackError("NO_DECODER", "当前浏览器未检测到兼容的 H.264 解码能力");
  if (audio && !audioCopy && capabilities.aac !== true) throw playbackError("NO_DECODER", "当前浏览器未检测到兼容的 AAC 解码能力");
  const actions = [videoCopy, ...(audio ? [Boolean(audioCopy)] : [])];
  const strategy = actions.every(Boolean) ? "REMUX" : actions.some(Boolean) ? "PARTIAL_TRANSCODE" : "TRANSCODE";
  return { strategy, transport: mse && !options.preferNativeHls ? "mse" : "native-hls", fallbackLevel: failure,
    video: { track: video, action: videoCopy ? "COPY" : "ENCODE", codec: videoCopy ? video.codec : "h264", toneMap: !videoCopy && video.hdr },
    audio: audio ? { track: audio, action: audioCopy ? "COPY" : "ENCODE", codec: audioCopy ? audio.codec : "aac",
      channels: audioCopy ? audio.channels : (audio.channels <= 2 ? audio.channels : capabilities.multichannelAac === true ? Math.min(6, audio.channels) : 2) } : null,
    reason: actions.every(Boolean) ? "保留编码，仅调整容器与轨道" : "仅转换当前客户端不兼容的轨道" };
}
