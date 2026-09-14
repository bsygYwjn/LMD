// Run: node tests/player-controls/run.mjs
// Set PLAYWRIGHT_MODULE to an installed playwright package entry if it is not local.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = await createServer({ configFile: false, cacheDir: "tests/player-controls/.cache", plugins: [
  { name: "control-test-core", enforce: "pre", resolveId(id, importer) { if (id === "./core" && importer?.replaceAll("\\", "/").endsWith("/src/player/Player.tsx")) return resolve("tests/player-controls/core.ts"); },
    load(id) { if (process.argv.includes("--baseline") && id.replaceAll("\\", "/").endsWith("/src/player/Player.tsx")) return execFileSync("git", ["show", "beaf824:src/player/Player.tsx"], { encoding: "utf8" }); },
    configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/api/")) return next(); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ items: [], sources: [], comments: [] })); }); },
  }, react(),
], server: { host: "127.0.0.1", port: 5185 } });
await server.listen();
if (process.argv.includes("--serve")) { console.log(`Isolated control fixture: ${server.resolvedUrls.local[0]}tests/player-controls/`); await new Promise(() => {}); }
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ json: { items: [], sources: [], comments: [] } }));
  await page.goto(`${server.resolvedUrls.local[0]}tests/player-controls/`);
  const stage = page.locator(".lmd-stage"), settings = page.getByRole("button", { name: "播放设置", exact: true });
  await settings.click();
  await page.locator(".lmd-settings-panel select").first().focus();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".lmd-settings-panel").count(), 0);
  assert.equal(await settings.evaluate(el => el === document.activeElement), true);
  console.log("PASS Escape closes panel from select and restores opener");
  await settings.click();
  const before = await page.evaluate(() => window.testCore.calls.pause);
  await page.locator(".lmd-settings-panel select").first().focus();
  await page.keyboard.press("m"); await page.keyboard.press(" ");
  assert.equal(await page.evaluate(() => window.testCore.calls.pause), before);
  assert.equal(await page.evaluate(() => window.testCore.state.muted), false);
  await page.keyboard.press("Escape");
  await page.keyboard.press(" ");
  assert.equal(await page.locator(".lmd-settings-panel").count(), 1);
  assert.equal(await page.evaluate(() => window.testCore.calls.pause), before);
  await page.keyboard.press("Escape");
  console.log("PASS form keys are isolated and Space activates focused settings button only");
  for (const tag of ["input", "textarea", "select", "div"]) {
    await stage.evaluate((el, tag) => { const input = document.createElement(tag); input.id = "editable-probe"; if (tag === "div") input.setAttribute("contenteditable", ""); el.append(input); input.focus(); }, tag);
    await page.keyboard.press("m"); await page.keyboard.press(" "); await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => window.testCore.state.muted), false);
    assert.equal(await page.evaluate(() => window.testCore.calls.pause), before);
    assert.deepEqual(await page.evaluate(() => window.testCore.calls.seek), []);
    await page.locator("#editable-probe").evaluate(el => el.remove());
  }
  console.log("PASS input/textarea/select/empty-contenteditable block player shortcuts outside panels");
  await stage.focus(); await page.keyboard.down(" "); await page.keyboard.down(" "); await page.keyboard.up(" ");
  assert.equal(await page.evaluate(() => window.testCore.calls.pause), before + 1);
  await page.keyboard.press(" ");
  await page.keyboard.down("m"); await page.keyboard.down("m"); await page.keyboard.up("m");
  assert.equal(await page.evaluate(() => window.testCore.state.muted), true);
  await page.keyboard.press("m");
  assert.equal(await page.evaluate(() => window.testCore.state.muted), false);
  await page.keyboard.down("ArrowLeft"); await page.keyboard.down("ArrowLeft"); await page.keyboard.down("ArrowLeft"); await page.keyboard.up("ArrowLeft");
  assert.deepEqual(await page.evaluate(() => window.testCore.calls.seek), [35]);
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await page.evaluate(() => window.testCore.calls.seek), [35, 40]);
  await page.keyboard.down("ArrowRight"); await page.waitForTimeout(500); await page.keyboard.up("ArrowRight");
  assert.equal(await page.evaluate(() => window.testCore.state.playbackRate), 1);
  assert.deepEqual(await page.evaluate(() => window.testCore.calls.seek), [35, 40]);
  console.log("PASS Space/M repeat suppression, left repeat coalescing, right seek/hold restore");
  await page.evaluate(() => { document.querySelector(".lmd-stage").requestFullscreen = () => Promise.reject(new Error("test page fullscreen fallback")); });
  await stage.focus(); await page.keyboard.down("f"); await page.keyboard.down("f"); await page.keyboard.up("f");
  assert.equal(await stage.evaluate(el => el.classList.contains("is-page-fullscreen")), true);
  await settings.click(); await page.keyboard.press("Escape");
  assert.equal(await stage.evaluate(el => el.classList.contains("is-page-fullscreen")), true);
  await page.keyboard.press("Escape");
  assert.equal(await stage.evaluate(el => el.classList.contains("is-page-fullscreen")), false);
  console.log("PASS F fallback fullscreen and panel → fullscreen Escape order");
  await page.getByRole("button", { name: "静音", exact: true }).click(); await page.mouse.move(1090, 790);
  await page.waitForTimeout(2800);
  assert.equal(await stage.evaluate(el => el.classList.contains("controls-visible")), false);
  await page.keyboard.press("Tab"); await page.waitForTimeout(2800);
  assert.equal(await stage.evaluate(el => el.classList.contains("controls-visible")), true);
  console.log("PASS pointer-focused button hides after idle; Tab reveals and preserves controls");
  assert.equal(await page.getByRole("button", { name: "下一集", exact: true }).count(), 1);
  for (const width of [320, 360, 390, 412]) { await page.setViewportSize({ width, height: 844 }); assert.equal(await page.getByRole("button", { name: "下一集", exact: true }).count(), 1); }
  await page.evaluate(() => { window.testCore.emit("ended"); window.testCore.emit("ended"); document.querySelector(".next-episode-button").click(); });
  assert.equal(await page.evaluate(() => window.nextCount), 1);
  assert.deepEqual(errors, []);
  console.log("PASS one episode entry and ended/click deduplication; no page errors");
} finally { await browser.close(); await server.close(); }

