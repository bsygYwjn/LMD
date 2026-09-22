import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

const temporary = await mkdtemp(path.join(tmpdir(), 'lmd-label-http-'));
const data = path.join(temporary, 'data'), library = path.join(temporary, 'videos');
await mkdir(data); await mkdir(path.join(library, 'Work', 'Season 1'), { recursive: true });
const stableId = p => createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);
const video = path.join(library, 'Work', 'Season 1', '[DBD-Raws][Hibike! Euphonium 3][01][1080P].mp4');
await writeFile(video, 'immutable test video');
const media = { id: 'test-video', libraryId: 'lib', path: video, title: 'scan title', fileName: path.basename(video), extension: 'MP4', size: 20, modifiedAt: '2026-01-01T00:00:00Z', tags: [], subtitles: [], fonts: [], posterHue: 200, videoCodec: 'h264', audioCodec: 'aac' };
await writeFile(path.join(data, 'state.json'), JSON.stringify({ version: 11, libraries: [{ id: 'lib', name: '测试视频库', path: library }], media: [media], jobs: [], settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false }, displayGroups: [] }));
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;
async function start() {
  child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), env: { ...process.env, LMD_DATA_DIR: data, LMD_PORT: String(port), LMD_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('test server timeout ' + output);
}
async function req(route, body, method = body ? 'POST' : 'GET', extra = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { code: response.status, json: await response.json() };
}
async function stop() { if (!child || child.exitCode !== null) return; const done = new Promise(resolve => child.once('exit', resolve)); await req('/api/service/stop', {}); await done; }
try {
  await start();
  const targets = (await req('/api/labels/targets')).json;
  assert.ok(targets.some(t => t.name === 'Work' && t.kind === 'folder'));
  assert.ok(!JSON.stringify(targets).includes(library));
  assert.equal((await req('/api/labels/claim', {}, 'POST', { Origin: 'https://evil.example' })).code, 403);
  const batch = (await req('/api/labels/claim', { id: media.id })).json;
  const result = { batchId: batch.batchId, groups: batch.groups.map(g => ({ id: g.id, version: g.version, status: 'completed', titles: { title: '吹响吧！上低音号', originalTitle: '響け！ユーフォニアム', sources: ['https://anime-eupho.com/'], evidence: '模拟 Agent 固定结果，用于接口测试。' }, episodes: [{ slot: 1, originalEpisodeTitle: 'あらたなユーフォニアム' }] })) };
  assert.equal((await req('/api/labels/validate', result)).json.valid, true);
  // Live claims survive restart.
  await stop(); await start();
  assert.equal((await req('/api/labels/apply', result)).json.success, 1);
  assert.equal((await req('/api/labels/apply', result)).json.duplicate, true);
  let catalog = (await req('/api/catalog')).json;
  assert.equal(catalog.media[0].title, 'scan title');
  assert.equal(catalog.media[0].display.title, '吹响吧！上低音号');
  assert.equal(catalog.media[0].display.originalEpisodeTitle, 'あらたなユーフォニアム');
  assert.ok(!JSON.stringify(catalog).includes(library));
  assert.equal((await req('/api/labels/test-video', { season: 2 }, 'PATCH')).code, 400);
  assert.equal((await readFile(video, 'utf8')), 'immutable test video');
  const stream = await fetch(base + '/api/media/test-video/stream', { headers: { Range: 'bytes=0-4' } });
  assert.equal(stream.status, 206); assert.equal(await stream.text(), 'immut');
  await stop(); await start();
  catalog = (await req('/api/catalog')).json;
  assert.equal(catalog.media[0].display.title, '吹响吧！上低音号');
  const work = targets.find(t => t.name === 'Work');
  await req('/api/labels/' + work.id, { clear: true }, 'PATCH');
  await req('/api/labels/' + work.id, { title: '中间目录作品名', originalTitle: 'Original Work' }, 'PATCH');
  catalog = (await req('/api/catalog')).json;
  assert.equal(catalog.media[0].display.title, '中间目录作品名');
  assert.equal(catalog.folders.find(f => f.name === 'Work').originalTitle, 'Original Work');
  assert.equal((await req('/api/labels/claim', {})).json.groups.length, 0);
  await req('/api/labels/' + work.id, { originalTitle: 'Original-only Work' }, 'PATCH');
  catalog = (await req('/api/catalog')).json;
  assert.equal(catalog.folders.find(f => f.name === 'Work').title, 'Original-only Work');
  console.log('labels HTTP: local origin guard, intermediate folder, single override, claim/apply restart, idempotency, immutable source, byte-range playback passed');
} finally { await stop(); await rm(temporary, { recursive: true, force: true }); }
