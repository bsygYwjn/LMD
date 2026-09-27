import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { FolderPlus, LoaderCircle, Pause, Play, Upload, X } from "lucide-react";
import { transferSize } from "./downloads";
import { uploadGroupKeys } from "./upload-groups";

export type UploadKind = "video" | "music" | "reading" | "photos" | "files";
type Identity = { enabled: boolean; authenticated: boolean; localAdmin: boolean; canUpload?: boolean; user: { id: string; canUpload?: boolean } | null };
type Target = { id: string; kind: UploadKind; label: string; libraryId: string; folderId?: string; parentId?: string | null; relativePath?: string; writable?: boolean };
type Task = { id: string; kind: UploadKind; targetId: string; relativePath: string; size: number; lastModified: number; receivedBytes: number; chunks: Array<{ offset: number; size: number; sha256: string }>; status: string; error?: string; errorCode?: string; groupId?: string };
type Phase = "queued" | "hashing" | "transferring" | "paused" | "needs_file" | "conflict" | "indexing" | "complete" | "index_failed" | "blocked";
type Entry = { task: Task; phase: Phase; error?: string; hashBytes?: number; token?: string };
type HashResult = { hashes: string[]; sha256: string };
type UploadContextValue = { enabled: boolean; count: number; open: (kind: UploadKind, folderId?: string | null) => void };
const UploadContext = createContext<UploadContextValue>({ enabled: false, count: 0, open: () => {} });
const CHUNK_BYTES = 8 * 1024 * 1024;
const labels: Record<UploadKind, string> = { video: "视频", music: "音乐", reading: "阅读", photos: "图片", files: "其他文件" };
const phases: Record<Phase, string> = { queued: "等待上传", hashing: "校验文件", transferring: "正在上传", paused: "已暂停", needs_file: "请重选原文件以续传", conflict: "重名冲突 · 原件已保留", indexing: "已上传，正在更新列表", complete: "上传完成", index_failed: "已上传，索引失败", blocked: "提交状态需管理员检查 · 暂存已保留" };
const extensions: Record<UploadKind, Set<string> | null> = {
  video: new Set("mp4 mkv mov m4v webm avi ts m2ts mts mpg mpeg flv ass ssa srt ttf otf ttc woff woff2 rar".split(" ")),
  music: new Set("mp3 aac m4a flac wav wave aif aiff ogg opus ape wv lrc jpg jpeg png webp".split(" ")),
  reading: new Set("pdf epub mobi azw azw3 fb2 cbz txt xlsx xls xlsm xlsb csv ods".split(" ")),
  photos: new Set("jpg jpeg jpe jfif png apng gif webp avif bmp dib ico svg tif tiff".split(" ")),
  files: null,
};
class UploadError extends Error {
  constructor(message: string, public status: number, public task?: Task, public code?: string) { super(message); }
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(typeof options?.body === "string" ? { "Content-Type": "application/json" } : {}), ...options?.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if ([401, 403].includes(response.status)) window.dispatchEvent(new Event("lmd:upload-auth-refresh"));
    throw new UploadError(result.error || "上传操作失败", response.status, result.task, result.code);
  }
  return result;
}
const route = (task: Task) => `/api/uploads/${encodeURIComponent(task.id)}`;
const unfinished = (entry: Entry) => !["complete", "index_failed", "indexing"].includes(entry.phase);
const phaseFor = (task: Task): Phase => task.errorCode === "UPLOAD_PUBLICATION_UNCERTAIN" ? "blocked" : task.status === "conflict" ? "conflict" : task.status === "complete" ? "complete" : task.status === "index_failed" ? "index_failed" : ["published", "indexing"].includes(task.status) ? "indexing" : "needs_file";
const isConflict = (failure: unknown): failure is UploadError => failure instanceof UploadError && ["UPLOAD_CONFLICT", "UPLOAD_GROUP_CONFLICT", "UPLOAD_CASE_CONFLICT"].includes(failure.code || "");
function hashFile(file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<HashResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./upload-hash.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("上传已暂停", "AbortError")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => { if (event.data.type === "progress") progress(event.data.bytes); else if (event.data.type === "done") { cleanup(); resolve(event.data); } else { cleanup(); reject(new Error(event.data.error)); } };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || "无法校验文件")); };
    worker.postMessage({ file });
  });
}

