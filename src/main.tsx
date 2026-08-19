import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JASSUB from "jassub";
// `worker&url` tells Vite to package this file as a real Web Worker.
// A plain `?url` only returns the source file address and JASSUB cannot finish
// its background subtitle renderer initialization in every browser.
import workerUrl from "jassub/dist/worker/worker.js?worker&url";
import wasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import modernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import {
  AlertTriangle,
  Bot,
  Captions,
  ChevronLeft,
  ChevronDown,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Film,
  FolderOpen,
  FolderSearch,
  Gauge,
  HardDrive,
  KeyRound,
  Library,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Moon,
  Play,
  Power,
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
type MediaDisplay = { groupId: string; folderId?: string; seriesTitle: string; season: number; episode: number; alias: string; configured: boolean };
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
type DisplayFolder = DisplayGroup & { path: string; customTitle: string; sampleAlias: string };
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

const SUBTITLE_OFFSET_OPTIONS = [-10, -5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 10];

function subtitleOffsetLabel(offsetSeconds: number) {
  if (offsetSeconds < 0) return `提前 ${Math.abs(offsetSeconds).toFixed(1)} 秒`;
  if (offsetSeconds > 0) return `延后 ${offsetSeconds.toFixed(1)} 秒`;
  return "不偏移";
}

function parseSubtitleTimestamp(value: string) {
  const parts = value.split(":");
  const seconds = Number(parts.pop() || 0);
  const minutes = Number(parts.pop() || 0);
  const hours = Number(parts.pop() || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatAssTimestamp(seconds: number) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function shiftAssSubtitles(content: string, offsetSeconds: number) {
  if (!offsetSeconds) return content;
  return content.replace(
    /^(\s*Dialogue\s*:[^,\r\n]*,)(\d+:\d{2}:\d{2}(?:\.\d+)?),(\d+:\d{2}:\d{2}(?:\.\d+)?)(,[^\r\n]*)$/gim,
    (_line, prefix: string, start: string, end: string, suffix: string) => `${prefix}${formatAssTimestamp(parseSubtitleTimestamp(start) + offsetSeconds)},${formatAssTimestamp(parseSubtitleTimestamp(end) + offsetSeconds)}${suffix}`,
  );
}

function formatWebVttTimestamp(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function shiftWebVttSubtitles(content: string, offsetSeconds: number) {
  if (!offsetSeconds) return content;
  return content.replace(
    /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(\s+-->\s+)((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})([^\r\n]*)$/gm,
    (_line, start: string, separator: string, end: string, settings: string) => `${formatWebVttTimestamp(parseSubtitleTimestamp(start) + offsetSeconds)}${separator}${formatWebVttTimestamp(parseSubtitleTimestamp(end) + offsetSeconds)}${settings}`,
  );
}

function assToWebVtt(content: string) {
  const defaultFields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  let fields = defaultFields;
  let inEvents = false;
  const cues: string[] = [];

  for (const rawLine of content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const section = line.match(/^\[([^\]]+)]$/);
    if (section) {
      inEvents = section[1].trim().toLowerCase() === "events";
      continue;
    }
    if (!inEvents) continue;
    const format = line.match(/^Format\s*:\s*(.+)$/i);
    if (format) {
      fields = format[1].split(",").map((field) => field.trim().toLowerCase());
      continue;
    }
    const dialogue = line.match(/^Dialogue\s*:\s*(.*)$/i);
    if (!dialogue || fields.length < 3) continue;

    const values: string[] = [];
    let remainder = dialogue[1];
    for (let index = 0; index < fields.length - 1; index += 1) {
      const separator = remainder.indexOf(",");
      if (separator < 0) {
        values.length = 0;
        break;
      }
      values.push(remainder.slice(0, separator));
      remainder = remainder.slice(separator + 1);
    }
    if (!values.length) continue;
    values.push(remainder);
    const event = Object.fromEntries(fields.map((field, index) => [field, values[index] || ""]));
    const start = parseSubtitleTimestamp(event.start);
    const end = parseSubtitleTimestamp(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // ASS vector drawings are not dialogue and would appear as paths in a
    // native text track. Skip those cues while retaining positioned/sign text.
    if (/\{[^}]*\\p[1-9]\d*[^}]*}/i.test(event.text)) continue;
    const text = event.text
      .replace(/\{[^}]*}/g, "")
      .replace(/\\N/gi, "\n")
      .replace(/\\h/gi, " ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    cues.push(`${formatWebVttTimestamp(start)} --> ${formatWebVttTimestamp(end)}\n${text}`);
  }

  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
}

function App() {
  const isAdminPath = window.location.pathname.startsWith("/admin");
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
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
        const nextOverview = await api<Overview>(bootstrapActivity?.scanning ? "/api/overview?compact=1" : "/api/overview");
        if (sequence !== refreshSequence.current) return;
        if (bootstrapActivity) {
          nextOverview.scanning = bootstrapActivity.scanning;
          nextOverview.scan = bootstrapActivity.scan;
          nextOverview.jobs = bootstrapActivity.jobs;
          nextOverview.remuxAcceleration = bootstrapActivity.remuxAcceleration;
        }
        initialAdminOverviewLoaded.current = true;
        setOverview(nextOverview);
      } else {
        const nextAccessStatus = await api<AccessStatus>("/api/auth/status");
        if (sequence !== refreshSequence.current) return;
        setAccessStatus(nextAccessStatus);
        if (nextAccessStatus.enabled && !nextAccessStatus.authenticated) setCatalog(null);
        else {
          const nextCatalog = await api<Catalog>("/api/catalog");
          if (sequence !== refreshSequence.current) return;
          setCatalog(nextCatalog);
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f7fb" : "#0b0d12");
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
    await refresh();
  };

  if (loading) return <LoadingScreen />;
  if (!isAdminPath && accessStatus?.enabled && !accessStatus.authenticated) {
    return <AccessLoginScreen theme={theme} onToggleTheme={toggleTheme} onAuthenticated={refresh} />;
  }

  return (
    <div className="app-shell">
      {isAdminPath ? (
        <AdminApp
          overview={overview}
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
        <ClientApp catalog={catalog} error={error} onRefresh={refresh} accessStatus={accessStatus} onLogout={logout} theme={theme} onToggleTheme={toggleTheme} />
      )}
      {isAdminPath && selectedMedia && <PlayerModal media={selectedMedia} onClose={() => setSelectedMedia(null)} />}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-mark">L</div>
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
    <main className="access-login-page">
      <header className="access-login-header"><Brand /><ThemeToggle theme={theme} onToggle={onToggleTheme} /></header>
      <section className="access-login-card">
        <div className="access-login-icon"><LockKeyhole size={28} /></div>
        <span className="eyebrow">LAN ACCESS</span>
        <h1>登录后访问视频</h1>
        <p>这台 LMD 已开启局域网访问控制。请输入服务器管理员为你分配的六位数字访问码。</p>
        <form onSubmit={login}>
          <label><span>六位访问码</span><input className="six-digit-access-input" type="password" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" value={accessCode} onChange={(event) => setAccessCode(event.target.value.replace(/\D/g, "").slice(0, 6))} maxLength={6} autoFocus placeholder="••••••" aria-label="六位数字访问码" /></label>
          {error && <div className="access-login-error"><AlertTriangle size={16} /><span>{error}</span></div>}
          <button className="primary-button" type="submit" disabled={busy || !/^\d{6}$/.test(accessCode)}>{busy ? <LoaderCircle size={17} className="spin" /> : <KeyRound size={17} />}{busy ? "正在验证…" : "登录"}</button>
        </form>
        <div className="access-login-footnote"><ShieldCheck size={15} /><span>登录状态仅保存在此浏览器的 HttpOnly Cookie 中，30 天内无需重复输入。</span></div>
      </section>
    </main>
  );
}

function Brand({ compact = false, onHome }: { compact?: boolean; onHome?: () => void }) {
  const content = <>
      <div className="brand-mark">L</div>
      {!compact && <div><strong>LMD</strong><span>LOCAL MEDIUM DIRECTORY</span></div>}
    </>;
  const className = `brand ${compact ? "brand-compact" : ""}`;
  return onHome
    ? <button type="button" className={`${className} brand-home-button`} onClick={onHome} aria-label="返回观看端主页" title="返回观看端主页">{content}</button>
    : <div className={className}>{content}</div>;
}

function ThemeToggle({ theme, onToggle }: { theme: ThemeMode; onToggle: () => void }) {
  const isLight = theme === "light";
  const nextThemeLabel = isLight ? "深色模式" : "明亮模式";
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`切换到${nextThemeLabel}`}
      aria-pressed={isLight}
      title={`切换到${nextThemeLabel}`}
    >
      <span className="theme-toggle-icon" aria-hidden="true">{isLight ? <Sun size={16} /> : <Moon size={16} />}</span>
      <span className="theme-toggle-label">{isLight ? "明亮" : "深色"}</span>
    </button>
  );
}

