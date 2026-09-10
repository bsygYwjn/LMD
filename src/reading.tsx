import React, { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Download,
  FolderOpen,
  HardDrive,
  List,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  Rows3,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type ReadingKind = "ebook" | "spreadsheet";
export type ReadingFilter = "all" | ReadingKind;

export type ReadingItem = {
  id: string;
  libraryId: string;
  title: string;
  fileName: string;
  path?: string;
  extension: string;
  kind: ReadingKind;
  size: number;
  modifiedAt: string;
  folderId: string;
  fileUrl: string;
  thumbnailUrl: string | null;
};

export type ReadingFolder = {
  id: string;
  parentId: string | null;
  name: string;
  title: string;
  configured: boolean;
  directMediaCount: number;
  mediaCount: number;
  childCount: number;
  coverMediaId: string | null;
  ebookCount: number;
  spreadsheetCount: number;
  kind: "reading";
};

export type ReadingCatalog = {
  items: ReadingItem[];
  folders: ReadingFolder[];
  scan: { scanning: boolean; phase: string; progressPercent: number | null; processedFiles: number; totalFiles: number; lastError: string | null };
};

export type ReadingOverview = {
  libraries: Array<{ id: string; name: string; path: string }>;
  items: ReadingItem[];
  scanning: boolean;
  scan: ReadingCatalog["scan"] & { mode?: string | null };
};

type FoliateViewElement = HTMLElement & {
  book?: {
    metadata?: { title?: unknown; author?: unknown };
    toc?: Array<TocEntry>;
    dir?: string;
    sections?: Array<{ id?: string; linear?: string }>;
  };
  renderer?: HTMLElement & { setStyles?: (css: string) => void; next?: () => void; prev?: () => void; snap?: (x: number, y: number) => void | Promise<void>; goTo?: (target: { index: number; anchor?: unknown }) => Promise<void>; page?: number; pages?: number; atEnd?: boolean; atStart?: boolean };
  lastLocation?: { fraction?: number; cfi?: string; section?: { current?: number; total?: number } };
  open: (fileOrBook: unknown) => Promise<void>;
  close: () => void;
  deselect?: () => void;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  goLeft: () => Promise<void>;
  goRight: () => Promise<void>;
  goTo: (target: unknown) => Promise<void>;
  goToFraction: (fraction: number) => Promise<void>;
  resolveNavigation?: (target: unknown) => { index: number; anchor?: unknown } | undefined;
};

type TocEntry = { label?: string; href?: string; subitems?: TocEntry[]; children?: TocEntry[] };
type ReadingProgress = Record<string, unknown>;

const SPREADSHEET_LIMIT = 64 * 1024 * 1024;
const TEXT_LIMIT = 16 * 1024 * 1024;

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result as T;
}

function progressKey(item: ReadingItem) {
  return `lmd-reading-v1:${item.id}:${item.size}+${item.modifiedAt}`;
}

function readProgress(item: ReadingItem): ReadingProgress {
  try { return JSON.parse(localStorage.getItem(progressKey(item)) || "{}"); }
  catch { return {}; }
}

function saveProgress(item: ReadingItem, patch: ReadingProgress) {
  try { localStorage.setItem(progressKey(item), JSON.stringify({ ...readProgress(item), ...patch })); }
  catch { /* 无痕窗口或存储配额不足时，阅读本身仍可继续。 */ }
}

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfJs() {
  pdfJsPromise ||= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjs;
  });
  return pdfJsPromise;
}

function ReadingThumbnail({ item }: { item: ReadingItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.thumbnailUrl]);
  if (!item.thumbnailUrl || failed) return null;
  return <span className="rd-thumb-anchor"><img className="rd-thumb" src={item.thumbnailUrl} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={() => setFailed(true)} /></span>;
}

function formatLanguageMap(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return formatLanguageMap(Object.values(value as Record<string, unknown>)[0]);
  return "";
}

function formatContributor(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatContributor).filter(Boolean).join(" / ");
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return formatLanguageMap((value as { name?: unknown }).name);
  return "";
}

function flattenToc(entries: TocEntry[] = [], depth = 0): Array<TocEntry & { depth: number }> {
  return entries.flatMap((entry) => [{ ...entry, depth }, ...flattenToc(entry.subitems || entry.children || [], depth + 1)]);
}

// EPUB 字体去混淆需要 SHA-1。局域网通常使用 HTTP，Web Crypto 在非安全
// 上下文中可能不可用，因此这里保留一份只服务于该公开格式算法的内置实现。
async function sha1ForEpub(input: string) {
  const source = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(source);
  padded[source.length] = 0x80;
  new DataView(padded.buffer).setUint32(paddedLength - 4, source.length * 8, false);
  const words = new Uint32Array(80);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const rotateLeft = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 80; index += 1) words[index] = rotateLeft(words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16], 1) >>> 0;
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let index = 0; index < 80; index += 1) {
      const f = index < 20 ? (b & c) | (~b & d) : index < 40 ? b ^ c ^ d : index < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = index < 20 ? 0x5a827999 : index < 40 ? 0x6ed9eba1 : index < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temporary = (rotateLeft(a, 5) + f + e + k + words[index]) | 0;
      e = d; d = c; c = rotateLeft(b, 30); b = a; a = temporary;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const digest = new Uint8Array(20);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4].forEach((value, index) => digestView.setUint32(index * 4, value >>> 0, false));
  return digest;
}

function ReaderNotice({ message, downloadUrl, fileName }: { message: string; downloadUrl?: string; fileName?: string }) {
  return (
    <div className="reader-notice" role="alert">
      <AlertTriangle size={20} />
      <strong>无法在线预览</strong>
      <span>{message}</span>
      {downloadUrl && <a href={downloadUrl} download={fileName}><Download size={15} />下载原文件</a>}
    </div>
  );
}

function ReaderLoading({ label = "正在打开文件…" }: { label?: string }) {
  return <div className="reader-loading"><LoaderCircle className="spin" size={24} /><span>{label}</span></div>;
}

function useDismissableDrawer(
  open: boolean,
  onDismiss: () => void,
  triggerRef: React.RefObject<HTMLElement | null>,
  drawerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || triggerRef.current?.contains(target) || drawerRef.current?.contains(target)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerRef, onDismiss, open, triggerRef]);
}

