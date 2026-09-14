import assert from "node:assert/strict";
import { LatestTaskQueue } from "./latest-task-queue.ts";

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

{
  const submitted: number[] = [], accepted: number[] = [];
  const queue = new LatestTaskQueue<number>(async (value, context) => {
    submitted.push(value);
    if (context.isLatest()) accepted.push(value);
  }, 10);
  const requests = Array.from({ length: 10 }, (_, index) => queue.enqueue(index));
  await Promise.all(requests);
  assert.deepEqual(submitted, [9], "ten rapid updates must submit only the final value");
  assert.deepEqual(accepted, [9]);
  queue.dispose();
}

{
  let releaseFirst = () => {};
  let markStarted = () => {};
  const firstStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const submitted: number[] = [], accepted: number[] = [];
  let active = 0, maximumActive = 0;
  const queue = new LatestTaskQueue<number>(async (value, context) => {
    submitted.push(value);
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (value === 1) { markStarted(); await firstGate; }
    if (context.isLatest()) accepted.push(value);
    active--;
  }, 5);
  const first = queue.enqueue(1);
  await firstStarted;
  const second = queue.enqueue(2);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(submitted, [1, 2], "an update arriving in flight must run after the first request settles");
  assert.deepEqual(accepted, [2], "a late response must not replace the latest intent");
  assert.equal(maximumActive, 1, "generation-changing requests must be serialized");
  queue.dispose();
}

{
  let submitted = false;
  const queue = new LatestTaskQueue<number>(async () => { submitted = true; }, 10);
  const pending = queue.enqueue(1);
  queue.cancel();
  await pending;
  await delay(15);
  assert.equal(submitted, false, "cancelled work must not reach the session API");
  queue.dispose();
}

console.log("Latest task queue: debounce, serialization, stale response and cancellation passed");
