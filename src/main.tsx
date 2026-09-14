import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrandMark } from "./BrandMark";
import { VideoPlayer as PlayerModal } from "./player/Player";
import { PlayerTestPanel, playerTestRequested } from "./player/player-test";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Film,
  FolderOpen,
  FolderSearch,
  Gauge,
  HardDrive,
  Images,
  KeyRound,
  Library,
  LoaderCircle,
  LogOut,
  Moon,
  Music2,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sun,
  Trash2,
  UserRoundPlus,
  X,
} from "lucide-react";
import {
  MusicAdminPanel,
  MusicFolderView,
  MusicFullPlayer,
  MusicPlayerProvider,
  type MusicCatalog,
  type MusicOverview,
  type MusicTrack,
} from "./music";
import {
  ReadingAdminPanel,
  ReadingLibraryView,
  type ReadingCatalog,
  type ReadingFilter,
  type ReadingItem,
  type ReadingOverview,
} from "./reading";
import {
  PhotoAdminPanel,
  PhotoLibraryView,
  type PhotoCatalog,
  type PhotoItem,
  type PhotoOverview,
} from "./photos";
import "./styles.css";

type Subtitle = { id: string; name: string; format: string; language: string; url: string; size?: number; modifiedAt?: string };
type FontAsset = { id: string; name: string; url: string; size?: number; modifiedAt?: string; aliases?: string[] };
type BrowserCompatibility = {
  directPlayLikely: boolean;
  needsCompatibleCopy: boolean;
  canRemuxToMp4: boolean;
  issues: string[];
  deviceCodecDependent: boolean;
};
type QuickSelection = { number: number; label: string; kind: "episode" | "extra" };
type MediaDisplay = { groupId: string; folderId?: string; seriesTitle: string; season: number; episode: number; quickSelection: QuickSelection | null; alias: string; configured: boolean };
type Media = {
  id: string;
  title: string;
  fileName: string;
  path?: string;
  extension: string;
  size: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
  bitDepth?: number;
  hdr?: string | null;
  posterHue: number;
  streamUrl: string;
  remuxUrl?: string | null;
  thumbnailUrl?: string | null;
  subtitles: Subtitle[];
  fonts: FontAsset[];
  tags: string[];
  compatibility?: BrowserCompatibility;
  compatibleCopyStatus?: "waiting" | "queued" | "running" | "completed" | "failed" | "ready" | "not-needed";
  compatibleCopyProgress?: number;
  display?: MediaDisplay;
  demo?: boolean;
};
type LibraryFolder = { id: string; name: string; path: string };
type DisplayGroup = { id: string; folderName?: string; title: string; season: number; configured: boolean; mediaCount: number };
type DisplayFolder = DisplayGroup & { path: string; customTitle: string; sampleAlias: string; kind?: "music" | "video" | "reading" | "photo"; ebookCount?: number; spreadsheetCount?: number; libraryName?: string; relativePath?: string };
type CatalogFolder = {
  id: string;
  parentId: string | null;
  name: string;
  title: string;
  configured: boolean;
  directMediaCount: number;
  mediaCount: number;
  childCount: number;
  coverMediaId: string | null;
};
type Job = { id: string; mediaId: string; title: string; type: string; status: "queued" | "running" | "completed" | "failed"; progress: number; message: string };
type ToolStatus = { available: boolean; version?: string | null; hint?: string; installedVersion?: string | null; source?: "local" | "path" | null; installable?: boolean };
type MediaToolsInstallStatus = {
  status: "idle" | "downloading" | "extracting" | "installing" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  error: string;
  version?: string | null;
  installedVersion?: string | null;
  latestVersion?: string | null;
  bytesDownloaded: number;
  bytesTotal: number;
  startedAt?: string | null;
  finishedAt?: string | null;
};
type PlaybackSettings = { cacheMaxBytes: number; cacheTtlSeconds: number; aheadSeconds: number; backBufferSeconds: number;
  heartbeatSeconds: number; leaseSeconds: number; initialLeaseSeconds: number; releaseGraceSeconds: number; noOutputSeconds: number; cleanupSeconds: number;
  maxBufferBytes: number; encoder: "auto" | "libx264" | "h264_nvenc" | "h264_qsv" | "h264_amf" };
type PlaybackStatus = { sessions: number; pipelines: number; cacheBytes: number; cacheMaxBytes: number; sessionsCreated: number; sessionsReleased: number;
  pipelinesCreated: number; pipelinesReleased: number; cacheHits: number; fallbacks: number; seeks: number; audioTrackSwitches: number; bytesGenerated: number };
type DanmakuSettings = { appId: string; configured: boolean; environmentManaged: boolean };
type AccessUser = {
  id: string;
  categoryIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};
type AccessCategory = { id: string; name: string; folderIds: string[]; createdAt: string; updatedAt: string; system?: boolean };
type AccessControlOverview = { enabled: boolean; users: AccessUser[]; categories: AccessCategory[]; activeSessions: number };
type AccessStatus = { enabled: boolean; authenticated: boolean; localAdmin: boolean; user: { id: string } | null };
type RemuxAccelerationStatus = {
  enabled: boolean;
  expiresAt: string | null;
  remainingSeconds: number;
  maxParallelJobs: number;
  acceleratedParallelJobs: number;
  activeJobs: number;
  queuedJobs: number;
};
type Overview = {
  libraries: LibraryFolder[];
  media: Media[];
  jobs: Job[];
  tools: ToolStatus;
  settings: { maxStreams: number; cacheDirectory: string; compatibleCopyDirectory: string; autoScanEnabled: boolean; autoScanIntervalSeconds: number };
  scanning: boolean;
  activeVideoTransfers: number;
  lanAddresses: string[];
  autostart: { enabled: boolean; path: string };
  displayFolders: DisplayFolder[];
  accessFolders?: DisplayFolder[];
  accessControl: AccessControlOverview;
  remuxAcceleration: RemuxAccelerationStatus;
  scan: CatalogScanStatus;
};
type CatalogScanStatus = {
  enabled: boolean;
  scanning: boolean;
  intervalSeconds: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  id: string | null;
  mode: "standard" | "turbo" | null;
  pendingMode: "turbo" | null;
  phase: "idle" | "waiting" | "discovering" | "processing" | "finalizing" | "cancelling" | "cancelled" | "completed" | "failed";
  progressPercent: number | null;
  discoveredFiles: number;
  processedFiles: number;
  totalFiles: number;
  processedLibraries: number;
  totalLibraries: number;
  maxParallelFiles: number;
  maxParallelMediaTools?: number;
};
type Catalog = { media: Media[]; folders?: CatalogFolder[]; groups: DisplayGroup[]; scan: CatalogScanStatus };
type ThemeMode = "dark" | "light";
type AdminSection = "overview" | "access" | "settings";

const THEME_STORAGE_KEY = "lmd-theme";

const ACTIVE_SCAN_PHASES = new Set<CatalogScanStatus["phase"]>(["waiting", "discovering", "processing", "finalizing", "cancelling"]);

function scanIsActive(scan?: CatalogScanStatus | null) {
  return Boolean(scan && (scan.scanning || ACTIVE_SCAN_PHASES.has(scan.phase) || scan.pendingMode === "turbo"));
}

function scanPhaseLabel(scan?: CatalogScanStatus | null) {
  if (!scan) return "正在准备扫描";
  if (scan.pendingMode === "turbo" && scan.mode !== "turbo") return "等待当前扫描结束";
  return {
    idle: "等待开始",
    waiting: "正在调度急速扫描",
    discovering: "正在发现视频文件",
    processing: "正在读取媒体信息",
    finalizing: "正在保存媒体索引",
    cancelling: "正在停止最高性能扫描",
    cancelled: "扫描已手动停止",
    completed: "扫描已完成",
    failed: "扫描未完成",
  }[scan.phase];
}

function formatRemainingTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours} 小时 ${minutes} 分钟`;
  if (hours) return `${hours} 小时`;
  if (minutes) return `${minutes} 分钟`;
  return "不到 1 分钟";
}

function initialTheme(): ThemeMode {
  const documentTheme = document.documentElement.dataset.theme;
  if (documentTheme === "dark" || documentTheme === "light") return documentTheme;
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
  } catch {
    // Some private browsing modes can disable storage; the OS preference still works.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

class ApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) { super(message); this.name = "ApiError"; this.status = status; this.code = code; }
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers,
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error || "操作失败", response.status, result.code);
  return result as T;
}

async function optionalFeatureApi<T>(url: string, fallback: T): Promise<T> {
  try { return await api<T>(url); }
  catch (error) {
    // 兼容正在安全完成旧版转换任务、尚未重启到音乐后端的 8096 服务。
    if (error instanceof ApiError && error.status === 404) return fallback;
    throw error;
  }
}

function formatBytes(value: number) {
  if (!value) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds = 0) {
  if (!seconds) return "未知时长";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}小时${minutes}分` : `${minutes}分钟`;
}

function codecName(value?: string | null) {
  const known: Record<string, string> = { hevc: "HEVC", h264: "H.264", av1: "AV1", vp9: "VP9", aac: "AAC", dts: "DTS", opus: "Opus" };
  return value ? known[value.toLowerCase()] || value.toUpperCase() : "待识别";
}

function App() {
  const isAdminPath = window.location.pathname.startsWith("/admin");
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [musicOverview, setMusicOverview] = useState<MusicOverview | null>(null);
  const [readingOverview, setReadingOverview] = useState<ReadingOverview | null>(null);
  const [photoOverview, setPhotoOverview] = useState<PhotoOverview | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [musicCatalog, setMusicCatalog] = useState<MusicCatalog | null>(null);
  const [readingCatalog, setReadingCatalog] = useState<ReadingCatalog | null>(null);
  const [photoCatalog, setPhotoCatalog] = useState<PhotoCatalog | null>(null);
  const [accessStatus, setAccessStatus] = useState<AccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adminSection, setAdminSection] = useState<AdminSection>("overview");
  const [selectedMedia, setSelectedMedia] = useState<Media | null>(null);
  const refreshSequence = useRef(0);
  const hasLoadedOnce = useRef(false);
  const initialAdminOverviewLoaded = useRef(false);
  const previousAdminScanActive = useRef(false);
  const previousAdminJobsActive = useRef(false);
  const adminScanActive = Boolean(overview?.scanning || scanIsActive(overview?.scan));
  const adminJobsActive = Boolean(overview?.jobs.some((job) => job.status === "queued" || job.status === "running"));
  const musicAdminActive = Boolean(musicOverview?.scanning || musicOverview?.jobs.some((job) => job.status === "queued" || job.status === "running"));
  const readingAdminActive = Boolean(readingOverview?.scanning);
  const photoAdminActive = Boolean(photoOverview?.scanning);

  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++refreshSequence.current;
    try {
      // LoadingScreen 只用于首次加载；后续刷新（含管理端操作后的非静默刷新）
      // 不再整树卸载界面，避免播放器预览被中断。
      if (!quiet && !hasLoadedOnce.current) setLoading(true);
      if (isAdminPath) {
        let bootstrapActivity: { scanning: boolean; scan: CatalogScanStatus; jobs: Job[]; remuxAcceleration: RemuxAccelerationStatus } | null = null;
        if (!quiet && !initialAdminOverviewLoaded.current) {
          bootstrapActivity = await api("/api/scan/status");
        }
        const [nextOverview, nextMusicOverview, nextReadingOverview, nextPhotoOverview] = await Promise.all([
          api<Overview>(bootstrapActivity?.scanning ? "/api/overview?compact=1" : "/api/overview"),
          optionalFeatureApi<MusicOverview>("/api/music/overview", { libraries: [], tracks: [], jobs: [], scanning: false, scan: { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null } }),
          optionalFeatureApi<ReadingOverview>("/api/reading/overview", { libraries: [], items: [], scanning: false, scan: { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null } }),
          optionalFeatureApi<PhotoOverview>("/api/photos/overview", { libraries: [], items: [], scanning: false, scan: { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null } }),
        ]);
        if (sequence !== refreshSequence.current) return;
        if (bootstrapActivity) {
          nextOverview.scanning = bootstrapActivity.scanning;
          nextOverview.scan = bootstrapActivity.scan;
          nextOverview.jobs = bootstrapActivity.jobs;
          nextOverview.remuxAcceleration = bootstrapActivity.remuxAcceleration;
        }
        initialAdminOverviewLoaded.current = true;
        setOverview(nextOverview);
        setMusicOverview(nextMusicOverview);
        setReadingOverview(nextReadingOverview);
        setPhotoOverview(nextPhotoOverview);
      } else {
        const nextAccessStatus = await api<AccessStatus>("/api/auth/status");
        if (sequence !== refreshSequence.current) return;
        setAccessStatus(nextAccessStatus);
        if (nextAccessStatus.enabled && !nextAccessStatus.authenticated) {
          setCatalog(null);
          setMusicCatalog(null);
          setReadingCatalog(null);
          setPhotoCatalog(null);
        }
        else {
          const [nextCatalog, nextMusicCatalog, nextReadingCatalog, nextPhotoCatalog] = await Promise.all([
            api<Catalog>("/api/catalog"),
            optionalFeatureApi<MusicCatalog>("/api/music/catalog", { tracks: [], folders: [], scan: { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null } }),
            optionalFeatureApi<ReadingCatalog>("/api/reading/catalog", { items: [], folders: [], scan: { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null } }),
            optionalFeatureApi<PhotoCatalog>("/api/photos/catalog", { items: [], folders: [], scan: { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null } }),
          ]);
          if (sequence !== refreshSequence.current) return;
          setCatalog(nextCatalog);
          setMusicCatalog(nextMusicCatalog);
          setReadingCatalog(nextReadingCatalog);
          setPhotoCatalog(nextPhotoCatalog);
        }
      }
      setError("");
    } catch (fetchError) {
      if (sequence !== refreshSequence.current) return;
      setError(fetchError instanceof Error ? fetchError.message : "无法连接本地服务");
    } finally {
      if (sequence === refreshSequence.current) {
        setLoading(false);
        hasLoadedOnce.current = true;
      }
    }
  }, [isAdminPath]);

  const refreshAdminActivity = useCallback(async () => {
    try {
      const activity = await api<{ scanning: boolean; scan: CatalogScanStatus; jobs: Job[]; remuxAcceleration: RemuxAccelerationStatus }>("/api/scan/status");
      setOverview((currentOverview) => currentOverview ? {
        ...currentOverview,
        scanning: activity.scanning,
        scan: activity.scan,
        jobs: activity.jobs,
        remuxAcceleration: activity.remuxAcceleration,
      } : currentOverview);
      setError("");
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "无法读取扫描进度");
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!isAdminPath || (!adminScanActive && !adminJobsActive)) return;
    const timer = window.setInterval(() => void refreshAdminActivity(), adminScanActive ? 500 : 1800);
    return () => window.clearInterval(timer);
  }, [adminJobsActive, adminScanActive, isAdminPath, refreshAdminActivity]);
  useEffect(() => {
    if (!isAdminPath || (!musicAdminActive && !readingAdminActive && !photoAdminActive)) return;
    const timer = window.setInterval(() => void refresh(true), 1200);
    return () => window.clearInterval(timer);
  }, [isAdminPath, musicAdminActive, photoAdminActive, readingAdminActive, refresh]);
  useEffect(() => {
    const scanFinished = previousAdminScanActive.current && !adminScanActive;
    const jobsFinished = previousAdminJobsActive.current && !adminJobsActive;
    previousAdminScanActive.current = adminScanActive;
    previousAdminJobsActive.current = adminJobsActive;
    if (isAdminPath && (scanFinished || jobsFinished)) void refresh(true);
  }, [adminJobsActive, adminScanActive, isAdminPath, refresh]);
  useEffect(() => {
    if (isAdminPath || (!catalog?.scan?.scanning && !catalog?.media.some((item) => ["waiting", "queued", "running"].includes(item.compatibleCopyStatus || "")))) return;
    const timer = window.setInterval(() => refresh(true), 4000);
    return () => window.clearInterval(timer);
  }, [catalog?.media, catalog?.scan?.scanning, isAdminPath, refresh]);
  useEffect(() => {
    if (!selectedMedia || !catalog) return;
    const updatedMedia = catalog.media.find((item) => item.id === selectedMedia.id);
    if (updatedMedia && mediaLiveContentKey(updatedMedia) !== mediaLiveContentKey(selectedMedia)) setSelectedMedia(updatedMedia);
  }, [catalog, selectedMedia]);
  useEffect(() => {
    if (isAdminPath && overview && !overview.accessControl.enabled && adminSection === "access") setAdminSection("settings");
  }, [adminSection, isAdminPath, overview]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f5f6f7" : "#101215");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The theme remains active for this page even when storage is unavailable.
    }
  }, [theme]);

  const toggleTheme = () => setTheme((currentTheme) => currentTheme === "dark" ? "light" : "dark");
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setCatalog(null);
    setMusicCatalog(null);
    setReadingCatalog(null);
    setPhotoCatalog(null);
    await refresh();
  };

  if (loading) return <LoadingScreen />;
  if (!isAdminPath && accessStatus?.enabled && !accessStatus.authenticated) {
    return <AccessLoginScreen theme={theme} onToggleTheme={toggleTheme} onAuthenticated={refresh} />;
  }

  return (
    <MusicPlayerProvider catalog={musicCatalog}>
    <div className="app-shell">
      {isAdminPath ? (
        <AdminApp
          overview={overview}
          musicOverview={musicOverview}
          readingOverview={readingOverview}
          photoOverview={photoOverview}
          error={error}
          notice={notice}
          section={adminSection}
          onSectionChange={setAdminSection}
          onRefresh={refresh}
          onNotice={setNotice}
          onError={setError}
          onPlay={setSelectedMedia}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      ) : (
        <ClientApp catalog={catalog} musicCatalog={musicCatalog} readingCatalog={readingCatalog} photoCatalog={photoCatalog} error={error} onRefresh={refresh} accessStatus={accessStatus} onLogout={logout} theme={theme} onToggleTheme={toggleTheme} />
      )}
      {isAdminPath && selectedMedia && <PlayerModal media={selectedMedia} onClose={() => setSelectedMedia(null)} />}
    </div>
    </MusicPlayerProvider>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <LoaderCircle size={20} className="spin" />
      <p>正在连接 LMD…</p>
    </main>
  );
}

