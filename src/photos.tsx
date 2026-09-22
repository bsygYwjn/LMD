import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  HardDrive,
  ImageOff,
  Images,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
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

function PhotoViewer({ item, folderName, index, total, previous, next, onSelectPhoto, onClose }: {
  item: PhotoItem;
  folderName: string;
  index: number;
  total: number;
  previous: PhotoItem | null;
  next: PhotoItem | null;
  onSelectPhoto: (item: PhotoItem) => void;
  onClose: () => void;
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
    <div className="pviewer" aria-label={`正在查看 ${item.title}`}>
      <div className="pviewer-bar">
        <div className="pviewer-title"><strong>{item.title}</strong><span>{index + 1} / {total}</span></div>
        <div className="pviewer-actions">
          <button type="button" className="icon-btn" onClick={() => previous && onSelectPhoto(previous)} disabled={!previous} aria-label="上一张" title="上一张（方向键左）"><ChevronLeft size={16} /></button>
          <button type="button" className="icon-btn" onClick={() => next && onSelectPhoto(next)} disabled={!next} aria-label="下一张" title="下一张（方向键右）"><ChevronRight size={16} /></button>
          <span className="pviewer-zoom">
            <button type="button" className="icon-btn" onClick={() => changeZoom(zoom - (zoom <= 2 ? 0.25 : 0.5))} aria-label="缩小" title="缩小"><ZoomOut size={15} /></button>
            <button type="button" className="pviewer-zoom-value" onClick={() => changeZoom(1)} title="重置缩放">{Math.round(zoom * 100)}%</button>
            <button type="button" className="icon-btn" onClick={() => changeZoom(zoom + (zoom < 2 ? 0.25 : 0.5))} aria-label="放大" title="放大"><ZoomIn size={15} /></button>
          </span>
          <a className="icon-btn" href={item.downloadUrl} download={item.fileName} aria-label="下载原图" title="下载原图"><Download size={15} /></a>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭查看器" title="关闭查看器"><X size={16} /></button>
        </div>
      </div>
      <div className="pviewer-body">
        <div
          ref={viewportRef}
          className={`pviewer-stage${dragging ? " is-dragging" : ""}`}
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
            ? <img className="pviewer-image" key={item.id} src={item.previewUrl} alt={item.title} draggable={false} onError={() => setImageError(true)} style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }} />
            : <div className="empty-state pviewer-empty"><ImageOff size={32} /><strong>这张图片暂时无法在线预览</strong><span>{item.extension === "TIF" || item.extension === "TIFF" ? "安装 FFmpeg 并重新扫描后可生成 TIFF 兼容预览。" : "浏览器无法解码此文件，但原图仍可安全下载。"}</span><a className="btn btn--sm" href={item.downloadUrl} download={item.fileName}><Download size={14} />下载原图</a></div>}
        </div>
        <aside className="pviewer-info" aria-label="照片详细信息">
          <h3>照片信息</h3>
          <dl>
            <div className="pinfo-row"><dt>所在文件夹</dt><dd>{folderName}</dd></div>
            <div className="pinfo-row"><dt>尺寸</dt><dd>{item.width && item.height ? `${item.width} × ${item.height}` : "—"}</dd></div>
            <div className="pinfo-row"><dt>像素</dt><dd>{formatMegapixels(item.width, item.height)}</dd></div>
            <div className="pinfo-row"><dt>宽高比</dt><dd>{formatAspectRatio(item.width, item.height)}</dd></div>
            <div className="pinfo-row"><dt>方向</dt><dd>{orientation}</dd></div>
            <div className="pinfo-row"><dt>拍摄时间</dt><dd>{item.capturedAt ? item.capturedAt.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3") : "—"}</dd></div>
            <div className="pinfo-row"><dt>GPS 坐标</dt><dd>{latitude !== null && longitude !== null ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : "—"}</dd></div>
            {altitude !== null && <div className="pinfo-row"><dt>海拔</dt><dd>{altitude.toFixed(1)} m</dd></div>}
            <div className="pinfo-row"><dt>文件名</dt><dd title={item.fileName}>{item.fileName}</dd></div>
            <div className="pinfo-row"><dt>格式</dt><dd>{item.extension}</dd></div>
            <div className="pinfo-row"><dt>文件大小</dt><dd>{formatBytes(item.size)}</dd></div>
            <div className="pinfo-row"><dt>修改时间</dt><dd>{formatDateTime(item.modifiedAt)}</dd></div>
          </dl>
          <a className="btn btn--sm pviewer-download" href={item.downloadUrl} download={item.fileName}><Download size={14} />下载原图</a>
        </aside>
      </div>
    </div>
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
    <div className={`ph-item${selected ? " is-selected" : ""}`}>
      <button type="button" className="ph-hit" onClick={selecting ? onToggle : onOpen} aria-label={selecting ? `${selected ? "取消选择" : "选择"} ${item.title}` : `查看 ${item.title}`} aria-pressed={selecting ? selected : undefined} />
      {item.thumbnailUrl ? <img className="ph-img" src={item.thumbnailUrl} srcSet={item.thumbnailSrcSet || undefined} sizes="(max-width: 680px) 33vw, 160px" alt={item.title} loading="lazy" decoding="async" /> : <span className="ph-unavailable"><ImageOff size={22} />无预览</span>}
      {selecting && <span className="ph-check">{selected && <Check size={13} />}</span>}
    </div>
  );
}

