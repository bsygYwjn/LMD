// Opt-in real PGS endpoint + real FFmpeg PNG decoding + independently approved reference.
// Missing fixture is NOT a pass. This never generates its reference from the output under test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

if (!process.argv[2]) { console.error('NOT ACCEPTED: supply a reference manifest (see issue-08-acceptance.md)'); process.exit(2); }
const manifestPath = path.resolve(process.argv[2]);
const spec = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(spec.codec, 'hdmv_pgs_subtitle');
assert.ok(spec.start >= 300 && spec.duration > 0 && spec.duration <= 35, 'must test a middle-of-file bounded window');
assert.ok(spec.referenceProvenance && spec.expected.length, 'independent reference provenance and cues are required');
const root = await mkdtemp(path.join(tmpdir(), 'lmd-pgs-reference-'));
const decode = file => new Promise((resolve, reject) => {
  const child = spawn(spec.ffmpeg, ['-v','error','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'], { windowsHide: true });
  const chunks = []; let stderr = '', size = 0;
  const timer = setTimeout(() => child.kill(), 15000);
  child.stdout.on('data', b => { size += b.length; if (size > 64 * 1024 ** 2) child.kill(); else chunks.push(b); });
  child.stderr.on('data', b => stderr += b);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr || 'FFmpeg failed/timed out')); });
});
try {
  const infoResponse = await fetch(`${spec.base}/api/media/${encodeURIComponent(spec.mediaId)}/info`, { signal: AbortSignal.timeout(15000) });
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.ok(info.tracks.some(t => Number(t.index) === Number(spec.track) && t.codec === 'hdmv_pgs_subtitle'), 'endpoint must identify a real PGS track');
  const started = performance.now();
  const response = await fetch(`${spec.base}/api/media/${encodeURIComponent(spec.mediaId)}/bitmap-subtitles/${spec.track}?start=${spec.start}&duration=${spec.duration}`, { signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200); const index = await response.json();
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < spec.maxWindowMs, `window latency ${elapsedMs} exceeds budget ${spec.maxWindowMs}`);
  const results = [];
  for (const expected of spec.expected) {
    const cue = index.cues.find(c => Math.abs(c.start - expected.start) < 0.1);
    assert.ok(cue, `missing cue at ${expected.start}`);
    for (const field of ['x','y','width','height']) assert.equal(cue[field], expected[field], `cue ${expected.start} ${field}`);
    const url = new URL(cue.url, spec.base); assert.equal(url.origin, new URL(spec.base).origin);
    const image = await fetch(url, { signal: AbortSignal.timeout(15000) }); assert.equal(image.status, 200);
    const actualFile = path.join(root, 'actual.png'); await writeFile(actualFile, Buffer.from(await image.arrayBuffer()));
    const reference = path.resolve(path.dirname(manifestPath), expected.png);
    assert.equal(createHash('sha256').update(await readFile(reference)).digest('hex'), expected.sha256, 'reference must remain unchanged');
    const [actual, wanted] = await Promise.all([decode(actualFile), decode(reference)]);
    assert.equal(actual.length, expected.width * expected.height * 4); assert.equal(actual.length, wanted.length);
    let maxDifference = 0, total = 0, transparent = 0, colored = 0;
    for (let i = 0; i < actual.length; i++) { const d = Math.abs(actual[i] - wanted[i]); maxDifference = Math.max(maxDifference, d); total += d; }
    for (let i = 0; i < actual.length; i += 4) { if (wanted[i + 3] === 0) transparent++; if (wanted[i + 3] && wanted[i] !== wanted[i + 1]) colored++; }
    assert.ok(transparent && colored, 'reference must exercise both transparency and color');
    assert.ok(maxDifference <= 3 && total / actual.length <= 0.5, 'RGBA mismatch including alpha');
    results.push({ start: cue.start, maxDifference, meanDifference: total / actual.length });
  }
  console.log(JSON.stringify({ scope: 'real endpoint pixels, geometry and request latency; does not prove bounded decoding/cancellation', elapsedMs, results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
