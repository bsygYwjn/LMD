import assert from 'node:assert/strict';
import { PlaybackCore, audioTrackLabel } from './core.ts';

globalThis.window = new EventTarget();
const tracks = [1, 3, 7].map((index, i) => ({ id: String(index), index, type: 'audio', language: 'jpn', codec: 'flac', channels: 2, title: '', default: i === 1 }));
assert.equal(new Set(tracks.map(audioTrackLabel)).size, 3);
assert.match(audioTrackLabel(tracks[1], 1), /默认/);
assert.match(audioTrackLabel({ ...tracks[0], title: '440 Hz', forced: true }, 0), /^440 Hz.*强制/);
class Video extends EventTarget {
  currentTime = 20; volume = 0.6; muted = false; playbackRate = 1.5;
  pause() {} removeAttribute() {} load() {} play() { return Promise.resolve(); }
}
const core = new PlaybackCore(new Video());
core.mediaInfo = { mediaId: 'test', tracks };
core.capabilities = {};
core.state = { ...core.state, duration: 70, currentTime: 20, audioTrackId: '1', timeOffset: 0 };
core.session = { sessionId: 'same', generation: 1, plan: { audio: { track: tracks[0] } } };
core.desiredAudioTrackId = '1';
const requests = [];
const replies = [];
globalThis.fetch = async (url, options) => {
  if (options.method === 'DELETE') return { ok: true };
  requests.push({ url, ...JSON.parse(options.body), method: options.method });
  return new Promise(resolve => replies.push(track => resolve({ ok: true, json: async () => ({
    sessionId: 'same', generation: requests.length + 1, transport: 'native', strategy: 'REMUX', timeOffset: 18,
    plan: { audio: { track: tracks.find(t => t.id === track) } }, url: '/new', heartbeatSeconds: 100,
  }) })));
};
const first = core.selectAudioTrack('3');
await new Promise(resolve => setTimeout(resolve, 150));
const second = core.selectAudioTrack('1');
const last = core.selectAudioTrack('7');
assert.equal(requests.length, 1);
replies.shift()('3');
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(requests.length, 2);
assert.deepEqual(requests.map(r => r.audioTrackId), ['3', '7']);
assert.deepEqual(requests.map(r => r.generation), [1, 2]);
assert.ok(requests.every(r => r.method === 'PATCH' && r.position === 20 && r.url.endsWith('/same')));
replies.shift()('7');
await Promise.all([first, second, last]);
assert.equal(core.getState().audioTrackId, '7');
core.video.dispatchEvent(new Event('loadedmetadata'));
assert.equal(core.video.currentTime, 2);
assert.equal(core.currentTime, 20);
assert.equal(core.video.playbackRate, 1.5);
assert.equal(core.video.volume, 0.6);
await core.selectAudioTrack('7');
await core.selectAudioTrack('missing');
assert.equal(requests.length, 2);
core.mediaInfo.tracks = [];
await core.selectAudioTrack('1');
assert.equal(requests.length, 2);
await core.destroy();
console.log('Audio labels, serialized last-choice PATCH, timeline, settings and absent tracks passed');
