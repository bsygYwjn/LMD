export type SubtitleResource = { id: string; name: string; format: string; language: string; url: string | null; default?: boolean; state?: string; size?: number; modifiedAt?: string };
export type SubtitleFont = { id: string; name: string; url: string; aliases?: string[]; size?: number; modifiedAt?: string };
export type SubtitlePreparation = {
  selectionGeneration: number; sourceVersion: string; trackId: string | null;
  state: "off" | "queued" | "running" | "ready" | "failed" | "cancelled";
  subtitle: SubtitleResource | null; fonts: SubtitleFont[]; error: { code: string; message: string } | null;
};
type Descriptor = { sessionId: string; sourceVersion?: string; subtitle?: SubtitlePreparation };
type Request = <T>(url: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>;

/** Subtitle selection has its own generation and never tears down the A/V transport. */
export class SubtitlePreparationController {
  private session: { id: string; sourceVersion: string } | null = null;
  private generation = 0;
  private selected: string | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly request: Request;
  private readonly publish: (state: SubtitlePreparation) => void;
  constructor(request: Request, publish: (state: SubtitlePreparation) => void) { this.request = request; this.publish = publish; }

  private state(state: SubtitlePreparation["state"]): SubtitlePreparation {
    return { selectionGeneration: this.generation, sourceVersion: this.session?.sourceVersion || "", trackId: this.selected, state, subtitle: null, fonts: [], error: null };
  }
  bind(sessionId: string, sourceVersion: string) {
    if (this.disposed || this.session?.id === sessionId && this.session.sourceVersion === sourceVersion) return;
    this.cancelPolling(); this.session = { id: sessionId, sourceVersion }; this.generation++;
    this.publish(this.state(this.selected ? "queued" : "off"));
    if (this.selected) void this.prepare();
  }
  select(trackId: string | null, retry = false) {
    if (this.disposed || trackId === this.selected && !retry) return;
    this.cancelPolling(); this.selected = trackId; this.generation++;
    this.publish(this.state(trackId ? "queued" : "off"));
    if (this.session) void this.prepare(retry);
  }
  private cancelPolling() { this.controller?.abort(); this.controller = null; clearTimeout(this.timer); this.timer = undefined; }
  private async prepare(retry = false) {
    const session = this.session, generation = this.generation, trackId = this.selected;
    if (!session) return;
    const controller = new AbortController(); this.controller = controller;
    const current = () => !this.disposed && this.session === session && this.generation === generation && !controller.signal.aborted;
    const accept = (result: Descriptor) => {
      const state = result.subtitle;
      if (!current()) return false;
      if (result.sessionId !== session.id || result.sourceVersion && result.sourceVersion !== session.sourceVersion || state && state.sourceVersion !== session.sourceVersion) {
        this.publish({ ...this.state("failed"), error: { code: "SOURCE_CHANGED", message: "视频源或播放会话已变化，请重试播放后选择字幕" } }); return false;
      }
      if (!state || state.selectionGeneration !== generation || state.trackId !== trackId) {
        this.publish({ ...this.state("failed"), error: { code: "SUBTITLE_SELECTION_CHANGED", message: "字幕选择状态已变化，请重试字幕" } }); return false;
      }
      this.publish(state); return state.state === "queued" || state.state === "running";
    };
    let failures = 0;
    const failed = (error: unknown) => {
      if (!current()) return;
      this.publish({ ...this.state("failed"), error: { code: (error as { code?: string })?.code || "SUBTITLE_PREPARATION_FAILED", message: (error as Error)?.message || "字幕准备失败，可重试" } });
    };
    const poll = async () => {
      if (!current()) return;
      try {
        const result = await this.request<Descriptor>(`/api/playback-sessions/${session.id}`, undefined, "GET", controller.signal);
        failures = 0;
        if (accept(result)) this.timer = setTimeout(poll, typeof document !== "undefined" && document.hidden ? 2500 : 650);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (!current()) return;
        if (status && [401, 403, 404, 409, 410].includes(status) || ++failures >= 4) { failed(error); return; }
        this.timer = setTimeout(poll, Math.min(5000, 650 * 2 ** failures));
      }
    };
    try {
      const result = await this.request<Descriptor>(`/api/playback-sessions/${session.id}`, { subtitleTrackId: trackId, subtitleSelectionGeneration: generation, subtitleRetry: retry }, "PATCH", controller.signal);
      if (accept(result)) this.timer = setTimeout(poll, 650);
    } catch (error) { failed(error); }
  }
  unbind() { this.cancelPolling(); this.session = null; this.generation++; if (!this.disposed) this.publish(this.state(this.selected ? "queued" : "off")); }
  dispose() { this.disposed = true; this.unbind(); }
}
