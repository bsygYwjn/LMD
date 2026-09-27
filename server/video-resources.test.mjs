import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMediaTaskScheduler } from './media-tasks.mjs';
import { createVideoResourceService, describeVideoResources, videoCacheSignature, videoSourceVersion } from './video-resources.mjs';
import { createFontObjectStore } from './font-object-store.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const eventually = async predicate => { const until = Date.now() + 3000; while (!predicate()) { if (Date.now() > until) throw new Error('Condition did not become true'); await new Promise(resolve => setTimeout(resolve, 5)); } };
// A bounded, structurally valid SFNT fixture. Functional tests make no disk-speed claim.
const fontBytes = (variant = 1) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(0x10000); bytes.writeUInt16BE(1, 4); bytes.write('name', 12); bytes.writeUInt32BE(28, 20); bytes.writeUInt32BE(4, 24); bytes.writeUInt32BE(variant, 28); return bytes; };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lmd-resource-test-')), cache = path.join(root, 'cache');
  const appState = { media: [], settings: {} }; let saveFailure = false, saved = null, aliasesRead = 0;
  const commands = [], scheduler = createMediaTaskScheduler();
  const saveState = async () => { if (typeof saveFailure === 'function' ? saveFailure(appState) : saveFailure) throw new Error('simulated disk full'); saved = structuredClone(appState); };
  const deps = { appState, cacheDirectory: cache, getMediaTools: () => ({ available: true, ffmpeg: 'fixture-ffmpeg' }), scheduler,
    saveState, readFontAliases: async () => { aliasesRead++; return ['Fixture family']; },
    runCommand: async (_executable, args, _timeout, options = {}) => {
      commands.push(args); await overrides.beforeCommand?.(args, options);
      const attachments = args.map((arg, i) => arg.startsWith('-dump_attachment:') ? args[i + 1] : null).filter(Boolean);
      if (attachments.length) for (const file of attachments) await writeFile(path.resolve(options.cwd || root, file), fontBytes(overrides.fontVariant?.(args) || 1));
      else await writeFile(args.at(-1), args.at(-1).endsWith('.ass') ? '[Script Info]\n[V4+ Styles]\n[Events]\n' : '1\n00:00:00,000 --> 00:00:02,000\nHello\n');
      return { stdout: '', stderr: '' };
    } };
  let service = createVideoResourceService(deps);
  const addMedia = async id => {
    const file = path.join(root, `${id}.mkv`); await writeFile(file, `source ${id}`); const info = await stat(file);
    const media = { id, path: file, size: info.size, modifiedAt: info.mtime.toISOString(),
      embeddedSubtitleStreams: [{ index: 1, format: 'ASS', extension: '.ass', default: true }, { index: 2, format: 'SRT', extension: '.srt' }],
      embeddedFontStreams: [{ index: 3, fileName: 'same-name.ttf', size: 32 }] };
    Object.assign(media, describeVideoResources(media)); appState.media.push(media); return media;
  };
  t.after(async () => { await service.stop(); await scheduler.close(); const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(tmpdir())); await rm(resolved, { recursive: true, force: true }); });
  return { root, cache, appState, commands, scheduler, addMedia, get service() { return service; }, get saved() { return saved; }, get aliasesRead() { return aliasesRead; }, failSave(value) { saveFailure = value; },
    async restart() { await service.stop(); service = createVideoResourceService(deps); return service; } };
}

test('descriptions perform no extraction; selected plain subtitle never extracts fonts or other tracks', async t => {
  const f = await fixture(t), media = await f.addMedia('plain');
  assert.equal(f.commands.length, 0); assert.equal(media.subtitles.length, 2); assert.ok(media.subtitles.every(item => item.state === 'unknown' && !item.path));
  const prepared = await f.service.ensureSubtitle(media, media.subtitles[1].id);
  assert.equal(prepared.subtitle.format, 'SRT'); assert.deepEqual(prepared.fonts, []);
  assert.equal(f.commands.length, 1); assert.equal(f.commands[0][f.commands[0].indexOf('-map') + 1], '0:2');
  assert.equal(media.subtitles.find(item => item.format === 'ASS').state, 'unknown');
  await f.service.ensureSubtitle(media, media.subtitles.find(item => item.format === 'SRT').id);
  assert.equal(f.commands.length, 1);
});