const photoCoverSessionSeed = Math.floor(Math.random() * 0x7fffffff);

function photoCoverScore(folderId: string, itemId: string) {
  let value = photoCoverSessionSeed;
  const source = `${folderId}:${itemId}`;
  for (let index = 0; index < source.length; index += 1) value = Math.imul(value ^ source.charCodeAt(index), 16777619);
  return value >>> 0;
}

function PhotoFolderCard({ folder, items, onOpen }: { folder: PhotoFolder; items: PhotoItem[]; onOpen: () => void }) {
  const candidates = useMemo(() => [...items]
    .filter((item) => item.thumbnailUrl)
    .sort((left, right) => photoCoverScore(folder.id, left.id) - photoCoverScore(folder.id, right.id))
    .slice(0, 6), [folder.id, items]);
  const candidateKey = candidates.map((item) => item.id).join(":");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
    if (candidates.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = 4800 + (photoCoverScore(folder.id, folder.id) % 1200);
    const timer = window.setInterval(() => {
      if (!document.hidden) setActiveIndex((value) => (value + 1) % candidates.length);
    }, interval);
    return () => window.clearInterval(timer);
  }, [candidateKey, candidates.length, folder.id]);

  return (
    <article className="ph-folder-card">
      <button type="button" className="ph-folder-hit" onClick={onOpen} aria-label={`打开图片文件夹 ${folder.title}`} />
      <div className="ph-folder-cover">
        {candidates.map((item, index) => <img
          key={item.id}
          className={`ph-folder-image${index === activeIndex ? " is-active" : ""}`}
          src={item.thumbnailUrl || ""}
          alt=""
          loading="lazy"
          decoding="async"
          aria-hidden="true"
        />)}
        {!candidates.length && <span className="ph-folder-empty"><Images size={30} />暂无缩略图</span>}
        <span className="tag ph-folder-badge">文件夹</span>
        <span className="ph-folder-count">{folder.mediaCount} 张</span>
      </div>
      <h3 className="ph-folder-title">{folder.title}</h3>
      <p className="ph-folder-meta">{folder.childCount ? `${folder.childCount} 个子文件夹 · ${folder.mediaCount} 张图片` : `${folder.directMediaCount} 张图片`}</p>
    </article>
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
  const folderItemsById = useMemo(() => {
    const itemsByFolder = new Map<string, PhotoItem[]>();
    for (const item of catalog.items) {
      let folder = folderById.get(item.folderId) || null;
      const visitedFolders = new Set<string>();
      while (folder && !visitedFolders.has(folder.id)) {
        const folderItems = itemsByFolder.get(folder.id) || [];
        folderItems.push(item);
        itemsByFolder.set(folder.id, folderItems);
        visitedFolders.add(folder.id);
        folder = folder.parentId ? folderById.get(folder.parentId) || null : null;
      }
    }
    return itemsByFolder;
  }, [catalog.items, folderById]);
  const rootFolders = catalog.folders.filter((folder) => folder.parentId === null);
  const singleRootFolder = rootFolders.length === 1 ? rootFolders[0] : null;
  const currentFolder = folderById.get(folderId || "") || singleRootFolder;
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
  const visibleTrail = singleRootFolder ? trail.filter((folder) => folder.id !== singleRootFolder.id) : trail;
  const atLibraryRoot = !folderId || folderId === singleRootFolder?.id;

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
    if (selectedPhoto || !node || renderLimit >= directItems.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setRenderLimit((value) => Math.min(directItems.length, value + 80));
    }, { rootMargin: "500px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [directItems.length, renderLimit, selectedPhoto?.id]);

  if (selectedPhoto) {
    return <PhotoViewer item={selectedPhoto} folderName={folderById.get(selectedPhoto.folderId)?.title || "图片库"} index={Math.max(selectedIndex, 0)} total={folderItems.length} previous={selectedIndex > 0 ? folderItems[selectedIndex - 1] : null} next={selectedIndex >= 0 ? folderItems[selectedIndex + 1] || null : null} onSelectPhoto={onSwitchPhoto} onClose={onBackToLibrary} />;
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
    <div className="ph-view">
      <div className="lib-toolbar">
        <nav className="crumbs" aria-label="当前图片文件夹路径">
          {!atLibraryRoot && currentFolder
            ? <>
                <button type="button" onClick={onBackToLibrary}>全部图片</button>
                {visibleTrail.map((folder) => <React.Fragment key={folder.id}><span className="crumbs-sep">/</span><button type="button" onClick={() => onOpenFolder(folder.id)} aria-current={folder.id === currentFolder.id ? "page" : undefined}>{folder.title}</button></React.Fragment>)}
              </>
            : <span aria-current="page">全部图片</span>}
        </nav>
        <span className="lib-stats">{folders.length} 个文件夹 · {currentFolder ? directItems.length : matchingItems.length} 张图片</span>
        <div className="lib-toolbar-actions">
          {currentFolder && directItems.length > 0 && <button type="button" className="btn btn--sm" onClick={() => selecting ? clearSelection() : setSelecting(true)}>{selecting ? "取消" : "选择"}</button>}
        </div>
      </div>

      {folders.length > 0 && <div className="ph-folders">
        {folders.map((folder) => <PhotoFolderCard key={folder.id} folder={folder} items={folderItemsById.get(folder.id) || []} onOpen={() => onOpenFolder(folder.id)} />)}
      </div>}

      {currentFolder && <div className="ph-grid">
        {directItems.slice(0, renderLimit).map((item) => <PhotoCard key={item.id} item={item} selecting={selecting} selected={selectedIds.has(item.id)} onOpen={() => onOpenPhoto(item)} onToggle={() => toggleItem(item)} />)}
        <div className="ph-sentinel" ref={loadMoreRef}>{renderLimit < directItems.length ? <span className="ph-loading"><LoaderCircle size={14} className="spin" />正在加载更多图片…</span> : null}</div>
      </div>}

      {!folders.length && !directItems.length && <div className="empty-state"><Images size={28} /><strong>{normalizedSearch ? "没有匹配的图片" : !atLibraryRoot && currentFolder ? "这个图片文件夹暂时为空" : "图片库暂时为空"}</strong><span>{normalizedSearch ? "请尝试其他文件名或扩展名。" : "请在本机管理端添加图片目录并扫描。"}</span></div>}

      {selecting && <div className="ph-selection-bar" role="region" aria-label="图片选择操作">
        <span className="ph-selection-count">已选 {selectedIds.size} 张{saving ? ` · 正在保存 ${saveProgress.completed}/${saveProgress.total}${saveProgress.failed ? ` · ${saveProgress.failed} 张失败` : ""}` : ""}</span>
        <button type="button" className="btn btn--sm" onClick={() => setSelectedIds(new Set(directItems.map((item) => item.id)))} disabled={saving || selectedIds.size === directItems.length}>全选当前结果</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveSelected()} disabled={saving || !selectedIds.size}>{saving ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{saving ? "正在保存" : "保存所选原图"}</button>
      </div>}
    </div>
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
    <section className="adm-section">
      <div className="adm-section-head">
        <div><h2>图片目录</h2><p>按原文件夹层级建立图库；仅生成预览缓存，不移动、不修改原图。</p></div>
        <div className="adm-actions">
          <span className="tag">{overview?.items.length || 0} 张图片</span>
          {overview?.scanning
            ? <button type="button" className="btn btn--sm" onClick={() => void stopScan()} disabled={busy}><X size={14} />停止扫描</button>
            : <button type="button" className="btn btn--sm" onClick={() => void scan()} disabled={busy || !overview?.libraries.length}><RefreshCw size={14} className={busy ? "spin" : ""} />扫描图片</button>}
        </div>
      </div>
      {overview?.scanning && <div className="adm-progress"><div className="adm-progress-track"><span style={{ width: `${overview.scan.progressPercent || 0}%` }} /></div><span className="adm-progress-label">正在处理 {overview.scan.processedFiles}/{overview.scan.totalFiles || "…"}</span></div>}
      <div className="adm-add">
        <button type="button" className="btn btn--sm" onClick={() => void chooseFolder()} disabled={busy}><FolderOpen size={14} />选择文件夹</button>
        <input className="input" aria-label="图片目录路径" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && folderPath.trim() && !busy) void register(folderPath.trim()); }} placeholder="也可以手动输入路径，按 Enter 添加" />
      </div>
      <div className="adm-rows">
        {overview?.libraries.length ? overview.libraries.map((library) => <div className="adm-row" key={library.id}>
          <HardDrive size={15} />
          <div className="adm-row-main"><strong>{library.name}</strong><span>{library.path}</span></div>
          <span className="adm-row-meta">{overview.items.filter((item) => item.libraryId === library.id).length} 张</span>
          <button type="button" className="icon-btn icon-btn--danger" onClick={() => void remove(library)} disabled={busy} aria-label={`移除图片目录 ${library.name}`} title={`移除图片目录 ${library.name}`}><Trash2 size={15} /></button>
        </div>) : <div className="empty-state"><Images size={24} /><strong>还没有图片目录</strong><span>添加文件夹并扫描后即可浏览图库。</span></div>}
      </div>
    </section>
  );
}
