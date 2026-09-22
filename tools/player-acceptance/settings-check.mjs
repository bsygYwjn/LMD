// Browser check for the admin settings surface added by the playback upgrade.
// Verifies the settings page renders the playback and danmaku cards and that the
// backend contract behind them saves, validates and restores values.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { delay } from "./cdp.mjs";
import { launchAcceptanceSession } from "./playwright-session.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.LMD_BASE_URL || "http://127.0.0.1:8096";
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const api = async (route, init) => {
  const response = await fetch(`${BASE}${route}`, { headers: { "Content-Type": "application/json" }, ...init });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function main() {
  const target = await api("/api/player-test/target");
  if (target.status !== 200 || target.body?.enabled !== true) {
    throw new Error("设置写入验收仅限 LMD_PLAYER_TEST=1 的隔离测试服务，请通过 LMD_BASE_URL 指定地址。");
  }
  const profile = path.join(here, "chrome-profile");
  await rm(profile, { recursive: true, force: true });
  // ---- API contract first (independent of rendering).
  const initial = await api("/api/settings/video-playback");
  record("读取播放设置", initial.status === 200 && initial.body?.settings?.cacheMaxBytes > 0, JSON.stringify(initial.body?.settings || {}).slice(0, 120));
  if (initial.status !== 200 || !initial.body?.settings) throw new Error("无法读取原始播放设置，停止写入验收。");
  try {
    const saved = await api("/api/settings/video-playback", { method: "PATCH", body: JSON.stringify({ aheadSeconds: 45, leaseSeconds: 60, heartbeatSeconds: 10 }) });
    record("保存播放设置", saved.status === 200 && saved.body.settings.aheadSeconds === 45 && saved.body.settings.leaseSeconds === 60, JSON.stringify(saved.body?.settings || {}).slice(0, 120));

    const invalid = await api("/api/settings/video-playback", { method: "PATCH", body: JSON.stringify({ leaseSeconds: 15, heartbeatSeconds: 30 }) });
    record("拒绝不合法的租约与心跳组合", invalid.status === 400, `${invalid.status} ${invalid.body?.error || ""}`);

    const outOfRange = await api("/api/settings/video-playback", { method: "PATCH", body: JSON.stringify({ aheadSeconds: 100000 }) });
    record("拒绝越界参数", outOfRange.status === 400, `${outOfRange.status} ${outOfRange.body?.error || ""}`);
  } finally {
    const restored = await api("/api/settings/video-playback", { method: "PATCH", body: JSON.stringify({ aheadSeconds: initial.body.settings.aheadSeconds, leaseSeconds: initial.body.settings.leaseSeconds, heartbeatSeconds: initial.body.settings.heartbeatSeconds }) });
    record("恢复原始播放设置", restored.status === 200 && restored.body.settings.aheadSeconds === initial.body.settings.aheadSeconds, JSON.stringify(restored.body?.settings || {}).slice(0, 120));
  }

  const danmakuInitial = await api("/api/settings/danmaku");
  record("读取弹幕凭证状态", danmakuInitial.status === 200 && typeof danmakuInitial.body.configured === "boolean", JSON.stringify(danmakuInitial.body));
  if (danmakuInitial.status !== 200 || typeof danmakuInitial.body?.configured !== "boolean") throw new Error("无法读取凭证状态，停止写入验收。");
  record("弹幕凭证读取不返回密钥", danmakuInitial.body && !("appSecret" in danmakuInitial.body) && !JSON.stringify(danmakuInitial.body).includes("secret"), JSON.stringify(danmakuInitial.body));

  // configured=false can still mean a stored secret exists without an appId.
  // Secrets cannot be read back for restoration. Keep browser checks read-only;
  // server/danmaku.test.mjs covers credential writes in a temporary directory.
  console.log("SKIP 弹幕凭证写入：由隔离临时目录的服务端测试覆盖，浏览器验收保留全部现有密钥。");

  // ---- Rendering.
  await mkdir(profile, { recursive: true });
  const { browser, session } = await launchAcceptanceSession({ port: 9334, userDataDir: profile });
  session.collect();
  await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Log.enable")]);
  try {
    await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await session.send("Page.navigate", { url: `${BASE}/admin` });
    await session.waitFor("document.querySelector('.admin-shell, .admin-layout, .client-page, #root')", { label: "管理页面", timeout: 25000 });
    await delay(1500);
    const nav = await session.evaluate(`(() => { const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find(button => (button.textContent || '').includes('运行设置')) || buttons.find(button => (button.textContent || '').includes('设置'));
      if (target) { target.click(); return true; } return false; })()`);
    record("管理页存在运行设置入口", nav === true);
    await delay(2500);
    const cards = await session.evaluate(`(() => ({
      playback: Boolean(document.querySelector('.playback-settings-card')),
      danmaku: Boolean(document.querySelector('.danmaku-settings-card')),
      playbackInputs: document.querySelectorAll('.playback-settings-card input').length,
      danmakuInputs: document.querySelectorAll('.danmaku-settings-card input').length,
      heading: document.querySelector('.playback-settings-card h2')?.textContent || '',
      danmakuHeading: document.querySelector('.danmaku-settings-card h2')?.textContent || '',
      values: [...document.querySelectorAll('.playback-settings-card input')].map(input => input.value),
    }))()`);
    record("运行设置渲染播放缓存与会话卡片", cards.playback && cards.playbackInputs >= 7, JSON.stringify({ inputs: cards.playbackInputs, heading: cards.heading, values: cards.values }));
    record("运行设置渲染弹幕凭证卡片", cards.danmaku && cards.danmakuInputs === 2, JSON.stringify({ inputs: cards.danmakuInputs, heading: cards.danmakuHeading }));
    record("无过时的自动完整副本描述", await session.evaluate(`(() => { const text = document.querySelector('.settings-grid')?.textContent || '';
      return !/自动生成完整兼容副本/.test(text); })()`));
    record("设置页无未捕获错误", session.failures.length === 0, session.failures.slice(0, 3).join(" | ").slice(0, 300));
  } finally {
    session.close(); await browser.close();
  }
  const failed = results.filter(item => !item.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error("设置页验收异常:", error); process.exitCode = 1; });
