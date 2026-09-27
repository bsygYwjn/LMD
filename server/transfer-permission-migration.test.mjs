import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'lmd-transfer-migration-'));
const data = path.join(root, 'data');
const libraryPath = path.join(root, 'music');
const childPath = path.join(libraryPath, '原有专辑');
const emptyPath = path.join(libraryPath, '空白私密');
await Promise.all([mkdir(data), mkdir(childPath, { recursive: true }), mkdir(emptyPath, { recursive: true })]);
const stableId = value => createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 20);
const folderId = directory => stableId(`music:music-library:${path.resolve(directory).toLowerCase()}`);
const rootId = folderId(libraryPath), childId = folderId(childPath), emptyId = folderId(emptyPath);
const rootFile = path.join(libraryPath, '根目录.flac');
const childFile = path.join(childPath, '歌曲.flac');
await Promise.all([writeFile(rootFile, 'root original fixture'), writeFile(childFile, 'child original fixture')]);
const records = await Promise.all([rootFile, childFile].map(async (file, index) => ({ id: `track-${index}`, libraryId: 'music-library', path: file, fileName: path.basename(file), title: path.basename(file), extension: 'FLAC', size: (await stat(file)).size, modifiedAt: (await stat(file)).mtime.toISOString(), codec: 'flac', lossless: true, artists: [], tags: [], coverPaths: {} })));
const user = (id, code, categoryIds, folderIds) => ({ id, enabled: true, categoryIds, folderIds, accessSalt: `salt-${id}`, accessHash: scryptSync(code, `salt-${id}`, 64).toString('base64url') });
await writeFile(path.join(data, 'state.json'), JSON.stringify({ version: 11, musicLibraries: [{ id: 'music-library', path: libraryPath, name: '迁移音乐库' }], musicTracks: records,
  settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false },
  accessControl: { enabled: true, users: [user('category-user', '601001', ['public'], []), user('folder-user', '601002', [], [rootId])], sessions: [], categories: [{ id: 'public', name: '原有分类', folderIds: [rootId] }, { id: 'private', name: '私密分类', folderIds: [] }] },
}));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const local = `http://127.0.0.1:${port}`;
let child, lan, errors = '';

