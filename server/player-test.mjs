// In-browser acceptance harness for the unified playback core.
//
// The harness runs inside the real browser (same origin, same media element,
// same network stack) and reports through the service so that results land in a
// file next to server state. It exists because engine-level automation cannot
// stand in for a real browser: device volume, native HLS, MSE buffer recycling
// and touch gestures only exist on the actual client.
//
// The service only accepts reports while LMD_PLAYER_TEST=1, so a shared or
// packaged server can never be written to through this path.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { playbackError } from "./playback-planner.mjs";

const MAX_BODY_BYTES = 2 * 1024 ** 2;

export function createPlayerTestService({ dataDirectory, enabled, readJson, sendJson, requireLocalManagement, appState }) {
  const directory = path.join(dataDirectory, "playback-test");
  const reportFile = path.join(directory, "browser-report.json");
  const enabledFlag = enabled === true || process.env.LMD_PLAYER_TEST === "1";
  let lastReport = null;

  async function loadExisting() {
    try { lastReport = JSON.parse(await readFile(reportFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") console.error(`播放自检报告读取失败：${error.message}`); }
  }
  const ready = enabledFlag ? loadExisting() : Promise.resolve();

  function summary(report) {
    const results = Array.isArray(report?.results) ? report.results : [];
    return { finishedAt: report?.finishedAt || null, startedAt: report?.startedAt || null, userAgent: report?.userAgent || "",
      total: results.length, failed: results.filter(item => item?.ok !== true).length,
      failures: results.filter(item => item?.ok !== true).map(item => ({ name: item?.name, detail: item?.detail })), metrics: report?.metrics || {} };
  }

  async function handleRequest(request, response, url, pathname) {
    if (!pathname.startsWith("/api/player-test")) return false;
    if (!enabledFlag) { sendJson(response, 404, { error: "播放自检未启用。", code: "PLAYER_TEST_DISABLED" }); return true; }
    if (!requireLocalManagement(request, response)) return true;
    await ready;
    try {
      if (pathname === "/api/player-test/report" && request.method === "POST") {
        const length = Number(request.headers["content-length"] || 0);
        if (length > MAX_BODY_BYTES) throw playbackError("REPORT_TOO_LARGE", "自检报告过大", 413);
        const body = await readJson(request);
        const report = { receivedAt: new Date().toISOString(), service: process.env.LMD_SERVICE_TAG || "",
          userAgent: String(body.userAgent || "").slice(0, 400), startedAt: body.startedAt, finishedAt: body.finishedAt,
          results: (Array.isArray(body.results) ? body.results : []).slice(0, 200).map(item => ({
            name: String(item?.name ?? "").slice(0, 200), ok: item?.ok === true, detail: String(item?.detail ?? "").slice(0, 2000) })),
          metrics: JSON.parse(JSON.stringify(body.metrics ?? {}, (_key, value) => typeof value === "string" ? value.slice(0, 500) : value)) };
        await mkdir(directory, { recursive: true });
        await writeFile(`${reportFile}.tmp`, JSON.stringify(report, null, 2));
        await rename(`${reportFile}.tmp`, reportFile);
        lastReport = report;
        sendJson(response, 200, { ok: true, summary: summary(report) });
        return true;
      }
      if (pathname === "/api/player-test/target" && request.method === "GET") {
        const media = (appState.media || []).find(item => !item.hidden) || null;
        sendJson(response, 200, { enabled: true, mediaId: media?.id || null, title: media?.title || media?.fileName || "",
          report: lastReport ? summary(lastReport) : null });
        return true;
      }
      if (pathname === "/api/player-test/report" && request.method === "GET") {
        sendJson(response, 200, { report: lastReport, summary: lastReport ? summary(lastReport) : null });
        return true;
      }
      throw playbackError("NOT_FOUND", "自检接口不存在", 404);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendJson(response, error.status || 500, { error: error.message, code: error.code || "PLAYER_TEST_ERROR" });
      return true;
    }
  }
  return { handleRequest, enabled: enabledFlag, reportPath: reportFile };
}