test('shared task survives one consumer cancellation, and ASS fonts share raw objects across videos', async t => {
  const held = deferred(); let started = false;
  const f = await fixture(t, { beforeCommand: async args => { if (args.at(-1).endsWith('.ass') && !started) { started = true; await held.promise; } } });
  const a = await f.addMedia('episode-a'), b = await f.addMedia('episode-b'), first = new AbortController(), second = new AbortController();
  const abandoned = f.service.ensureSubtitle(a, a.subtitles[0].id, { signal: first.signal });
  const surviving = f.service.ensureSubtitle(a, a.subtitles[0].id, { signal: second.signal });
  await eventually(() => started); first.abort(); await assert.rejects(abandoned, { name: 'AbortError' }); held.resolve();
  assert.equal((await surviving).fonts.length, 1);
  await f.service.ensureSubtitle(b, b.subtitles[0].id);
  assert.equal(f.service.status().subtitleExtractions, 2); assert.equal(f.service.status().fontExtractions, 2);
  const [fontA, fontB] = [a.fonts[0], b.fonts[0]]; assert.equal(fontA.blobHash, fontB.blobHash); assert.equal(fontA.path, fontB.path);
  assert.equal(f.aliasesRead, 1, 'identical raw content reuses parser metadata');
  assert.equal(f.service.status().fonts.logicalBytes, 64); assert.equal(f.service.status().fonts.uniqueBytes, 32);
  const release = await f.service.pinFonts(a, [{ id: fontA.id }]); assert.equal(f.service.status().fonts.pins, 1); release();
  await f.restart(); await f.service.ensureSubtitle(a, a.subtitles.find(track => track.format === 'ASS').id); assert.equal(f.aliasesRead, 1);
});

test('last cancellation rejects promptly, but shutdown waits for actual execution cleanup', async t => {
  const closing = deferred(); let killed = false, started = false;
  const f = await fixture(t, { beforeCommand: async (_args, options) => { started = true; options.onChild?.({ kill: () => { killed = true; } }); await closing.promise; } });
  const media = await f.addMedia('cancel'), controller = new AbortController();
  const task = f.service.ensureSubtitle(media, media.subtitles[1].id, { signal: controller.signal });
  await eventually(() => started); controller.abort(); await assert.rejects(task, { name: 'AbortError' }); await eventually(() => killed);
  let stopped = false; const stop = f.service.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  closing.resolve(); await stop; assert.equal(f.scheduler.snapshot().running, 0);
  assert.equal(media.subtitles[1].state, 'unknown');
});

test('a changed source cannot publish late output or become ready', async t => {
  const held = deferred(); let started = false;
  const f = await fixture(t, { beforeCommand: async () => { started = true; await held.promise; } });
  const media = await f.addMedia('replace'), task = f.service.ensureSubtitle(media, media.subtitles[1].id);
  await eventually(() => started); await writeFile(media.path, 'replacement source with a new version'); held.resolve();
  await assert.rejects(task, { code: 'SOURCE_CHANGED' });
  assert.equal(media.subtitles[1].state, 'unknown'); assert.equal(media.subtitles[1].path, null);
});

test('failed persistence never publishes ready; failure backoff survives restart and explicit retry works', async t => {
  const f = await fixture(t), media = await f.addMedia('save'); f.failSave(true);
  await assert.rejects(f.service.ensureSubtitle(media, media.subtitles[1].id), { code: 'RESOURCE_SAVE_FAILED' });
  assert.equal(media.subtitles[1].state, 'unknown'); f.failSave(false);
  await f.service.ensureSubtitle(media, media.subtitles[1].id, { retry: true });
  assert.equal(media.subtitles.find(item => item.format === 'SRT').state, 'ready');
  // A genuinely failed extraction has durable source-specific cooldown.
  const broken = await f.addMedia('broken'); broken.subtitles[1].format = 'UNSUPPORTED';
  await assert.rejects(f.service.ensureSubtitle(broken, broken.subtitles[1].id), { code: 'SUBTITLE_UNSUPPORTED' });
  assert.ok(Object.keys(f.saved.media.find(item => item.id === 'broken').videoResourceFailures).length);
  await f.restart(); broken.subtitles[1].format = 'SRT';
  await assert.rejects(f.service.ensureSubtitle(broken, broken.subtitles[1].id), { code: 'SUBTITLE_UNSUPPORTED' });
  await f.service.ensureSubtitle(broken, broken.subtitles[1].id, { retry: true });
});

