import * as XLSX from "xlsx";

const MAX_ROWS = 200_000;
const MAX_COLUMNS = 1_024;
const MAX_NON_EMPTY_CELLS = 250_000;

type WorkerRequest = { type: "open"; url: string } | { type: "sheet"; name: string };

let sourceBytes: ArrayBuffer | null = null;
let sourceUrl = "";

function messageForError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "无法解析表格");
  if (/password|encrypted|encryption/i.test(message)) return "这个表格已加密，浏览器快速预览无法解密。请下载原文件后在本地 Excel 中打开。";
  return `无法预览这个表格：${message}`;
}

async function loadBytes(url: string) {
  if (sourceBytes && sourceUrl === url) return sourceBytes;
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`文件请求失败（${response.status}）`);
  sourceBytes = await response.arrayBuffer();
  sourceUrl = url;
  return sourceBytes;
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void (async () => {
    try {
      if (event.data.type === "open") {
        const bytes = await loadBytes(event.data.url);
        const workbook = XLSX.read(bytes, { type: "array", bookSheets: true, bookProps: true });
        self.postMessage({ type: "names", names: workbook.SheetNames, properties: workbook.Props || null });
        return;
      }

      if (!sourceBytes) throw new Error("表格文件尚未加载");
      const workbook = XLSX.read(sourceBytes, {
        type: "array",
        sheets: [event.data.name],
        cellDates: true,
        cellFormula: true,
        cellStyles: true,
        cellNF: true,
      });
      const worksheet = workbook.Sheets[event.data.name];
      if (!worksheet) throw new Error("找不到这个工作表");
      const rawRange = worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
      const rowCount = Math.min(MAX_ROWS, Math.max(1, rawRange.e.r + 1));
      const columnCount = Math.min(MAX_COLUMNS, Math.max(1, rawRange.e.c + 1));
      const cells: Array<{ row: number; column: number; text: string }> = [];
      for (const address of Object.keys(worksheet)) {
        if (address.startsWith("!")) continue;
        const position = XLSX.utils.decode_cell(address);
        if (position.r >= rowCount || position.c >= columnCount) continue;
        const cell = worksheet[address];
        if (!cell || cell.v === undefined || cell.v === null) continue;
        const text = cell.w ?? XLSX.utils.format_cell(cell);
        cells.push({ row: position.r, column: position.c, text: String(text ?? "") });
        if (cells.length >= MAX_NON_EMPTY_CELLS) break;
      }
      const merges = (worksheet["!merges"] || [])
        .filter((merge) => merge.s.r < rowCount && merge.s.c < columnCount)
        .map((merge) => ({
          startRow: merge.s.r,
          startColumn: merge.s.c,
          endRow: Math.min(merge.e.r, rowCount - 1),
          endColumn: Math.min(merge.e.c, columnCount - 1),
        }));
      const rowHeights = (worksheet["!rows"] || []).slice(0, rowCount).map((row) => Math.max(22, Math.min(120, row?.hpx || (row?.hpt ? row.hpt * 96 / 72 : 30))));
      const columnWidths = (worksheet["!cols"] || []).slice(0, columnCount).map((column) => Math.max(64, Math.min(420, column?.wpx || (column?.wch ? column.wch * 7.2 + 12 : 120))));
      const truncated = rawRange.e.r + 1 > rowCount || rawRange.e.c + 1 > columnCount || cells.length >= MAX_NON_EMPTY_CELLS;
      self.postMessage({ type: "sheet", name: event.data.name, rowCount, columnCount, cells, merges, rowHeights, columnWidths, truncated });
    } catch (error) {
      self.postMessage({ type: "error", message: messageForError(error) });
    }
  })();
});
