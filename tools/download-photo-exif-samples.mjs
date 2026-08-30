import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT_DIRECTORY = path.resolve(process.cwd(), "assets", "photo-exif-samples");
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, "sources.json");
const TARGET_COUNT = 100;
const API_URL = "https://commons.wikimedia.org/w/api.php";

async function request(url, options = {}, attempts = 10) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45_000), headers: { "User-Agent": "LMD-Photo-EXIF-Sample-Collector/1.0 (local testing)", ...options.headers } });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 2000));
      continue;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  throw lastError;
}

async function api(parameters) {
  const query = new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...parameters });
  return (await request(`${API_URL}?${query}`)).json();
}

function hasRequiredExif(metadata = []) {
  const tags = new Map(metadata.map((entry) => [entry.name, entry.value]));
  return tags.has("DateTimeOriginal") && tags.has("GPSLatitude") && tags.has("GPSLongitude");
}

function safeName(value, index) {
  const extension = path.extname(value).toLowerCase() === ".jpeg" ? ".jpg" : ".jpg";
  const stem = value.replace(/^File:/, "").replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 96) || "photo";
  return `${String(index).padStart(3, "0")}-${stem}${extension}`;
}

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const collected = [];
let continuation = null;
let page = 0;
while (collected.length < TARGET_COUNT && page < 40) {
  const result = await api({
    action: "query",
    generator: "categorymembers",
    gcmtitle: "Category:Taken with Google Pixel 8 Pro",
    gcmtype: "file",
    gcmlimit: "50",
    ...(continuation ? { gcmcontinue: continuation } : {}),
    prop: "imageinfo",
    iiprop: "url|size|mime|metadata|extmetadata",
  });
  continuation = result.continue?.gcmcontinue || null;
  const pages = Object.values(result.query?.pages || {});
  for (const pageInfo of pages) {
    if (collected.length >= TARGET_COUNT) break;
    const image = pageInfo.imageinfo?.[0];
    if (!image || image.mime !== "image/jpeg" || !hasRequiredExif(image.metadata)) continue;
    const name = safeName(pageInfo.title, collected.length + 1);
    collected.push({
      file: name,
      title: pageInfo.title,
      sourceUrl: image.descriptionurl,
      originalUrl: image.url,
      bytes: image.size,
      exif: image.metadata.filter((entry) => ["DateTimeOriginal", "GPSLatitude", "GPSLongitude", "GPSAltitude", "Make", "Model"].includes(entry.name)),
      license: image.extmetadata?.LicenseShortName?.value || null,
      author: image.extmetadata?.Artist?.value || null,
      credit: image.extmetadata?.Credit?.value || null,
    });
  }
  page += 1;
  if (!continuation) break;
}
if (collected.length < TARGET_COUNT) throw new Error(`Only found ${collected.length} JPEG files with DateTimeOriginal, GPSLatitude, and GPSLongitude.`);
let downloadCursor = 0;
async function downloadWorker() {
  while (downloadCursor < collected.length) {
    const index = downloadCursor++;
    const item = collected[index];
    const destination = path.join(OUTPUT_DIRECTORY, item.file);
    const existing = await stat(destination).catch(() => null);
    if (!existing?.isFile() || !existing.size) {
      const temporary = `${destination}.partial`;
      const response = await request(item.originalUrl);
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()));
      await rename(temporary, destination).catch(async (error) => { await unlink(temporary).catch(() => {}); throw error; });
    }
    console.log(`${index + 1}/${TARGET_COUNT} ${item.file}`);
  }
}
await Promise.all(Array.from({ length: 1 }, () => downloadWorker()));
await writeFile(MANIFEST_PATH, `${JSON.stringify({ source: "Wikimedia Commons", generatedAt: new Date().toISOString(), count: collected.length, items: collected }, null, 2)}\n`, "utf8");
console.log(`Saved ${collected.length} EXIF samples to ${OUTPUT_DIRECTORY}`);