function mediaDisplayName(media: Media) {
  return media.display?.alias || media.title;
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
    <button className="viewer-account-button" onClick={() => void onLogout()} title="退出当前访问用户">
      <LogOut size={15} />
      <span>已用访问码登录</span>
    </button>
  );
}

function ClientApp({ catalog, error, onRefresh, accessStatus, onLogout, theme, onToggleTheme }: {
  catalog: Catalog | null;
  error: string;
  onRefresh: (quiet?: boolean) => Promise<void>;
  accessStatus: AccessStatus | null;
  onLogout: () => Promise<void>;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(() => {
    const parameters = new URLSearchParams(window.location.search);
    return parameters.get("folder") || parameters.get("series");
  });
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("video"));
  const [scanBusy, setScanBusy] = useState(false);
  const [scanNotice, setScanNotice] = useState<{ text: string; tone: "warning" | "success" } | null>(null);
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
  const legacyMedia = selectedFolderId && !folderById.has(selectedFolderId)
    ? allMedia.find((item) => item.display?.groupId === selectedFolderId)
    : null;
  const legacyFolderId = selectedFolderId && !folderById.has(selectedFolderId)
    ? legacyMedia ? mediaFolderId(legacyMedia) : ""
    : "";
  const currentFolder = folderById.get(selectedFolderId || "") || folderById.get(legacyFolderId) || null;
  const rootFolders = useMemo(() => folders.filter((folder) => folder.parentId === null).sort(compareCatalogTitles), [folders]);
  const childFolders = useMemo(() => folders
    .filter((folder) => folder.parentId === currentFolder?.id)
    .sort(compareCatalogTitles), [currentFolder?.id, folders]);
  const directMedia = useMemo(() => allMedia
    .filter((item) => currentFolder && mediaFolderId(item) === currentFolder.id)
    .sort((left, right) => (left.display?.episode || 0) - (right.display?.episode || 0)
      || left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" })), [allMedia, currentFolder]);
  const matchesSearch = (item: Media) => `${mediaDisplayName(item)} ${item.title} ${item.fileName} ${item.tags.join(" ")}`.toLowerCase().includes(normalizedSearch);
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
  const selectedMedia = allMedia.find((item) => item.id === selectedMediaId) || null;
  const selectedMediaFolder = selectedMedia ? mediaFolderId(selectedMedia) : "";
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
    return trail;
  }, [currentFolder, folderById]);
  const currentCover = currentFolder?.coverMediaId ? mediaById.get(currentFolder.coverMediaId) || null : null;
  const totalVideos = allMedia.length;

  useEffect(() => {
    const syncRouteFromHistory = () => {
      const parameters = new URLSearchParams(window.location.search);
      setSelectedFolderId(parameters.get("folder") || parameters.get("series"));
      setSelectedMediaId(parameters.get("video"));
      setSearch("");
    };
    window.addEventListener("popstate", syncRouteFromHistory);
    return () => window.removeEventListener("popstate", syncRouteFromHistory);
  }, []);

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
    window.history.pushState({ folder: null }, "", nextUrl);
    setSelectedFolderId(null);
    setSelectedMediaId(null);
    setSearch("");
    window.scrollTo({ top: 0, left: 0 });
  };

  const openParentFolder = () => {
    if (currentFolder?.parentId) openFolder(currentFolder.parentId);
    else openLibrary();
  };

  const scanNow = async () => {
    setScanBusy(true);
    setScanNotice({ text: "正在扫描视频目录并刷新文件列表…", tone: "success" });
    try {
      const result = await api<{ count: number }>("/api/catalog/scan", { method: "POST" });
      await onRefresh(true);
      setScanNotice({ text: `扫描完成，当前共有 ${result.count} 个视频文件。`, tone: "success" });
    } catch (operationError) {
      setScanNotice({ text: operationError instanceof Error ? operationError.message : "扫描刷新失败", tone: "warning" });
    } finally { setScanBusy(false); }
  };

  if (selectedMedia) {
    return (
      <div className="client-page client-player-page">
        <header className="client-header"><Brand onHome={openLibrary} /><div className="header-actions"><ViewerSession accessStatus={accessStatus} onLogout={onLogout} /><ThemeToggle theme={theme} onToggle={onToggleTheme} /></div></header>
        <main className="client-player-main">
          <PlayerModal
            media={selectedMedia}
            pageMode
            previousMedia={previousMedia}
            nextMedia={nextMedia}
            onPrevious={previousMedia ? () => switchPlayerMedia(previousMedia) : undefined}
            onNext={nextMedia ? () => switchPlayerMedia(nextMedia) : undefined}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="client-page" style={{ "--hero-hue": currentCover?.posterHue || 205 } as React.CSSProperties}>
      <header className="client-header">
        <Brand onHome={openLibrary} />
        <div className="header-actions">
          <ViewerSession accessStatus={accessStatus} onLogout={onLogout} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="client-scan-now" onClick={scanNow} disabled={scanBusy} title="立即扫描并刷新文件"><RefreshCw size={16} className={scanBusy ? "spin" : ""} /><span>立即刷新</span></button>
          <label className="search-box"><Search size={17} /><input aria-label="搜索文件夹或视频" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件夹、视频…" /></label>
        </div>
      </header>

      <main className="client-main">
        {error && <StatusBanner tone="warning" icon={<AlertTriangle size={18} />}>{error}</StatusBanner>}
        {scanNotice && <StatusBanner tone={scanNotice.tone} icon={scanNotice.tone === "warning" ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}>{scanNotice.text}</StatusBanner>}
        <section className={`library-hero${currentFolder ? " folder-hero" : ""}`}>
          <div className={`hero-copy${currentFolder ? "" : " hero-copy-brand"}`}>
            {currentFolder ? <>
              <button className="library-back" onClick={openParentFolder}><ChevronLeft size={17} />{currentFolder.parentId ? `返回 ${folderById.get(currentFolder.parentId)?.title || "上一级"}` : "全部目录"}</button>
              <nav className="folder-breadcrumb" aria-label="当前文件夹路径">
                <button type="button" onClick={openLibrary}>全部目录</button>
                {folderTrail.map((folder) => <React.Fragment key={folder.id}><span>/</span><button type="button" onClick={() => openFolder(folder.id)} aria-current={folder.id === currentFolder.id ? "page" : undefined}>{folder.title}</button></React.Fragment>)}
              </nav>
              <h1>{currentFolder.title}</h1>
              <p>{currentFolder.childCount ? `按磁盘目录层级展示 ${currentFolder.childCount} 个子文件夹；本层有 ${currentFolder.directMediaCount} 个视频，共 ${currentFolder.mediaCount} 个视频。` : `本文件夹有 ${currentFolder.directMediaCount} 个视频，选择后即可开始播放。`}</p>
            </> : <span className="hero-wordmark" aria-label="LMD">LMD</span>}
          </div>
          <div className="hero-stats" aria-label="媒体库概览">
            <div><strong>{currentFolder ? currentFolder.childCount : rootFolders.length}</strong><span>{currentFolder ? "个子文件夹" : "个根目录"}</span></div>
            <div><strong>{currentFolder ? currentFolder.mediaCount : totalVideos}</strong><span>{currentFolder ? "个视频总计" : "个视频"}</span></div>
          </div>
        </section>
        <section className="media-section">
          <div className="section-heading">
            <div><span className="section-kicker">{currentFolder ? "FOLDER" : "LIBRARY"}</span><h2>{currentFolder ? "文件夹内容" : "全部视频目录"}</h2></div>
            <span className="media-count">{visibleFolders.length} 个文件夹 · {visibleMedia.length} 个视频</span>
          </div>
          <div className="media-grid">
            {visibleFolders.map((folder) => <FolderCard key={folder.id} folder={folder} cover={folder.coverMediaId ? mediaById.get(folder.coverMediaId) || null : null} onOpen={() => openFolder(folder.id)} />)}
            {visibleMedia.map((item) => <MediaCard key={item.id} media={item} onPlay={() => openMedia(item)} />)}
          </div>
          {!visibleFolders.length && !visibleMedia.length && <div className="client-empty"><Library size={30} /><strong>{normalizedSearch ? "没有匹配的内容" : currentFolder ? "这个文件夹暂时为空" : "媒体库暂时为空"}</strong><span>{normalizedSearch ? "请尝试其他文件夹名或视频名。" : currentFolder ? "此处没有可播放视频或包含视频的子文件夹。" : "请添加视频目录，或把视频放入已有目录后重新扫描。"}</span></div>}
        </section>
      </main>
    </div>
  );
}

