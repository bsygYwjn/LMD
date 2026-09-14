import Hls from "hls.js";
import { LatestTaskQueue, type LatestTaskContext } from "./latest-task-queue.ts";

export type MediaTrack = { id: string; index: number; type: string; codec: string; codecString: string; profile: string; level: number;
  width: number; height: number; frameRate: number; bitRate: number; bitDepth: number; channels: number; sampleRate: number;
  language: string; title: string; default: boolean; forced?: boolean; attachedPicture: boolean; hdr: boolean };
export function audioTrackLabel(track: MediaTrack, ordinal: number) {
  return [track.title, track.language === "und" ? "未知语言" : track.language, track.codec.toUpperCase(),
    track.channels ? `${track.channels} 声道` : "", `轨道 ${ordinal + 1}`, track.default ? "默认" : "", track.forced ? "强制" : ""].filter(Boolean).join(" · ");
}
export type MediaInfo = { mediaId: string; version: number; sourceSignature: string; container: string; duration: number; startTime: number; bitRate: number; tracks: MediaTrack[] };
type Capabilities = { mse: boolean; nativeHls: boolean; h264: boolean; aac: boolean; direct: Record<string, boolean>; tracks: Record<string, { mse: boolean; file: boolean; smooth?: boolean; powerEfficient?: boolean }> };
export type PlaybackState = { mediaId: string; currentTime: number; duration: number; paused: boolean; seeking: boolean; buffering: boolean;
  volume: number; muted: boolean; playbackRate: number; tracks: MediaTrack[]; audioTrackId: string | null;
  buffered: [number, number][]; seekable: [number, number][]; strategy: string; transport: string; timeOffset: number;
  generation: number; error: string; errorCode: string; autoplayBlocked: boolean; firstFrameMs: number | null; lastSeekMs: number | null };
type Session = { sessionId: string; generation: number; strategy: string; transport: string; duration: number; timeOffset: number; sourceStart: number; readyEnd: number;
  requestedTime: number; url: string; eof: boolean; state: string; error: { code: string; message: string } | null;
  heartbeatSeconds: number; buffer: { aheadSeconds: number; backBufferSeconds: number; maxBufferBytes: number };
  plan: { audio: { track: MediaTrack } | null; video: { track: MediaTrack }; fallbackLevel: number } };
type Listener = (state: PlaybackState, event: string) => void;
type SessionUpdate = { target: number; audioTrackId: string | null; seek: boolean };

export async function api<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal, onResponse?: (payload: { sessionId?: string }) => void): Promise<T> {
  const response = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "Content-Type": "application/json" }, signal, cache: "no-store" });
  let data: unknown = null;
  try { data = await response.json(); }
  catch (error) {
    // The response body can be aborted after the server already created the
    // resource; the caller learns about it through onResponse and must clean up
    // whatever it can no longer adopt.
    const partial = (error as Error) || new Error("响应读取中断");
    throw Object.assign(partial, { bodyRead: true });
  }
  const payload = (data ?? {}) as { error?: string; code?: string; sessionId?: string };
  onResponse?.(payload);
  if (!response.ok) throw Object.assign(new Error(payload.error || `请求失败（${response.status}）`), { code: payload.code, status: response.status });
  return data as T;
}
const mime = (container: string, codecs: string[]) => `video/${container}; codecs="${codecs.join(",")}"`;
const can = (video: HTMLVideoElement, contentType: string) => { try { return Boolean(video.canPlayType(contentType)); } catch { return false; } };

