import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTransferDirectoryService, uploadFormatSupported } from './transfer-directories.mjs';
import { createUploadIndexer } from './upload-indexing.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'lmd-directory-transfer-'));
try {
  const library = { id: 'lib', path: path.join(root, 'empty'), name: 'Empty' };
  await mkdir(path.join(library.path, 'denied'), { recursive: true });
  const stableId = value => createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 20);
  const state = { libraries: [library], accessControl: { enabled: true, users: [], categories: [] } };
  let context = { localAdmin: true, fullAccess: true };
  const service = createTransferDirectoryService({ getState: () => state, stableId, contextForRequest: () => context, saveState: async () => {} });
  await service.refresh(true);
  const targets = await service.listTargets({}, 'video');
  assert.equal(targets.length, 2, 'empty root and empty child are available targets');
  assert.equal(targets[0].parentId, null);
  const rootId = service.bucketId('video', library, library.path);
  const childId = service.bucketId('video', library, path.join(library.path, 'denied'));
  context = { user: { id: 'user', canUpload: true }, allowedFolderIds: new Set([rootId]) };
  assert.equal((await service.listTargets({}, 'video')).length, 1);
  const target = await service.resolveTarget({}, 'video', targets[0].id);
  await assert.rejects(service.authorizePath({}, 'video', target, 'denied/movie.mp4'), /没有写入权限/);
  await service.authorizePath({}, 'video', target, 'new/movie.mp4');
  await assert.rejects(service.authorizePath({}, 'video', target, '.hidden/movie.mp4'), /隐藏/);
  await assert.rejects(service.authorizePath({}, 'video', target, `${'deep/'.repeat(11)}movie.mp4`), /最多支持/);
  state.accessControl.categories.push({ id: 'public', folderIds: [rootId] }, { id: 'private', folderIds: [childId] });
  const newPath = path.join(library.path, 'new');
  const secondPath = path.join(newPath, 'second');
  await mkdir(secondPath, { recursive: true });
  await service.onDirectoriesCreated({}, 'video', target, [newPath, secondPath]);
  assert.deepEqual(state.accessControl.categories[1].folderIds, [childId]);
  assert.ok(state.accessControl.categories[0].folderIds.includes(service.bucketId('video', library, secondPath)));
  context.allowedFolderIds = new Set([childId]);
  assert.equal((await service.listTargets({}, 'video')).length, 1, 'navigable ancestor cannot be an upload target');
  assert.equal(service.visibleNodes(context, 'video').length, 2, 'ancestor remains navigable');
  state.photoLibraries = [{ ...library, id: 'photo-empty' }];
  await service.refresh(); // New empty roots invalidate a warm snapshot without force.
  assert.ok(service.inventory().some(folder => folder.kind === 'photo'), 'empty photo permission buckets keep the existing public photo kind');
  assert.ok(!service.inventory().some(folder => folder.kind === 'photos'));
  state.photoLibraries = [];
  await service.refresh();
  assert.ok(!service.inventory().some(folder => folder.kind === 'photo'), 'removed roots disappear from a warm snapshot');
  context.user.canUpload = false;
  assert.throws(() => service.identify({}), /上传权限/);
  state.accessControl.enabled = false;
  context = { localAdmin: true, fullAccess: true };
  assert.throws(() => service.identify({}), /开启访问控制/);
  for (const [kind, filename] of [['video','a.ass'],['video','Fonts/a.rar'],['music','folder.jpg'],['reading','book.epub'],['photos','a.svg'],['files','random.exe']]) assert.equal(uploadFormatSupported(kind, filename), true);
  assert.equal(uploadFormatSupported('video', 'random.rar'), false);
  assert.equal(uploadFormatSupported('reading', 'cover.png'), false);
  assert.equal(uploadFormatSupported('video', '.hidden.mp4'), false);
  assert.equal(uploadFormatSupported('files', '.hidden.bin'), true);

  let scans = 0, release;
  const firstScan = new Promise(resolve => { release = resolve; });
  const indexer = createUploadIndexer({ getState: () => state, refreshDirectories: async () => {}, delayMs: 1,
    scanners: { video: { isScanning: () => false, scan: async () => { if (++scans === 1) await firstScan; } } } });
  const first = indexer.onPublished(path.join(library.path, 'a.mp4'));
  while (!scans) await new Promise(resolve => setTimeout(resolve, 2));
  const second = indexer.onPublished(path.join(library.path, 'b.mp4'));
  release();
  await Promise.all([first, second]);
  assert.equal(scans, 2, 'a publication during scan always schedules another generation');
  console.log('PASS upload directory permissions, empty libraries, inheritance, formats and indexing generations');
} finally { await rm(root, { recursive: true, force: true }); }
