// Measures complete selected-track extraction and byte-preserving font sharing
// from explicitly chosen read-only media. All outputs stay in isolated temp data.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createMediaTaskScheduler } from '../server/media-tasks.mjs';
import { createVideoResourceService, describeVideoResources } from '../server/video-resources.mjs';
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1];
if (!process.argv.includes('--manifest')) throw new Error('--manifest requires a JSON list of {file} sample paths');
const sources = JSON.parse(await readFile(arg('manifest'), 'utf8'));
if (!sources.length || sources.length > 4) throw new Error('Choose one to four read-only sample files');
const project = path.resolve(import.meta.dirname, '..'), root = await mkdtemp(path.join(tmpdir(), 'lmd-resource-benchmark-'));
const ffmpeg = path.join(project, 'tools/ffmpeg/bin/ffmpeg.exe'), ffprobe = path.join(project, 'tools/ffmpeg/bin/ffprobe.exe');
const calls = [];
function command(executable, args, timeoutMs, options = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, cwd: options.cwd });
    let stdout = '', stderr = '', failure;
    options.onChild?.(child);
    const timer = setTimeout(() => { failure = new Error('Media tool timeout'); child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer);
      calls.push({ kind: executable === ffprobe ? 'probe' : args.some(x => x.startsWith('-dump_attachment')) ? 'fonts' : 'subtitle', durationMs: performance.now() - started, exitCode: code });
      if (failure || code) reject(failure || new Error(stderr)); else resolve({ stdout, stderr });
    });
  });
}
const state = { media: [], libraries: [], settings: {} }, scheduler = createMediaTaskScheduler();
const cache = path.join(root, 'cache'); await mkdir(cache);
let saves = 0;
const service = createVideoResourceService({ appState: state, cacheDirectory: cache, scheduler,
  getMediaTools: () => ({ available: true, ffmpeg }), runCommand: command,
  saveState: async () => { const staged = path.join(root, `state-${++saves}.part`); await writeFile(staged, JSON.stringify(state)); await rename(staged, path.join(root, 'state.json')); } });
const results = [];
async function sizeOf(directory) {
  let files = 0, bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { const sub = await sizeOf(file); files += sub.files; bytes += sub.bytes; }
    else { files++; bytes += (await stat(file)).size; }
  }
  return { files, bytes };
}
try {
  for (const [index, sample] of sources.entries()) {
    const file = path.resolve(sample.file), s = await stat(file), id = createHash('sha256').update(file.toLowerCase()).digest('hex').slice(0, 12);
    state.libraries.push({ id, path: path.dirname(file) });
    const probeStart = performance.now();
    const { stdout } = await command(ffprobe, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,extradata_size:stream_tags:stream_disposition', '-of', 'json', file], 20_000);
    const probe = JSON.parse(stdout);
    const media = { id, libraryId: id, path: file, size: s.size, modifiedAt: s.mtime.toISOString(), subtitles: [], fonts: [],
      embeddedSubtitleStreams: probe.streams.filter(stream => stream.codec_type === 'subtitle' && ['ass','ssa'].includes(stream.codec_name)).map(stream => ({ index: stream.index, format: stream.codec_name.toUpperCase(), language: stream.tags?.language, title: stream.tags?.title, default: Boolean(stream.disposition?.default) })),
      embeddedFontStreams: probe.streams.filter(stream => stream.codec_type === 'attachment' && /\.(ttf|otf|ttc|woff2?)$/i.test(stream.tags?.filename || '')).map(stream => ({ index: stream.index, fileName: stream.tags.filename, size: stream.extradata_size })) };
    Object.assign(media, describeVideoResources(media)); state.media.push(media);
    const probeMs = performance.now() - probeStart;
    if (!media.subtitles.length) throw new Error('Sample has no ASS/SSA track');
    const selected = media.subtitles.find(track => track.default) || media.subtitles[0];
    const callsBefore = calls.length, started = performance.now();
    const prepared = await service.ensureSubtitle(media, selected.id);
    const preparationMs = performance.now() - started;
    const warmStart = performance.now(); await service.ensureSubtitle(media, selected.id); const warmMs = performance.now() - warmStart;
    const result = { sample: index + 1, sourceBytes: s.size, subtitleTracks: media.subtitles.length, fontAttachments: media.embeddedFontStreams.length,
      preparedTracks: media.subtitles.filter(track => track.state === 'ready').length, preparedFonts: prepared.fonts.length, probeMs, preparationMs, warmMs,
      toolCalls: calls.slice(callsBefore), resources: service.status(), storage: { subtitles: await sizeOf(path.join(cache, 'subtitles')), fonts: await sizeOf(path.join(cache, 'fonts')), total: await sizeOf(cache) } };
    results.push(result); console.log(JSON.stringify(result));
  }
} finally { await service.stop(); await scheduler.close(); }
const output = path.resolve(process.argv.includes('--output') ? arg('output') : path.join(project, 'data/video-resource-benchmark.json'));
await writeFile(output, JSON.stringify({ conditions: 'Real complete source files; isolated derived cache; OS cache not flushed; sequential samples; no playback rendering; alias-parser timing excluded (object and byte validation included).', root, results }, null, 2));
console.log(`Saved ${output}; original media unchanged; isolated artifacts retained at ${root}`);
