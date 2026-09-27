import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const error = (code, message) => Object.assign(new Error(message), { code, status: 422 });
const inside = (file, root) => { const relative = path.relative(root, path.resolve(file)); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

// Validate the original container, retaining every face in a TTC and every byte.
// Bounds checking rejects truncated files before they acquire a durable binding.
export async function inspectFont(file, expectedSize = null) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 12 || info.size > 256 * 1024 ** 2 || (expectedSize && info.size !== expectedSize))
    throw error('INVALID_FONT', '字体附件大小无效');
  const handle = await open(file, 'r');
  const read = async (length, position) => { const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, position); if (result.bytesRead !== length) throw error('INVALID_FONT', '字体附件不完整'); return buffer; };
  let format;
  try {
    const header = await read(12, 0), magic = header.toString('ascii', 0, 4);
    const sfnt = async offset => {
      if (offset < 0 || offset + 12 > info.size) throw error('INVALID_FONT', '字体集合偏移无效');
      const head = await read(12, offset);
      if (head.readUInt32BE(0) !== 0x00010000 && !['OTTO', 'true', 'typ1'].includes(head.toString('ascii', 0, 4))) throw error('INVALID_FONT', '字体格式无法识别');
      const count = head.readUInt16BE(4);
      if (!count || count > 4096 || offset + 12 + count * 16 > info.size) throw error('INVALID_FONT', '字体表目录无效');
      const tables = await read(count * 16, offset + 12);
      for (let i = 0; i < count; i++) if (tables.readUInt32BE(i * 16 + 8) + tables.readUInt32BE(i * 16 + 12) > info.size) throw error('INVALID_FONT', '字体表不完整');
    };
    if (magic === 'ttcf') {
      format = 'ttc'; const count = header.readUInt32BE(8);
      if (!count || count > 256 || 12 + count * 4 > info.size) throw error('INVALID_FONT', '字体集合无效');
      const offsets = await read(count * 4, 12);
      for (let i = 0; i < count; i++) await sfnt(offsets.readUInt32BE(i * 4));
    } else if (magic === 'wOFF' || magic === 'wOF2') {
      format = magic === 'wOFF' ? 'woff' : 'woff2';
      if (header.readUInt32BE(8) !== info.size || info.size < (format === 'woff' ? 44 : 48)) throw error('INVALID_FONT', '压缩字体不完整');
    } else { format = magic === 'OTTO' ? 'otf' : 'ttf'; await sfnt(0); }
  } finally { await handle.close(); }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return { blobHash: digest.digest('hex'), size: info.size, format, validationVersion: 1 };
}

