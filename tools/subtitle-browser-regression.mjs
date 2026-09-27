// Real A/V and libass in an isolated service. Generated short MKV + real system
// font; transport delays below test stale responses, not extraction performance.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const { chromium } = await import(process.env.LMD_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "lmd-subtitle-browser-"));
const library = path.join(temporary, "Library"), data = path.join(temporary, "data");
const output = path.join(root, "data/development-baselines/video-scan-20260927");
await mkdir(library); await mkdir(output, { recursive: true });
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,32,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.00,0:00:59.00,Default,,0,0,0,,ALPHA DEFAULT\n`;
await writeFile(path.join(temporary, "a.ass"), ass);
await writeFile(path.join(temporary, "b.srt"), "1\n00:00:00,000 --> 00:00:59,000\nBETA SELECTED\n");
const ffmpeg = process.env.LMD_FFMPEG || path.join(root, "tools/ffmpeg/bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const font = process.env.LMD_TEST_FONT || (process.platform === "win32" ? "C:\\Windows\\Fonts\\arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=0x23384f:size=640x360:rate=24:duration=60", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=60",
    "-i", path.join(temporary, "a.ass"), "-i", path.join(temporary, "b.srt"), "-map", "0:v", "-map", "1:a", "-map", "2:0", "-map", "3:0", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "copy",
    "-metadata:s:s:0", "title=Alpha ASS", "-metadata:s:s:1", "title=Beta SRT", "-disposition:s:0", "default", "-disposition:s:1", "0", "-attach", font, "-metadata:s:t", "mimetype=application/x-truetype-font", "-metadata:s:t", "filename=arial.ttf", path.join(library, "Fixture.mkv")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr.on("data", chunk => { error += chunk; }); child.once("error", reject); child.once("close", code => code ? reject(new Error(error)) : resolve());
});
const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", LMD_PORT: String(port), LMD_DATA_DIR: data } });
let logs = "", browser, browserPage; child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
const request = async (route, body, method = body === undefined ? "GET" : "POST") => { const response = await fetch(base + route, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? undefined : { "Content-Type": "application/json" } }); const result = await response.json(); assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`); return result; };
const report = { sample: "generated 60s H.264/AAC MKV, default ASS + SRT + embedded original Arial bytes", checks: [], subtitleRequests: [], timings: {} };
try {
  for (let i = 0; ; i++) { try { await request("/api/health"); break; } catch (error) { if (i > 150 || child.exitCode !== null) throw new Error(logs || error.message); await delay(100); } }
  await request("/api/settings/auto-scan", { enabled: false }, "PATCH");
  await request("/api/libraries", { folderPath: library, name: "Subtitle fixture" }); await request("/api/scan", {});
  const catalog = await request("/api/catalog"), media = catalog.media[0]; assert.ok(media);
  const before = JSON.parse(await readFile(path.join(data, "state.json"), "utf8"));
  assert.ok(!(before.media[0].fonts || []).some(font => font.blobHash), "basic indexing creates no font contents");
  browser = await chromium.launch({ headless: true, executablePath: process.env.LMD_BROWSER_EXECUTABLE || undefined, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  browserPage = page;
  const errors = [], sessionIds = new Set(), loadedAssets = [];
  page.on("pageerror", error => errors.push(error.message));
  report.console = [];
  report.workers = []; report.assets = [];
  page.on("worker", worker => { void worker.evaluate(async () => { const errors = []; self.addEventListener("error", event => errors.push(event.message)); self.addEventListener("unhandledrejection", event => errors.push(String(event.reason))); await new Promise(resolve => setTimeout(resolve, 2000)); return { name: self.name, url: self.location.href, isolated: self.crossOriginIsolated, handler: String(self.onmessage).slice(0, 200), memory: self.WASMMEMORY?.buffer.byteLength, errors }; }).then(info => report.workers.push(info)).catch(() => {}); });
  page.context().on("response", response => { if (/\.wasm|worker|\/fonts\//.test(response.url())) report.assets.push([response.status(), response.url()]); });
  page.on("console", message => { if (["error", "warning"].includes(message.type())) report.console.push(message.text()); });
  page.on("requestfailed", req => report.console.push(`${req.url()} ${req.failure()?.errorText}`));
  page.context().on("request", req => { if (/\/(subtitles|fonts)\//.test(req.url())) loadedAssets.push(req.url()); });
  page.on("response", async response => { if (response.request().method() === "POST" && /\/playback-sessions$/.test(response.url())) { const session = await response.json().catch(() => null); if (session?.sessionId) sessionIds.add(session.sessionId); } });
  let selectionDelay = 1800, failNext = false;
  await page.route("**/api/playback-sessions/*", async route => {
    const req = route.request(), body = req.postDataJSON();
    if (req.method() !== "PATCH" || body?.subtitleTrackId === undefined) { await route.continue(); return; }
    report.subtitleRequests.push(body);
    if (failNext && body.subtitleTrackId) { failNext = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Fixture retry boundary", code: "SUBTITLE_TEST_FAILURE" }) }); return; }
    const response = await route.fetch();
    if (body.subtitleTrackId && selectionDelay) await delay(selectionDelay);
    await route.fulfill({ response }).catch(() => {});
  });
  const clickedAt = performance.now();
  await page.goto(`${base}/?video=${media.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const video = document.querySelector(".lmd-stage video"); return video && video.readyState >= 2 && !video.paused && video.currentTime > .1; }, null, { timeout: 20000 });
  report.timings.firstObservedPlayingMs = Math.round(performance.now() - clickedAt);
  assert.match(await page.locator(".lmd-subtitle-notice").innerText(), /字幕与所需字体正在准备/, "first frame starts independently while the subtitle response is deliberately held");
  await page.waitForFunction(() => !document.body.innerText.includes("字幕与所需字体正在准备"), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector(".lmd-ass-subtitles")?.width > 0);
  for (let i = 0; i < 60 && !loadedAssets.some(url => url.includes("/fonts/")); i++) await delay(150);
  await page.locator(".lmd-stage").screenshot({ path: path.join(output, "subtitle-ass-ready.png") });
  assert.ok(loadedAssets.some(url => url.includes("/fonts/")), "libass requests the media-authorized embedded font");
  report.checks.push("real audio/video starts while default ASS preparation response is pending; ASS/font resources load and screenshot is saved for visual QA");
  await page.locator(".lmd-stage").hover(); await page.getByRole("button", { name: "字幕选择", exact: true }).click();
  const select = page.getByRole("combobox", { name: /^字幕轨道/ });
  await select.waitFor();
  const options = await select.locator("option").evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent })));
  report.options = options;
  const alpha = options.find(option => option.text.includes("ASS")), beta = options.find(option => option.text.includes("SRT"));
  assert.ok(alpha && beta); assert.equal(await select.inputValue(), alpha.value);
  // A -> B -> off, with both obsolete successful replies still in flight.
  selectionDelay = 700;
  await select.selectOption(beta.value); await delay(60); await select.selectOption(alpha.value); await delay(60); await select.selectOption("off");
  const fetchesAtOff = loadedAssets.length; await delay(1000);
  assert.equal(await select.inputValue(), "off"); assert.equal(loadedAssets.length, fetchesAtOff, "late results cannot fetch or show obsolete subtitle resources");
  assert.equal(await page.locator(".lmd-text-subtitles").innerText(), "");
  report.checks.push("A→B→off ignores delayed successful responses and does not re-enable or fetch the old selection");
  selectionDelay = 0; failNext = true;
  await select.selectOption(beta.value); await page.getByRole("button", { name: "重试字幕准备", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".lmd-text-subtitles")?.textContent.includes("BETA SELECTED"));
  assert.equal(report.subtitleRequests.at(-1).subtitleRetry, true);
  report.checks.push("preparation failure offers retry and SRT joins the current timeline after retry");
  await page.getByLabel("延后秒数", { exact: true }).fill("0.7");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.getByLabel("播放进度", { exact: true }).evaluate(input => { input.value = "20"; input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="播放进度"]')?.value) >= 19.9);
  assert.equal(await page.locator(".lmd-text-subtitles").innerText(), "BETA SELECTED");
  const requestsBeforeSeek = report.subtitleRequests.length; await delay(300); assert.equal(report.subtitleRequests.length, requestsBeforeSeek, "seek reuses prepared subtitle resources");
  report.checks.push("seek keeps original subtitle timeline and offset without re-extracting the track");
  await page.locator(".lmd-stage").hover(); await page.getByRole("button", { name: "字幕选择", exact: true }).click();
  selectionDelay = 900; await select.selectOption(alpha.value); await delay(60);
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" }); await delay(1200);
  assert.equal(await page.locator(".lmd-stage").count(), 0);
  for (const id of sessionIds) { const response = await fetch(`${base}/api/playback-sessions/${id}`); assert.ok([404, 410].includes(response.status), `released session must be unavailable: ${response.status}`); }
  report.checks.push("leaving the player releases its session consumer; late preparation cannot remount subtitles");
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "subtitle-browser.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { const diagnosis = await browserPage?.evaluate(() => ({ text: document.body.innerText, select: [...document.querySelectorAll("select")].map(select => ({ value: select.value, options: select.textContent })) })).catch(() => null); await writeFile(path.join(output, "subtitle-browser-failure.log"), `${error.stack}\n${logs}\n${JSON.stringify({ report, diagnosis, info: await request('/api/catalog').catch(() => null) }, null, 2)}`); throw error; }
finally {
  await browser?.close();
  await fetch(`${base}/api/service/stop`, { method: "POST" }).catch(() => {});
  if (child.exitCode === null) await new Promise(resolve => { child.once("exit", resolve); setTimeout(() => { child.kill(); resolve(); }, 5000).unref(); });
  assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(temporary).startsWith("lmd-subtitle-browser-"));
  await rm(temporary, { recursive: true, force: true });
}