function FolderCard({ folder, cover, onOpen }: { folder: CatalogFolder; cover: Media | null; onOpen: () => void }) {
  return (
    <article className="media-card folder-card" style={{ "--poster-hue": cover?.posterHue || 180 } as React.CSSProperties}>
      <button className="card-hit-area" onClick={onOpen} aria-label={`打开文件夹 ${folder.title}`} />
      <div className="media-poster">
        {cover?.thumbnailUrl && <img className="video-thumbnail" src={cover.thumbnailUrl} alt={`${folder.title} 文件夹缩略图`} loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <div className="poster-grain" />
        <span className="format-badge">文件夹</span>
        <span className="play-orb" aria-hidden="true"><FolderOpen size={20} /></span>
        <div className="poster-caption"><FolderOpen size={20} /><span>{folder.mediaCount} 个视频</span></div>
      </div>
      <div className="media-card-body">
        <h3>{folder.title}</h3>
        <p>{folder.childCount ? `${folder.childCount} 个子文件夹 · ${folder.mediaCount} 个视频` : `${folder.directMediaCount} 个视频`}</p>
        <div className="subtitle-summary"><FolderOpen size={14} />{folder.configured && folder.title !== folder.name ? `磁盘文件夹：${folder.name}` : "按磁盘目录层级浏览"}</div>
      </div>
    </article>
  );
}

function MediaCard({ media, onPlay }: { media: Media; onPlay: () => void }) {
  const displayName = mediaDisplayName(media);
  return (
    <article className="media-card" style={{ "--poster-hue": media.posterHue } as React.CSSProperties}>
      <button className="card-hit-area" onClick={onPlay} aria-label={`播放 ${displayName}`} />
      <div className="media-poster">
        {media.thumbnailUrl && <img className="video-thumbnail" src={media.thumbnailUrl} alt={`${displayName} 视频缩略图`} loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
        <div className="poster-grain" />
        <span className="format-badge">{media.extension}</span>
        {media.hdr && <span className="poster-hdr">{media.hdr}</span>}
        <span className="play-orb" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
        <div className="poster-caption"><Film size={20} /><span>{media.height ? `${media.height}P` : "原画"}</span></div>
      </div>
      <div className="media-card-body">
        <h3>{displayName}</h3>
        <p>{codecName(media.videoCodec)} · {media.bitDepth || 8}-bit · {formatDuration(media.durationSeconds)}</p>
        <div className="subtitle-summary"><Captions size={14} />{media.subtitles.length ? `${media.subtitles.length} 条字幕` : "暂无字幕"}</div>
      </div>
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
    <div className="modal-backdrop rapid-scan-backdrop" role="dialog" aria-modal="true" aria-labelledby="rapid-scan-title">
      <section className="rapid-scan-modal">
        <button type="button" className="rapid-scan-close" onClick={onClose} aria-label={canRunInBackground ? "关闭窗口并在后台继续扫描" : "关闭急速扫描窗口"} title={canRunInBackground ? "关闭窗口，扫描继续在后台运行" : "关闭"}><X size={18} /></button>
        <div className="rapid-scan-heading"><span className="rapid-scan-icon"><Gauge size={24} /></span><div><span className="eyebrow">TURBO SCAN</span><h2 id="rapid-scan-title">{dialogTitle}</h2></div></div>
        {state.view === "prompt" ? (
          <>
            <p>已添加视频目录“{state.library.name}”。是否立即开启“急速扫描模式”？</p>
            <div className="rapid-scan-path">{state.library.path}</div>
            <div className="rapid-scan-warning"><AlertTriangle size={17} /><span>最高性能模式仅对本次任务生效，会按本机处理器数量大幅提高文件检查和媒体分析并发，尽可能拉满 CPU 与磁盘吞吐。</span></div>
            <div className="rapid-scan-actions"><button type="button" className="secondary-button" onClick={onClose}>稍后处理</button><button type="button" className="primary-button" onClick={onStart}><Gauge size={17} />开启最高性能扫描</button></div>
          </>
        ) : (
          <>
            {startError ? <div className="rapid-scan-error"><AlertTriangle size={17} /><span>{startError}</span></div> : starting || !observedTurboScan || !scan ? (
              <div className="rapid-scan-launching"><LoaderCircle size={22} className="spin" /><div><strong>正在提交急速扫描任务</strong><span>服务端确认后会显示实时文件处理进度。</span></div></div>
            ) : (
              <>
                <ScanProgress scan={scan} />
                <p className="rapid-scan-note">本次任务最多并行检查 {Math.max(1, scan.maxParallelFiles)} 个文件，并同时运行 {Math.max(1, scan.maxParallelMediaTools || 1)} 个媒体分析进程。扫描期间风扇转速、CPU 或磁盘活动显著增加属于正常现象。</p>
                {scan.phase === "failed" && scan.lastError && <div className="rapid-scan-error"><AlertTriangle size={17} /><span>{scan.lastError}</span></div>}
              </>
            )}
            {canRunInBackground && <p className="rapid-scan-background-note">关闭窗口不会中断任务，可在“运行设置”中继续查看扫描进度。</p>}
            <div className="rapid-scan-actions"><button type="button" className={canRunInBackground ? "secondary-button" : "primary-button"} onClick={onClose}>{canRunInBackground ? "转至后台运行" : "关闭"}</button></div>
          </>
        )}
      </section>
    </div>
  );
}

function AdminApp(props: {
  overview: Overview | null;
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
  const { overview, error, notice, section, onSectionChange, onRefresh, onNotice, onError, onPlay, theme, onToggleTheme } = props;
  const [rapidScanDialog, setRapidScanDialog] = useState<RapidScanDialogState | null>(null);
  const [turboActionBusy, setTurboActionBusy] = useState(false);
  const [turboStartError, setTurboStartError] = useState("");
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
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <Brand />
        <div className="sidebar-label">本机管理</div>
        <nav>
          <button className={section === "overview" ? "active" : ""} onClick={() => onSectionChange("overview")}><Gauge size={19} />总览</button>
          {overview?.accessControl.enabled && <button className={section === "access" ? "active" : ""} onClick={() => onSectionChange("access")}><ShieldCheck size={19} />访问控制</button>}
          <button className={section === "settings" ? "active" : ""} onClick={() => onSectionChange("settings")}><Settings size={19} />运行设置</button>
        </nav>
        <div className="sidebar-bottom">
          <a className="server-pill" href="/" target="_blank" rel="noopener noreferrer" aria-label="打开观看端（端口 8096）" title="在新标签页打开观看端"><span className={error ? "dot warning" : "dot"} /><div><strong>{error ? "服务异常" : "本地服务在线"}</strong><span>端口 8096 · 点击打开观看端</span></div></a>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar"><div><span className="eyebrow">LMD LOCAL CONTROL</span><h1>{sectionTitle}</h1></div><ThemeToggle theme={theme} onToggle={onToggleTheme} /></header>
        {error && <StatusBanner tone="warning" icon={<AlertTriangle size={18} />}>{error}</StatusBanner>}
        {notice && <StatusBanner tone="success" icon={<CheckCircle2 size={18} />}>{notice}</StatusBanner>}
        {section === "overview" && <OverviewPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} onLibraryAdded={promptForTurboScan} onPlay={onPlay} />}
        {section === "access" && overview?.accessControl.enabled && <AccessControlPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} />}
        {section === "settings" && <SettingsPanel overview={overview} onRefresh={onRefresh} onNotice={onNotice} onError={onError} onOpenAccess={() => onSectionChange("access")} onStartTurboScan={() => void startTurboScan()} onStopTurboScan={() => void stopTurboScan()} turboActionBusy={turboActionBusy} />}
      </main>
      {rapidScanDialog && <RapidScanDialog state={rapidScanDialog} scan={overview?.scan || null} starting={turboActionBusy} startError={turboStartError} onStart={() => void startTurboScan()} onClose={() => { setRapidScanDialog(null); setTurboStartError(""); }} />}
    </div>
  );
}

