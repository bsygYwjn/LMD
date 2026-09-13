import path from "node:path";
import { launchBrowser, Session, delay } from "./cdp.mjs";
const BASE = "http://127.0.0.1:8096";
const snapshot = async () => (await (await fetch(`${BASE}/api/settings/video-playback`)).json()).sessions;
const browser = await launchBrowser({ port: 9340, userDataDir: path.resolve("chrome-profile") });
const session = await Session.connect(browser.target.webSocketDebuggerUrl);
await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Network.enable")]);
let patches = 0;
session.on("Network.requestWillBeSent", ({ request }) => { if (request.method === "PATCH" && /playback-sessions/.test(request.url)) patches += 1; });
try {
  await session.send("Page.navigate", { url: BASE });
  await session.waitFor("document.querySelector('.mcard-hit')", { label: "cards", timeout: 30000 });
  for (let depth = 0; depth < 5; depth++) {
    if (await session.evaluate("Boolean(document.querySelector('.mcard-hit[aria-label^=\"播放 \"]'))")) { await session.evaluate("document.querySelector('.mcard-hit[aria-label^=\"播放 \"]').click()"); break; }
    await session.evaluate("document.querySelector('.mcard-hit[aria-label^=\"打开文件夹 \"]')?.click()"); await delay(1000);
  }
  await session.waitFor("document.querySelector('.lmd-stage video')", { label: "video", timeout: 30000 });
  await delay(5000);
  console.log("播放中:", JSON.stringify((await snapshot()).map(s => `${s.id} idle=${s.idleSeconds}`)));
  // A real exit from the player: drop the video parameter so the player page unmounts.
  await session.evaluate("(() => { const url = new URL(location.href); url.searchParams.delete('video'); history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); })()");
  await delay(1500);
  console.log("离开后 URL:", await session.evaluate("location.href"), "播放器还在:", await session.evaluate("Boolean(document.querySelector('.lmd-stage'))"));
  const after = patches;
  for (let step = 1; step <= 5; step++) {
    await delay(6000);
    console.log(`离开后 ${step * 6}s: 会话=${JSON.stringify((await snapshot()).map(s => `${s.id} idle=${s.idleSeconds}`))} 期间 PATCH=${patches - after}`);
  }
} finally { session.close(); browser.close(); }
