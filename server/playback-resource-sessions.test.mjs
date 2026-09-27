import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlaybackService, sourceSignature } from './playback.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const eventually = async predicate => { const until = Date.now() + 3000; while (!predicate()) { if (Date.now() > until) throw new Error('Condition timeout'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const metadata = { version: 1, container: 'mp4', duration: 60, tracks: [{ id: '0', index: 0, type: 'video', codec: 'h264' }] };

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lmd-subtitle-session-')), media = { id: 'movie', path: path.join(root, 'movie.mp4') };
  await writeFile(media.path, 'read-only fixture'); const file = await stat(media.path); Object.assign(media, { size: file.size, modifiedAt: file.mtime.toISOString(), resourceDescriptorVersion: 1 });
  media.playbackMetadata = { ...metadata, sourceSignature: sourceSignature(media) };
  media.subtitles = [{ id: 'A', format: 'ASS', source: 'embedded', state: 'unknown', default: true }, { id: 'B', format: 'SRT', source: 'embedded', state: 'unknown' }];
  const state = { media: [media], settings: {} }, pending = [], allowed = new Set(['alice', 'bob']); let pins = 0, probe = null, probeCount = 0;
  const sendJson = (response, status, payload) => { const body = JSON.stringify(payload); response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); response.end(body); };
  const service = createPlaybackService({ appState: state, cacheDirectory: root, getMediaTools: () => ({ available: true }), saveState: async () => {},
    probeVideo: async (_file, _execute, { signal } = {}) => { probeCount++; if (probe) await probe.promise; signal?.throwIfAborted(); return { playbackMetadata: metadata }; },
    runCommand: async () => {}, spawnTracked: () => { throw new Error('Unnecessary A/V conversion'); },
    resources: { describe: async () => ({ subtitles: media.subtitles, fonts: [] }), status: () => ({}),
      ensureSubtitle: async (_media, trackId, options) => { const completion = deferred(); pending.push({ trackId, options, ...completion }); return completion.promise; },
      pinFonts: async (_media, fonts) => { pins += fonts.length; let released = false; return () => { if (!released) { released = true; pins -= fonts.length; } }; } },
    authorizedMediaForRequest: (request, response, id) => { if (id === media.id && allowed.has(request.headers['x-user'])) return media; sendJson(response, 403, { error: 'No access' }); return null; },
    accessContextForRequest: request => ({ user: { id: request.headers['x-user'] } }), requireLocalManagement: () => true,
    readJson: async request => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text || '{}'); }, sendJson,
    streamFile: (_request, response) => { response.end('audio/video bytes'); } });
  const server = createServer((req, res) => { const url = new URL(req.url, 'http://local'); void service.handleRequest(req, res, url, url.pathname); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, method = 'GET', body, user = 'alice') => fetch(base + url, { method, headers: { 'x-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  t.after(async () => { for (const item of pending) item.resolve({ subtitle: { id: item.trackId, format: 'SRT', url: '/ready' }, fonts: [] }); probe?.resolve(); await service.stop(); await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { request, media, service, allowed, pending, get pins() { return pins; }, get probeCount() { return probeCount; }, blockProbe() { probe = deferred(); delete media.playbackMetadata; return probe; } };
}

test('selected subtitle never blocks playback; rapid A → B → off and release reject late results', async t => {
  const h = await harness(t);
  const info = await h.request('/api/media/movie/info'); assert.equal(info.status, 200); assert.equal(h.pending.length, 0, 'details do not extract');
  const response = await h.request('/api/media/movie/playback-sessions', 'POST', { capabilities: { direct: { '0:none': true } }, subtitleTrackId: 'A', subtitleSelectionGeneration: 1 });
  assert.equal(response.status, 201); const session = await response.json(), endpoint = `/api/playback-sessions/${session.sessionId}`;
  assert.equal(session.subtitle.state, 'queued'); assert.equal(h.pending.length, 1);
  assert.equal(await (await h.request(session.url)).text(), 'audio/video bytes', 'media can flow while subtitle promise is unresolved');
  assert.equal((await h.request(endpoint, 'GET', undefined, 'bob')).status, 403, 'sharing does not expose another device session');
  const second = await (await h.request(endpoint, 'PATCH', { subtitleTrackId: 'B', subtitleSelectionGeneration: 2 })).json();
  assert.equal(second.generation, session.generation); assert.equal(h.pending[0].options.signal.aborted, true);
  await h.request(endpoint, 'PATCH', { subtitleTrackId: null, subtitleSelectionGeneration: 3 });
  assert.equal(h.pending[1].options.signal.aborted, true);
  h.pending[0].resolve({ subtitle: { id: 'A', url: '/stale-a' }, fonts: [{ id: 'font-a' }] });
  h.pending[1].resolve({ subtitle: { id: 'B', url: '/stale-b' }, fonts: [] });
  await new Promise(resolve => setTimeout(resolve, 5));
  const current = await (await h.request(endpoint)).json(); assert.equal(current.subtitle.state, 'off'); assert.equal(current.subtitle.subtitle, null); assert.equal(h.pins, 0);
  assert.equal((await h.request(endpoint, 'PATCH', { subtitleTrackId: 'A', subtitleSelectionGeneration: 2 })).status, 409);
  await h.request(endpoint, 'PATCH', { subtitleTrackId: 'A', subtitleSelectionGeneration: 4 });
  h.pending[2].resolve({ subtitle: { id: 'A', format: 'ASS', url: '/correct' }, fonts: [{ id: 'font-a' }] }); await eventually(() => h.pins === 1);
  assert.equal((await (await h.request(endpoint)).json()).subtitle.state, 'ready');
  await h.request(endpoint, 'DELETE'); assert.equal(h.pins, 0); assert.equal((await h.request(endpoint)).status, 410);
});

test('permission revoked while probe is queued prevents info disclosure and session creation', async t => {
  const h = await harness(t), probe = h.blockProbe();
  const viewing = h.request('/api/media/movie/info'); const creating = h.request('/api/media/movie/playback-sessions', 'POST', { capabilities: { direct: { '0:none': true } } });
  await eventually(() => h.probeCount === 1); h.allowed.delete('alice'); probe.resolve();
  assert.equal((await viewing).status, 403); assert.equal((await creating).status, 403); assert.equal(h.service.status().sessions, 0); assert.equal(h.probeCount, 1);
});

test('probe subscriptions cancel independently and a changed source invalidates an active session', async t => {
  const h = await harness(t), probe = h.blockProbe(), first = new AbortController(), second = new AbortController();
  const abandoned = h.service.info(h.media, { signal: first.signal }); const kept = h.service.info(h.media, { signal: second.signal });
  await eventually(() => h.probeCount === 1); first.abort(); await assert.rejects(abandoned, { name: 'AbortError' }); probe.resolve();
  assert.equal((await kept).sourceSignature, sourceSignature(h.media)); assert.equal(h.probeCount, 1);
  const session = await (await h.request('/api/media/movie/playback-sessions', 'POST', { capabilities: { direct: { '0:none': true } } })).json();
  await writeFile(h.media.path, 'replacement source');
  assert.equal((await h.request(`/api/playback-sessions/${session.sessionId}`)).status, 409); assert.equal(h.service.status().sessions, 0);
});
