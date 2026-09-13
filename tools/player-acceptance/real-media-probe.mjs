const base = "http://127.0.0.1:8096";
const catalog = await (await fetch(`${base}/api/catalog`)).json();
const sample = catalog.media.slice(0, 6).map(m => ({ id: m.id, file: m.fileName.slice(0, 60), codec: m.videoCodec, audio: m.audioCodec, depth: m.bitDepth, hdr: m.hdr }));
console.log("sample:", JSON.stringify(sample, null, 1));
const first = catalog.media[0];
const info = await (await fetch(`${base}/api/media/${first.id}/info`)).json();
console.log("info:", JSON.stringify({ container: info.container, duration: info.duration, tracks: info.tracks.map(t => `${t.type}/${t.codec}/${t.codecString}`) }, null, 1));
const body = JSON.stringify({ capabilities: { mse: true, nativeHls: false, h264: true, aac: true, direct: {}, tracks: {} }, startTime: 0 });
const started = Date.now();
const session = await (await fetch(`${base}/api/media/${first.id}/playback-sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).json();
console.log("session:", JSON.stringify({ strategy: session.strategy, video: session.plan?.video?.action, audio: session.plan?.audio?.action, transport: session.transport, duration: session.duration, timeOffset: session.timeOffset, readyEnd: session.readyEnd, encoder: session.encoder, error: session.error, ms: Date.now() - started }));
if (session.url) {
  const manifest = await (await fetch(`${base}${session.url}`)).text();
  console.log("manifest head:", manifest.split("\n").slice(0, 6).join(" | "));
  const init = await fetch(`${base}/api/playback-sessions/${session.sessionId}/init.mp4?generation=1`);
  console.log("init:", init.status, (await init.arrayBuffer()).byteLength, "bytes");
  const segment = await fetch(`${base}/api/playback-sessions/${session.sessionId}/0.m4s?generation=1`);
  console.log("segment:", segment.status, (await segment.arrayBuffer()).byteLength, "bytes");
  await fetch(`${base}/api/playback-sessions/${session.sessionId}`, { method: "DELETE" });
}
