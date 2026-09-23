import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, labelCommand } from './label-prompt.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'lmd-external-agent-'));
const cli = fileURLToPath(new URL('./lmd-label.mjs', import.meta.url));
const requests = [];
const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ method: request.method, url: new URL(request.url, 'http://localhost'), body });
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(request.url.startsWith('/api/labels/claim') ? { batchId: null, groups: [] } : { pending: 2, completed: 1, review: 0, claimed: 0 }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, ...args, '--port', String(port)], { cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  child.on('error', reject);
  child.on('exit', code => resolve({ code, stdout, stderr }));
});
try {
  const generated = await run(['prompt', '--folder', 'アニメ']);
  assert.equal(generated.code, 0, generated.stderr);
  assert.ok(generated.stdout.includes(process.execPath));
  assert.ok(generated.stdout.includes(cli));
  assert.ok(generated.stdout.includes("'--folder' 'アニメ' '--scope' 'recursive'"));
  assert.ok(generated.stdout.includes('不要完成一部或一批后就停止'));
  assert.ok(generated.stdout.includes('pending=0 且 claimed=0'));
  assert.ok(!generated.stdout.includes('node tools/'));
  assert.equal(requests.length, 0, 'prompt generation does not claim tasks or need a running service');
  const status = await run(['status', '--folder', 'アニメ']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).pending, 2);
  assert.equal(requests.at(-1).url.searchParams.get('folder'), 'アニメ');
  assert.equal(requests.at(-1).url.searchParams.get('scope'), 'recursive');
  const claim = await run(['claim', '--folder', 'アニメ']);
  assert.equal(claim.code, 0, claim.stderr);
  assert.deepEqual(requests.at(-1).body, { folder: 'アニメ', scope: 'recursive', limit: 10, retry: false });
  const invalid = await run(['claim', '--folder', 'アニメ', '--id', 'some-id']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /只可指定一种/);
  const resultFile = path.join(temporary, '带 空格.json');
  await writeFile(resultFile, '\uFEFF' + JSON.stringify({ batchId: 'known-batch', groups: [] }));
  assert.equal((await run(['validate', '--file', resultFile])).code, 0);
  assert.deepEqual(requests.at(-1).body, { batchId: 'known-batch', groups: [] });
  const options = { nodePath: process.execPath, cliPath: cli, port, ids: ['one', 'two'], retry: true };
  const retryPrompt = buildPrompt(options);
  assert.equal(retryPrompt.match(/'--retry'/g)?.length, 1, 'explicit review retry appears only on the first claim, never the ongoing loop');
  assert.ok(retryPrompt.includes("'--ids' 'one,two'"));
  assert.ok(labelCommand({ ...options, cliPath: "C:\\O'Brien $test\\label.mjs" }, 'status').includes("'C:\\O''Brien $test\\label.mjs'"), 'PowerShell paths remain literal including apostrophes and dollar signs');
  await new Promise(resolve => server.close(resolve));
  const offline = await run(['status']);
  assert.equal(offline.code, 1);
  assert.match(offline.stderr, /请先手动启动服务/);
  console.log('label CLI: external cwd, absolute paths, recursive folder scope, scoped status, BOM results, literal quoting, one-shot review retry, offline error passed');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
