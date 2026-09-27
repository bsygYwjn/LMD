import { within, LIBRARY_KEYS } from './transfer-directories.mjs';

// A generation survives a scan already in progress: its result can only
// acknowledge the generation that was present when our own scan started.
export function createUploadIndexer({ getState, scanners, refreshDirectories, delayMs = 150 }) {
  const states = new Map();
  async function run(kind, state) {
    if (state.running) return;
    state.running = true;
    try {
      while (state.done < state.generation) {
        while (scanners[kind].isScanning()) await new Promise(resolve => setTimeout(resolve, 100));
        const generation = state.generation;
        try {
          const paths = [...state.paths].filter(([, version]) => version <= generation).map(([filePath]) => filePath);
          await refreshDirectories(kind, paths);
          await scanners[kind].scan({ paths, generation });
          for (const [filePath, version] of state.paths) if (version <= generation) state.paths.delete(filePath);
          state.done = generation;
          for (const waiter of state.waiters.filter(w => w.generation <= generation)) waiter.resolve();
          state.waiters = state.waiters.filter(w => w.generation > generation);
        } catch (error) {
          state.done = generation;
          for (const waiter of state.waiters.filter(w => w.generation <= generation)) waiter.reject(error);
          state.waiters = state.waiters.filter(w => w.generation > generation);
        }
      }
    } finally { state.running = false; }
  }
  function mark(kind, filePath) {
    let state = states.get(kind);
    if (!state) { state = { generation: 0, done: 0, running: false, waiters: [], timer: null, paths: new Map() }; states.set(kind, state); }
    const generation = ++state.generation;
    state.paths.set(filePath, generation);
    const result = new Promise((resolve, reject) => state.waiters.push({ generation, resolve, reject }));
    if (!state.timer && !state.running) state.timer = setTimeout(() => { state.timer = null; void run(kind, state); }, delayMs);
    return result;
  }
  async function onPublished(filePath) {
    const affected = Object.entries(LIBRARY_KEYS).filter(([, key]) => (getState()[key] || []).some(library => within(filePath, library.path)));
    const results = await Promise.allSettled(affected.map(([kind]) => mark(kind, filePath)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return { onPublished };
}
