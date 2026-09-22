// Isolated browser regression: serves dist with synthetic media only.
// Run after building: node tools/library-browser-regression.mjs
// Requires optional Playwright + Chromium. LMD_PLAYWRIGHT_MODULE may point to
// an installed playwright/index.mjs file URL. Never contacts the live service.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.LMD_PLAYWRIGHT_MODULE || "playwright");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.env.LMD_FRONTEND_DIST || path.join(root, "dist"));
const scan = { scanning: false, phase: "idle", progressPercent: null, processedFiles: 0, totalFiles: 0, lastError: null };
const folder = (id, count) => ({ id, parentId: null, name: id, title: id, configured: false, directMediaCount: count, mediaCount: count, childCount: 0, coverMediaId: null });
const photos = Array.from({ length: 95 }, (_, i) => ({ id: `p${i}`, libraryId: "photos", title: `Photo ${i}`, fileName: `${String(i).padStart(3, "0")}.svg`, extension: "SVG", size: 200, modifiedAt: "2026-01-01", width: 300, height: 200, aspectRatio: 1.5, folderId: "photos", thumbnailUrl: "/fixture/image.svg", thumbnailSrcSet: null, previewUrl: "/fixture/image.svg", downloadUrl: "/fixture/image.svg", previewAvailable: true }));
const tracks = [1, 2].map(i => ({ id: `m${i}`, libraryId: "music", title: `Track ${i}`, fileName: `track-${i}.wav`, extension: "WAV", size: 160044, modifiedAt: "2026-01-01", artists: ["Fixture"], album: "Album", albumArtist: "Fixture", genres: [], year: null, discNumber: 1, trackNumber: i, durationSeconds: 120, bitrate: 128000, sampleRate: 8000, bitDepth: 16, channels: 1, codec: "pcm_s16le", container: "wav", lossless: true, tags: [], folderId: "music", streamUrl: "/fixture/audio.wav", compatibleUrl: null, preferredMime: "audio/wav", coverUrls: null, lyricsUrl: null, lyrics: null, compatibleStatus: "not-needed", metadataSource: "local", externalIds: {} }));
const documents = ["TXT", "EPUB", "PDF"].map(extension => ({ id: extension.toLowerCase(), libraryId: "reading", title: `${extension} fixture`, fileName: `fixture.${extension.toLowerCase()}`, extension, kind: "ebook", size: 1024, modifiedAt: "2026-01-01", folderId: "reading", fileUrl: `/fixture/book.${extension.toLowerCase()}`, thumbnailUrl: null }));
const jsonRoutes = new Map([
  ["/api/auth/status", { enabled: false, authenticated: true, user: null }],
  ["/api/catalog", { media: [], folders: [], groups: [], scan }],
  ["/api/photos/catalog", { items: photos, folders: [folder("photos", photos.length)], scan }],
  ["/api/music/catalog", { tracks, folders: [{ ...folder("music", 2), kind: "music" }], scan }],
  ["/api/reading/catalog", { items: documents, folders: [{ ...folder("reading", 3), kind: "reading", ebookCount: 3, spreadsheetCount: 0 }], scan }],
]);

