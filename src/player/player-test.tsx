// Real-browser acceptance harness for the unified playback core.
//
// Open the site with `?playerTest=1` to run the suite in the actual browser.
// Every assertion below drives the shipped UI (catalog card, stage, control
// bar, settings panel) instead of calling internals, so a pass means the
// product path works, not just the transport.
import { useEffect, useState } from "react";
import type { PlayerMedia } from "./Player";

type Check = { name: string; ok: boolean; detail?: string };

const results: Check[] = [];
const log: string[] = [];
const metrics: Record<string, unknown> = {};
let running = false;
let done = false;
let notify: (() => void) | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  log.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
  notify?.();
};
const note = (message: string) => { log.push(message); notify?.(); };

function video(): HTMLVideoElement | null { return document.querySelector<HTMLVideoElement>(".lmd-stage video"); }
function button(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>(".lmd-stage button")]
    .find(item => item.getAttribute("aria-label") === label) ?? null;
}
function selectByOption(pattern: RegExp): HTMLSelectElement | null {
  return [...document.querySelectorAll<HTMLSelectElement>(".lmd-settings-panel select")]
    .find(item => [...item.options].some(option => pattern.test(option.textContent || ""))) ?? null;
}
function setNativeValue(element: HTMLElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
}
async function waitFor<T>(probe: () => T | null | undefined | false, timeout: number, label: string): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value as T;
    last = value; await sleep(120);
  }
  throw new Error(`等待「${label}」超时（${timeout}ms）last=${JSON.stringify(last)}`);
}
async function waitPlaying(seconds = 25) {
  return waitFor(() => {
    const element = video();
    return element && !element.paused && element.currentTime > 0.25 && element.readyState >= 2 ? { currentTime: element.currentTime, readyState: element.readyState } : null;
  }, seconds * 1000, "视频出画并推进");
}
function seekTo(value: number) {
  const range = document.querySelector<HTMLInputElement>('input[aria-label="播放进度"]')!;
  setNativeValue(range, String(value));
  range.dispatchEvent(new Event("input", { bubbles: true }));
  range.dispatchEvent(new Event("change", { bubbles: true }));
  range.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));
}
function seekLocally(value: number) {
  const range = document.querySelector<HTMLInputElement>('input[aria-label="播放进度"]')!;
  setNativeValue(range, String(value));
  range.dispatchEvent(new Event("change", { bubbles: true }));
}
function tap(element: Element, options: PointerEventInit = {}) {
  const rect = element.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, pointerId: options.pointerId ?? 1, isPrimary: true,
    clientX: options.clientX ?? rect.left + rect.width / 2, clientY: options.clientY ?? rect.top + rect.height / 2, pointerType: options.pointerType ?? "touch" };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...options }));
  element.dispatchEvent(new PointerEvent("pointermove", { ...base, ...options }));
  element.dispatchEvent(new PointerEvent("pointerup", { ...base, ...options }));
}
const health = async () => (await (await fetch("/api/health", { cache: "no-store" })).json()).playback as
  { sessions: number; pipelines: number; cacheBytes: number; sessionsCreated: number; seeks: number; fallbacks: number; bytesGenerated: number };

