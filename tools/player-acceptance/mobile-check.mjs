// Run: node tools/player-acceptance/mobile-check.mjs <local MP4>
// No requests reach a real LMD backend; all session responses are local stubs.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { launchBrowser, Session, delay } from "./cdp.mjs";

const port = Number(process.env.LMD_MOBILE_PORT || 8266), cdpPort = Number(process.env.LMD_CDP_PORT || 9366);
const scratch = path.resolve("data/mobile-acceptance");
await mkdir(scratch, { recursive: true });
assert(process.argv[2], "Supply a local test MP4; real media libraries are never modified");
await copyFile(process.argv[2], path.join(scratch, "sample.mp4"));
const sessionData = { sessionId: "fixture", generation: 1, strategy: "DIRECT", transport: "file", duration: 90, timeOffset: 0, sourceStart: 0, readyEnd: 90, requestedTime: 0, url: "/data/mobile-acceptance/sample.mp4", eof: true, state: "ready", error: null, heartbeatSeconds: 3600, buffer: {}, plan: { audio: null, video: { track: {} }, fallbackLevel: 0 } };
const fixtureMiddleware = (req, res, next) => {
  if (req.url === "/mobile-fixture") { res.setHeader("Content-Type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tools/player-acceptance/mobile-fixture.tsx"></script>'); return; }
  if (req.url?.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.url.endsWith("/info") ? { mediaId: "mobile-fixture", duration: 90, container: "mp4", tracks: [] } : sessionData)); return; }
  next();
};
const baseline = process.argv.includes("--baseline-css") ? execFileSync("git", ["show", "HEAD:src/player/player.css"], { encoding: "utf8" }) : null;
const server = await createServer({ configFile: false, plugins: [react(), { name: "mobile-fixture", enforce: "pre", transform(_code, id) { if (baseline && id.replaceAll("\\", "/").endsWith("/src/player/player.css")) return baseline; }, configureServer(server) { server.middlewares.use(fixtureMiddleware); } }], cacheDir: path.join(scratch, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, watch: null }, });
await server.listen();
if (process.argv.includes("--serve")) {
  console.log("Isolated player preview: http://127.0.0.1:8266/mobile-fixture (stub API; local test media only)");
  await new Promise(() => {});
}
const browser = await launchBrowser({ port: cdpPort, userDataDir: path.join(scratch, "chrome-profile") });
const cdp = await Session.connect(browser.wsUrl);
cdp.collect(); const results = [];
const click = async label => {
  const point = await cdp.evaluate(`(() => { const e=document.querySelector('button[aria-label="${label}"]');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  await delay(80);
};
try {
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  for (const [width, height, touch] of [[320,568,true],[360,800,true],[390,844,true],[412,915,true],[844,390,true],[1440,900,false]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: touch });
    await cdp.send("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    if (!touch) await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 })" });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/mobile-fixture` });
    await cdp.waitFor("document.querySelector('video')?.readyState >= 2");
    await cdp.evaluate("document.querySelector('video').pause();document.querySelector('video').currentTime=12");
    await delay(180);
    const geometry = await cdp.evaluate(`(() => {const stage=document.querySelector('.lmd-stage'),r=stage.getBoundingClientRect(),row=document.querySelector('.lmd-control-row');const nodes=[document.querySelector(".lmd-lock"),document.querySelector(".lmd-progress"),...row.children].filter(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width);return {rects:nodes.map(e=>({name:e.getAttribute("aria-label")||e.className,rect:e.getBoundingClientRect().toJSON()})),height:r.height,width:r.width,overflow:document.documentElement.scrollWidth>innerWidth, clipped:nodes.some(e=>{const b=e.getBoundingClientRect();return b.left<r.left||b.right>r.right}),overlap:nodes.some((e,i)=>nodes.slice(i+1).some(f=>{const a=e.getBoundingClientRect(),b=f.getBoundingClientRect();return Math.min(a.right,b.right)>Math.max(a.left,b.left)+1&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1}))};})()`);
    assert(!geometry.overflow && !geometry.clipped && !geometry.overlap, JSON.stringify(geometry));
    await cdp.screenshot(path.join(scratch, `${width}-controls.png`));
    await click("播放设置");
    const panel = await cdp.evaluate(`(() => {const p=document.querySelector('.lmd-settings-panel'),r=p.getBoundingClientRect();return {height:document.querySelector('.lmd-stage').getBoundingClientRect().height,time:document.querySelector('video').currentTime,modal:p.matches(':modal'),inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,text:p.textContent,overflow:p.scrollWidth>p.clientWidth};})()`);
    assert.equal(panel.height, geometry.height); assert(Math.abs(panel.time-12)<0.5); assert(panel.inside && !panel.overflow); assert.equal(panel.modal,touch);
    assert(touch ? panel.text.includes("右侧竖滑调节音量") && panel.text.includes("双击") && !panel.text.includes("左右键") : panel.text.includes("左右键"));
    await cdp.screenshot(path.join(scratch, `${width}-settings.png`));
    await cdp.evaluate("document.querySelector('.lmd-settings-panel').scrollTop=9999");
    assert(await cdp.evaluate("(()=>{const e=document.querySelector('button[aria-label=\"关闭设置\"]'),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===e})()"));
    await click("关闭设置");
    await click("播放");
    const playingTime = await cdp.evaluate("document.querySelector('video').currentTime");
    await click("播放设置"); await delay(350); await click("关闭设置");
    assert(await cdp.evaluate(`!document.querySelector('video').paused && document.querySelector('video').currentTime > ${playingTime}`));
    await click("暂停");
    await click("播放设置");
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await delay(100);
    assert(await cdp.evaluate("!document.querySelector('.lmd-settings-panel') && document.activeElement?.getAttribute('aria-label') === '播放设置'"));
    await click("字幕选择"); await click("关闭设置");
    await click("锁定播放器"); await click("解锁播放器");
    await click("全屏");
    await cdp.waitFor("!!document.fullscreenElement || !!document.querySelector('.is-page-fullscreen')");
    await click("播放设置");
    assert(await cdp.evaluate("document.querySelector('.lmd-settings-panel').open"));
    await click("关闭设置"); await click("退出全屏");
    results.push({ width, height, touch, geometry, panel: { ...panel, text: undefined }, passed: true });
    console.log(`PASS ${width}x${height}: bounds, overlap, stage stability, clock, settings/subtitles, lock, fullscreen, help`);
  }
  await writeFile(path.join(scratch,"results.json"), JSON.stringify(results,null,2));
} catch (error) { console.error(cdp.failures); console.error(await cdp.evaluate("document.body.innerText")); throw error; } finally { cdp.close(); browser.close(); await server.close(); }