async function start() {
  child = spawn(process.execPath, [path.join(project, 'server/index.mjs')], { cwd: project, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LMD_DATA_DIR: data, LMD_PORT: String(port) } });
  child.stderr.on('data', chunk => { errors += chunk; });
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`${local}/api/health`);
      if (response.ok) { lan = (await response.json()).lanAddresses[0]; assert.ok(lan, 'real LAN address is required to verify non-admin permissions'); return; }
    } catch {}
    if (child.exitCode !== null) throw new Error(`isolated server exited: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`isolated startup timeout: ${errors}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise(resolve => child.once('exit', resolve));
  await fetch(`${local}/api/service/stop`, { method: 'POST' }).catch(() => child.kill());
  const timeout = setTimeout(() => child.kill(), 5000);
  await stopped;
  clearTimeout(timeout);
}
async function json(route, { method = 'GET', body, cookie, expected = 200 } = {}) {
  const response = await fetch(`${cookie ? lan : local}${route}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(result)}`);
  return result;
}
async function login(code) {
  const response = await fetch(`${lan}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: code }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
const stored = async () => JSON.parse(await readFile(path.join(data, 'state.json'), 'utf8'));
const sorted = values => [...values].sort();

try {
  await start();
  let state = await stored();
  assert.equal(state.accessControl.folderIdVersion, 1);
  assert.deepEqual(sorted(state.accessControl.categories.find(category => category.id === 'public').folderIds), sorted([rootId, childId]), 'old root category alias must preserve the pre-migration root and child buckets');
  assert.deepEqual(sorted(state.accessControl.users.find(entry => entry.id === 'folder-user').folderIds), sorted([rootId, childId]), 'old per-user root aliases migrate by the same rule');
  assert.ok(state.accessControl.users.every(entry => entry.canUpload === false), 'old users do not automatically acquire upload capability');
  assert.ok(!state.accessControl.categories.some(category => category.folderIds.includes(emptyId)), 'newly inventoried empty sibling must not acquire old root classification');
  const overview = await json('/api/overview?compact=1');
  assert.ok(overview.accessFolders.some(folder => folder.id === emptyId), 'empty sibling is visible to management for explicit classification');
  for (const id of ['category-user', 'folder-user']) await json(`/api/access-control/users/${id}`, { method: 'PATCH', body: { canUpload: true } });
  const categoryCookie = await login('601001');
  const folderCookie = await login('601002');
  for (const cookie of [categoryCookie, folderCookie]) {
    const catalog = await json('/api/music/catalog', { cookie });
    assert.equal(catalog.tracks.length, 2);
    const targets = (await json('/api/uploads/targets?kind=music', { cookie })).targets;
    assert.deepEqual(sorted(targets.map(target => target.relativePath)), sorted(['', '原有专辑']));
  }
  await json(`/api/access-control/folders/${childId}`, { method: 'PATCH', body: { categoryId: 'private' } });
  await json(`/api/access-control/folders/${rootId}`, { method: 'PATCH', body: { categoryId: 'private' } });
  await json(`/api/access-control/folders/${rootId}`, { method: 'PATCH', body: { categoryId: 'public' } });
  state = await stored();
  assert.deepEqual(state.accessControl.categories.find(category => category.id === 'public').folderIds, [rootId], 'canonical root reassignment must be exact after migration');
  assert.deepEqual(state.accessControl.categories.find(category => category.id === 'private').folderIds, [childId]);
  assert.equal((await json('/api/music/catalog', { cookie: categoryCookie })).tracks.length, 1, 'category user loses separately reclassified child');
  assert.equal((await json('/api/music/catalog', { cookie: folderCookie })).tracks.length, 2, 'existing explicit per-user grants stay explicit');
  const rootTarget = (await json('/api/uploads/targets?kind=music', { cookie: categoryCookie })).targets[0];
  assert.equal(rootTarget.relativePath, '');
  for (const relativePath of ['原有专辑/不能写.lrc', '空白私密/不能写.lrc']) {
    await json('/api/uploads', { method: 'POST', cookie: categoryCookie, body: { kind: 'music', targetId: rootTarget.id, relativePath, size: 1 }, expected: 403 });
  }
  await json('/api/uploads/directories', { method: 'POST', cookie: categoryCookie, body: { kind: 'music', targetId: rootTarget.id, relativePath: '新建专辑/第二层' }, expected: 201 });
  const newId = folderId(path.join(libraryPath, '新建专辑'));
  const secondId = folderId(path.join(libraryPath, '新建专辑', '第二层'));
  state = await stored();
  assert.deepEqual(sorted(state.accessControl.categories.find(category => category.id === 'public').folderIds), sorted([rootId, newId, secondId]), 'only new first/second-level directories inherit the explicit parent classification');
  assert.ok(!state.accessControl.categories.some(category => category.folderIds.includes(emptyId)));
  const targetPaths = sorted((await json('/api/uploads/targets?kind=music', { cookie: categoryCookie })).targets.map(target => target.relativePath));
  assert.deepEqual(targetPaths, sorted(['', '新建专辑', '新建专辑/第二层']));
  const snapshot = state.accessControl.categories.map(category => ({ id: category.id, folderIds: sorted(category.folderIds) }));
  await stop();
  await start();
  state = await stored();
  assert.equal(state.accessControl.folderIdVersion, 1);
  assert.deepEqual(state.accessControl.categories.map(category => ({ id: category.id, folderIds: sorted(category.folderIds) })), snapshot, 'restart must not repeat root alias expansion');
  assert.deepEqual(sorted((await json('/api/uploads/targets?kind=music', { cookie: categoryCookie })).targets.map(target => target.relativePath)), targetPaths, 'existing session and target grants survive restart unchanged');
  assert.equal((await json('/api/music/catalog', { cookie: categoryCookie })).tracks.length, 1);
  console.log('PASS legacy root-alias migration, exact canonical reassignment, empty sibling isolation, new bucket inheritance and persisted restart permissions');
} finally {
  await stop();
  const absolute = path.resolve(root);
  assert.ok(absolute.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(absolute).startsWith('lmd-transfer-migration-'));
  await rm(absolute, { recursive: true, force: true });
}
