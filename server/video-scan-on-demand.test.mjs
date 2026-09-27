import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverVideos, createVideoChangeMonitor } from './video-discovery.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'lmd-stream-index-'));
const data = path.join(root, 'data'), library = path.join(root, 'library');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, base, errors = '';
async function request(endpoint, method = 'GET', body) {
  const response = await fetch(base + endpoint, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, value: await response.json() };
}
async function until(read, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await pause(15); }
  throw new Error('Timed out waiting for isolated scan: ' + errors);
}
try {
  await mkdir(data); await mkdir(library);
  await mkdir(path.join(library, 'empty', 'deep'), { recursive: true });
  await Promise.all(Array.from({ length: 45 }, (_, index) => writeFile(path.join(library, `${String(index).padStart(3, '0')}.mkv`), 'fixture')));
  await writeFile(path.join(library, '.partial.mp4'), 'unfinished');
  await writeFile(path.join(library, '000.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  await writeFile(path.join(data, 'state.json'), JSON.stringify({ version: 12, settings: { autoScanEnabled: false }, libraries: [], media: [] }));
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(project, 'server/index.mjs')], { cwd: project, env: { ...process.env, NODE_ENV: 'test', LMD_HOST: '127.0.0.1', LMD_PORT: String(port), LMD_DATA_DIR: data,
    // Only a cancellation/publication boundary fixture, never an HDD benchmark.
    LMD_TEST_SCAN_FILE_DELAY_MS: '35' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => { errors += chunk; });
  await until(() => request('/api/health').catch(() => null), result => result?.status === 200);
  assert.equal((await request('/api/libraries', 'POST', { folderPath: library })).status, 201);
  let result = await request('/api/video/scans', 'POST');
  assert.equal(result.status, 202); const id = result.value.taskId;
  assert.equal(result.value.completion, 'indexed');
  const repeat = await request('/api/video/scans', 'POST'); assert.equal(repeat.value.taskId, id);
  const intermediate = await until(() => request('/api/catalog'), result => result.value.media.length > 0 && result.value.scan.scanning);
  assert.ok(intermediate.value.media.length < 45);
  assert.equal(intermediate.value.media[0].metadata.state, 'unknown');
  result = await request(`/api/video/scans/${id}/cancel`, 'POST'); assert.equal(result.status, 202);
  const frozen = (await request('/api/catalog')).value.media.map(media => media.id);
  await until(() => request('/api/video/scans/current'), result => !result.value.scan.scanning);
  assert.deepEqual((await request('/api/catalog')).value.media.map(media => media.id), frozen, 'no buffered item publishes after cancellation');
  result = await request('/api/video/scans/current'); assert.equal(result.value.scan.phase, 'cancelled');
  assert.equal(result.value.scan.enabled, false, 'cancel never enables paused automatic indexing');
  result = await request('/api/scan', 'POST'); assert.equal(result.status, 200); assert.equal(result.value.count, 45);
  let catalog = (await request('/api/catalog')).value;
  assert.equal(catalog.scan.phase, 'indexed');
  assert.ok(catalog.media.every(media => media.thumbnailUrl === null && !media.fonts.length && media.sourceVersion === `${media.size}:${media.modifiedAt}`));
  const firstRevision = catalog.catalogRevision, revisions = catalog.media.map(media => media.entryRevision);
  await request('/api/scan', 'POST'); catalog = (await request('/api/catalog')).value;
  assert.equal(catalog.catalogRevision, firstRevision, 'unchanged scan does not publish a new catalog revision');
  assert.deepEqual(catalog.media.map(media => media.entryRevision), revisions);
  const status = (await request('/api/scan/status')).value;
  assert.equal(status.mediaTasks.metrics.submitted, 0, 'indexing never submits media extraction tasks');
  assert.equal(status.videoResources.subtitleExtractions, 0); assert.equal(status.videoResources.fontExtractions, 0);
  assert.deepEqual(await readdir(path.join(data, 'cache', 'subtitles')), []);
  const missingFont = await request('/api/media/' + catalog.media[0].id + '/fonts/unknown');
  assert.equal(missingFont.status, 404); assert.ok(missingFont.value.code, 'resource failures expose a machine-readable code');
  const objectHash = 'a'.repeat(64), objectDirectory = path.join(data, 'cache', 'fonts', 'objects', 'aa');
  await mkdir(objectDirectory, { recursive: true });
  const orphan = path.join(objectDirectory, objectHash), unrelated = path.join(data, 'cache', 'fonts', 'user-font.txt');
  await writeFile(orphan, 'expired generated bytes'); await writeFile(unrelated, 'keep');
  await utimes(orphan, new Date(0), new Date(0));
  const maintenance = await request('/api/video/cache/maintain', 'POST');
  assert.equal(maintenance.status, 200); assert.equal(maintenance.value.skipped, false);
  assert.equal(await stat(orphan).catch(() => null), null); assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  await rename(library, library + '-offline');
  result = await request('/api/scan', 'POST'); assert.equal(result.status, 500);
  catalog = (await request('/api/catalog')).value;
  assert.equal(catalog.media.length, 45); assert.equal(catalog.scan.phase, 'partial');
  assert.ok(catalog.media.every(media => media.availability === 'offline'));
  await rename(library + '-offline', library);
  await rm(path.join(library, '044.mkv'));
  await request('/api/scan', 'POST'); assert.equal((await request('/api/catalog')).value.media.length, 44);
  const stored = JSON.parse(await readFile(path.join(data, 'state.json'), 'utf8'));
  assert.equal(stored.settings.autoScanEnabled, false);

  const limited = { complete: true, errors: [], truncated: false }, candidates = [];
  for await (const file of discoverVideos(library, { extensions: new Set(['.mkv']), report: limited, maxFiles: 2 })) candidates.push(file);
  assert.equal(candidates.length, 2); assert.equal(limited.complete, false); assert.equal(limited.truncated, true); assert.ok(limited.resumeAt);
  const monitor = createVideoChangeMonitor({ libraries: () => [], debounceMs: 10000 });
  monitor.mark(library); const generation = monitor.snapshot(); monitor.mark(path.join(library, 'empty'));
  monitor.acknowledge(generation); assert.deepEqual(monitor.snapshot().scopes, [path.join(library, 'empty')]); monitor.close();
  console.log('PASS streaming visibility, ordinary cancellation, no extraction, warm revisions, offline protection, confirmed deletion, bounded discovery and dirty generations');
} finally {
  if (child) {
    await request('/api/service/stop', 'POST').catch(() => {});
    await Promise.race([new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }), pause(5000).then(() => child.kill())]);
  }
  await rm(root, { recursive: true, force: true });
}
