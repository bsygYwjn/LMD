import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";

export const transferSize = (bytes: number) => {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = bytes > 0 ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};

export function useDownloadSelection() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return { selected, setSelected, toggle };
}

type Archive = { downloadUrl: string; expiresAt: string; omittedRelatedCount: number; fileCount: number; totalBytes: number; fileName: string };
export function DownloadSelection({ kind, items, selected, onSelect }: { kind: "video" | "music"; items: Array<{ id: string; size: number }>; selected: Set<string>; onSelect: (ids: Set<string>) => void }) {
  const [includeRelated, setIncludeRelated] = useState(true);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "handed">("idle");
  const [error, setError] = useState("");
  const operation = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const chosen = items.filter(item => selected.has(item.id));
  const signature = chosen.map(item => item.id).sort().join("|");
  useEffect(() => {
    operation.current.generation += 1; operation.current.controller?.abort(); setArchive(null); setPhase("idle"); setError("");
    return () => { operation.current.generation += 1; operation.current.controller?.abort(); };
  }, [signature, includeRelated, kind]);
  const prepare = async () => {
    operation.current.controller?.abort();
    const generation = ++operation.current.generation, controller = new AbortController(); operation.current.controller = controller;
    setPhase("preparing"); setError("");
    try {
      const response = await fetch("/api/downloads/archives", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ids: chosen.map(item => item.id), includeRelated }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法准备下载清单");
      if (generation !== operation.current.generation) return;
      setArchive(result); setPhase("ready");
    } catch (failure) { if (generation !== operation.current.generation || controller.signal.aborted) return; setError(failure instanceof Error ? failure.message : "准备下载失败"); setPhase("idle"); }
  };
  const download = async () => {
    if (!archive) return;
    const generation = operation.current.generation, controller = new AbortController(); operation.current.controller?.abort(); operation.current.controller = controller;
    setError("");
    try {
      const check = await fetch(archive.downloadUrl, { method: "HEAD", signal: controller.signal });
      if (generation !== operation.current.generation) return;
      if (!check.ok) throw new Error(check.status === 410 ? "下载地址已失效，请重新准备。已保留文件选择。" : "下载权限或原文件已变化，请重新准备。");
      const anchor = document.createElement("a"); anchor.href = archive.downloadUrl; anchor.download = archive.fileName; document.body.append(anchor); anchor.click(); anchor.remove();
      setPhase("handed");
    } catch (failure) { if (generation !== operation.current.generation || controller.signal.aborted) return; setError(failure instanceof Error ? failure.message : "下载暂不可用"); setArchive(null); setPhase("idle"); }
  };
  if (!items.length) return null;
  return <div className="download-selection" aria-label="批量下载">
    <label className="transfer-check"><input type="checkbox" checked={chosen.length === items.length && !!items.length} onChange={() => onSelect(chosen.length === items.length ? new Set() : new Set(items.map(item => item.id)))} />全选当前结果</label>
    {chosen.length > 0 && <><span>{chosen.length} 个 · {transferSize(chosen.reduce((sum, item) => sum + item.size, 0))}</span><label className="transfer-check"><input type="checkbox" checked={includeRelated} onChange={event => setIncludeRelated(event.target.checked)} />附带配套文件</label>
      <button className="btn btn--sm" disabled={phase === "preparing"} onClick={() => void prepare()}>{phase === "preparing" ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{phase === "preparing" ? "正在准备清单…" : archive ? "重新准备 ZIP" : "准备 ZIP"}</button>
      {archive && <button className="btn btn--primary btn--sm" onClick={() => void download()}><Download size={14} />下载 ZIP</button>}
      <button className="icon-btn" onClick={() => onSelect(new Set())} aria-label="清除下载选择"><X size={14} /></button>
      {archive && <span className="download-status" role="status">{phase === "handed" ? "已交给浏览器，请在浏览器中查看下载进度" : `准备完成 · ${archive.fileCount} 个文件`}{archive.omittedRelatedCount ? ` · 已省略 ${archive.omittedRelatedCount} 个无权限配套文件` : ""}</span>}
    </>}
    {error && <p className="transfer-error" role="alert">{error}</p>}
  </div>;
}
