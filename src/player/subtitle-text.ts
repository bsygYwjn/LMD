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

export function assToWebVtt(content: string) {
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

