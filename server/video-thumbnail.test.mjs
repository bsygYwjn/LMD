import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'lmd-video-thumbnail-'));
const data = path.join(temporary, 'data'), library = path.join(temporary, 'library');
const ffmpeg = path.join(project, 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, logs = '', base;

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(Buffer.concat(stdout).toString('utf8'))
      : reject(new Error(Buffer.concat(stderr).toString('utf8'))));
  });
}

async function frameContrast(filePath) {
  const output = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', filePath,
    '-vf', 'signalstats,metadata=mode=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
  const low = Number(output.match(/lavfi\.signalstats\.YLOW=([\d.]+)/)?.[1]);
  const high = Number(output.match(/lavfi\.signalstats\.YHIGH=([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(low) && Number.isFinite(high), 'FFmpeg should report frame luminance');
  return high - low;
}

async function start() {
  server = spawn(process.execPath, [path.join(project, 'server', 'index.mjs')], {
    cwd: project, env: { ...process.env, NODE_ENV: 'test', LMD_HOST: '127.0.0.1',
      LMD_PORT: base.split(':').at(-1), LMD_DATA_DIR: data },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.resume();
  server.stderr.on('data', chunk => { logs += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    assert.equal(server.exitCode, null, logs);
    await delay(100);
  }
  throw new Error('isolated service failed to start: ' + logs);
}

async function stop() {
  if (!server) return;
  await fetch(base + '/api/service/stop', { method: 'POST' }).catch(() => {});
  await Promise.race([new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve)), delay(5000)]);
  if (server.exitCode === null) server.kill();
  server = null;
}

const request = (endpoint, method = 'GET', body) => fetch(base + endpoint, {
  method, signal: AbortSignal.timeout(30000),
  ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
});

try {
  await mkdir(data); await mkdir(library);
  const video = path.join(library, 'black-intro.mp4');
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=4',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=8',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', video]);
  await writeFile(path.join(data, 'state.json'), JSON.stringify({ version: 12,
    settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false }, libraries: [], media: [], jobs: [] }));
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
  await new Promise(resolve => listener.close(resolve));

  await start();
  assert.equal((await request('/api/libraries', 'POST', { folderPath: library })).status, 201);
  const scan = await request('/api/scan', 'POST');
  assert.equal(scan.status, 200, logs);
  const catalog = await (await request('/api/catalog')).json();
  assert.equal(catalog.media.length, 1);
  const media = catalog.media[0];
  assert.equal(media.durationSeconds, null, 'basic scan should leave duration unknown');
  assert.equal(media.thumbnailUrl, null);
  await stop();

  // Reproduce the persisted v1 image: a valid JPEG containing the black intro.
  const statePath = path.join(data, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const storedMedia = state.media.find(item => item.id === media.id);
  const signature = createHash('sha256')
    .update(`${storedMedia.id}\0${storedMedia.size}\0${storedMedia.modifiedAt}`).digest('hex').slice(0, 12);
  const thumbnailDir = path.join(data, 'cache', 'thumbnails');
  const legacyPath = path.join(thumbnailDir, `${media.id}-${signature}.jpg`);
  await run(ffmpeg, ['-v', 'error', '-y', '-ss', '0', '-i', video, '-frames:v', '1', legacyPath]);
  assert.ok(await frameContrast(legacyPath) < 10, 'old cached first frame should be black');
  storedMedia.thumbnailPath = legacyPath;
  storedMedia.thumbnail = { state: 'ready' };
  await writeFile(statePath, JSON.stringify(state));

  await start();
  const migrated = (await (await request('/api/catalog')).json()).media[0];
  assert.equal(migrated.thumbnailUrl, null, 'old black cache must no longer be published');
  const preparedResponse = await request(`/api/video/media/${media.id}/prepare`, 'POST', { resources: ['thumbnail'] });
  const prepared = await preparedResponse.json();
  assert.equal(preparedResponse.status, 200, JSON.stringify(prepared));
  assert.ok(prepared.media.thumbnailUrl);
  assert.equal(prepared.media.metadata.state, 'unknown', 'thumbnail-only request should not prepare playback metadata');
  const refreshedState = JSON.parse(await readFile(statePath, 'utf8'));
  const thumbnailPath = refreshedState.media.find(item => item.id === media.id).thumbnailPath;
  assert.match(path.basename(thumbnailPath), /-v2-[0-9a-f]{12}\.jpg$/);
  assert.notEqual(thumbnailPath, legacyPath);
  assert.ok(await frameContrast(thumbnailPath) > 50, 'new preview should contain visible image content');
  const image = await request(prepared.media.thumbnailUrl);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type') || '', /image\/jpeg/);

  const modifiedAt = (await stat(thumbnailPath)).mtimeMs;
  const repeated = await request(`/api/video/media/${media.id}/prepare`, 'POST', { resources: ['thumbnail'] });
  assert.equal(repeated.status, 200);
  assert.equal((await stat(thumbnailPath)).mtimeMs, modifiedAt, 'new preview should be reused');
  console.log('PASS: stale black thumbnail invalidated; unknown-duration video chooses a visible frame and reuses v2 cache');
} finally {
  await stop();
  assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
