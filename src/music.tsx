import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { updateMediaSession, releaseMediaSession } from "./media-session";
import {
  Disc3,
  FileMusic,
  FolderOpen,
  HardDrive,
  ListMusic,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
} from "lucide-react";

export type MusicTrack = {
  id: string;
  libraryId: string;
  title: string;
  fileName: string;
  path?: string;
  extension: string;
  size: number;
  modifiedAt: string;
  artists: string[];
  album: string;
  albumArtist: string;
  year: number | null;
  genres: string[];
  discNumber: number | null;
  trackNumber: number | null;
  durationSeconds: number;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  codec: string | null;
  container: string;
  lossless: boolean;
  tags: string[];
  folderId: string;
  streamUrl: string;
  compatibleUrl: string | null;
  preferredMime: string;
  coverUrls: { 256?: string; 1024?: string } | null;
  lyricsUrl: string | null;
  lyrics: { synchronized: boolean; wordTimed: boolean; source: string } | null;
  compatibleStatus: "waiting" | "queued" | "running" | "failed" | "ready" | "not-needed";
  metadataSource: "local" | string;
  externalIds: Record<string, string>;
};

export type MusicFolder = {
  id: string;
  parentId: string | null;
  name: string;
  title: string;
  configured: boolean;
  directMediaCount: number;
  mediaCount: number;
  childCount: number;
  coverMediaId: string | null;
  kind: "music";
};

export type MusicCatalog = {
  tracks: MusicTrack[];
  folders: MusicFolder[];
  scan: { scanning: boolean; phase: string; progressPercent: number | null; processedFiles: number; totalFiles: number; lastError: string | null };
};

export type MusicOverview = {
  libraries: Array<{ id: string; name: string; path: string }>;
  tracks: MusicTrack[];
  jobs: Array<{ id: string; mediaId: string; title: string; type: string; status: string; progress: number; message: string }>;
  scanning: boolean;
  scan: MusicCatalog["scan"] & { mode?: string | null };
};

export type MusicLyrics = {
  synchronized: boolean;
  wordTimed: boolean;
  source: string;
  metadata: Record<string, string>;
  plainText: string;
  lines: Array<{
    startMs: number;
    endMs: number;
    text: string;
    words?: Array<{ startMs: number; endMs: number; text: string }>;
  }>;
};

type PlayMode = "sequence" | "repeat-one" | "shuffle";

type MusicPlayerValue = {
  currentTrack: MusicTrack | null;
  currentTime: number;
  duration: number;
  playing: boolean;
  mode: PlayMode;
  setMode: (mode: PlayMode) => void;
  playTrack: (track: MusicTrack, queue: MusicTrack[], autoplay?: boolean) => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  previous: () => void;
  next: () => void;
};

const MusicPlayerContext = createContext<MusicPlayerValue | null>(null);

function useMusicPlayer() {
  const value = useContext(MusicPlayerContext);
  if (!value) throw new Error("MusicPlayerProvider is missing");
  return value;
}

function absoluteUrl(value: string) {
  return new URL(value, window.location.href).href;
}

function audioSource(track: MusicTrack) {
  return track.compatibleUrl || track.streamUrl;
}

