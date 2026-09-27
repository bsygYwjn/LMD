import { opendir, realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';

export const within = (file, root) => {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

// Only one directory handle is held at a time. The consumer supplies backpressure
// at each yield; large libraries never require an array of every candidate.
export async function* discoverVideos(root, { extensions, hidden = () => false, assertCurrent = () => {}, report, maxDepth = 10, maxFiles = 10000, maxDirectories = 20000 } = {}) {
  const canonicalRoot = await realpath(root).catch(error => {
    report.complete = false; report.errors.push({ code: error.code || 'ROOT_UNAVAILABLE', path: root }); return null;
  });
  if (!canonicalRoot) return;
  const pending = [{ directory: path.resolve(root), depth: 0 }];
  let found = 0, directories = 0;
  while (pending.length) {
    assertCurrent();
    const { directory, depth } = pending.pop();
    if (depth > maxDepth) { report.complete = false; report.truncated = true; report.resumeAt = directory; continue; }
    let handle;
    try {
      const actual = await realpath(directory); assertCurrent();
      if (!within(actual, canonicalRoot)) throw Object.assign(new Error('Root boundary changed'), { code: 'ROOT_BOUNDARY_CHANGED' });
      handle = await opendir(directory);
      for await (const entry of handle) {
        assertCurrent();
        if (entry.name.startsWith('.')) continue;
        const filePath = path.join(directory, entry.name);
        if (hidden(filePath) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (++directories > maxDirectories) { report.complete = false; report.truncated = true; report.resumeAt = filePath; continue; }
          pending.push({ directory: filePath, depth: depth + 1 });
        }
        else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          if (++found > maxFiles) { report.complete = false; report.truncated = true; report.resumeAt = filePath; return; }
          yield filePath;
        }
      }
    } catch (error) {
      if (['SCAN_CANCELLED', 'LIBRARY_CHANGED_DURING_SCAN', 'SERVICE_STOPPING'].includes(error.code)) throw error;
      report.complete = false; report.errors.push({ path: directory, code: error.code || 'DIRECTORY_UNAVAILABLE' });
    }
  }
}

// Notifications are hints. Revisions are acknowledged only after a scan succeeds,
// so an event received while scanning always remains pending for the next pass.
export function createVideoChangeMonitor({ libraries, onDirty = () => {}, debounceMs = 1200 }) {
  const watchers = new Map(), dirty = new Map();
  let generation = 0, timer = null, stopped = false;
  function mark(directory) {
    if (stopped) return;
    dirty.set(path.resolve(directory), ++generation);
    clearTimeout(timer); timer = setTimeout(onDirty, debounceMs); timer.unref?.();
  }
  function synchronize() {
    const current = new Map(libraries().map(library => [path.resolve(library.path), library]));
    for (const [root, watcher] of watchers) if (!current.has(root)) { watcher.close(); watchers.delete(root); }
    for (const [root] of current) if (!watchers.has(root)) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
          const candidate = file ? path.resolve(root, String(file)) : root;
          if (within(candidate, root)) mark(file ? path.dirname(candidate) : root);
        });
        watcher.on('error', () => { mark(root); watcher.close(); watchers.delete(root); });
        watchers.set(root, watcher);
      } catch { mark(root); }
    }
  }
  function snapshot() { return { generation, scopes: [...dirty.keys()] }; }
  function acknowledge(token) { for (const [directory, version] of dirty) if (version <= token.generation) dirty.delete(directory); }
  function close() { stopped = true; clearTimeout(timer); for (const watcher of watchers.values()) watcher.close(); watchers.clear(); }
  return { mark, synchronize, snapshot, acknowledge, close, status: () => ({ watchedRoots: watchers.size, dirtyScopes: dirty.size }) };
}
