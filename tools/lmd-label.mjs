#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export { prompt } from "./label-prompt.mjs";
import { buildPrompt } from "./label-prompt.mjs";

export async function main(input = process.argv.slice(2)) {
  const args = [...input];
  const command = args.shift() || 'status', opts = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--port', '--id', '--ids', '--folder', '--scope', '--limit', '--file', '--batch', '--retry'].includes(flag)) throw new Error(`未知参数 ${flag}`);
    if (flag === '--retry') opts.retry = true;
    else { const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`); opts[flag.slice(2)] = value; }
  }
  const port = Number(opts.port || process.env.LMD_PORT || process.env.LANTERN_PORT || 8096);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  if (![undefined, 'direct', 'children', 'recursive'].includes(opts.scope)) throw new Error('范围应为 direct、children 或 recursive');
  if ([opts.id, opts.ids, opts.folder].filter(value => value !== undefined).length > 1) throw new Error('--id、--ids、--folder 只可指定一种');
  const selection = { ...(opts.id ? { id: opts.id } : {}), ...(opts.ids ? { ids: opts.ids.split(',') } : {}), ...(opts.folder ? { folder: opts.folder } : {}), scope: opts.scope || 'recursive' };
  if (command === 'prompt') { console.log(buildPrompt({ ...selection, nodePath: process.execPath, cliPath: fileURLToPath(import.meta.url), port, platform: process.platform, limit: Number(opts.limit || 3), retry: !!opts.retry })); return; }
  if (!['status', 'targets', 'claim', 'validate', 'apply', 'release'].includes(command)) throw new Error('命令：status | targets | prompt | claim [--folder 名称或 --id ID] | validate --file | apply --file | release --batch');
  let body;
  if (command === 'claim') body = { ...selection, limit: Number(opts.limit || 10), retry: !!opts.retry };
  if (['validate', 'apply'].includes(command)) { if (!opts.file) throw new Error('需要 --file result.json'); body = JSON.parse((await readFile(opts.file, 'utf8')).replace(/^\uFEFF/u, '')); }
  if (command === 'release') { if (!opts.batch) throw new Error('需要 --batch ID'); body = { batchId: opts.batch }; }
  let response;
  const query = command === 'status' ? `?${new URLSearchParams(Object.entries(selection).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]))}` : '';
  try { response = await fetch(`http://127.0.0.1:${port}/api/labels/${command}${query}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) }); }
  catch (error) { throw new Error(`无法连接本机 LMD 服务（端口 ${port}），请先手动启动服务。${error.message}`); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  console.log(JSON.stringify(command === 'targets' ? result.filter(t => t.kind === 'folder').map(({ id, name, parentId, ancestorNames, counts, status }) => ({ id, name, parentId, ancestorNames, counts, status })) : result));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(error => { console.error(error.message); process.exitCode = 1; });
