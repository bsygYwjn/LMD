import assert from "node:assert/strict";
import { SubtitlePreparationController, type SubtitlePreparation } from "./subtitle-preparation.ts";

const requests: Array<{ url: string; body: any; method?: string; signal?: AbortSignal; resolve: (result: any) => void; reject: (error: Error) => void }> = [];
const states: SubtitlePreparation[] = [];
const controller = new SubtitlePreparationController(<T>(url: string, body?: unknown, method?: string, signal?: AbortSignal) => new Promise<T>((resolve, reject) => requests.push({ url, body, method, signal, resolve, reject })), state => states.push(state));
const flush = () => new Promise(resolve => setImmediate(resolve));
function respond(request: typeof requests[number], state = "ready", overrides: Record<string, unknown> = {}) {
  request.resolve({ sessionId: request.url.split("/").at(-1), sourceVersion: "v1", subtitle: { selectionGeneration: request.body?.subtitleSelectionGeneration ?? states.at(-1)!.selectionGeneration,
    sourceVersion: "v1", trackId: request.body?.subtitleTrackId ?? states.at(-1)!.trackId, state, subtitle: { id: "a", url: "/a.vtt" }, fonts: [], error: null }, ...overrides });
}
controller.bind("session1", "v1");
assert.equal(requests.length, 0, "opening a session with subtitles off must not prepare resources");
controller.select("a"); const a = requests.at(-1)!;
controller.select("b"); const b = requests.at(-1)!;
controller.select(null); const off = requests.at(-1)!;
assert.equal(a.signal?.aborted, true); assert.equal(b.signal?.aborted, true);
assert.equal(off.body.subtitleTrackId, null);
assert.ok(a.body.subtitleSelectionGeneration < b.body.subtitleSelectionGeneration && b.body.subtitleSelectionGeneration < off.body.subtitleSelectionGeneration);
respond(off, "off"); await flush();
const beforeLate = states.length;
respond(b); respond(a); await flush();
assert.equal(states.length, beforeLate, "late A/B responses cannot re-enable a disabled track");
assert.equal(states.at(-1)!.state, "off");
controller.select("a"); const oldSession = requests.at(-1)!;
controller.bind("session2", "v1"); const newSession = requests.at(-1)!;
respond(oldSession); await flush();
assert.equal(states.at(-1)!.state, "queued", "old session completion cannot publish into the replacement session");
respond(newSession, "queued"); await flush();
await new Promise(resolve => setTimeout(resolve, 700));
const poll = requests.at(-1)!; assert.equal(poll.method, "GET");
respond(poll); await flush(); assert.equal(states.at(-1)!.state, "ready");
controller.select("a", true); const retry = requests.at(-1)!;
retry.reject(new Error("temporary I/O failure")); await flush();
assert.match(states.at(-1)!.error!.message, /temporary/);
controller.select("a", true); const changed = requests.at(-1)!;
respond(changed, "ready", { sourceVersion: "v2" }); await flush();
assert.equal(states.at(-1)!.error?.code, "SOURCE_CHANGED");
controller.select("b"); const abandoned = requests.at(-1)!;
controller.dispose(); const disposedCount = states.length; respond(abandoned); await flush();
assert.equal(states.length, disposedCount, "leaving the player rejects pending completions");
assert.ok(requests.filter(request => request.method === "PATCH").every(request => !("generation" in request.body)), "subtitle updates never advance the A/V generation");
console.log("PASS: subtitle off, A→B→off races, session/source guards, polling, retry and disposal");
