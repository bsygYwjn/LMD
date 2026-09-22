#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export { prompt } from "./label-prompt.mjs";
import { prompt } from "./label-prompt.mjs";

export async function main(args = process.argv.slice(2)) {
  const command = args.shift() || 'status', opts = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--port', '--id', '--ids', '--scope', '--limit', '--file', '--batch', '--retry'].includes(flag)) throw new Error(`未知参数 ${flag}`);
    if (flag === '--retry') opts.retry = true;
    else { const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`); opts[flag.slice(2)] = value; }
  }
  const port = Number(opts.port || process.env.LMD_PORT || process.env.LANTERN_PORT || 8096);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  if (command === 'prompt') { console.log(prompt); return; }
  if (!['status', 'claim', 'validate', 'apply', 'release'].includes(command)) throw new Error('命令：status | prompt | claim | validate --file | apply --file | release --batch');
  let body;
  if (command === 'claim') body = { ...(opts.id ? { id: opts.id } : {}), ...(opts.ids ? { ids: opts.ids.split(',') } : {}), scope: opts.scope || 'direct', limit: Number(opts.limit || 10), retry: !!opts.retry };
  if (['validate', 'apply'].includes(command)) { if (!opts.file) throw new Error('需要 --file result.json'); body = JSON.parse((await readFile(opts.file, 'utf8')).replace(/^\uFEFF/u, '')); }
  if (command === 'release') { if (!opts.batch) throw new Error('需要 --batch ID'); body = { batchId: opts.batch }; }
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/api/labels/${command}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new Error(`无法连接本机 LMD 服务（端口 ${port}），请先手动启动服务。${error.message}`); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(error => { console.error(error.message); process.exitCode = 1; });
