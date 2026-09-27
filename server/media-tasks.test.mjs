import assert from 'node:assert/strict';
import { createMediaTaskScheduler, conservativeDeviceKey } from './media-tasks.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const expectAbort = promise => assert.rejects(promise, error => error.name === 'AbortError');

// Cancelling one viewer never terminates work still needed by another viewer.
{
  const scheduler = createMediaTaskScheduler(), gate = deferred();
  const first = new AbortController(), second = new AbortController();
  let starts = 0, underlyingSignal;
  const run = async ({ signal }) => { starts++; underlyingSignal = signal; await gate.promise; return 'shared'; };
  const a = scheduler.schedule({ key: 'media:version:track', signal: first.signal, run });
  const b = scheduler.schedule({ key: 'media:version:track', signal: second.signal, priority: 0, run });
  const cancelled = expectAbort(a); await tick(); first.abort(); await cancelled;
  assert.equal(starts, 1); assert.equal(underlyingSignal.aborted, false);
  gate.resolve(); assert.equal(await b, 'shared');
  assert.equal(scheduler.snapshot().metrics.joined, 1); await scheduler.close();
}
// Last cancellation does not free a physical slot before the subprocess exits.
{
  const scheduler = createMediaTaskScheduler({ globalLimit: 1 }), exit = deferred();
  const signal = new AbortController(); let starts = 0;
  const a = scheduler.schedule({ key: 'same', signal: signal.signal, run: async () => { starts++; await exit.promise; } });
  const cancelled = expectAbort(a); await tick(); signal.abort(); await cancelled;
  const b = scheduler.schedule({ key: 'same', run: async () => { starts++; return 'new'; } });
  await tick(); assert.equal(starts, 1); assert.equal(scheduler.snapshot().running, 1);
  assert.equal(scheduler.snapshot().queued, 1);
  exit.resolve(); assert.equal(await b, 'new'); assert.equal(starts, 2); await scheduler.close();
}
// Different drive letters on an unknown physical topology cannot oversubscribe.
{
  const scheduler = createMediaTaskScheduler(), gate = deferred(); const started = [];
  const submit = (key, sourcePath, kind) => scheduler.schedule({ key, sourcePath, kind, run: async () => { started.push(key); await gate.promise; } });
  const a = submit('long-a', 'C:\\media\\a.mkv', 'subtitle');
  const b = submit('long-b', 'D:\\media\\b.mkv', 'font');
  const c = submit('short', 'E:\\media\\c.mkv', 'probe');
  await tick(); assert.deepEqual(started, ['long-a', 'short']);
  assert.equal(scheduler.snapshot().running, 2);
  gate.resolve(); await Promise.all([a, b, c]); await scheduler.close();
  assert.equal(conservativeDeviceKey('\\\\NAS\\share-a\\x'), conservativeDeviceKey('\\\\nas\\share-b\\y'));
}
// Priority upgrades operate on the queued shared task, without another FFprobe.
{
  const scheduler = createMediaTaskScheduler({ globalLimit: 1 }), gate = deferred(), started = [];
  const hold = scheduler.schedule({ key: 'hold', run: () => gate.promise });
  const a = scheduler.schedule({ key: 'background', priority: 80, run: () => started.push('background') });
  const b = scheduler.schedule({ key: 'probe', priority: 40, run: () => started.push('probe') });
  const joined = scheduler.schedule({ key: 'probe', priority: 0, run: () => assert.fail('duplicate') });
  gate.resolve(); await Promise.all([hold, a, b, joined]); assert.deepEqual(started, ['probe', 'background']); await scheduler.close();
}
// Aging is bounded by actual waiting time; old background work gets service.
{
  let clock = 0; const scheduler = createMediaTaskScheduler({ globalLimit: 1, now: () => clock, agingMs: 10 });
  const gate = deferred(), started = [];
  const hold = scheduler.schedule({ key: 'hold', run: () => gate.promise });
  const old = scheduler.schedule({ key: 'old', priority: 80, run: () => started.push('old') });
  clock = 1000;
  const playback = scheduler.schedule({ key: 'new', priority: 0, run: () => started.push('new') });
  gate.resolve(); await Promise.all([hold, old, playback]); assert.deepEqual(started, ['old', 'new']); await scheduler.close();
}
// Queue deadlines/capacity and playback reservations provide real backpressure.
{
  const scheduler = createMediaTaskScheduler({ maxQueued: 1 }), gate = deferred();
  const release = scheduler.reservePlayback('D:\\movie.mkv');
  const a = scheduler.schedule({ key: 'active', kind: 'probe', run: () => gate.promise });
  const deadline = scheduler.schedule({ key: 'deadline', queueTimeoutMs: 15, run: () => assert.fail('expired task ran') });
  await assert.rejects(scheduler.schedule({ key: 'overflow', run: () => {} }), { code: 'TASK_QUEUE_FULL' });
  const expired = assert.rejects(deadline, { code: 'TASK_QUEUE_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 25)); await expired;
  assert.equal(scheduler.snapshot().playbackReaders, 1); release(); release();
  assert.equal(scheduler.snapshot().playbackReaders, 0); gate.resolve(); await a;
  const failure = new Error('tool failed');
  await assert.rejects(scheduler.schedule({ key: 'failure', run: () => { throw failure; } }), /tool failed/);
  assert.equal(scheduler.snapshot().running, 0); await scheduler.close();
  await assert.rejects(scheduler.schedule({ key: 'closed', run: () => {} }), { code: 'SCHEDULER_CLOSED' });
}
console.log('PASS shared consumers, exit barrier, physical-device fallback, priority upgrade, aging, playback reservation, deadlines and backpressure');
