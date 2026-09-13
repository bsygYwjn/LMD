import { useEffect, useRef, useState } from "react";
import Danmaku from "danmaku";
import { api, PlaybackCore } from "./core";
import { applyMapping, mappedTime, validateAnchors, type Anchor, type Exclude } from "./danmaku-time";

export { applyMapping, mappedTime, validateAnchors };
export type { Anchor, Exclude };

type Comment = { time: number; text: string; mode: "rtl" | "ltr" | "top" | "bottom"; color: string };
type Source = { id: string; name: string; enabled: boolean; comments: Comment[] };
type Options = { enabled: boolean; opacity: number; fontSize: number; speed: number; area: number; density: number; blocked: string; delay: number; anchors: Anchor[]; excludes: Exclude[] };
const defaults: Options = { enabled: true, opacity: 0.8, fontSize: 24, speed: 144, area: 0.65, density: 8, blocked: "", delay: 0, anchors: [], excludes: [] };
// Bounded so a huge import cannot pin memory or stall the render loop.
const MAX_COMMENTS = 120000, MAX_SOURCES = 8;
export function stored<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } }
export function persist(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private mode or storage full: settings remain usable in memory. */ } }

function normalize(list: unknown[], limit = MAX_COMMENTS): Comment[] {
  if (list.length > 100000) throw new Error("弹幕数量超过 100000 条");
  const seen = new Set<string>(), result: Comment[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>, p = String(item.p || "").split(",");
    const time = Number(item.time ?? p[0]), text = String(item.text ?? item.m ?? "").slice(0, 500);
    const mode = ["rtl", "ltr", "top", "bottom"].includes(String(item.mode)) ? String(item.mode) : ({ 1: "rtl", 4: "bottom", 5: "top", 6: "ltr" } as Record<string, string>)[String(p[1])];
    const color = /^#[\da-f]{6}$/i.test(String(item.color)) ? String(item.color) : `#${(Number(p[2] ?? 16777215) >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
    if (!Number.isFinite(time) || time < 0 || time > 604800 || !text.trim() || !mode) continue;
    const key = `${Math.round(time * 10)}:${text}:${mode}`; if (seen.has(key)) continue;
    seen.add(key); result.push({ time, text, color, mode: mode as Comment["mode"] });
    if (result.length >= limit) break;
  }
  return result.sort((a, b) => a.time - b.time);
}