function OverviewPanel({ overview, onRefresh, onNotice, onLibraryAdded, onPlay }: { overview: Overview | null; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void; onLibraryAdded: (library: LibraryFolder) => void; onPlay: (media: Media) => void }) {
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
    <div className="admin-content">
      <section className="panel library-panel">
        <div className="panel-title"><div><span className="panel-icon"><FolderOpen size={20} /></span><div><h2>视频目录</h2><p>使用 Windows 选择窗口添加文件夹，程序只读取文件，不会移动原视频；自动扫描统一在管理端控制。</p></div></div><div className="panel-actions"><button className={`secondary-button auto-scan-button${overview?.settings.autoScanEnabled ? " active" : ""}`} onClick={toggleAutoScan} disabled={busy || !overview}><RefreshCw size={16} className={scanActive ? "spin" : ""} />{overview?.settings.autoScanEnabled ? `自动扫描 ${overview.settings.autoScanIntervalSeconds}s` : "自动扫描已关闭"}</button><button className="secondary-button" onClick={scan} disabled={busy || scanActive || !overview?.libraries.length}><RefreshCw size={16} className={busy || scanActive ? "spin" : ""} />重新扫描</button></div></div>
        {overview?.scan && scanIsActive(overview.scan) && <div className="library-scan-progress"><ScanProgress scan={overview.scan} compact /></div>}
        <div className="folder-form"><button className="secondary-button folder-picker-button" onClick={chooseFolder} disabled={busy}><FolderSearch size={17} />选择并添加文件夹</button><input aria-label="视频目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy && folderPath.trim()) { event.preventDefault(); void addLibrary(); } }} placeholder="也可以手动输入路径，按 Enter 添加" /></div>
        <div className="folder-list">
          {overview?.libraries.length ? overview.libraries.map((library) => <div className="folder-item" key={library.id}><HardDrive size={18} /><div><strong>{library.name}</strong><span>{library.path}</span></div><CheckCircle2 size={18} className="success-icon" /><button type="button" className="folder-remove-button" onClick={() => void removeLibrary(library)} disabled={busy} title={`移除目录 ${library.name}`} aria-label={`移除视频目录 ${library.name}`}><Trash2 size={16} /></button></div>) : <div className="empty-row"><FolderOpen size={22} /><span>还没有媒体目录。添加后才能读取真实视频。</span></div>}
        </div>
      </section>

      <DisplayFoldersPanel folders={overview?.displayFolders || []} onRefresh={onRefresh} onNotice={onNotice} />

      <section className={`panel media-table-panel collapsible-panel${compatibilityExpanded ? "" : " is-collapsed"}`}>
        <div className="panel-title"><div><span className="panel-icon"><Library size={20} /></span><div><h2>自动兼容处理</h2><p>扫描或启动时会自动检测 MKV、FLAC/Opus 等浏览器不易直放的组合，当前最多同时生成 {remuxConcurrency} 个 MP4 + AAC 副本；视频不重新压缩。</p></div></div><div className="panel-actions"><span className="table-count">{media.length} 个文件 · {pendingCompatibility.length} 个等待/处理中</span><button className="secondary-button" onClick={prepareCompatibleCopies} disabled={busy || !pendingCompatibility.length}><RefreshCw size={16} className={activeJobs ? "spin" : ""} />重新检查自动队列</button><button type="button" className="collapse-button" onClick={() => setCompatibilityExpanded((expanded) => !expanded)} aria-expanded={compatibilityExpanded} aria-controls="compatibility-list" aria-label={compatibilityExpanded ? "折叠自动兼容处理" : "展开自动兼容处理"} title={compatibilityExpanded ? "折叠" : "展开"}><ChevronDown size={18} /></button></div></div>
        {compatibilityExpanded && <div className="media-table" id="compatibility-list">
          {media.length ? media.map((item) => (
            <div className="media-row" key={item.id}>
              <div className="tiny-poster" style={{ "--poster-hue": item.posterHue } as React.CSSProperties}><Film size={18} /></div>
              <div className="media-file"><strong>{item.title}</strong><span>{item.path}</span></div>
              <div className="technical"><span>{item.extension}</span><span>{codecName(item.videoCodec)}</span><span>{item.bitDepth || 8}-bit</span>{item.hdr && <span className="hdr-chip">{item.hdr}</span>}</div>
              <div className="row-actions"><button title="预览播放" onClick={() => onPlay(item)}><Play size={16} /></button><button className="remux-button" onClick={() => remux(item)} disabled={Boolean(item.remuxUrl) || activeMediaIds.has(item.id)}>{item.remuxUrl ? <><Check size={15} />兼容副本就绪</> : activeMediaIds.has(item.id) ? <><LoaderCircle size={15} className="spin" />处理中</> : <>重封装 + AAC</>}</button></div>
            </div>
          )) : <div className="empty-table"><Film size={28} /><strong>媒体库还是空的</strong><span>先在上方添加一个视频目录，再执行扫描。</span></div>}
        </div>}
      </section>

      {!!overview?.jobs.length && <JobsPanel jobs={overview.jobs} maxParallelJobs={remuxConcurrency} />}
    </div>
  );
}