function PdfReader({ item }: { item: ReadingItem }) {
  const saved = useMemo(() => readProgress(item), [item]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const tocButtonRef = useRef<HTMLButtonElement>(null);
  const tocDrawerRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<any>(null);
  const loadingTaskRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);
  const passwordCallbackRef = useRef<((password: string) => void) | null>(null);
  const [pageNumber, setPageNumber] = useState(Math.max(1, Number(saved.page) || 1));
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(Math.max(.5, Math.min(3, Number(saved.scale) || 1)));
  const [fit, setFit] = useState<"width" | "page" | "custom">((saved.fit as "width" | "page" | "custom") || "width");
  const [rotation, setRotation] = useState(Number(saved.rotation) || 0);
  const [outline, setOutline] = useState<any[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordNeeded, setPasswordNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stageSize, setStageSize] = useState({ width: 900, height: 700 });
  useDismissableDrawer(tocOpen, () => setTocOpen(false), tocButtonRef, tocDrawerRef);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setStageSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const task = pdfjs.getDocument({ url: item.fileUrl, enableXfa: false });
        loadingTaskRef.current = task;
        task.onPassword = (updatePassword: (password: string) => void) => {
          passwordCallbackRef.current = updatePassword;
          if (active) setPasswordNeeded(true);
        };
        const document = await task.promise;
        if (!active) return;
        documentRef.current = document;
        setPageCount(document.numPages);
        setPageNumber((value) => Math.min(document.numPages, Math.max(1, value)));
        setOutline((await document.getOutline()) || []);
        setLoading(false);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "PDF 读取失败");
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
      renderTaskRef.current?.cancel?.();
      loadingTaskRef.current?.destroy?.();
      documentRef.current = null;
    };
  }, [item.fileUrl]);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (!document || !canvas || !pageCount) return;
    let active = true;
    void (async () => {
      try {
        renderTaskRef.current?.cancel?.();
        const page = await document.getPage(pageNumber);
        if (!active) return;
        const base = page.getViewport({ scale: 1, rotation });
        const horizontalPadding = 48;
        const verticalPadding = 48;
        const effectiveScale = fit === "width"
          ? Math.max(.2, (stageSize.width - horizontalPadding) / base.width)
          : fit === "page"
            ? Math.max(.2, Math.min((stageSize.width - horizontalPadding) / base.width, (stageSize.height - verticalPadding) / base.height))
            : scale;
        const viewport = page.getViewport({ scale: effectiveScale, rotation });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("浏览器无法创建 PDF 画布");
        const task = page.render({ canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
        renderTaskRef.current = task;
        await task.promise;
        page.cleanup();
      } catch (renderError) {
        if (active && (renderError as { name?: string }).name !== "RenderingCancelledException") setError(renderError instanceof Error ? renderError.message : "PDF 页面渲染失败");
      }
    })();
    saveProgress(item, { page: pageNumber, scale, fit, rotation });
    return () => { active = false; renderTaskRef.current?.cancel?.(); };
  }, [fit, item.id, item.modifiedAt, item.size, pageCount, pageNumber, rotation, scale, stageSize]);

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setPasswordNeeded(false);
    passwordCallbackRef.current?.(password);
    setPassword("");
  };

  const openOutline = async (entry: any) => {
    const document = documentRef.current;
    if (!document || !entry.dest) return;
    const destination = typeof entry.dest === "string" ? await document.getDestination(entry.dest) : entry.dest;
    if (!destination?.[0]) return;
    const index = typeof destination[0] === "object" ? await document.getPageIndex(destination[0]) : Number(destination[0]);
    setPageNumber(index + 1);
    setTocOpen(false);
  };

  if (error) return <ReaderNotice message={error} downloadUrl={item.fileUrl} fileName={item.fileName} />;
  return (
    <div className="document-reader pdf-reader">
      <div className="reader-toolbar">
        <button ref={tocButtonRef} type="button" className="btn btn--sm" onClick={() => setTocOpen((value) => !value)} disabled={!outline.length} title="PDF 目录"><List size={15} /><span>目录</span></button>
        <span className="reader-toolbar-separator" />
        <button type="button" className="icon-btn" onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber <= 1} title="上一页"><ChevronLeft size={16} /></button>
        <label className="page-jump"><input className="input" aria-label="PDF 页码" type="number" min={1} max={pageCount || 1} value={pageNumber} onChange={(event) => setPageNumber(Math.max(1, Math.min(pageCount || 1, Number(event.target.value) || 1)))} /><span>/ {pageCount || "—"}</span></label>
        <button type="button" className="icon-btn" onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))} disabled={!pageCount || pageNumber >= pageCount} title="下一页"><ChevronRight size={16} /></button>
        <span className="reader-toolbar-separator" />
        <button type="button" className="icon-btn" onClick={() => { setFit("custom"); setScale((value) => Math.max(.5, value - .1)); }} title="缩小"><Minus size={16} /></button>
        <span className="reader-zoom-label">{fit === "custom" ? `${Math.round(scale * 100)}%` : fit === "width" ? "适合宽度" : "适合页面"}</span>
        <button type="button" className="icon-btn" onClick={() => { setFit("custom"); setScale((value) => Math.min(3, value + .1)); }} title="放大"><Plus size={16} /></button>
        <button type="button" className="icon-btn" onClick={() => setFit((value) => value === "width" ? "page" : "width")} title="切换适合宽度或页面"><Maximize2 size={16} /></button>
        <button type="button" className="icon-btn" onClick={() => setRotation((value) => (value + 90) % 360)} title="顺时针旋转"><RotateCw size={16} /></button>
        <a className="icon-btn" href={item.fileUrl} download={item.fileName} title="下载原 PDF"><Download size={16} /></a>
      </div>
      <div ref={tocDrawerRef} className={`reader-drawer${tocOpen ? " is-open" : ""}`} aria-hidden={!tocOpen}>
        <div className="reader-drawer-heading"><strong>文档目录</strong><button type="button" className="icon-btn" onClick={() => setTocOpen(false)} title="关闭目录"><X size={15} /></button></div>
        <div className="reader-toc-list">{outline.map((entry) => <button type="button" key={`${entry.title}-${String(entry.dest)}`} onClick={() => void openOutline(entry)}>{entry.title || "未命名章节"}</button>)}</div>
      </div>
      <div className="pdf-stage" ref={stageRef}>{loading && <ReaderLoading label="正在按需载入 PDF…" />}<canvas ref={canvasRef} /></div>
      {passwordNeeded && <div className="reader-password"><form onSubmit={submitPassword}><strong>此 PDF 需要密码</strong><span>密码仅在本次打开期间保存在内存中。</span><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /><button className="btn btn--primary btn--sm" type="submit" disabled={!password}>解锁文档</button></form></div>}
    </div>
  );
}

function decodeText(bytes: ArrayBuffer) {
  const data = new Uint8Array(bytes);
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder("utf-8").decode(data.subarray(3));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch {
    try { return new TextDecoder("gb18030").decode(data); }
    catch { return new TextDecoder("utf-8").decode(data); }
  }
}

