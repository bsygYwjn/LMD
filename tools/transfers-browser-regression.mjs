// Real HTTP LAN acceptance against isolated libraries/state. Never uses :8096.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.LMD_PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(tmpdir(), 'lmd-transfer-browser-'));
const data = path.join(root, 'state'); await mkdir(data);
await writeFile(path.join(data,'state.json'),JSON.stringify({settings:{autoScanEnabled:false,autoPrepareCompatibleCopies:false}}));
const probe=createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
const base=`http://127.0.0.1:${port}`;
let browser, child, lan, errors='';
const api=async (url,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(base+url,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); const value=await response.json(); assert.ok(response.ok,`${url}: ${JSON.stringify(value)}`); return value;};
try {
  child=spawn(process.execPath,[path.join(project,'server/index.mjs')],{cwd:project,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,LMD_PORT:String(port),LMD_DATA_DIR:data,LMD_WEB_DIR:process.env.LMD_FRONTEND_DIST || path.join(project,'dist')}});
  child.stderr.on('data',chunk=>errors+=chunk);
  for(let i=0;i<200;i++){try{lan=(await api('/api/health')).lanAddresses[0];break;}catch{} await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(lan,`LAN startup ${errors}`);
  const libraries={};
  for(const kind of ['video','music','reading','photos','files']){const folder=path.join(root,kind);await mkdir(folder);libraries[kind]=folder;await api(kind==='video'?'/api/libraries':`/api/${kind}/libraries`,{folderPath:folder});}
  const wav=Buffer.alloc(44+8000*2*90);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  await writeFile(path.join(libraries.music,'听歌.wav'),wav);await writeFile(path.join(libraries.music,'听歌.lrc'),'[00:00.00]局域网测试');await api('/api/music/catalog/scan',{});
  await writeFile(path.join(libraries.photos,'隔离.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.svgExecuted=true"><script>window.svgExecuted=true;fetch(\'/api/health?svg_probe=script\')</script><image href="/api/health?svg_probe=image"/></svg>');await api('/api/photos/catalog/scan',{});
  await api('/api/access-control',{enabled:true},'PATCH');await api('/api/access-control/users',{accessCode:'314159',categoryIds:['__uncategorized__'],canUpload:true});
  browser=await chromium.launch({headless:true});const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  assert.equal((await context.request.post(lan+'/api/auth/login',{data:{accessCode:'314159'}})).status(),200);
  await page.goto(lan);await page.waitForSelector('.appbar-nav');
  assert.deepEqual(await page.evaluate(()=>({secure:isSecureContext,subtle:!!crypto.subtle,uuid:!!crypto.randomUUID})),{secure:false,subtle:false,uuid:false});
  assert.equal(await page.locator('.appbar-nav button').count(),5);
  await page.getByRole('button',{name:'音乐',exact:true}).click();
  await page.locator('.track-play-content').first().click();await page.waitForFunction(()=>[...document.querySelectorAll('audio')].some(a=>!a.paused));
  await page.getByRole('button',{name:'其他文件',exact:true}).click();
  await page.getByRole('button',{name:'上传文件与新建文件夹'}).click();
  const inputDirectory=path.join(root,'用户选中的目录');await mkdir(inputDirectory);await mkdir(path.join(inputDirectory,'子目录'));const original=Buffer.alloc(17*1024*1024,97);await writeFile(path.join(inputDirectory,'子目录','续传.bin'),original);
  let secondChunk, release;
  const held=new Promise(resolve=>{secondChunk=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/uploads/*/chunks?offset=8388608',async route=>{secondChunk();await gate;await route.continue().catch(()=>{});});
  await page.locator('input[webkitdirectory]').setInputFiles(inputDirectory);
  await page.getByRole('button',{name:/^上传.*个文件$/}).click();let chunkTimer;try{await Promise.race([held,new Promise((_,reject)=>{chunkTimer=setTimeout(()=>reject(new Error('second upload chunk timeout')),45000);})]);}finally{clearTimeout(chunkTimer);}
  await page.getByRole('button',{name:'收起上传窗口'}).click();
  await page.getByRole('button',{name:'视频',exact:true}).click();assert.ok(await page.locator('.upload-queue-toggle').isVisible());
  assert.ok(await page.evaluate(()=>[...document.querySelectorAll('audio')].some(a=>!a.paused && a.currentTime>0)),'music continues across sections during upload');
  await page.reload();release();await page.unroute('**/api/uploads/*/chunks?offset=8388608');await page.waitForSelector('.upload-queue-toggle');
  await page.locator('.upload-queue-toggle').click();await page.getByText('请重选原文件以续传',{exact:false}).first().waitFor();
  await page.locator('.upload-queue input[type=file]').first().setInputFiles(path.join(inputDirectory,'子目录','续传.bin'));
  await page.getByText('上传完成',{exact:true}).waitFor({timeout:60000});
  assert.deepEqual(await readFile(path.join(libraries.files,'用户选中的目录','子目录','续传.bin')),original);
  console.log('PASS real HTTP LAN without subtle/randomUUID: folder hierarchy, worker SHA256, persistent cross-section queue, music playback and refresh/reselect resume');
  await page.getByRole('button',{name:'收起上传窗口'}).click();await page.getByRole('button',{name:'音乐',exact:true}).click();
  await page.getByLabel('全选当前结果').check();await page.getByRole('button',{name:'准备 ZIP',exact:true}).click();await page.getByText(/准备完成/).waitFor();
  const native=page.waitForEvent('download');await page.getByRole('button',{name:'下载 ZIP',exact:true}).click();const download=await native;const archive=path.join(root,'native.zip');await download.saveAs(archive);assert.equal((await readFile(archive)).readUInt32LE(),0x04034b50);await page.getByText(/已交给浏览器/).waitFor();
  assert.ok((await readFile(archive)).includes(Buffer.from('听歌.lrc')));
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'phone navigation and selection bar fit');
  console.log('PASS native STORE ZIP download with sidecar, truthful download state and phone navigation/selection layout');
  const photoCatalog=await api('/api/photos/catalog');const item=photoCatalog.items[0];let probes=0;
  const svg=await context.newPage();const blocked=[],violations=[];svg.on('console',message=>{if(/Content Security Policy|sandboxed/i.test(message.text()))violations.push(message.text());});svg.on('response',response=>{if(response.url().includes('svg_probe='))probes++;});svg.on('requestfailed',request=>{if(request.url().includes('svg_probe='))blocked.push(request.failure()?.errorText);});
  for(const url of [`/api/photos/items/${item.id}/file`,item.previewUrl,item.thumbnailUrl]){await svg.goto(lan+url);await svg.waitForTimeout(100);assert.equal(await svg.evaluate(()=>window.svgExecuted),undefined);}
  assert.equal(probes,0,'SVG direct URLs cannot run scripts or request same-origin external resources');
  assert.equal(blocked.length,3,'each SVG external image fails before a response');
  assert.ok(violations.length>=3,`browser reports SVG policy violations: ${JSON.stringify(blocked)}`);
  console.log('PASS SVG file/preview/thumbnail direct navigation sandbox blocks scripts and external references');
  assert.deepEqual(pageErrors,[]);
} finally {
  await browser?.close();if(child && child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));await fetch(base+'/api/service/stop',{method:'POST'}).catch(()=>child.kill());await exited;}await rm(root,{recursive:true,force:true});
}
