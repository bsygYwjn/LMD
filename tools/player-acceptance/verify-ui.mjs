import path from "node:path";
import { launchBrowser, Session, delay } from "./cdp.mjs";
const here = path.resolve("tools/player-acceptance");
const BASE = "http://127.0.0.1:8096";
const browser = await launchBrowser({ port: 9337, userDataDir: path.join(here, "chrome-profile") });
const session = await Session.connect(browser.target.webSocketDebuggerUrl);
session.collect();
await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Log.enable")]);
try {
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await session.send("Page.navigate", { url: BASE });
  await session.waitFor("document.querySelector('.card-hit-area')", { label: "cards", timeout: 30000 });
  for (let depth = 0; depth < 5; depth++) {
    if (await session.evaluate("Boolean(document.querySelector('.card-hit-area[aria-label^=\"播放 \"]'))")) {
      await session.evaluate("document.querySelector('.card-hit-area[aria-label^=\"播放 \"]').click()"); break;
    }
    await session.evaluate("document.querySelector('.card-hit-area[aria-label^=\"打开文件夹 \"]')?.click()"); await delay(1000);
  }
  await session.waitFor("document.querySelector('.lmd-stage video')", { label: "video", timeout: 30000 });
  await delay(6000);
  // Force the control bar visible by moving the mouse over the stage.
  await session.evaluate(`(() => { const stage = document.querySelector('.lmd-stage'); const rect = stage.getBoundingClientRect();
    stage.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 20, clientY: rect.top + 20 })); })()`);
  await delay(800);
  await session.screenshot(path.join(here, "shots", "verify-controls.png"));
  // Open the settings panel so every feature entry is visible at once.
  await session.evaluate(`[...document.querySelectorAll('.lmd-controls button')].find(b => b.getAttribute('aria-label') === '播放设置')?.click()`);
  await delay(600);
  const panel = await session.evaluate(`(() => { const p = document.querySelector('.lmd-settings-panel');
    return { open: Boolean(p), fields: [...(p?.querySelectorAll('label') || [])].map(l => l.textContent.split('\\n')[0].slice(0, 22)),
      buttons: [...(p?.querySelectorAll('button') || [])].map(b => b.textContent.slice(0, 18)), info: p?.querySelector('details')?.textContent?.slice(0, 150) }; })()`);
  await session.screenshot(path.join(here, "shots", "verify-settings.png"));
  console.log("settings panel:", JSON.stringify(panel, null, 1));
  const state = await session.evaluate(`(() => { const v = document.querySelector('.lmd-stage video');
    return { paused: v.paused, currentTime: +v.currentTime.toFixed(2), duration: v.duration, readyState: v.readyState, error: v.error && v.error.code, src: v.currentSrc.slice(0, 40) }; })()`);
  console.log("video:", JSON.stringify(state));
  console.log("page errors:", session.failures.length ? session.failures.slice(0, 3) : "none");
} finally { session.close(); browser.close(); }
