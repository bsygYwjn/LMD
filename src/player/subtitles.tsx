import { useEffect, useRef, useState } from "react";
import JASSUB from "jassub";
import workerUrl from "jassub/dist/worker/worker.js?worker&url";
import wasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import modernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import { PlaybackCore, api } from "./core";
import { assToWebVtt } from "./subtitle-text";
import { assRendererFailureMessage, bitmapPaintPlan, type BitmapCue } from "./subtitle-rendering";

export type Subtitle = { id: string; name: string; format: string; language: string; url: string; size?: number; modifiedAt?: string };
export type FontAsset = { id: string; name: string; url: string; aliases?: string[]; modifiedAt?: string; size?: number };
type Cue = { start: number; end: number; text: string };
type BitmapWindow = { cues: BitmapCue[]; canvas?: { width: number; height: number }; width: number; height: number; total: number };

const seconds = (value: string) => value.replace(",", ".").split(":").reduce((total, part) => total * 60 + Number(part), 0);
function parseText(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n"), index = lines.findIndex(line => line.includes(" --> "));
    if (index < 0) continue;
    const match = /((?:\d+:)?\d+:\d+[.,]\d+)\s+-->\s+((?:\d+:)?\d+:\d+[.,]\d+)/.exec(lines[index]);
    if (!match) continue;
    const start = seconds(match[1]), end = seconds(match[2]);
    const text = lines.slice(index + 1).join("\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
    if (Number.isFinite(start) && end > start && text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function stopAssRenderer(worker: JASSUB | null) {
  if (!worker) return;
  worker._destroyed = true;
  worker._removeListeners();
  worker._worker.terminate();
}

export function SubtitleOverlay({ core, subtitle, fonts, delay, mode, fallbackReason, onFallback, report }: {
  core: PlaybackCore; subtitle?: Subtitle; fonts: FontAsset[]; delay: number; mode: "styled" | "text";
  fallbackReason: string; onFallback: (message: string) => void; report: (message: string) => void;
}) {
  const renderer = useRef<JASSUB | null>(null), delayRef = useRef(delay), assCanvas = useRef<HTMLCanvasElement>(null), bitmapCanvas = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState(""); delayRef.current = delay;
  const key = `${subtitle?.id}:${subtitle?.url}:${subtitle?.modifiedAt}:${subtitle?.size}:${mode}:${fonts.map(f => `${f.id}:${f.modifiedAt}:${f.size}`).join("|")}`;
  useEffect(() => {
    if (renderer.current) { renderer.current.timeOffset = core.getState().timeOffset - delay; void renderer.current.resize(true).catch(() => {}); }
  }, [delay, core]);
  useEffect(() => {
    const controller = new AbortController(); let active = true, frame = 0, worker: JASSUB | null = null;
    let unsubscribe = () => {}, bitmapGeneration = 0, cleanupBitmapPictures = () => {};
    const bitmapControllers = new Map<number, AbortController>();
    setText(""); report("");
    const ass = subtitle && ["ASS", "SSA"].includes(subtitle.format.toUpperCase());

    const startTextRenderer = (content: string, isAss: boolean, notice = "") => {
      const cues = parseText(isAss ? assToWebVtt(content) : content);
      if (isAss) report(notice ? `${notice}，已自动切换为纯文本；字体、定位和动画会降级` : "纯文本模式：ASS 的字体、定位和动画已降级");
      let lastText = "", last = 0;
      const tick = (now: number) => {
        if (!active) return;
        if (now - last > 60) {
          last = now; const time = core.currentTime - delayRef.current;
          let low = 0, high = cues.length;
          while (low < high) { const mid = (low + high) >>> 1; if (cues[mid].start <= time) low = mid + 1; else high = mid; }
          const texts: string[] = [];
          for (let i = low - 1; i >= 0 && cues[i].start >= time - 3600; i--) if (cues[i].end > time) texts.unshift(cues[i].text);
          const value = texts.join("\n"); if (value !== lastText) { lastText = value; setText(value); }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    void (async () => {
      if (!subtitle) return;
      try {
        if (["PGS", "VOBSUB", "DVB", "DVD_SUBTITLE", "HDMV_PGS_SUBTITLE", "DVB_SUBTITLE"].includes(subtitle.format.toUpperCase())) {
          const windows = new Map<number, BitmapWindow>(), pictures = new Map<string, HTMLImageElement>();
          let currentWindow = -1, previousPaint = "\0", lastCheck = 0;
          const clearPictures = () => { for (const picture of pictures.values()) picture.src = ""; pictures.clear(); };
          cleanupBitmapPictures = clearPictures;
          const pictureFor = (url: string) => {
            let picture = pictures.get(url);
            if (!picture) {
              picture = new Image(); picture.decoding = "async";
              picture.onload = () => { previousPaint = "\0"; };
              picture.onerror = () => { pictures.delete(url); if (active) report("部分字幕位图加载失败"); };
              picture.src = url; pictures.set(url, picture);
              if (pictures.size > 24) {
                const oldest = pictures.keys().next().value as string;
                if (oldest !== url) { const dropped = pictures.get(oldest); if (dropped) dropped.src = ""; pictures.delete(oldest); }
              }
            }
            return picture;
          };
          const loadWindow = async (windowStart: number, prefetch: boolean) => {
            if (windows.has(windowStart) || bitmapControllers.has(windowStart)) return;
            const windowController = new AbortController(), requestGeneration = bitmapGeneration;
            bitmapControllers.set(windowStart, windowController);
            try {
              const result = await api<BitmapWindow>(`${subtitle.url}?start=${windowStart.toFixed(2)}&duration=35`, undefined, "GET", windowController.signal);
              if (!active || requestGeneration !== bitmapGeneration) return;
              windows.set(windowStart, result); previousPaint = "\0";
              for (const storedStart of windows.keys()) if (Math.abs(storedStart - currentWindow) > 60) windows.delete(storedStart);
              if (!prefetch) { report(""); void loadWindow(windowStart + 30, true); }
            } catch (error) {
              if (active && requestGeneration === bitmapGeneration && (error as Error).name !== "AbortError" && !prefetch) report(`位图字幕窗口加载失败：${(error as Error).message}`);
            } finally {
              if (bitmapControllers.get(windowStart) === windowController) bitmapControllers.delete(windowStart);
            }
          };
          const tick = (now: number) => {
            if (!active) return;
            const time = core.currentTime - delayRef.current;
            if (now - lastCheck > 100) {
              lastCheck = now;
              const wantedWindow = Math.max(0, Math.floor(Math.max(0, time) / 30) * 30);
              if (wantedWindow !== currentWindow) {
                if (currentWindow >= 0 && Math.abs(wantedWindow - currentWindow) > 30) {
                  bitmapGeneration += 1;
                  for (const pending of bitmapControllers.values()) pending.abort();
                  bitmapControllers.clear(); windows.clear(); clearPictures();
                }
                currentWindow = wantedWindow; previousPaint = "\0";
                if (windows.has(wantedWindow)) void loadWindow(wantedWindow + 30, true);
                else void loadWindow(wantedWindow, false);
              }
              const activeWindow = windows.get(currentWindow);
              const current = (activeWindow?.cues || []).filter(cue => cue.start <= time && cue.end > time);
              for (const cue of activeWindow?.cues || []) if (cue.start > time && cue.start < time + 2) pictureFor(cue.url);
              const fallbackCanvas = activeWindow?.canvas || { width: activeWindow?.width || core.video.videoWidth, height: activeWindow?.height || core.video.videoHeight };
              const plan = bitmapPaintPlan(current, fallbackCanvas);
              const paintKey = `${plan.canvasWidth}x${plan.canvasHeight}:${plan.pictures.map(picture => `${picture.url}@${picture.x},${picture.y},${picture.width},${picture.height}`).join("|")}`;
              const canvas = bitmapCanvas.current, context = canvas?.getContext("2d");
              if (canvas && context && paintKey !== previousPaint) {
                previousPaint = paintKey;
                if (canvas.width !== plan.canvasWidth) canvas.width = plan.canvasWidth;
                if (canvas.height !== plan.canvasHeight) canvas.height = plan.canvasHeight;
                context.clearRect(0, 0, canvas.width, canvas.height);
                for (const item of plan.pictures) {
                  const picture = pictureFor(item.url);
                  if (picture.complete && picture.naturalWidth) context.drawImage(picture, item.x, item.y, item.width, item.height);
                }
              }
            }
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
          return;
        }

        let response: Response;
        try { response = await fetch(subtitle.url, { signal: controller.signal, cache: "no-store" }); }
        catch (error) {
          if ((error as Error).name === "AbortError") throw error;
          throw new Error(`字幕资源加载失败：${(error as Error).message || "网络请求失败"}`);
        }
        if (!response.ok) throw new Error(`字幕资源加载失败（${response.status}）`);
        const content = await response.text(); if (!active) return;
        if (ass && mode === "styled") {
          try {
            if (!("OffscreenCanvas" in window)) throw new Error("当前浏览器缺少 OffscreenCanvas 支持");
            if (!assCanvas.current) throw new Error("ASS 字幕画布尚未就绪");
            const assCanvasElement = assCanvas.current;
            const availableFonts = Object.fromEntries(fonts.flatMap(font => (font.aliases || []).map(alias => [alias.trim().toLowerCase(), font.url])));
            worker = new JASSUB({ video: core.video, canvas: assCanvasElement, subContent: content, workerUrl, wasmUrl, modernWasmUrl,
              fonts: fonts.filter(font => !font.aliases?.length).map(font => font.url), availableFonts, queryFonts: false,
              timeOffset: core.getState().timeOffset - delayRef.current });
            renderer.current = worker;
            unsubscribe = core.subscribe((state, event) => { if (worker && event === "strategychange") { worker.timeOffset = state.timeOffset - delayRef.current; void worker.resize(true).catch(() => {}); } });
            const rawWorker = worker._worker;
            let cleanupStartupWatch = () => {};
            const startupFailure = new Promise<never>((_, reject) => {
              const fail = (message: string) => reject(new Error(message));
              const onError = (event: ErrorEvent) => fail(event.message || "ASS Worker 加载失败");
              const onMessageError = () => fail("ASS Worker 消息解析失败");
              const timer = window.setTimeout(() => fail("ASS 特效渲染器启动超时"), 6000);
              rawWorker.addEventListener("error", onError, { once: true });
              rawWorker.addEventListener("messageerror", onMessageError, { once: true });
              cleanupStartupWatch = () => {
                window.clearTimeout(timer);
                rawWorker.removeEventListener("error", onError);
                rawWorker.removeEventListener("messageerror", onMessageError);
              };
            });
            try { await Promise.race([worker.ready, startupFailure]); }
            finally { cleanupStartupWatch(); }
            if (active) await worker.resize(true, core.video.videoWidth || core.video.clientWidth, core.video.videoHeight || core.video.clientHeight);
          } catch (error) {
            if (!active || (error as Error).name === "AbortError") return;
            unsubscribe(); unsubscribe = () => {};
            stopAssRenderer(worker);
            worker = null; renderer.current = null;
            const message = assRendererFailureMessage(error);
            onFallback(message); startTextRenderer(content, true, message);
          }
        } else startTextRenderer(content, Boolean(ass), fallbackReason);
      } catch (error) {
        if (active && (error as Error).name !== "AbortError") report((error as Error).message || "字幕渲染失败");
      }
    })();
    return () => {
      active = false; controller.abort(); bitmapGeneration += 1;
      for (const pending of bitmapControllers.values()) pending.abort(); bitmapControllers.clear();
      cleanupBitmapPictures();
      cancelAnimationFrame(frame); unsubscribe(); stopAssRenderer(worker); if (renderer.current === worker) renderer.current = null;
    };
  }, [core, key]);
  return <><canvas key={`ass:${key}`} className="lmd-ass-subtitles" ref={assCanvas} /><canvas className="lmd-bitmap-subtitles" ref={bitmapCanvas} /><div className="lmd-text-subtitles" aria-hidden="true">{text}</div></>;
}