function sortTracks(tracks: MusicTrack[]) {
  return [...tracks].sort((left, right) =>
    (left.discNumber ?? 1) - (right.discNumber ?? 1)
    || (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
    || left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" }));
}

function durationLabel(seconds = 0) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function artistLabel(track: MusicTrack) {
  return track.artists.join(" / ") || track.albumArtist || "未知艺术家";
}

function coverUrl(track: MusicTrack | null, large = false) {
  if (!track?.coverUrls) return "";
  return (large ? track.coverUrls[1024] : track.coverUrls[256]) || track.coverUrls[1024] || track.coverUrls[256] || "";
}

function MusicArtwork({ track, className = "", large = false }: { track: MusicTrack | null; className?: string; large?: boolean }) {
  const source = coverUrl(track, large);
  return (
    <div className={`music-artwork ${className}`}>
      {source ? <img src={source} alt={track ? `${track.album || track.title} 的专辑封面` : "专辑封面"} /> : <Music2 size={large ? 72 : 30} aria-hidden="true" />}
    </div>
  );
}

export function MusicPlayerProvider({ catalog, children }: { catalog: MusicCatalog | null; children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const catalogRef = useRef(catalog);
  const currentIdRef = useRef<string | null>(null);
  const queueRef = useRef<string[]>([]);
  const modeRef = useRef<PlayMode>("sequence");
  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [mode, setModeState] = useState<PlayMode>("sequence");
  catalogRef.current = catalog;
  currentIdRef.current = currentTrackId;
  queueRef.current = queueIds;
  modeRef.current = mode;

  const currentTrack = catalog?.tracks.find((track) => track.id === currentTrackId) || null;

  const activateById = useCallback((trackId: string, autoplay = true) => {
    const track = catalogRef.current?.tracks.find((item) => item.id === trackId);
    const audio = audioRef.current;
    if (!track || !audio) return;
    const source = absoluteUrl(audioSource(track));
    if (currentIdRef.current !== track.id || audio.src !== source) {
      audio.src = source;
      audio.load();
      setCurrentTime(0);
      setDuration(track.durationSeconds || 0);
    }
    currentIdRef.current = track.id;
    setCurrentTrackId(track.id);
    if (autoplay) void audio.play().catch(() => setPlaying(false));
  }, []);

  const playTrack = useCallback((track: MusicTrack, queue: MusicTrack[], autoplay = true) => {
    const sortedQueue = sortTracks(queue.length ? queue : [track]);
    const ids = sortedQueue.map((item) => item.id);
    queueRef.current = ids;
    setQueueIds(ids);
    activateById(track.id, autoplay);
  }, [activateById]);

  const next = useCallback(() => {
    const ids = queueRef.current;
    if (!ids.length) return;
    const currentIndex = Math.max(0, ids.indexOf(currentIdRef.current || ""));
    let nextIndex = currentIndex + 1;
    if (modeRef.current === "shuffle" && ids.length > 1) {
      do nextIndex = Math.floor(Math.random() * ids.length); while (nextIndex === currentIndex);
    } else if (nextIndex >= ids.length) nextIndex = 0;
    activateById(ids[nextIndex], true);
  }, [activateById]);

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 4) {
      audio.currentTime = 0;
      return;
    }
    const ids = queueRef.current;
    if (!ids.length) return;
    const currentIndex = Math.max(0, ids.indexOf(currentIdRef.current || ""));
    activateById(ids[(currentIndex - 1 + ids.length) % ids.length], true);
  }, [activateById]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
    setCurrentTime(audio.currentTime);
  }, []);

  const setMode = useCallback((nextMode: PlayMode) => {
    modeRef.current = nextMode;
    setModeState(nextMode);
  }, []);

  const handleEnded = useCallback(() => {
    if (modeRef.current === "repeat-one") {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        void audio.play();
      }
      return;
    }
    next();
  }, [next]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    updateMediaSession("music", { priority: 10, handlers: {
      play: () => void audioRef.current?.play(), pause: () => audioRef.current?.pause(),
      previoustrack: previous, nexttrack: next,
      seekto: details => { if (typeof details.seekTime === "number") seek(details.seekTime); },
      seekbackward: details => seek((audioRef.current?.currentTime || 0) - (details.seekOffset || 10)),
      seekforward: details => seek((audioRef.current?.currentTime || 0) + (details.seekOffset || 10)),
    } });
    return () => {
      releaseMediaSession("music");
    };
  }, [next, previous, seek]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
    const artwork = [256, 1024]
      .map((size) => currentTrack.coverUrls?.[size as 256 | 1024])
      .filter(Boolean)
      .map((src, index) => ({ src: absoluteUrl(src!), sizes: index ? "1024x1024" : "256x256", type: "image/jpeg" }));
    updateMediaSession("music", { metadata: new MediaMetadata({
      title: currentTrack.title,
      artist: artistLabel(currentTrack),
      album: currentTrack.album || "本地音乐",
      artwork,
    }) });
  }, [currentTrack]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    updateMediaSession("music", { playbackState: playing ? "playing" : currentTrack ? "paused" : "none" });
  }, [currentTrack, playing]);

  const updatePosition = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextDuration = Number.isFinite(audio.duration) ? audio.duration : currentTrack?.durationSeconds || 0;
    setCurrentTime(audio.currentTime || 0);
    setDuration(nextDuration);
    if ("mediaSession" in navigator && nextDuration > 0 && audio.currentTime >= 0 && audio.currentTime <= nextDuration) {
      updateMediaSession("music", { position: { duration: nextDuration, playbackRate: audio.playbackRate, position: audio.currentTime } });
    }
  };

  const value = useMemo<MusicPlayerValue>(() => ({
    currentTrack,
    currentTime,
    duration,
    playing,
    mode,
    setMode,
    playTrack,
    toggle,
    seek,
    previous,
    next,
  }), [currentTime, currentTrack, duration, mode, next, playTrack, playing, previous, seek, setMode]);

  return (
    <MusicPlayerContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        className="persistent-music-audio"
        preload="metadata"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onDurationChange={updatePosition}
        onLoadedMetadata={updatePosition}
        onTimeUpdate={updatePosition}
        onEnded={handleEnded}
        onError={() => setPlaying(false)}
      />
    </MusicPlayerContext.Provider>
  );
}

function openTrackRoute(track: MusicTrack) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("section", "music");
  nextUrl.searchParams.set("folder", track.folderId);
  nextUrl.searchParams.set("track", track.id);
  nextUrl.searchParams.delete("video");
  nextUrl.searchParams.delete("series");
  window.history.pushState({ section: "music", folder: track.folderId, track: track.id }, "", nextUrl);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}

function ModeButton({ mode, setMode }: Pick<MusicPlayerValue, "mode" | "setMode">) {
  const nextMode: PlayMode = mode === "sequence" ? "repeat-one" : mode === "repeat-one" ? "shuffle" : "sequence";
  const label = mode === "sequence" ? "顺序播放" : mode === "repeat-one" ? "单曲循环" : "随机播放";
  return <button type="button" className="music-control-button" onClick={() => setMode(nextMode)} aria-label={`${label}，点击切换播放模式`} title={`${label}，点击切换`}>{mode === "repeat-one" ? <Repeat1 size={16} /> : mode === "shuffle" ? <Shuffle size={16} /> : <Repeat size={16} />}</button>;
}

function folderCover(folder: MusicFolder, catalog: MusicCatalog) {
  return folder.coverMediaId ? catalog.tracks.find((track) => track.id === folder.coverMediaId) || null : null;
}

function tracksUnderFolder(catalog: MusicCatalog, folderId: string) {
  const tracksByFolder = new Map<string, MusicTrack[]>();
  for (const track of catalog.tracks) {
    const tracks = tracksByFolder.get(track.folderId) || [];
    tracks.push(track);
    tracksByFolder.set(track.folderId, tracks);
  }
  const childrenByFolder = new Map<string, MusicFolder[]>();
  for (const folder of catalog.folders) {
    if (!folder.parentId) continue;
    const children = childrenByFolder.get(folder.parentId) || [];
    children.push(folder);
    childrenByFolder.set(folder.parentId, children);
  }
  for (const children of childrenByFolder.values()) {
    children.sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  }
  const queue: MusicTrack[] = [];
  const visited = new Set<string>();
  const collect = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    queue.push(...sortTracks(tracksByFolder.get(id) || []));
    for (const child of childrenByFolder.get(id) || []) collect(child.id);
  };
  collect(folderId);
  return queue;
}

