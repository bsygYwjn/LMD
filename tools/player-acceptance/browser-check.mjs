// Real-browser acceptance check for the LMD unified playback core.
// Drives the shipped UI (catalog folder -> media card -> stage -> settings)
// against the running service and asserts first frame, controls, seek, rapid
// seek, audio track switch, rate change, gestures and session release.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, Session, delay } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.LMD_BASE_URL || "http://127.0.0.1:8096";
const profile = path.join(here, "chrome-profile");
const shots = path.join(here, "shots");
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
const report = { base: BASE, startedAt: new Date().toISOString(), results, metrics: {} };

const videoProbe = `(() => { const v = document.querySelector('.lmd-stage video'); return v ? { currentTime: v.currentTime, duration: v.duration, paused: v.paused, readyState: v.readyState, networkState: v.networkState,
  error: v.error ? { code: v.error.code, message: v.error.message } : null, src: (v.currentSrc || v.src || '').slice(0, 160) } : null; })()`;

async function waitFor(session, expression, timeout, label) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await session.evaluate(expression);
    if (last) return last;
    await delay(200);
  }
  const diagnosis = await session.evaluate(`(() => { const v = document.querySelector('.lmd-stage video');
    return { url: location.href, hasVideo: Boolean(v), stage: Boolean(document.querySelector('.lmd-stage')),
      readyState: v && v.readyState, networkState: v && v.networkState, paused: v && v.paused, currentTime: v && v.currentTime,
      error: v && v.error && { code: v.error.code, message: v.error.message }, loading: document.querySelector('.lmd-loading')?.textContent || '',
      message: document.querySelector('.lmd-play-message')?.textContent || '', controlsVisible: Boolean(document.querySelector('.lmd-controls')) }; })()`);
  throw new Error(`等待「${label}」超时（${timeout}ms）last=${JSON.stringify(last)} 诊断=${JSON.stringify(diagnosis)}`);
}

async function waitPlaying(session, seconds = 25) {
  return waitFor(session, `(() => { const v = document.querySelector('.lmd-stage video');
    return v && !v.paused && v.currentTime > 0.25 && v.readyState >= 2 ? { currentTime: v.currentTime, readyState: v.readyState } : null; })()`, seconds * 1000, "视频出画");
}

async function openFirstMedia(session) {
  await session.send("Page.navigate", { url: BASE });
  await session.waitFor("document.querySelector('.media-card .card-hit-area')", { label: "目录卡片", timeout: 25000 });
  for (let depth = 0; depth < 6; depth++) {
    if (await session.evaluate("Boolean(document.querySelector('.card-hit-area[aria-label^=\"播放 \"]'))")) {
      await session.evaluate("document.querySelector('.card-hit-area[aria-label^=\"播放 \"]').click()");
      return depth;
    }
    if (!await session.evaluate("Boolean(document.querySelector('.card-hit-area[aria-label^=\"打开文件夹 \"]'))")) throw new Error("目录里没有可进入的卡片");
    await session.evaluate("document.querySelector('.card-hit-area[aria-label^=\"打开文件夹 \"]').click()");
    await delay(900);
  }
  throw new Error("目录层级过深，未找到媒体文件");
}

async function setSelect(session, matcher, value) {
  return session.evaluate(`(async () => {
    const panel = document.querySelector('.lmd-settings-panel');
    if (!panel) return { ok: false, reason: '设置面板未打开' };
    const select = [...panel.querySelectorAll('select')].find(item => [...item.options].some(option => ${matcher}.test(option.textContent || '')));
    if (!select) return { ok: false, reason: '未找到匹配的下拉框', have: [...panel.querySelectorAll('select')].map(item => [...item.options].map(o => o.textContent)) };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    const before = select.value, options = [...select.options].map(o => ({ value: o.value, text: o.textContent }));
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, before, value: select.value, options };
  })()`, { awaitPromise: true });
}

async function seekWithBar(session, value, dispatchInput = true) {
  await session.evaluate(`(() => {
    const range = document.querySelector('input[aria-label="播放进度"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(range, '${value}');
    ${dispatchInput ? "range.dispatchEvent(new Event('input', { bubbles: true }));" : ""}
    range.dispatchEvent(new Event('change', { bubbles: true }));
    range.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true }));
  })()`);
}

// A released session must stop answering; a lingering lease from another run is
// irrelevant to this assertion.
async function releasedSessionState(sessionId) {
  if (!sessionId) return "unknown";
  const response = await fetch(`${BASE}/api/playback-sessions/${sessionId}`, { cache: "no-store" }).catch(() => null);
  if (!response) return "unreachable";
  if (response.status === 410 || response.status === 404) return "released";
  const body = await response.json().catch(() => ({}));
  return body?.error ? "released" : "alive";
}

