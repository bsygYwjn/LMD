// Isolated production-browser checks. Synthetic metadata measures DOM cost only,
// never source-disk throughput. No live service or user media is touched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const { chromium } = await import(process.env.LMD_PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.env.LMD_FRONTEND_DIST || path.join(root, "dist"));
const output = process.env.LMD_BROWSER_REPORT || path.join(root, "data/development-baselines/video-scan-20260927/frontend-browser.json");
await mkdir(path.dirname(output), { recursive: true });
let count = 100, revision = 1, active = false, phase = "idle", otherDelay = 0, catalogRequests = 0, polls = 0;
const thumbRequests = [];
const scan = () => ({ id: "fixture-task", enabled: false, scanning: active, phase, mode: "standard", pendingMode: null, canCancel: active, intervalSeconds: 30,
  discoveredFiles: count, indexedFiles: count, processedFiles: count, totalFiles: count, totalLibraries: 1, processedLibraries: 1, catalogRevision: revision, progressPercent: active ? null : 100 });
const media = (i) => ({ id: `v${i}`, title: `Video ${String(i).padStart(5, "0")}`, fileName: `Video ${String(i).padStart(5, "0")}.mp4`, extension: "MP4", size: 1024,
  sourceVersion: "fixture-v1", metadata: { state: "unknown" }, posterHue: 205, streamUrl: "/fixture/video.mp4", subtitles: [], fonts: [], tags: [],
  display: { groupId: "library", folderId: "library", configured: false, seriesTitle: `Video ${String(i).padStart(5, "0")}`, alias: `Video ${String(i).padStart(5, "0")}`, season: 1, episode: 1 } });
const folder = () => ({ id: "library", parentId: null, name: "Videos", title: "Videos", directMediaCount: count, mediaCount: count, childCount: 0, coverMediaId: null });
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const route = new URL(request.url, "http://fixture").pathname;
    const json = (value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
    if (route === "/api/auth/status") return json({ enabled: false, authenticated: true, user: null, canUpload: false });
    if (route === "/api/catalog") { catalogRequests++; return json({ catalogRevision: revision, media: Array.from({ length: count }, (_, i) => media(i)), groups: [], folders: [folder()], scan: scan() }); }
    if (route === "/api/video/scans/current") { polls++; return json({ taskId: "fixture-task", scan: scan() }); }
    if (route === "/api/video/scans") { active = true; phase = "discovering"; return json({ taskId: "fixture-task", scan: scan() }, 202); }
    if (route === "/api/video/scans/fixture-task/cancel") { active = false; phase = "cancelled"; return json({ stopped: true, scan: scan() }, 202); }
    if (/^\/api\/video\/media\/v\d+\/prepare$/.test(route)) { thumbRequests.push(route); return json({ media: { ...media(Number(route.match(/v(\d+)/)[1])), thumbnailUrl: "/fixture/thumbnail.svg" } }); }
    if (route === "/fixture/thumbnail.svg") { response.writeHead(200, { "Content-Type": "image/svg+xml" }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="112"><rect width="200" height="112" fill="#23384f"/></svg>'); return; }
    if (["/api/music/catalog", "/api/reading/catalog", "/api/photos/catalog"].includes(route)) { await delay(otherDelay); return json({ tracks: [], items: [], folders: [], scan: scan() }); }
    if (route.startsWith("/api/")) return json({ error: "Unknown fixture route" }, 404);
    const filename = path.resolve(dist, `.${route === "/" ? "/index.html" : route}`);
    if (!filename.startsWith(`${dist}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { "Content-Type": mime[path.extname(filename)] || "application/octet-stream" }); response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = { scope: "Synthetic metadata, production React build, real Chromium DOM. Excludes HDD throughput, video decoding and subtitle extraction.", measurements: [], checks: [] };
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.LMD_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { window.__longTasks = []; new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: "longtask", buffered: true }); });
  for (const size of [100, 1000, 10000]) for (let iteration = 0; iteration < 3; iteration++) {
    count = size; revision++; phase = "idle"; active = false;
    await page.goto(`${base}/?folder=library`, { waitUntil: "domcontentloaded" });
    thumbRequests.length = 0;
    await page.locator(".mcard").first().waitFor();
    const metrics = await page.evaluate(() => ({ renderedAtMs: performance.now(), cards: document.querySelectorAll(".mcard").length, domNodes: document.querySelectorAll("*").length, longTasks: window.__longTasks }));
    assert.ok(metrics.cards <= 120, "large directories cap rendered cards with accessible pagination");
    if (size === 10000) assert.ok(!thumbRequests.includes("/api/video/media/v9999/prepare"), "offscreen card must not request preparation before the filter makes it visible");
    const start = performance.now();
    await page.getByRole("searchbox", { name: "搜索文件夹或视频" }).fill(`Video ${String(size - 1).padStart(5, "0")}`);
    await page.waitForFunction(() => document.querySelectorAll(".mcard").length === 1);
    report.measurements.push({ size, iteration, ...metrics, filterInteractionMs: Math.round(performance.now() - start) });
  }
  count = 1000; revision++;
  await page.goto(`${base}/?folder=library`, { waitUntil: "domcontentloaded" });
  await page.getByRole("checkbox", { name: "选择下载 Video 00000.mp4", exact: true }).check();
  await page.getByRole("navigation", { name: "视频分页" }).first().getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择下载 Video 00120.mp4", exact: true }).waitFor();
  await page.getByRole("navigation", { name: "视频分页" }).first().getByRole("button", { name: "上一页", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "选择下载 Video 00000.mp4", exact: true }).isChecked(), true);
  report.checks.push("large-folder pagination keeps media accessible and preserves download selection between pages");
  count = 7; revision++; otherDelay = 2500;
  await page.goto(`${base}/?folder=library`, { waitUntil: "domcontentloaded" });
  await page.locator(".mcard").first().waitFor();
  assert.ok(await page.evaluate(() => performance.now()) < 2000, "video list must not wait for other media categories");
  report.checks.push("video independently rendered while other media API responses remain delayed");
  await page.getByRole("button", { name: "立即扫描并刷新文件", exact: true }).click();
  await page.getByText("正在发现视频文件", { exact: true }).waitFor();
  const before = catalogRequests; count = 8; revision++;
  await page.waitForFunction(() => document.querySelectorAll(".mcard").length === 8);
  assert.ok(catalogRequests > before, "active revision change publishes new video cards");
  await page.getByRole("button", { name: "取消本轮", exact: true }).click();
  await page.getByText("扫描已手动停止", { exact: true }).waitFor();
  await delay(1200);
  assert.equal(active, false);
  report.checks.push("202 begins polling immediately, revision updates visible list, standard scan cancellation retains terminal status");
  assert.ok(thumbRequests.length > 0, "visible cards request thumbnail preparation");
  // Narrow viewport keeps real counts and errors within the content area.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(path.dirname(output), "frontend-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, "mobile progress must not overflow horizontally");
  assert.deepEqual(errors, []);
  report.checks.push("mobile progress fits viewport and browser has no uncaught exceptions");
  report.polls = polls;
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
