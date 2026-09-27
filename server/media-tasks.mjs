// One scheduler is shared by indexing, playback and requested resources. Unknown
// local volumes intentionally share a conservative budget: a drive letter is
// not proof of a separate physical disk. Deployments may supply verified mapping.
export function conservativeDeviceKey(sourcePath = '') {
  const normalized = String(sourcePath).replaceAll('\\', '/').toLowerCase();
  const unc = normalized.match(/^\/\/([^/]+)\//);
  return unc ? `network:${unc[1]}` : 'local-disks';
}

const abortError = (message = '资源请求已取消', code = 'TASK_CANCELLED') => Object.assign(new Error(message), { name: 'AbortError', code, statusCode: 409 });
const longKinds = new Set(['subtitle', 'font', 'attachment', 'remux', 'bitmap', 'transcode', 'background-media']);

export function createMediaTaskScheduler({ globalLimit = 4, deviceLimit = 2, longLimit = 1, maxQueued = 256,
  queueTimeoutMs = 5 * 60_000, agingMs = 1000, deviceForPath = conservativeDeviceKey, now = Date.now } = {}) {
  const tasks = new Map(), running = new Set(), playback = new Map();
  const history = [];
  const metrics = { submitted: 0, joined: 0, completed: 0, failed: 0, cancelled: 0, rejected: 0, queueWaitMs: 0, executionMs: 0 };
  let sequence = 0, closed = false, pumping = false;
  globalLimit = Math.max(1, Math.floor(globalLimit));
  deviceLimit = Math.max(1, Math.floor(deviceLimit));
  longLimit = Math.max(1, Math.min(deviceLimit, Math.floor(longLimit)));

  function eligible(task) {
    if (running.size >= globalLimit || task.state !== 'queued') return false;
    const active = [...running].filter(item => item.device === task.device);
    // Continuous playback has its own lifetime and takes one device lane. Keep
    // one preparation lane so a selected subtitle can still become available.
    const budget = playback.has(task.device) ? Math.max(1, deviceLimit - 1) : deviceLimit;
    if (active.length >= budget) return false;
    return !longKinds.has(task.kind) || active.filter(item => longKinds.has(item.kind)).length < longLimit;
  }
  function priority(task) { return task.priority - Math.floor(Math.max(0, now() - task.queuedAt) / Math.max(1, agingMs)); }
  function forget(task) { if (tasks.get(task.key) === task) tasks.delete(task.key); }
  function finishConsumer(consumer, error, value) {
    if (consumer.finished) return;
    consumer.finished = true;
    consumer.signal?.removeEventListener('abort', consumer.abort);
    if (error) consumer.reject(error); else consumer.resolve(value);
  }
  function cancelEmpty(task) {
    if (task.consumers.size) return;
    task.controller.abort(abortError());
    if (task.state === 'queued') {
      clearTimeout(task.timer); task.state = 'cancelled'; forget(task); metrics.cancelled++;
    } else if (task.state === 'running') task.state = 'cancelling';
    // A new consumer must not attach to an already aborted execution. Its new
    // task can queue, but the old execution retains its slot until run settles.
    forget(task);
    pump();
  }
  function expire(task) {
    if (task.state !== 'queued') return;
    const error = abortError('资源排队超时，请重试', 'TASK_QUEUE_TIMEOUT');
    task.controller.abort(error); task.state = 'failed'; forget(task); metrics.failed++;
    for (const consumer of task.consumers) finishConsumer(consumer, error);
    task.consumers.clear(); pump();
  }
  function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (running.size < globalLimit) {
        const candidates = [...tasks.values()].filter(eligible).sort((a, b) => priority(a) - priority(b) || a.sequence - b.sequence);
        if (!candidates.length) break;
        start(candidates[0]);
      }
    } finally { pumping = false; }
  }
  function start(task) {
    clearTimeout(task.timer);
    task.state = 'running'; task.startedAt = now(); running.add(task);
    const wait = Math.max(0, task.startedAt - task.queuedAt);
    metrics.queueWaitMs += wait;
    Promise.resolve().then(() => {
      task.controller.signal.throwIfAborted();
      return task.run({ signal: task.controller.signal, task });
    }).then(value => settle(task, null, value), error => settle(task, error));
  }
  function settle(task, error, value) {
    const finishedAt = now(), executionMs = Math.max(0, finishedAt - task.startedAt);
    if (task.controller.signal.aborted) error ||= task.controller.signal.reason || abortError();
    task.state = error ? (task.controller.signal.aborted ? 'cancelled' : 'failed') : 'ready';
    metrics[error ? (task.state === 'cancelled' ? 'cancelled' : 'failed') : 'completed']++;
    metrics.executionMs += executionMs;
    history.push({ kind: task.kind, state: task.state, queuedAt: task.queuedAt, startedAt: task.startedAt, finishedAt,
      queueWaitMs: Math.max(0, task.startedAt - task.queuedAt), executionMs, errorCode: error?.code || null });
    if (history.length > 100) history.shift();
    running.delete(task); forget(task);
    for (const consumer of task.consumers) finishConsumer(consumer, error, value);
    task.consumers.clear(); pump();
  }
  function schedule({ key, sourcePath, kind = 'probe', priority: requestedPriority = 30, signal, run, queueTimeoutMs: deadline = queueTimeoutMs }) {
    if (closed) return Promise.reject(abortError('媒体服务正在停止', 'SCHEDULER_CLOSED'));
    if (signal?.aborted) return Promise.reject(signal.reason || abortError());
    if (!key || typeof run !== 'function') return Promise.reject(new TypeError('Task key and run callback are required'));
    const priorityValue = Number.isFinite(requestedPriority) ? Math.max(0, Math.min(100, requestedPriority)) : 30;
    let task = tasks.get(key);
    if (!task) {
      if ([...tasks.values()].filter(item => item.state === 'queued').length >= maxQueued) {
        metrics.rejected++;
        return Promise.reject(Object.assign(new Error('资源请求较多，请稍后重试'), { code: 'TASK_QUEUE_FULL', statusCode: 429 }));
      }
      task = { key, kind, device: deviceForPath(sourcePath), priority: priorityValue, run, sequence: ++sequence,
        queuedAt: now(), startedAt: null, state: 'queued', consumers: new Set(), controller: new AbortController(), timer: null };
      task.timer = setTimeout(() => expire(task), Math.max(1, Math.min(30 * 60_000, Number(deadline) || queueTimeoutMs)));
      task.timer.unref?.(); tasks.set(key, task); metrics.submitted++;
    } else {
      task.priority = Math.min(task.priority, priorityValue); metrics.joined++;
    }
    const promise = new Promise((resolve, reject) => {
      const consumer = { resolve, reject, signal, finished: false, abort: null };
      consumer.abort = () => { task.consumers.delete(consumer); finishConsumer(consumer, signal.reason || abortError()); cancelEmpty(task); };
      task.consumers.add(consumer); signal?.addEventListener('abort', consumer.abort, { once: true });
      if (signal?.aborted) consumer.abort();
    });
    pump(); return promise;
  }
  function reservePlayback(sourcePath) {
    const device = deviceForPath(sourcePath);
    playback.set(device, (playback.get(device) || 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = (playback.get(device) || 1) - 1;
      if (count) playback.set(device, count); else playback.delete(device);
      pump();
    };
  }
  function snapshot() {
    const queued = [...tasks.values()].filter(task => task.state === 'queued');
    const counts = {};
    for (const task of [...queued, ...running]) {
      counts[task.kind] ||= { queued: 0, running: 0, cancelling: 0 };
      counts[task.kind][task.state]++;
    }
    return { queued: queued.length, running: running.size, playbackReaders: [...playback.values()].reduce((a, b) => a + b, 0),
      limits: { global: globalLimit, device: deviceLimit, long: longLimit, maxQueued }, byKind: counts, metrics: { ...metrics }, recent: history.map(item => ({ ...item })) };
  }
  async function close() {
    closed = true;
    const all = new Set([...tasks.values(), ...running]);
    for (const task of all) {
      clearTimeout(task.timer);
      for (const consumer of task.consumers) finishConsumer(consumer, abortError());
      task.consumers.clear(); cancelEmpty(task);
    }
    // Do not release slots or claim idle before subprocess owners confirm exit.
    while (running.size) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return { schedule, reservePlayback, snapshot, close };
}
