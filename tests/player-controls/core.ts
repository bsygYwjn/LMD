// Only the test Vite resolver substitutes this class; production imports the real core.
export class PlaybackCore extends EventTarget {
  state = { mediaId: "fixture", currentTime: 50, duration: 120, paused: false, seeking: false, buffering: false, volume: 1, muted: false, playbackRate: 1, tracks: [], audioTrackId: null, buffered: [], seekable: [], strategy: "TEST", transport: "test", timeOffset: 0, generation: 0, error: "", errorCode: "", autoplayBlocked: false, firstFrameMs: 0, lastSeekMs: 0 };
  listeners = new Set(); calls = { play: 0, pause: 0, seek: [] as number[], rate: [] as number[] };
  constructor(public video: HTMLVideoElement) { super(); window.testCore = this; }
  get currentTime() { return this.state.currentTime; }
  get playbackRate() { return this.state.playbackRate; }
  getState() { return this.state; }
  emit(event: string, values = {}) { this.state = { ...this.state, ...values }; this.listeners.forEach(fn => fn(this.state, event)); }
  subscribe(fn) { this.listeners.add(fn); fn(this.state, "state"); return () => this.listeners.delete(fn); }
  async load() { this.emit("playing"); }
  async play() { this.calls.play++; this.emit("play", { paused: false }); }
  pause() { this.calls.pause++; this.emit("pause", { paused: true }); }
  async seek(value: number) { this.calls.seek.push(value); this.emit("seeking", { currentTime: value }); }
  setVolume(volume: number) { this.emit("volumechange", { volume }); }
  setMuted(muted: boolean) { this.emit("volumechange", { muted }); }
  setPlaybackRate(playbackRate: number) { this.calls.rate.push(playbackRate); this.emit("ratechange", { playbackRate }); }
  async destroy() { this.listeners.clear(); }
}

export { audioTrackLabel } from "../../src/player/core";