function AccessLoginScreen({ theme, onToggleTheme, onAuthenticated }: {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onAuthenticated: (quiet?: boolean) => Promise<void>;
}) {
  const [accessCode, setAccessCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(accessCode)) return;
    setBusy(true);
    setError("");
    try {
      await api<AccessStatus>("/api/auth/login", { method: "POST", body: JSON.stringify({ accessCode }) });
      await onAuthenticated();
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "登录失败，请重试。");
    } finally { setBusy(false); }
  };

  return (
    <main className="login-page">
      <header className="login-top">
        <span className="appbar-brand"><BrandMark /><strong>LMD</strong></span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </header>
      <section className="login-panel">
        <h1>登录后访问媒体库</h1>
        <p>这台 LMD 已开启局域网访问控制。请输入服务器管理员为你分配的六位数字访问码，以浏览获准的视频、音乐和阅读目录。</p>
        <form onSubmit={login}>
          <label className="field"><span>六位访问码</span><input className="input login-code" type="password" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" value={accessCode} onChange={(event) => setAccessCode(event.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} autoFocus placeholder="••••••" aria-label="六位数字访问码" /></label>
          {error && <div className="banner banner--error"><AlertTriangle size={14} /><span>{error}</span></div>}
          <button className="btn btn--primary" type="submit" disabled={busy || !/^\d{6}$/.test(accessCode)}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}{busy ? "正在验证…" : "登录"}</button>
        </form>
        <p className="login-note"><ShieldCheck size={13} /><span>登录状态仅保存在此浏览器的 HttpOnly Cookie 中，30 天内无需重复输入。</span></p>
      </section>
    </main>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
  const isLight = theme === "light";
  const nextThemeLabel = isLight ? "深色模式" : "明亮模式";
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onToggle}
      aria-label={`切换到${nextThemeLabel}`}
      aria-pressed={isLight}
      title={`切换到${nextThemeLabel}`}
    >
      {isLight ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function mediaDisplayName(media: Media) {
  return media.display?.alias || media.title;
}

function mediaQuickSelectionName(media: Media) {
  return media.display?.quickSelection?.label || mediaDisplayName(media);
}

function mediaLiveContentKey(media: Media) {
  return JSON.stringify({
    remuxUrl: media.remuxUrl,
    compatibleCopyStatus: media.compatibleCopyStatus,
    subtitles: media.subtitles.map(({ id, name, format, language, size, modifiedAt }) => ({ id, name, format, language, size, modifiedAt })),
    fonts: media.fonts.map(({ id, name, size, modifiedAt, aliases }) => ({ id, name, size, modifiedAt, aliases })),
  });
}

function mediaFolderId(media: Media) {
  return media.display?.folderId || media.display?.groupId || "";
}

function compareCatalogTitles(left: { title: string }, right: { title: string }) {
  return left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" });
}

function ViewerSession({ accessStatus, onLogout }: { accessStatus: AccessStatus | null; onLogout: () => Promise<void> }) {
  if (!accessStatus?.enabled || !accessStatus.user) return null;
  return (
    <button type="button" className="icon-btn" onClick={() => void onLogout()} title="退出当前访问用户" aria-label="退出当前访问用户">
      <LogOut size={15} />
    </button>
  );
}

type ViewerSection = "video" | "music" | "reading" | "photos";

function sectionFromLocation(): ViewerSection {
  const value = new URLSearchParams(window.location.search).get("section");
  return value === "music" || value === "reading" || value === "photos" ? value : "video";
}

function ClientHeader({ section, onSelectSection, onHome, theme, onToggleTheme, accessStatus, onLogout, scanTitle, onScan, scanBusy, search, onSearchChange, searchPlaceholder, searchAriaLabel }: {
  section: ViewerSection;
  onSelectSection: (section: ViewerSection) => void;
  onHome: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  accessStatus: AccessStatus | null;
  onLogout: () => Promise<void>;
  scanTitle?: string;
  onScan?: () => void;
  scanBusy?: boolean;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
}) {
  return (
    <header className="appbar">
      <button type="button" className="appbar-brand" onClick={onHome} aria-label="返回视频库首页" title="返回视频库首页"><BrandMark /><strong>LMD</strong></button>
      <nav className="segmented appbar-nav" aria-label="媒体板块">
        <button type="button" className={section === "video" ? "is-active" : ""} onClick={() => onSelectSection("video")}><Film size={17} /><span>视频</span></button>
        <button type="button" className={section === "music" ? "is-active" : ""} onClick={() => onSelectSection("music")}><Music2 size={17} /><span>音乐</span></button>
        <button type="button" className={section === "reading" ? "is-active" : ""} onClick={() => onSelectSection("reading")}><BookOpen size={17} /><span>电子书</span></button>
        <button type="button" className={section === "photos" ? "is-active" : ""} onClick={() => onSelectSection("photos")}><Images size={17} /><span>图片</span></button>
      </nav>
      <div className="appbar-actions">
        {typeof search === "string" && onSearchChange && <label className="search-box"><Search size={14} /><input aria-label={searchAriaLabel || "搜索"} value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder={searchPlaceholder || "搜索…"} /></label>}
        {onScan && <button type="button" className="icon-btn" onClick={onScan} disabled={scanBusy} title={scanTitle} aria-label={scanTitle}><RefreshCw size={15} className={scanBusy ? "spin" : ""} /></button>}
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <ViewerSession accessStatus={accessStatus} onLogout={onLogout} />
      </div>
    </header>
  );
}

function ClientApp({ catalog, musicCatalog, readingCatalog, photoCatalog, error, onRefresh, accessStatus, onLogout, theme, onToggleTheme }: {
  catalog: Catalog | null;
  musicCatalog: MusicCatalog | null;
  readingCatalog: ReadingCatalog | null;
  photoCatalog: PhotoCatalog | null;
  error: string;
  onRefresh: (quiet?: boolean) => Promise<void>;
  accessStatus: AccessStatus | null;
  onLogout: () => Promise<void>;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<ViewerSection>(sectionFromLocation);
  const [selectedMusicFolderId, setSelectedMusicFolderId] = useState<string | null>(() => {
    const parameters = new URLSearchParams(window.location.search);
    return parameters.get("section") === "music" ? parameters.get("folder") : null;
  });
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("track"));
  const [selectedReadingFolderId, setSelectedReadingFolderId] = useState<string | null>(() => {
    const parameters = new URLSearchParams(window.location.search);
    return parameters.get("section") === "reading" ? parameters.get("folder") : null;
  });
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("document"));
  const [selectedPhotoFolderId, setSelectedPhotoFolderId] = useState<string | null>(() => {
    const parameters = new URLSearchParams(window.location.search);
    return parameters.get("section") === "photos" ? parameters.get("folder") : null;
  });
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(() => {
    const parameters = new URLSearchParams(window.location.search);
    return parameters.get("section") === "photos" ? parameters.get("photo") : null;
  });
  const [readingFilter, setReadingFilter] = useState<ReadingFilter>(() => {
    const value = new URLSearchParams(window.location.search).get("kind");
    return value === "ebook" || value === "spreadsheet" ? value : "all";
  });
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => {
    const parameters = new URLSearchParams(window.location.search);
    return sectionFromLocation() === "video" ? parameters.get("folder") || parameters.get("series") : null;
  });
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("video"));
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNotice, setScanNotice] = useState<{ text: string; tone: "warning" | "success" } | null>(null);
  const dismissScanNotice = useCallback(() => setScanNotice(null), []);
  const allMedia = catalog?.media || [];
  const normalizedSearch = search.trim().toLowerCase();
  const folders = useMemo<CatalogFolder[]>(() => {
    if (catalog?.folders) return catalog.folders;
    return (catalog?.groups || []).map((group) => {
      const groupMedia = allMedia.filter((item) => item.display?.groupId === group.id);
      return {
        id: group.id,
        parentId: null,
        name: group.folderName || group.title,
        title: group.title,
        configured: group.configured,
        directMediaCount: groupMedia.length,
        mediaCount: groupMedia.length,
        childCount: 0,
        coverMediaId: groupMedia[0]?.id || null,
      };
    });
  }, [allMedia, catalog?.folders, catalog?.groups]);
  const mediaById = useMemo(() => new Map(allMedia.map((item) => [item.id, item])), [allMedia]);
  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const rootFolders = useMemo(() => folders.filter((folder) => folder.parentId === null).sort(compareCatalogTitles), [folders]);
  const singleRootFolder = rootFolders.length === 1 ? rootFolders[0] : null;
  const legacyMedia = selectedFolderId && !folderById.has(selectedFolderId)
    ? allMedia.find((item) => item.display?.groupId === selectedFolderId)
    : null;
  const legacyFolderId = selectedFolderId && !folderById.has(selectedFolderId)
    ? legacyMedia ? mediaFolderId(legacyMedia) : ""
    : "";
  const currentFolder = folderById.get(selectedFolderId || "") || folderById.get(legacyFolderId) || singleRootFolder;
  const atVideoLibraryRoot = !selectedFolderId || selectedFolderId === singleRootFolder?.id;
  const childFolders = useMemo(() => folders
    .filter((folder) => folder.parentId === currentFolder?.id)
    .sort(compareCatalogTitles), [currentFolder?.id, folders]);
  const directMedia = useMemo(() => allMedia
    .filter((item) => currentFolder && mediaFolderId(item) === currentFolder.id)
    .sort((left, right) => (left.display?.episode || 0) - (right.display?.episode || 0)
      || left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" })), [allMedia, currentFolder]);
  const matchesSearch = (item: Media) => `${mediaQuickSelectionName(item)} ${mediaDisplayName(item)} ${item.title} ${item.fileName} ${item.tags.join(" ")}`.toLowerCase().includes(normalizedSearch);
  const matchingFolderIds = useMemo(() => {
    const matches = new Set<string>();
    if (!normalizedSearch) return matches;
    for (const folder of folders) {
      if (`${folder.title} ${folder.name}`.toLowerCase().includes(normalizedSearch)) matches.add(folder.id);
    }
    for (const item of allMedia) {
      if (matchesSearch(item) && mediaFolderId(item)) matches.add(mediaFolderId(item));
    }
    for (const folderId of [...matches]) {
      let parentId = folderById.get(folderId)?.parentId || null;
      const visited = new Set<string>();
      while (parentId && !visited.has(parentId)) {
        matches.add(parentId);
        visited.add(parentId);
        parentId = folderById.get(parentId)?.parentId || null;
      }
    }
    return matches;
  }, [allMedia, folderById, folders, normalizedSearch]);
  const visibleFolders = (currentFolder ? childFolders : rootFolders)
    .filter((folder) => !normalizedSearch || matchingFolderIds.has(folder.id));
  const visibleMedia = directMedia.filter((item) => !normalizedSearch || matchesSearch(item));
  const hasQuickSelections = visibleMedia.some((item) => Boolean(item.display?.quickSelection));
  const selectedMedia = allMedia.find((item) => item.id === selectedMediaId) || null;
  const selectedMediaFolder = selectedMedia ? mediaFolderId(selectedMedia) : "";
  // Acceptance harness: ?playerTest=1 opens the first catalog item so the
  // runner can drive the real player and report results to the service.
  const playerTest = playerTestRequested();
  useEffect(() => {
    if (playerTest && !selectedMediaId && allMedia.length) setSelectedMediaId(allMedia[0].id);
  }, [playerTest, selectedMediaId, allMedia.length]);
  const selectedFolderMedia = useMemo(() => allMedia
    .filter((item) => selectedMediaFolder && mediaFolderId(item) === selectedMediaFolder)
    .sort((left, right) => (left.display?.episode || 0) - (right.display?.episode || 0)
      || left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" })), [allMedia, selectedMediaFolder]);
  const selectedMediaIndex = selectedMedia ? selectedFolderMedia.findIndex((item) => item.id === selectedMedia.id) : -1;
  const previousMedia = selectedMediaIndex > 0 ? selectedFolderMedia[selectedMediaIndex - 1] || null : null;
  const nextMedia = selectedMediaIndex >= 0 ? selectedFolderMedia[selectedMediaIndex + 1] || null : null;
  const folderTrail = useMemo(() => {
    const trail: CatalogFolder[] = [];
    const visited = new Set<string>();
    let folder = currentFolder;
    while (folder && !visited.has(folder.id)) {
      trail.unshift(folder);
      visited.add(folder.id);
      folder = folder.parentId ? folderById.get(folder.parentId) || null : null;
    }
    return singleRootFolder ? trail.filter((folder) => folder.id !== singleRootFolder.id) : trail;
  }, [currentFolder, folderById, singleRootFolder]);
  const totalVideos = allMedia.length;

  useEffect(() => {
    const syncRouteFromHistory = () => {
      const parameters = new URLSearchParams(window.location.search);
      const nextSection = sectionFromLocation();
      setSection(nextSection);
      setSelectedMusicFolderId(nextSection === "music" ? parameters.get("folder") : null);
      setSelectedTrackId(nextSection === "music" ? parameters.get("track") : null);
      setSelectedReadingFolderId(nextSection === "reading" ? parameters.get("folder") : null);
      setSelectedDocumentId(nextSection === "reading" ? parameters.get("document") : null);
      setSelectedPhotoFolderId(nextSection === "photos" ? parameters.get("folder") : null);
      setSelectedPhotoId(nextSection === "photos" ? parameters.get("photo") : null);
      const nextFilter = parameters.get("kind");
      setReadingFilter(nextFilter === "ebook" || nextFilter === "spreadsheet" ? nextFilter : "all");
      setSelectedFolderId(nextSection === "video" ? parameters.get("folder") || parameters.get("series") : null);
      setSelectedMediaId(nextSection === "video" ? parameters.get("video") : null);
      setSearch("");
    };
    window.addEventListener("popstate", syncRouteFromHistory);
    return () => window.removeEventListener("popstate", syncRouteFromHistory);
  }, []);

  const switchSection = (nextSection: ViewerSection) => {
    if (nextSection === section && !selectedMediaId && !selectedTrackId && !selectedDocumentId && !selectedPhotoId) return;
    const nextUrl = new URL(window.location.href);
    for (const key of ["folder", "series", "video", "track", "document", "photo", "kind"]) nextUrl.searchParams.delete(key);
    if (nextSection === "video") nextUrl.searchParams.delete("section");
    else nextUrl.searchParams.set("section", nextSection);
    window.history.pushState({ section: nextSection }, "", nextUrl);
    setSection(nextSection);
    setSelectedFolderId(null);
    setSelectedMediaId(null);
    setSelectedMusicFolderId(null);
    setSelectedTrackId(null);
    setSelectedReadingFolderId(null);
    setSelectedDocumentId(null);
    setSelectedPhotoFolderId(null);
    setSelectedPhotoId(null);
    setReadingFilter("all");
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openFolder = (folderId: string) => {
    const folder = folderById.get(folderId);
    const folderNameMatchesSearch = Boolean(normalizedSearch && folder
      && `${folder.title} ${folder.name}`.toLowerCase().includes(normalizedSearch));
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("folder", folderId);
    nextUrl.searchParams.delete("series");
    nextUrl.searchParams.delete("video");
    window.history.pushState({ folder: folderId }, "", nextUrl);
    setSelectedFolderId(folderId);
    setSelectedMediaId(null);
    if (!normalizedSearch || folderNameMatchesSearch) setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openMedia = (media: Media) => {
    const nextUrl = new URL(window.location.href);
    const folderId = mediaFolderId(media) || currentFolder?.id || "";
    if (folderId) nextUrl.searchParams.set("folder", folderId);
    nextUrl.searchParams.delete("series");
    nextUrl.searchParams.set("video", media.id);
    window.history.pushState({ folder: folderId || null, video: media.id }, "", nextUrl);
    setSelectedFolderId(folderId || selectedFolderId);
    setSelectedMediaId(media.id);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const switchPlayerMedia = (media: Media) => {
    const folderId = mediaFolderId(media) || selectedFolderId;
    const nextUrl = new URL(window.location.href);
    if (folderId) nextUrl.searchParams.set("folder", folderId);
    nextUrl.searchParams.delete("series");
    nextUrl.searchParams.set("video", media.id);
    window.history.replaceState({ folder: folderId || null, video: media.id }, "", nextUrl);
    setSelectedFolderId(folderId);
    setSelectedMediaId(media.id);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openLibrary = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete("folder");
    nextUrl.searchParams.delete("series");
    nextUrl.searchParams.delete("video");
    nextUrl.searchParams.delete("section");
    nextUrl.searchParams.delete("track");
    nextUrl.searchParams.delete("document");
    nextUrl.searchParams.delete("photo");
    nextUrl.searchParams.delete("kind");
    window.history.pushState({ folder: null }, "", nextUrl);
    setSelectedFolderId(null);
    setSelectedMediaId(null);
    setSection("video");
    setSelectedMusicFolderId(null);
    setSelectedTrackId(null);
    setSelectedReadingFolderId(null);
    setSelectedDocumentId(null);
    setSelectedPhotoFolderId(null);
    setSelectedPhotoId(null);
    setReadingFilter("all");
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openMusicFolder = (folderId: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "music");
    nextUrl.searchParams.set("folder", folderId);
    nextUrl.searchParams.delete("track");
    nextUrl.searchParams.delete("video");
    nextUrl.searchParams.delete("series");
    window.history.pushState({ section: "music", folder: folderId }, "", nextUrl);
    setSection("music");
    setSelectedMusicFolderId(folderId);
    setSelectedTrackId(null);
    setSelectedFolderId(null);
    setSelectedMediaId(null);
    setSelectedReadingFolderId(null);
    setSelectedDocumentId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openMusicLibrary = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "music");
    nextUrl.searchParams.delete("folder");
    nextUrl.searchParams.delete("track");
    nextUrl.searchParams.delete("video");
    nextUrl.searchParams.delete("series");
    window.history.pushState({ section: "music" }, "", nextUrl);
    setSection("music");
    setSelectedMusicFolderId(null);
    setSelectedTrackId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openMusicTrack = (track: MusicTrack) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "music");
    nextUrl.searchParams.set("folder", track.folderId);
    nextUrl.searchParams.set("track", track.id);
    nextUrl.searchParams.delete("video");
    nextUrl.searchParams.delete("series");
    window.history.pushState({ section: "music", folder: track.folderId, track: track.id }, "", nextUrl);
    setSection("music");
    setSelectedMusicFolderId(track.folderId);
    setSelectedTrackId(track.id);
    setSelectedFolderId(null);
    setSelectedMediaId(null);
    setSelectedReadingFolderId(null);
    setSelectedDocumentId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openReadingFolder = (folderId: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "reading");
    nextUrl.searchParams.set("folder", folderId);
    nextUrl.searchParams.delete("document");
    nextUrl.searchParams.delete("track");
    nextUrl.searchParams.delete("video");
    nextUrl.searchParams.delete("series");
    nextUrl.searchParams.delete("document");
    nextUrl.searchParams.delete("kind");
    if (readingFilter === "all") nextUrl.searchParams.delete("kind");
    else nextUrl.searchParams.set("kind", readingFilter);
    window.history.pushState({ section: "reading", folder: folderId }, "", nextUrl);
    setSection("reading");
    setSelectedReadingFolderId(folderId);
    setSelectedDocumentId(null);
    setSelectedMusicFolderId(null);
    setSelectedTrackId(null);
    setSelectedFolderId(null);
    setSelectedMediaId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openReadingLibrary = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "reading");
    nextUrl.searchParams.delete("folder");
    nextUrl.searchParams.delete("document");
    if (readingFilter === "all") nextUrl.searchParams.delete("kind");
    else nextUrl.searchParams.set("kind", readingFilter);
    window.history.pushState({ section: "reading" }, "", nextUrl);
    setSection("reading");
    setSelectedReadingFolderId(null);
    setSelectedDocumentId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openReadingDocument = (item: ReadingItem) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "reading");
    nextUrl.searchParams.set("folder", item.folderId);
    nextUrl.searchParams.set("document", item.id);
    if (readingFilter === "all") nextUrl.searchParams.delete("kind");
    else nextUrl.searchParams.set("kind", readingFilter);
    nextUrl.searchParams.delete("track");
    nextUrl.searchParams.delete("video");
    nextUrl.searchParams.delete("series");
    window.history.pushState({ section: "reading", folder: item.folderId, document: item.id }, "", nextUrl);
    setSection("reading");
    setSelectedReadingFolderId(item.folderId);
    setSelectedDocumentId(item.id);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const changeReadingFilter = (filter: ReadingFilter) => {
    const nextUrl = new URL(window.location.href);
    if (filter === "all") nextUrl.searchParams.delete("kind");
    else nextUrl.searchParams.set("kind", filter);
    window.history.replaceState({ ...window.history.state, kind: filter }, "", nextUrl);
    setReadingFilter(filter);
  };

  const openPhotoLibrary = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "photos");
    nextUrl.searchParams.delete("folder");
    nextUrl.searchParams.delete("photo");
    window.history.pushState({ section: "photos" }, "", nextUrl);
    setSection("photos");
    setSelectedPhotoFolderId(null);
    setSelectedPhotoId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openPhotoFolder = (folderId: string) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "photos");
    nextUrl.searchParams.set("folder", folderId);
    nextUrl.searchParams.delete("photo");
    window.history.pushState({ section: "photos", folder: folderId }, "", nextUrl);
    setSection("photos");
    setSelectedPhotoFolderId(folderId);
    setSelectedPhotoId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openPhoto = (item: PhotoItem) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "photos");
    nextUrl.searchParams.set("folder", item.folderId);
    nextUrl.searchParams.set("photo", item.id);
    window.history.pushState({ section: "photos", folder: item.folderId, photo: item.id }, "", nextUrl);
    setSection("photos");
    setSelectedPhotoFolderId(item.folderId);
    setSelectedPhotoId(item.id);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const switchPhoto = (item: PhotoItem) => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("section", "photos");
    nextUrl.searchParams.set("folder", item.folderId);
    nextUrl.searchParams.set("photo", item.id);
    window.history.replaceState({ section: "photos", folder: item.folderId, photo: item.id }, "", nextUrl);
    setSelectedPhotoFolderId(item.folderId);
    setSelectedPhotoId(item.id);
  };

  const scanNow = async () => {
    setScanBusy(true);
    const musicMode = section === "music";
    const readingMode = section === "reading";
    const photoMode = section === "photos";
    setScanNotice({ text: musicMode ? "正在扫描音乐目录、标签、封面与歌词…" : readingMode ? "正在扫描电子书与表格目录…" : photoMode ? "正在扫描图片尺寸并生成瀑布流缩略图…" : "正在扫描视频目录并刷新文件列表…", tone: "success" });
    try {
      const result = await api<{ count: number }>(musicMode ? "/api/music/catalog/scan" : readingMode ? "/api/reading/catalog/scan" : photoMode ? "/api/photos/catalog/scan" : "/api/catalog/scan", { method: "POST" });
      await onRefresh(true);
      setScanNotice({ text: musicMode ? `扫描完成，当前共有 ${result.count} 首歌曲。` : readingMode ? `扫描完成，当前共有 ${result.count} 个阅读文件。` : photoMode ? `扫描完成，当前共有 ${result.count} 张图片。` : `扫描完成，当前共有 ${result.count} 个视频文件。`, tone: "success" });
    } catch (operationError) {
      setScanNotice({ text: operationError instanceof Error ? operationError.message : "扫描刷新失败", tone: "warning" });
    } finally { setScanBusy(false); }
  };

  if (section === "photos" && photoCatalog) {
    return (
      <div className="client-page">
        <ClientHeader section={section} onSelectSection={switchSection} onHome={openLibrary} theme={theme} onToggleTheme={onToggleTheme} accessStatus={accessStatus} onLogout={onLogout} scanTitle="立即扫描图片目录" onScan={selectedPhotoId ? undefined : scanNow} scanBusy={scanBusy} search={selectedPhotoId ? undefined : search} onSearchChange={selectedPhotoId ? undefined : setSearch} searchPlaceholder="搜索文件夹、图片、格式…" searchAriaLabel="搜索图片文件夹、文件名或扩展名" />
        <main className={selectedPhotoId ? "app-main app-main--player" : "app-main"}>
          {error && <StatusBanner tone="warning" icon={<AlertTriangle size={14} />}>{error}</StatusBanner>}
          {!selectedPhotoId && <TimedStatusBanner notice={scanNotice} onDismiss={dismissScanNotice} />}
          <PhotoLibraryView key={selectedPhotoFolderId || "root"} catalog={photoCatalog} folderId={selectedPhotoFolderId} photoId={selectedPhotoId} search={search} onOpenFolder={openPhotoFolder} onOpenPhoto={openPhoto} onSwitchPhoto={switchPhoto} onBackToLibrary={openPhotoLibrary} onNotice={(message) => setScanNotice({ text: message, tone: "success" })} />
        </main>
      </div>
    );
  }

  if (section === "music" && selectedTrackId && musicCatalog) {
    return (
      <div className="client-page">
        <ClientHeader section={section} onSelectSection={switchSection} onHome={openLibrary} theme={theme} onToggleTheme={onToggleTheme} accessStatus={accessStatus} onLogout={onLogout} />
        <main className="app-main app-main--player">
          <MusicFullPlayer catalog={musicCatalog} trackId={selectedTrackId} />
        </main>
      </div>
    );
  }

  if (section === "music" && musicCatalog) {
    return (
      <div className="client-page">
        <ClientHeader section={section} onSelectSection={switchSection} onHome={openLibrary} theme={theme} onToggleTheme={onToggleTheme} accessStatus={accessStatus} onLogout={onLogout} scanTitle="立即扫描音乐目录" onScan={scanNow} scanBusy={scanBusy} search={search} onSearchChange={setSearch} searchPlaceholder="搜索歌曲、艺术家、专辑…" searchAriaLabel="搜索音乐文件夹、歌曲、艺术家或专辑" />
        <main className="app-main">
          {error && <StatusBanner tone="warning" icon={<AlertTriangle size={14} />}>{error}</StatusBanner>}
          <TimedStatusBanner notice={scanNotice} onDismiss={dismissScanNotice} />
          <MusicFolderView key={selectedMusicFolderId || "root"} catalog={musicCatalog} folderId={selectedMusicFolderId} search={search} onOpenFolder={openMusicFolder} onOpenTrack={openMusicTrack} onBackToLibrary={openMusicLibrary} />
        </main>
      </div>
    );
  }

  if (section === "reading" && readingCatalog) {
    return (
      <div className="client-page">
        <ClientHeader section={section} onSelectSection={switchSection} onHome={openLibrary} theme={theme} onToggleTheme={onToggleTheme} accessStatus={accessStatus} onLogout={onLogout} scanTitle="立即扫描阅读目录" onScan={selectedDocumentId ? undefined : scanNow} scanBusy={scanBusy} search={selectedDocumentId ? undefined : search} onSearchChange={selectedDocumentId ? undefined : setSearch} searchPlaceholder="搜索书名、表格、格式…" searchAriaLabel="搜索电子书、表格或格式" />
        <main className={selectedDocumentId ? "app-main app-main--player" : "app-main"}>
          {error && <StatusBanner tone="warning" icon={<AlertTriangle size={14} />}>{error}</StatusBanner>}
          {!selectedDocumentId && <TimedStatusBanner notice={scanNotice} onDismiss={dismissScanNotice} />}
          <ReadingLibraryView key={`${selectedReadingFolderId}|${selectedDocumentId}`} catalog={readingCatalog} folderId={selectedReadingFolderId} documentId={selectedDocumentId} filter={readingFilter} search={search} theme={theme} onOpenFolder={openReadingFolder} onOpenDocument={openReadingDocument} onBackToLibrary={openReadingLibrary} onFilterChange={changeReadingFilter} />
        </main>
      </div>
    );
  }

  if (selectedMedia) {
    return (
      <div className="client-page">
        <ClientHeader section={section} onSelectSection={switchSection} onHome={openLibrary} theme={theme} onToggleTheme={onToggleTheme} accessStatus={accessStatus} onLogout={onLogout} />
        <main className="app-main app-main--player">
          <PlayerModal
            media={selectedMedia}
            pageMode
            previousMedia={previousMedia}
            nextMedia={nextMedia}
            onPrevious={previousMedia ? () => switchPlayerMedia(previousMedia) : undefined}
            onNext={nextMedia ? () => switchPlayerMedia(nextMedia) : undefined}
          />
          {playerTest && <PlayerTestPanel media={selectedMedia} />}
        </main>
      </div>
    );
  }

  return (
    <div className="client-page">
      <ClientHeader section={section} onSelectSection={switchSection} onHome={openLibrary} theme={theme} onToggleTheme={onToggleTheme} accessStatus={accessStatus} onLogout={onLogout} scanTitle="立即扫描并刷新文件" onScan={scanNow} scanBusy={scanBusy} search={search} onSearchChange={setSearch} searchPlaceholder="搜索文件夹、视频…" searchAriaLabel="搜索文件夹或视频" />
      <main className="app-main" key={currentFolder?.id || "root"}>
        {error && <StatusBanner tone="warning" icon={<AlertTriangle size={14} />}>{error}</StatusBanner>}
        <TimedStatusBanner notice={scanNotice} onDismiss={dismissScanNotice} />
        <div className="lib-toolbar">
          <nav className="crumbs" aria-label="当前文件夹路径">
            {!atVideoLibraryRoot && currentFolder ? <>
              <button type="button" onClick={openLibrary}>全部视频</button>
              {folderTrail.map((folder) => <React.Fragment key={folder.id}><span className="crumbs-sep">/</span><button type="button" onClick={() => openFolder(folder.id)} aria-current={folder.id === currentFolder.id ? "page" : undefined}>{folder.title}</button></React.Fragment>)}
            </> : <span className="crumbs-current">全部视频</span>}
          </nav>
          <span className="lib-stats">{currentFolder ? `${visibleFolders.length} 个文件夹 · ${visibleMedia.length} 个视频` : `${rootFolders.length} 个根目录 · ${totalVideos} 个视频`}</span>
        </div>
        {visibleFolders.length || visibleMedia.length ? (
          <div className="media-sections">
            {visibleMedia.length > 0 && <section className={`media-section${hasQuickSelections ? " media-section--selection" : ""}`} aria-labelledby="video-selection-section-title">
              {currentFolder && <div className="media-section-head"><h2 id="video-selection-section-title">{hasQuickSelections ? "选集" : "视频"}</h2><span>{visibleMedia.length} 个</span></div>}
              <div className="media-grid">
                {visibleMedia.map((item) => <MediaCard key={item.id} media={item} onPlay={() => openMedia(item)} />)}
              </div>
            </section>}
            {visibleFolders.length > 0 && <section className="media-section" aria-labelledby={currentFolder ? "video-folder-section-title" : undefined}>
              {currentFolder && <div className="media-section-head"><h2 id="video-folder-section-title">文件夹</h2><span>{visibleFolders.length} 个</span></div>}
              <div className="media-grid">
                {visibleFolders.map((folder) => <FolderCard key={folder.id} folder={folder} cover={folder.coverMediaId ? mediaById.get(folder.coverMediaId) || null : null} onOpen={() => openFolder(folder.id)} />)}
              </div>
            </section>}
          </div>
        ) : (
          <div className="empty-state"><Library size={24} /><strong>{normalizedSearch ? "没有匹配的内容" : !atVideoLibraryRoot && currentFolder ? "这个文件夹暂时为空" : "媒体库暂时为空"}</strong><span>{normalizedSearch ? "请尝试其他文件夹名或视频名。" : !atVideoLibraryRoot && currentFolder ? "此处没有可播放视频或包含视频的子文件夹。" : "请添加视频目录，或把视频放入已有目录后重新扫描。"}</span></div>
        )}
      </main>
    </div>
  );
}

