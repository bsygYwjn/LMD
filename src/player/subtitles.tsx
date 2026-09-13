import { useEffect, useRef, useState } from "react";
import JASSUB from "jassub";
import workerUrl from "jassub/dist/worker/worker.js?worker&url";
import wasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import modernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import { PlaybackCore, api } from "./core";
import { assToWebVtt } from "./subtitle-text";
export type Subtitle = { id: string; name: string; format: string; language: string; url: string; size?: number; modifiedAt?: string };
export type FontAsset = { id: string; name: string; url: string; aliases?: string[]; modifiedAt?: string; size?: number };
type Cue = { start: number; end: number; text: string };
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
type BitmapCue = { start: number; end: number; width: number; height: number; url: string };
type BitmapWindow = { cues: BitmapCue[]; width: number; height: number; total: number };
export function SubtitleOverlay({ core, subtitle, fonts, delay, mode, report }: { core: PlaybackCore; subtitle?: Subtitle; fonts: FontAsset[]; delay: number; mode: "styled" | "text"; report: (message: string) => void }) {
  const renderer = useRef<JASSUB | null>(null), delayRef = useRef(delay), bitmapCanvas = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState(""); delayRef.current = delay;
  const key = `${subtitle?.id}:${subtitle?.url}:${subtitle?.modifiedAt}:${subtitle?.size}:${mode}:${fonts.map(f => `${f.id}:${f.modifiedAt}:${f.size}`).join("|")}`;
  useEffect(() => {
    if (renderer.current) { renderer.current.timeOffset = core.getState().timeOffset - delay; void renderer.current.resize(true).catch(() => {}); }
  }, [delay, core]);
  useEffect(() => {
    const controller = new AbortController(); let active = true, frame = 0, worker: JASSUB | null = null;
    let unsubscribe = () => {}, bitmapAbort: AbortController | null = null;
    setText(""); report("");
    const ass = subtitle && ["ASS", "SSA"].includes(subtitle.format.toUpperCase());
    void (async () => {
      if (!subtitle) return;
      try {
        if (["PGS", "VOBSUB", "DVB", "DVD_SUBTITLE", "HDMV_PGS_SUBTITLE", "DVB_SUBTITLE"].includes(subtitle.format.toUpperCase())) {
          let cues: BitmapCue[] = [], windowStart = -1, fetching = false, previous = "", lastCheck = 0, windowGeneration = 0;
          // Continuous seek cancels the in-flight window and drops its result:
          // stale pictures from another position must never be painted.
          const pictures = new Map<string, HTMLImageElement>();
          const loadWindow = async (time: number) => {
            fetching = true; windowStart = Math.max(0, Math.floor(time / 30) * 30);
            const generation = ++windowGeneration; bitmapAbort?.abort(); bitmapAbort = new AbortController();
            try {
              const result = await api<BitmapWindow>(`${subtitle.url}?start=${windowStart.toFixed(2)}&duration=35`, undefined, "GET", bitmapAbort.signal);
              if (!active || generation !== windowGeneration) return;
              cues = result.cues; previous = "";
              for (const image of pictures.values()) image.src = "";
              pictures.clear(); report("");
            } catch (error) { if (active && (error as Error).name !== "AbortError") report((error as Error).message); }
            finally { if (generation === windowGeneration) fetching = false; }
          };
          const pictureFor = (url: string) => {
            let picture = pictures.get(url);
            if (!picture) {
              picture = new Image(); picture.decoding = "async";
              picture.onload = () => { previous = ""; };
              picture.onerror = () => { pictures.delete(url); report("部分字幕位图加载失败"); };
              picture.src = url; pictures.set(url, picture);
              if (pictures.size > 24) { const oldest = pictures.keys().next().value as string; if (oldest !== url) { const dropped = pictures.get(oldest); if (dropped) dropped.src = ""; pictures.delete(oldest); } }
            }
            return picture;
          };
          const tick = (now: number) => {
            if (!active) return;
            const time = core.currentTime - delayRef.current;
            if (now - lastCheck > 100) {
              lastCheck = now;
              if (!fetching && (time < windowStart || time >= windowStart + 30)) void loadWindow(time);
              const current = cues.filter(cue => cue.start <= time && cue.end > time);
              for (const cue of cues) if (cue.start > time && cue.start < time + 2) pictureFor(cue.url);
              const next = current.map(cue => `${cue.start}:${cue.end}`).join(",");
              const canvas = bitmapCanvas.current, context = canvas?.getContext("2d");
              if (canvas && context && next !== previous) {
                previous = next; context.clearRect(0, 0, canvas.width, canvas.height);
                for (const cue of current) {
                  const picture = pictureFor(cue.url);
                  if (picture.complete && picture.naturalWidth) {
                    if (canvas.width !== picture.naturalWidth || canvas.height !== picture.naturalHeight) { canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight; }
                    context.drawImage(picture, 0, 0);
                  }
                }
              }
            }
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick); return;
        }
        const response = await fetch(subtitle.url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`字幕加载失败（${response.status}）`);
        const content = await response.text(); if (!active) return;
        if (ass && mode === "styled") {
          if (!("OffscreenCanvas" in window)) throw new Error("当前浏览器不支持特效字幕渲染，可切换为纯文本模式");
          const availableFonts = Object.fromEntries(fonts.flatMap(font => (font.aliases || []).map(alias => [alias.trim().toLowerCase(), font.url])));
          worker = new JASSUB({ video: core.video, subContent: content, workerUrl, wasmUrl, modernWasmUrl,
            fonts: fonts.filter(font => !font.aliases?.length).map(font => font.url), availableFonts, queryFonts: false,
            timeOffset: core.getState().timeOffset - delayRef.current });
          renderer.current = worker;
          unsubscribe = core.subscribe((state, event) => { if (worker && event === "strategychange") { worker.timeOffset = state.timeOffset - delayRef.current; void worker.resize(true).catch(() => {}); } });
          await worker.ready;
          if (active) await worker.resize(true);
        } else {
          const cues = parseText(ass ? assToWebVtt(content) : content);
          if (ass) report("纯文本模式：ASS 的字体、定位和动画已降级");
          let lastText = "", last = 0;
          const tick = (now: number) => {
            if (!active) return;
            if (now - last > 60) {
              last = now; const time = core.currentTime - delayRef.current;
              // Binary search narrows the active cue range; overlapping signs
              // remain supported without scanning the whole script per frame.
              let low = 0, high = cues.length;
              while (low < high) { const mid = (low + high) >>> 1; if (cues[mid].start <= time) low = mid + 1; else high = mid; }
              const texts: string[] = [];
              for (let i = low - 1; i >= 0 && cues[i].start >= time - 3600; i--) if (cues[i].end > time) texts.unshift(cues[i].text);
              const value = texts.join("\n"); if (value !== lastText) { lastText = value; setText(value); }
            }
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
        }
      } catch (error) { if (active && (error as Error).name !== "AbortError") report((error as Error).message || "字幕渲染失败，可尝试纯文本模式"); }
    })();
    return () => { active = false; controller.abort(); bitmapAbort?.abort(); cancelAnimationFrame(frame); unsubscribe(); worker?.destroy(); if (renderer.current === worker) renderer.current = null; };
  }, [core, key]);
  return <><canvas className="lmd-bitmap-subtitles" ref={bitmapCanvas} /><div className="lmd-text-subtitles" aria-hidden="true">{text}</div></>;
}