async function runChecks(media: PlayerMedia) {
  const desktop = window.innerWidth >= 900;
  note(`开始自检：${media.title}（${desktop ? "桌面" : "移动"}视口 ${window.innerWidth}×${window.innerHeight}）`);

  // 1. 目录与进入播放页
  const hit = await waitFor(() => document.querySelector<HTMLElement>(`.media-card .card-hit-area[aria-label="播放 ${media.title}"]`)
    || document.querySelector<HTMLElement>(".media-card .card-hit-area"), 20000, "媒体卡片");
  check("目录显示媒体卡片", true);
  hit.click();
  await waitFor(() => document.querySelector(".lmd-stage video"), 20000, "播放页 video 元素");
  check("点击卡片进入播放页并创建 video", true);

  const startedAt = performance.now();
  const first = await waitPlaying(desktop ? 25 : 35);
  metrics.firstFrameMs = Math.round(performance.now() - startedAt);
  check("视频实际出画并连续推进", true, `t=${first.currentTime.toFixed(2)}s readyState=${first.readyState} 首帧 ${metrics.firstFrameMs}ms`);

  const rendered = await new Promise<number | null>(resolve => {
    const element = video();
    if (!element?.requestVideoFrameCallback) return resolve(null);
    const timer = setTimeout(() => resolve(null), 4000);
    element.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(Math.round(performance.now() - startedAt)); });
  });
  metrics.firstRenderedFrameMs = rendered;
  check("浏览器已渲染真实视频帧", rendered !== null, rendered === null ? "该浏览器不支持 requestVideoFrameCallback" : `${rendered}ms`);

  const initial = await health();
  metrics.healthDuringPlayback = initial;
  check("播放期间存在活跃会话", initial.sessions >= 1, JSON.stringify(initial));
  check("DIRECT/REMUX 已创建处理管线或使用原文件", initial.sessionsCreated >= 1, `sessionsCreated=${initial.sessionsCreated}`);

  // 2. 控制条存在性
  check("自定义控制条存在", Boolean(document.querySelector(".lmd-controls")));
  check("进度条、缓冲条存在", Boolean(document.querySelector('input[aria-label="播放进度"]') && document.querySelector(".lmd-buffer-ranges")));

  // 3. 暂停与恢复
  video()!.click();
  await sleep(400);
  check("单击画面暂停", video()!.paused === true);
  video()!.click();
  await sleep(900);
  check("再次单击画面恢复播放", video()!.paused === false);

  // 4. 直接 Seek（命中缓冲）
  const duration = await waitFor(() => { const value = video()?.duration; return value && Number.isFinite(value) && value > 5 ? value : null; }, 8000, "媒体时长");
  metrics.duration = duration;
  const nearStart = Math.min(duration - 1, video()!.currentTime + 2);
  const t0 = performance.now();
  seekTo(nearStart);
  await waitFor(() => { const element = video()!; return Math.abs(element.currentTime - nearStart) < 2.5 ? true : null; }, 8000, "缓冲内定位");
  metrics.bufferedSeekMs = Math.round(performance.now() - t0);
  check("进度条在已缓冲范围内定位", true, `${metrics.bufferedSeekMs}ms`);

  // 5. 冷 Seek 与时间轴映射
  const target = Math.min(duration - 2, Math.max(duration * 0.6, 12));
  const t1 = performance.now();
  seekTo(target);
  const landedTime = await waitFor(() => {
    const element = video()!;
    return Math.abs(element.currentTime - target) < 3 ? element.currentTime : null;
  }, 25000, "冷 Seek 生效");
  metrics.seekMs = Math.round(performance.now() - t1);
  metrics.seekTarget = target; metrics.seekLanded = landedTime;
  check("冷 Seek 定位到目标时间", true, `目标 ${target.toFixed(2)}s 落点 ${landedTime.toFixed(2)}s 用时 ${metrics.seekMs}ms`);
  check("Seek 后仍在推进", await waitPlaying(12).then(() => true, () => false));

  // 6. 连续快速 Seek：只有最后一次生效
  const targets = [Math.max(2, target - 8), Math.min(duration - 2, target + 6), Math.max(2, target - 4), target];
  for (const value of targets) { seekLocally(value); await sleep(140); }
  const finalTarget = targets.at(-1)!;
  const landed = await waitFor(() => { const value = video()!.currentTime; return Math.abs(value - finalTarget) < 3 ? value : null; }, 25000, "最后一次 Seek 生效");
  await sleep(4500);
  const settled = video()!.currentTime;
  metrics.rapidSeek = { finalTarget, landed, settled };
  check("连续快速 Seek 只接受最后一次结果", Math.abs(settled - finalTarget) < 6, JSON.stringify(metrics.rapidSeek));
  check("连续 Seek 后播放未中断", video()!.paused === false && !video()!.error);

  // 7. 倍速与音量
  button("播放设置")?.click();
  await sleep(250);
  const rateSelect = selectByOption(/×/);
  if (rateSelect) { setNativeValue(rateSelect, "1.5"); rateSelect.dispatchEvent(new Event("change", { bubbles: true })); await sleep(300); }
  check("倍速切换到 1.5×", video()!.playbackRate === 1.5, `playbackRate=${video()!.playbackRate}`);
  if (rateSelect) { setNativeValue(rateSelect, "1"); rateSelect.dispatchEvent(new Event("change", { bubbles: true })); await sleep(200); }

  // 8. 音轨切换（多音轨样例）
  const audioSelect = selectByOption(/声道/);
  if (audioSelect && audioSelect.options.length > 1) {
    const before = audioSelect.value, next = [...audioSelect.options].map(option => option.value).find(value => value !== before)!;
    const position = video()!.currentTime;
    setNativeValue(audioSelect, next); audioSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const resumed = await waitFor(() => { const element = video()!; return !element.paused && Math.abs(element.currentTime - position) < 8 && element.readyState >= 2 ? element.currentTime : null; }, 30000, "切轨后继续播放");
    check("切换音轨后在新会话继续播放", true, `位置 ${position.toFixed(2)}s → ${resumed.toFixed(2)}s`);
  } else {
    check("样例包含多音轨（用于切轨验收）", false, audioSelect ? `仅 ${audioSelect.options.length} 个音轨` : "未找到音轨选择");
  }
  button("关闭设置")?.click();

  // 9. 离开播放页释放资源
  const beforeLeave = await health();
  // 复用既有结构化导航（品牌按钮回到目录），不新增返回按钮。
  document.querySelector<HTMLElement>(".client-header .brand-home-button")?.click();
  await waitFor(() => (document.querySelector(".lmd-stage") ? null : true), 8000, "返回目录").catch(() => {});
  await sleep(2200);
  const afterLeave = await health();
  metrics.healthAfterLeave = afterLeave;
  check("离开播放页释放会话与处理进程", afterLeave.sessions === 0 && afterLeave.pipelines === 0, JSON.stringify({ before: beforeLeave.sessions, after: afterLeave.sessions }));

  const created = afterLeave.sessionsCreated - initial.sessionsCreated;
  const seeks = afterLeave.seeks - initial.seeks;
  metrics.sessionDelta = { created, seeks };
  check("每个消费者独立建立会话（无泄漏式增长）", created >= 1 && created <= 12, `新增会话 ${created}`);
  check("缓存占用受容量约束", afterLeave.cacheBytes <= 10 * 1024 ** 3, `${(afterLeave.cacheBytes / 1024 ** 2).toFixed(1)} MiB`);
}

