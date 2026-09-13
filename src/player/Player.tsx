import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, LockKeyhole, UnlockKeyhole, Settings2, Captions, MessageSquare, SkipBack, SkipForward, RotateCcw, RotateCw, X, LoaderCircle } from "lucide-react";
import { PlaybackCore, type PlaybackState } from "./core";
import { SubtitleOverlay, type Subtitle, type FontAsset } from "./subtitles";
import { DanmakuOverlay, DanmakuPanel, useDanmaku, stored, persist } from "./danmaku";
import { releaseMediaSession, updateMediaSession } from "../media-session";
import "./player.css";

export type PlayerMedia = { id: string; title: string; fileName: string; extension: string; size: number; modifiedAt?: string; subtitles: Subtitle[]; fonts: FontAsset[];
  videoCodec?: string | null; audioCodec?: string | null; width?: number | null; height?: number | null; bitDepth?: number; hdr?: string | null; posterHue: number; demo?: boolean;
  display?: { configured: boolean; alias: string } };
type Props = { media: PlayerMedia; pageMode?: boolean; onClose?: () => void; previousMedia?: PlayerMedia | null; nextMedia?: PlayerMedia | null; onPrevious?: () => void; onNext?: () => void };
const label = (media: PlayerMedia) => media.display?.configured ? media.display.alias : media.title;
const time = (seconds: number) => { const whole = Math.max(0, Math.floor(seconds || 0)), hours = Math.floor(whole / 3600); return `${hours ? `${hours}:` : ""}${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`; };
const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
const initial: PlaybackState = { mediaId: "", currentTime: 0, duration: 0, paused: true, seeking: false, buffering: true, volume: 1, muted: false, playbackRate: 1, tracks: [], audioTrackId: null,
  buffered: [], seekable: [], strategy: "", transport: "", timeOffset: 0, generation: 0, error: "", errorCode: "", autoplayBlocked: false, firstFrameMs: null, lastSeekMs: null };