test('validated legacy font migrates only after durable binding and keeps a rollback receipt', async t => {
  const f = await fixture(t), media = await f.addMedia('legacy'); await mkdir(path.join(f.cache, 'fonts'), { recursive: true });
  const legacy = path.join(f.cache, 'fonts', `${media.id}-${videoCacheSignature(media)}-3-same-name.ttf`); await writeFile(legacy, fontBytes());
  await f.service.ensureSubtitle(media, media.subtitles[0].id);
  assert.equal(f.service.status().fontExtractions, 0); await assert.rejects(stat(legacy), { code: 'ENOENT' });
  assert.equal(f.saved.media[0].fonts[0].blobHash, media.fonts[0].blobHash);
  const receipts = await readdir(path.join(f.cache, 'fonts', 'migration-log')); assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await readFile(path.join(f.cache, 'fonts', 'migration-log', receipts[0]), 'utf8'));
  assert.equal(receipt.sourceVersion, videoSourceVersion(media)); assert.equal(receipt.oldName, path.basename(legacy));
});

test('font binding save failure keeps the old generated copy and protects original files', async t => {
  const f = await fixture(t), media = await f.addMedia('rollback'); await mkdir(path.join(f.cache, 'fonts'), { recursive: true });
  const legacy = path.join(f.cache, 'fonts', `${media.id}-${videoCacheSignature(media)}-3-same-name.ttf`); await writeFile(legacy, fontBytes());
  f.failSave(state => state.media.some(item => item.fonts.some(font => font.blobHash)));
  await assert.rejects(f.service.ensureSubtitle(media, media.subtitles[0].id), { code: 'RESOURCE_SAVE_FAILED' });
  assert.deepEqual(await readFile(legacy), fontBytes()); assert.equal(media.fonts[0].state, 'unknown'); assert.equal(f.service.status().fonts.bindings, 0);
  f.failSave(false); await f.service.ensureSubtitle(media, media.subtitles.find(track => track.format === 'ASS').id, { retry: true });
  assert.equal(media.fonts[0].state, 'ready'); await assert.rejects(stat(legacy), { code: 'ENOENT' });
});

test('hundreds of attachments use short cwd-relative outputs within the Windows command limit', async t => {
  const f = await fixture(t), media = await f.addMedia('many-fonts');
  media.embeddedFontStreams = Array.from({ length: 233 }, (_, index) => ({ index: index + 3, fileName: `font-${index}.ttf`, size: 32 }));
  Object.assign(media, describeVideoResources(media)); const prepared = await f.service.ensureSubtitle(media, media.subtitles[0].id);
  assert.equal(prepared.fonts.length, 233);
  const args = f.commands.find(command => command.some(arg => arg.startsWith('-dump_attachment:')));
  assert.ok(args.join(' ').length < 12_000);
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('-dump_attachment:')) assert.match(args[i + 1], /^\d+\.part$/);
  assert.equal(f.service.status().fonts.objects, 1);
});

test('font GC protects references, pending commits and playback pins; corruption is recoverable', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'lmd-font-gc-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'original.ttf'), second = path.join(root, 'different.ttf'); await writeFile(first, fontBytes(1)); await writeFile(second, fontBytes(2));
  let bindings = [], clock = Date.now() + 10_000;
  const store = createFontObjectStore({ directory: path.join(root, 'cache'), getBindings: () => bindings, graceMs: 0, now: () => clock });
  const [a, duplicate, b] = await Promise.all([store.importFont(first), store.importFont(first), store.importFont(second)]);
  assert.equal(a.path, duplicate.path); assert.notEqual(a.path, b.path); await store.collect(); assert.equal((await stat(a.path)).size, 32);
  bindings = [{ blobHash: a.blobHash, size: 32 }]; a.release(); duplicate.release(); b.release();
  await store.collect(); await assert.rejects(stat(b.path), { code: 'ENOENT' }); assert.equal((await stat(a.path)).size, 32);
  const active = await store.acquire(a.blobHash, 32); bindings = []; await store.collect(); assert.equal((await stat(a.path)).size, 32);
  active.release(); await writeFile(a.path, Buffer.alloc(32)); await assert.rejects(store.acquire(a.blobHash, 32), { code: 'FONT_OBJECT_CORRUPT' });
  const repaired = await store.importFont(first); assert.deepEqual(await readFile(repaired.path), fontBytes()); repaired.release();
  await store.collect(); await assert.rejects(stat(a.path), { code: 'ENOENT' }); assert.deepEqual(await readFile(first), fontBytes());
});