function FolderCard({ folder, cover, onOpen }: { folder: CatalogFolder; cover: Media | null; onOpen: () => void }) {
  return (
    <article className="mcard mcard--folder" style={{ "--poster-hue": cover?.posterHue || 205 } as React.CSSProperties}>
      <button type="button" className="mcard-hit" onClick={onOpen} aria-label={`打开文件夹 ${folder.title}`} />
      <div className="mcard-poster">
        {cover?.thumbnailUrl && <img className="mcard-img" src={cover.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <span className="tag mcard-badge">文件夹</span>
      </div>
      <h3 className="mcard-title">{folder.title}</h3>
      <p className="mcard-meta">{folder.childCount ? `${folder.childCount} 个子文件夹 · ${folder.mediaCount} 个视频` : `${folder.directMediaCount} 个视频`}</p>
    </article>
  );
}

function MediaCard({ media, onPlay }: { media: Media; onPlay: () => void }) {
  const displayName = mediaDisplayName(media);
  const quickSelectionName = mediaQuickSelectionName(media);
  const quickSelection = media.display?.quickSelection || null;
  return (
    <article className="mcard" style={{ "--poster-hue": media.posterHue } as React.CSSProperties} title={quickSelection ? media.fileName : undefined}>
      <button type="button" className="mcard-hit" onClick={onPlay} aria-label={quickSelection ? `播放 ${quickSelectionName}，原文件 ${media.fileName}` : `播放 ${displayName}`} />
      <div className="mcard-poster">
        {media.thumbnailUrl && <img className="mcard-img" src={media.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <span className="tag mcard-badge">{media.extension}</span>
        {media.hdr && <span className="tag mcard-hdr">{media.hdr}</span>}
        <span className="mcard-res">{media.height ? `${media.height}P` : "原画"}</span>
      </div>
      <h3 className={`mcard-title${quickSelection ? " mcard-title--quick" : ""}`}>{quickSelectionName}</h3>
      <p className="mcard-meta">{codecName(media.videoCodec)} · {media.bitDepth || 8}-bit · {formatDuration(media.durationSeconds)}{media.subtitles.length ? ` · ${media.subtitles.length} 字幕` : ""}</p>
    </article>
  );
}

function ScanProgress({ scan, compact = false }: { scan: CatalogScanStatus; compact?: boolean }) {
  const numericProgress = typeof scan.progressPercent === "number" && Number.isFinite(scan.progressPercent)
    ? Math.max(0, Math.min(100, Math.round(scan.progressPercent)))
    : null;
  const totalFiles = Math.max(scan.totalFiles, scan.discoveredFiles);
  const countLabel = scan.phase === "discovering"
    ? `${scan.discoveredFiles} 个文件 · ${scan.processedLibraries}/${scan.totalLibraries} 个目录`
    : totalFiles > 0
      ? `${Math.min(scan.processedFiles, totalFiles)}/${totalFiles} 个文件`
      : "正在统计文件";
  const parallelLabel = scan.maxParallelFiles > 0
    ? `最多 ${scan.maxParallelFiles} 路文件并行${(scan.maxParallelMediaTools || 0) > 0 ? ` · ${scan.maxParallelMediaTools} 路媒体进程` : ""}`
    : "正在分配处理资源";
  return (
    <div className={`scan-progress${compact ? " is-compact" : ""}`}>
      <div className="scan-progress-heading"><span>{scanPhaseLabel(scan)}</span><b>{numericProgress === null ? "…" : `${numericProgress}%`}</b></div>
      <div
        className={`scan-progress-track${numericProgress === null ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-label={scan.mode === "turbo" || scan.pendingMode === "turbo" ? "急速扫描进度" : "媒体扫描进度"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={numericProgress ?? undefined}
        aria-valuetext={`${scanPhaseLabel(scan)}，${countLabel}`}
      ><span style={numericProgress === null ? undefined : { width: `${numericProgress}%` }} /></div>
      <div className="scan-progress-meta"><span>{countLabel}</span><span>{parallelLabel}</span></div>
    </div>
  );
}

type RapidScanDialogState =
  | { view: "prompt"; library: LibraryFolder }
  | { view: "progress"; priorScanId: string | null; priorScanMode: CatalogScanStatus["mode"] };

function RapidScanDialog({ state, scan, starting, startError, onStart, onClose }: {
  state: RapidScanDialogState;
  scan: CatalogScanStatus | null;
  starting: boolean;
  startError: string;
  onStart: () => void;
  onClose: () => void;
}) {
  const progressState = state.view === "progress" ? state : null;
  const observedTurboScan = Boolean(progressState && scan && (
    scan.pendingMode === "turbo"
    || (scan.mode === "turbo" && (scan.id !== progressState.priorScanId || progressState.priorScanMode !== "turbo"))
  ));
  const terminal = Boolean(observedTurboScan && scan && !scanIsActive(scan) && (scan.phase === "completed" || scan.phase === "cancelled" || scan.phase === "failed"));
  const canRunInBackground = state.view === "progress" && !startError && !terminal;
  const dialogTitle = state.view === "prompt"
    ? "为新目录开启急速扫描？"
    : startError
      ? "急速扫描启动失败"
      : terminal && scan?.phase === "completed"
        ? "急速扫描已完成"
        : terminal && scan?.phase === "cancelled"
          ? "急速扫描已停止"
          : terminal
            ? "急速扫描未完成"
          : "正在进行急速扫描";

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rapid-scan-title">
      <section className="modal">
        <div className="modal-head">
          <h2 id="rapid-scan-title">{dialogTitle}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={canRunInBackground ? "关闭窗口并在后台继续扫描" : "关闭急速扫描窗口"} title={canRunInBackground ? "关闭窗口，扫描继续在后台运行" : "关闭"}><X size={15} /></button>
        </div>
        <div className="modal-body">
          {state.view === "prompt" ? (
            <>
              <p>已添加视频目录“{state.library.name}”。是否立即开启“急速扫描模式”？</p>
              <div className="rapid-path">{state.library.path}</div>
              <div className="banner banner--warning"><AlertTriangle size={14} /><span>最高性能模式仅对本次任务生效，会按本机处理器数量大幅提高文件检查和媒体分析并发，尽可能拉满 CPU 与磁盘吞吐。</span></div>
            </>
          ) : (
            <>
              {startError ? <div className="banner banner--error"><AlertTriangle size={14} /><span>{startError}</span></div> : starting || !observedTurboScan || !scan ? (
                <div className="rapid-launching"><LoaderCircle size={18} className="spin" /><div><strong>正在提交急速扫描任务</strong><span>服务端确认后会显示实时文件处理进度。</span></div></div>
              ) : (
                <>
                  <ScanProgress scan={scan} />
                  <p>本次任务最多并行检查 {Math.max(1, scan.maxParallelFiles)} 个文件，并同时运行 {Math.max(1, scan.maxParallelMediaTools || 1)} 个媒体分析进程。扫描期间风扇转速、CPU 或磁盘活动显著增加属于正常现象。</p>
                  {scan.phase === "failed" && scan.lastError && <div className="banner banner--error"><AlertTriangle size={14} /><span>{scan.lastError}</span></div>}
                </>
              )}
              {canRunInBackground && <p>关闭窗口不会中断任务，可在“运行设置”中继续查看扫描进度。</p>}
            </>
          )}
        </div>
        <div className="modal-actions">
          {state.view === "prompt" ? (
            <>
              <button type="button" className="btn" onClick={onClose}>稍后处理</button>
              <button type="button" className="btn btn--primary" onClick={onStart}><Gauge size={15} />开启最高性能扫描</button>
            </>
          ) : (
            <button type="button" className={canRunInBackground ? "btn" : "btn btn--primary"} onClick={onClose}>{canRunInBackground ? "转至后台运行" : "关闭"}</button>
          )}
        </div>
      </section>
    </div>
  );
}

function AdminApp(props: {
  overview: Overview | null;
  musicOverview: MusicOverview | null;
  readingOverview: ReadingOverview | null;
  photoOverview: PhotoOverview | null;
  error: string;
  notice: string;
  section: AdminSection;
  onSectionChange: (section: AdminSection) => void;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (notice: string) => void;
  onError: (error: string) => void;
  onPlay: (media: Media) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const { overview, musicOverview, readingOverview, photoOverview, error, notice, section, onSectionChange, onRefresh, onNotice, onError, onPlay, theme, onToggleTheme } = props;
  const [rapidScanDialog, setRapidScanDialog] = useState<RapidScanDialogState | null>(null);
  const [turboActionBusy, setTurboActionBusy] = useState(false);
  const [turboStartError, setTurboStartError] = useState("");
  const dismissNotice = useCallback(() => onNotice(""), [onNotice]);
  // Playback cache/lease limits and danmaku credentials both live in the video
  // playback core, so the settings page loads them lazily and never caches the
  // secret itself in the page payload.
  const [playbackSettings, setPlaybackSettings] = useState<PlaybackSettings | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus | null>(null);
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings | null>(null);
  useEffect(() => {
    if (section !== "settings") return;
    let stopped = false;
    void Promise.all([
      api<{ settings: PlaybackSettings; status: PlaybackStatus }>("/api/settings/video-playback").catch(() => null),
      api<DanmakuSettings>("/api/settings/danmaku").catch(() => null),
    ]).then(([playback, danmaku]) => {
      if (stopped) return;
      if (playback) { setPlaybackSettings(playback.settings); setPlaybackStatus(playback.status); }
      if (danmaku) setDanmakuSettings(danmaku);
    });
    return () => { stopped = true; };
  }, [section]);
  const savePlaybackSettings = async (patch: Partial<PlaybackSettings>) => {
    const result = await api<{ settings: PlaybackSettings; status: PlaybackStatus }>("/api/settings/video-playback", { method: "PATCH", body: JSON.stringify(patch) });
    setPlaybackSettings(result.settings); setPlaybackStatus(result.status);
  };
  const saveDanmakuSettings = async (body: { appId?: string; appSecret?: string; clear?: boolean }) => {
    const result = await api<DanmakuSettings>("/api/settings/danmaku", { method: "PATCH", body: JSON.stringify(body) });
    setDanmakuSettings(result);
  };
  const sectionTitle = section === "overview" ? "总览" : section === "access" ? "访问控制" : "运行设置";

  const promptForTurboScan = (library: LibraryFolder) => {
    setTurboStartError("");
    setRapidScanDialog({ view: "prompt", library });
  };

  const startTurboScan = async () => {
    if (turboActionBusy) return;
    const priorScanId = overview?.scan?.id || null;
    const priorScanMode = overview?.scan?.mode || null;
    setRapidScanDialog({ view: "progress", priorScanId, priorScanMode });
    setTurboActionBusy(true);
    setTurboStartError("");
    onError("");
    onNotice("");
    try {
      await api<{ scan?: CatalogScanStatus }>("/api/scan/start?mode=turbo", { method: "POST" });
      await onRefresh(true);
      onNotice("最高性能急速扫描已启动；本次任务会临时拉满文件检查和媒体分析并发，完成后自动恢复。");
    } catch (operationError) {
      const message = operationError instanceof Error ? operationError.message : "无法启动急速扫描";
      setTurboStartError(message);
      onError(message);
    } finally {
      setTurboActionBusy(false);
    }
  };

  const stopTurboScan = async () => {
    if (turboActionBusy) return;
    setTurboActionBusy(true);
    setTurboStartError("");
    onError("");
    onNotice("");
    try {
      const result = await api<{ stopped: boolean; scan: CatalogScanStatus }>("/api/scan/stop", { method: "POST" });
      setRapidScanDialog(null);
      await onRefresh(true);
      onNotice(result.stopped
        ? "本次最高性能扫描已停止；已完成的媒体信息已保留，自动扫描设置保持不变。"
        : "当前没有正在运行或排队的最高性能扫描。");
    } catch (operationError) {
      onError(operationError instanceof Error ? operationError.message : "无法停止最高性能扫描");
    } finally {
      setTurboActionBusy(false);
    }
  };

  return (
    <div className="admin">
      <aside className="admin-nav">
        <div className="admin-brand"><BrandMark /><div><strong>LMD</strong><span>本机管理</span></div></div>
        <nav className="admin-menu">
          <button type="button" className={section === "overview" ? "is-active" : ""} onClick={() => onSectionChange("overview")}><Gauge size={15} />总览</button>
          {overview?.accessControl.enabled && <button type="button" className={section === "access" ? "is-active" : ""} onClick={() => onSectionChange("access")}><ShieldCheck size={15} />访问控制</button>}
          <button type="button" className={section === "settings" ? "is-active" : ""} onClick={() => onSectionChange("settings")}><Settings size={15} />运行设置</button>
        </nav>
        <a className="admin-status" href="/" target="_blank" rel="noopener noreferrer" aria-label="打开观看端（端口 8096）" title="在新标签页打开观看端"><span className={error ? "status-dot status-dot--warning" : "status-dot"} /><div><strong>{error ? "服务异常" : "服务在线"}</strong><span>端口 8096 · 打开观看端</span></div></a>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar"><h1>{sectionTitle}</h1><ThemeToggle theme={theme} onToggle={onToggleTheme} /></header>
        {error && <StatusBanner tone="warning" icon={<AlertTriangle size={14} />}>{error}</StatusBanner>}
        <TimedStatusBanner notice={notice ? { text: notice, tone: "success" } : null} onDismiss={dismissNotice} />
        {section === "overview" && <OverviewPanel overview={overview} musicOverview={musicOverview} readingOverview={readingOverview} photoOverview={photoOverview} onRefresh={onRefresh} onNotice={onNotice} onLibraryAdded={promptForTurboScan} onPlay={onPlay} />}
        {section === "access" && overview?.accessControl.enabled && <AccessControlPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} />}
        {section === "settings" && <SettingsPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} onError={onError} onOpenAccess={() => onSectionChange("access")} onStartTurboScan={() => void startTurboScan()} onStopTurboScan={() => void stopTurboScan()} turboActionBusy={turboActionBusy}
          playbackSettings={playbackSettings} playbackStatus={playbackStatus} onPlaybackSettings={savePlaybackSettings} danmakuSettings={danmakuSettings} onDanmakuSettings={saveDanmakuSettings} />}
      </main>
      {rapidScanDialog && <RapidScanDialog state={rapidScanDialog} scan={overview?.scan || null} starting={turboActionBusy} startError={turboStartError} onStart={() => void startTurboScan()} onClose={() => { setRapidScanDialog(null); setTurboStartError(""); }} />}
    </div>
  );
}

function OverviewPanel({ overview, musicOverview, readingOverview, photoOverview, onRefresh, onNotice, onLibraryAdded, onPlay }: { overview: Overview | null; musicOverview: MusicOverview | null; readingOverview: ReadingOverview | null; photoOverview: PhotoOverview | null; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void; onLibraryAdded: (library: LibraryFolder) => void; onPlay: (media: Media) => void }) {
  const [folderPath, setFolderPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [compatibilityExpanded, setCompatibilityExpanded] = useState(false);
  const media = overview?.media || [];
  const activeJobs = overview?.jobs.filter((job) => ["queued", "running"].includes(job.status)).length || 0;
  const activeMediaIds = new Set(overview?.jobs.filter((job) => ["queued", "running"].includes(job.status)).map((job) => job.mediaId) || []);
  const pendingCompatibility = media.filter((item) => item.compatibility?.needsCompatibleCopy && !item.remuxUrl);
  const remuxConcurrency = overview?.remuxAcceleration?.maxParallelJobs || 1;
  const scanActive = Boolean(overview?.scanning || scanIsActive(overview?.scan));

  const registerLibrary = async (selectedPath: string) => {
    const result = await api<{ libraries: LibraryFolder[]; library: LibraryFolder; added: boolean }>("/api/libraries", {
      method: "POST",
      body: JSON.stringify({ folderPath: selectedPath }),
    });
    setFolderPath("");
    await onRefresh(true);
    if (!result.added) {
      onNotice(`视频目录“${result.library.name}”已经存在，无需重复添加。`);
      return;
    }
    onNotice(`已添加视频目录：${result.library.path}。请选择是否立即进行急速扫描。`);
    onLibraryAdded(result.library);
  };

  const addLibrary = async () => {
    if (!folderPath.trim()) return;
    setBusy(true);
    try {
      await registerLibrary(folderPath.trim());
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "添加失败");
    } finally { setBusy(false); }
  };

  const chooseFolder = async () => {
    setBusy(true);
    onNotice("请在弹出的 Windows 窗口中选择视频文件夹…");
    try {
      const result = await api<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (result.cancelled || !result.path) return onNotice("已取消选择文件夹。");
      setFolderPath(result.path);
      await registerLibrary(result.path);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法选择文件夹");
    } finally { setBusy(false); }
  };

  const removeLibrary = async (library: LibraryFolder) => {
    if (!window.confirm(`确定从 LMD 中移除视频目录“${library.name}”吗？\n\n只会移除目录关联和索引，不会删除硬盘中的任何视频文件。`)) return;
    setBusy(true);
    try {
      const result = await api<{ removedMediaCount: number }>(`/api/libraries/${encodeURIComponent(library.id)}`, { method: "DELETE" });
      onNotice(`已移除视频目录“${library.name}”及 ${result.removedMediaCount} 条索引记录；硬盘中的文件未被删除。`);
      await onRefresh();
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法移除视频目录");
    } finally { setBusy(false); }
  };

  const scan = async () => {
    setBusy(true);
    onNotice("正在扫描目录。视频较多时需要等待片刻…");
    try {
      const result = await api<{ count: number }>("/api/scan", { method: "POST" });
      onNotice(`扫描完成，共发现 ${result.count} 个视频。`);
      await onRefresh();
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "扫描失败");
    } finally { setBusy(false); }
  };

  const toggleAutoScan = async () => {
    if (!overview) return;
    const enabled = !overview.settings.autoScanEnabled;
    setBusy(true);
    try {
      await api("/api/settings/auto-scan", { method: "PATCH", body: JSON.stringify({ enabled }) });
      onNotice(enabled
        ? `已开启自动扫描，每 ${overview.settings.autoScanIntervalSeconds} 秒检查一次媒体目录。`
        : "已关闭自动扫描；仍可在管理端手动重新扫描。");
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改自动扫描状态");
    } finally { setBusy(false); }
  };

  const remux = async (item: Media) => {
    if (!overview?.tools.available) return onNotice(overview?.tools.hint || "尚未找到 FFmpeg。请到运行设置中点击“自动安装 FFmpeg”。");
    await api(`/api/media/${item.id}/remux`, { method: "POST", body: JSON.stringify({ convertAudioToAac: true }) });
    onNotice(`“${item.title}”已加入无损重封装队列；视频码流不会重新压缩。`);
    await onRefresh(true);
  };

  const prepareCompatibleCopies = async () => {
    if (!overview?.tools.available) return onNotice(overview?.tools.hint || "尚未找到 FFmpeg。请到运行设置中点击“自动安装 FFmpeg”。");
    setBusy(true);
    try {
      const result = await api<{ count: number }>("/api/media/prepare-compatible", { method: "POST" });
      onNotice(result.count
        ? `已将 ${result.count} 个视频加入兼容副本队列。当前最多同时处理 ${remuxConcurrency} 个：视频无损复制，音频转换为 AAC。`
        : "没有需要处理的新视频；兼容副本可能已就绪或正在队列中。");
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法创建兼容副本");
    } finally { setBusy(false); }
  };

  return (
    <div className="adm-content adm-content--overview">
      <section className="adm-section">
        <div className="adm-section-head">
          <div><h2>视频目录</h2><p>使用 Windows 选择窗口添加文件夹，程序只读取文件，不会移动原视频；自动扫描统一在管理端控制。</p></div>
          <div className="adm-actions">
            <button type="button" className="btn btn--sm" onClick={toggleAutoScan} disabled={busy || !overview} aria-pressed={Boolean(overview?.settings.autoScanEnabled)}><RefreshCw size={14} className={scanActive ? "spin" : ""} />{overview?.settings.autoScanEnabled ? `自动扫描 ${overview.settings.autoScanIntervalSeconds}s` : "自动扫描已关闭"}</button>
            <button type="button" className="btn btn--sm" onClick={scan} disabled={busy || scanActive || !overview?.libraries.length}><RefreshCw size={14} className={busy || scanActive ? "spin" : ""} />重新扫描</button>
          </div>
        </div>
        {overview?.scan && scanIsActive(overview.scan) && <ScanProgress scan={overview.scan} compact />}
        <div className="adm-add">
          <button type="button" className="btn" onClick={chooseFolder} disabled={busy}><FolderSearch size={15} />选择并添加文件夹</button>
          <input className="input" aria-label="视频目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy && folderPath.trim()) { event.preventDefault(); void addLibrary(); } }} placeholder="也可以手动输入路径，按 Enter 添加" />
        </div>
        <div className="adm-rows">
          {overview?.libraries.length ? overview.libraries.map((library) => (
            <div className="adm-row" key={library.id}>
              <HardDrive size={15} className="adm-row-icon" />
              <div className="adm-row-main"><strong>{library.name}</strong><span>{library.path}</span></div>
              <CheckCircle2 size={14} className="adm-row-ok" />
              <button type="button" className="icon-btn icon-btn--danger" onClick={() => void removeLibrary(library)} disabled={busy} title={`移除目录 ${library.name}`} aria-label={`移除视频目录 ${library.name}`}><Trash2 size={14} /></button>
            </div>
          )) : <div className="adm-rows-empty"><FolderOpen size={16} /><span>还没有媒体目录。添加后才能读取真实视频。</span></div>}
        </div>
      </section>

      <MusicAdminPanel overview={musicOverview} onRefresh={onRefresh} onNotice={onNotice} />

      <ReadingAdminPanel overview={readingOverview} onRefresh={onRefresh} onNotice={onNotice} />

      <PhotoAdminPanel overview={photoOverview} onRefresh={onRefresh} onNotice={onNotice} />

      <DisplayFoldersPanel folders={(overview?.displayFolders || []).filter((folder) => folder.kind !== "music" && folder.kind !== "reading" && folder.kind !== "photo")} onRefresh={onRefresh} onNotice={onNotice} />

      <section className="adm-section">
        <div className="adm-section-head">
          <button type="button" className={`adm-disclosure${compatibilityExpanded ? " is-open" : ""}`} onClick={() => setCompatibilityExpanded((expanded) => !expanded)} aria-expanded={compatibilityExpanded} aria-controls="compatibility-list">
            <ChevronRight size={15} />
            <span className="adm-disclosure-title"><strong>自动兼容处理</strong><span>扫描或启动时会自动检测 MKV、FLAC/Opus 等浏览器不易直放的组合，当前最多同时生成 {remuxConcurrency} 个 MP4 + AAC 副本；视频不重新压缩。</span></span>
          </button>
          <div className="adm-actions">
            <span className="lib-stats">{media.length} 个文件 · {pendingCompatibility.length} 个等待/处理中</span>
            <button type="button" className="btn btn--sm" onClick={prepareCompatibleCopies} disabled={busy || !pendingCompatibility.length}><RefreshCw size={14} className={activeJobs ? "spin" : ""} />重新检查自动队列</button>
          </div>
        </div>
        {compatibilityExpanded && <div className="adm-rows" id="compatibility-list">
          {media.length ? media.map((item) => (
            <div className="adm-row" key={item.id}>
              <div className="adm-row-main"><strong>{item.title}</strong><span>{item.path}</span></div>
              <div className="adm-row-tech"><span className="tag">{item.extension}</span><span className="tag">{codecName(item.videoCodec)}</span><span className="tag">{item.bitDepth || 8}-bit</span>{item.hdr && <span className="tag">{item.hdr}</span>}</div>
              <div className="adm-row-actions">
                <button type="button" className="icon-btn" title="预览播放" aria-label={`预览播放 ${item.title}`} onClick={() => onPlay(item)}><Play size={14} /></button>
                <button type="button" className="btn btn--sm" onClick={() => remux(item)} disabled={Boolean(item.remuxUrl) || activeMediaIds.has(item.id)}>{item.remuxUrl ? <><Check size={13} />兼容副本就绪</> : activeMediaIds.has(item.id) ? <><LoaderCircle size={13} className="spin" />处理中</> : <>重封装 + AAC</>}</button>
              </div>
            </div>
          )) : <div className="adm-rows-empty"><Film size={16} /><span>媒体库还是空的。先在上方添加一个视频目录，再执行扫描。</span></div>}
        </div>}
      </section>

      {!!overview?.jobs.length && <JobsPanel jobs={overview.jobs} maxParallelJobs={remuxConcurrency} />}
    </div>
  );
}

function DisplayFoldersPanel({ folders, onRefresh, onNotice }: { folders: DisplayFolder[]; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <button type="button" className={`adm-disclosure${expanded ? " is-open" : ""}`} onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="display-folders-list">
          <ChevronRight size={15} />
          <span className="adm-disclosure-title"><strong>网页作品代号</strong><span>每个视频文件夹填写一次作品名和季度；只改变网页显示，不修改原视频或字幕文件名。</span></span>
        </button>
        <div className="adm-actions"><span className="lib-stats">{folders.filter((folder) => folder.configured).length}/{folders.length} 个已设置</span></div>
      </div>
      {expanded && <div className="adm-rows" id="display-folders-list">
        {folders.length ? folders.map((folder) => <DisplayFolderRow key={folder.id} folder={folder} onRefresh={onRefresh} onNotice={onNotice} />) : <div className="adm-rows-empty"><FolderOpen size={16} /><span>还没有可设置的作品文件夹。添加视频目录并扫描后会自动列出。</span></div>}
      </div>}
    </section>
  );
}

function DisplayFolderRow({ folder, onRefresh, onNotice }: { folder: DisplayFolder; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void }) {
  const [title, setTitle] = useState(folder.customTitle);
  const [season, setSeason] = useState(folder.season);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setTitle(folder.customTitle); setSeason(folder.season); }, [folder.customTitle, folder.season]);
  const episode = Number(folder.sampleAlias.match(/E(\d+)$/)?.[1] || 1);
  const previewTitle = title.trim() || folder.folderName || folder.title;
  const preview = `${previewTitle} - S${String(season || 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

  const save = async () => {
    if (!title.trim()) return onNotice(`请先为“${folder.folderName}”填写作品名。`);
    setSaving(true);
    try {
      await api(`/api/display-groups/${folder.id}`, { method: "PATCH", body: JSON.stringify({ title: title.trim(), season }) });
      onNotice(`“${title.trim()}”的网页代号已保存；磁盘文件名没有改变。`);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法保存作品代号");
    } finally { setSaving(false); }
  };

  return (
    <div className="adm-row adm-row--form">
      <div className="adm-row-main"><strong>{folder.folderName}</strong><span>{folder.path}</span><small>{folder.mediaCount} 个视频 · 示例：{preview}</small></div>
      <div className="adm-row-form">
        <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="作品名，例如：缘之空" aria-label={`${folder.folderName} 作品名`} />
        <input className="input input--num" type="number" min="1" max="99" value={season} onChange={(event) => setSeason(Number(event.target.value))} aria-label={`${folder.folderName} 季度`} title="季度" />
        <button type="button" className="btn btn--primary btn--sm" onClick={save} disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}保存</button>
      </div>
    </div>
  );
}

function JobsPanel({ jobs, maxParallelJobs }: { jobs: Job[]; maxParallelJobs: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <button type="button" className={`adm-disclosure${expanded ? " is-open" : ""}`} onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="automatic-jobs-list">
          <ChevronRight size={15} />
          <span className="adm-disclosure-title"><strong>自动处理队列</strong><span>这里只改变容器和必要的音频格式，视频画面码流原样复制；当前最多同时处理 {maxParallelJobs} 部。</span></span>
        </button>
        <div className="adm-actions"><span className="lib-stats">{jobs.length} 个任务</span></div>
      </div>
      {expanded && <div className="adm-rows" id="automatic-jobs-list">
        {jobs.slice(0, 5).map((job) => (
          <div className="job-row" key={job.id}>
            <span className={`job-status ${job.status}`}>{job.status === "running" ? <LoaderCircle size={14} className="spin" /> : job.status === "completed" ? <Check size={14} /> : job.status === "failed" ? <X size={14} /> : <RefreshCw size={14} />}</span>
            <div className="job-main"><strong>{job.title}</strong><span>{job.type} · {job.message}</span></div>
            <div className="job-progress"><div className="progress"><span style={{ width: `${job.progress}%` }} /></div><b>{job.progress}%</b></div>
          </div>
        ))}
      </div>}
    </section>
  );
}

function generateAccessCode() {
  const ceiling = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  let value = ceiling;
  while (value >= ceiling) value = window.crypto.getRandomValues(new Uint32Array(1))[0];
  return String(value % 1_000_000).padStart(6, "0");
}

async function copyAccessCode(value: string, onNotice: (value: string) => void) {
  try {
    await navigator.clipboard.writeText(value);
    onNotice("访问码已复制到剪贴板。");
  } catch {
    onNotice("浏览器无法自动复制，请手动选中访问码复制。");
  }
}

function AccessControlPanel({ overview, onRefresh, onNotice }: {
  overview: Overview | null;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (value: string) => void;
}) {
  const accessControl = overview?.accessControl;
  const categories = accessControl?.categories || [];
  const [accessCode, setAccessCode] = useState(generateAccessCode);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const toggleCategory = (categoryId: string) => {
    setCategoryIds((current) => current.includes(categoryId) ? current.filter((id) => id !== categoryId) : [...current, categoryId]);
  };

  const createUser = async () => {
    if (!/^\d{6}$/.test(accessCode)) return onNotice("访问码必须是六位数字。");
    if (!categoryIds.length) return onNotice("请至少选择一个允许该访问码查看的文件夹分类。");
    setBusy(true);
    try {
      await api<AccessUser>("/api/access-control/users", { method: "POST", body: JSON.stringify({ accessCode, categoryIds }) });
      onNotice(`访问码 ${accessCode} 已关联一个用户。请复制后通过可信方式交给对方；服务端不会保存明文。`);
      setCategoryIds([]);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法创建访问用户");
    } finally { setBusy(false); }
  };

  return (
    <div className="adm-content">
      <section className="adm-section">
        <div className="adm-section-head">
          <div><h2>分类访问控制</h2><p>未归类的视频、音乐、阅读或图片文件夹会自动进入“未分类”，可与“全年龄”“R-18”等分类一样授权给六位访问码用户。关闭功能请前往“运行设置”。</p></div>
          <div className="adm-stats">
            <span><strong>{accessControl?.users.filter((user) => user.enabled).length || 0}</strong> 位已启用用户</span>
            <span><strong>{categories.length}</strong> 个文件夹分类</span>
            <span><strong>{accessControl?.activeSessions || 0}</strong> 个有效登录</span>
          </div>
        </div>
      </section>

      <section className="adm-section">
        <div className="adm-section-head">
          <div><h2>添加访问码用户</h2><p>不需要用户名；每一个六位访问码就是一个独立用户，并按分类获得权限。</p></div>
        </div>
        <div className="access-user-form">
          <label className="field"><span>六位数字访问码（创建后仅保存加密摘要）</span><span className="access-code-input"><input className="input" inputMode="numeric" pattern="[0-9]{6}" value={accessCode} onChange={(event) => setAccessCode(event.target.value.replace(/\D/g, "").slice(0, 6))} minLength={6} maxLength={6} /><button className="icon-btn" type="button" onClick={() => setAccessCode(generateAccessCode())} title="重新生成六位访问码"><RefreshCw size={14} /></button><button className="icon-btn" type="button" onClick={() => void copyAccessCode(accessCode, onNotice)} title="复制访问码"><Copy size={14} /></button></span></label>
          <div className="field"><span>允许访问的分类</span><div className="chip-checks">
            {categories.map((category) => <label key={category.id} className={`chip-check${categoryIds.includes(category.id) ? " is-selected" : ""}`}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleCategory(category.id)} /><strong>{category.name}</strong><small>{category.system ? `自动归类 · ${category.folderIds.length} 个文件夹` : `${category.folderIds.length} 个文件夹`}</small></label>)}
          </div></div>
          <div><button type="button" className="btn btn--primary" onClick={createUser} disabled={busy || !/^\d{6}$/.test(accessCode) || !categoryIds.length}><UserRoundPlus size={15} />关联为新用户</button></div>
        </div>
      </section>

      <section className="adm-section">
        <div className="adm-section-head">
          <div><h2>访问码用户与分类权限</h2><p>每个访问码只关联一个用户；分类权限修改立即生效。</p></div>
          <div className="adm-actions"><span className="lib-stats">{accessControl?.users.length || 0} 位用户</span></div>
        </div>
        <div className="access-user-list">
          {accessControl?.users.length ? accessControl.users.map((user, index) => <AccessUserCard key={user.id} user={user} userNumber={index + 1} categories={categories} onRefresh={onRefresh} onNotice={onNotice} />) : <div className="empty-state"><UserRoundPlus size={24} /><strong>还没有访问码用户</strong><span>先在上方生成六位访问码并选择允许访问的分类。</span></div>}
        </div>
      </section>

      <FolderCategoriesPanel folders={overview?.accessFolders || overview?.displayFolders || []} categories={categories} onRefresh={onRefresh} onNotice={onNotice} />
    </div>
  );
}

function FolderCategoriesPanel({ folders, categories, onRefresh, onNotice }: {
  folders: DisplayFolder[];
  categories: AccessCategory[];
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (value: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const editableCategories = categories.filter((category) => !category.system);

  const addCategory = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/api/access-control/categories", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      onNotice(`文件夹分类“${name.trim()}”已建立。`);
      setName("");
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法建立文件夹分类");
    } finally { setBusy(false); }
  };

  const assignFolder = async (folder: DisplayFolder, categoryId: string) => {
    setBusy(true);
    try {
      await api(`/api/access-control/folders/${folder.id}`, { method: "PATCH", body: JSON.stringify({ categoryId: categoryId || null }) });
      const categoryName = editableCategories.find((category) => category.id === categoryId)?.name;
      onNotice(categoryName ? `“${folder.title}”已归入“${categoryName}”。` : `“${folder.title}”已归入系统分类“未分类”。`);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改文件夹分类");
    } finally { setBusy(false); }
  };

  const categoryForFolder = (folderId: string) => editableCategories.find((category) => category.folderIds.includes(folderId))?.id || "";
  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <div><h2>文件夹分类</h2><p>每个媒体大目录只列出其下最多两层的权限文件夹，例如“アニメ / Monogatari Series / 01. Bakemonogatari”；更深层内容会自动继承。未手动归类的文件夹进入“未分类”。</p></div>
        <div className="adm-actions"><span className="lib-stats">{categories.length} 个分类</span></div>
      </div>
      <div className="adm-add">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) void addCategory(); }} maxLength={40} placeholder="新分类，例如：儿童专区" aria-label="新分类名称" />
        <button type="button" className="btn btn--primary" onClick={addCategory} disabled={busy || !name.trim()}>建立分类</button>
      </div>
      <div className="adm-rows category-editor-list">
        {categories.map((category) => <AccessCategoryEditor key={category.id} category={category} onRefresh={onRefresh} onNotice={onNotice} />)}
      </div>
      <div className="adm-rows folder-classification-list">
        {folders.length ? folders.map((folder) => {
          const typeLabel = folder.kind === "music" ? "音乐" : folder.kind === "reading" ? "阅读" : folder.kind === "photo" ? "图片" : "视频";
          const countLabel = folder.kind === "music" ? `${folder.mediaCount} 首歌曲` : folder.kind === "reading" ? `${folder.ebookCount || 0} 本书 · ${folder.spreadsheetCount || 0} 个表格` : folder.kind === "photo" ? `${folder.mediaCount} 张图片` : `${folder.mediaCount} 个视频`;
          return <div className="adm-row" key={folder.id}><div className="adm-row-main"><strong>{folder.title}</strong><span>{folder.libraryName || folder.folderName} · {countLabel} · {typeLabel}</span></div><select className="select" value={categoryForFolder(folder.id)} onChange={(event) => void assignFolder(folder, event.target.value)} disabled={busy} aria-label={`${folder.title} 的分类`}><option value="">未分类</option>{editableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>;
        }) : <div className="adm-rows-empty">请先在“总览”添加媒体目录并完成扫描。</div>}
      </div>
    </section>
  );
}

function AccessCategoryEditor({ category, onRefresh, onNotice }: {
  category: AccessCategory;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (value: string) => void;
}) {
  const [name, setName] = useState(category.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(category.name); }, [category.name]);

  if (category.system) {
    return <div className="adm-row system-category-row"><div className="adm-row-main"><strong>{category.name}</strong><span>系统分类 · 自动归入</span></div><span className="adm-row-meta">{category.folderIds.length} 个文件夹</span></div>;
  }

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/access-control/categories/${category.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      onNotice(`分类已改名为“${name.trim()}”。`);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改分类");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm(`确定删除分类“${category.name}”吗？其中的文件夹会变为未分类，相关用户也会失去该分类权限。`)) return;
    setBusy(true);
    try {
      await api(`/api/access-control/categories/${category.id}`, { method: "DELETE" });
      onNotice(`分类“${category.name}”已删除。`);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法删除分类");
    } finally { setBusy(false); }
  };

  return <div className="adm-row"><div className="adm-row-form"><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} aria-label={`分类 ${category.name} 名称`} /></div><span className="adm-row-meta">{category.folderIds.length} 个文件夹</span><div className="adm-row-actions"><button type="button" className="btn btn--sm" onClick={save} disabled={busy || !name.trim() || name.trim() === category.name}><Check size={13} />保存</button><button type="button" className="icon-btn icon-btn--danger" onClick={() => void remove()} disabled={busy} title="删除分类"><Trash2 size={14} /></button></div></div>;
}

function AccessUserCard({ user, userNumber, categories, onRefresh, onNotice }: {
  user: AccessUser;
  userNumber: number;
  categories: AccessCategory[];
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (value: string) => void;
}) {
  const [categoryIds, setCategoryIds] = useState(user.categoryIds);
  const [busy, setBusy] = useState(false);
  const [newAccessCode, setNewAccessCode] = useState("");
  useEffect(() => { setCategoryIds(user.categoryIds); }, [user.categoryIds]);

  const toggleCategory = (categoryId: string) => {
    setCategoryIds((current) => current.includes(categoryId) ? current.filter((id) => id !== categoryId) : [...current, categoryId]);
  };

  const updateUser = async (body: Record<string, unknown>, successMessage: string) => {
    setBusy(true);
    try {
      await api(`/api/access-control/users/${user.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onNotice(successMessage);
      await onRefresh(true);
      return true;
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法更新访问码用户");
      return false;
    } finally { setBusy(false); }
  };

  const resetAccessCode = async () => {
    const code = generateAccessCode();
    if (await updateUser({ accessCode: code }, `访问码用户 ${userNumber} 的访问码已重置，旧登录已失效。请复制下方新访问码。`)) setNewAccessCode(code);
  };

  const deleteUser = async () => {
    if (!window.confirm(`确定删除访问码用户 ${userNumber} 吗？该用户会立即退出。`)) return;
    setBusy(true);
    try {
      await api(`/api/access-control/users/${user.id}`, { method: "DELETE" });
      onNotice(`访问码用户 ${userNumber} 已删除。`);
      await onRefresh(true);
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法删除访问码用户");
    } finally { setBusy(false); }
  };

  const permissionsChanged = JSON.stringify([...categoryIds].sort()) !== JSON.stringify([...user.categoryIds].sort());
  return (
    <div className={`user-block${user.enabled ? "" : " is-disabled"}`}>
      <div className="user-head">
        <div className="user-id"><span className="user-avatar">{String(userNumber).padStart(2, "0")}</span><div><strong>访问码用户 {userNumber}</strong><span>{user.lastLoginAt ? `上次登录：${new Date(user.lastLoginAt).toLocaleString("zh-CN")}` : "尚未登录"} · {user.enabled ? "已启用" : "已禁用"}</span></div></div>
        <div className="user-actions"><button type="button" className="btn btn--sm" disabled={busy} onClick={() => void updateUser({ enabled: !user.enabled }, user.enabled ? `访问码用户 ${userNumber} 已禁用并退出所有设备。` : `访问码用户 ${userNumber} 已重新启用。`)}>{user.enabled ? "禁用" : "启用"}</button><button type="button" className="icon-btn icon-btn--danger" disabled={busy} onClick={() => void deleteUser()} title="删除用户"><Trash2 size={14} /></button></div>
      </div>
      <div className="chip-checks">
        {categories.map((category) => <label key={category.id} className={`chip-check${categoryIds.includes(category.id) ? " is-selected" : ""}`}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleCategory(category.id)} disabled={busy} /><strong>{category.name}</strong><small>{category.system ? `自动归类 · ${category.folderIds.length} 个文件夹` : `${category.folderIds.length} 个文件夹`}</small></label>)}
      </div>
      <div className="user-foot">
        <button type="button" className="btn btn--sm" disabled={busy || !permissionsChanged || !categoryIds.length} onClick={() => void updateUser({ categoryIds }, `访问码用户 ${userNumber} 的分类权限已保存并立即生效。`)}><Check size={13} />保存分类权限</button>
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void resetAccessCode()}><KeyRound size={13} />重置六位访问码</button>
        {newAccessCode && <span className="access-code"><span>新访问码</span><code>{newAccessCode}</code><button type="button" className="icon-btn" onClick={() => void copyAccessCode(newAccessCode, onNotice)} title="复制新访问码"><Copy size={13} /></button></span>}
      </div>
    </div>
  );
}

function SettingsPanel({ overview, onRefresh, onNotice, onError, onOpenAccess, onStartTurboScan, onStopTurboScan, turboActionBusy, playbackSettings, playbackStatus, onPlaybackSettings, danmakuSettings, onDanmakuSettings }: {
  overview: Overview | null;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (value: string) => void;
  onError: (value: string) => void;
  onOpenAccess: () => void;
  onStartTurboScan: () => void;
  onStopTurboScan: () => void;
  turboActionBusy: boolean;
  playbackSettings: PlaybackSettings | null;
  playbackStatus: PlaybackStatus | null;
  onPlaybackSettings: (patch: Partial<PlaybackSettings>) => Promise<void>;
  danmakuSettings: DanmakuSettings | null;
  onDanmakuSettings: (body: { appId?: string; appSecret?: string; clear?: boolean }) => Promise<void>;
}) {
  const [accelerationBusy, setAccelerationBusy] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [installState, setInstallState] = useState<MediaToolsInstallStatus | null>(null);
  const installStateRef = useRef<MediaToolsInstallStatus | null>(null);
  installStateRef.current = installState;
  const installActive = Boolean(installState && ["downloading", "extracting", "installing"].includes(installState.status));
  const [compatibleDirectory, setCompatibleDirectory] = useState(overview?.settings.compatibleCopyDirectory || "");
  useEffect(() => { setCompatibleDirectory(overview?.settings.compatibleCopyDirectory || ""); }, [overview?.settings.compatibleCopyDirectory]);
  // 打开运行设置时同步一次安装状态，避免安装进行中时界面停留在“等待安装”。
  useEffect(() => {
    let stopped = false;
    api<MediaToolsInstallStatus>("/api/tools/install/status")
      .then((state) => { if (!stopped) setInstallState(state); })
      .catch(() => {});
    return () => { stopped = true; };
  }, []);
  // 安装进行中每秒轮询进度；状态转为结束时刷新总览并提示结果。
  useEffect(() => {
    if (!installActive) return;
    let stopped = false;
    let finishedHandled = false;
    const tick = async () => {
      try {
        const state = await api<MediaToolsInstallStatus>("/api/tools/install/status");
        if (stopped) return;
        const wasActive = Boolean(installStateRef.current && ["downloading", "extracting", "installing"].includes(installStateRef.current.status));
        setInstallState(state);
        if (wasActive && !["downloading", "extracting", "installing"].includes(state.status) && !finishedHandled) {
          finishedHandled = true;
          await onRefresh();
          if (state.status === "completed") onNotice(state.message || "FFmpeg 安装完成。");
          else if (state.status === "failed") onError(state.error || "FFmpeg 安装失败，请重试。");
          else onNotice(state.message || "FFmpeg 安装已取消。");
        }
      } catch {
        // 状态接口暂时不可用，等待下一次轮询。
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [installActive, onRefresh, onNotice, onError]);
  const installOrUpdateTools = async () => {
    try {
      const result = await api<{ ok: boolean; alreadyLatest?: boolean; started?: boolean; latestVersion?: string | null; installedVersion?: string | null }>("/api/tools/install", { method: "POST" });
      if (result.alreadyLatest) {
        onNotice(`FFmpeg 已是最新版本 ${result.latestVersion}，无需更新。`);
        return;
      }
      setInstallState({
        status: "downloading",
        progress: 0,
        message: "正在准备下载 FFmpeg…",
        error: "",
        latestVersion: result.latestVersion,
        bytesDownloaded: 0,
        bytesTotal: 0,
        startedAt: new Date().toISOString(),
      });
      onNotice("已开始自动安装 FFmpeg，正在下载最新版本，请保持网络畅通…");
    } catch (operationError) {
      // 旧版服务端没有 /api/tools/install 路由，会返回 404“没有找到这个地址”。
      const message = operationError instanceof Error ? operationError.message : "";
      if (message.includes("没有找到这个地址")) {
        onError("服务端还是旧版本。请在系统托盘退出 LMD（右键托盘图标 → 退出托盘），再重新双击“启动LMD.vbs”，然后重试自动安装。");
      } else {
        onError(message || "无法启动 FFmpeg 安装");
      }
    }
  };
  const cancelInstall = async () => {
    try {
      await api("/api/tools/install/cancel", { method: "POST" });
      onNotice("正在取消 FFmpeg 安装…");
    } catch (operationError) {
      onError(operationError instanceof Error ? operationError.message : "无法取消 FFmpeg 安装");
    }
  };
  const acceleration = overview?.remuxAcceleration;
  const scanStatus = overview?.scan;
  const turboScanPending = scanStatus?.pendingMode === "turbo";
  const turboScanRunning = Boolean(scanStatus?.mode === "turbo" && scanIsActive(scanStatus));
  const turboScanActive = turboScanPending || turboScanRunning;
  const accelerationEndsAt = acceleration?.expiresAt
    ? new Date(acceleration.expiresAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  const refreshTools = async () => { await api("/api/tools/refresh", { method: "POST" }); await onRefresh(); onNotice("已重新检查媒体工具。 "); };
  const toggleAutostart = async () => {
    const enabled = !overview?.autostart.enabled;
    try {
      await api("/api/autostart", { method: "POST", body: JSON.stringify({ enabled }) });
      await onRefresh();
      onNotice(enabled ? "已开启开机自启；下次登录 Windows 后 LMD 会在后台启动。" : "已关闭开机自启。");
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改开机自启设置");
    }
  };
  const toggleAccessControl = async () => {
    const enabled = !overview?.accessControl.enabled;
    try {
      await api("/api/access-control", { method: "PATCH", body: JSON.stringify({ enabled }) });
      await onRefresh(true);
      onNotice(enabled ? "访问控制已开启。请设置文件夹分类并添加六位访问码用户。" : "访问控制已关闭，访客已恢复无需登录的简洁访问模式。");
      if (enabled) onOpenAccess();
    } catch (operationError) {
      onNotice(operationError instanceof Error ? operationError.message : "无法修改访问控制设置");
    }
  };
  const toggleRemuxAcceleration = async () => {
    if (!overview) return;
    const enabled = !overview.remuxAcceleration?.enabled;
    setAccelerationBusy(true);
    onNotice("");
    onError("");
    try {
      await api("/api/settings/remux-acceleration", { method: "PATCH", body: JSON.stringify({ enabled }) });
      await onRefresh(true);
      onNotice(enabled
        ? `并行加速已开启，最多同时处理 ${overview.remuxAcceleration?.acceleratedParallelJobs || 3} 部视频；12 小时后自动关闭。`
        : "并行加速已关闭；正在运行的任务会自然完成，后续恢复单任务处理。");
    } catch (operationError) {
      onError(operationError instanceof Error ? operationError.message : "无法修改重封装并行加速设置");
    } finally {
      setAccelerationBusy(false);
    }
  };
  const chooseCompatibleDirectory = async () => {
    setDirectoryBusy(true);
    onError("");
    onNotice("请在弹出的 Windows 窗口中选择兼容视频保存文件夹…");
    try {
      const result = await api<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (result.cancelled || !result.path) return onNotice("已取消选择保存文件夹。");
      setCompatibleDirectory(result.path);
      onNotice("已选择新地址；点击“保存地址并迁移”后才会生效。");
    } catch (operationError) {
      onError(operationError instanceof Error ? operationError.message : "无法选择兼容视频保存文件夹");
    } finally {
      setDirectoryBusy(false);
    }
  };
  const saveCompatibleDirectory = async () => {
    if (!compatibleDirectory.trim()) return;
    setDirectoryBusy(true);
    onError("");
    onNotice("正在保存地址并迁移现有兼容视频，请勿关闭 LMD…");
    try {
      const result = await api<{ directory: string; movedFiles: number; movedBytes: number }>("/api/settings/compatible-copy-directory", {
        method: "PATCH",
        body: JSON.stringify({ directoryPath: compatibleDirectory.trim(), moveExisting: true }),
      });
      await onRefresh(true);
      onNotice(`兼容视频地址已更新为 ${result.directory}；已迁移 ${result.movedFiles} 个文件（${formatBytes(result.movedBytes)}）。`);
    } catch (operationError) {
      onError(operationError instanceof Error ? operationError.message : "无法更新兼容视频保存地址");
    } finally {
      setDirectoryBusy(false);
    }
  };
  return (

    <div className="adm-content">
      <section className="adm-section">
        <div className="adm-section-head"><div><h2>存储与媒体工具</h2><p>兼容副本的保存位置与转码工具状态。</p></div></div>
        <div className="setting-row">
          <div className="setting-label"><strong>兼容视频保存地址</strong><span>以后生成的 MP4 兼容副本会保存到这里。保存新地址时会移动现有兼容副本，不会移动原视频、缩略图或字幕缓存；有扫描、重封装或播放任务时会暂停迁移。当前地址：{overview?.settings.compatibleCopyDirectory || "正在读取…"}</span></div>
          <div className="setting-control">
            <button type="button" className="btn btn--sm" onClick={chooseCompatibleDirectory} disabled={directoryBusy}><FolderSearch size={14} />选择文件夹</button>
            <input className="input" aria-label="兼容视频保存地址" value={compatibleDirectory} onChange={(event) => setCompatibleDirectory(event.target.value)} placeholder="例如 D:\LMD兼容视频" disabled={directoryBusy} />
            <button type="button" className="btn btn--primary btn--sm" onClick={saveCompatibleDirectory} disabled={directoryBusy || !compatibleDirectory.trim() || compatibleDirectory.trim() === overview?.settings.compatibleCopyDirectory}>{directoryBusy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{directoryBusy ? "正在处理" : "保存地址并迁移"}</button>
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-label">
            <strong>{installActive ? "正在安装 FFmpeg…" : overview?.tools.available ? "FFmpeg 已就绪" : "等待安装 FFmpeg"}</strong>
            <span>{installActive ? installState?.message || "正在准备下载…" : overview?.tools.available ? overview.tools.version : overview?.tools.hint}</span>
            {installActive && <div className="install-progress"><div className="progress"><span style={{ width: `${Math.max(1, installState?.progress || 0)}%` }} /></div><small>{installState?.progress || 0}%{installState?.bytesTotal ? ` · ${formatBytes(installState.bytesDownloaded)} / ${formatBytes(installState.bytesTotal)}` : ""}</small></div>}
          </div>
          <div className="setting-control">
            {installActive ? <button type="button" className="btn btn--danger btn--sm" onClick={() => void cancelInstall()}><X size={14} />取消安装</button> : <>
              {overview?.tools.installable !== false && <button type="button" className={overview?.tools.available ? "btn btn--sm" : "btn btn--primary btn--sm"} onClick={() => void installOrUpdateTools()} disabled={!overview}><Download size={14} />{overview?.tools.available ? (overview.tools.source === "path" ? "安装内置 FFmpeg" : "检查更新并安装") : "自动安装 FFmpeg"}</button>}
              <button type="button" className="btn btn--sm" onClick={refreshTools}><RefreshCw size={14} />重新检查</button>
            </>}
          </div>
        </div>
      </section>
      <section className="adm-section">
        <div className="adm-section-head"><div><h2>性能</h2><p>重封装并行加速与最高性能扫描。</p></div></div>
        <div className="setting-row">
          <div className="setting-label"><strong>并行加速重封装{acceleration?.enabled ? "已开启" : "已关闭"}</strong><span>{acceleration?.enabled ? `最多同时处理 ${acceleration.maxParallelJobs} 部，当前运行 ${acceleration.activeJobs} 部、排队 ${acceleration.queuedJobs} 部。剩余 ${formatRemainingTime(acceleration.remainingSeconds)}，将在 ${accelerationEndsAt} 自动关闭；关闭时不会中断正在运行的任务。` : `开启后最多同时处理 ${acceleration?.acceleratedParallelJobs || 3} 部视频，12 小时后自动恢复单任务模式；加速期间会增加磁盘并发读写。`}</span></div>
          <div className="setting-control"><button type="button" className={acceleration?.enabled ? "btn btn--sm" : "btn btn--primary btn--sm"} onClick={toggleRemuxAcceleration} disabled={!overview || accelerationBusy || (!overview.tools.available && !acceleration?.enabled)} aria-pressed={Boolean(acceleration?.enabled)} aria-busy={accelerationBusy}>{accelerationBusy ? <LoaderCircle size={14} className="spin" /> : <Gauge size={14} />}{accelerationBusy ? (acceleration?.enabled ? "正在关闭加速" : "正在开启加速") : acceleration?.enabled ? "立即关闭加速" : "开启 12 小时加速"}</button></div>
        </div>
        <div className="setting-row">
          <div className="setting-label"><strong>最高性能扫描{turboScanActive ? "（进行中）" : ""}</strong><span>按本机处理器数量大幅提高文件检查和媒体分析并发，适合添加大型目录后使用；仅对本次任务生效。</span>{scanStatus && turboScanActive && <ScanProgress scan={scanStatus} compact />}</div>
          <div className="setting-control"><button type="button" className={turboScanActive ? "btn btn--danger btn--sm" : "btn btn--sm"} onClick={turboScanActive ? onStopTurboScan : onStartTurboScan} disabled={!overview?.libraries.length || turboActionBusy} aria-busy={turboActionBusy} aria-pressed={turboScanActive}>{turboActionBusy ? <LoaderCircle size={14} className="spin" /> : turboScanActive ? <X size={14} /> : <FolderSearch size={14} />}{turboActionBusy ? (turboScanActive ? "正在停止" : "正在启动") : turboScanActive ? "停止最高性能扫描" : "开启最高性能扫描"}</button></div>
        </div>
      </section>
      <section className="adm-section">
        <div className="adm-section-head"><div><h2>系统</h2></div></div>
        <div className="setting-row">
          <div className="setting-label"><strong>开机自启{overview?.autostart.enabled ? "已开启" : "已关闭"}</strong><span>开启后，每次登录 Windows 都会在后台启动 LMD；不会自动打开管理网页或信息窗口。</span></div>
          <div className="setting-control"><button type="button" className={overview?.autostart.enabled ? "btn btn--sm" : "btn btn--primary btn--sm"} onClick={toggleAutostart}>{overview?.autostart.enabled ? "关闭开机自启" : "开启开机自启"}</button></div>
        </div>
        <div className="setting-row">
          <div className="setting-label"><strong>访问控制{overview?.accessControl.enabled ? "已开启" : "已关闭"}</strong><span>{overview?.accessControl.enabled ? "局域网访客必须输入六位数字访问码；“访问控制”菜单已显示，可设置文件夹分类和用户权限。" : "当前保持原来的简洁访问方式；开启后才会显示“访问控制”选项。"}</span></div>
          <div className="setting-control"><button type="button" className={overview?.accessControl.enabled ? "btn btn--sm" : "btn btn--primary btn--sm"} onClick={toggleAccessControl}>{overview?.accessControl.enabled ? "关闭并返回简洁版" : "开启访问控制"}</button></div>
        </div>
      </section>
            <section className="adm-section">
        <div className="adm-section-head"><div><h2>视频播放缓存与会话</h2><p>兼容播放按需生成临时分片，容量与租约在这里统一限制；不影响原视频与音乐模块。</p></div></div>
        <PlaybackSettingsCard settings={playbackSettings} status={playbackStatus} onSave={async (patch) => {
          try { await onPlaybackSettings(patch); onNotice("播放设置已保存，新的播放会话立即生效。"); }
          catch (operationError) { onError(operationError instanceof Error ? operationError.message : "无法保存播放设置"); }
        }} />
      </section>
      <section className="adm-section">
        <div className="adm-section-head"><div><h2>弹弹play 凭证</h2><p>凭证只保存在本机后端文件，不进入前端包、观看端响应或发布包；没有凭证时仍可导入本地弹幕。</p></div></div>
        <DanmakuSettingsCard settings={danmakuSettings} onSave={async (body) => {
          try { await onDanmakuSettings(body); onNotice(body.clear ? "已清除本机弹弹play凭证。" : "弹幕凭证已保存到本机后端。"); }
          catch (operationError) { onError(operationError instanceof Error ? operationError.message : "无法保存弹幕凭证"); }
        }} />
      </section>
<section className="adm-section">
        <div className="adm-section-head"><div><h2>关于</h2><p>不是一个云玩家呢 · Codex —— 共同参与 LMD 的设计、开发与维护。</p></div></div>
      </section>
    </div>
  );
}


function StatusBanner({ children, icon, tone, countdown }: { children: React.ReactNode; icon: React.ReactNode; tone: "warning" | "success"; countdown?: number }) {
  return <div className={`banner ${tone === "warning" ? "banner--warning" : "banner--success"}`} role={tone === "warning" ? "alert" : "status"} aria-live={tone === "warning" ? "assertive" : "polite"}>{icon}<span>{children}</span>{countdown !== undefined && <span className="banner-countdown" aria-hidden="true">{countdown}s 后关闭</span>}</div>;
}

const NOTICE_AUTO_DISMISS_MS = 4_000;

function TimedStatusBanner({ notice, onDismiss }: { notice: { text: string; tone: "warning" | "success" } | null; onDismiss: () => void }) {
  const [secondsRemaining, setSecondsRemaining] = useState(Math.ceil(NOTICE_AUTO_DISMISS_MS / 1_000));

  useEffect(() => {
    if (!notice) return;
    const closeAt = Date.now() + NOTICE_AUTO_DISMISS_MS;
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((closeAt - Date.now()) / 1_000));
      setSecondsRemaining(seconds);
      if (seconds === 0) onDismiss();
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [notice?.text, notice?.tone, onDismiss]);

  if (!notice) return null;
  return <StatusBanner tone={notice.tone} icon={notice.tone === "warning" ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />} countdown={secondsRemaining}>{notice.text}</StatusBanner>;
}

/** Playback cache, buffer and lease limits; values mirror the server defaults. */
function PlaybackSettingsCard({ settings, status, onSave }: { settings: PlaybackSettings | null; status: PlaybackStatus | null; onSave: (patch: Partial<PlaybackSettings>) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ cacheGib: 10, ttlHours: 6, ahead: 30, back: 30, heartbeat: 10, lease: 45, initialLease: 20, noOutput: 30 });
  useEffect(() => {
    if (!settings) return;
    setForm({ cacheGib: Math.round(settings.cacheMaxBytes / 1024 ** 3 * 10) / 10, ttlHours: Math.round(settings.cacheTtlSeconds / 360) / 10,
      ahead: settings.aheadSeconds, back: settings.backBufferSeconds, heartbeat: settings.heartbeatSeconds,
      lease: settings.leaseSeconds, initialLease: settings.initialLeaseSeconds, noOutput: settings.noOutputSeconds });
  }, [settings]);
  const number = (label: string, key: keyof typeof form, min: number, max: number, step: number) =>
    <label>{label}<input type="number" min={min} max={max} step={step} value={form[key]}
      onChange={(event) => setForm(current => ({ ...current, [key]: Number(event.target.value) }))} /></label>;
  const submit = async () => {
    setBusy(true);
    try {
      await onSave({ cacheMaxBytes: Math.round(form.cacheGib * 1024 ** 3), cacheTtlSeconds: Math.round(form.ttlHours * 3600),
        aheadSeconds: form.ahead, backBufferSeconds: form.back, heartbeatSeconds: form.heartbeat,
        leaseSeconds: form.lease, noOutputSeconds: form.noOutput });
    } finally { setBusy(false); }
  };
  const usage = status ? `${formatBytes(status.cacheBytes)} / ${formatBytes(status.cacheMaxBytes)}` : "正在读取…";
  return <section className="panel setting-card playback-settings-card">
    <div className="setting-icon ready"><Gauge /></div>
    <div>
      <span className="eyebrow">PLAYBACK CORE</span>
      <h2>视频播放缓存与会话</h2>
      <p>兼容播放按需生成临时分片，容量与租约在这里统一限制；这些值不会写入原视频，也不影响音乐模块。当前占用 {usage}，活跃会话 {status?.sessions ?? 0} 个、处理进程 {status?.pipelines ?? 0} 个。</p>
      <div className="setting-fields">
        {number("缓存上限（GiB）", "cacheGib", 0.06, 1024, 0.5)}
        {number("缓存保留（小时）", "ttlHours", 0.02, 168, 0.5)}
        {number("前向准备窗口（秒）", "ahead", 6, 120, 1)}
        {number("后向缓冲（秒）", "back", 0, 120, 1)}
        {number("心跳间隔（秒）", "heartbeat", 3, 30, 1)}
        {number("无心跳租约（秒）", "lease", 15, 180, 1)}
        {number("首次心跳前回收（秒）", "initialLease", 10, 180, 1)}
        {number("FFmpeg 无输出超时（秒）", "noOutput", 5, 120, 1)}
      </div>
      <div className="setting-card-actions">
        <button className="primary-button" onClick={() => void submit()} disabled={busy || !settings}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存播放设置</button>
      </div>
      <small className="setting-hint">租约必须至少是心跳间隔的两倍；首次心跳前的回收窗口用于清理浏览器导航时来不及释放的会话。缓存上限过低会让播放提前等待生成。</small>
    </div>
  </section>;
}

/** Danmaku provider credentials. The secret never leaves the backend. */
function DanmakuSettingsCard({ settings, onSave }: { settings: DanmakuSettings | null; onSave: (body: { appId?: string; appSecret?: string; clear?: boolean }) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState(""); const [appSecret, setAppSecret] = useState("");
  useEffect(() => { setAppId(settings?.appId || ""); }, [settings?.appId]);
  const submit = async (body: { appId?: string; appSecret?: string; clear?: boolean }) => {
    setBusy(true);
    try { await onSave(body); if (body.clear) { setAppId(""); setAppSecret(""); } else setAppSecret(""); }
    finally { setBusy(false); }
  };
  const managed = settings?.environmentManaged;
  return <section className={`panel setting-card danmaku-settings-card${settings?.configured ? " is-enabled" : ""}`}>
    <div>
      <span className="eyebrow">ONLINE DANMAKU</span>
      <h2>弹弹play 凭证{settings?.configured ? "已配置" : "未配置"}</h2>
      <p>{managed ? "凭证由服务器环境变量提供，网页端不会覆盖它。" : "AppId 与 AppSecret 只保存在本机后端文件里，不会进入前端包、观看端响应或发布包。没有凭证时仍可导入本地弹幕，视频播放不受影响。启用联网匹配前会提示会发送文件名、大小、时长和局部文件哈希（在服务器计算）。"}</p>
      <div className="setting-fields">
        <label>AppId<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="弹弹play 开放平台 AppId" disabled={managed || busy} /></label>
        <label>AppSecret<input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={settings?.configured ? "已保存，留空表示不修改" : "弹弹play AppSecret"} disabled={managed || busy} /></label>
      </div>
      <div className="setting-card-actions">
        <button className="primary-button" onClick={() => void submit({ appId, ...(appSecret ? { appSecret } : {}) })} disabled={managed || busy || !appId.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存凭证</button>
        <button className="secondary-button" onClick={() => void submit({ appId, clear: true })} disabled={managed || busy || !settings?.configured}><X size={16} />清除凭证</button>
      </div>
    </div>
  </section>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
