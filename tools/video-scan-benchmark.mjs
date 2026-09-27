// Explicit, isolated, read-only source benchmark. Never connects to the live
// instance or changes its libraries, cache, automatic scan setting or users.
// node tools/video-scan-benchmark.mjs --library <directory> [--server <index.mjs>]
//   [--iterations 3] [--output <result.json>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const args = Object.fromEntries(process.argv.slice(2).reduce((out, item, i, all) => item.startsWith('--') ? [...out, [item.slice(2), all[i + 1]]] : out, []));
if (!args.library) throw new Error('--library is required; choose a small, explicitly selected read-only sample');
const project = path.resolve(import.meta.dirname, '..');
const serverPath = path.resolve(args.server || path.join(project, 'server/index.mjs'));
const source = path.resolve(args.library), iterations = Math.max(1, Math.min(10, Number(args.iterations) || 3));
const output = path.resolve(args.output || path.join(project, 'data/video-scan-benchmark.json'));
const root = await mkdtemp(path.join(tmpdir(), 'lmd-video-benchmark-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sizeOf(directory) {
  let files = 0, bytes = 0;
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) { const child = await sizeOf(file); files += child.files; bytes += child.bytes; }
    else { files++; bytes += (await stat(file)).size; }
  }
  return { files, bytes };
}
const results = [];
for (let run = 0; run < iterations; run++) {
  const data = path.join(root, `run-${run}`); await mkdir(data);
  await writeFile(path.join(data, 'state.json'), JSON.stringify({ version: 12, libraries: [{ id: 'benchmark', path: source, name: 'Benchmark' }], media: [], jobs: [],
    settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false, videoPlayback: { encoder: 'libx264', releaseGraceSeconds: 0 } } }));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [serverPath], { cwd: project, windowsHide: true,
    env: { ...process.env, LMD_DATA_DIR: data, LMD_PORT: String(port), LMD_HOST: '127.0.0.1', LMD_FFMPEG_INSTALL_DIR: path.join(project, 'tools/ffmpeg') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stdout.resume(); child.stderr.on('data', bytes => { errors += bytes; });
  const base = `http://127.0.0.1:${port}`;
  const json = async (url, options) => {
    const response = await fetch(`${base}${url}`, options); const result = await response.json();
    if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  try {
    let healthy = false;
    for (let n = 0; n < 150; n++) { try { if ((await json('/api/health')).ok) { healthy = true; break; } } catch {} if (child.exitCode !== null) throw new Error(errors); await delay(100); }
    if (!healthy) throw new Error(`Server startup timeout: ${errors}`);
    const measureScan = async () => {
      const started = performance.now();
      const accepted = await json('/api/scan/start?mode=standard', { method: 'POST' });
      const acceptedMs = performance.now() - started; let firstVisibleMs = null, catalog, status;
      do {
        catalog = await json('/api/catalog');
        if (firstVisibleMs === null && catalog.media.length) firstVisibleMs = performance.now() - started;
        status = (await json('/api/scan/status')).scan;
        if (!status.scanning) {
          // Completion may fall between the two reads; take the final published
          // snapshot rather than reporting a stale empty catalog as success.
          catalog = await json('/api/catalog');
          if (firstVisibleMs === null && catalog.media.length) firstVisibleMs = performance.now() - started;
          break;
        }
        if (performance.now() - started > 300_000) throw new Error('Benchmark exceeded five minutes');
        await delay(25);
      } while (true);
      return { acceptedMs, firstVisibleMs, completedMs: performance.now() - started, count: catalog.media.length, phase: status.phase, error: status.lastError,
        completion: accepted.completion || null, cache: { subtitles: await sizeOf(path.join(data, 'cache/subtitles')), fonts: await sizeOf(path.join(data, 'cache/fonts')), thumbnails: await sizeOf(path.join(data, 'cache/thumbnails')) } };
    };
    const cold = await measureScan(), warm = await measureScan();
    const catalog = await json('/api/catalog'); let probeMs = null;
    if (catalog.media[0]) { const started = performance.now(); await json(`/api/media/${catalog.media[0].id}/info`); probeMs = performance.now() - started; }
    const saved = await readFile(path.join(data, 'state.json'), 'utf8'), state = JSON.parse(saved);
    const started = performance.now(); JSON.stringify(state); const serializationMs = performance.now() - started;
    const record = { run: run + 1, cold, warm, firstPlaybackProbeMs: probeMs, stateBytes: Buffer.byteLength(saved), serializationMs };
    results.push(record); console.log(JSON.stringify(record));
  } finally {
    child.kill(); await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(5000)]);
    await writeFile(path.join(data, 'server-stderr.log'), errors);
  }
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ serverPath, source, temporaryData: root, node: process.version,
  conditions: 'Fresh derived cache per run; OS file cache not flushed. Same instance warm rescan. Source files are read-only. First visibility is API polling, not rendered browser pixels. Playback metric covers probe only, not first frame.', results }, null, 2));
console.log(`Saved ${output}; isolated data retained at ${root}`);
