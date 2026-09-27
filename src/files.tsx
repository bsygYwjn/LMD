import React, { useCallback, useEffect, useState } from "react";
import { Download, File, FolderOpen, HardDrive, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { transferSize } from "./downloads";

type SharedFile = { id: string; libraryId: string; title: string; fileName: string; size: number; modifiedAt: string; folderId: string; downloadUrl: string };
type FileFolder = { id: string; parentId: string | null; title: string; name: string; mediaCount: number };
type FileCatalog = { items: SharedFile[]; folders: FileFolder[]; scan: { scanning: boolean; lastError?: string } };
type FileOverview = FileCatalog & { libraries: Array<{ id: string; name: string; path: string }> };
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: options?.body ? { "Content-Type": "application/json" } : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

export function FilesLibraryView({ folderId, search, onOpenFolder }: { folderId: string | null; search: string; onOpenFolder: (id: string | null) => void }) {
  const [catalog, setCatalog] = useState<FileCatalog | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => { void request<FileCatalog>("/api/files/catalog").then(value => { setCatalog(value); setError(""); }).catch(failure => setError(failure.message)); }, []);
  useEffect(() => { reload(); window.addEventListener("lmd:uploads-changed", reload); window.addEventListener("lmd:files-refresh", reload); return () => { window.removeEventListener("lmd:uploads-changed", reload); window.removeEventListener("lmd:files-refresh", reload); }; }, [reload]);
  if (!catalog) return <div className="empty-state">{error || "正在读取共享文件…"}</div>;
  const roots = catalog.folders.filter(folder => !folder.parentId);
  const current = catalog.folders.find(folder => folder.id === folderId) || (roots.length === 1 ? roots[0] : null);
  const query = search.trim().toLocaleLowerCase();
  const children = catalog.folders.filter(folder => folder.parentId === (current?.id || null) && (!query || `${folder.title} ${folder.name}`.toLocaleLowerCase().includes(query)));
  const items = catalog.items.filter(item => query ? item.fileName.toLocaleLowerCase().includes(query) : item.folderId === current?.id);
  const trail: FileFolder[] = []; const seen = new Set<string>(); let cursor = current;
  while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); trail.unshift(cursor); cursor = catalog.folders.find(folder => folder.id === cursor?.parentId) || null; }
  return <div className="files-view"><div className="lib-toolbar"><nav className="crumbs" aria-label="共享文件路径"><button onClick={() => onOpenFolder(null)}>其他文件</button>{trail.map(folder => <React.Fragment key={folder.id}><span>/</span><button aria-current={folder.id === current?.id ? "page" : undefined} onClick={() => onOpenFolder(folder.id)}>{folder.title}</button></React.Fragment>)}</nav><span className="lib-stats">{children.length} 个文件夹 · {items.length} 个文件</span></div>
    {error && <p className="transfer-error" role="alert">{error}</p>}
    <div className="files-folders">{children.map(folder => <button className="file-folder" key={folder.id} onClick={() => onOpenFolder(folder.id)}><FolderOpen size={22} /><span>{folder.title}</span><small>{folder.mediaCount} 个文件</small></button>)}</div>
    {items.length > 0 && <div className="files-list">{items.map(item => <div className="file-row" key={item.id}><File size={20} /><span className="file-name" title={item.fileName}>{item.fileName}</span><span>{transferSize(item.size)}</span><time dateTime={item.modifiedAt}>{new Date(item.modifiedAt).toLocaleString("zh-CN")}</time><a className="icon-btn" href={item.downloadUrl} download aria-label={`下载 ${item.fileName}`}><Download size={17} /></a></div>)}</div>}
    {!items.length && !children.length && <div className="empty-state"><FolderOpen size={26} /><strong>{query ? "没有匹配的文件" : roots.length ? "此文件夹为空" : "尚未配置其他文件共享目录"}</strong><span>{roots.length ? "有上传权限的用户可使用右上角上传或新建文件夹。" : "请管理员在本机管理端添加共享目录。"}</span></div>}
  </div>;
}

export function FilesAdminPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [overview, setOverview] = useState<FileOverview | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => { setOverview(await request<FileOverview>("/api/files/overview")); }, []);
  useEffect(() => { void reload().catch(failure => onNotice(failure.message)); }, [reload]);
  const mutate = async (url: string, options: RequestInit, message: string) => { setBusy(true); try { await request(url, options); await reload(); onNotice(message); } catch (failure) { onNotice(failure instanceof Error ? failure.message : "操作失败"); } finally { setBusy(false); } };
  const registerLibrary = async (selectedPath: string) => {
    await request("/api/files/libraries", { method: "POST", body: JSON.stringify({ folderPath: selectedPath }) });
    await reload();
    setFolderPath("");
    onNotice("共享目录已添加");
  };
  const addPath = async () => {
    if (busy || !folderPath.trim()) return;
    setBusy(true);
    try { await registerLibrary(folderPath.trim()); }
    catch (failure) { onNotice(failure instanceof Error ? failure.message : "添加共享目录失败"); }
    finally { setBusy(false); }
  };
  const chooseFolder = async () => {
    if (busy) return;
    setBusy(true);
    onNotice("请在弹出的 Windows 窗口中选择共享文件夹…");
    try {
      const result = await request<{ cancelled: boolean; path: string | null }>("/api/folders/select", { method: "POST" });
      if (result.cancelled || !result.path) { onNotice("已取消选择共享文件夹。"); return; }
      setFolderPath(result.path);
      await registerLibrary(result.path);
    } catch (failure) { onNotice(failure instanceof Error ? failure.message : "无法选择共享文件夹"); }
    finally { setBusy(false); }
  };
  return <section className="adm-section"><div className="adm-section-head"><div><h2>其他文件共享</h2><p>共享任意类型的原文件；移除共享目录不会删除磁盘文件。</p></div><button className="btn btn--sm" disabled={busy || !overview?.libraries.length} onClick={() => void mutate("/api/files/scan", { method: "POST" }, "其他文件列表已刷新")}><RefreshCw size={14} />刷新文件</button></div>
    <form className="files-add" onSubmit={event => { event.preventDefault(); void addPath(); }}>
      <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void chooseFolder()}>{busy ? <LoaderCircle size={14} className="spin" /> : <FolderOpen size={14} />}选择并添加文件夹</button>
      <input className="input" aria-label="其他文件共享目录" placeholder="也可以手动输入完整路径，按 Enter 添加" value={folderPath} disabled={busy} onChange={event => setFolderPath(event.target.value)} />
      <button type="submit" className="btn" disabled={busy || !folderPath.trim()}>添加路径</button>
    </form>
    <div className="files-admin-list">{overview?.libraries.map(library => <div className="file-row" key={library.id}><HardDrive size={19} /><span className="file-name"><strong>{library.name}</strong><small>{library.path}</small></span><button className="icon-btn" disabled={busy} aria-label={`移除共享 ${library.name}`} onClick={() => void mutate(`/api/files/libraries/${encodeURIComponent(library.id)}`, { method: "DELETE" }, "已移除共享，原文件已保留")}><Trash2 size={15} /></button></div>)}</div>
    {!overview?.libraries.length && <p className="muted">尚未配置目录。添加后才会在观看端显示共享文件。</p>}
  </section>;
}
