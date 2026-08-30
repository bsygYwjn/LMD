import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Image as ImageIcon,
  ImageOff,
  Images,
  LoaderCircle,
  Minus,
  MousePointer2,
  Plus,
  RefreshCw,
  Save,
  Square,
  Trash2,
  X,
} from "lucide-react";

export type PhotoScanStatus = {
  scanning: boolean;
  phase: string;
  progressPercent: number | null;
  processedFiles: number;
  totalFiles: number;
  lastError: string | null;
};

export type PhotoLibrary = { id: string; name: string; path: string };

export type PhotoItem = {
  id: string;
  libraryId: string;
  title: string;
  fileName: string;
  path?: string;
  extension: string;
  size: number;
  modifiedAt: string;
  width: number | null;
  height: number | null;
  capturedAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  aspectRatio: number | null;
  folderId: string;
  thumbnailUrl: string | null;
  thumbnailSrcSet: string | null;
  previewUrl: string | null;
  downloadUrl: string;
  previewAvailable: boolean;
};

export type PhotoFolder = {
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

export type PhotoCatalog = { items: PhotoItem[]; folders: PhotoFolder[]; scan: PhotoScanStatus };
export type PhotoOverview = { libraries: PhotoLibrary[]; items: PhotoItem[]; scanning: boolean; scan: PhotoScanStatus };

type WritablePhotoFile = {
  write: (data: Uint8Array | Blob) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};
type PhotoFileHandle = { createWritable: () => Promise<WritablePhotoFile> };
type PhotoDirectoryHandle = { getFileHandle: (name: string, options?: { create?: boolean }) => Promise<PhotoFileHandle> };
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite"; startIn?: string }) => Promise<PhotoDirectoryHandle>;
};