function TextReader({ item }: { item: ReadingItem }) {
  const saved = useMemo(() => readProgress(item), [item]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [fontSize, setFontSize] = useState(Math.max(13, Math.min(28, Number(saved.fontSize) || 17)));
  const [lineHeight, setLineHeight] = useState(Math.max(1.35, Math.min(2.2, Number(saved.lineHeight) || 1.75)));
  const [paper, setPaper] = useState<"screen" | "sepia">(saved.paper === "sepia" ? "sepia" : "screen");

  useEffect(() => {
    if (item.size > TEXT_LIMIT) return setError(`TXT 在线阅读上限为 16 MiB；当前文件为 ${formatBytes(item.size)}。`);
    const controller = new AbortController();
    fetch(item.fileUrl, { signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error(`文件请求失败（${response.status}）`);
      return response.arrayBuffer();
    }).then((bytes) => setContent(decodeText(bytes))).catch((loadError) => {
      if ((loadError as { name?: string }).name !== "AbortError") setError(loadError instanceof Error ? loadError.message : "TXT 读取失败");
    });
    return () => controller.abort();
  }, [item.fileUrl, item.size]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !content) return;
    const frame = requestAnimationFrame(() => { element.scrollTop = Number(saved.scrollTop) || 0; });
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => saveProgress(item, { scrollTop: element.scrollTop, fontSize, lineHeight, paper }), 180);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); element.removeEventListener("scroll", onScroll); };
  }, [content, fontSize, item, lineHeight, paper, saved.scrollTop]);

  useEffect(() => { saveProgress(item, { fontSize, lineHeight, paper }); }, [fontSize, item, lineHeight, paper]);
  if (error) return <ReaderNotice message={error} downloadUrl={item.fileUrl} fileName={item.fileName} />;
  return (
    <div className={`document-reader text-reader text-paper-${paper}`}>
      <div className="reader-toolbar"><button type="button" className="icon-btn" onClick={() => setFontSize((value) => Math.max(13, value - 1))} title="减小字号"><Minus size={16} /></button><span>{fontSize}px</span><button type="button" className="icon-btn" onClick={() => setFontSize((value) => Math.min(28, value + 1))} title="增大字号"><Plus size={16} /></button><label>行距<select className="select" value={lineHeight} onChange={(event) => setLineHeight(Number(event.target.value))}><option value={1.45}>紧凑</option><option value={1.75}>舒适</option><option value={2}>宽松</option></select></label><button type="button" className="btn btn--sm" onClick={() => setPaper((value) => value === "screen" ? "sepia" : "screen")}>{paper === "screen" ? "羊皮纸" : "跟随主题"}</button><a className="icon-btn" href={item.fileUrl} download={item.fileName} title="下载原文件"><Download size={16} /></a></div>
      <div className="text-scroll" ref={containerRef}>{content ? <pre style={{ fontSize, lineHeight }}>{content}</pre> : <ReaderLoading label="正在识别文本编码…" />}</div>
    </div>
  );
}

function ebookStyles(fontSize: number, lineHeight: number, paper: "screen" | "sepia", appTheme: "dark" | "light") {
  const sepia = paper === "sepia";
  const dark = !sepia && appTheme === "dark";
  const foreground = sepia ? "#332b20" : dark ? "#e9e7e1" : "#263140";
  const background = sepia ? "#eee3cc" : dark ? "#11141a" : "#f7f9fc";
  const link = sepia ? "#356b82" : dark ? "#64d2ff" : "#176fae";
  return `
    :root { color-scheme: ${dark ? "dark" : "light"}; }
    html, body { color: ${foreground} !important; background: ${background} !important; }
    body { font-size: ${fontSize}% !important; padding-inline: 3% !important; }
    html, body, body * { -webkit-user-select: none !important; user-select: none !important; }
    p, li, blockquote, dd { line-height: ${lineHeight} !important; }
    img, svg { max-width: 100% !important; max-height: 100% !important; }
    a { color: ${link} !important; }
  `;
}