/** The media records are the authority for references. Counters are only pins. */
export function createFontObjectStore({ directory, getBindings = () => [], graceMs = 24 * 3600_000, now = Date.now }) {
  const root = path.join(directory, 'objects'), temporaryRoot = path.join(directory, 'object-pending');
  const pins = new Map(), validated = new Map(), aliasJobs = new Map(); let gate = Promise.resolve(), initialized = false;
  const metrics = { imports: 0, hits: 0, migratedBytes: 0, collectedBytes: 0 };
  const lock = operation => { const result = gate.then(operation); gate = result.catch(() => {}); return result; };
  const objectPath = hash => { if (!HASH.test(hash || '')) throw error('INVALID_FONT_HASH', '字体对象标识无效'); return path.join(root, hash.slice(0, 2), hash); };
  const pin = hash => { pins.set(hash, (pins.get(hash) || 0) + 1); let released = false; return () => { if (released) return; released = true; const n = (pins.get(hash) || 1) - 1; if (n) pins.set(hash, n); else pins.delete(hash); }; };
  async function initialize() {
    if (initialized) return;
    await mkdir(root, { recursive: true }); await mkdir(temporaryRoot, { recursive: true });
    // Only abandoned, service-owned staging files; never original font folders.
    for (const item of await readdir(temporaryRoot, { withFileTypes: true })) if (item.isFile() && /^[a-f0-9-]+\.part$/.test(item.name)) {
      const file = path.join(temporaryRoot, item.name), info = await lstat(file);
      if (now() - info.mtimeMs > graceMs) await rm(file, { force: true });
    }
    initialized = true;
  }
  async function importFont(file, { expectedSize, aliases = [], originalName = path.basename(file) } = {}) {
    const metadata = await inspectFont(file, expectedSize), hash = metadata.blobHash, release = pin(hash);
    try {
      await lock(async () => {
        await initialize(); const destination = objectPath(hash);
        let existing = await inspectFont(destination, metadata.size).catch(() => null);
        if (existing?.blobHash === hash) { metrics.hits++; return; }
        // Quarantine a corrupt object atomically. Existing open handles remain
        // valid; no publisher or newly acquired reader can adopt these bytes.
        const old = await lstat(destination).catch(() => null);
        if (old) {
          if (old.isSymbolicLink() || !old.isFile()) throw error('FONT_OBJECT_CORRUPT', '字体对象路径无效');
          await rename(destination, path.join(temporaryRoot, `${randomUUID()}.part`)); validated.delete(hash);
        }
        await mkdir(path.dirname(destination), { recursive: true });
        const staged = path.join(temporaryRoot, `${randomUUID()}.part`);
        try {
          await copyFile(file, staged);
          const stagedInfo = await inspectFont(staged, metadata.size);
          if (stagedInfo.blobHash !== hash) throw error('FONT_CHANGED', '字体在准备期间发生变化');
          const handle = await open(staged, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          // Link is exclusive and atomic: a second publisher can never overwrite.
          try { await link(staged, destination); } catch (failure) {
            if (failure.code !== 'EEXIST') throw failure;
            existing = await inspectFont(destination, metadata.size);
            if (existing.blobHash !== hash) throw error('FONT_OBJECT_CORRUPT', '已有字体对象校验失败');
          }
          metrics.imports++;
        } finally { await rm(staged, { force: true }).catch(() => {}); }
      });
      return { ...metadata, originalName, aliases, path: objectPath(hash), release };
    } catch (failure) { release(); throw failure; }
  }
  async function acquire(hash, expectedSize) {
    return lock(async () => {
      const file = objectPath(hash), info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || !info.size || (expectedSize && expectedSize !== info.size)) throw error('FONT_OBJECT_MISSING', '字体缓存已失效，请重新选择字幕');
      const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (validated.get(hash) !== fingerprint) {
        const object = await inspectFont(file, expectedSize).catch(() => null);
        if (object?.blobHash !== hash) throw error('FONT_OBJECT_CORRUPT', '字体缓存校验失败，请重新选择字幕');
        validated.set(hash, fingerprint);
      }
      return { path: file, release: pin(hash) };
    });
  }
  async function aliasesFor(hash, parser) {
    if (aliasJobs.has(hash)) return aliasJobs.get(hash);
    const promise = (async () => {
      const file = path.join(directory, 'object-metadata', `${hash}-v1.json`);
      const existing = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (existing?.blobHash === hash && existing.parserVersion === 1 && Array.isArray(existing.aliases) && existing.aliases.every(alias => typeof alias === 'string' && alias.length <= 160)) return existing.aliases;
      const aliases = await parser(objectPath(hash)); await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.part`;
      try { await writeFile(temporary, JSON.stringify({ blobHash: hash, parserVersion: 1, aliases })); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      return aliases;
    })();
    aliasJobs.set(hash, promise); promise.catch(() => { if (aliasJobs.get(hash) === promise) aliasJobs.delete(hash); });
    return promise;
  }
  async function removeMigratedCopy(file, binding, stillValid = () => true) {
    if (!inside(file, directory) || inside(file, root) || !HASH.test(binding.blobHash || '')) return false;
    return lock(async () => {
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) return false;
      if (!await stillValid()) return false;
      // A durable receipt permits restoring the old generated filename on rollback.
      const receipts = path.join(directory, 'migration-log'); await mkdir(receipts, { recursive: true });
      const record = { version: 1, at: new Date(now()).toISOString(), oldName: path.relative(directory, file), ...binding };
      delete record.path;
      const name = createHash('sha256').update(file).digest('hex');
      const staged = path.join(receipts, `${name}.${randomUUID()}.part`), destination = path.join(receipts, `${name}.json`);
      await writeFile(staged, JSON.stringify(record)); await rename(staged, destination);
      if (!await stillValid()) return false;
      await rm(file); metrics.migratedBytes += info.size; return true;
    });
  }
  async function collect() {
    return lock(async () => {
      await initialize();
      const referenced = new Set(getBindings().map(binding => binding.blobHash).filter(hash => HASH.test(hash || '')));
      for (const prefix of await readdir(root, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
        for (const entry of await readdir(path.join(root, prefix.name), { withFileTypes: true })) {
          if (!entry.isFile() || !HASH.test(entry.name) || !entry.name.startsWith(prefix.name) || referenced.has(entry.name) || pins.has(entry.name)) continue;
          const file = objectPath(entry.name), info = await lstat(file);
          if (now() - info.mtimeMs < graceMs) continue;
          // getBindings can change while stat awaits; check the authority again.
          if (pins.has(entry.name) || getBindings().some(binding => binding.blobHash === entry.name)) continue;
          await rm(file);
          await rm(path.join(directory, 'object-metadata', `${entry.name}-v1.json`), { force: true });
          validated.delete(entry.name); aliasJobs.delete(entry.name); metrics.collectedBytes += info.size;
        }
      }
      for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9-]+\.part$/.test(entry.name)) continue;
        const file = path.join(temporaryRoot, entry.name), info = await lstat(file);
        if (now() - info.mtimeMs >= graceMs) await rm(file, { force: true });
      }
    });
  }
  function status() {
    const bindings = getBindings().filter(binding => HASH.test(binding.blobHash || ''));
    const objects = new Map(bindings.map(binding => [binding.blobHash, binding.size || 0]));
    const logicalBytes = bindings.reduce((sum, binding) => sum + (binding.size || 0), 0), uniqueBytes = [...objects.values()].reduce((a, b) => a + b, 0);
    return { ...metrics, bindings: bindings.length, objects: objects.size, logicalBytes, uniqueBytes, deduplicationRate: logicalBytes ? 1 - uniqueBytes / logicalBytes : null, pins: [...pins.values()].reduce((a, b) => a + b, 0) };
  }
  return { importFont, acquire, aliasesFor, collect, removeMigratedCopy, status, objectPath };
}