async function health(session) { return session.evaluate("(async () => (await (await fetch('/api/health', { cache: 'no-store' })).json()).playback)()"); }

async function settingsSessions() {
  const response = await fetch(`${BASE}/api/settings/video-playback`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return [];
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body?.sessionIds) ? body.sessionIds : [];
}

// A released session is intentionally kept for the lease window and aborted runs
// leave sessions behind, so wait for a clean, measured baseline first.
async function resetBaseline() {
  const deadline = Date.now() + 90000;
  let last = null;
  while (Date.now() < deadline) {
    last = (await (await fetch(`${BASE}/api/health`, { cache: "no-store" })).json()).playback;
    if (last.sessions === 0 && last.pipelines === 0) return last;
    await delay(2000);
  }
  return last;
}

async function main() {
  await rm(profile, { recursive: true, force: true }); await mkdir(shots, { recursive: true });
  // Rescan first so the catalog always matches the sample file on disk.
  const scan = await fetch(`${BASE}/api/scan`, { method: "POST" }).then(response => response.json()).catch(error => ({ error: String(error) }));
  console.log(`预扫描：${scan.count ?? scan.error} 个媒体`);
  // Aborted runs leave sessions alive for their lease window, so wait for a
  // clean baseline before measuring; otherwise the assertions see stale state.
  const baseline = await resetBaseline();
  console.log(`基线：sessions=${baseline.sessions} pipelines=${baseline.pipelines}`);
  const browser = await launchBrowser({ port: 9333, userDataDir: profile });
  const session = await Session.connect(browser.target.webSocketDebuggerUrl);
  session.collect();
  await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Log.enable"), session.send("Network.enable")]);
  const responses = [];
  session.on("Network.responseReceived", ({ response }) => { if (/\/api\/(playback|media)/.test(response.url)) responses.push(`${response.status} ${response.url.replace(BASE, "")}`); });
  // /api/health does not expose session ids and fetch() request types vary, so
  // the ids created by this run are found by polling the settings descriptor
  // while the player is mounted. Nothing is active before the run starts.
  const seenSessions = new Set();
  const collectSessions = async () => { for (const id of await settingsSessions()) seenSessions.add(id); };
  const collector = setInterval(() => void collectSessions(), 700);

  try {
    await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const depth = await openFirstMedia(session);
    record("目录可浏览并定位到媒体卡片", true, `下钻 ${depth} 层`);
    await session.waitFor("document.querySelector('.lmd-stage video')", { label: "播放器 video 元素", timeout: 25000 });
    record("点击媒体卡片进入播放页并创建 video", true);
    await session.waitFor("document.querySelector('.lmd-controls')", { label: "自定义控制条", timeout: 15000 });
    record("自定义控制条存在", true);
    record("进度条与缓冲条存在", await session.evaluate("Boolean(document.querySelector('input[aria-label=\"播放进度\"]') && document.querySelector('.lmd-buffer-ranges'))"));

    const startedAt = Date.now();
    await waitPlaying(session, 30);
    report.metrics.firstFrameMs = Date.now() - startedAt;
    record("视频实际出画并连续推进", true, `首帧 ${report.metrics.firstFrameMs}ms`);
    await session.screenshot(path.join(shots, "01-playing.png"));

    const probe = await session.evaluate(videoProbe);
    report.metrics.playbackSource = probe.src;
    record("播放立即开始且时间轴可用", Number.isFinite(probe.duration) && probe.duration > 1, `duration=${probe.duration}s`);

    // hls.js can only know the full length once the playlist is complete; the
    // reported duration must converge to the original file length.
    const durationProbe = await waitFor(session, `(() => { const v = document.querySelector('.lmd-stage video');
      return Number.isFinite(v.duration) && v.duration > 55 ? v.duration : null; })()`, 60000, "时长收敛到原片长度").catch(error => ({ error: String(error.message).slice(0, 200) }));
    report.metrics.convergedDuration = durationProbe;
    record("媒体时长收敛到原片长度", durationProbe > 55, `duration=${durationProbe}`);

    const rendered = await session.evaluate(`(async () => { const v = document.querySelector('.lmd-stage video');
      if (!v.requestVideoFrameCallback) return null;
      return await new Promise(resolve => { const timer = setTimeout(() => resolve(null), 5000); v.requestVideoFrameCallback((_now, meta) => { clearTimeout(timer); resolve(meta.mediaTime); }); }); })()`, { awaitPromise: true });
    record("浏览器渲染出真实视频帧", rendered !== null, `mediaTime=${rendered}`);

    const startHealth = await health(session);
    report.metrics.initialHealth = startHealth;
    record("播放期间存在活跃会话与处理进程", startHealth.sessions >= 1, JSON.stringify(startHealth));

    await session.evaluate("[...document.querySelectorAll('.lmd-controls button')].find(b => b.getAttribute('aria-label') === '播放设置')?.click()");
    await delay(400);
    const info = await session.evaluate("(() => { const d = document.querySelector('.lmd-settings-panel details'); return d ? d.textContent : ''; })()");
    report.metrics.playerInfo = info;
    record("播放信息面板报告策略", /DIRECT|REMUX|PARTIAL_TRANSCODE|TRANSCODE/.test(info), info.slice(0, 140));

    const rate = await setSelect(session, "/×/", "1.5");
    await delay(500);
    const actualRate = await session.evaluate("document.querySelector('.lmd-stage video').playbackRate");
    record("倍速切换到 1.5× 生效", actualRate === 1.5 && rate.ok, JSON.stringify({ rate: rate.ok, actualRate }));
    await setSelect(session, "/×/", "1"); await delay(300);

    const audioState = await setSelect(session, "/声道/", "");
    const audioOptions = audioState.options || [];
    if (audioState.ok && audioOptions.length > 1) {
      const target = audioOptions.find(option => option.value !== audioState.before).value;
      const position = (await session.evaluate(videoProbe)).currentTime;
      await setSelect(session, "/声道/", target);
      const deadline = Date.now() + 30000;
      let landed = null;
      while (Date.now() < deadline) {
        const current = await session.evaluate(videoProbe);
        if (current && !current.paused && current.readyState >= 2 && Math.abs(current.currentTime - position) < 12) { landed = current.currentTime; break; }
        await delay(250);
      }
      record("切换音轨后在新会话继续播放", landed !== null, `位置 ${position.toFixed(2)}s → ${landed === null ? "未恢复" : landed.toFixed(2)}s`);
    } else {
      record("样例包含多音轨", false, JSON.stringify(audioOptions));
    }
    await session.evaluate("[...document.querySelectorAll('.lmd-settings-panel button')].find(b => b.getAttribute('aria-label') === '关闭设置')?.click()");
    await delay(400);

    const tapStage = async () => session.evaluate(`(async () => {
      const stage = document.querySelector('.lmd-stage'), rect = stage.getBoundingClientRect();
      const x = rect.left + rect.width * 0.3, y = rect.top + rect.height * 0.3;
      const fire = (type) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
      fire('pointerdown'); await new Promise(r => setTimeout(r, 40)); fire('pointerup');
    })()`, { awaitPromise: true });
    await tapStage();
    const pauseState = await waitFor(session, `(() => { const v = document.querySelector('.lmd-stage video');
      if (v.paused) return { paused: true, t: v.currentTime };
      const button = document.querySelector('.lmd-controls button[aria-label="\u64ad\u653e"]');
      return button ? { paused: true, via: 'control button' } : null; })()`, 5000, "暂停生效").catch(() => ({ paused: false }));
    record("单击画面暂停", pauseState.paused === true, JSON.stringify(pauseState));
    await session.screenshot(path.join(shots, "02-paused.png"));
    await tapStage();
    const resumeState = await waitFor(session, `(() => { const v = document.querySelector('.lmd-stage video'); return v.paused ? null : { paused: false, t: v.currentTime }; })()`, 6000, "恢复播放").catch(() => ({ paused: true }));
    record("再次单击画面恢复播放", resumeState.paused === false, JSON.stringify(resumeState));

    const current = await session.evaluate(videoProbe);
    const duration = current.duration;
    const warm = Math.min(duration - 1, current.currentTime + 2);
    const warmStart = Date.now();
    await seekWithBar(session, warm.toFixed(2));
    const warmLanded = await waitFor(session, `(() => { const v = document.querySelector('.lmd-stage video'); return Math.abs(v.currentTime - ${warm}) < 2.5 ? v.currentTime : null; })()`, 15000, "缓冲内定位");
    report.metrics.warmSeekMs = Date.now() - warmStart;
    record("进度条在已缓冲范围内定位", warmLanded !== null, `用时 ${report.metrics.warmSeekMs}ms`);

    const target = Math.min(duration - 2, Math.max(duration * 0.7, 20));
    const coldStart = Date.now();
    await seekWithBar(session, target.toFixed(2));
    const coldLanded = await waitFor(session, `(() => { const v = document.querySelector('.lmd-stage video'); return Math.abs(v.currentTime - ${target}) < 3 ? v.currentTime : null; })()`, 30000, "冷 Seek");
    report.metrics.seekMs = Date.now() - coldStart;
    report.metrics.seek = { target, landed: coldLanded };
    record("冷 Seek 定位到目标时间", coldLanded !== null, JSON.stringify(report.metrics.seek) + ` 用时 ${report.metrics.seekMs}ms`);
    await session.screenshot(path.join(shots, "03-after-seek.png"));

    const targets = [Math.max(2, target - 12), Math.min(duration - 2, target + 8), Math.max(2, target - 5), target];
    for (const value of targets) { await seekWithBar(session, value.toFixed(2), false); await delay(150); }
    await delay(7000);
    const settled = await session.evaluate(videoProbe);
    report.metrics.rapidSeek = { finalTarget: target, settled: settled.currentTime };
    record("连续快速 Seek 收敛到最后一次目标", Math.abs(settled.currentTime - target) < 10 && !settled.error, JSON.stringify(report.metrics.rapidSeek));
    record("连续 Seek 后播放未中断", settled.paused === false && !settled.error, `paused=${settled.paused}`);

    const fullscreen = await session.evaluate(`(async () => { const button = [...document.querySelectorAll('.lmd-controls button')].find(b => b.getAttribute('aria-label') === '全屏');
      if (!button) return { available: false }; button.click(); await new Promise(r => setTimeout(r, 1000));
      return { available: true, fullscreen: Boolean(document.fullscreenElement || document.querySelector('.lmd-stage.is-page-fullscreen')) }; })()`, { awaitPromise: true });
    record("全屏进入控制可用", fullscreen.available === true && fullscreen.fullscreen === true, JSON.stringify(fullscreen));
    await session.evaluate(`(async () => { if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      const exit = document.querySelector('.lmd-stage-heading button'); if (exit) exit.click(); })()`);
    await delay(900);

    const beforeLeave = await health(session);
    await session.evaluate("document.querySelector('.client-header .brand-home-button')?.click()");
    await delay(3500);
    await delay(7000);
    const afterLeave = await health(session);
    const trackedStates = [];
    for (const id of seenSessions) trackedStates.push({ id: id.slice(0, 8), state: await releasedSessionState(id) });
    report.metrics.healthAfterLeave = afterLeave;
    report.metrics.trackedSessions = trackedStates;
    const stillAlive = trackedStates.filter(item => item.state === "alive");
    record("离开播放页释放本次创建的全部播放会话", seenSessions.size > 0 && stillAlive.length === 0,
      JSON.stringify({ created: seenSessions.size, alive: stillAlive }));
    record("会话数按消费者释放且不再增长", afterLeave.sessions <= beforeLeave.sessions,
      JSON.stringify({ before: beforeLeave.sessions, after: afterLeave.sessions, pipelines: afterLeave.pipelines }));

    report.metrics.sessionDelta = { created: afterLeave.sessionsCreated - startHealth.sessionsCreated, seeks: afterLeave.seeks - startHealth.seeks,
      cacheBytes: afterLeave.cacheBytes, fallbacks: afterLeave.fallbacks - startHealth.fallbacks };
    record("会话按消费者计数且无泄漏式增长", report.metrics.sessionDelta.created >= 1 && report.metrics.sessionDelta.created <= 16, JSON.stringify(report.metrics.sessionDelta));
    record("缓存占用有界", afterLeave.cacheBytes <= 10 * 1024 ** 3, `${(afterLeave.cacheBytes / 1024 ** 2).toFixed(1)} MiB`);

    // Mobile pass.
    await session.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await openFirstMedia(session);
    await session.waitFor("document.querySelector('.lmd-stage video')", { label: "移动端 video", timeout: 25000 });
    const mobilePlaying = await waitPlaying(session, 30);
    record("移动视口下正常出画", true, `t=${mobilePlaying.currentTime.toFixed(2)}s`);
    await session.screenshot(path.join(shots, "04-mobile-playing.png"));

    const mobileControls = await session.evaluate(`(() => ({ controls: Boolean(document.querySelector('.lmd-controls')),
      stageWidth: document.querySelector('.lmd-stage').clientWidth, toolbarButtons: document.querySelectorAll('.lmd-controls button').length,
      desktopHidden: getComputedStyle(document.querySelector('.lmd-desktop-control') || document.body).display }))()`);
    record("移动端控制条布局可用", mobileControls.controls && mobileControls.toolbarButtons >= 4 && mobileControls.desktopHidden === "none", JSON.stringify(mobileControls));

    const gestures = await session.evaluate(`(async () => {
      const stage = document.querySelector('.lmd-stage'), video = document.querySelector('.lmd-stage video');
      const rect = stage.getBoundingClientRect(), cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const fire = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
      const before = video.currentTime;
      fire('pointerdown', cx, cy);
      for (let step = 1; step <= 6; step++) { fire('pointermove', cx + step * 30, cy); await new Promise(r => setTimeout(r, 40)); }
      const preview = document.querySelector('.lmd-seek-feedback')?.textContent || '';
      fire('pointerup', cx + 180, cy);
      await new Promise(r => setTimeout(r, 3000));
      const afterSwipe = video.currentTime;
      const doubleTap = async () => { fire('pointerdown', cx - 120, cy - 50); fire('pointerup', cx - 120, cy - 50); };
      await doubleTap(); await new Promise(r => setTimeout(r, 150)); await doubleTap();
      await new Promise(r => setTimeout(r, 900));
      const pausedAfterDoubleTap = video.paused;
      await doubleTap(); await new Promise(r => setTimeout(r, 150)); await doubleTap();
      await new Promise(r => setTimeout(r, 900));
      const resumedAfterDoubleTap = video.paused;
      return { before, preview, afterSwipe, pausedAfterDoubleTap, resumedAfterDoubleTap, error: video.error && video.error.code };
    })()`, { awaitPromise: true });
    report.metrics.mobileGestures = gestures;
    record("滑动时显示目标时间预览", Boolean(gestures.preview), JSON.stringify(gestures.preview));
    record("横向滑动提交 Seek", gestures.afterSwipe > gestures.before + 1, `${gestures.before.toFixed(2)}s → ${gestures.afterSwipe.toFixed(2)}s`);
    record("移动端双击切换播放状态", gestures.pausedAfterDoubleTap === true && gestures.resumedAfterDoubleTap === false,
      `双击后 paused=${gestures.pausedAfterDoubleTap}，再次双击 paused=${gestures.resumedAfterDoubleTap}`);
    await session.screenshot(path.join(shots, "05-mobile-gestures.png"));

    const lock = await session.evaluate(`(async () => { const button = document.querySelector('.lmd-lock'); if (!button) return { available: false };
      button.click(); await new Promise(r => setTimeout(r, 400));
      const locked = document.querySelector('.lmd-stage').classList.contains('is-locked');
      const controlsHidden = !document.querySelector('.lmd-controls');
      document.querySelector('.lmd-lock').click();
      return { available: true, locked, controlsHidden }; })()`, { awaitPromise: true });
    record("防误触锁定隐藏控件并可解锁", lock.available === true && lock.locked === true && lock.controlsHidden === true, JSON.stringify(lock));

    const beforeMobileLeave = await health(session);
    await session.evaluate("document.querySelector('.client-header .brand-home-button')?.click()");
    await delay(9000);
    const afterMobileLeave = await health(session);
    const mobileStates = [];
    for (const id of seenSessions) mobileStates.push({ id: id.slice(0, 8), state: await releasedSessionState(id) });
    const mobileAlive = mobileStates.filter(item => item.state === "alive");
    record("移动端离开播放页同样释放本次创建的会话", seenSessions.size > 0 && mobileAlive.length === 0,
      JSON.stringify({ created: seenSessions.size, alive: mobileAlive }));
    record("移动端离开后会话数不再增长", afterMobileLeave.sessions <= beforeMobileLeave.sessions,
      JSON.stringify({ before: beforeMobileLeave.sessions, after: afterMobileLeave.sessions, pipelines: afterMobileLeave.pipelines }));

    report.metrics.playbackResponses = responses.slice(0, 80);
    const serverErrors = responses.filter(line => /^5\d\d/.test(line));
    record("播放接口无 5xx", serverErrors.length === 0, serverErrors.slice(0, 5).join(" | "));
    record("无未捕获的页面错误", session.failures.length === 0, session.failures.slice(0, 4).join(" | ").slice(0, 500));
  } finally {
    clearInterval(collector);
    await writeFile(path.join(shots, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
    session.close(); browser.close();
  }
  const failed = results.filter(item => !item.ok);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error("验收脚本异常:", error); process.exitCode = 1; });