function DisplayFoldersPanel({ folders, onRefresh, onNotice }: { folders: DisplayFolder[]; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (value: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`panel display-groups-panel collapsible-panel${expanded ? "" : " is-collapsed"}`}>
      <div className="panel-title"><div><span className="panel-icon"><FolderOpen size={20} /></span><div><h2>网页作品代号</h2><p>每个视频文件夹填写一次作品名和季度；只改变网页显示，不修改原视频或字幕文件名。</p></div></div><div className="panel-actions"><span className="table-count">{folders.filter((folder) => folder.configured).length}/{folders.length} 个已设置</span><button type="button" className="collapse-button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="display-folders-list" aria-label={expanded ? "折叠网页作品代号" : "展开网页作品代号"} title={expanded ? "折叠" : "展开"}><ChevronDown size={18} /></button></div></div>
      {expanded && <div className="display-group-list" id="display-folders-list">
        {folders.length ? folders.map((folder) => <DisplayFolderRow key={folder.id} folder={folder} onRefresh={onRefresh} onNotice={onNotice} />) : <div className="empty-table"><FolderOpen size={28} /><strong>还没有可设置的作品文件夹</strong><span>添加视频目录并扫描后会自动列出。</span></div>}
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
    <div className="display-group-row">
      <div className="display-group-meta"><FolderOpen size={18} /><div><strong>{folder.folderName}</strong><span>{folder.path}</span><small>{folder.mediaCount} 个视频 · 示例：{preview}</small></div></div>
      <div className="display-group-form"><label><span>作品名</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：缘之空" /></label><label className="season-field"><span>季度</span><input type="number" min="1" max="99" value={season} onChange={(event) => setSeason(Number(event.target.value))} /></label><button className="primary-button" onClick={save} disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}保存代号</button></div>
    </div>
  );
}

function JobsPanel({ jobs, maxParallelJobs }: { jobs: Job[]; maxParallelJobs: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className={`panel jobs-panel collapsible-panel${expanded ? "" : " is-collapsed"}`}>
      <div className="panel-title"><div><span className="panel-icon"><RefreshCw size={20} /></span><div><h2>自动处理队列</h2><p>这里只改变容器和必要的音频格式，视频画面码流原样复制；当前最多同时处理 {maxParallelJobs} 部。</p></div></div><button type="button" className="collapse-button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="automatic-jobs-list" aria-label={expanded ? "折叠自动处理队列" : "展开自动处理队列"} title={expanded ? "折叠" : "展开"}><ChevronDown size={18} /></button></div>
      {expanded && <div id="automatic-jobs-list">{jobs.slice(0, 5).map((job) => <div className="job-row" key={job.id}><span className={`job-status ${job.status}`}>{job.status === "running" ? <LoaderCircle size={16} className="spin" /> : job.status === "completed" ? <Check size={16} /> : job.status === "failed" ? <X size={16} /> : <RefreshCw size={16} />}</span><div><strong>{job.title}</strong><span>{job.type} · {job.message}</span></div><div className="job-progress"><div><span style={{ width: `${job.progress}%` }} /></div><b>{job.progress}%</b></div></div>)}</div>}
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
    <div className="admin-content access-control-content">
      <section className="panel access-mode-panel is-enabled">
        <div className="access-mode-summary">
          <span className="access-mode-icon"><ShieldCheck size={28} /></span>
          <div><span className="eyebrow">CLASSIFIED ACCESS</span><h2>分类访问控制已开启</h2><p>未归类的视频文件夹会自动进入“未分类”，可与“全年龄”“R-18”等分类一样授权给六位访问码用户。关闭功能请前往“运行设置”。</p></div>
        </div>
        <div className="access-mode-actions">
          <div><strong>{accessControl?.users.filter((user) => user.enabled).length || 0}</strong><span>位已启用用户</span></div>
          <div><strong>{categories.length}</strong><span>个文件夹分类</span></div>
          <div><strong>{accessControl?.activeSessions || 0}</strong><span>个有效登录</span></div>
        </div>
      </section>

      <FolderCategoriesPanel folders={overview?.displayFolders || []} categories={categories} onRefresh={onRefresh} onNotice={onNotice} />

      <section className="panel access-create-panel">
        <div className="panel-title"><div><span className="panel-icon"><UserRoundPlus size={20} /></span><div><h2>添加访问码用户</h2><p>不需要用户名；每一个六位访问码就是一个独立用户，并按分类获得权限。</p></div></div></div>
        <div className="access-user-form">
          <label className="access-code-field"><span>六位数字访问码（创建后仅保存加密摘要）</span><div><input className="six-digit-access-input" inputMode="numeric" pattern="[0-9]{6}" value={accessCode} onChange={(event) => setAccessCode(event.target.value.replace(/\D/g, "").slice(0, 6))} minLength={6} maxLength={6} /><button className="icon-button" type="button" onClick={() => setAccessCode(generateAccessCode())} title="重新生成六位访问码"><RefreshCw size={16} /></button><button className="icon-button" type="button" onClick={() => void copyAccessCode(accessCode, onNotice)} title="复制访问码"><Copy size={16} /></button></div></label>
          <div className="access-folder-field"><span>允许访问的分类</span><div className="access-folder-options">
            {categories.map((category) => <label key={category.id} className={categoryIds.includes(category.id) ? "selected" : ""}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleCategory(category.id)} /><span><strong>{category.name}</strong><small>{category.system ? `自动归类 · ${category.folderIds.length} 个文件夹` : `${category.folderIds.length} 个文件夹`}</small></span></label>)}
          </div></div>
          <button className="primary-button access-create-button" onClick={createUser} disabled={busy || !/^\d{6}$/.test(accessCode) || !categoryIds.length}><UserRoundPlus size={17} />关联为新用户</button>
        </div>
      </section>

      <section className="panel access-users-panel">
        <div className="panel-title"><div><span className="panel-icon"><ShieldCheck size={20} /></span><div><h2>访问码用户与分类权限</h2><p>每个访问码只关联一个用户；分类权限修改立即生效。</p></div></div><span className="table-count">{accessControl?.users.length || 0} 位用户</span></div>
        <div className="access-user-list">
          {accessControl?.users.length ? accessControl.users.map((user, index) => <AccessUserCard key={user.id} user={user} userNumber={index + 1} categories={categories} onRefresh={onRefresh} onNotice={onNotice} />) : <div className="empty-table"><UserRoundPlus size={28} /><strong>还没有访问码用户</strong><span>先在上方生成六位访问码并选择允许访问的分类。</span></div>}
        </div>
      </section>
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
    <section className="panel access-categories-panel">
      <div className="panel-title"><div><span className="panel-icon"><FolderOpen size={20} /></span><div><h2>文件夹分类</h2><p>每个视频文件夹归入一个分类；未手动归类的文件夹会自动进入“未分类”，并可单独授权。</p></div></div><span className="table-count">{categories.length} 个分类</span></div>
      <div className="category-create-row"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) void addCategory(); }} maxLength={40} placeholder="新分类，例如：儿童专区" /><button className="primary-button" onClick={addCategory} disabled={busy || !name.trim()}><FolderOpen size={16} />建立分类</button></div>
      <div className="category-editor-list">
        {categories.map((category) => <AccessCategoryEditor key={category.id} category={category} onRefresh={onRefresh} onNotice={onNotice} />)}
      </div>
      <div className="folder-classification-list">
        {folders.length ? folders.map((folder) => <div className="folder-classification-row" key={folder.id}><div><strong>{folder.title}</strong><span>{folder.folderName} · {folder.mediaCount} 个视频</span></div><select value={categoryForFolder(folder.id)} onChange={(event) => void assignFolder(folder, event.target.value)} disabled={busy}><option value="">未分类</option>{editableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>) : <div className="access-empty-folders">请先在“总览”添加视频目录并完成扫描。</div>}
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
    return <div className="category-editor-row system-category-row"><strong>{category.name}</strong><span>{category.folderIds.length} 个文件夹</span><small>系统分类 · 自动归入</small></div>;
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

  return <div className="category-editor-row"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} /><span>{category.folderIds.length} 个文件夹</span><button className="secondary-button" onClick={save} disabled={busy || !name.trim() || name.trim() === category.name}><Check size={15} />保存</button><button className="icon-button danger-icon-button" onClick={() => void remove()} disabled={busy} title="删除分类"><Trash2 size={15} /></button></div>;
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
    <article className={`access-user-card${user.enabled ? "" : " is-disabled"}`}>
      <div className="access-user-heading"><div><span className="access-user-avatar">{String(userNumber).padStart(2, "0")}</span><div><h3>访问码用户 {userNumber}</h3><p>{user.lastLoginAt ? `上次登录：${new Date(user.lastLoginAt).toLocaleString("zh-CN")}` : "尚未登录"} · {user.enabled ? "已启用" : "已禁用"}</p></div></div><div className="access-user-actions"><button className="secondary-button" disabled={busy} onClick={() => void updateUser({ enabled: !user.enabled }, user.enabled ? `访问码用户 ${userNumber} 已禁用并退出所有设备。` : `访问码用户 ${userNumber} 已重新启用。`)}>{user.enabled ? "禁用" : "启用"}</button><button className="icon-button danger-icon-button" disabled={busy} onClick={() => void deleteUser()} title="删除用户"><Trash2 size={16} /></button></div></div>
      <div className="access-folder-options compact">
        {categories.map((category) => <label key={category.id} className={categoryIds.includes(category.id) ? "selected" : ""}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleCategory(category.id)} disabled={busy} /><span><strong>{category.name}</strong><small>{category.system ? `自动归类 · ${category.folderIds.length} 个文件夹` : `${category.folderIds.length} 个文件夹`}</small></span></label>)}
      </div>
      <div className="access-user-footer">
        <button className="secondary-button" disabled={busy || !permissionsChanged || !categoryIds.length} onClick={() => void updateUser({ categoryIds }, `访问码用户 ${userNumber} 的分类权限已保存并立即生效。`)}><Check size={16} />保存分类权限</button>
        <button className="secondary-button" disabled={busy} onClick={() => void resetAccessCode()}><KeyRound size={16} />重置六位访问码</button>
        {newAccessCode && <div className="new-access-code"><span>新访问码</span><code>{newAccessCode}</code><button className="icon-button" onClick={() => void copyAccessCode(newAccessCode, onNotice)} title="复制新访问码"><Copy size={15} /></button></div>}
      </div>
    </article>
  );
}

