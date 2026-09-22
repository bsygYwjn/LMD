// Run each size/concurrency in a fresh process; do not retain a synthetic 128 MiB input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const project = path.resolve(process.env.LMD_TEST_PROJECT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const modulePath = path.join(project, 'server/playback-mp4.mjs');
const MiB = 1024 ** 2;
if (process.argv[2] === '--worker') {
  const { readMp4Boxes } = await import(pathToFileURL(modulePath));
  const size = Number(process.argv[3]) * MiB, concurrency = Number(process.argv[4]);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  async function* source() {
    const header = Buffer.alloc(8); header.writeUInt32BE(size); header.write('mdat', 4); yield header;
    for (let left = size - 8; left > 0;) {
      // Fresh buffers approximate independent stdout chunks (no shared backing allocation).
      const block = Buffer.alloc(Math.min(left, 64 * 1024), 37); left -= block.length; yield block;
    }
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    let bytes = 0, chunks = 0;
    for await (const box of readMp4Boxes(source())) {
      assert.equal(typeof box.chunks, 'function', 'requires streaming implementation from issue 02');
      for await (const chunk of box.chunks()) {
        bytes += chunk.length; chunks++;
        assert.ok(chunk.length <= 64 * 1024, 'parser must not assemble full mdat');
        if (bytes > 8) assert.equal(chunk.at(-1), 37);
        if (chunks % 32 === 0) { sample(); await new Promise(resolve => setImmediate(resolve)); }
      }
    }
    assert.equal(bytes, size); sample();
  }));
  const result = { sizeMiB: size / MiB, concurrency, elapsedMs: performance.now() - start,
    baselineMiB: baseline / MiB, peakMiB: peak / MiB, deltaMiB: (peak - baseline) / MiB };
  // A bounded parser must not retain one whole box per consumer (10 x 128 MiB).
  assert.ok(result.deltaMiB < 192 && result.peakMiB < 384, `RSS budget exceeded: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result));
} else {
  const rows = [];
  for (const [size, concurrency] of [[64, 1], [128, 1], [64, 5], [128, 10]]) {
    rows.push(await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', String(size), String(concurrency)], { windowsHide: true, env: process.env });
      let out = '', err = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('box budget timed out after 90s')); }, 90000);
      child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(err || `worker exit ${code}`)); else { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } } });
    }));
  }
  assert.ok(rows[1].elapsedMs < rows[0].elapsedMs * 3.5 + 100, '128 MiB runtime exceeds linear-growth tolerance');
  console.log(JSON.stringify({ scope: 'parser only; excludes FFmpeg, disk publication and browser', project,
    moduleSha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), node: process.version, results: rows }, null, 2));
}
