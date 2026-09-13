import { readFile, writeFile } from "node:fs/promises";
const file = "src/main.tsx";
let text = await readFile(file, "utf8");

// Conflict 1 (imports) is already resolved; resolve the remaining settings block.
const conflicts = [...text.matchAll(/<<<<<<< HEAD\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> codex\/newvedioplayer/g)];
console.log("remaining conflicts:", conflicts.length);

// The settings page markup: keep main's refreshed design-system structure and
// graft the two new cards into it using the same adm-section language.
const cards = `
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
      </section>`;

let resolved = text;
if (conflicts.length >= 1) {
  const last = conflicts[conflicts.length - 1];
  const mainSide = last[1];
  const ours = last[2];
  const withCards = mainSide.replace(/(\n      <section className="adm-section">\n        <div className="adm-section-head"><div><h2>关于<\/h2>)/, `${cards}$1`);
  if (withCards === mainSide) throw new Error("关于 section anchor not found in main settings markup");
  resolved = resolved.replace(last[0], withCards);
  console.log("settings block: kept main structure, inserted playback + danmaku cards");
} else {
  console.log("no settings conflict left");
}
await writeFile(file, resolved);
const left = (resolved.match(/^(<<<<<<<|=======|>>>>>>>)/gm) || []).length;
console.log("markers left:", left);