function SettingsPanel({ overview, onRefresh, onNotice, onError, onOpenAccess, onStartTurboScan, onStopTurboScan, turboActionBusy }: {
  overview: Overview | null;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (value: string) => void;
  onError: (value: string) => void;
  onOpenAccess: () => void;
  onStartTurboScan: () => void;
  onStopTurboScan: () => void;
  turboActionBusy: boolean;
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
    <div className="admin-content settings-grid">
      <section className="panel setting-card compatible-copy-location-card"><div className="setting-icon ready"><HardDrive /></div><div><span className="eyebrow">COMPATIBLE MEDIUM STORAGE</span><h2>兼容视频保存地址</h2><p>以后生成的 MP4 兼容副本会保存到这里。保存新地址时会移动现有兼容副本，不会移动原视频、缩略图或字幕缓存；有扫描、重封装或播放任务时会暂停迁移。</p><div className="compatible-directory-form"><button className="secondary-button" onClick={chooseCompatibleDirectory} disabled={directoryBusy}><FolderSearch size={16} />选择文件夹</button><input aria-label="兼容视频保存地址" value={compatibleDirectory} onChange={(event) => setCompatibleDirectory(event.target.value)} placeholder="例如 D:\\LMD兼容视频" disabled={directoryBusy} /><button className="primary-button" onClick={saveCompatibleDirectory} disabled={directoryBusy || !compatibleDirectory.trim() || compatibleDirectory.trim() === overview?.settings.compatibleCopyDirectory}>{directoryBusy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{directoryBusy ? "正在处理" : "保存地址并迁移"}</button></div><small className="compatible-directory-current">当前地址：{overview?.settings.compatibleCopyDirectory || "正在读取…"}</small></div></section>
      <section className="panel setting-card"><div className={`setting-icon ${installActive ? "standby" : overview?.tools.available ? "ready" : "warning"}`}>{installActive ? <LoaderCircle size={22} className="spin" /> : overview?.tools.available ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}</div><div><span className="eyebrow">MEDIA ENGINE</span><h2>{installActive ? "正在安装 FFmpeg…" : overview?.tools.available ? "FFmpeg 已就绪" : "等待安装 FFmpeg"}</h2><p>{installActive ? installState?.message || "正在准备下载…" : overview?.tools.available ? overview.tools.version : overview?.tools.hint}</p>{installActive && <div className="install-progress"><div className="install-progress-track"><span style={{ width: `${Math.max(1, installState?.progress || 0)}%` }} /></div><small>{installState?.progress || 0}%{installState?.bytesTotal ? ` · ${formatBytes(installState.bytesDownloaded)} / ${formatBytes(installState.bytesTotal)}` : ""}</small></div>}<div className="setting-card-actions">{installActive ? <button className="danger-button" onClick={() => void cancelInstall()}><X size={16} />取消安装</button> : <>{overview?.tools.installable !== false && <button className={overview?.tools.available ? "secondary-button" : "primary-button"} onClick={() => void installOrUpdateTools()} disabled={!overview}><Download size={16} />{overview?.tools.available ? (overview.tools.source === "path" ? "安装内置 FFmpeg" : "检查更新并安装") : "自动安装 FFmpeg"}</button>}<button className="secondary-button" onClick={refreshTools}><RefreshCw size={16} />重新检查</button></>}</div></div></section>
      <section className={`panel setting-card remux-acceleration-card${acceleration?.enabled ? " is-enabled" : ""}${turboScanActive ? " has-turbo-scan" : ""}`}><div className={`setting-icon ${acceleration?.enabled || turboScanActive ? "ready" : "standby"}`}><Gauge /></div><div><span className="eyebrow">REMUX ACCELERATION</span><h2>并行加速重封装{acceleration?.enabled ? "已开启" : "已关闭"}</h2><p>{acceleration?.enabled ? `最多同时处理 ${acceleration.maxParallelJobs} 部，当前运行 ${acceleration.activeJobs} 部、排队 ${acceleration.queuedJobs} 部。剩余 ${formatRemainingTime(acceleration.remainingSeconds)}，将在 ${accelerationEndsAt} 自动关闭；关闭时不会中断正在运行的任务。` : `开启后最多同时处理 ${acceleration?.acceleratedParallelJobs || 3} 部视频，12 小时后自动恢复单任务模式；加速期间会增加磁盘并发读写。`}</p><div className="setting-card-actions"><button className={acceleration?.enabled ? "secondary-button" : "primary-button"} onClick={toggleRemuxAcceleration} disabled={!overview || accelerationBusy || (!overview.tools.available && !acceleration?.enabled)} aria-pressed={Boolean(acceleration?.enabled)} aria-busy={accelerationBusy}>{accelerationBusy ? <LoaderCircle size={16} className="spin" /> : <Gauge size={16} />}{accelerationBusy ? (acceleration?.enabled ? "正在关闭加速" : "正在开启加速") : acceleration?.enabled ? "立即关闭加速" : "开启 12 小时加速"}</button><button className={`${turboScanActive ? "danger-button" : "secondary-button"} turbo-scan-button${turboScanActive ? " active" : ""}`} onClick={turboScanActive ? onStopTurboScan : onStartTurboScan} disabled={!overview?.libraries.length || turboActionBusy} aria-busy={turboActionBusy} aria-pressed={turboScanActive}>{turboActionBusy ? <LoaderCircle size={16} className="spin" /> : turboScanActive ? <X size={16} /> : <FolderSearch size={16} />}{turboActionBusy ? (turboScanActive ? "正在停止最高性能扫描" : "正在启动最高性能扫描") : turboScanActive ? "停止最高性能扫描" : "开启最高性能扫描"}</button></div>{scanStatus && turboScanActive && <div className="setting-scan-progress"><ScanProgress scan={scanStatus} compact /></div>}</div></section>
      <section className="panel setting-card"><div className={`setting-icon ${overview?.autostart.enabled ? "ready" : "standby"}`}><Power /></div><div><span className="eyebrow">WINDOWS STARTUP</span><h2>开机自启{overview?.autostart.enabled ? "已开启" : "已关闭"}</h2><p>开启后，每次登录 Windows 都会在后台启动 LMD；不会自动打开管理网页或信息窗口。</p><button className={overview?.autostart.enabled ? "secondary-button" : "primary-button"} onClick={toggleAutostart}>{overview?.autostart.enabled ? "关闭开机自启" : "开启开机自启"}</button></div></section>
      <section className="panel setting-card"><div className={`setting-icon ${overview?.accessControl.enabled ? "ready" : "standby"}`}>{overview?.accessControl.enabled ? <ShieldCheck /> : <LockKeyhole />}</div><div><span className="eyebrow">VIEWER ACCESS</span><h2>访问控制{overview?.accessControl.enabled ? "已开启" : "已关闭"}</h2><p>{overview?.accessControl.enabled ? "局域网访客必须输入六位数字访问码；“访问控制”菜单已显示，可设置文件夹分类和用户权限。" : "当前保持原来的简洁访问方式；开启后才会显示“访问控制”选项。"}</p><button className={overview?.accessControl.enabled ? "secondary-button" : "primary-button"} onClick={toggleAccessControl}>{overview?.accessControl.enabled ? "关闭并返回简洁版" : "开启访问控制"}</button></div></section>
      <section className="panel setting-card"><div className="setting-icon ready"><Bot /></div><div><span className="eyebrow">PROJECT DEVELOPERS</span><h2>不是一个云玩家呢 · Codex</h2><p>共同参与 LMD 的设计、开发与维护。</p></div></section>
    </div>
  );
}

function StatusBanner({ children, icon, tone }: { children: React.ReactNode; icon: React.ReactNode; tone: "warning" | "success" }) {
  return <div className={`status-banner ${tone}`} role={tone === "warning" ? "alert" : "status"} aria-live={tone === "warning" ? "assertive" : "polite"}>{icon}<span>{children}</span></div>;
}

function PlayerModal({ media, onClose, pageMode = false, previousMedia = null, nextMedia = null, onPrevious, onNext }: {
  media: Media;
  onClose?: () => void;
  pageMode?: boolean;
  previousMedia?: Media | null;
  nextMedia?: Media | null;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rendererRef = useRef<JASSUB | null>(null);
  // Start with subtitles disabled so video decoding is tested independently.
  // The viewer can then enable SRT or ASS/SSA after the picture starts.
  const [subtitleId, setSubtitleId] = useState("off");
  const [subtitleOffset, setSubtitleOffset] = useState(0);
  const [subtitleRenderMode, setSubtitleRenderMode] = useState<"stable" | "styled">("stable");
  const [nativeTrackUrl, setNativeTrackUrl] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const selectedSubtitle = media.subtitles.find((item) => item.id === subtitleId);
  const selectedSubtitleIsAss = Boolean(selectedSubtitle && ["ASS", "SSA"].includes(selectedSubtitle.format));
  // 字幕渲染只依赖“字幕内容”本身：媒体 id、所选字幕、偏移、字幕文件版本与字体
  // 版本。这样兼容副本状态变迁（remuxUrl / compatibleCopyStatus 变化）不会销毁
  // 重建 JASSUB 渲染器，而字幕文件更新后仍会自动重新加载。
  const subtitleContentKey = `${media.id}\0${subtitleId}\0${subtitleOffset}\0${subtitleRenderMode}\0${selectedSubtitle?.modifiedAt || ""}\0${selectedSubtitle?.size || ""}\0${media.fonts.map((font) => `${font.id}:${font.modifiedAt || ""}:${font.size || ""}`).join("|")}`;
  const needsCompatibleCopy = Boolean(media.compatibility?.needsCompatibleCopy && !media.remuxUrl);
  const compatibilityIssues = media.compatibility?.issues.join("、") || `${media.extension} / ${codecName(media.videoCodec)} / ${codecName(media.audioCodec)}`;
  const displayName = mediaDisplayName(media);
  const autoPreparingCopy = ["waiting", "queued", "running"].includes(media.compatibleCopyStatus || "");
  const hasSubtitles = media.subtitles.length > 0;

  useEffect(() => {
    setSubtitleId("off");
    setSubtitleOffset(0);
    setSubtitleRenderMode("stable");
    setNativeTrackUrl("");
    setPlaybackError("");
  }, [media.id]);

  useEffect(() => {
    const subtitle = media.subtitles.find((item) => item.id === subtitleId);
    const video = videoRef.current;
    if (!video || !subtitle || !["ASS", "SSA"].includes(subtitle.format) || subtitleRenderMode !== "styled") {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      Array.from(video?.textTracks || []).forEach((track) => { track.mode = "disabled"; });
      return;
    }
    const controller = new AbortController();
    let active = true;
    let renderer: JASSUB | null = null;
    Array.from(video.textTracks).forEach((track) => { track.mode = "disabled"; });
    void (async () => {
      try {
        const response = await fetch(subtitle.url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`字幕请求失败（${response.status}）`);
        const content = shiftAssSubtitles(await response.text(), subtitleOffset);
        if (!active) return;
        const availableFonts = Object.fromEntries(media.fonts.flatMap((font) =>
          (font.aliases || [])
            .map((alias) => alias.trim().toLowerCase())
            .filter(Boolean)
            .map((alias) => [alias, font.url]),
        ));
        const eagerFonts = media.fonts
          .filter((font) => !font.aliases?.length)
          .map((font) => font.url);
        renderer = new JASSUB({
          video,
          subContent: content,
          workerUrl,
          wasmUrl,
          modernWasmUrl,
          fonts: eagerFonts,
          availableFonts,
          queryFonts: "local",
        });
        rendererRef.current = renderer;
        await renderer.ready;
        if (active) await renderer.resize(true);
      } catch { }
    })();
    return () => {
      active = false;
      controller.abort();
      renderer?.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [subtitleContentKey]);

  useEffect(() => {
    const subtitle = media.subtitles.find((item) => item.id === subtitleId);
    const useNativeTrack = subtitle?.format === "SRT"
      || (Boolean(subtitle && ["ASS", "SSA"].includes(subtitle.format)) && subtitleRenderMode === "stable");
    if (!subtitle || !useNativeTrack) {
      setNativeTrackUrl("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    setNativeTrackUrl("");
    void (async () => {
      try {
        const response = await fetch(subtitle.format === "SRT" ? `${subtitle.url}?format=vtt` : subtitle.url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`字幕请求失败（${response.status}）`);
        const source = await response.text();
        const content = shiftWebVttSubtitles(subtitle.format === "SRT" ? source : assToWebVtt(source), subtitleOffset);
        if (!active) return;
        objectUrl = URL.createObjectURL(new Blob([content], { type: "text/vtt" }));
        setNativeTrackUrl(objectUrl);
      } catch { }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [subtitleContentKey]);

  const reportPlaybackError = () => {
    if (needsCompatibleCopy) {
      setPlaybackError(autoPreparingCopy
        ? `浏览器无法直接解码 ${compatibilityIssues}；LMD 正在后台自动生成兼容副本，完成后播放器会自动切换。`
        : `浏览器无法直接解码 ${compatibilityIssues}，自动兼容处理未完成，请在服务器电脑管理端查看处理队列。`);
    } else if (media.remuxUrl && media.compatibility?.deviceCodecDependent) {
      setPlaybackError(`兼容副本已经是 MP4 + AAC，但此设备的浏览器仍不支持 ${codecName(media.videoCodec)} 视频解码。`);
    } else {
      setPlaybackError("浏览器无法播放这个视频源，请检查文件是否完整以及当前设备是否支持该视频编码。");
    }
  };

  const player = (
      <div className={`player-modal${pageMode ? " player-page-panel" : ""}`}>
        <div className="player-topbar"><div><strong>{displayName}</strong><span>{media.demo ? "播放器界面示例" : `${media.extension} · ${codecName(media.videoCodec)} · ${media.bitDepth || 8}-bit`}</span></div>{!pageMode && onClose && <div><button className="close-button" onClick={onClose} aria-label="关闭播放器"><X size={20} /></button></div>}</div>
        <div className={`video-stage ${media.demo ? "demo-stage" : ""}`} style={{ "--poster-hue": media.posterHue } as React.CSSProperties}>
          {media.demo ? <div className="demo-player-copy"><div className="play-orb large"><Play size={28} fill="currentColor" /></div><h2>这里将播放你的原始视频</h2><p>播放器使用 Range 直传，并在画面上方渲染 ASS/SSA 特效字幕。</p></div> : <video key={media.id} ref={videoRef} src={media.remuxUrl || media.streamUrl} controls autoPlay playsInline preload="metadata" onEnded={nextMedia && onNext ? onNext : undefined} onError={reportPlaybackError} onLoadedMetadata={() => setPlaybackError("")}>{selectedSubtitle && nativeTrackUrl && <track key={`${selectedSubtitle.id}-${subtitleOffset}-${subtitleRenderMode}`} kind="subtitles" src={nativeTrackUrl} srcLang="zh" label={selectedSubtitle.language} default onLoad={(event) => { event.currentTarget.track.mode = "showing"; }} />}</video>}
        </div>
        {pageMode && <div className="player-episode-nav" aria-label="剧集导航">
          <button className="previous-episode-button" onClick={onPrevious} disabled={!previousMedia || !onPrevious} aria-label={previousMedia ? `播放上一集：${mediaDisplayName(previousMedia)}` : "已是第一集"} title={previousMedia ? `上一集：${mediaDisplayName(previousMedia)}` : "已是第一集"}><SkipBack size={18} /><span>{previousMedia ? "上一集" : "已是第一集"}</span></button>
          <button className="next-episode-button" onClick={onNext} disabled={!nextMedia || !onNext} aria-label={nextMedia ? `播放下一集：${mediaDisplayName(nextMedia)}` : "已是最后一集"} title={nextMedia ? `下一集：${mediaDisplayName(nextMedia)}` : "已是最后一集"}><span>{nextMedia ? "下一集" : "已是最后一集"}</span><SkipForward size={18} /></button>
        </div>}
        {!media.demo && (playbackError || needsCompatibleCopy) && <div className={`playback-status ${playbackError ? "error" : "warning"}`}><AlertTriangle size={17} /><span>{playbackError || (autoPreparingCopy ? `检测到 ${compatibilityIssues}，LMD 已自动加入兼容处理队列；完成后本页会自动改用 MP4 + AAC 副本。` : `当前原片包含 ${compatibilityIssues}，请在服务器电脑管理端检查自动兼容处理状态。`)}</span></div>}
        <div className="player-toolbar">
          <div className="player-subtitle-controls">
            <div className="track-select"><Captions size={17} /><label htmlFor="subtitle-track">字幕</label><select id="subtitle-track" value={subtitleId} onChange={(event) => setSubtitleId(event.target.value)} disabled={!hasSubtitles}>{hasSubtitles ? <><option value="off">关闭字幕</option>{media.subtitles.map((subtitle) => <option value={subtitle.id} key={subtitle.id}>{subtitle.language} · {subtitle.format} · {subtitle.name}</option>)}</> : <option value="off">无字幕</option>}</select></div>
            {selectedSubtitleIsAss && <div className="subtitle-offset subtitle-render-mode"><label htmlFor="subtitle-render-mode">显示模式</label><select id="subtitle-render-mode" value={subtitleRenderMode} onChange={(event) => setSubtitleRenderMode(event.target.value as "stable" | "styled")}><option value="stable">稳定模式（推荐）</option><option value="styled">ASS 特效模式</option></select></div>}
            <div className="subtitle-offset"><label htmlFor="subtitle-offset">时间偏移</label><select id="subtitle-offset" value={subtitleOffset} onChange={(event) => setSubtitleOffset(Number(event.target.value))} disabled={!selectedSubtitle}><option value={0}>不偏移</option>{SUBTITLE_OFFSET_OPTIONS.filter((value) => value !== 0).map((value) => <option value={value} key={value}>{subtitleOffsetLabel(value)}</option>)}</select></div>
          </div>
          <div className="player-technical"><span>{media.width || 1920}×{media.height || 1080}</span><span>{media.remuxUrl ? "AAC" : codecName(media.audioCodec)}</span>{media.remuxUrl && <span>MP4 兼容副本</span>}{media.hdr && <span className="hdr-chip">{media.hdr}</span>}</div>
        </div>
      </div>
  );

  if (pageMode) return player;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`播放 ${displayName}`}>
      {player}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
