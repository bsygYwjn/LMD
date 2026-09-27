import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'lmd-transfers-http-'));
const data = path.join(root, 'state');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(data);
await writeFile(path.join(data, 'state.json'), JSON.stringify({ settings: { autoScanEnabled: false, autoPrepareCompatibleCopies: false } }));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, errors = '', lan, cookie = '';
async function start() {
  child = spawn(process.execPath, [path.join(project, 'server/index.mjs')], { cwd: project, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LMD_PORT: String(port), LMD_DATA_DIR: data } });
  child.stderr.on('data', chunk => { errors += chunk; });
  for (let i = 0; i < 200; i++) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) { const health = await response.json(); lan = health.lanAddresses[0]; return; } } catch {}
    if (child.exitCode !== null) throw new Error(errors);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`startup timeout ${errors}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  await fetch(`${base}/api/service/stop`, { method: 'POST' }).catch(() => child.kill());
  await exited;
}
async function json(url, method = 'GET', body, useLan = false, expected = 200) {
  const response = await fetch(`${useLan ? lan : base}${url}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(useLan && cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(value)}`);
  return value;
}
async function chunk(task, bytes, token, expected = 200, offset = 0) {
  const response = await fetch(`${lan}/api/uploads/${task.id}/chunks?offset=${offset}`, { method: 'PUT', headers: { Cookie: cookie, 'X-Chunk-Sha256': hash(bytes), 'X-Upload-Token': token }, body: bytes });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}
async function waitIndexed(task) {
  for (let i = 0; i < 300; i++) {
    const value = await json(`/api/uploads/${task.id}`, 'GET', undefined, true);
    if (value.task.status === 'complete') return;
    assert.notEqual(value.task.status, 'index_failed', JSON.stringify(value));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('index timeout');
}
try {
  await start();
  assert.ok(lan, 'real LAN interface required for non-admin tests');
  await json('/api/uploads/targets', 'GET', undefined, false, 403);
  const folders = {};
  for (const kind of ['video','music','reading','photos','files']) {
    folders[kind] = path.join(root, kind); await mkdir(folders[kind]);
    await json(kind === 'video' ? '/api/libraries' : `/api/${kind}/libraries`, 'POST', { folderPath: folders[kind] }, false, 201);
  }
  await json('/api/access-control', 'PATCH', { enabled: true });
  const user = await json('/api/access-control/users', 'POST', { accessCode: '314159', categoryIds: ['__uncategorized__'] }, false, 201);
  assert.equal(user.canUpload, false);
  const login = await fetch(`${lan}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessCode: '314159' }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  await json('/api/uploads/targets', 'GET', undefined, true, 403);
  await json(`/api/access-control/users/${user.id}`, 'PATCH', { canUpload: true });
  assert.equal((await json('/api/auth/status','GET',undefined,true)).canUpload, true);
  const targets = (await json('/api/uploads/targets','GET',undefined,true)).targets;
  assert.equal(targets.length, 5, 'all five empty roots are writable');
  const wav = Buffer.alloc(16044); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
  const fixtures = { video: ['电影.mp4',Buffer.from('test-video')], music: ['歌曲.wav',wav], reading: ['书籍.txt',Buffer.from('这是隔离测试')], photos: ['图片.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')], files: ['其他.bin',Buffer.from([0,1,2,255])] };
  for (const [kind, [name, bytes]] of Object.entries(fixtures)) {
    const target = targets.find(t => t.kind === kind);
    const created = await json('/api/uploads','POST',{kind,targetId:target.id,relativePath:`最外层/第二层/${name}`,size:bytes.length,lastModified:123},true,201);
    await chunk(created.task,bytes,created.resumeToken);
    const duplicate = await chunk(created.task,bytes,created.resumeToken); assert.equal(duplicate.duplicate,true);
    await json(`/api/uploads/${created.task.id}/complete`,'POST',{sha256:hash(bytes),resumeToken:created.resumeToken},true);
    await waitIndexed(created.task);
    assert.deepEqual(await readFile(path.join(folders[kind],'最外层','第二层',name)),bytes);
    const catalog = await json(kind === 'video' ? '/api/catalog' : `/api/${kind}/catalog`,'GET',undefined,true);
    const item = (catalog.media || catalog.tracks || catalog.items)[0]; assert.ok(item,`indexed ${kind}`);
    if (['video','music','files'].includes(kind)) {
      const download = await fetch(`${lan}${item.downloadUrl}`,{headers:{Cookie:cookie}});
      assert.equal(download.status,200); assert.match(download.headers.get('content-disposition'),/attachment; filename\*=UTF-8''/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
      const head = await fetch(`${lan}${item.downloadUrl}`,{method:'HEAD',headers:{Cookie:cookie,Range:'bytes=1-2'}});
      assert.equal(head.status,206); assert.equal(head.headers.get('content-length'),'2');
    }
    if (kind === 'photos') {
      const response = await fetch(`${lan}${item.fileUrl || item.previewUrl}`,{headers:{Cookie:cookie}});
      assert.match(response.headers.get('content-security-policy'),/sandbox/);
    }
  }
  const target = targets.find(t => t.kind === 'files');
  await json('/api/uploads/directories','POST',{kind:'files',targetId:target.id,relativePath:'空文件夹'},true,201);
  assert.ok((await json('/api/uploads/targets?kind=files','GET',undefined,true)).targets.some(t=>t.relativePath==='空文件夹'));
  const bytes = Buffer.from('survive restart');
  const created = await json('/api/uploads','POST',{kind:'files',targetId:target.id,relativePath:'恢复.dat',size:bytes.length},true,201);
  await chunk(created.task,bytes,created.resumeToken);
  await json(`/api/access-control/users/${user.id}`,'PATCH',{canUpload:false});
  await json(`/api/uploads/${created.task.id}`,'GET',undefined,true,403);
  await json(`/api/access-control/users/${user.id}`,'PATCH',{canUpload:true});
  await stop(); await start();
  await json(`/api/uploads/${created.task.id}/resume`,'POST',{prefixHashes:[hash(Buffer.from('wrong'))]},true,409);
  const resume = await json(`/api/uploads/${created.task.id}/resume`,'POST',{prefixHashes:[hash(bytes)]},true);
  await json(`/api/uploads/${created.task.id}/complete`,'POST',{sha256:hash(bytes),resumeToken:resume.resumeToken},true);
  await waitIndexed(created.task);
  assert.deepEqual(await readFile(path.join(folders.files,'恢复.dat')),bytes);
  const conflict = await json('/api/uploads','POST',{kind:'files',targetId:target.id,relativePath:'恢复.dat',size:bytes.length},true,409);
  assert.equal(conflict.task.status,'conflict');
  await json(`/api/uploads/${conflict.task.id}`,'DELETE',undefined,true);
  assert.deepEqual(await readFile(path.join(folders.files,'恢复.dat')),bytes);
  const other = await json('/api/access-control/users','POST',{accessCode:'271828',categoryIds:['__uncategorized__'],canUpload:true},false,201);
  const login2 = await fetch(`${lan}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode:'271828'})});
  cookie=login2.headers.get('set-cookie').split(';')[0];
  await json(`/api/uploads/${created.task.id}`,'GET',undefined,true,404);
  assert.notEqual(other.id,user.id);
  console.log('PASS five-library HTTP uploads, empty targets, folder hierarchy, grant/revoke, resume after restart, prefix mismatch, original downloads, SVG CSP and cross-user isolation');
} finally { await stop(); await rm(root,{recursive:true,force:true}); }