function formatBytes(value: number) {
  if (!value) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function greatestCommonDivisor(left: number, right: number) {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function formatAspectRatio(width: number | null, height: number | null) {
  if (!width || !height) return "—";
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function formatMegapixels(width: number | null, height: number | null) {
  if (!width || !height) return "—";
  return `${(width * height / 1_000_000).toFixed(1)} MP`;
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json", ...options.headers } : options?.headers,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result as T;
}

function splitFileName(fileName: string) {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return { stem: fileName, extension: "" };
  return { stem: fileName.slice(0, lastDot), extension: fileName.slice(lastDot) };
}

async function uniqueFileHandle(directory: PhotoDirectoryHandle, fileName: string) {
  const { stem, extension } = splitFileName(fileName);
  for (let index = 0; index < 10000; index += 1) {
    const candidate = index ? `${stem} (${index})${extension}` : fileName;
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error instanceof DOMException && error.name !== "NotFoundError") throw error;
      return directory.getFileHandle(candidate, { create: true });
    }
  }
  throw new Error(`无法为“${fileName}”生成不重复的文件名。`);
}

async function writeResponseToFile(response: Response, writable: WritablePhotoFile) {
  if (!response.body) {
    await writable.write(await response.blob());
    await writable.close();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
    }
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function fallbackDownloads(items: PhotoItem[]) {
  for (const item of items) {
    const anchor = document.createElement("a");
    anchor.href = item.downloadUrl;
    anchor.download = item.fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
}

function PhotoViewer({ item, folderName, previous, next, onSelectPhoto }: {
  item: PhotoItem;
  folderName: string;
  previous: PhotoItem | null;
  next: PhotoItem | null;
  onSelectPhoto: (item: PhotoItem) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState(false);

  const changeZoom = (nextZoom: number) => {
    const bounded = Math.min(8, Math.max(0.25, Math.round(nextZoom * 100) / 100));
    setZoom(bounded);
    if (bounded <= 1) setOffset({ x: 0, y: 0 });
  };

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setImageError(false);
    pointersRef.current.clear();
  }, [item.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a")) return;
      if (event.key === "ArrowLeft" && previous) onSelectPhoto(previous);
      else if (event.key === "ArrowRight" && next) onSelectPhoto(next);
      else if (event.key === "+" || event.key === "=") changeZoom(zoom + (zoom < 2 ? 0.25 : 0.5));
      else if (event.key === "-") changeZoom(zoom - (zoom <= 2 ? 0.25 : 0.5));
      else if (event.key === "0") changeZoom(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [next, previous, zoom]);

  const pointerDistance = () => {
    const points = [...pointersRef.current.values()];
    return points.length >= 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
  };

  const orientation = item.width && item.height
    ? item.width === item.height ? "正方形" : item.width > item.height ? "横向" : "纵向"
    : "—";
  const latitude = typeof item.latitude === "number" && Number.isFinite(item.latitude) ? item.latitude : null;
  const longitude = typeof item.longitude === "number" && Number.isFinite(item.longitude) ? item.longitude : null;
  const altitude = typeof item.altitude === "number" && Number.isFinite(item.altitude) ? item.altitude : null;

  return (
    <section className="photo-viewer-page" aria-label={`正在查看 ${item.title}`}>
      <header className="photo-viewer-toolbar">
        <div className="photo-viewer-actions">
          <button type="button" onClick={() => previous && onSelectPhoto(previous)} disabled={!previous} title="上一张（方向键左）"><ChevronLeft size={18} /></button>
          <button type="button" onClick={() => next && onSelectPhoto(next)} disabled={!next} title="下一张（方向键右）"><ChevronRight size={18} /></button>
        </div>
        <div className="photo-viewer-actions">
          <span className="photo-viewer-divider" />
          <button type="button" onClick={() => changeZoom(zoom - (zoom <= 2 ? 0.25 : 0.5))} title="缩小"><Minus size={18} /></button>
          <button type="button" className="photo-zoom-value" onClick={() => changeZoom(1)} title="恢复适应窗口">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => changeZoom(zoom + (zoom < 2 ? 0.25 : 0.5))} title="放大"><Plus size={18} /></button>
          <a href={item.downloadUrl} download={item.fileName} title="下载原图"><Download size={18} /><span>原图</span></a>
        </div>
      </header>
      <div className="photo-viewer-layout">
        <div
          ref={viewportRef}
          className={`photo-viewer-canvas${dragging ? " is-dragging" : ""}`}
          onWheel={(event) => { event.preventDefault(); changeZoom(zoom + (event.deltaY < 0 ? 0.15 : -0.15)); }}
          onDoubleClick={() => changeZoom(zoom === 1 ? 2 : 1)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pointersRef.current.size === 2) pinchRef.current = { distance: pointerDistance(), zoom };
            else if (zoom > 1) {
              dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
              setDragging(true);
            }
          }}
          onPointerMove={(event) => {
            if (!pointersRef.current.has(event.pointerId)) return;
            pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pointersRef.current.size >= 2 && pinchRef.current) {
              const distance = pointerDistance();
              if (pinchRef.current.distance) changeZoom(pinchRef.current.zoom * distance / pinchRef.current.distance);
            } else if (dragRef.current && zoom > 1) {
              setOffset({
                x: dragRef.current.offsetX + event.clientX - dragRef.current.x,
                y: dragRef.current.offsetY + event.clientY - dragRef.current.y,
              });
            }
          }}
          onPointerUp={(event) => {
            pointersRef.current.delete(event.pointerId);
            if (pointersRef.current.size < 2) pinchRef.current = null;
            if (!pointersRef.current.size) { dragRef.current = null; setDragging(false); }
          }}
          onPointerCancel={(event) => {
            pointersRef.current.delete(event.pointerId);
            pinchRef.current = null;
            dragRef.current = null;
            setDragging(false);
          }}
        >
          {item.previewUrl && !imageError
            ? <img className="photo-viewer-image" src={item.previewUrl} alt={item.title} draggable={false} onError={() => setImageError(true)} style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }} />
            : <div className="photo-preview-unavailable"><ImageOff size={44} /><strong>这张图片暂时无法在线预览</strong><span>{item.extension === "TIF" || item.extension === "TIFF" ? "安装 FFmpeg 并重新扫描后可生成 TIFF 兼容预览。" : "浏览器无法解码此文件，但原图仍可安全下载。"}</span><a href={item.downloadUrl} download={item.fileName}><Download size={17} />下载原图</a></div>}
          {item.previewUrl && !imageError && zoom === 1 && <div className="photo-gesture-hint"><MousePointer2 size={14} />滚轮、双击或双指缩放</div>}
        </div>
        <aside className="photo-viewer-details" aria-label="照片详细信息">
          <header>
            <span>照片信息</span>
            <h1>{item.title}</h1>
            <p>{folderName}</p>
          </header>
          <section>
            <h2>图像</h2>
            <dl>
              <div><dt>尺寸</dt><dd>{item.width && item.height ? `${item.width} × ${item.height}` : "—"}</dd></div>
              <div><dt>像素</dt><dd>{formatMegapixels(item.width, item.height)}</dd></div>
              <div><dt>宽高比</dt><dd>{formatAspectRatio(item.width, item.height)}</dd></div>
              <div><dt>方向</dt><dd>{orientation}</dd></div>
              <div><dt>拍摄时间</dt><dd>{item.capturedAt ? item.capturedAt.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3") : "—"}</dd></div>
              <div><dt>GPS 坐标</dt><dd>{latitude !== null && longitude !== null ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : "—"}</dd></div>
              {altitude !== null && <div><dt>海拔</dt><dd>{altitude.toFixed(1)} m</dd></div>}
            </dl>
          </section>
          <section>
            <h2>文件元数据</h2>
            <dl>
              <div><dt>文件名</dt><dd title={item.fileName}>{item.fileName}</dd></div>
              <div><dt>格式</dt><dd>{item.extension}</dd></div>
              <div><dt>文件大小</dt><dd>{formatBytes(item.size)}</dd></div>
              <div><dt>修改时间</dt><dd>{formatDateTime(item.modifiedAt)}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </section>
  );
}

