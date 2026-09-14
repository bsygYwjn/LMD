import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const project = path.resolve(process.env.LMD_TEST_PROJECT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const { readMp4Boxes } = await import(pathToFileURL(path.join(project, 'server/playback-mp4.mjs')));
function header(size, extended = false) {
  const b = Buffer.alloc(extended ? 16 : 8); b.writeUInt32BE(extended ? 1 : size); b.write('mdat', 4);
  if (extended) b.writeBigUInt64BE(BigInt(size), 8); return b;
}
async function* bytes(buffer) { for (const byte of buffer) yield Buffer.from([byte]); }
async function consume(buffer) {
  for await (const box of readMp4Boxes(bytes(buffer))) {
    assert.equal(typeof box.chunks, 'function', 'requires issue 02 streaming parser');
    for await (const _ of box.chunks()) void _;
  }
}
for (const data of [header(0), header(7), header(15, true), header(128 * 1024 ** 2 + 1), header(2 ** 54, true)]) {
  await assert.rejects(consume(data), /safety limit/, 'invalid/oversized lengths must fail before allocation');
}
for (const data of [header(20).subarray(0, 7), header(20, true).subarray(0, 15), header(20)]) {
  await assert.rejects(consume(data), /Incomplete MP4 fragment/);
}
await consume(Buffer.concat([header(19, true), Buffer.from([1, 2, 3]), header(8)]));
let closed = false;
async function* interrupted() {
  try { yield header(4096); yield Buffer.alloc(8); throw new Error('upstream aborted'); }
  finally { closed = true; }
}
await assert.rejects(async () => {
  for await (const box of readMp4Boxes(interrupted())) for await (const _ of box.chunks()) void _;
}, /upstream aborted/);
assert.equal(closed, true);
console.log('PASS extended headers, invalid sizes, truncation, upstream interruption (parser scope only)');