function MusicFolderCard({ folder, catalog, onOpen, action = "open" }: { folder: MusicFolder; catalog: MusicCatalog; onOpen: () => void; action?: "open" | "play" }) {
  const cover = folderCover(folder, catalog);
  const presentsAlbum = Boolean(cover?.album && !folder.childCount);
  const title = presentsAlbum ? cover!.album : folder.title;
  const detail = presentsAlbum
    ? `${artistLabel(cover!)} · ${folder.mediaCount} 首歌曲`
    : folder.childCount ? `${folder.childCount} 个子文件夹 · ${folder.mediaCount} 首歌曲` : `${folder.directMediaCount} 首歌曲`;
  const kindLabel = presentsAlbum ? "专辑" : "音乐文件夹";
  return (
    <article className="music-folder-card">
      <button type="button" className="music-folder-cover" onClick={onOpen} aria-label={`${action === "play" ? "播放" : "打开"}${kindLabel} ${title}`}>
        <MusicArtwork track={cover} large />
        <span className="music-folder-badge">{action === "play" ? <Play size={13} fill="currentColor" /> : <FileMusic size={13} />}{action === "play" ? "播放" : presentsAlbum ? "专辑" : "文件夹"}</span>
      </button>
      <h3 title={title}>{title}</h3>
      <p>{detail}</p>
    </article>
  );
}

function MusicTrackList({ tracks, onOpen, emptyText = "此处还没有歌曲" }: { tracks: MusicTrack[]; onOpen: (track: MusicTrack) => void; emptyText?: string }) {
  if (!tracks.length) return <div className="music-empty"><Music2 size={25} /><span>{emptyText}</span></div>;
  return (
    <div className="music-track-list">
      {tracks.map((track) => (
        <button type="button" className="music-track-row" key={track.id} onClick={() => onOpen(track)}>
          <MusicArtwork track={track} />
          <span className="music-track-number">{track.trackNumber ? String(track.trackNumber).padStart(2, "0") : <Music2 size={15} />}</span>
          <span className="music-track-title"><strong>{track.title}</strong><small>{artistLabel(track)}</small></span>
          <span className="music-track-album">{track.album || "未标记专辑"}</span>
          <span className="music-track-quality">{track.lossless ? "无损" : track.extension}<small>{track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : track.codec || track.extension}{track.bitDepth ? ` · ${track.bitDepth}-bit` : ""}</small></span>
          <span className="music-track-duration">{durationLabel(track.durationSeconds)}</span>
          <Play size={16} className="music-track-play" />
        </button>
      ))}
    </div>
  );
}

function trackMatches(track: MusicTrack, normalizedSearch: string) {
  return `${track.title} ${track.fileName} ${track.artists.join(" ")} ${track.album} ${track.albumArtist} ${track.genres.join(" ")}`.toLowerCase().includes(normalizedSearch);
}

export function MusicHomeSection({ catalog, search, onOpenFolder, onOpenTrack }: {
  catalog: MusicCatalog | null;
  search: string;
  onOpenFolder: (folderId: string) => void;
  onOpenTrack: (track: MusicTrack) => void;
}) {
  const player = useMusicPlayer();
  const normalizedSearch = search.trim().toLowerCase();
  const roots = (catalog?.folders || []).filter((folder) => folder.parentId === null)
    .filter((folder) => !normalizedSearch || `${folder.title} ${folder.name}`.toLowerCase().includes(normalizedSearch))
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true }));
  const matchingTracks = normalizedSearch ? sortTracks((catalog?.tracks || []).filter((track) => trackMatches(track, normalizedSearch))) : [];
  const openTrack = (track: MusicTrack) => {
    const queue = sortTracks((catalog?.tracks || []).filter((item) => item.folderId === track.folderId));
    player.playTrack(track, queue, true);
    onOpenTrack(track);
  };
  const openFolder = (folder: MusicFolder) => {
    const queue = catalog ? tracksUnderFolder(catalog, folder.id) : [];
    if (!folder.childCount && queue.length) {
      player.playTrack(queue[0], queue, true);
      onOpenTrack(queue[0]);
      return;
    }
    onOpenFolder(folder.id);
  };
  return (
    <section className="media-section music-library-section">
      <div className="section-heading"><div><span className="section-kicker">MUSIC</span><h2>全部音乐目录</h2></div><span className="media-count">{roots.length} 个文件夹 · {catalog?.tracks.length || 0} 首歌曲</span></div>
      {roots.length ? <div className="music-folder-grid">{roots.map((folder) => <MusicFolderCard key={folder.id} folder={folder} catalog={catalog!} action={!folder.childCount && folder.mediaCount ? "play" : "open"} onOpen={() => openFolder(folder)} />)}</div> : !normalizedSearch && <div className="client-empty music-home-empty"><Disc3 size={30} /><strong>音乐库暂时为空</strong><span>在本机管理端添加音乐目录并扫描后，会在这里按磁盘层级显示。</span></div>}
      {normalizedSearch && <div className="music-search-results"><h3>歌曲搜索结果</h3><MusicTrackList tracks={matchingTracks} onOpen={openTrack} emptyText="没有匹配的歌曲、艺术家或专辑" /></div>}
    </section>
  );
}