function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), bytes = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    parts.push(header, filename, bytes); central.push(directory, filename); offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const epub = zip({
  mimetype: "application/epub+zip",
  "META-INF/container.xml": '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "book.opf": '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Regression book</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>',
  "nav.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>',
  "chapter.xhtml": `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body>${Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i}. A long synthetic paragraph used to verify reader preferences across page turns.</p>`).join("")}</body></html>`,
});
const pdfObjects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R >>", "<< /Length 0 >>\nstream\n\nendstream"];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of pdfObjects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const audio = Buffer.alloc(44 + 8000 * 2 * 120);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
const fixtureRoutes = new Map([
  ["/fixture/book.epub", ["application/epub+zip", epub]],
  ["/fixture/book.pdf", ["application/pdf", Buffer.from(pdf)]],
  ["/fixture/book.txt", ["text/plain; charset=utf-8", Buffer.from(Array.from({ length: 2000 }, (_, i) => `Line ${i}: reader scroll regression.`).join("\n"))]],
  ["/fixture/image.svg", ["image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#427"/></svg>')]],
  ["/fixture/audio.wav", ["audio/wav", audio]],
]);
let pdfRequests = 0, delayedPdfModules = 0;
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = createServer(async (request, response) => {
  try {
    const route = new URL(request.url, "http://fixture").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (jsonRoutes.has(route)) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(jsonRoutes.get(route))); return; }
    if (fixtureRoutes.has(route)) {
      if (route.endsWith(".pdf")) pdfRequests++;
      const [type, bytes] = fixtureRoutes.get(route); response.setHeader("Content-Type", type); response.end(bytes); return;
    }
    if (route.startsWith("/api/")) { response.writeHead(404, { "Content-Type": "application/json" }); response.end('{"error":"Unknown fixture route"}'); return; }
    if (/\/pdf-[^/]+\.js$/.test(route)) { delayedPdfModules++; await delay(500); }
    const filename = path.resolve(dist, `.${route === "/" ? "/index.html" : route}`);
    if (!filename.startsWith(`${dist}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    response.setHeader("Content-Type", mime[path.extname(filename)] || "application/octet-stream"); response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser, session;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  session = { send: (method, params) => cdp.send(method, params), evaluate: expression => page.evaluate(expression), waitFor: expression => page.waitForFunction(expression, null, { timeout: 20000 }) };
  await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Network.enable")]);
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const go = query => page.goto(`${base}/${query}`, { waitUntil: "domcontentloaded" });
  const click = selector => session.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = expression => session.waitFor(expression);

  await go("");
  await wait("document.querySelectorAll('.appbar-nav button').length === 4");
  assert.deepEqual(await session.evaluate("[...document.querySelectorAll('.appbar-nav button')].map(button => button.textContent)"), ["视频", "音乐", "电子书", "图片"]);
  assert.equal(await session.evaluate("document.querySelector('.appbar-nav .is-active').textContent"), "视频");
  console.log("PASS library: video home and all four media navigation entries render");

  await go("?section=photos&folder=photos");
  await wait("document.querySelectorAll('.ph-item').length === 80");
  await click(".ph-item button");
  await wait("document.querySelector('.pviewer')");
  await session.evaluate("history.back()");
  await wait("document.querySelector('.ph-sentinel')");
  await session.evaluate("document.querySelector('.ph-sentinel').scrollIntoView()");
  await wait("document.querySelectorAll('.ph-item').length === 95");
  console.log("PASS photos: navigating back from viewer reconnects infinite scrolling (95 images)");

  await go("?section=reading&folder=reading&document=txt");
  await wait("document.querySelector('.text-scroll pre')");
  await session.evaluate("document.querySelector('.text-scroll').scrollTop = 1800");
  await delay(300);
  await click('[title="增大字号"]');
  await delay(150);
  assert.ok(await session.evaluate("document.querySelector('.text-scroll').scrollTop > 1500"), "font size must not restore the opening scroll position");
  await click(".text-reader .reader-toolbar .btn");
  await delay(150);
  assert.ok(await session.evaluate("document.querySelector('.text-scroll').scrollTop > 1500"), "paper change must not reset the scroll position");
  console.log("PASS TXT: font and paper changes preserve the current reading position");

  await go("?section=reading&folder=reading&document=epub");
  await wait("document.querySelector('foliate-view')?.lastLocation && !document.querySelector('.foliate-reader .reader-loading')");
  await click('[title="增大字号"]');
  await session.evaluate("(() => { const select = document.querySelector('.foliate-reader label select'); select.value = '1.8'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await session.evaluate("document.querySelector('foliate-view').goToFraction(.4)");
  await wait("JSON.parse(localStorage.getItem('lmd-reading-v1:epub:1024+2026-01-01')).fraction > .2");
  const preferences = await session.evaluate("JSON.parse(localStorage.getItem('lmd-reading-v1:epub:1024+2026-01-01'))");
  assert.equal(preferences.fontSize, 110); assert.equal(preferences.lineHeight, 1.8);
  await go("?section=reading&folder=reading&document=epub");
  await wait("document.querySelector('foliate-view')?.lastLocation && !document.querySelector('.foliate-reader .reader-loading')");
  assert.ok(await session.evaluate("document.querySelector('.foliate-reader .reader-toolbar').textContent.includes('110%')"));
  console.log("PASS EPUB: changing preferences, relocating, and reopening preserves font and line spacing");

  await go("?section=music&folder=music");
  await wait("document.querySelectorAll('.track-row').length === 2");
  const beforeOpen = await session.evaluate("history.length");
  await click(".track-row");
  await wait("new URL(location.href).searchParams.get('track') === 'm1'");
  assert.equal(await session.evaluate("history.length"), beforeOpen + 1, "explicit track opens must push history");
  await click('[aria-label="下一首"]');
  await wait("new URL(location.href).searchParams.get('track') === 'm2'");
  assert.equal(await session.evaluate("history.length"), beforeOpen + 1, "queue changes must replace history");
  await session.evaluate("history.back()");
  await wait("document.querySelectorAll('.track-row').length === 2 && !new URL(location.href).searchParams.has('track')");
  console.log("PASS music: explicit opens push, queue changes replace, and browser back returns to the library");

  await go("?section=reading&folder=reading&document=pdf");
  const deadline = Date.now() + 10000;
  while (!delayedPdfModules && Date.now() < deadline) await delay(20);
  assert.ok(delayedPdfModules, "the PDF module must begin loading before leaving the reader");
  await session.evaluate("[...document.querySelectorAll('.appbar-nav button')].find(button => button.textContent === '图片').click()");
  await wait("document.querySelector('.ph-view')");
  await delay(800);
  assert.equal(pdfRequests, 0, "leaving during dynamic import must not create an orphaned PDF task");
  await go("?section=reading&folder=reading&document=pdf");
  await wait("document.querySelector('.pdf-stage canvas')?.width > 300 && !document.querySelector('.pdf-stage .reader-loading')");
  assert.ok(pdfRequests > 0, "PDF still loads when the reader remains mounted");
  console.log("PASS PDF: leaving during module loading cancels work; reopening renders normally");
  assert.deepEqual(pageErrors, [], "all library flows must complete without uncaught browser errors");
  console.log("PASS browser: all library flows complete without uncaught exceptions");
} finally {
  await browser?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