export function VideoPlayer(props: Props) {
  const { media, pageMode = false, onClose, previousMedia, nextMedia, onPrevious, onNext } = props;
  const stage = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), coreRef = useRef<PlaybackCore | null>(null);
  const [core, setCore] = useState<PlaybackCore | null>(null), [state, setState] = useState(initial);
  const [visible, setVisible] = useState(true), [panel, setPanel] = useState<"" | "subtitles" | "danmaku" | "settings">("");
  const [locked, setLocked] = useState(false), [pageFullscreen, setPageFullscreen] = useState(false), [systemFullscreen, setSystemFullscreen] = useState(false);
  const [subtitleId, setSubtitleId] = useState("off"), [delay, setDelay] = useState(0), [subtitleMode, setSubtitleMode] = useState<"styled" | "text">("styled");
  const [subtitleError, setSubtitleError] = useState(""), [toast, setToast] = useState(""), [preview, setPreview] = useState<number | null>(null);
  const [holdRate, setHoldRate] = useState(() => stored("lmd:player:holdRate", 3)), [brightness, setBrightness] = useState(1);
  const [boosting, setBoosting] = useState(false);
  const stateRef = useRef(state), latest = useRef(props), visibleRef = useRef(visible), lockedRef = useRef(locked), panelRef = useRef(panel);
  stateRef.current = state; latest.current = props; visibleRef.current = visible; lockedRef.current = locked; panelRef.current = panel;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), singleTap = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const boostPrevious = useRef<number | null>(null), keyHeld = useRef(false), draggingRange = useRef(false), seekPreview = useRef<number | null>(null);
  const pointer = useRef<{ id: number; type: string; x: number; y: number; start: number; volume: number; brightness: number; mode: string; lastTap: number } | null>(null);
  const tapTime = useRef(0);
  const danmaku = useDanmaku(media.id, `${media.size}:${media.modifiedAt || ""}`);
  const fullscreen = pageFullscreen || systemFullscreen;
  const notify = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 1400); }, []);
  const show = useCallback(() => { setVisible(true); clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => {
    if (!stateRef.current.paused && !panelRef.current && !stage.current?.contains(document.activeElement === stage.current ? null : document.activeElement)) setVisible(false);
  }, 2600); }, []);
  const endBoost = useCallback(() => { clearTimeout(holdTimer.current); if (boostPrevious.current !== null) { coreRef.current?.setPlaybackRate(boostPrevious.current); boostPrevious.current = null; setBoosting(false); } }, []);
  const startBoost = useCallback(() => { if (lockedRef.current || boostPrevious.current !== null || stateRef.current.paused) return; boostPrevious.current = coreRef.current?.playbackRate || 1; coreRef.current?.setPlaybackRate(holdRate); setBoosting(true); }, [holdRate]);
  const toggle = useCallback(() => { const current = coreRef.current; if (!current) return; if (stateRef.current.paused) void current.play(); else current.pause(); show(); }, [show]);
  const seekBy = useCallback((seconds: number) => { const current = coreRef.current; if (!current) return; void current.seek(current.currentTime + seconds); notify(`${seconds < 0 ? "快退" : "快进"} ${Math.abs(seconds)} 秒`); show(); }, [notify, show]);
  const fullscreenToggle = useCallback(async () => {
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
    if (pageFullscreen) { setPageFullscreen(false); return; }
    if (stage.current?.requestFullscreen && !ios()) { try { await stage.current.requestFullscreen(); return; } catch {} }
    setPageFullscreen(true);
  }, [pageFullscreen]);
  useEffect(() => {
    if (!video.current || media.demo) return;
    setState(initial); setSubtitleId("off"); setDelay(0); setLocked(false); setPanel(""); setSubtitleError("");
    const current = new PlaybackCore(video.current); coreRef.current = current; setCore(current);
    current.setVolume(stored("lmd:player:volume", 1)); current.setPlaybackRate(stored("lmd:player:rate", 1));
    const unsubscribe = current.subscribe((value, event) => {
      setState(value);
      if (event === "ended" && latest.current.nextMedia) latest.current.onNext?.();
      if (event === "ratechange" && boostPrevious.current === null) persist("lmd:player:rate", value.playbackRate);
      if (event === "volumechange") persist("lmd:player:volume", value.volume);
      if (["play", "playing", "pause"].includes(event)) updateMediaSession("video", { playbackState: value.paused ? "paused" : "playing" });
      if (event === "timeupdate" && value.duration > 0) updateMediaSession("video", { position: { duration: value.duration, playbackRate: value.playbackRate, position: value.currentTime } });
    });
    updateMediaSession("video", { priority: 20, metadata: typeof MediaMetadata !== "undefined" ? new MediaMetadata({ title: label(media), artist: "LMD 本地视频" }) : null,
      handlers: { play: () => void current.play(), pause: () => current.pause(), seekto: details => { if (details.seekTime != null) void current.seek(details.seekTime); },
        seekbackward: details => void current.seek(current.currentTime - (details.seekOffset || 5)), seekforward: details => void current.seek(current.currentTime + (details.seekOffset || 5)),
        previoustrack: () => latest.current.onPrevious?.(), nexttrack: () => latest.current.onNext?.() } });
    void current.load(media.id);
    return () => { endBoost(); unsubscribe(); void current.destroy(); coreRef.current = null; releaseMediaSession("video"); };
  }, [media.id]);
  useEffect(() => { if (state.paused) setVisible(true); else show(); }, [state.paused, show]);
  useEffect(() => {
    const changed = () => setSystemFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", changed); return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => { if (!pageFullscreen) return; const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = previous; }; }, [pageFullscreen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]") || panelRef.current || !stage.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") { setPageFullscreen(false); setPanel(""); setLocked(false); return; }
      if (lockedRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
      if ([" ", "k", "K"].includes(event.key)) { event.preventDefault(); if (!event.repeat) toggle(); }
      else if (event.key === "ArrowRight") {
        event.preventDefault(); if (!keyHeld.current) { keyHeld.current = true; holdTimer.current = setTimeout(startBoost, 400); }
      } else if (event.key === "ArrowLeft") { event.preventDefault(); seekBy(-5); }
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); coreRef.current?.setVolume(stateRef.current.volume + (event.key === "ArrowUp" ? 0.05 : -0.05)); show(); }
      else if (event.key.toLowerCase() === "f") { event.preventDefault(); void fullscreenToggle(); }
      else if (event.key.toLowerCase() === "m") { event.preventDefault(); coreRef.current?.setMuted(!stateRef.current.muted); }
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === "ArrowRight" && keyHeld.current) { keyHeld.current = false; if (boostPrevious.current === null) seekBy(5); endBoost(); } };
    const blur = () => { keyHeld.current = false; endBoost(); pointer.current = null; setPreview(null); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); };
  }, [toggle, seekBy, startBoost, endBoost, fullscreenToggle, show]);
  useEffect(() => () => { clearTimeout(hideTimer.current); clearTimeout(toastTimer.current); clearTimeout(singleTap.current); clearTimeout(holdTimer.current); }, []);
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointer.current || (event.target as HTMLElement).closest("button,input,select,.lmd-settings-panel")) return;
    stage.current?.focus({ preventScroll: true });
    if (locked) { show(); return; }
    // Pointer capture is best effort: it throws when the pointer is already
    // gone (synthetic events, a cancelled touch, or a second finger).
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture unavailable */ }
    pointer.current = { id: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, start: core?.currentTime || 0, volume: state.volume, brightness, mode: "tap", lastTap: tapTime.current };
    if (event.pointerType !== "mouse") holdTimer.current = setTimeout(() => { if (pointer.current?.mode === "tap") { pointer.current.mode = "hold"; startBoost(); } }, 400);
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current; if (!p || p.id !== event.pointerId || p.type === "mouse") return;
    const dx = event.clientX - p.x, dy = event.clientY - p.y, bounds = stage.current!.getBoundingClientRect();
    if (p.mode === "tap" && Math.hypot(dx, dy) > 12) { clearTimeout(holdTimer.current); p.mode = Math.abs(dx) > Math.abs(dy) ? "seek" : p.x - bounds.left > bounds.width / 2 ? "volume" : "brightness"; }
    if (p.mode === "seek") { seekPreview.current = Math.max(0, Math.min(state.duration, p.start + dx / bounds.width * Math.min(180, state.duration))); setPreview(seekPreview.current); }
    else if (p.mode === "volume") { if (ios()) notify("请使用设备音量键"); else { const volume = Math.max(0, Math.min(1, p.volume - dy / bounds.height)); core?.setVolume(volume); notify(`音量 ${Math.round(volume * 100)}%`); } }
    else if (p.mode === "brightness") { const value = Math.max(0.25, Math.min(1, p.brightness - dy / bounds.height)); setBrightness(value); notify(`画面亮度 ${Math.round(value * 100)}%`); }
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const p = pointer.current; if (!p || p.id !== event.pointerId) return; pointer.current = null; clearTimeout(holdTimer.current);
    if (p.mode === "hold") endBoost();
    if (cancelled) { setPreview(null); seekPreview.current = null; return; }
    if (p.mode === "seek" && seekPreview.current !== null) { void core?.seek(seekPreview.current); setPreview(null); seekPreview.current = null; show(); return; }
    if (p.mode !== "tap") return;
    if (p.type === "mouse") { toggle(); return; }
    const now = performance.now();
    if (now - tapTime.current < 280) { clearTimeout(singleTap.current); tapTime.current = 0; toggle(); }
    else { tapTime.current = now; singleTap.current = setTimeout(() => { if (visibleRef.current && !stateRef.current.paused) setVisible(false); else show(); }, 280); }
  };
  const openPanel = (name: typeof panel) => { setPanel(previous => previous === name ? "" : name); setVisible(true); };
  const selected = media.subtitles.find(s => s.id === subtitleId);
  const player = <div className={`player-modal${pageMode ? " player-page-panel" : ""} lmd-player`}>
    <div className="player-topbar"><div><strong>{label(media)}</strong><span>{media.extension} · {media.videoCodec?.toUpperCase() || "原始媒体"}{media.bitDepth ? ` · ${media.bitDepth}-bit` : ""}</span></div>{!pageMode && onClose && <button className="close-button" aria-label="关闭播放器" onClick={onClose}><X size={20} /></button>}</div>
    <div ref={stage} tabIndex={0} aria-label="视频播放器" className={`lmd-stage${pageFullscreen ? " is-page-fullscreen" : ""}${visible ? " controls-visible" : ""}${locked ? " is-locked" : ""}`}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={e => pointerUp(e)} onPointerCancel={e => pointerUp(e, true)} onMouseMove={() => { if (!locked) show(); }} onContextMenu={e => { if (boosting) e.preventDefault(); }}>
      {media.demo ? <div className="lmd-demo"><Play size={56} /><h2>你的私人放映室</h2><p>原片直放 · 按需兼容 · 字幕与弹幕</p></div> : <video ref={video} playsInline preload="metadata" />}
      <div className="lmd-brightness" style={{ opacity: 1 - brightness }} />
      {core && <><DanmakuOverlay core={core} controller={danmaku} /><SubtitleOverlay core={core} subtitle={selected} fonts={media.fonts} delay={delay} mode={subtitleMode} report={setSubtitleError} /></>}
      {!media.demo && state.buffering && !state.error && <div className="lmd-loading"><LoaderCircle className="spin" size={32} /><span>{state.seeking ? "正在定位…" : "准备播放…"}</span></div>}
      {!media.demo && (state.autoplayBlocked || state.error) && <div className="lmd-play-message"><p>{state.error || "点击开始播放"}</p><button onClick={() => state.error ? void core?.retry() : void core?.play()}><Play size={18} />{state.error ? "重试播放" : "播放"}</button></div>}
      {preview !== null && <div className="lmd-seek-feedback"><strong>{time(preview)}</strong><span>/ {time(state.duration)}</span></div>}
      {(toast || boosting) && <div className="lmd-toast" role="status">{boosting ? `${holdRate}× 倍速播放 · 松开恢复` : toast}</div>}
      <div className="lmd-stage-heading"><span>{label(media)}</span>{fullscreen && <button aria-label="退出全屏" onClick={() => void fullscreenToggle()}><Minimize size={19} /></button>}</div>
      <button className="lmd-lock" aria-label={locked ? "解锁播放器" : "锁定播放器"} onClick={() => { endBoost(); setLocked(!locked); setPanel(""); show(); }}>{locked ? <LockKeyhole size={20} /> : <UnlockKeyhole size={20} />}</button>
      {!locked && <div className="lmd-controls" onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>
        <div className="lmd-progress"><div className="lmd-buffer-ranges">{state.buffered.map(([start, end], i) => <i key={i} style={{ left: `${start / state.duration * 100}%`, width: `${(end - start) / state.duration * 100}%` }} />)}</div><input aria-label="播放进度" type="range" min="0" max={state.duration || 1} step="0.01" value={preview ?? state.currentTime}
          style={{ "--progress": `${(preview ?? state.currentTime) / (state.duration || 1) * 100}%` } as React.CSSProperties}
          onPointerDown={() => { draggingRange.current = true; }} onChange={e => { const value = +e.target.value; if (draggingRange.current) { setPreview(value); seekPreview.current = value; } else void core?.seek(value); }}
          onPointerUp={e => { draggingRange.current = false; void core?.seek(+e.currentTarget.value); setPreview(null); seekPreview.current = null; }} onPointerCancel={() => { draggingRange.current = false; setPreview(null); }} /></div>
        <div className="lmd-control-row"><button aria-label={state.paused ? "播放" : "暂停"} title="播放 / 暂停（空格）" onClick={toggle}>{state.paused ? <Play size={22} fill="currentColor" /> : <Pause size={22} fill="currentColor" />}</button>
          <button className="lmd-desktop-control" aria-label="快退5秒" onClick={() => seekBy(-5)}><RotateCcw size={18} /></button><button className="lmd-desktop-control" aria-label="快进5秒" onClick={() => seekBy(5)}><RotateCw size={18} /></button>
          {nextMedia && <button aria-label="下一集" onClick={onNext}><SkipForward size={20} /></button>}
          <span className="lmd-time">{time(preview ?? state.currentTime)} <span>/ {time(state.duration)}</span></span><div className="lmd-control-spacer" />
          <button className={danmaku.options.enabled ? "is-active" : ""} aria-label={danmaku.options.enabled ? "关闭弹幕" : "开启弹幕"} aria-pressed={danmaku.options.enabled} onClick={() => danmaku.update({ enabled: !danmaku.options.enabled })}><MessageSquare size={19} /></button>
          <button className="lmd-desktop-control" aria-label="弹幕设置" onClick={() => openPanel("danmaku")}>弹幕</button>
          <button aria-label="字幕选择" className={selected ? "is-active" : ""} onClick={() => openPanel("subtitles")}><Captions size={21} /></button>
          <button aria-label="播放设置" onClick={() => openPanel("settings")}><span className="lmd-rate">{state.playbackRate}×</span><Settings2 size={17} /></button>
          <div className="lmd-volume lmd-desktop-control"><button aria-label={state.muted ? "取消静音" : "静音"} onClick={() => core?.setMuted(!state.muted)}>{state.muted || state.volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>{!ios() && <input aria-label="音量" type="range" min="0" max="1" step="0.01" value={state.muted ? 0 : state.volume} onChange={e => core?.setVolume(+e.target.value)} />}</div>
          <button aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={() => void fullscreenToggle()}>{fullscreen ? <Minimize size={21} /> : <Maximize size={21} />}</button>
        </div>
      </div>}
      {!locked && panel && <div className="lmd-settings-panel" onPointerDown={e => e.stopPropagation()}><header><strong>{panel === "subtitles" ? "字幕" : panel === "danmaku" ? "弹幕" : "播放设置"}</strong><button aria-label="关闭设置" onClick={() => setPanel("")}><X size={18} /></button></header>
        {panel === "subtitles" && <div className="lmd-panel-fields"><label>字幕轨道<select value={subtitleId} onChange={e => setSubtitleId(e.target.value)}><option value="off">关闭字幕</option>{media.subtitles.map(s => <option key={s.id} value={s.id}>{s.language} · {s.format} · {s.name}</option>)}</select></label>
          {selected && ["ASS", "SSA"].includes(selected.format) && <label>渲染方式<select value={subtitleMode} onChange={e => setSubtitleMode(e.target.value as "styled" | "text")}><option value="styled">ASS 特效 · libass</option><option value="text">纯文本后备模式</option></select></label>}
          <label>延后秒数<input type="number" min="-3600" max="3600" step="0.1" value={delay} onChange={e => setDelay(Number(e.target.value) || 0)} /></label><p>正值延后，负值提前。字幕与原视频时间同步。</p>{subtitleError && <p role="status" className="lmd-panel-message">{subtitleError}</p>}</div>}
        {panel === "danmaku" && <DanmakuPanel controller={danmaku} currentTime={state.currentTime} />}
        {panel === "settings" && <div className="lmd-panel-fields"><label>播放速度<select value={state.playbackRate} onChange={e => core?.setPlaybackRate(+e.target.value)}>{[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
          <label>长按倍速<select value={holdRate} onChange={e => { setHoldRate(+e.target.value); persist("lmd:player:holdRate", +e.target.value); }}><option value={2}>2×</option><option value={3}>3×</option></select></label>
          <label>音轨<select value={state.audioTrackId || ""} disabled={!state.audioTrackId} onChange={e => void core?.selectAudioTrack(e.target.value)}>{state.tracks.filter(t => t.type === "audio").map(t => <option key={t.id} value={t.id}>{t.language} · {t.title || t.codec.toUpperCase()} · {t.channels} 声道</option>)}</select></label>
          <button onClick={() => openPanel("danmaku")}>弹幕来源与校准</button><button onClick={() => core?.setMuted(!state.muted)}>{state.muted ? "取消静音" : "静音"}</button><p>{ios() ? "音量请使用设备按键。左侧滑动只调节网页画面亮度。" : "左右键快进快退，长按右键临时倍速，F 全屏。"}</p>
          <details><summary>播放信息</summary><p>{state.strategy || "准备中"} · {state.transport}</p><p>首帧 {state.firstFrameMs ?? "—"} ms · Seek {state.lastSeekMs ?? "—"} ms</p><p>{media.width} × {media.height}{media.hdr ? ` · ${media.hdr}` : ""}</p></details></div>}
      </div>}
    </div>
    {subtitleError && !panel && <div className="lmd-subtitle-notice" role="status">{subtitleError}<button onClick={() => openPanel("subtitles")}>字幕设置</button></div>}
    {pageMode && <div className="player-episode-nav" aria-label="剧集导航"><button className="previous-episode-button" onClick={onPrevious} disabled={!previousMedia}><SkipBack size={18} /><span>{previousMedia ? "上一集" : "已是第一集"}</span></button><button className="next-episode-button" onClick={onNext} disabled={!nextMedia}><span>{nextMedia ? "下一集" : "已是最后一集"}</span><SkipForward size={18} /></button></div>}
  </div>;
  return pageMode ? player : <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`播放 ${label(media)}`}>{player}</div>;
}