export async function detectCapabilities(video: HTMLVideoElement, info: MediaInfo): Promise<Capabilities> {
  const source = window.MediaSource || (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  const supports = (value: string) => { try { return Boolean(source?.isTypeSupported(value)); } catch { return false; } };
  const result: Capabilities = { mse: Hls.isSupported(), nativeHls: can(video, "application/vnd.apple.mpegurl"),
    h264: supports(mime("mp4", ["avc1.640028"])) || can(video, mime("mp4", ["avc1.640028"])),
    aac: supports('audio/mp4; codecs="mp4a.40.2"') || can(video, 'audio/mp4; codecs="mp4a.40.2"'), direct: {}, tracks: {} };
  await Promise.all(info.tracks.filter(t => ["video", "audio"].includes(t.type) && !t.attachedPicture).map(async track => {
    const contentType = `${track.type}/mp4; codecs="${track.codecString}"`;
    const fileType = `${track.type}/${info.container === "webm" ? "webm" : "mp4"}; codecs="${track.codecString}"`;
    const cap: Capabilities["tracks"][string] = { mse: Boolean(track.codecString) && supports(contentType), file: Boolean(track.codecString) && can(video, fileType) };
    const query: MediaDecodingConfiguration = track.type === "video"
      ? { type: "file", video: { contentType: fileType, width: track.width || 1920, height: track.height || 1080, bitrate: track.bitRate || info.bitRate || 8000000, framerate: track.frameRate || 24 } }
      : { type: "file", audio: { contentType: fileType, channels: String(track.channels || 2), bitrate: track.bitRate || 256000, samplerate: track.sampleRate || 48000 } };
    try {
      const decoded = await Promise.race([navigator.mediaCapabilities?.decodingInfo(query), new Promise<undefined>(resolve => setTimeout(resolve, 700))]);
      if (decoded) { cap.file = cap.file && decoded.supported; cap.smooth = decoded.smooth; cap.powerEfficient = decoded.powerEfficient; }
    } catch { /* Unknown capabilities fall back to exact MIME tests and playback. */ }
    result.tracks[track.id] = cap;
  }));
  const videos = info.tracks.filter(t => t.type === "video" && !t.attachedPicture), audios = info.tracks.filter(t => t.type === "audio");
  for (const videoTrack of videos) for (const audio of audios.length ? audios : [null]) {
    result.direct[`${videoTrack.id}:${audio?.id || "none"}`] = Boolean(result.tracks[videoTrack.id]?.file && (!audio || result.tracks[audio.id]?.file))
      && can(video, mime(info.container === "webm" ? "webm" : "mp4", [videoTrack.codecString, ...(audio ? [audio.codecString] : [])]));
  }
  return result;
}

export class PlaybackCore extends EventTarget {
  readonly video: HTMLVideoElement;
  private listeners = new Set<Listener>();
  private mediaInfo: MediaInfo | null = null;
  private capabilities: Capabilities | null = null;
  private session: Session | null = null;
  private hls: Hls | null = null;
  private abort = new AbortController();
  private sequence = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private eventHandlers: [string, EventListener][] = [];
  private disposed = false;
  private switching = false;
  private intent = false;
  private fallbackLevel = 0;
  private nativeFallback = false;
  private recovering = false;
  private retrying: Promise<void> | null = null;
  private ended = false;
  private startedAt = 0;
  private seekStarted = 0;
  private pendingTarget = 0;
  private heartbeatBusy = false;
  private frameCallback: number | undefined;
  private networkRetry = 0;
  private reloadAttempts = 0;
  private desiredAudioTrackId: string | null = null;
  private pendingSeek = false;
  private readonly sessionUpdates: LatestTaskQueue<SessionUpdate>;
  private state: PlaybackState = { mediaId: "", currentTime: 0, duration: 0, paused: true, seeking: false, buffering: false,
    volume: 1, muted: false, playbackRate: 1, tracks: [], audioTrackId: null, buffered: [], seekable: [], strategy: "", transport: "", timeOffset: 0,
    generation: 0, error: "", errorCode: "", autoplayBlocked: false, firstFrameMs: null, lastSeekMs: null };

  constructor(video: HTMLVideoElement) {
    super(); this.video = video; video.controls = false; video.playsInline = true;
    this.sessionUpdates = new LatestTaskQueue((update, context) => this.applySessionUpdate(update, context));
    for (const name of ["loadedmetadata", "durationchange", "play", "playing", "pause", "seeking", "seeked", "timeupdate", "ratechange", "volumechange", "waiting", "progress", "ended", "error"]) {
      const fn = () => this.onMediaEvent(name); video.addEventListener(name, fn); this.eventHandlers.push([name, fn]);
    }
    window.addEventListener("pagehide", this.pageHide);
    window.addEventListener("online", this.onOnline);
  }
  // A media-compatible clock for plugins, backed by the original timeline.
  get currentTime() { return this.switching ? this.state.currentTime : Math.max(0, Math.min(this.state.duration, this.video.currentTime + this.state.timeOffset)); }
  get duration() { return this.state.duration; }
  get paused() { return this.state.paused || this.state.buffering || this.switching; }
  get playbackRate() { return this.video.playbackRate; }
  getState() { return this.state; }
  subscribe(listener: Listener) { this.listeners.add(listener); listener(this.state, "state"); return () => { this.listeners.delete(listener); }; }
  private emit(event: string, patch: Partial<PlaybackState> = {}) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state, event);
    this.dispatchEvent(new Event(event));
  }
  private ranges(ranges: TimeRanges): [number, number][] { return Array.from({ length: ranges.length }, (_, i) => [Math.max(0, ranges.start(i) + this.state.timeOffset), Math.min(this.duration, ranges.end(i) + this.state.timeOffset)] as [number, number]).filter(([a, b]) => b > a); }
  private onMediaEvent(event: string) {
    if (this.disposed) return;
    if (event === "volumechange" || event === "ratechange") {
      this.emit(event, { volume: this.video.volume, muted: this.video.muted, playbackRate: this.video.playbackRate }); return;
    }
    if (this.switching) return;
    if (event === "error") {
      if (this.video.error?.code === 2) this.emit("error", { error: "网络连接中断，恢复连接后可重试", errorCode: "NETWORK_ERROR", buffering: false });
      else void this.fallback();
      return;
    }
    const currentTime = Math.max(0, Math.min(this.duration, this.video.currentTime + this.state.timeOffset));
    if (event === "ended") {
      if (currentTime >= this.duration - 0.35 && !this.ended) { this.ended = true; this.intent = false; this.emit("ended", { currentTime: this.duration, paused: true, buffering: false }); }
      else if (!this.ended) void this.seek(currentTime);
      return;
    }
    const patch: Partial<PlaybackState> = { currentTime, paused: this.video.paused, buffered: this.ranges(this.video.buffered), seekable: this.duration ? [[0, this.duration]] : [] };
    if (event === "waiting") patch.buffering = true;
    if (event === "playing" || event === "seeked") { patch.buffering = false; patch.seeking = false; patch.error = ""; patch.errorCode = ""; }
    if (event === "seeking") patch.seeking = true;
    if (event === "seeked" && this.seekStarted) { patch.lastSeekMs = Math.round(performance.now() - this.seekStarted); this.seekStarted = 0; }
    this.emit(event, patch);
  }
  async load(mediaId: string, options: { startTime?: number; autoplay?: boolean } = {}) {
    this.mediaInfo = null; this.capabilities = null;
    this.sessionUpdates.cancel(); this.pendingSeek = false; this.desiredAudioTrackId = null;
    this.sequence++; this.abort.abort(); this.abort = new AbortController();
    const sequence = this.sequence; this.switching = true; this.releaseTransport();
    this.intent = options.autoplay !== false; this.fallbackLevel = 0; this.nativeFallback = false; this.ended = false; this.reloadAttempts = 0; this.startedAt = performance.now();
    this.emit("loading", { mediaId, currentTime: options.startTime || 0, duration: 0, tracks: [], error: "", errorCode: "", buffering: true, firstFrameMs: null, autoplayBlocked: false });
    try {
      const info = await api<MediaInfo>(`/api/media/${mediaId}/info`, undefined, "GET", this.abort.signal);
      const capabilities = await detectCapabilities(this.video, info);
      if (sequence !== this.sequence || this.disposed) return;
      this.mediaInfo = info; this.capabilities = capabilities;
      this.emit("loadedmetadata", { duration: info.duration, tracks: info.tracks });
      await this.openSession(options.startTime || 0);
    } catch (error) { if (sequence === this.sequence && !this.disposed) this.fail(error); }
  }
  private teardownMediaTransport() {
    clearInterval(this.heartbeat); this.heartbeat = undefined;
    this.hls?.destroy(); this.hls = null;
    if (this.frameCallback !== undefined) { this.video.cancelVideoFrameCallback?.(this.frameCallback); this.frameCallback = undefined; }
    this.video.pause(); this.video.removeAttribute("src"); this.video.load();
  }
  private releaseSession() {
    // keepalive keeps the release alive while the page is unloading; without it
    // the browser cancels the request and the server only frees the session when
    // the lease expires.
    if (this.session) { const id = this.session.sessionId; this.session = null; void fetch(`/api/playback-sessions/${id}`, { method: "DELETE", keepalive: true }).catch(() => {}); }
  }
  private releaseTransport() { this.teardownMediaTransport(); this.releaseSession(); }
  private async createSession(target: number, audioTrackId: string | null, signal: AbortSignal) {
    if (!this.mediaInfo || !this.capabilities) throw new Error("播放信息尚未就绪");
    return api<Session>(`/api/media/${this.mediaInfo.mediaId}/playback-sessions`, { capabilities: this.capabilities, startTime: target,
      audioTrackId, fallbackLevel: this.fallbackLevel, preferNativeHls: this.nativeFallback }, "POST", signal);
  }
  private isCurrentSession(session: Session, sequence: number) {
    return sequence === this.sequence && !this.disposed && this.session?.sessionId === session.sessionId && this.session.generation === session.generation;
  }
  private attachSession(session: Session, target: number, sequence: number) {
    if (sequence !== this.sequence || this.disposed) return;
    this.session = session; this.desiredAudioTrackId = session.plan.audio?.track.id || null;
    this.emit("strategychange", { strategy: session.strategy, transport: session.transport, timeOffset: session.timeOffset, generation: session.generation,
      audioTrackId: this.desiredAudioTrackId });
    const start = Math.max(0, target - session.timeOffset);
    const onReady = () => {
      if (!this.isCurrentSession(session, sequence)) return;
      this.video.currentTime = start; this.switching = false;
      this.emit("loadedmetadata", { paused: !this.intent });
      if (this.intent) void this.play(); else this.emit("pause", { paused: true, buffering: false, seeking: false });
      if (this.video.requestVideoFrameCallback) this.frameCallback = this.video.requestVideoFrameCallback(() => {
        if (this.isCurrentSession(session, sequence)) this.emit("firstframe", { firstFrameMs: this.state.firstFrameMs ?? Math.round(performance.now() - this.startedAt),
          lastSeekMs: this.seekStarted ? Math.round(performance.now() - this.seekStarted) : this.state.lastSeekMs, buffering: false, seeking: false });
        this.seekStarted = 0;
      });
    };
    this.video.addEventListener("loadedmetadata", onReady, { once: true, signal: this.abort.signal });
    if (session.transport === "mse") {
      this.video.disableRemotePlayback = true;
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, autoStartLoad: false, startPosition: start,
        maxBufferLength: session.buffer.aheadSeconds, maxMaxBufferLength: session.buffer.aheadSeconds,
        backBufferLength: session.buffer.backBufferSeconds, maxBufferSize: session.buffer.maxBufferBytes,
        liveSyncDuration: 86400, liveMaxLatencyDuration: Infinity, maxLiveSyncPlaybackRate: 1 });
      this.hls = hls;
      hls.on(Hls.Events.MEDIA_ATTACHED, () => { if (this.isCurrentSession(session, sequence)) hls.loadSource(session.url); });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { if (this.isCurrentSession(session, sequence)) hls.startLoad(start); });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !this.isCurrentSession(session, sequence)) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          this.emit("error", { error: "网络或播放会话暂时不可用，点击重试", errorCode: "NETWORK_ERROR", buffering: false });
          if (navigator.onLine && this.networkRetry++ < 2) void this.seek(this.currentTime).catch(error => this.fail(error));
        } else void this.fallback();
      });
      hls.attachMedia(this.video);
    } else { this.video.src = session.url; this.video.load(); }
    this.heartbeat = setInterval(() => void this.keepAlive(), session.heartbeatSeconds * 1000);
  }
  private async openSession(target: number, audioTrackId = this.desiredAudioTrackId) {
    if (!this.mediaInfo || !this.capabilities || this.disposed) return;
    this.sessionUpdates.cancel(); this.pendingSeek = false;
    this.sequence++; const sequence = this.sequence;
    this.abort.abort(); this.abort = new AbortController(); this.switching = true; this.pendingTarget = target;
    this.releaseTransport();
    this.emit("seeking", { currentTime: target, seeking: true, buffering: true, error: "", errorCode: "", buffered: [] });
    try {
      const session = await this.createSession(target, audioTrackId, this.abort.signal);
      if (sequence !== this.sequence || this.disposed) { void fetch(`/api/playback-sessions/${session.sessionId}`, { method: "DELETE", keepalive: true }); return; }
      this.attachSession(session, target, sequence);
    } catch (error) {
      if (sequence !== this.sequence || this.disposed) return;
      const code = (error as { code?: string }).code || "";
      // The original file changed between requests: refresh metadata once and
      // rebuild the session instead of leaving the player in a dead state.
      if (code === "SOURCE_CHANGED" && this.reloadAttempts < 1) {
        this.reloadAttempts++;
        await this.load(this.state.mediaId, { startTime: this.state.currentTime, autoplay: this.intent });
        return;
      }
      if (["PIPELINE_FAILED", "NO_DECODER", "TIMELINE_UNAVAILABLE"].includes(code) && this.fallbackLevel < 3) { this.recovering = false; await this.fallback(); }
      else this.fail(error);
    }
  }
  private rememberSession(sessionId: string, updated: Session) {
    if (this.session?.sessionId === sessionId && updated.generation >= this.session.generation) this.session = updated;
  }
  private sessionMatchesUpdate(session: Session, update: SessionUpdate) {
    return Math.abs(session.requestedTime - update.target) < 0.05 && (session.plan.audio?.track.id || null) === update.audioTrackId;
  }
  private async replaceExpiredSession(update: SessionUpdate, context: LatestTaskContext) {
    if (!context.isLatest() || this.disposed) return null;
    const replacement = await this.createSession(update.target, update.audioTrackId, this.abort.signal);
    if (!context.isLatest() || this.disposed) {
      void fetch(`/api/playback-sessions/${replacement.sessionId}`, { method: "DELETE", keepalive: true }).catch(() => {});
      return null;
    }
    this.session = replacement;
    return replacement;
  }
  private async updateExistingSession(base: Session, update: SessionUpdate, context: LatestTaskContext) {
    let current = base;
    for (let attempt = 0; attempt < 2; attempt++) {
      const audioChanged = (current.plan.audio?.track.id || null) !== update.audioTrackId;
      const body: { generation: number; position: number; seekTime?: number; audioTrackId?: string | null } = {
        generation: current.generation, position: update.target,
      };
      if (update.seek) body.seekTime = update.target;
      if (audioChanged) body.audioTrackId = update.audioTrackId;
      try {
        const updated = await api<Session>(`/api/playback-sessions/${current.sessionId}`, body, "PATCH", this.abort.signal);
        this.rememberSession(current.sessionId, updated);
        return updated;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if ((error as Error).name === "AbortError" || this.disposed) throw error;
        if ((error as { code?: string }).code === "SOURCE_CHANGED") throw error;
        if (status === 410) {
          if (this.session?.sessionId === current.sessionId) this.session = null;
          return this.replaceExpiredSession(update, context);
        }
        // A generation conflict or an ambiguous network failure may mean the
        // server committed the request but its response never reached us. Read
        // back the authoritative generation before deciding whether to retry.
        if (status !== 409 && status !== undefined) throw error;
        let refreshed: Session;
        try { refreshed = await api<Session>(`/api/playback-sessions/${current.sessionId}`, undefined, "GET", this.abort.signal); }
        catch (refreshError) {
          if ((refreshError as { status?: number }).status === 410) {
            if (this.session?.sessionId === current.sessionId) this.session = null;
            return this.replaceExpiredSession(update, context);
          }
          throw error;
        }
        this.rememberSession(current.sessionId, refreshed);
        if (this.sessionMatchesUpdate(refreshed, update)) return refreshed;
        if (!context.isLatest()) return null;
        current = refreshed;
      }
    }
    throw Object.assign(new Error("播放会话更新冲突，请重试"), { code: "STALE_SESSION" });
  }
  private async applySessionUpdate(update: SessionUpdate, context: LatestTaskContext) {
    if (!this.mediaInfo || !this.capabilities || this.disposed) return;
    this.pendingSeek = false;
    const sequence = this.sequence;
    this.abort.abort(); this.abort = new AbortController();
    this.teardownMediaTransport();
    this.emit("seeking", { currentTime: update.target, seeking: true, buffering: true, error: "", errorCode: "", buffered: [] });
    try {
      const existing = this.session;
      const updated = existing
        ? await this.updateExistingSession(existing, update, context)
        : await this.replaceExpiredSession(update, context);
      if (!updated || !context.isLatest() || sequence !== this.sequence || this.disposed) return;
      this.attachSession(updated, update.target, sequence);
    } catch (error) {
      if (!context.isLatest() || sequence !== this.sequence || this.disposed) return;
      const code = (error as { code?: string }).code || "";
      if (code === "SOURCE_CHANGED" && this.reloadAttempts < 1) {
        this.reloadAttempts++;
        await this.load(this.state.mediaId, { startTime: update.target, autoplay: this.intent });
      } else if (["PIPELINE_FAILED", "NO_DECODER", "TIMELINE_UNAVAILABLE"].includes(code) && this.fallbackLevel < 3) {
        this.recovering = false; await this.fallback();
      } else throw error;
    }
  }
  private queueSessionUpdate(target: number, audioTrackId: string | null, seek: boolean) {
    this.pendingSeek ||= seek; this.desiredAudioTrackId = audioTrackId;
    this.sequence++; this.switching = true; this.pendingTarget = target;
    this.video.pause();
    this.emit("seeking", { currentTime: target, seeking: true, buffering: true, error: "", errorCode: "" });
    return this.sessionUpdates.enqueue({ target, audioTrackId, seek: this.pendingSeek }).catch(error => this.fail(error));
  }
  private async keepAlive() {
    if (!this.session || this.heartbeatBusy || this.disposed || this.switching) return;
    this.heartbeatBusy = true; const session = this.session;
    try {
      const updated = await api<Session>(`/api/playback-sessions/${session.sessionId}`, { position: this.currentTime, generation: session.generation }, "PATCH");
      if (this.session !== session || this.switching) return;
      this.session = updated;
      if (updated.error) this.fail(Object.assign(new Error(updated.error.message), { code: updated.error.code }));
    } catch (error) {
      if (this.session !== session || this.switching) return;
      if ((error as { status?: number }).status === 410) await this.openSession(this.currentTime);
      else if ([401, 403, 404].includes((error as { status?: number }).status || 0)) { this.pause(); this.fail(error); }
    } finally { this.heartbeatBusy = false; }
  }
  private fail(error: unknown) {
    if ((error as Error)?.name === "AbortError" || this.disposed) return;
    this.switching = false;
    this.emit("error", { error: (error as Error)?.message || "无法播放视频", errorCode: (error as { code?: string })?.code || "PLAYBACK_ERROR", buffering: false, seeking: false });
  }
  private async fallback() {
    if (this.recovering || this.disposed) return;
    this.recovering = true;
    try {
      if (this.session?.transport === "mse" && this.capabilities?.nativeHls && !this.nativeFallback) this.nativeFallback = true;
      else {
        if (this.fallbackLevel >= 3) { this.fail(new Error("已尝试兼容播放，当前设备仍无法解码这个视频")); return; }
        this.fallbackLevel++;
      }
      await this.openSession(this.state.currentTime || this.pendingTarget);
    } finally { this.recovering = false; }
  }
  async play() {
    this.intent = true; this.ended = false;
    if (this.switching) return;
    try { await this.video.play(); this.emit("play", { paused: false, autoplayBlocked: false }); }
    catch (error) {
      if ((error as Error).name === "NotAllowedError") this.emit("autoplayblocked", { autoplayBlocked: true, paused: true, buffering: false });
      else if ((error as Error).name !== "AbortError") this.fail(error);
    }
  }
  pause() { this.intent = false; this.video.pause(); this.emit("pause", { paused: true }); }
  async seek(time: number) {
    if (!this.mediaInfo) return;
    const target = Math.max(0, Math.min(time, Math.max(0, this.duration - 0.02))); this.seekStarted = performance.now(); this.ended = false;
    // A local seek only works while this element really holds the requested
    // range: DIRECT always has the file, otherwise the target must be buffered.
    const local = this.session?.strategy === "DIRECT" || this.state.buffered.some(([start, end]) => target >= start && target < end - 0.1);
    if (local && !this.switching) {
      this.video.currentTime = Math.max(0, target - this.state.timeOffset);
      this.emit("seeking", { currentTime: target, seeking: true });
      if (this.intent) void this.play();
      void this.keepAlive();
    } else await this.queueSessionUpdate(target, this.desiredAudioTrackId, true);
  }
  retry(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.retrying) return this.retrying;
    this.retrying = this.retryPlayback().finally(() => { this.retrying = null; });
    return this.retrying;
  }
  private async retryPlayback() {
    if (!this.mediaInfo || !this.capabilities) {
      await this.load(this.state.mediaId, { startTime: this.state.currentTime, autoplay: this.intent });
      return;
    }
    this.networkRetry = 0; this.sessionUpdates.cancel(); this.pendingSeek = false;
    const target = this.currentTime, existing = this.session;
    if (!existing) { await this.openSession(target); return; }
    this.sequence++; const sequence = this.sequence;
    this.abort.abort(); this.abort = new AbortController(); this.switching = true; this.pendingTarget = target;
    this.teardownMediaTransport();
    this.emit("seeking", { currentTime: target, seeking: true, buffering: true, error: "", errorCode: "", buffered: [] });
    try {
      let refreshed: Session;
      try {
        refreshed = await api<Session>(`/api/playback-sessions/${existing.sessionId}`, { position: target, generation: existing.generation }, "PATCH", this.abort.signal);
      } catch (error) {
        // A failed/aborted seek may already have advanced the server generation.
        // Reconcile it before trying to restart the failed pipeline.
        if ((error as { code?: string }).code !== "STALE_SESSION") throw error;
        refreshed = await api<Session>(`/api/playback-sessions/${existing.sessionId}`, undefined, "GET", this.abort.signal);
      }
      if (sequence !== this.sequence || this.disposed || this.session?.sessionId !== existing.sessionId) return;
      this.session = refreshed;
      if (refreshed.error) {
        refreshed = await api<Session>(`/api/playback-sessions/${existing.sessionId}`, { seekTime: target, generation: refreshed.generation }, "PATCH", this.abort.signal);
        if (sequence !== this.sequence || this.disposed || this.session?.sessionId !== existing.sessionId) return;
      }
      this.attachSession(refreshed, target, sequence);
    } catch (error) {
      if (sequence !== this.sequence || this.disposed) return;
      if ((error as { status?: number }).status === 410) await this.openSession(target);
      else if ((error as { code?: string }).code === "SOURCE_CHANGED") await this.load(this.state.mediaId, { startTime: target, autoplay: this.intent });
      else this.fail(error);
    }
  }
  setVolume(volume: number) { this.video.volume = Math.max(0, Math.min(1, volume)); if (volume > 0) this.video.muted = false; }
  setMuted(muted: boolean) { this.video.muted = muted; }
  setPlaybackRate(rate: number) { if (Number.isFinite(rate) && rate >= 0.25 && rate <= 4) this.video.playbackRate = rate; }
  async selectAudioTrack(trackId: string) {
    if (this.disposed || !this.mediaInfo?.tracks.some(track => track.type === "audio" && track.id === trackId) || trackId === this.desiredAudioTrackId) return;
    const target = this.currentTime;
    await this.queueSessionUpdate(target, trackId, false);
  }
  private pageHide = () => {
    this.sessionUpdates.cancel(); this.pendingSeek = false; this.sequence++; this.abort.abort(); this.releaseTransport();
  };
  private onOnline = () => { if (this.state.errorCode === "NETWORK_ERROR") void this.retry(); };
  async destroy() {
    this.disposed = true; this.sessionUpdates.dispose(); this.pendingSeek = false; this.sequence++; this.abort.abort(); this.releaseTransport(); this.listeners.clear();
    for (const [event, handler] of this.eventHandlers) this.video.removeEventListener(event, handler);
    window.removeEventListener("pagehide", this.pageHide); window.removeEventListener("online", this.onOnline);
  }
}