export function UploadProvider({ accessStatus, onRefresh, children }: { accessStatus: Identity | null; onRefresh: (quiet?: boolean) => Promise<void>; children: React.ReactNode }) {
  const enabled = !!(accessStatus?.enabled && (accessStatus.localAdmin || (accessStatus.authenticated && (accessStatus.canUpload || accessStatus.user?.canUpload))));
  const identity = accessStatus?.localAdmin ? "local-admin" : accessStatus?.authenticated ? accessStatus.user?.id || "" : "";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entriesOwner, setEntriesOwner] = useState("");
  const [shown, setShown] = useState(false);
  const [kind, setKind] = useState<UploadKind>("video");
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState("");
  const [maxFileBytes, setMaxFileBytes] = useState(100 * 1024 ** 3);
  const [staged, setStaged] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("");
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const files = useRef(new Map<string, File>()), active = useRef(new Map<string, AbortController>());
  const preflight = useRef<AbortController | null>(null), targetsSequence = useRef(0);
  const refreshingIdentity = useRef(false);
  const state = useRef(entries), identityRef = useRef(identity), enabledRef = useRef(enabled), generation = useRef(0), sequence = useRef(0), targetFolder = useRef<string | null>(null);
  state.current = entries; identityRef.current = identity; enabledRef.current = enabled;
  const update = useCallback((id: string, patch: Partial<Entry>) => setEntries(current => current.map(entry => entry.task.id === id ? { ...entry, ...patch } : entry)), []);
  const changed = useCallback(() => { window.dispatchEvent(new Event("lmd:uploads-changed")); void onRefresh(true); }, [onRefresh]);
  const refreshIdentity = useCallback(() => {
    for (const controller of active.current.values()) controller.abort();
    setEntries(current => current.map(entry => unfinished(entry) ? { ...entry, phase: "paused", error: "登录或权限已变化，请重新登录后继续" } : entry));
    if (refreshingIdentity.current) return;
    refreshingIdentity.current = true;
    const ownGeneration = generation.current;
    void onRefresh(true).then(async () => {
      // The listing omits tasks whose folder authorization has been revoked.
      // Use a raw read here to avoid recursively firing the auth-refresh event.
      const response = await fetch("/api/uploads");
      if (!response.ok || ownGeneration !== generation.current) return;
      const result = await response.json() as { tasks: Task[] };
      if (ownGeneration !== generation.current) return;
      const visible = new Set(result.tasks.map(task => task.id));
      setEntries(current => current.filter(entry => visible.has(entry.task.id)));
      for (const id of files.current.keys()) if (!visible.has(id)) files.current.delete(id);
    }).catch(() => {}).finally(() => { refreshingIdentity.current = false; });
  }, [onRefresh]);
  useEffect(() => { window.addEventListener("lmd:upload-auth-refresh", refreshIdentity); return () => window.removeEventListener("lmd:upload-auth-refresh", refreshIdentity); }, [refreshIdentity]);
  const loadTargets = useCallback(async (nextKind: UploadKind, folderId?: string | null) => {
    const sequence = ++targetsSequence.current, ownGeneration = generation.current;
    try {
      const result = await request<{ targets: Target[]; limits?: { maxFileBytes?: number } }>(`/api/uploads/targets?kind=${nextKind}`);
      if (sequence !== targetsSequence.current || ownGeneration !== generation.current) return;
      const writable = result.targets.filter(target => target.writable !== false);
      setTargets(writable); if (result.limits?.maxFileBytes) setMaxFileBytes(result.limits.maxFileBytes);
      const matching = folderId ? writable.find(target => target.folderId === folderId) : null;
      const roots = writable.filter(target => target.relativePath === "" || target.parentId === null);
      setTargetId(matching?.id || (!folderId && roots.length === 1 ? roots[0].id : ""));
    } catch (failure) { if (sequence !== targetsSequence.current || ownGeneration !== generation.current) return; setTargets([]); setTargetId(""); setError(failure instanceof Error ? failure.message : "无法读取上传目录"); if (failure instanceof UploadError && [401, 403].includes(failure.status)) refreshIdentity(); }
  }, [refreshIdentity]);
  useEffect(() => {
    generation.current += 1; targetsSequence.current += 1; preflight.current?.abort(); for (const controller of active.current.values()) controller.abort(); active.current.clear(); files.current.clear(); setEntries([]); setEntriesOwner(identity); setStaged([]); setTargets([]); setTargetId(""); setError(""); setPreparing(false);
    if (!identity || !enabled) return;
    let stopped = false;
    void request<{ tasks: Task[] }>("/api/uploads").then(result => {
      if (stopped) return;
      setEntries(result.tasks.filter(task => task.status !== "cancelled").map(task => ({ task, phase: phaseFor(task) })));
    }).catch(failure => { if (!stopped) setError(failure.message); });
    return () => { stopped = true; };
  }, [identity, enabled]);
  useEffect(() => { if (!enabled) { for (const controller of active.current.values()) controller.abort(); setEntries(current => current.map(entry => unfinished(entry) ? { ...entry, phase: "paused" } : entry)); } }, [enabled]);
  useEffect(() => {
    if (!identity || entriesOwner !== identity) return;
    // Recovery metadata only; bytes, capabilities and tokens never enter storage.
    try { localStorage.setItem(`lmd:uploads:${identity}`, JSON.stringify(entries.filter(unfinished).map(({ task }) => ({ id: task.id, kind: task.kind, relativePath: task.relativePath, size: task.size, lastModified: task.lastModified })))); } catch { /* Server task manifests remain the source of truth. */ }
  }, [entries, identity, entriesOwner]);
  useEffect(() => { if (shown) dialog.current?.showModal(); else dialog.current?.close(); }, [shown]);
  useEffect(() => {
    if (entriesOwner !== identity || !entries.some(entry => entry.phase === "indexing")) return;
    const ownGeneration = generation.current;
    const timer = window.setInterval(() => {
      for (const entry of state.current.filter(item => item.phase === "indexing")) void request<{ task: Task }>(route(entry.task)).then(({ task }) => { if (ownGeneration !== generation.current) return; update(task.id, { task, phase: phaseFor(task) }); if (["complete", "index_failed"].includes(task.status)) changed(); }).catch(failure => { if (ownGeneration === generation.current && failure instanceof UploadError && [401, 403].includes(failure.status)) refreshIdentity(); });
    }, 1500);
    return () => clearInterval(timer);
  }, [entries.some(entry => entry.phase === "indexing"), entriesOwner, identity, update, changed, refreshIdentity]);
  const run = async (entry: Entry) => {
    const id = entry.task.id, file = files.current.get(id);
    if (!file) { update(id, { phase: "needs_file" }); return; }
    const controller = new AbortController(), signal = controller.signal, ownGeneration = generation.current;
    active.current.set(id, controller);
    const safeUpdate = (patch: Partial<Entry>) => { if (ownGeneration === generation.current) update(id, patch); };
    try {
      safeUpdate({ phase: "hashing", error: "", hashBytes: 0 });
      const digest = await hashFile(file, signal, hashBytes => safeUpdate({ hashBytes }));
      let { task } = await request<{ task: Task }>(route(entry.task), { signal });
      let token = entry.token;
      if (!token || task.receivedBytes > 0) {
        const prefixHashes = task.chunks.map((chunk, index) => {
          if (chunk.offset !== index * CHUNK_BYTES || chunk.sha256 !== digest.hashes[index]) throw new Error("所选文件与已上传前缀不同，未继续上传。请重选正确的原文件。");
          return digest.hashes[index];
        });
        const resumed = await request<{ task: Task; resumeToken: string }>(`${route(task)}/resume`, { method: "POST", body: JSON.stringify({ prefixHashes }), signal });
        task = resumed.task; token = resumed.resumeToken;
      }
      safeUpdate({ task, token, phase: "transferring" });
      while (task.receivedBytes < file.size) {
        const offset = task.receivedBytes;
        const result = await request<{ task: Task }>(`${route(task)}/chunks?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "x-chunk-sha256": digest.hashes[Math.floor(offset / CHUNK_BYTES)], "x-upload-token": token! }, body: file.slice(offset, offset + CHUNK_BYTES), signal });
        task = result.task; safeUpdate({ task });
      }
      const completed = await request<{ task: Task }>(`${route(task)}/complete`, { method: "POST", body: JSON.stringify({ sha256: digest.sha256, resumeToken: token }), signal });
      if (ownGeneration !== generation.current) return;
      safeUpdate({ task: completed.task, phase: phaseFor(completed.task) }); changed(); files.current.delete(id);
    } catch (failure) {
      if (ownGeneration !== generation.current) return;
      if (failure instanceof UploadError && [401, 403].includes(failure.status)) refreshIdentity();
      else if (failure instanceof UploadError && failure.code === "UPLOAD_PUBLICATION_UNCERTAIN") safeUpdate({ phase: "blocked", error: failure.message });
      else if (isConflict(failure)) {
        const task = failure.task || entry.task;
        for (const peer of state.current.filter(item => (item.task.id === task.id || task.groupId && item.task.groupId === task.groupId) && unfinished(item))) { active.current.get(peer.task.id)?.abort(); update(peer.task.id, { phase: "conflict", error: failure.message }); }
        safeUpdate({ task, phase: "conflict", error: failure.message });
      } else if (signal.aborted) { if (state.current.find(item => item.task.id === id)?.phase !== "conflict") safeUpdate({ phase: "paused" }); }
      else safeUpdate({ phase: "paused", error: failure instanceof Error ? failure.message : "网络连接中断，可继续上传" });
    } finally { if (active.current.get(id) === controller) active.current.delete(id); if (ownGeneration === generation.current) setEntries(current => [...current]); }
  };
  useEffect(() => {
    if (!enabled || preparing || entriesOwner !== identity) return;
    for (const entry of entries) {
      if (active.current.size >= 2) break;
      if (entry.phase === "queued" && !active.current.has(entry.task.id)) void run(entry);
    }
  }, [entries, enabled, preparing, entriesOwner, identity]);
  useEffect(() => () => { generation.current += 1; for (const controller of active.current.values()) controller.abort(); }, []);
  const open = (nextKind: UploadKind, folderId?: string | null) => { setKind(nextKind); targetFolder.current = folderId || null; setShown(true); setError(""); setStaged([]); if (enabled) void loadTargets(nextKind, folderId); };
  const reason = (file: File) => file.size > maxFileBytes ? `超过单文件上限 ${transferSize(maxFileBytes)}` : kind !== "files" && (file.webkitRelativePath || file.name).replaceAll("\\", "/").split("/").some(part => part.startsWith(".")) ? "媒体库不支持以点开头的隐藏文件或文件夹路径" : extensions[kind] && !extensions[kind]!.has(file.name.split(".").pop()!.toLowerCase()) ? `不支持的${labels[kind]}格式` : kind === "video" && /\.rar$/i.test(file.name) && !(/fonts?|字体/iu.test(file.name) || (file.webkitRelativePath || "").split("/").slice(0, -1).some(part => /^(?:fonts?|字体)$/iu.test(part))) ? "视频库仅接收现有字体包命名规则识别的 RAR" : "";
  const supported = staged.filter(file => !reason(file));
  const addFiles = (selected: File[]) => { setStaged(selected); setError(""); };
  const enqueue = async () => {
    if (!targetId || !supported.length || preparing) return;
    setPreparing(true); setError("");
    const ownGeneration = generation.current, controller = new AbortController(); preflight.current = controller;
    const groupPrefix = `selection-${Date.now().toString(36)}-${++sequence.current}`;
    const groupKeys = uploadGroupKeys(kind, supported), groupIds = new Map<string, string>();
    const findExisting = (file: File) => state.current.find(item => unfinished(item) && item.task.kind === kind && item.task.targetId === targetId && item.task.relativePath === (file.webkitRelativePath || file.name) && item.task.size === file.size && item.task.lastModified === file.lastModified);
    supported.forEach((file, index) => { const existing = findExisting(file); if (existing?.task.groupId) groupIds.set(groupKeys[index], existing.task.groupId); });
    const created: Entry[] = [], conflictGroups = new Set<string>(), failedGroups = new Set<string>(), failures: string[] = [], rejected: File[] = [];
    try {
      // Preflight all groups before scheduling bytes. Unrelated ordinary files
      // remain independent; shared video fonts and album covers move together.
      for (let index = 0; index < supported.length; index++) {
        const file = supported[index];
        const key = groupKeys[index];
        if (!groupIds.has(key)) groupIds.set(key, `${groupPrefix}-${groupIds.size}`);
        const groupId = groupIds.get(key)!;
        const relativePath = file.webkitRelativePath || file.name;
        const existing = findExisting(file);
        if (existing) { files.current.set(existing.task.id, file); created.push({ ...existing, phase: existing.phase === "conflict" ? "conflict" : "queued", error: "" }); if (existing.phase === "conflict") conflictGroups.add(groupId); continue; }
        try {
          const result = await request<{ task: Task; resumeToken: string }>("/api/uploads", { method: "POST", body: JSON.stringify({ kind, targetId, relativePath, size: file.size, lastModified: file.lastModified, groupId }), signal: controller.signal });
          if (ownGeneration !== generation.current) return;
          files.current.set(result.task.id, file); created.push({ task: result.task, token: result.resumeToken, phase: "queued" });
        } catch (failure) {
          if (ownGeneration !== generation.current || controller.signal.aborted) return;
          if (isConflict(failure) && failure.task) { conflictGroups.add(groupId); files.current.set(failure.task.id, file); created.push({ task: failure.task, phase: "conflict", error: failure.message }); }
          else {
            failedGroups.add(groupId); rejected.push(file); failures.push(`${relativePath}：${failure instanceof Error ? failure.message : "无法创建上传任务"}`);
            if (failure instanceof UploadError && [401, 403].includes(failure.status)) { rejected.push(...supported.slice(index + 1)); throw failure; }
          }
        }
      }
    } catch (failure) { if (failure instanceof UploadError && [401, 403].includes(failure.status)) refreshIdentity(); }
    finally {
      if (ownGeneration !== generation.current) return;
      setStaged(rejected); if (failures.length) setError(failures.join("\n"));
      setEntries(current => { const ids = new Set(created.map(item => item.task.id)); return [...current.filter(item => !ids.has(item.task.id)), ...created.map(item => conflictGroups.has(item.task.groupId || "") ? { ...item, phase: "conflict" as Phase } : failedGroups.has(item.task.groupId || "") ? { ...item, phase: "paused" as Phase, error: "关联文件准备未完成，请检查错误后继续" } : item)]; });
      setPreparing(false);
    }
  };
  const reselect = (entry: Entry, file?: File) => {
    if (!file) return;
    if (file.size !== entry.task.size || file.lastModified !== entry.task.lastModified) { update(entry.task.id, { error: "文件大小或修改时间不同，请重选同一个原文件。" }); return; }
    files.current.set(entry.task.id, file); update(entry.task.id, { phase: entry.phase === "conflict" ? "conflict" : "queued", error: "" });
  };
  const cancel = async (entry: Entry) => {
    const ownGeneration = generation.current;
    const peers = state.current.filter(item => item.task.id === entry.task.id || item.task.groupId && item.task.groupId === entry.task.groupId).filter(unfinished);
    peers.forEach(item => active.current.get(item.task.id)?.abort());
    try { await request(`${route(entry.task)}?includeGroup=1`, { method: "DELETE" }); if (ownGeneration !== generation.current) return; setEntries(current => current.filter(item => !peers.some(peer => peer.task.id === item.task.id))); peers.forEach(item => files.current.delete(item.task.id)); }
    catch (failure) { if (ownGeneration === generation.current) setError(failure instanceof Error ? failure.message : "取消失败"); }
  };
  const retarget = async (entry: Entry, nextTargetId: string, relativePath: string) => {
    const ownGeneration = generation.current;
    try {
      await request(route(entry.task), { method: "PATCH", body: JSON.stringify({ targetId: nextTargetId, relativePath, includeGroup: true }) });
      if (ownGeneration !== generation.current) return;
      const result = await request<{ tasks: Task[] }>("/api/uploads");
      if (ownGeneration !== generation.current) return;
      const peers = result.tasks.filter(task => task.id === entry.task.id || task.groupId && task.groupId === entry.task.groupId);
      setEntries(current => current.map(item => { const task = peers.find(peer => peer.id === item.task.id); return task ? { ...item, task, token: undefined, error: "", phase: files.current.has(task.id) ? "queued" : "needs_file" } : item; }));
    } catch (failure) { if (ownGeneration === generation.current) setError(failure instanceof Error ? failure.message : "调整目标失败"); }
  };
  const createDirectory = async () => {
    if (!targetId || !folderName.trim()) return;
    const ownGeneration = generation.current;
    try { await request("/api/uploads/directories", { method: "POST", body: JSON.stringify({ kind, targetId, relativePath: folderName.trim() }) }); if (ownGeneration !== generation.current) return; setFolderName(""); await loadTargets(kind, targetFolder.current); changed(); }
    catch (failure) { if (ownGeneration === generation.current) setError(failure instanceof Error ? failure.message : "新建文件夹失败"); }
  };
  const visibleEntries = entriesOwner === identity ? entries : [];
  const count = visibleEntries.filter(unfinished).length;
  return <UploadContext.Provider value={{ enabled, count, open }}>{children}
    {count > 0 && !shown && <button className="upload-queue-toggle" onClick={() => open(kind, new URLSearchParams(window.location.search).get("folder"))}><Upload size={15} />上传队列 · {count}</button>}
    <dialog ref={dialog} className="upload-dialog" aria-labelledby="upload-title" onCancel={event => { event.preventDefault(); setShown(false); }}>
      <header><div><h2 id="upload-title">上传与文件夹</h2><p>8 MiB 分块 · 刷新后重选原文件可续传 · 未完成任务保留 24 小时</p></div><button className="icon-btn" aria-label="收起上传窗口" onClick={() => setShown(false)}><X size={20} /></button></header>
      {!enabled ? <p className="transfer-error">上传需要开启访问控制，并由管理员授予当前用户上传权限。</p> : <>
        <div className="upload-destination"><label>板块<select value={kind} onChange={event => { const next = event.target.value as UploadKind; setKind(next); setStaged([]); void loadTargets(next); }}>{Object.entries(labels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>上传到<select value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">请选择有写入权限的目录</option>{targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label></div>
        {!targets.length && <p>没有可写目录。请管理员配置共享目录、开启访问控制并授予相应分类权限。</p>}
        <div className="upload-new-folder"><input className="input" value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="新文件夹名称（可包含层级）" aria-label="新文件夹名称" /><button className="btn btn--sm" disabled={!targetId || !folderName.trim()} onClick={() => void createDirectory()}><FolderPlus size={15} />新建文件夹</button></div>
        <div className="upload-dropzone" onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}>
          <Upload size={25} /><strong>拖入文件，或选择文件 / 文件夹</strong><span>保留所选文件夹及层级 · 单文件最多 {transferSize(maxFileBytes)}</span><div className="transfer-actions"><button className="btn btn--sm" onClick={() => fileInput.current?.click()}>选择文件</button><button className="btn btn--sm" onClick={() => directoryInput.current?.click()}>选择文件夹</button></div>
          <input hidden multiple type="file" ref={fileInput} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
          <input hidden multiple type="file" ref={directoryInput} {...{ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />
        </div>
        {staged.length > 0 && <div className="upload-review"><strong>已选择 {staged.length} 个文件 · {transferSize(staged.reduce((sum, file) => sum + file.size, 0))}</strong>{staged.some(file => reason(file)) && <><p>以下文件不适用于当前板块，将保留在原处：</p><ul>{staged.filter(file => reason(file)).map((file, index) => <li key={index}>{file.webkitRelativePath || file.name} — {reason(file)}</li>)}</ul></>}<button className="btn btn--primary" disabled={!targetId || !supported.length || preparing} onClick={() => void enqueue()}>{preparing && <LoaderCircle size={14} className="spin" />}{preparing ? "正在检查目标…" : `上传${supported.length === staged.length ? "" : "支持的 "}${supported.length} 个文件`}</button></div>}
      </>}
      {error && <p className="transfer-error" role="alert">{error}</p>}
      <div className="upload-queue" aria-label="全局上传队列">{visibleEntries.map(entry => <div className="upload-task" key={entry.task.id}><div className="upload-task-title"><strong title={entry.task.relativePath}>{entry.task.relativePath}</strong><span>{labels[entry.task.kind]}</span></div><div className="upload-task-state"><span>{phases[entry.phase]}</span><span>{transferSize(entry.phase === "hashing" ? entry.hashBytes || 0 : entry.task.receivedBytes)} / {transferSize(entry.task.size)}</span></div><progress max={entry.task.size || 1} value={entry.phase === "hashing" ? entry.hashBytes || 0 : entry.task.receivedBytes} />{(entry.error || entry.task.error) && <p className="transfer-error" role="status">{entry.error || entry.task.error}</p>}
        <div className="transfer-actions">{["hashing", "transferring", "queued"].includes(entry.phase) && <button className="btn btn--sm" onClick={() => { active.current.get(entry.task.id)?.abort(); update(entry.task.id, { phase: "paused" }); }}><Pause size={13} />暂停</button>}
          {enabled && ["paused", "needs_file", "conflict"].includes(entry.phase) && <>{entry.phase !== "conflict" && files.current.has(entry.task.id) && <button className="btn btn--sm" onClick={() => update(entry.task.id, { phase: "queued", error: "" })}><Play size={13} />继续</button>}<label className="btn btn--sm">重选原文件<input hidden type="file" onChange={event => { reselect(entry, event.target.files?.[0]); event.target.value = ""; }} /></label></>}
          {entry.phase === "index_failed" && <button className="btn btn--sm" onClick={() => void request<{ task: Task }>(`${route(entry.task)}/reindex`, { method: "POST" }).then(({ task }) => { update(task.id, { task, phase: phaseFor(task) }); changed(); }).catch(failure => setError(failure.message))}>重试索引</button>}
          {unfinished(entry) && entry.phase !== "blocked" && <button className="btn btn--sm" onClick={() => void cancel(entry)}>{entry.phase === "conflict" ? "跳过本组" : "取消本组"}</button>}
        </div>
        {enabled && entry.phase === "conflict" && <Retarget entry={entry} targets={targets.filter(target => target.kind === entry.task.kind)} onKind={() => { setKind(entry.task.kind); void loadTargets(entry.task.kind); }} onSave={(id, path) => void retarget(entry, id, path)} />}
      </div>)}</div>
    </dialog>
  </UploadContext.Provider>;
}

function Retarget({ entry, targets, onKind, onSave }: { entry: Entry; targets: Target[]; onKind: () => void; onSave: (targetId: string, relativePath: string) => void }) {
  const [targetId, setTargetId] = useState(""); const [relativePath, setRelativePath] = useState(entry.task.relativePath);
  return <details className="upload-retarget" onToggle={event => { if (event.currentTarget.open && !targets.length) onKind(); }}><summary>调整本组未完成文件的目标</summary><p>已上传成功的文件保持原位；配套文件与未完成原件一起调整。</p><select aria-label="新的上传目录" value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">选择新目录</option>{targets.map(target => <option value={target.id} key={target.id}>{target.label}</option>)}</select><input className="input" aria-label="新的相对路径" value={relativePath} onChange={event => setRelativePath(event.target.value)} /><button className="btn btn--sm" disabled={!targetId || !relativePath} onClick={() => onSave(targetId, relativePath)}>保存目标并继续</button></details>;
}

export function UploadLauncher({ kind }: { kind: UploadKind }) {
  const upload = useContext(UploadContext);
  if (!upload.enabled && !upload.count) return null;
  return <button className="icon-btn" aria-label="上传文件与新建文件夹" title="上传文件与新建文件夹" onClick={() => upload.open(kind, new URLSearchParams(window.location.search).get("folder"))}><Upload size={17} />{upload.count > 0 && <small>{upload.count}</small>}</button>;
}

export function UploadSettingsCard({ onNotice }: { onNotice: (message: string) => void }) {
  const [gib, setGib] = useState(100), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { void request<{ maxFileBytes: number }>("/api/uploads/settings").then(result => setGib(result.maxFileBytes / 1024 ** 3)).catch(failure => setError(failure.message)); }, []);
  const save = async () => { setBusy(true); try { await request("/api/uploads/settings", { method: "PATCH", body: JSON.stringify({ maxFileBytes: Math.floor(gib * 1024 ** 3) }) }); setError(""); onNotice("上传单文件上限已保存"); } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败"); } finally { setBusy(false); } };
  return <section className="adm-section"><div className="adm-section-head"><div><h2>局域网上传</h2><p>需开启访问控制并逐用户授予上传权。未完成任务保留 24 小时，目标磁盘至少保留 2 GiB。</p></div></div><div className="files-add"><label>单文件上限（GiB）<input className="input" type="number" min="0.001" step="1" value={gib} onChange={event => setGib(Number(event.target.value))} /></label><button className="btn btn--sm" disabled={busy || !Number.isFinite(gib) || gib <= 0} onClick={() => void save()}>保存上传设置</button></div>{error && <p className="transfer-error">{error}</p>}</section>;
}