export function playerTestRequested() {
  try { return new URLSearchParams(window.location.search).get("playerTest") === "1"; } catch { return false; }
}

/** Mounts the harness panel and drives the real UI once media is mounted. */
export function PlayerTestPanel({ media }: { media: PlayerMedia | null }) {
  const [, force] = useState(0);
  useEffect(() => { notify = () => force(value => value + 1); return () => { notify = null; }; }, []);
  useEffect(() => {
    if (running || done || !media) return;
    running = true; notify?.();
    runChecks(media).catch(error => check("自检执行完成", false, String(error?.message || error)))
      .finally(async () => {
        running = false; done = true; notify?.();
        try {
          const response = await fetch("/api/player-test/report", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userAgent: navigator.userAgent, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), results, metrics }) });
          const data = await response.json();
          log.push(response.ok ? `报告已写入服务器：失败 ${data.summary?.failed ?? "?"} 项` : `报告写入失败：${data.error || response.status}`);
        } catch (error) { log.push(`报告写入失败：${String((error as Error)?.message || error)}`); }
        notify?.();
      });
  }, [media]);
  const failed = results.filter(item => !item.ok).length;
  return <div className={`lmd-selftest${done ? " is-done" : ""}${failed ? " has-failure" : ""}`} role="status">
    <header><strong>播放核心自检{media ? ` · ${media.title}` : ""}</strong><span>{done ? (failed ? `${failed} 项未通过` : "全部通过") : running ? "进行中…" : "等待媒体"}</span></header>
    <ol>{results.map((item, index) => <li key={index} className={item.ok ? "ok" : "bad"}><b>{item.ok ? "PASS" : "FAIL"}</b> {item.name}{item.detail ? <em>{item.detail}</em> : null}</li>)}</ol>
    <details open={!done}><summary>过程日志</summary><pre>{log.join("\n")}</pre></details>
    <details><summary>测量数据</summary><pre>{JSON.stringify(metrics, null, 2)}</pre></details>
  </div>;
}
