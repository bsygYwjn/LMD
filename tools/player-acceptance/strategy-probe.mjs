const base = "http://127.0.0.1:8096";
const catalog = await (await fetch(`${base}/api/catalog`)).json();
for (const media of catalog.media.slice(0, 3)) {
  const info = await (await fetch(`${base}/api/media/${media.id}/info`)).json();
  for (const plan of [{ name: "空能力（保守客户端）", caps: { mse: true, nativeHls: false, h264: true, aac: true, direct: {}, tracks: {} } },
                      { name: "Chrome 真实能力", caps: { mse: true, nativeHls: false, h264: true, aac: true,
                        direct: Object.fromEntries(info.tracks.filter(t => t.type === "video").flatMap(v => (info.tracks.filter(a => a.type === "audio").length ? info.tracks.filter(a => a.type === "audio") : [null]).map(a => [`${v.id}:${a?.id || "none"}`, true]))),
                        tracks: Object.fromEntries(info.tracks.map(t => [t.id, { mse: true, file: true, smooth: true, powerEfficient: true }])) } }]) {
    const body = JSON.stringify({ capabilities: plan.caps, startTime: 0 });
    const response = await fetch(`${base}/api/media/${media.id}/playback-sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const session = await response.json();
    console.log(`${media.fileName.slice(0, 40)} | ${media.videoCodec}/${media.audioCodec} | ${plan.name} -> ${session.strategy || response.status} (V:${session.plan?.video?.action} A:${session.plan?.audio?.action})`);
    if (session.sessionId) await fetch(`${base}/api/playback-sessions/${session.sessionId}`, { method: "DELETE" });
  }
}