export function MusicFolderView({ catalog, folderId, search, onOpenFolder, onOpenTrack, onBackToLibrary }: {
  catalog: MusicCatalog;
  folderId: string | null;
  search: string;
  onOpenFolder: (folderId: string) => void;
  onOpenTrack: (track: MusicTrack) => void;
  onBackToLibrary: () => void;
}) {
  const player = useMusicPlayer();
  const folderById = useMemo(() => new Map(catalog.folders.map((folder) => [folder.id, folder])), [catalog.folders]);
  const rootFolders = catalog.folders.filter((folder) => folder.parentId === null);
  const singleRootFolder = rootFolders.length === 1 ? rootFolders[0] : null;
  const currentFolder = folderById.get(folderId || "") || singleRootFolder;
  const normalizedSearch = search.trim().toLowerCase();
  const childFolders = catalog.folders.filter((folder) => currentFolder ? folder.parentId === currentFolder.id : folder.parentId === null)
    .filter((folder) => !normalizedSearch || `${folder.title} ${folder.name}`.toLowerCase().includes(normalizedSearch));
  const directQueue = sortTracks(catalog.tracks.filter((track) => track.folderId === currentFolder?.id));
  const currentQueue = useMemo(() => currentFolder ? tracksUnderFolder(catalog, currentFolder.id) : [], [catalog, currentFolder?.id]);
  const visibleTracks = normalizedSearch ? sortTracks(catalog.tracks.filter((track) => trackMatches(track, normalizedSearch))) : directQueue;
  const trail: MusicFolder[] = [];
  const visited = new Set<string>();
  let ancestor = currentFolder;
  while (ancestor && !visited.has(ancestor.id)) {
    trail.unshift(ancestor);
    visited.add(ancestor.id);
    ancestor = ancestor.parentId ? folderById.get(ancestor.parentId) || null : null;
  }
  const visibleTrail = singleRootFolder ? trail.filter((folder) => folder.id !== singleRootFolder.id) : trail;
  const play = (track: MusicTrack) => {
    const queue = sortTracks(catalog.tracks.filter((item) => item.folderId === track.folderId));
    player.playTrack(track, queue, true);
    onOpenTrack(track);
  };
  const openFolder = (folder: MusicFolder) => {
    const queue = tracksUnderFolder(catalog, folder.id);
    if (!folder.childCount && queue.length) {
      player.playTrack(queue[0], queue, true);
      onOpenTrack(queue[0]);
      return;
    }
    onOpenFolder(folder.id);
  };
  if (!catalog.folders.length) return <div className="empty-state"><Music2 size={24} /><strong>音乐目录暂时为空</strong><span>在管理端添加音乐目录并扫描后，会在这里列出你的音乐。</span></div>;
  const atLibraryRoot = !folderId || folderId === singleRootFolder?.id;
  return (
    <div className="mus-view">
      <div className="lib-toolbar">
        <nav className="crumbs" aria-label="当前音乐文件夹路径">{atLibraryRoot ? <span aria-current="page">全部音乐</span> : <><button type="button" onClick={onBackToLibrary}>全部音乐</button>{visibleTrail.map((folder) => <React.Fragment key={folder.id}><span className="crumbs-sep">/</span><button type="button" onClick={() => onOpenFolder(folder.id)} aria-current={folder.id === currentFolder?.id ? "page" : undefined}>{folder.title}</button></React.Fragment>)}</>}</nav>
        <span className="lib-stats">{childFolders.length} 个文件夹 · {normalizedSearch ? visibleTracks.length : currentFolder ? currentQueue.length : catalog.tracks.length} 首歌曲</span>
        {currentFolder && !!currentQueue.length && <div className="lib-toolbar-actions"><button type="button" className="btn btn--sm" onClick={() => player.playTrack(currentQueue[0], currentQueue, true)}><Play size={14} fill="currentColor" />播放当前文件夹</button></div>}
      </div>
      {childFolders.length > 0 && <div className="mus-folders">{childFolders.map((folder) => <MusicFolderCard key={folder.id} folder={folder} catalog={catalog} action={!folder.childCount && folder.mediaCount ? "play" : "open"} onOpen={() => openFolder(folder)} />)}</div>}
      {visibleTracks.length > 0 && <div className="track-list">{visibleTracks.map((track, index) => <button type="button" className={`track-row${player.currentTrack?.id === track.id ? " is-playing" : ""}`} key={track.id} onClick={() => play(track)}><span className="track-index">{player.currentTrack?.id === track.id ? <span className="track-eq" aria-hidden="true"><i /><i /><i /></span> : index + 1}</span><MusicArtwork track={track} className="track-art" /><span className="track-main"><span className="track-title">{track.title}</span><span className="track-artist">{artistLabel(track)}</span></span><span className="track-album">{track.album || "未标记专辑"}</span><span className="track-duration">{durationLabel(track.durationSeconds)}</span></button>)}</div>}
      {!visibleTracks.length && (normalizedSearch || !childFolders.length) && <div className="empty-state"><Music2 size={24} /><strong>{normalizedSearch ? "没有匹配的歌曲、艺术家或专辑" : "这个文件夹暂时没有歌曲"}</strong></div>}
    </div>
  );
}

