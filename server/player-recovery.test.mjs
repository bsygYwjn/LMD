import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
const project = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(project, '.player-recovery-'));
const source = await readFile(path.join(project, 'src/player/core.ts'), 'utf8');
await writeFile(path.join(temporary, 'core.mjs'), ts.transpileModule(source.replace(/"\.\/latest-task-queue(?:\.ts)?"/, '"../src/player/latest-task-queue.ts"'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const oldFetch = globalThis.fetch;
globalThis.window = new EventTarget();
class Video extends EventTarget {
  currentTime = 0; volume = 1; muted = false; playbackRate = 1; paused = true;
  buffered = { length: 0 }; seekable = { length: 0 };
  pause() { this.paused = true; } load() {} removeAttribute() {} canPlayType() { return 'probably'; }
}
const reply = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const info = { mediaId: 'good', duration: 60, container: 'mp4', tracks: [] };
const session = { sessionId: 'one', generation: 1, transport: 'file', strategy: 'DIRECT', duration: 60, timeOffset: 0,
  plan: { audio: null }, heartbeatSeconds: 1000, error: null };
let core;
try {
  const { PlaybackCore } = await import(pathToFileURL(path.join(temporary, 'core.mjs')));
  core = new PlaybackCore(new Video());
  let infos = 0, posts = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/info')) { infos++; await new Promise(resolve => setTimeout(resolve, 15)); return infos === 1 ? reply({ error: '无法分析这个媒体文件', code: 'PROBE_FAILED' }, 422) : reply(info); }
    if (options.method === 'POST') { posts++; return reply(session, 201); }
    return reply({ ok: true });
  };
  await core.load('good'); assert.equal(core.getState().errorCode, 'PROBE_FAILED'); assert.equal(core.getState().buffering, false);
  await Promise.all(Array.from({ length: 10 }, () => core.retry()));
  assert.equal(infos, 2); assert.equal(posts, 1); assert.equal(core.getState().error, '');
  let patches = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === 'PATCH') { const body = JSON.parse(options.body); patches.push(body); return reply({ ...session, generation: body.seekTime === undefined ? 1 : 2, error: body.seekTime === undefined ? { code: 'PIPELINE_FAILED', message: '媒体处理失败' } : null }); }
    if (options.method === 'POST') posts++;
    return reply({ ok: true });
  };
  await Promise.all(Array.from({ length: 10 }, () => core.retry()));
  assert.equal(posts, 1); assert.equal(patches.length, 2); assert.equal(patches[1].generation, 1); assert.equal(patches[1].seekTime, 0);
  assert.equal(core.getState().generation, 2);
  const reconciled = [];
  globalThis.fetch = async (_url, options = {}) => {
    reconciled.push(options.method || 'GET');
    if (options.method === 'PATCH' && JSON.parse(options.body).generation === 2)
      return reply({ error: '播放请求已被替换', code: 'STALE_SESSION' }, 409);
    if (!options.method || options.method === 'GET') return reply({ ...session, generation: 3, error: { code: 'PIPELINE_FAILED', message: '媒体处理失败' } });
    return reply({ ...session, generation: 4 });
  };
  await core.retry();
  assert.deepEqual(reconciled, ['PATCH', 'GET', 'PATCH']); assert.equal(core.getState().generation, 4);
  // Loading a damaged second item must clear the previous metadata; retry must
  // re-probe that item rather than creating a session for the first item.
  let requested = [];
  globalThis.fetch = async (url, options = {}) => {
    requested.push([url, options.method]);
    if (url.endsWith('/info')) return reply({ error: '无法分析这个媒体文件', code: 'PROBE_FAILED' }, 422);
    return reply({ ok: true });
  };
  await core.load('broken'); await core.retry();
  assert.equal(requested.filter(([url]) => url === '/api/media/broken/info').length, 2);
  assert.equal(requested.filter(([, method]) => method === 'POST').length, 0);
  assert.equal(core.getState().buffering, false);
  await core.destroy(); core = new PlaybackCore(new Video());
  let rejectOld;
  globalThis.fetch = (url) => url.includes('/old/') ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(reply({ error: 'new failure', code: 'PROBE_FAILED' }, 422));
  const old = core.load('old'); await core.load('new'); rejectOld(new Error('stale error')); await old;
  assert.equal(core.getState().error, 'new failure');
  console.log('PASS: metadata retry, concurrent retry deduplication, pipeline PATCH recovery, media switch isolation, stale failure guard');
} finally {
  await core?.destroy(); globalThis.fetch = oldFetch; delete globalThis.window;
  await rm(temporary, { recursive: true, force: true });
}
