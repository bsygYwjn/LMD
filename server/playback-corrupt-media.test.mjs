import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
const project = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'lmd-corrupt-media-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (exe, args) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { windowsHide: true }); let stderr = '';
  child.stdout.resume(); child.stderr.on('data', chunk => stderr += chunk);
  child.once('error', reject); child.once('close', code => code ? reject(new Error(stderr)) : resolve());
});
let server;
try {
  const library = path.join(temporary, 'library'), data = path.join(temporary, 'data');
  await mkdir(library); await mkdir(data);
  const good = path.join(library, 'S01E01-good.mp4'), bad = path.join(library, 'S01E09-corrupt.mp4');
  await run(path.join(project, 'tools/ffmpeg/bin/ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=160x90:rate=24:duration=1', '-c:v', 'libx264', good]);
  await writeFile(bad, 'This is an intentionally corrupt MP4 acceptance fixture.');
  await writeFile(path.join(data, 'state.json'), JSON.stringify({ settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false }, libraries: [], media: [], jobs: [] }));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  server = spawn(process.execPath, [path.join(project, 'server/index.mjs')], { cwd: project, env: { ...process.env, LMD_HOST: '127.0.0.1', LMD_PORT: String(port), LMD_DATA_DIR: data }, windowsHide: true });
  let logs = ''; server.stdout.resume(); server.stderr.on('data', chunk => logs += chunk);
  const base = `http://127.0.0.1:${port}`;
  const request = (url, method = 'GET', body) => fetch(base + url, { method, signal: AbortSignal.timeout(30000), ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await request('/api/health')).ok) break; } catch {}
    assert.equal(server.exitCode, null, logs); await delay(100);
  }
  assert.equal((await request('/api/libraries', 'POST', { folderPath: library, name: 'corrupt acceptance' })).status, 201);
  const scan = await request('/api/scan', 'POST'); assert.equal(scan.status, 200, logs);
  const catalog = await scan.json(); assert.equal(catalog.count, 2, JSON.stringify(catalog));
  const damaged = catalog.media.find(item => item.fileName.includes('S01E09'));
  const healthy = catalog.media.find(item => item.fileName.includes('S01E01'));
  assert.ok(damaged.probeError); assert.ok(!healthy.probeError);
  const healthyInfo = await (await request(`/api/media/${healthy.id}/info`)).json();
  assert.ok(healthyInfo.duration > 0); assert.ok(healthyInfo.tracks.some(track => track.type === 'video'));
  const status = async () => (await (await request('/api/settings/video-playback')).json()).status;
  const before = await status();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await request(`/api/media/${damaged.id}/info`, method)).status, 405);
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const [url, method, body] of [[`/api/media/${damaged.id}/info`, 'GET'], [`/api/media/${damaged.id}/playback-sessions`, 'POST', {}]]) {
      const response = await request(url, method, body); assert.equal(response.status, 422);
      const payload = await response.json(); assert.equal(payload.code, 'PROBE_FAILED'); assert.match(payload.error, /无法分析/);
    }
  }
  assert.deepEqual(await status(), before);
  assert.equal((await request(`/api/media/${healthy.id}/info`)).status, 200);
  // Repair only this test's damaged fixture, then retry without restarting.
  await copyFile(good, bad);
  assert.equal((await request(`/api/media/${damaged.id}/info`)).status, 200);
  console.log('PASS: real scan keeps good and corrupt media, 422 PROBE_FAILED, repeated failure zero sessions/cache, repaired source recovers');
  await request('/api/service/stop', 'POST', {});
} finally {
  if (server && server.exitCode === null) { server.kill(); await Promise.race([new Promise(resolve => server.once('close', resolve)), delay(5000)]); }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
