type Entry = { priority: number; handlers?: Partial<Record<MediaSessionAction, MediaSessionActionHandler>>; metadata?: MediaMetadata | null;
  playbackState?: MediaSessionPlaybackState; position?: MediaPositionState };
const entries = new Map<string, Entry>();
const actions: MediaSessionAction[] = ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"];
function publish() {
  if (!("mediaSession" in navigator)) return;
  const owner = [...entries.values()].sort((a, b) => b.priority - a.priority)[0];
  for (const action of actions) { try { navigator.mediaSession.setActionHandler(action, owner?.handlers?.[action] || null); } catch {} }
  navigator.mediaSession.metadata = owner?.metadata || null;
  navigator.mediaSession.playbackState = owner?.playbackState || "none";
  try { navigator.mediaSession.setPositionState(owner?.position); } catch {}
}
export function updateMediaSession(id: string, patch: Partial<Entry>) { entries.set(id, { priority: 0, ...entries.get(id), ...patch }); publish(); }
export function releaseMediaSession(id: string) { entries.delete(id); publish(); }