function PhotoFolderCard({ folder, cover, onOpen }: { folder: PhotoFolder; cover: PhotoItem | null; onOpen: () => void }) {
  return (
    <button type="button" className="photo-folder-card" onClick={onOpen} aria-label={`打开图片文件夹 ${folder.title}`}>
      <span className="photo-folder-cover">
        {cover?.thumbnailUrl ? <img src={cover.thumbnailUrl} srcSet={cover.thumbnailSrcSet || undefined} sizes="240px" alt="" loading="lazy" decoding="async" /> : <Images size={34} />}
        <span><FolderOpen size={15} />文件夹</span>
      </span>
      <strong>{folder.title}</strong>
      <small>{folder.childCount ? `${folder.childCount} 个子文件夹 · ` : ""}{folder.mediaCount} 张图片</small>
    </button>
  );
}

function PhotoCard({ item, selecting, selected, onOpen, onToggle }: {
  item: PhotoItem;
  selecting: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={`photo-card${selected ? " is-selected" : ""}`} onClick={selecting ? onToggle : onOpen} aria-label={selecting ? `${selected ? "取消选择" : "选择"} ${item.title}` : `查看 ${item.title}`} aria-pressed={selecting ? selected : undefined}>
      {item.thumbnailUrl ? <img src={item.thumbnailUrl} srcSet={item.thumbnailSrcSet || undefined} sizes="(max-width: 680px) 33vw, 160px" alt={item.title} loading="lazy" decoding="async" /> : <span className="photo-card-unavailable"><ImageOff size={28} />无预览</span>}
      {selecting && <span className="photo-select-mark">{selected ? <Check size={16} /> : <Square size={16} />}</span>}
    </button>
  );
}