export function useDanmaku(mediaId: string, version: string) {
  const key = `lmd:danmaku:${mediaId}:${version}`;
  const [options, setOptions] = useState<Options>(() => ({ ...defaults, ...stored<Partial<Options>>(key, {}) }));
  const [sources, setSources] = useState<Source[]>([]), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(() => stored("lmd:danmaku:consent", false));
  const [matches, setMatches] = useState<{ episodeId: number; animeTitle: string; episodeTitle: string }[]>([]);
  const [anchorSource, setAnchorSource] = useState(""), [anchorTarget, setAnchorTarget] = useState("");
  const abort = useRef<AbortController | null>(null), epoch = useRef(0);
  useEffect(() => { setOptions({ ...defaults, ...stored<Partial<Options>>(key, {}) }); setSources([]); setMatches([]); setMessage(""); epoch.current++; return () => { abort.current?.abort(); epoch.current++; }; }, [key]);
  const update = (patch: Partial<Options>) => setOptions(previous => { const next = { ...previous, ...patch }; persist(key, next); return next; });
  async function comments(episodeId: number, signal: AbortSignal, turn: number) {
    const result = await api<{ comments: Comment[]; source: string }>(`/api/media/${mediaId}/danmaku/comments`, { consent: true, episodeId }, "POST", signal);
    if (turn !== epoch.current) return;
    const list = normalize(result.comments);
    setSources(previous => [{ id: "provider", name: result.source, enabled: true, comments: list }, ...previous.filter(s => s.id !== "provider")]);
    setMessage(`已加载 ${list.length} 条聚合弹幕 · 使用来源时间轴`); setMatches([]);
  }
  async function match(rematch = false) {
    abort.current?.abort(); abort.current = new AbortController(); const signal = abort.current.signal, turn = epoch.current;
    setBusy(true); setMessage("正在匹配番剧与集数…");
    try {
      const result = await api<{ matched: boolean; binding: { episodeId: number } | null; matches: typeof matches }>(`/api/media/${mediaId}/danmaku/match`, { consent: true, rematch }, "POST", signal);
      if (turn !== epoch.current) return;
      if (result.matched && result.binding) await comments(result.binding.episodeId, signal, turn);
      else { setMatches(result.matches); setMessage(result.matches.length ? "请选择正确的番剧与集数" : "未找到可靠匹配，可导入本地弹幕"); }
    } catch (error) { if (turn === epoch.current && (error as Error).name !== "AbortError") setMessage((error as Error).message); }
    finally { if (turn === epoch.current) setBusy(false); }
  }
  useEffect(() => { if (consent) void match(); }, [key, consent]);
  async function select(episodeId: number) {
    const candidate = matches.find(m => m.episodeId === episodeId); if (!candidate) return;
    abort.current?.abort(); abort.current = new AbortController(); const signal = abort.current.signal, turn = epoch.current; setBusy(true);
    try { await api(`/api/media/${mediaId}/danmaku/binding`, { consent: true, episodeId, title: `${candidate.animeTitle} ${candidate.episodeTitle}` }, "POST", signal); await comments(episodeId, signal, turn); }
    catch (error) { if ((error as Error).name !== "AbortError") setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > 8 * 1024 ** 2) throw new Error("弹幕文件不得超过 8 MiB");
      const text = await file.text(); let raw: unknown[];
      if (text.trimStart().startsWith("<")) {
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("不允许包含文档实体的弹幕文件");
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) throw new Error("XML 弹幕格式无效");
        raw = Array.from(doc.querySelectorAll("d")).map(node => { const p = (node.getAttribute("p") || "").split(","); return { p: `${p[0]},${p[1]},${p[3]}`, m: node.textContent || "" }; });
      } else { const json = JSON.parse(text); raw = Array.isArray(json) ? json : json.comments; }
      if (!Array.isArray(raw)) throw new Error("JSON 应为弹幕数组或包含 comments 数组");
      const list = normalize(raw);
      setSources(previous => [...previous.slice(-(MAX_SOURCES - 1)), { id: crypto.randomUUID?.() || String(Date.now()), name: file.name, enabled: true, comments: list }]);
      setMessage(`已导入 ${list.length} 条弹幕${list.length >= MAX_COMMENTS ? "（已达上限，其余已忽略）" : ""}`);
    } catch (error) { setMessage((error as Error).message); }
  }
  function addAnchor() {
    const source = Number(anchorSource), target = Number(anchorTarget);
    if (!anchorSource || !anchorTarget || !Number.isFinite(source) || !Number.isFinite(target) || source < 0 || target < 0) { setMessage("请填写有效的来源时间和视频时间（秒）"); return; }
    const anchors = [...options.anchors.filter(a => a.source !== source), { source, target }].sort((a, b) => a.source - b.source);
    const problem = validateAnchors(anchors);
    if (problem) { setMessage(problem); return; }
    update({ anchors }); setAnchorSource(""); setAnchorTarget(""); setMessage("已保存分段校准；每个锚点之后应用对应偏移，锚点之前保持来源时间");
  }
  function removeAnchor(source: number) {
    update({ anchors: options.anchors.filter(anchor => anchor.source !== source) });
    setMessage("已删除该分段锚点");
  }
  /** Marks a provider interval as absent from this copy of the video. */
  function addExclude() {
    const from = Number(anchorSource), to = Number(anchorTarget);
    if (!anchorSource || !anchorTarget || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) { setMessage("请填写有效的区间起止时间（秒）"); return; }
    const excludes = [...(options.excludes || []).filter(range => range.from !== from), { from, to }].sort((a, b) => a.from - b.from);
    if (excludes.length > 50) { setMessage("区间最多 50 个"); return; }
    update({ excludes }); setMessage(`已标记删除区间 ${from}s – ${to}s，其中的弹幕不再显示`);
  }
  function removeExclude(from: number) {
    update({ excludes: (options.excludes || []).filter(range => range.from !== from) });
    setMessage("已删除该区间");
  }
  return { options, update, sources, setSources, message, busy, matches, select, importFile, consent,
    enable: () => { persist("lmd:danmaku:consent", true); setConsent(true); }, disable: () => { persist("lmd:danmaku:consent", false); setConsent(false); abort.current?.abort(); },
    match, anchorSource, setAnchorSource, anchorTarget, setAnchorTarget, addAnchor, removeAnchor, addExclude, removeExclude };
}
type Controller = ReturnType<typeof useDanmaku>;
export function DanmakuOverlay({ core, controller }: { core: PlaybackCore; controller: Controller }) {
  const container = useRef<HTMLDivElement>(null);
  const { options, sources } = controller;
  useEffect(() => {
    if (!container.current || !options.enabled) return;
    const blocked = options.blocked.split(/\n|,/).map(s => s.trim()).filter(Boolean), buckets = new Map<number, number>(), seen = new Set<string>();
    const comments = sources.filter(s => s.enabled).flatMap(s => s.comments).filter(c => !blocked.some(word => c.text.includes(word))).sort((a, b) => a.time - b.time).flatMap(c => {
      // Mapping happens before de-duplication: the same comment from two sources
      // lands on the same original-timeline second even when the providers
      // disagree, so identical text at the same mapped time is shown once.
      const time = applyMapping(c.time, { anchors: options.anchors, excludes: options.excludes || [], delay: options.delay });
      if (time === null || time < 0) return [];
      const key = `${Math.round(time * 10)}:${c.mode}:${c.text}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ text: c.text, time, mode: c.mode, style: { font: `600 ${options.fontSize}px sans-serif`, fillStyle: c.color, strokeStyle: "#000000", lineWidth: 2 } as unknown as CanvasRenderingContext2D }];
    }).filter(c => {
      const bucket = Math.floor(c.time), count = buckets.get(bucket) || 0; buckets.set(bucket, count + 1); return count < options.density;
    });
    const renderer = new Danmaku({ container: container.current, media: core as unknown as HTMLMediaElement, comments, engine: "canvas", speed: options.speed });
    const resize = new ResizeObserver(() => renderer.resize()); resize.observe(container.current);
    return () => { resize.disconnect(); renderer.destroy(); };
  }, [core, sources, options]);
  return <div ref={container} className="lmd-danmaku-layer" style={{ height: `${options.area * 100}%`, opacity: options.opacity }} aria-hidden="true" />;
}
export function DanmakuPanel({ controller: c, currentTime }: { controller: Controller; currentTime: number }) {
  return <div className="lmd-panel-fields">
    {!c.consent ? <div className="lmd-consent"><p>启用后，服务器会向弹弹play发送文件名、大小、时长和前 16 MiB 哈希，用于识别番剧。不会上传视频。</p><button onClick={c.enable}>启用自动匹配</button></div> : <div className="lmd-panel-actions"><button disabled={c.busy} onClick={() => void c.match(true)}>重新匹配</button><button onClick={c.disable}>关闭联网</button></div>}
    <label className="lmd-file-button">导入 XML / JSON<input type="file" accept=".xml,.json" onChange={e => { void c.importFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
    {c.message && <p role="status" className="lmd-panel-message">{c.message}</p>}
    {!!c.matches.length && <select aria-label="匹配番剧集数" defaultValue="" onChange={e => void c.select(Number(e.target.value))}><option value="" disabled>选择番剧与集数</option>{c.matches.map(m => <option key={m.episodeId} value={m.episodeId}>{m.animeTitle} · {m.episodeTitle}</option>)}</select>}
    {c.sources.map(source => <label key={source.id} className="lmd-source"><input type="checkbox" checked={source.enabled} onChange={e => c.setSources(previous => previous.map(s => s.id === source.id ? { ...s, enabled: e.target.checked } : s))} />{source.name}<small>{source.comments.length} 条</small></label>)}
    <label>透明度<input type="range" min="0.1" max="1" step="0.05" value={c.options.opacity} onChange={e => c.update({ opacity: +e.target.value })} /></label>
    <label>字号<input type="range" min="16" max="40" step="1" value={c.options.fontSize} onChange={e => c.update({ fontSize: +e.target.value })} /></label>
    <label>显示区域<select value={c.options.area} onChange={e => c.update({ area: +e.target.value })}><option value={0.25}>上方 1/4</option><option value={0.5}>上半屏</option><option value={0.65}>上方 2/3</option><option value={1}>全屏</option></select></label>
    <label>密度<select value={c.options.density} onChange={e => c.update({ density: +e.target.value })}><option value={3}>稀疏</option><option value={8}>标准</option><option value={20}>密集</option></select></label>
    <label>滚动速度<input type="range" min="60" max="240" step="12" value={c.options.speed} onChange={e => c.update({ speed: +e.target.value })} /></label>
    <label>延后秒数<input type="number" min="-3600" max="3600" step="0.1" value={c.options.delay} onChange={e => c.update({ delay: Number(e.target.value) || 0 })} /></label>
    <label>屏蔽词<textarea placeholder="每行一个词" maxLength={2000} value={c.options.blocked} onChange={e => c.update({ blocked: e.target.value })} /></label>
    <details><summary>分段校准 · {c.options.anchors.length} 个锚点{(c.options.excludes || []).length ? ` · ${(c.options.excludes || []).length} 段删除` : ""}</summary>
      <p>正值统一延后；分段锚点只影响该锚点之后的弹幕，锚点之前保持来源时间，因此不会重复叠加偏移。供应方已经校准过的时间轴不要再次添加锚点。</p>
      <label>来源时间（秒）<input type="number" min="0" value={c.anchorSource} onChange={e => c.setAnchorSource(e.target.value)} /></label>
      <label>视频时间（秒）<input type="number" min="0" value={c.anchorTarget} onChange={e => c.setAnchorTarget(e.target.value)} /></label>
      <div className="lmd-panel-actions">
        <button onClick={() => c.setAnchorTarget(currentTime.toFixed(2))}>用当前时间</button>
        <button onClick={c.addAnchor}>保存锚点</button>
        <button onClick={c.addExclude}>标记删除区间</button>
        <button onClick={() => c.update({ delay: 0, anchors: [], excludes: [] })}>恢复默认</button>
      </div>
      {c.options.anchors.map(a => <p key={a.source} className="lmd-source">{a.source}s → {a.target}s<button onClick={() => c.removeAnchor(a.source)}>删除</button></p>)}
      {(c.options.excludes || []).map(range => <p key={range.from} className="lmd-source">删除 {range.from}s – {range.to}s<button onClick={() => c.removeExclude(range.from)}>删除</button></p>)}
    </details>
  </div>;
}
