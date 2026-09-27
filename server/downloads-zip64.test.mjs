import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import yazl from 'yazl';

// Exercise the same lazy STORE API as downloads.mjs across ZIP's 16-bit entry
// count boundary, without huge files, disk fixtures, or widening API selection.
const entryCount = 65536;
const zip = new yazl.ZipFile();
let receivedBytes = 0;
let tail = Buffer.alloc(0);
let opened = 0;
let active = 0;
let peakActive = 0;
const complete = new Promise((resolve, reject) => {
  zip.once('error', reject);
  zip.outputStream.once('error', reject);
  zip.outputStream.on('data', chunk => {
    receivedBytes += chunk.length;
    tail = Buffer.concat([tail, chunk]).subarray(-256);
  });
  zip.outputStream.once('end', resolve);
});
for (let index = 0; index < entryCount; index++) {
  zip.addReadStreamLazy(`empty/${index}.dat`, { size: 0, compress: false, mtime: new Date('2026-01-01T00:00:00Z') }, callback => {
    opened += 1;
    peakActive = Math.max(peakActive, ++active);
    const source = Readable.from([]);
    source.once('end', () => { active -= 1; });
    callback(null, source);
  });
}
zip.end();
await complete;
assert.equal(opened, entryCount);
assert.equal(active, 0);
assert.equal(peakActive, 1, 'lazy source streams are opened one at a time');
assert.ok(receivedBytes < 20 * 1024 * 1024, 'ZIP64 threshold fixture remains small');

const eocd = tail.length - 22;
assert.equal(tail.readUInt32LE(eocd), 0x06054b50, 'classic end record is retained for compatibility');
assert.equal(tail.readUInt16LE(eocd + 8), 0xffff);
assert.equal(tail.readUInt16LE(eocd + 10), 0xffff);
const locator = eocd - 20;
assert.equal(tail.readUInt32LE(locator), 0x07064b50, 'ZIP64 locator is generated automatically');
const record = locator - 56;
assert.equal(tail.readUInt32LE(record), 0x06064b50, 'ZIP64 end-of-central-directory record exists');
assert.equal(tail.readBigUInt64LE(record + 4), 44n);
assert.equal(tail.readBigUInt64LE(record + 24), BigInt(entryCount));
assert.equal(tail.readBigUInt64LE(record + 32), BigInt(entryCount));
assert.equal(tail.readBigUInt64LE(locator + 8), BigInt(receivedBytes - tail.length + record));
console.log(`PASS automatic ZIP64 for ${entryCount} lazy STORE entries (${receivedBytes} bytes, one source stream at a time)`);