function FoliateReader({ item, theme, immersive, onToggleImmersive, onToggleImmersiveControls, onRevealImmersiveControls }: {
  item: ReadingItem;
  theme: "dark" | "light";
  immersive: boolean;
  onToggleImmersive: () => Promise<void>;
  onToggleImmersiveControls: () => void;
  onRevealImmersiveControls: () => void;
}) {
  const saved = useMemo(() => readProgress(item), [item]);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const tocButtonRef = useRef<HTMLButtonElement>(null);
  const tocDrawerRef = useRef<HTMLDivElement>(null);
  const pageTurnLockedRef = useRef(false);
  const pendingFractionRef = useRef<number | null>(null);
  const mobileTapStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const clickBoundDocumentsRef = useRef(new WeakSet<Document>());
  const turnPageRef = useRef<(direction: "previous" | "next") => Promise<void>>(async () => {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState(item.title);
  const [author, setAuthor] = useState("");
  const [toc, setToc] = useState<Array<TocEntry & { depth: number }>>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [fraction, setFraction] = useState(Math.max(0, Math.min(1, Number(saved.fraction) || 0)));
  const [pendingFraction, setPendingFraction] = useState<number | null>(null);
  const [flow, setFlow] = useState<"paginated" | "scrolled">(saved.flow === "scrolled" ? "scrolled" : "paginated");
  const [fontSize, setFontSize] = useState(Math.max(80, Math.min(180, Number(saved.fontSize) || 100)));
  const [lineHeight, setLineHeight] = useState(Math.max(1.25, Math.min(2, Number(saved.lineHeight) || 1.55)));
  const paper = "screen" as const;
  const tocOpenRef = useRef(tocOpen);
  const flowRef = useRef(flow);
  tocOpenRef.current = tocOpen;
  flowRef.current = flow;
  useDismissableDrawer(tocOpen, () => setTocOpen(false), tocButtonRef, tocDrawerRef);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    let active = true;
    let view: FoliateViewElement | null = null;
    let activeTurnPage: ((direction: "previous" | "next") => Promise<void>) | null = null;
    void (async () => {
      try {
        const foliate = await import("foliate-js/view.js");
        const response = await fetch(item.fileUrl, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`文件请求失败（${response.status}）`);
        const blob = await response.blob();
        if (!active) return;
        const file = new File([blob], item.fileName, { type: response.headers.get("content-type") || blob.type });
        view = document.createElement("foliate-view") as FoliateViewElement;
        view.className = "foliate-view";
        host.replaceChildren(view);
        viewRef.current = view;
        const book = await foliate.makeBook(file, { sha1: sha1ForEpub }) as NonNullable<FoliateViewElement["book"]>;
        if (!active || viewRef.current !== view) return;
        const navigateAndWait = async (navigate: () => void | Promise<void>) => {
          await navigate();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        };
        const turnPage = async (direction: "previous" | "next") => {
          if (!view || viewRef.current !== view || pageTurnLockedRef.current || flowRef.current !== "paginated") return;
          pageTurnLockedRef.current = true;
          const before = view.lastLocation;
          try {
            const page = Number(view.renderer?.page);
            const pages = Number(view.renderer?.pages);
            const currentIndex = before?.section?.current;
            const atSectionBoundary = Number.isFinite(page) && Number.isFinite(pages)
              && (direction === "next" ? page >= pages - 2 : page <= 1);
            if (atSectionBoundary && typeof currentIndex === "number") {
              const step = direction === "next" ? 1 : -1;
              const sections = view.book?.sections || [];
              let nextIndex = currentIndex + step;
              while (nextIndex >= 0 && nextIndex < sections.length && sections[nextIndex]?.linear === "no") nextIndex += step;
              const nextHref = sections[nextIndex]?.id;
              if (nextHref) {
                if (direction === "next") await navigateAndWait(() => view?.goTo(nextHref));
                else await navigateAndWait(() => view?.renderer?.goTo?.({ index: nextIndex, anchor: () => 1 }));
              }
            } else {
              const rtl = view.renderer?.getAttribute("dir") === "rtl";
              const delta = (direction === "next" ? 1 : -1) * (rtl ? -1 : 1);
              if (view.renderer?.snap) await navigateAndWait(() => view?.renderer?.snap?.(delta, delta));
              else await navigateAndWait(() => direction === "next" ? view?.next() : view?.prev());
            }
          } catch (turnError) {
            console.error("电子书翻页失败", turnError);
          } finally {
            window.setTimeout(() => { pageTurnLockedRef.current = false; }, 140);
          }
        };
        activeTurnPage = turnPage;
        view.addEventListener("load", ((loadEvent: CustomEvent) => {
          const bookDocument = loadEvent.detail?.doc as Document | undefined;
          if (!bookDocument || clickBoundDocumentsRef.current.has(bookDocument)) return;
          clickBoundDocumentsRef.current.add(bookDocument);
          let pointerStart: { id: number; x: number; y: number } | null = null;
          let suppressNextClick = false;
          bookDocument.addEventListener("selectstart", (selectionEvent) => {
            selectionEvent.preventDefault();
          });
          bookDocument.addEventListener("pointerdown", (pointerEvent) => {
            if (!pointerEvent.isPrimary || pointerEvent.button !== 0) return;
            pointerStart = { id: pointerEvent.pointerId, x: pointerEvent.clientX, y: pointerEvent.clientY };
            suppressNextClick = false;
            bookDocument.getSelection()?.removeAllRanges();
          });
          bookDocument.addEventListener("pointermove", (pointerEvent) => {
            if (!pointerStart || pointerStart.id !== pointerEvent.pointerId) return;
            if (Math.hypot(pointerEvent.clientX - pointerStart.x, pointerEvent.clientY - pointerStart.y) > 8) suppressNextClick = true;
          });
          bookDocument.addEventListener("pointerup", () => { pointerStart = null; });
          bookDocument.addEventListener("pointercancel", () => { pointerStart = null; suppressNextClick = true; });
          bookDocument.addEventListener("click", async (pageEvent: MouseEvent) => {
            const target = pageEvent.target as { closest?: (selector: string) => Element | null } | null;
            if (pageEvent.defaultPrevented || target?.closest?.("a, button, input, select, textarea, [role='button']")) return;
            if (suppressNextClick || pageEvent.detail > 1) {
              suppressNextClick = false;
              return;
            }
            const selection = bookDocument.getSelection();
            if (selection && !selection.isCollapsed) return;
            if (tocOpenRef.current) {
              setTocOpen(false);
              return;
            }
            if (flowRef.current !== "paginated") return;
            // The book iframe is expanded to the full chapter width by Foliate's
            // paginator. Its document width is therefore much wider than the
            // visible page on phones, which made every tap look like a tap on
            // the left side. Use the renderer viewport that the reader actually
            // shows when deciding which half was pressed.
            const pageWidth = view?.renderer?.clientWidth
              || bookDocument.defaultView?.visualViewport?.width
              || bookDocument.defaultView?.innerWidth
              || bookDocument.documentElement.clientWidth
              || 0;
            if (!pageWidth) return;
            await turnPage(pageEvent.clientX < pageWidth / 2 ? "previous" : "next");
          });
        }) as EventListener);
        await view.open(book);
        if (!active) return;
        turnPageRef.current = turnPage;
        view.renderer?.setAttribute("flow", flow);
        view.renderer?.setStyles?.(ebookStyles(fontSize, lineHeight, paper, theme));
        const metadata = view.book?.metadata;
        setTitle(formatLanguageMap(metadata?.title) || item.title);
        setAuthor(formatContributor(metadata?.author));
        setToc(flattenToc(view.book?.toc));
        view.addEventListener("relocate", ((event: CustomEvent) => {
          const detail = event.detail || {};
          const rawFraction = Number(detail.fraction);
          const nextFraction = Number.isFinite(rawFraction) ? Math.max(0, Math.min(1, rawFraction)) : null;
          if (nextFraction !== null) setFraction(nextFraction);
          saveProgress(item, {
            ...(nextFraction === null ? {} : { fraction: nextFraction }),
            cfi: detail.cfi || null,
            section: Number.isFinite(Number(detail.section?.current)) ? Number(detail.section.current) : null,
            flow,
            fontSize,
            lineHeight,
            paper,
          });
        }) as EventListener);
        const savedFraction = Math.max(0, Math.min(1, Number(saved.fraction) || 0));
        const savedCfi = typeof saved.cfi === "string" ? saved.cfi : "";
        const savedTarget = savedCfi ? view.resolveNavigation?.(savedCfi) : undefined;
        const savedSection = Number(saved.section);
        const savedHref = Number.isInteger(savedSection) && savedSection >= 0
          ? view.book?.sections?.[savedSection]?.id
          : undefined;
        if (savedTarget && view.renderer?.goTo) {
          await navigateAndWait(() => view?.renderer?.goTo?.(savedTarget));
        } else if (savedHref) {
          await navigateAndWait(() => view?.goTo(savedHref));
        }
        if (!view.lastLocation && savedFraction > 0) await navigateAndWait(() => view?.goToFraction(savedFraction));
        if (!view.lastLocation) await navigateAndWait(() => view?.goToFraction(0));
        if (!view.lastLocation) {
          const firstIndex = view.book?.sections?.findIndex((section) => section.linear !== "no") ?? -1;
          if (firstIndex >= 0) await navigateAndWait(() => view?.renderer?.goTo?.({ index: firstIndex, anchor: 0 }));
        }
        setLoading(false);
      } catch (loadError) {
        if (active && (loadError as { name?: string }).name !== "AbortError") {
          setError(loadError instanceof Error ? loadError.message : "电子书读取失败");
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (activeTurnPage && turnPageRef.current === activeTurnPage) turnPageRef.current = async () => {};
      view?.close?.();
      if (viewRef.current === view) viewRef.current = null;
      host.replaceChildren();
    };
  }, [item.fileName, item.fileUrl]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view?.renderer) return;
    view.renderer.setAttribute("flow", flow);
    view.renderer.setStyles?.(ebookStyles(fontSize, lineHeight, paper, theme));
    view.deselect?.();
    saveProgress(item, { flow, fontSize, lineHeight, paper });
  }, [flow, fontSize, item, lineHeight, paper, theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "ArrowLeft") void turnPageRef.current("previous");
      if (event.key === "ArrowRight") void turnPageRef.current("next");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const previewProgress = (value: number) => {
    const nextFraction = Math.max(0, Math.min(1, value));
    pendingFractionRef.current = nextFraction;
    setPendingFraction(nextFraction);
  };

  const cancelProgressPreview = () => {
    pendingFractionRef.current = null;
    setPendingFraction(null);
  };

  const commitProgress = (targetFraction: number | null = pendingFractionRef.current) => {
    const nextFraction = targetFraction === null ? null : Math.max(0, Math.min(1, targetFraction));
    if (nextFraction === null) return;
    pendingFractionRef.current = null;
    setPendingFraction(null);
    setFraction(nextFraction);
    void viewRef.current?.goToFraction(nextFraction).catch((seekError) => {
      console.error("电子书进度跳转失败", seekError);
    });
  };

  const handleMobilePagePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = mobileTapStartRef.current;
    mobileTapStartRef.current = null;
    if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const horizontalPosition = (event.clientX - bounds.left) / bounds.width;
    if (immersive && horizontalPosition >= .36 && horizontalPosition <= .64) {
      if (event.pointerType === "mouse") onRevealImmersiveControls();
      else onToggleImmersiveControls();
      return;
    }
    void turnPageRef.current(horizontalPosition < .5 ? "previous" : "next");
  };

  if (error) return <ReaderNotice message={error} downloadUrl={item.fileUrl} fileName={item.fileName} />;
  return (
    <div className={`document-reader foliate-reader paper-${paper}`}>
      <div className="reader-toolbar">
        <button ref={tocButtonRef} type="button" className="btn btn--sm" onClick={() => setTocOpen((value) => !value)} disabled={!toc.length} title="书籍目录"><List size={15} /><span>目录</span></button>
        <span className="reader-book-meta"><strong>{title}</strong>{author && <small>{author}</small>}</span>
        <select className="select" value={flow} aria-label="排版" title="排版" onChange={(event) => setFlow(event.target.value as "paginated" | "scrolled")}><option value="paginated">分页</option><option value="scrolled">滚动</option></select>
        <button type="button" className="icon-btn" onClick={() => setFontSize((value) => Math.max(80, value - 10))} title="减小字号"><Minus size={16} /></button><span>{fontSize}%</span><button type="button" className="icon-btn" onClick={() => setFontSize((value) => Math.min(180, value + 10))} title="增大字号"><Plus size={16} /></button>
        <label>行距<select className="select" value={lineHeight} onChange={(event) => setLineHeight(Number(event.target.value))}><option value={1.35}>紧凑</option><option value={1.55}>舒适</option><option value={1.8}>宽松</option></select></label>
        <button className="icon-btn" type="button" onClick={() => void onToggleImmersive()} aria-pressed={immersive} aria-label={immersive ? "退出沉浸阅读" : "沉浸式全屏阅读"} title={immersive ? "退出沉浸阅读" : "沉浸式全屏阅读"}>{immersive ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        <a className="icon-btn" href={item.fileUrl} download={item.fileName} title="下载原文件"><Download size={16} /></a>
      </div>
      <div ref={tocDrawerRef} className={`reader-drawer${tocOpen ? " is-open" : ""}`} aria-hidden={!tocOpen}><div className="reader-drawer-heading"><strong>书籍目录</strong><button type="button" className="icon-btn" onClick={() => setTocOpen(false)}><X size={15} /></button></div><div className="reader-toc-list">{toc.map((entry, index) => <button type="button" key={`${entry.href}-${index}`} style={{ paddingLeft: `${14 + entry.depth * 14}px` }} onClick={() => { if (entry.href) void viewRef.current?.goTo(entry.href); setTocOpen(false); }}>{entry.label || "未命名章节"}</button>)}</div></div>
      <div className="foliate-stage">
        <div ref={hostRef} className="foliate-host" />
        {!loading && flow === "paginated" && <div
          className={`mobile-page-turn-layer${immersive ? " is-immersive" : ""}`}
          aria-hidden="true"
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            mobileTapStartRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            if (!immersive || event.pointerType !== "mouse") return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const horizontalPosition = (event.clientX - bounds.left) / bounds.width;
            const verticalPosition = (event.clientY - bounds.top) / bounds.height;
            if (horizontalPosition >= .36 && horizontalPosition <= .64 && verticalPosition >= .24 && verticalPosition <= .76) onRevealImmersiveControls();
          }}
          onPointerUp={handleMobilePagePointerUp}
          onPointerCancel={() => { mobileTapStartRef.current = null; }}
        />}
        {loading && <ReaderLoading label="正在读取书籍结构与目录…" />}
      </div>
      <div className="reading-progress">
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round((pendingFraction ?? fraction) * 1000)}
          disabled={loading}
          aria-label="阅读进度"
          aria-valuetext={`${Math.round((pendingFraction ?? fraction) * 100)}%`}
          title="拖动后松开跳转到对应阅读位置"
          style={{ "--reading-progress": `${(pendingFraction ?? fraction) * 100}%` } as React.CSSProperties}
          onChange={(event) => previewProgress(Number(event.currentTarget.value) / 1000)}
          onPointerUp={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            commitProgress(bounds.width ? (event.clientX - bounds.left) / bounds.width : pendingFractionRef.current);
          }}
          onPointerCancel={cancelProgressPreview}
          onKeyDown={(event) => {
            const current = pendingFractionRef.current ?? fraction;
            const next = event.key === "Home" ? 0
              : event.key === "End" ? 1
                : event.key === "PageDown" ? current + .1
                  : event.key === "PageUp" ? current - .1
                    : event.key === "ArrowRight" || event.key === "ArrowUp" ? current + .01
                      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? current - .01
                        : null;
            if (next === null) return;
            event.preventDefault();
            commitProgress(next);
          }}
          onBlur={() => commitProgress()}
        />
        <small>{Math.round((pendingFraction ?? fraction) * 100)}%</small>
      </div>
    </div>
  );
}

