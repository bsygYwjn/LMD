import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlaybackService } from './playback.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'lmd-boundaries-'));
let probes = 0, saves = 0, broken = false;
const media = { id: 'sample', path: path.join(temporary, 'sample.mp4') };
await writeFile(media.path, 'test fixture');
const metadata = { version: 1, container: 'mp4', duration: 60, tracks: [{ id: '0', index: 0, type: 'video', codec: 'h264' }] };
const service = createPlaybackService({
  appState: { media: [media], settings: {} }, cacheDirectory: temporary,
  getMediaTools: () => ({ available: true }),
  probeVideo: async () => { probes++; if (broken) throw new Error('corrupt bytes'); return { playbackMetadata: metadata }; },
  saveState: async () => { saves++; },
  spawnTracked: () => { throw new Error('Unexpected FFmpeg spawn'); },
  runCommand: async () => {}, authorizedMediaForRequest: () => media,
  accessContextForRequest: () => null, requireLocalManagement: () => true,
  readJson: async request => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text || '{}'); },
  sendJson: (response, status, payload) => { const body = JSON.stringify(payload); response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); response.end(body); },
  streamFile: () => { throw new Error('Unexpected stream'); },
});
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  void service.handleRequest(req, res, url, url.pathname);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (url, method = 'GET', body) => fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
try {
  const before = service.status();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request('/api/media/sample/info', method);
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request('/api/media/sample/playback-sessions', method)).status, 405);
  assert.deepEqual(service.status(), before); assert.equal(probes, 0); assert.equal(saves, 0);
  assert.deepEqual(await readdir(path.join(temporary, 'playback')), []);
  const head = await request('/api/media/sample/info', 'HEAD');
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  const created = await request('/api/media/sample/playback-sessions', 'POST', { capabilities: { direct: { '0:none': true } } });
  assert.equal(created.status, 201); const session = await created.json();
  const endpoint = `/api/playback-sessions/${session.sessionId}`;
  assert.equal((await request(endpoint, 'HEAD')).status, 200);
  for (const [url, allowed] of [[endpoint, 'GET, HEAD, PATCH, DELETE'], [endpoint + '/file', 'GET, HEAD']]) {
    const response = await request(url, 'POST'); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), allowed);
  }
  assert.equal((await request(endpoint, 'PATCH', { generation: 1, seekTime: 20 })).status, 200);
  for (const body of [{ generation: 1, seekTime: 5, position: 5 }, { generation: 1, position: 3 }, { seekTime: 2, position: 2 }]) {
    assert.equal((await request(endpoint, 'PATCH', body)).status, 409);
    const current = await (await request(endpoint)).json(); assert.equal(current.requestedTime, 20); assert.equal(current.generation, 2);
  }
  await request(endpoint, 'DELETE');
  assert.equal((await request(endpoint)).status, 410);
  delete media.playbackMetadata; broken = true;
  for (let i = 0; i < 3; i++) {
    const response = await request('/api/media/sample/info'); assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'PROBE_FAILED');
  }
  assert.equal(service.status().sessions, 0); assert.equal(service.status().pipelinesCreated, 0);
  broken = false; assert.equal((await request('/api/media/sample/info')).status, 200);
  console.log('PASS: method matrix, Allow, HEAD, zero side effects, stale generations, probe recovery');
} finally {
  await service.stop(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