export function PhotoLibraryView({ catalog, folderId, photoId, search, onOpenFolder, onOpenPhoto, onSwitchPhoto, onBackToLibrary, onNotice }: {
  catalog: PhotoCatalog;
  folderId: string | null;
  photoId: string | null;
  search: string;
  onOpenFolder: (folderId: string) => void;
  onOpenPhoto: (item: PhotoItem) => void;
  onSwitchPhoto: (item: PhotoItem) => void;
  onBackToLibrary: () => void;
  onNotice: (message: string) => void;
}) {
  const folderById = useMemo(() => new Map(catalog.folders.map((folder) => [folder.id, folder])), [catalog.folders]);
  const itemById = useMemo(() => new Map(catalog.items.map((item) => [item.id, item])), [catalog.items]);
  const currentFolder = folderById.get(folderId || "") || null;
  const selectedPhoto = itemById.get(photoId || "") || null;
  const normalizedSearch = search.trim().toLocaleLowerCase("zh-CN");
  const matchingItems = useMemo(() => catalog.items.filter((item) => !normalizedSearch || `${item.title} ${item.fileName} ${item.extension}`.toLocaleLowerCase("zh-CN").includes(normalizedSearch)), [catalog.items, normalizedSearch]);
  const folderHasVisibleItems = (folder: PhotoFolder) => matchingItems.some((item) => {
    let candidate = folderById.get(item.folderId) || null;
    const visited = new Set<string>();
    while (candidate && !visited.has(candidate.id)) {
      if (candidate.id === folder.id) return true;
      visited.add(candidate.id);
      candidate = candidate.parentId ? folderById.get(candidate.parentId) || null : null;
    }
    return false;
  });
  const folders = catalog.folders
    .filter((folder) => folder.parentId === currentFolder?.id || (!currentFolder && folder.parentId === null))
    .filter((folder) => !normalizedSearch || folderHasVisibleItems(folder))
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true, sensitivity: "base" }));
  const directItems = matchingItems
    .filter((item) => currentFolder ? item.folderId === currentFolder.id : false)
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" }));
  const folderItems = useMemo(() => catalog.items
    .filter((item) => selectedPhoto && item.folderId === selectedPhoto.folderId)
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "zh-CN", { numeric: true, sensitivity: "base" })), [catalog.items, selectedPhoto]);
  const selectedIndex = selectedPhoto ? folderItems.findIndex((item) => item.id === selectedPhoto.id) : -1;
  const trail: PhotoFolder[] = [];
  let cursor = currentFolder;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    trail.unshift(cursor);
    visited.add(cursor.id);
    cursor = cursor.parentId ? folderById.get(cursor.parentId) || null : null;
  }

  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [renderLimit, setRenderLimit] = useState(80);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ completed: 0, total: 0, failed: 0 });
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelecting(false);
    setSelectedIds(new Set());
    setRenderLimit(80);
  }, [currentFolder?.id, normalizedSearch]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || renderLimit >= directItems.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setRenderLimit((value) => Math.min(directItems.length, value + 80));
    }, { rootMargin: "500px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [directItems.length, renderLimit]);

  if (selectedPhoto) {
    return <PhotoViewer item={selectedPhoto} folderName={folderById.get(selectedPhoto.folderId)?.title || "图片库"} previous={selectedIndex > 0 ? folderItems[selectedIndex - 1] : null} next={selectedIndex >= 0 ? folderItems[selectedIndex + 1] || null : null} onSelectPhoto={onSwitchPhoto} />;
  }

  const selectedItems = directItems.filter((item) => selectedIds.has(item.id));
  const clearSelection = () => { setSelecting(false); setSelectedIds(new Set()); setSaveProgress({ completed: 0, total: 0, failed: 0 }); };
  const toggleItem = (item: PhotoItem) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
    return next;
  });
  const saveSelected = async () => {
    if (!selectedItems.length || saving) return;
    const pickerWindow = window as DirectoryPickerWindow;
    const canPickDirectory = window.isSecureContext && typeof pickerWindow.showDirectoryPicker === "function";
    if (!canPickDirectory) {
      fallbackDownloads(selectedItems);
      onNotice(`已发起 ${selectedItems.length} 个原图下载；如果浏览器只下载一张，请允许此站点连续下载多个文件。`);
      return;
    }
    setSaving(true);
    setSaveProgress({ completed: 0, total: selectedItems.length, failed: 0 });
    try {
      const directory = await pickerWindow.showDirectoryPicker!({ id: "lmd-photo-downloads", mode: "readwrite", startIn: "downloads" });
      let failed = 0;
      for (const [index, item] of selectedItems.entries()) {
        try {
          const response = await fetch(item.downloadUrl);
          if (!response.ok) throw new Error(`下载 ${item.fileName} 失败`);
          const handle = await uniqueFileHandle(directory, item.fileName);
          await writeResponseToFile(response, await handle.createWritable());
        } catch {
          failed += 1;
        }
        setSaveProgress({ completed: index + 1, total: selectedItems.length, failed });
      }
      onNotice(failed ? `已保存 ${selectedItems.length - failed} 张原图，${failed} 张失败。` : `已将 ${selectedItems.length} 张原图保存到所选目录。`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) onNotice(error instanceof Error ? error.message : "无法保存所选图片");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="photo-hero">
        <div>
          <span className="section-kicker">PHOTO LIBRARY</span>
          {currentFolder && <nav className="folder-breadcrumb" aria-label="当前图片文件夹路径"><button type="button" onClick={onBackToLibrary}>全部图片</button>{trail.map((folder) => <React.Fragment key={folder.id}><span>/</span><button type="button" onClick={() => onOpenFolder(folder.id)} aria-current={folder.id === currentFolder.id ? "page" : undefined}>{folder.title}</button></React.Fragment>)}</nav>}
          <h1>{currentFolder?.title || "图片库"}</h1>
          <p>{currentFolder ? `本层包含 ${folders.length} 个子文件夹和 ${directItems.length} 张图片。` : "按原文件夹层级浏览本地图片，原图始终保留在磁盘原位。"}</p>
        </div>
        <div className="photo-hero-actions">
          {currentFolder && directItems.length > 0 && <button type="button" className={selecting ? "active" : ""} onClick={() => selecting ? clearSelection() : setSelecting(true)}>{selecting ? <X size={17} /> : <CheckSquare2 size={17} />}{selecting ? "取消选择" : "选择图片"}</button>}
          <span><strong>{currentFolder ? directItems.length : catalog.items.length}</strong><small>{currentFolder ? "张本层图片" : "张图片"}</small></span>
        </div>
      </section>

      {folders.length > 0 && <section className="photo-folder-section"><div className="section-heading"><div><span className="section-kicker">FOLDERS</span><h2>{currentFolder ? "子文件夹" : "图片目录"}</h2></div><span className="media-count">{folders.length} 个文件夹</span></div><div className="photo-folder-grid">{folders.map((folder) => <PhotoFolderCard key={folder.id} folder={folder} cover={folder.coverMediaId ? itemById.get(folder.coverMediaId) || null : null} onOpen={() => onOpenFolder(folder.id)} />)}</div></section>}

      {currentFolder && <section className="photo-gallery-section">
        <div className="section-heading"><div><span className="section-kicker">PHOTOS</span><h2>{normalizedSearch ? "搜索结果" : "本层图片"}</h2></div><span className="media-count">{directItems.length} 张</span></div>
        <div className="photo-waterfall">{directItems.slice(0, renderLimit).map((item) => <PhotoCard key={item.id} item={item} selecting={selecting} selected={selectedIds.has(item.id)} onOpen={() => onOpenPhoto(item)} onToggle={() => toggleItem(item)} />)}</div>
        <div className="photo-load-sentinel" ref={loadMoreRef}>{renderLimit < directItems.length ? <><LoaderCircle size={16} className="spin" />正在加载更多图片…</> : null}</div>
      </section>}

      {!folders.length && !directItems.length && <div className="client-empty photo-empty"><Images size={32} /><strong>{normalizedSearch ? "没有匹配的图片" : currentFolder ? "这个图片文件夹暂时为空" : "图片库暂时为空"}</strong><span>{normalizedSearch ? "请尝试其他文件名或扩展名。" : "请在本机管理端添加图片目录并扫描。"}</span></div>}

      {selecting && <div className="photo-selection-bar" role="region" aria-label="图片选择操作">
        <div><span className="photo-selection-icon">{selectedIds.size ? <Check size={18} /> : <Square size={18} />}</span><strong>已选择 {selectedIds.size} 张</strong>{saving && <small>正在保存 {saveProgress.completed}/{saveProgress.total}{saveProgress.failed ? ` · ${saveProgress.failed} 张失败` : ""}</small>}</div>
        <div><button type="button" onClick={() => setSelectedIds(new Set(directItems.map((item) => item.id)))} disabled={saving || selectedIds.size === directItems.length}><CheckSquare2 size={16} />全选当前结果</button><button type="button" className="primary" onClick={() => void saveSelected()} disabled={saving || !selectedIds.size}>{saving ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{saving ? "正在保存" : "保存所选原图"}</button></div>
      </div>}
    </>
  );
}

export function PhotoAdminPanel({ overview, onRefresh, onNotice }: {
  overview: PhotoOverview | null;
  onRefresh: (quiet?: boolean) => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [folderPath, setFolderPath] = useState("");
  const [busy, setBusy] = useState(false);
  const register = async (selectedPath: string) => {
    const result = await requestJson<{ library: PhotoLibrary; added: boolean }>("/api/photos/libraries", { method: "POST", body: JSON.stringify({ folderPath: selectedPath }) });
    setFolderPath("");
    await onRefresh(true);
    onNotice(result.added ? `已添加图片目录：${result.library.path}。` : `图片目录“${result.library.name}”已经存在。`);
  };
  const chooseFolder = async () => {
    setBusy(true);
    onNotice("请在弹出的 Windows 窗口中选择图片文件夹…");
    try {
      const result = await requestJson<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (!result.cancelled && result.path) await register(result.path);
      else onNotice("已取消选择图片文件夹。");
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法选择图片文件夹"); }
    finally { setBusy(false); }
  };
  const scan = async () => {
    setBusy(true);
    onNotice("正在扫描图片尺寸并生成瀑布流缩略图；原图不会被修改…");
    try {
      const result = await requestJson<{ count: number }>("/api/photos/catalog/scan?mode=turbo", { method: "POST" });
      onNotice(`图片扫描完成，共发现 ${result.count} 张图片。`);
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "图片扫描失败"); }
    finally { setBusy(false); }
  };
  const stopScan = async () => {
    setBusy(true);
    try {
      await requestJson("/api/photos/scan/stop", { method: "POST" });
      onNotice("已请求停止图片扫描；正在处理的当前文件结束后会安全退出，旧索引继续保留。");
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法停止图片扫描"); }
    finally { setBusy(false); }
  };
  const remove = async (library: PhotoLibrary) => {
    if (!window.confirm(`确定从 LMD 中移除图片目录“${library.name}”吗？\n\n只移除索引和图片预览缓存，不会删除硬盘中的任何原图。`)) return;
    setBusy(true);
    try {
      const result = await requestJson<{ removedItemCount: number }>(`/api/photos/libraries/${encodeURIComponent(library.id)}`, { method: "DELETE" });
      onNotice(`已移除图片目录“${library.name}”及 ${result.removedItemCount} 条索引；原图未被删除。`);
      await onRefresh(true);
    } catch (error) { onNotice(error instanceof Error ? error.message : "无法移除图片目录"); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel library-panel photo-admin-panel">
      <div className="panel-title"><div><span className="panel-icon"><Images size={20} /></span><div><h2>图片目录</h2><p>按原文件夹层级建立瀑布流图库；仅生成预览缓存，不移动、不修改原图。</p></div></div><div className="panel-actions"><span className="table-count">{overview?.items.length || 0} 张图片</span>{overview?.scanning ? <button className="secondary-button" onClick={() => void stopScan()} disabled={busy}><X size={16} />停止扫描</button> : <button className="secondary-button" onClick={() => void scan()} disabled={busy || !overview?.libraries.length}><RefreshCw size={16} className={busy ? "spin" : ""} />扫描图片</button>}</div></div>
      {overview?.scanning && <div className="photo-admin-progress"><div><span style={{ width: `${overview.scan.progressPercent || 0}%` }} /></div><small>正在处理 {overview.scan.processedFiles}/{overview.scan.totalFiles || "…"}</small></div>}
      <div className="folder-form"><button className="secondary-button folder-picker-button" onClick={() => void chooseFolder()} disabled={busy}><FolderOpen size={17} />选择并添加图片文件夹</button><input aria-label="图片目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && folderPath.trim() && !busy) void register(folderPath.trim()); }} placeholder="也可以手动输入路径，按 Enter 添加" /></div>
      <div className="folder-list">{overview?.libraries.length ? overview.libraries.map((library) => <div className="folder-item" key={library.id}><ImageIcon size={18} /><div><strong>{library.name}</strong><span>{library.path}</span></div><button type="button" className="folder-remove-button" onClick={() => void remove(library)} disabled={busy} title={`移除图片目录 ${library.name}`}><Trash2 size={16} /></button></div>) : <div className="empty-row"><Images size={22} /><span>还没有图片目录。添加后即可浏览瀑布流图库。</span></div>}</div>
    </section>
  );
}