type SheetData = {
  name: string;
  rowCount: number;
  columnCount: number;
  cells: Array<{ row: number; column: number; text: string }>;
  merges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>;
  rowHeights: number[];
  columnWidths: number[];
  truncated: boolean;
};

function columnLabel(index: number) {
  let value = index + 1;
  let label = "";
  while (value) { value -= 1; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
}

function SpreadsheetGrid({ sheet }: { sheet: SheetData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cellMap = useMemo(() => new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell.text])), [sheet.cells]);
  const mergeMap = useMemo(() => {
    const map = new Map<string, SheetData["merges"][number] | null>();
    for (const merge of sheet.merges) {
      map.set(`${merge.startRow}:${merge.startColumn}`, merge);
      const area = (merge.endRow - merge.startRow + 1) * (merge.endColumn - merge.startColumn + 1);
      if (area > 10_000) continue;
      for (let row = merge.startRow; row <= merge.endRow; row += 1) for (let column = merge.startColumn; column <= merge.endColumn; column += 1) {
        if (row !== merge.startRow || column !== merge.startColumn) map.set(`${row}:${column}`, null);
      }
    }
    return map;
  }, [sheet.merges]);
  const rowVirtualizer = useVirtualizer({ count: sheet.rowCount + 1, getScrollElement: () => containerRef.current, estimateSize: (index) => index === 0 ? 32 : sheet.rowHeights[index - 1] || 30, overscan: 8 });
  const columnVirtualizer = useVirtualizer({ horizontal: true, count: sheet.columnCount + 1, getScrollElement: () => containerRef.current, estimateSize: (index) => index === 0 ? 52 : sheet.columnWidths[index - 1] || 120, overscan: 3 });
  const columnItems = columnVirtualizer.getVirtualItems();
  return (
    <div className="sheet-grid" ref={containerRef} role="grid" aria-rowcount={sheet.rowCount} aria-colcount={sheet.columnCount}>
      <div className="sheet-grid-canvas" style={{ width: columnVirtualizer.getTotalSize(), height: rowVirtualizer.getTotalSize() }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div key={virtualRow.key} className={`sheet-grid-row${virtualRow.index === 0 ? " header" : ""}`} style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}>
            {columnItems.map((virtualColumn) => {
              const row = virtualRow.index - 1;
              const column = virtualColumn.index - 1;
              const key = `${row}:${column}`;
              const mergeKnown = mergeMap.has(key);
              const merge = mergeMap.get(key);
              if (mergeKnown && merge === null) return null;
              const width = merge ? Array.from({ length: merge.endColumn - merge.startColumn + 1 }, (_, offset) => sheet.columnWidths[column + offset] || 120).reduce((sum, value) => sum + value, 0) : virtualColumn.size;
              const height = merge ? Array.from({ length: merge.endRow - merge.startRow + 1 }, (_, offset) => sheet.rowHeights[row + offset] || 30).reduce((sum, value) => sum + value, 0) : virtualRow.size;
              const text = row < 0 && column < 0 ? "" : row < 0 ? columnLabel(column) : column < 0 ? String(row + 1) : cellMap.get(key) || "";
              return <div key={virtualColumn.key} className={`sheet-cell${row < 0 || column < 0 ? " heading" : ""}${column < 0 ? " row-heading" : ""}${merge ? " merged" : ""}`} role={row < 0 || column < 0 ? "rowheader" : "gridcell"} title={text} style={{ left: virtualColumn.start, width, height }}>{text}</div>;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function SpreadsheetReader({ item }: { item: ReadingItem }) {
  const saved = useMemo(() => readProgress(item), [item]);
  const workerRef = useRef<Worker | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState(typeof saved.sheet === "string" ? saved.sheet : "");
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (item.size > SPREADSHEET_LIMIT) {
      setError(`表格在线预览上限为 64 MiB；当前文件为 ${formatBytes(item.size)}。`);
      setLoading(false);
      return;
    }
    const worker = new Worker(new URL("./reading-sheet.worker.ts", import.meta.url), { type: "module", name: "lmd-sheet-reader" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.type === "error") { setError(event.data.message); setLoading(false); return; }
      if (event.data.type === "names") {
        const names = event.data.names as string[];
        setSheetNames(names);
        const initial = names.includes(selectedSheet) ? selectedSheet : names[0] || "";
        setSelectedSheet(initial);
        if (initial) worker.postMessage({ type: "sheet", name: initial });
        else { setError("这个工作簿不包含可见工作表。"); setLoading(false); }
      }
      if (event.data.type === "sheet") { setSheet(event.data as SheetData); setLoading(false); }
    };
    worker.onerror = () => { setError("表格解析 Worker 意外停止，请重试。"); setLoading(false); };
    worker.postMessage({ type: "open", url: item.fileUrl });
    return () => { worker.terminate(); workerRef.current = null; };
  }, [item.fileUrl, item.size]);

  const chooseSheet = (name: string) => {
    setSelectedSheet(name);
    setSheet(null);
    setLoading(true);
    saveProgress(item, { sheet: name });
    workerRef.current?.postMessage({ type: "sheet", name });
  };
  if (error) return <ReaderNotice message={error} downloadUrl={item.fileUrl} fileName={item.fileName} />;
  return (
    <div className="document-reader spreadsheet-reader">
      <div className="reader-toolbar sheet-toolbar"><div className="sheet-tabs" role="tablist">{sheetNames.map((name) => <button type="button" role="tab" aria-selected={selectedSheet === name} className={selectedSheet === name ? "active" : ""} key={name} onClick={() => chooseSheet(name)}>{name}</button>)}</div><span className="sheet-capability" title="宏、公式重算、图表和复杂视觉样式不在快速预览范围内"><Table2 size={15} />只读数据预览</span><a className="icon-btn" href={item.fileUrl} download={item.fileName} title="下载原表格"><Download size={16} /></a></div>
      {sheet?.truncated && <div className="sheet-warning"><AlertTriangle size={15} />工作表范围过大，已安全限制预览行列或非空单元格数量；原文件未被修改。</div>}
      {loading ? <ReaderLoading label={sheetNames.length ? "正在解析所选工作表…" : "正在读取工作表名称…"} /> : sheet && <SpreadsheetGrid sheet={sheet} />}
    </div>
  );
}

function ReadingDocument({ item, theme }: { item: ReadingItem; theme: "dark" | "light" }) {
  const pageRef = useRef<HTMLElement>(null);
  const immersiveHideTimerRef = useRef<number | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [immersiveControlsVisible, setImmersiveControlsVisible] = useState(true);
  const isPdf = item.extension === "PDF";
  const isText = item.extension === "TXT";
  const nativeFullscreenAvailable = typeof document !== "undefined" && "requestFullscreen" in HTMLElement.prototype;
  const clearImmersiveHideTimer = () => {
    if (immersiveHideTimerRef.current !== null) window.clearTimeout(immersiveHideTimerRef.current);
    immersiveHideTimerRef.current = null;
  };
  const hideImmersiveControls = () => {
    clearImmersiveHideTimer();
    setImmersiveControlsVisible(false);
  };
  const revealImmersiveControls = () => {
    if (!immersive) return;
    clearImmersiveHideTimer();
    setImmersiveControlsVisible(true);
    immersiveHideTimerRef.current = window.setTimeout(() => setImmersiveControlsVisible(false), 4200);
  };
  const toggleImmersiveControls = () => {
    if (!immersive) return;
    if (immersiveControlsVisible) hideImmersiveControls();
    else revealImmersiveControls();
  };
  useEffect(() => {
    const syncFullscreen = () => {
      const isPageFullscreen = document.fullscreenElement === pageRef.current;
      if (!isPageFullscreen) {
        clearImmersiveHideTimer();
        setImmersive(false);
        setImmersiveControlsVisible(true);
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      clearImmersiveHideTimer();
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("reading-immersive-active", immersive);
    return () => document.documentElement.classList.remove("reading-immersive-active");
  }, [immersive]);
  const toggleImmersive = async () => {
    if (!pageRef.current) return;
    if (immersive) {
      clearImmersiveHideTimer();
      setImmersive(false);
      setImmersiveControlsVisible(true);
      if (document.fullscreenElement === pageRef.current) {
        try {
          await document.exitFullscreen();
        } catch {
          // The UI has already left immersive mode; native Escape remains available.
        }
      }
      return;
    }
    setImmersive(true);
    setImmersiveControlsVisible(false);
    if (!nativeFullscreenAvailable || document.fullscreenElement === pageRef.current) return;
    try {
      await pageRef.current.requestFullscreen();
    } catch {
      // Mobile Safari and embedded browsers may reject native fullscreen.
      // The fixed-position immersive layout remains fully functional.
    }
  };
  return (
    <section
      ref={pageRef}
      className={`reading-document-page${immersive ? " is-immersive" : ""}${immersive && immersiveControlsVisible ? " immersive-controls-visible" : ""}`}
      onPointerMove={(event) => {
        if (!immersive || event.pointerType !== "mouse") return;
        const target = event.target as Element;
        if (target.closest(".reader-toolbar, .reader-drawer")) revealImmersiveControls();
      }}
    >
      <div className="reader-head"><div className="reader-head-title"><strong>{item.title}</strong><span>{item.extension} · {formatBytes(item.size)} · 只读</span></div></div>
      {item.kind === "spreadsheet" ? <SpreadsheetReader item={item} /> : isPdf ? <PdfReader item={item} /> : isText ? <TextReader item={item} /> : <FoliateReader item={item} theme={theme} immersive={immersive} onToggleImmersive={toggleImmersive} onToggleImmersiveControls={toggleImmersiveControls} onRevealImmersiveControls={revealImmersiveControls} />}
    </section>
  );
}

export function ReadingLibraryView({ catalog, folderId, documentId, filter, search, theme, onOpenFolder, onOpenDocument, onBackToLibrary, onFilterChange }: {
  catalog: ReadingCatalog;
  folderId: string | null;
  documentId: string | null;
  filter: ReadingFilter;
  search: string;
  theme: "dark" | "light";
  onOpenFolder: (folderId: string) => void;
  onOpenDocument: (item: ReadingItem) => void;
  onBackToLibrary: () => void;
  onFilterChange: (filter: ReadingFilter) => void;
}) {
  const folderById = useMemo(() => new Map(catalog.folders.map((folder) => [folder.id, folder])), [catalog.folders]);
  const itemById = useMemo(() => new Map(catalog.items.map((item) => [item.id, item])), [catalog.items]);
  const rootFolders = catalog.folders.filter((folder) => folder.parentId === null);
  const singleRootFolder = rootFolders.length === 1 ? rootFolders[0] : null;
  const currentFolder = folderById.get(folderId || "") || singleRootFolder;
  const document = catalog.items.find((item) => item.id === documentId) || null;
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const matchesKind = (item: ReadingItem) => filter === "all" || item.kind === filter;
  const matchesSearch = (item: ReadingItem) => `${item.title} ${item.fileName} ${item.extension}`.toLocaleLowerCase("zh-CN").includes(normalizedSearch);
  const items = catalog.items.filter((item) => matchesKind(item) && (!normalizedSearch || matchesSearch(item)));
  const folderHasVisibleItems = (folder: ReadingFolder) => items.some((item) => {
    let candidate = folderById.get(item.folderId) || null;
    while (candidate) { if (candidate.id === folder.id) return true; candidate = candidate.parentId ? folderById.get(candidate.parentId) || null : null; }
    return false;
  });
  const folders = catalog.folders.filter((folder) => folder.parentId === currentFolder?.id || (!currentFolder && folder.parentId === null)).filter((folder) => folderHasVisibleItems(folder));
  const directItems = items.filter((item) => currentFolder ? item.folderId === currentFolder.id : false).sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true }));
  const trail: ReadingFolder[] = [];
  let trailCursor = currentFolder;
  const visited = new Set<string>();
  while (trailCursor && !visited.has(trailCursor.id)) { trail.unshift(trailCursor); visited.add(trailCursor.id); trailCursor = trailCursor.parentId ? folderById.get(trailCursor.parentId) || null : null; }
  const visibleTrail = singleRootFolder ? trail.filter((folder) => folder.id !== singleRootFolder.id) : trail;

  if (document) return <ReadingDocument item={document} theme={theme} />;
  const scopedItems = currentFolder ? directItems : items;
  const ebookCount = scopedItems.filter((item) => item.kind === "ebook").length;
  const spreadsheetCount = scopedItems.length - ebookCount;
  const atLibraryRoot = !folderId || folderId === singleRootFolder?.id;
  return (
    <div className="rd-view">
      <div className="lib-toolbar">
        <nav className="crumbs" aria-label="当前阅读文件夹路径">
          {!atLibraryRoot && currentFolder ? (
            <>
              <button type="button" onClick={onBackToLibrary}>全部阅读</button>
              {visibleTrail.map((folder) => (
                <React.Fragment key={folder.id}>
                  <span className="crumbs-sep">/</span>
                  <button type="button" onClick={() => onOpenFolder(folder.id)} aria-current={folder.id === currentFolder.id ? "page" : undefined}>{folder.title}</button>
                </React.Fragment>
              ))}
            </>
          ) : (
            <span>全部阅读</span>
          )}
        </nav>
        <span className="lib-stats">{folders.length} 个文件夹 · {ebookCount} 本书 · {spreadsheetCount} 个表格</span>
        <div className="lib-toolbar-actions">
          <div className="segmented" aria-label="阅读类型筛选">
            {(["all", "ebook", "spreadsheet"] as ReadingFilter[]).map((value) => <button type="button" key={value} className={filter === value ? "is-active" : ""} onClick={() => onFilterChange(value)}>{value === "all" ? "全部" : value === "ebook" ? "电子书" : "表格"}</button>)}
          </div>
        </div>
      </div>
      {folders.length > 0 && <div className="rd-folder-grid">
        {folders.map((folder) => {
          const coverItem = folder.coverMediaId ? itemById.get(folder.coverMediaId) || null : null;
          return (
            <div className="rd-card rd-card--folder" key={folder.id}>
              <button type="button" className="rd-hit" onClick={() => onOpenFolder(folder.id)} aria-label={`打开文件夹 ${folder.title}`} />
              <div className="rd-cover"><FolderOpen size={20} />{coverItem ? <ReadingThumbnail item={coverItem} /> : null}<span className="rd-badge">{folder.ebookCount} 书 · {folder.spreadsheetCount} 表</span></div>
              <h3 className="rd-title">{folder.title}</h3>
              <p className="rd-meta">{folder.childCount ? `${folder.childCount} 个子文件夹 · ` : ""}{folder.ebookCount} 本电子书 · {folder.spreadsheetCount} 个表格</p>
            </div>
          );
        })}
      </div>}
      {directItems.length > 0 && <div className="rd-grid">
        {directItems.map((item) => (
          <div className="rd-card" key={item.id}>
            <button type="button" className="rd-hit" onClick={() => onOpenDocument(item)} aria-label={item.title} />
            <div className="rd-cover">{item.kind === "ebook" ? <BookOpen size={20} /> : <Table2 size={20} />}{item.kind === "ebook" ? <ReadingThumbnail item={item} /> : null}<span className="rd-badge">{item.extension}</span></div>
            <h3 className="rd-title">{item.title}</h3>
            <p className="rd-meta">{item.kind === "ebook" ? "电子书" : "只读表格"} · {formatBytes(item.size)}</p>
          </div>
        ))}
      </div>}
      {!folders.length && !directItems.length && (
        <div className="empty-state"><BookOpen size={24} /><strong>{normalizedSearch ? "没有匹配的阅读内容" : "这个阅读目录暂时为空"}</strong><span>{normalizedSearch ? "请尝试其他文件名或格式。" : "请在本机管理端添加阅读目录并扫描。"}</span></div>
      )}
    </div>
  );
}

export function ReadingAdminPanel({ overview, onRefresh, onNotice }: { overview: ReadingOverview | null; onRefresh: (quiet?: boolean) => Promise<void>; onNotice: (message: string) => void }) {
  const [folderPath, setFolderPath] = useState("");
  const [busy, setBusy] = useState(false);
  const register = async (selectedPath: string) => {
    const result = await requestJson<{ library: { id: string; name: string; path: string }; added: boolean }>("/api/reading/libraries", { method: "POST", body: JSON.stringify({ folderPath: selectedPath }) });
    setFolderPath("");
    await onRefresh(true);
    onNotice(result.added ? `已添加阅读目录：${result.library.path}。` : `阅读目录“${result.library.name}”已经存在。`);
  };
  const chooseFolder = async () => {
    setBusy(true);
    onNotice("请在弹出的 Windows 窗口中选择电子书与表格文件夹…");
    try {
      const result = await requestJson<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (!result.cancelled && result.path) await register(result.path);
      else onNotice("已取消选择阅读文件夹。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法选择阅读文件夹"); }
    finally { setBusy(false); }
  };
  const scan = async () => {
    setBusy(true);
    onNotice("正在扫描电子书与表格文件名；不会解包或修改原文件…");
    try {
      const result = await requestJson<{ count: number }>("/api/reading/catalog/scan?mode=turbo", { method: "POST" });
      onNotice(`阅读扫描完成，共发现 ${result.count} 个文件。`);
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "阅读扫描失败"); }
    finally { setBusy(false); }
  };
  const remove = async (library: { id: string; name: string }) => {
    if (!window.confirm(`确定从 LMD 中移除阅读目录“${library.name}”吗？\n\n只移除索引，不会删除硬盘中的电子书或表格。`)) return;
    setBusy(true);
    try {
      const result = await requestJson<{ removedItemCount: number }>(`/api/reading/libraries/${encodeURIComponent(library.id)}`, { method: "DELETE" });
      onNotice(`已移除阅读目录“${library.name}”及 ${result.removedItemCount} 条索引；原文件未被删除。`);
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法移除阅读目录"); }
    finally { setBusy(false); }
  };
  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <div>
          <h2>阅读目录</h2>
          <p>一套目录统一管理 PDF、EPUB 等电子书和 Excel 表格；仅建立索引，不转换、不修改原文件。</p>
        </div>
        <div className="adm-actions">
          <span className="tag">{overview?.items.filter((item) => item.kind === "ebook").length || 0} 本书 · {overview?.items.filter((item) => item.kind === "spreadsheet").length || 0} 个表格</span>
          <button className="btn btn--sm" onClick={() => void scan()} disabled={busy || overview?.scanning || !overview?.libraries.length}><RefreshCw size={15} className={busy || overview?.scanning ? "spin" : ""} />扫描阅读</button>
        </div>
      </div>
      <div className="adm-add">
        <button className="btn" onClick={() => void chooseFolder()} disabled={busy}><FolderOpen size={15} />选择并添加阅读文件夹</button>
        <input className="input" aria-label="阅读目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && folderPath.trim() && !busy) void register(folderPath.trim()); }} placeholder="也可以手动输入路径，按 Enter 添加" />
      </div>
      <div className="adm-rows">
        {overview?.libraries.length ? overview.libraries.map((library) => (
          <div className="adm-row" key={library.id}>
            <HardDrive size={15} />
            <div className="adm-row-main"><strong>{library.name}</strong><span>{library.path}</span></div>
            <span className="adm-row-meta">{overview?.items.filter((item) => item.libraryId === library.id).length || 0} 个文件</span>
            <button type="button" className="icon-btn icon-btn--danger" onClick={() => void remove(library)} disabled={busy} title={`移除阅读目录 ${library.name}`}><Trash2 size={15} /></button>
          </div>
        )) : (
          <div className="empty-state"><BookOpen size={24} /><strong>还没有阅读目录</strong><span>添加后即可浏览电子书和表格。</span></div>
        )}
      </div>
    </section>
  );
}

export function ReadingModeIcon({ kind = "ebook" }: { kind?: ReadingKind }) {
  return kind === "spreadsheet" ? <Rows3 size={17} /> : <Columns3 size={17} />;
}