export function MusicFullPlayer({ catalog, trackId }: { catalog: MusicCatalog; trackId: string }) {
  const player = useMusicPlayer();
  const tookOverRef = useRef(player.currentTrack?.id === trackId);
  const effectiveTrackId = tookOverRef.current && player.currentTrack ? player.currentTrack.id : trackId;
  const track = catalog.tracks.find((item) => item.id === effectiveTrackId) || null;
  const queue = useMemo(() => sortTracks(catalog.tracks.filter((item) => item.folderId === track?.folderId)), [catalog.tracks, track?.folderId]);
  const [lyrics, setLyrics] = useState<MusicLyrics | null>(null);
  const [lyricsError, setLyricsError] = useState("");
  const [following, setFollowing] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [mobileView, setMobileView] = useState<"player" | "lyrics">("player");
  const [mobileOverlayVisible, setMobileOverlayVisible] = useState(false);
  const [lyricsScrolling, setLyricsScrolling] = useState(false);
  const resumeTimerRef = useRef<number | null>(null);
  const overlayTimerRef = useRef<number | null>(null);
  const lyricsScrollTimerRef = useRef<number | null>(null);
  const queueRowRef = useRef<HTMLButtonElement | null>(null);
  const queueButtonRef = useRef<HTMLButtonElement | null>(null);
  const queuePopupRef = useRef<HTMLDivElement | null>(null);
  const fullPlayerRef = useRef<HTMLDivElement | null>(null);
  const coverRef = useRef<HTMLButtonElement | null>(null);
  const coverPrevRectRef = useRef<DOMRect | null>(null);
  const coverAnimationRef = useRef<Animation | null>(null);
  const viewAnimationsRef = useRef<Animation[]>([]);
  const viewChangePendingRef = useRef(false);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const lyricsScrollRef = useRef<HTMLDivElement | null>(null);
  const ignoreLyricsScrollUntilRef = useRef(0);
  const queueOpenRef = useRef(queueOpen);
  queueOpenRef.current = queueOpen;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => { if (queueOpen) queueRowRef.current?.scrollIntoView({ block: "nearest" }); }, [track?.id, queueOpen]);

  useEffect(() => {
    if (!queueOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (queuePopupRef.current?.contains(target) || queueButtonRef.current?.contains(target))) return;
      setQueueOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setQueueOpen(false); };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [queueOpen]);

  useEffect(() => {
    if (track && player.currentTrack?.id !== track.id) {
      tookOverRef.current = true;
      player.playTrack(track, queue, false);
    }
  }, [player.currentTrack?.id, player.playTrack, queue, track]);

  const playingTrackId = player.currentTrack?.id;
  useEffect(() => {
    if (!tookOverRef.current || !playingTrackId || playingTrackId === trackId) return;
    const liveTrack = catalog.tracks.find((item) => item.id === playingTrackId);
    if (liveTrack) openTrackRoute(liveTrack);
  }, [catalog.tracks, playingTrackId, trackId]);

  const toggleMobileView = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (!narrow) return;
    if (event.detail > 0) event.currentTarget.blur();
    if (viewChangePendingRef.current) return;
    viewAnimationsRef.current.forEach((animation) => animation.cancel());
    viewAnimationsRef.current = [];

    const commitViewChange = (nextView: "player" | "lyrics") => {
      coverPrevRectRef.current = coverRef.current?.getBoundingClientRect() ?? null;
      coverAnimationRef.current?.cancel();
      setMobileView(nextView);
      if (window.scrollY) window.scrollTo({ top: 0, behavior: "auto" });
    };

    if (mobileView === "lyrics" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      commitViewChange(mobileView === "player" ? "lyrics" : "player");
      return;
    }

    const exiting = Array.from(fullPlayerRef.current?.querySelectorAll<HTMLElement>(".music-now-meta, .music-player-progress, .music-player-controls, .music-technical") ?? []);
    if (!exiting.length) {
      commitViewChange("lyrics");
      return;
    }

    viewChangePendingRef.current = true;
    // 控件淡出与封面移动同时进行：控件开始淡出后短暂延迟即提交视图切换，
    // 封面在控件尚未完全淡出时就开始移动，不再等控件动画播完。
    const exitAnimations = exiting.map((element, index) => element.animate(
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(12px)" },
      ],
      {
        duration: 120,
        delay: index * 8,
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
        fill: "forwards",
      },
    ));
    viewAnimationsRef.current = exitAnimations;
    window.setTimeout(() => {
      if (!viewChangePendingRef.current) return;
      viewChangePendingRef.current = false;
      commitViewChange("lyrics");
    }, 100);
  }, [mobileView, narrow]);

  useLayoutEffect(() => {
    if (narrow && mobileView === "lyrics") {
      const container = lyricsScrollRef.current;
      const activeLine = activeLineRef.current;
      if (container && activeLine) {
        const lineTop = activeLine.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        ignoreLyricsScrollUntilRef.current = performance.now() + 900;
        container.scrollTo({ top: lineTop - container.clientHeight * 0.42 + activeLine.clientHeight / 2 });
      }
    }
    const previousViewAnimations = viewAnimationsRef.current;
    viewAnimationsRef.current = [];
    previousViewAnimations.forEach((animation) => animation.cancel());
    const cover = coverRef.current;
    const previous = coverPrevRectRef.current;
    coverPrevRectRef.current = null;
    if (!narrow || !cover || !previous) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const current = cover.getBoundingClientRect();
    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    const scaleX = previous.width / Math.max(1, current.width);
    const scaleY = previous.height / Math.max(1, current.height);
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1 || Math.abs(scaleX - 1) >= 0.02) {
      coverAnimationRef.current = cover.animate(
        [
          { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})` },
          { transformOrigin: "top left", transform: "translate(0, 0) scale(1)" },
        ],
        { duration: 280, easing: "cubic-bezier(0.77, 0, 0.175, 1)" },
      );
    }

    const meta = fullPlayerRef.current?.querySelector<HTMLElement>(".music-now-meta");
    const entering = mobileView === "lyrics"
      ? [fullPlayerRef.current?.querySelector<HTMLElement>(".music-lyrics-panel")]
      : Array.from(fullPlayerRef.current?.querySelectorAll<HTMLElement>(".music-player-progress, .music-player-controls, .music-technical") ?? []);
    const contentAnimations = entering.filter((element): element is HTMLElement => Boolean(element)).map((element, index) => element.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      {
        duration: 200,
        delay: Math.min(index * 20, 60),
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      },
    ));
    const metaAnimation = meta?.animate(
      [
        { opacity: 0 },
        { offset: 0.62, opacity: 0 },
        { opacity: 1 },
      ],
      { duration: 280, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
    viewAnimationsRef.current = metaAnimation ? [metaAnimation, ...contentAnimations] : contentAnimations;
  }, [mobileView, narrow]);

  const revealMobileControls = useCallback(() => {
    if (!narrow || mobileView !== "lyrics") return;
    setMobileOverlayVisible(true);
    if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = window.setTimeout(() => {
      overlayTimerRef.current = null;
      setMobileOverlayVisible((visible) => (queueOpenRef.current ? visible : false));
    }, 4000);
  }, [mobileView, narrow]);

  useEffect(() => {
    if (!narrow || mobileView !== "lyrics") {
      setMobileOverlayVisible(false);
      setLyricsScrolling(false);
      if (lyricsScrollTimerRef.current !== null) {
        window.clearTimeout(lyricsScrollTimerRef.current);
        lyricsScrollTimerRef.current = null;
      }
      return;
    }
    revealMobileControls();
  }, [mobileView, narrow, revealMobileControls]);

  useEffect(() => () => {
    viewChangePendingRef.current = false;
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
    if (lyricsScrollTimerRef.current !== null) window.clearTimeout(lyricsScrollTimerRef.current);
    coverAnimationRef.current?.cancel();
    viewAnimationsRef.current.forEach((animation) => animation.cancel());
  }, []);

  const pauseFollowing = useCallback(() => {
    ignoreLyricsScrollUntilRef.current = 0;
    revealMobileControls();
    setFollowing(false);
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      setFollowing(true);
    }, 3000);
  }, [revealMobileControls]);

  const handleLyricsScroll = useCallback(() => {
    if (performance.now() < ignoreLyricsScrollUntilRef.current) return;
    setLyricsScrolling(true);
    if (lyricsScrollTimerRef.current !== null) window.clearTimeout(lyricsScrollTimerRef.current);
    lyricsScrollTimerRef.current = window.setTimeout(() => {
      lyricsScrollTimerRef.current = null;
      setLyricsScrolling(false);
    }, 520);
    pauseFollowing();
  }, [pauseFollowing]);

  useEffect(() => {
    let stopped = false;
    setLyrics(null);
    setLyricsError("");
    if (!track?.lyricsUrl) return;
    fetch(track.lyricsUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error("歌词暂不可用");
        return response.json() as Promise<MusicLyrics>;
      })
      .then((result) => { if (!stopped) setLyrics(!result.synchronized && looksLikeLrc(result.plainText) ? parseLrcText(result.plainText) : result); })
      .catch((error) => { if (!stopped) setLyricsError(error instanceof Error ? error.message : "歌词暂不可用"); });
    return () => { stopped = true; };
  }, [track?.lyricsUrl]);

  const currentMilliseconds = player.currentTime * 1000;
  const activeLineIndex = lyrics?.synchronized
    ? (() => {
        const found = lyrics.lines.findIndex((line, index) => currentMilliseconds >= line.startMs && currentMilliseconds < (lyrics.lines[index + 1]?.startMs ?? line.endMs));
        if (found >= 0) return found;
        if (lyrics.lines.length && currentMilliseconds >= lyrics.lines[lyrics.lines.length - 1].startMs) return lyrics.lines.length - 1;
        return 0;
      })()
    : -1;

  // 换句渐退渐出：本环境 CSS transition 不触发（实测无 CSSTransition 生成），
  // 改用 WAAPI 驱动（与 FLIP 过渡同一机制，已验证可靠）。
  // lyricLineTarget 给出每行静止态；行内样式写入静止态，
  // 下方 effect 在状态变化时用 element.animate 从上一状态平滑过渡。
  const prefersReducedLyricsMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lyricLineTarget = (index: number) => {
    if (!following || activeLineIndex < 0) return { opacity: 1, blur: 0 };
    if (index === activeLineIndex) return { opacity: 1, blur: 0 };
    const distance = Math.min(8, Math.abs(index - activeLineIndex));
    return {
      opacity: Math.max(0.28, 0.72 - distance * 0.06),
      blur: Math.min(3, 0.9 + distance * 0.35),
    };
  };
  const lyricLineStyle = (index: number): React.CSSProperties => {
    const target = lyricLineTarget(index);
    return { opacity: target.opacity, filter: `blur(${target.blur}px)` };
  };
  const lyricAnimTargetsRef = useRef<Map<number, { opacity: number; blur: number }>>(new Map());
  const lyricsForAnimRef = useRef<MusicLyrics | null>(null);
  useLayoutEffect(() => {
    const container = lyricsScrollRef.current;
    if (!container) return;
    if (lyricsForAnimRef.current !== lyrics) {
      lyricAnimTargetsRef.current.clear();
      lyricsForAnimRef.current = lyrics;
    }
    container.querySelectorAll<HTMLElement>(".music-lyric-line").forEach((element, index) => {
      const next = lyricLineTarget(index);
      const previous = lyricAnimTargetsRef.current.get(index);
      lyricAnimTargetsRef.current.set(index, next);
      if (!previous) return;
      if (previous.opacity === next.opacity && previous.blur === next.blur) return;
      element.getAnimations?.().forEach((animation) => animation.cancel());
      if (typeof element.animate !== "function") return;
      element.animate(
        [
          { opacity: String(previous.opacity), filter: `blur(${previous.blur}px)` },
          { opacity: String(next.opacity), filter: `blur(${next.blur}px)` },
        ],
        { duration: prefersReducedLyricsMotion ? 120 : 200, easing: "cubic-bezier(0.37, 0, 0.63, 1)" },
      );
    });
  }, [activeLineIndex, following, lyrics, prefersReducedLyricsMotion]);

  useEffect(() => {
    const container = lyricsScrollRef.current;
    const activeLine = activeLineRef.current;
    if (following && container && activeLine) {
      const lineTop = activeLine.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      const anchorRatio = narrow ? 0.18 : 0.42;
      ignoreLyricsScrollUntilRef.current = performance.now() + 900;
      container.scrollTo({ top: lineTop - container.clientHeight * anchorRatio + activeLine.clientHeight / 2, behavior: "smooth" });
    }
  }, [activeLineIndex, following, narrow]);

  if (!track) return <div className="empty-state"><Music2 size={24} /><strong>找不到这首歌</strong><span>它可能已被移动或移除，请返回列表重新选择。</span></div>;
  const total = player.duration || track.durationSeconds || 0;
  const queueInOverlay = narrow && mobileView === "lyrics";
  const progressBar = (
    <div className="music-player-progress">
      <input type="range" min={0} max={Math.max(total, 1)} step="0.01" value={Math.min(player.currentTime, Math.max(total, 1))} onChange={(event) => player.seek(Number(event.target.value))} aria-label="歌曲播放进度" />
      <div><span>{durationLabel(player.currentTime)}</span><span>{durationLabel(total)}</span></div>
    </div>
  );
  const queueAnchor = (
    <div className="music-queue-anchor">
      <button ref={queueButtonRef} type="button" className="music-queue-size" onClick={() => setQueueOpen((open) => !open)} aria-expanded={queueOpen} aria-haspopup="dialog" title="当前文件夹播放队列"><ListMusic size={15} /><span className="music-queue-count">{queue.length}</span></button>
      {queueOpen && (
        <div ref={queuePopupRef} className="mqueue" role="dialog" aria-label="播放队列">
          {queue.map((item, index) => (
            <button type="button" key={item.id} ref={item.id === track?.id ? queueRowRef : undefined} className={`music-queue-row${item.id === track?.id ? " current" : ""}`} onClick={() => player.playTrack(item, queue, true)}>
              <span className="music-queue-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="music-queue-title"><strong>{item.title}</strong><small>{artistLabel(item)}{item.album ? ` · ${item.album}` : ""}</small></span>
              <span className="music-queue-duration">{durationLabel(item.durationSeconds)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <div ref={fullPlayerRef} className={`music-player-layout${narrow ? ` view-${mobileView}` : ""}${!following ? " is-browsing-lyrics" : ""}${lyricsScrolling ? " is-scrolling-lyrics" : ""}`}>
      {coverUrl(track, true) && <div className="mplayer-ambient" style={{ backgroundImage: `url(${coverUrl(track, true)})` }} aria-hidden="true" />}
      <div className="mplayer-left">
        <button type="button" ref={coverRef} className="music-player-cover" onClick={toggleMobileView} aria-label={narrow ? (mobileView === "player" ? "打开滚动歌词" : "返回播放控制") : undefined}>
          <MusicArtwork track={track} large />
          {mobileView === "player" && <span className="music-cover-toggle-label" aria-hidden="true"><ListMusic size={15} /><span>歌词</span></span>}
        </button>
        <div className="music-now-meta">
          <h1>{track.title}</h1>
          <p>{artistLabel(track)}{track.album ? ` · ${track.album}` : ""}</p>
        </div>
        {progressBar}
        <div className="music-player-controls">
          <ModeButton mode={player.mode} setMode={player.setMode} />
          <button type="button" onClick={player.previous} aria-label="上一首"><SkipBack size={24} /></button>
          <button type="button" className="music-main-play" onClick={player.toggle} aria-label={player.playing ? "暂停" : "播放"}>{player.playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}</button>
          <button type="button" onClick={player.next} aria-label="下一首"><SkipForward size={24} /></button>
          {!queueInOverlay && queueAnchor}
        </div>
        <div className="music-technical">
          <span>{track.extension}</span><span>{track.codec || track.container}</span>
          {track.sampleRate && <span>{(track.sampleRate / 1000).toFixed(1)} kHz</span>}
          {track.bitDepth && <span>{track.bitDepth}-bit</span>}
          {track.channels && <span>{track.channels} 声道</span>}
          {track.lossless && <span className="lossless-chip">LOSSLESS</span>}
        </div>
      </div>
      <div className="music-lyrics-panel">
        <div ref={lyricsScrollRef} className="music-lyrics-scroll" onScroll={handleLyricsScroll} onWheel={pauseFollowing} onTouchStart={pauseFollowing} onPointerDown={pauseFollowing}>
          {lyrics?.synchronized ? lyrics.lines.map((line, index) => (
            <div key={`${line.startMs}-${index}`} ref={index === activeLineIndex ? activeLineRef : undefined} style={lyricLineStyle(index)} className={`music-lyric-line${index === activeLineIndex ? " active" : index < activeLineIndex ? " past" : " future"}`} onClick={() => { player.seek(line.startMs / 1000); setFollowing(true); }}>
              {line.words?.length ? line.words.map((word, wordIndex) => {
                const progress = currentMilliseconds <= word.startMs ? 0 : currentMilliseconds >= word.endMs ? 1 : (currentMilliseconds - word.startMs) / Math.max(1, word.endMs - word.startMs);
                return <span key={`${word.startMs}-${wordIndex}`} className={progress >= 1 ? "sung" : ""} style={{ "--word-progress": progress } as React.CSSProperties}>{word.text}</span>;
              }) : line.text}
            </div>
          )) : lyrics?.plainText ? <div className="music-plain-lyrics">{lyrics.plainText}</div> : <div className="music-no-lyrics"><Music2 size={24} /><strong>{lyricsError || "暂无歌词"}</strong><span>支持同名 LRC、增强 LRC 与音频内嵌歌词。</span></div>}
        </div>
      </div>
      {queueInOverlay && (
        <div className={`music-mobile-overlay${mobileOverlayVisible ? " show" : ""}`} onPointerDown={revealMobileControls}>
          <div className="music-mobile-overlay-controls" role="group" aria-label="歌词播放控制">
            <ModeButton mode={player.mode} setMode={player.setMode} />
            <button type="button" onClick={player.previous} aria-label="上一首"><SkipBack size={22} /></button>
            <button type="button" className="music-main-play" onClick={player.toggle} aria-label={player.playing ? "暂停" : "播放"}>{player.playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}</button>
            <button type="button" onClick={player.next} aria-label="下一首"><SkipForward size={22} /></button>
            {queueAnchor}
          </div>
        </div>
      )}
    </div>
  );
}

const LRC_LINE_PATTERN = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
const LRC_WORD_PATTERN = /<(\d{1,3}):(\d{2}(?:\.\d{1,3})?)>([^<]*)/g;

function looksLikeLrc(text: string) {
  return /\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/.test(text);
}

function parseLrcText(content: string): MusicLyrics | null {
  LRC_LINE_PATTERN.lastIndex = 0;
  const lines: MusicLyrics["lines"] = [];
  for (const rawLine of content.replace(/\r\n?/g, "\n").split("\n")) {
    LRC_LINE_PATTERN.lastIndex = 0;
    const timestamps = [...rawLine.matchAll(LRC_LINE_PATTERN)].map((match) => Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000));
    if (!timestamps.length) continue;
    LRC_WORD_PATTERN.lastIndex = 0;
    const wordMatches = [...rawLine.replace(/^(?:\[(?:\d{1,3}:\d{2}(?:\.\d{1,3})?)\])+/, "").matchAll(LRC_WORD_PATTERN)];
    const plainText = wordMatches.length
      ? wordMatches.map((match) => match[3]).join("").trim()
      : rawLine.replace(/^(?:\[(?:\d{1,3}:\d{2}(?:\.\d{1,3})?)\])+/, "").replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, "").trim();
    for (const startMs of timestamps) {
      const words = wordMatches.map((match) => ({ startMs: Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000), endMs: 0, text: match[3] }));
      for (let index = 0; index < words.length; index += 1) words[index].endMs = words[index + 1]?.startMs ?? startMs + 10000;
      lines.push({ startMs, endMs: 0, text: plainText, ...(words.length ? { words } : {}) });
    }
  }
  if (!lines.length) return null;
  lines.sort((left, right) => left.startMs - right.startMs);
  for (let index = 0; index < lines.length; index += 1) {
    lines[index].endMs = lines[index + 1]?.startMs ?? lines[index].startMs + 10000;
    for (const word of lines[index].words || []) if (word.endMs > lines[index].endMs) word.endMs = lines[index].endMs;
  }
  return { synchronized: true, wordTimed: lines.some((line) => line.words?.length), source: "embedded", metadata: {}, plainText: lines.map((line) => line.text).filter(Boolean).join("\n"), lines };
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

export function MusicAdminPanel({ overview, onRefresh, onNotice }: {
  overview: MusicOverview | null;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (notice: string) => void;
}) {
  const [folderPath, setFolderPath] = useState("");
  const [busy, setBusy] = useState(false);
  const activeJobs = overview?.jobs.filter((job) => ["queued", "running"].includes(job.status)) || [];
  const trackCountByLibrary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const track of overview?.tracks || []) counts.set(track.libraryId, (counts.get(track.libraryId) || 0) + 1);
    return counts;
  }, [overview?.tracks]);

  const register = async (selectedPath: string) => {
    const result = await requestJson<{ library: { id: string; name: string; path: string }; added: boolean }>("/api/music/libraries", { method: "POST", body: JSON.stringify({ folderPath: selectedPath }) });
    setFolderPath("");
    onNotice(result.added ? `已添加音乐目录：${result.library.path}。` : `音乐目录“${result.library.name}”已经存在。`);
    await onRefresh(true);
  };

  const chooseFolder = async () => {
    setBusy(true);
    try {
      onNotice("请在弹出的 Windows 窗口中选择音乐文件夹…");
      const result = await requestJson<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (result.cancelled || !result.path) onNotice("已取消选择音乐文件夹。");
      else await register(result.path);
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法选择音乐文件夹"); }
    finally { setBusy(false); }
  };

  const scan = async () => {
    setBusy(true);
    onNotice("正在读取音乐标签、封面与歌词；兼容性不足的无损格式会自动排队生成 FLAC。 ");
    try {
      const result = await requestJson<{ count: number }>("/api/music/catalog/scan?mode=turbo", { method: "POST" });
      onNotice(`音乐扫描完成，共发现 ${result.count} 首歌曲。`);
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "音乐扫描失败"); }
    finally { setBusy(false); }
  };

  const remove = async (library: MusicOverview["libraries"][number]) => {
    if (!window.confirm(`确定从 LMD 中移除音乐目录“${library.name}”吗？\n\n只移除索引与缓存，不会删除硬盘中的音乐文件。`)) return;
    setBusy(true);
    try {
      const result = await requestJson<{ removedTrackCount: number }>(`/api/music/libraries/${encodeURIComponent(library.id)}`, { method: "DELETE" });
      onNotice(`已移除音乐目录“${library.name}”及 ${result.removedTrackCount} 条歌曲索引；原文件未被删除。`);
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法移除音乐目录"); }
    finally { setBusy(false); }
  };

  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <div><h2>音乐目录</h2><p>按磁盘目录层级读取本地标签、专辑封面与歌词；不会修改音频原文件，也不会生成 AAC/MP3 副本。</p></div>
        <div className="adm-actions">
          <span className="lib-stats">{overview?.tracks.length || 0} 首歌曲 · {activeJobs.length} 个无损任务</span>
          <button type="button" className="btn" onClick={scan} disabled={busy || overview?.scanning || !overview?.libraries.length}><RefreshCw size={14} className={busy || overview?.scanning ? "spin" : ""} />扫描音乐</button>
        </div>
      </div>
      {overview?.scanning && <div className="music-admin-progress"><span style={{ width: `${overview.scan.progressPercent || 0}%` }} /></div>}
      <div className="adm-add">
        <button type="button" className="btn" onClick={chooseFolder} disabled={busy}><FolderOpen size={14} />选择并添加音乐文件夹</button>
        <input className="input" aria-label="音乐目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && folderPath.trim() && !busy) void register(folderPath.trim()); }} placeholder="也可以手动输入路径，按 Enter 添加" />
      </div>
      <div className="adm-rows">
        {overview?.libraries.length ? overview.libraries.map((library) => <div className="adm-row" key={library.id}><HardDrive size={15} /><div className="adm-row-main"><strong>{library.name}</strong><span>{library.path}</span></div><span className="adm-row-meta">{trackCountByLibrary.get(library.id) || 0} 首</span><button type="button" className="icon-btn icon-btn--danger" onClick={() => void remove(library)} disabled={busy} title={`移除音乐目录 ${library.name}`} aria-label={`移除音乐目录 ${library.name}`}><Trash2 size={14} /></button></div>) : <div className="empty-state"><HardDrive size={24} /><strong>还没有音乐目录</strong><span>添加后即可读取本地歌曲。</span></div>}
      </div>
      {!!activeJobs.length && <div className="music-job-list">{activeJobs.map((job) => <div key={job.id}><span><LoaderCircle size={15} className={job.status === "running" ? "spin" : ""} /></span><strong>{job.title}</strong><small>{job.message}</small><b>{job.progress}%</b></div>)}</div>}
    </section>
  );
}
