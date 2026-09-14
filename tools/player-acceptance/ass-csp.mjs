// Production browser smoke + screenshots. Screenshots still require visual approval.
// Never bypass CSP or replace JASSUB with a stub. Negative case removes only WASM permission.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, Session, delay } from './cdp.mjs';
const base = process.env.LMD_BASE_URL, title = process.env.LMD_ASS_MEDIA;
assert.ok(base && title, 'Set LMD_BASE_URL and LMD_ASS_MEDIA (exact playable ASS fixture card title)');
const output = await mkdtemp(path.join(tmpdir(), 'lmd-ass-csp-'));
const report = { base, title, visualApproval: 'NOT ACCEPTED: inspect positioning, colors and motion screenshots', cases: [] };
let browser, session;
try {
  browser = await launchBrowser({ userDataDir: path.join(output, 'profile'), port: Number(process.env.LMD_CDP_PORT || 19439) });
  session = await Session.connect(browser.wsUrl);
  await session.send('Page.enable'); await session.send('Runtime.enable'); await session.send('Network.enable');
  let blockWasm = false, interceptError;
  session.on('Fetch.requestPaused', event => { void (async () => {
    if (!blockWasm || event.resourceType !== 'Document' || event.responseStatusCode !== 200) {
      await session.send('Fetch.continueRequest', { requestId: event.requestId }); return;
    }
    const body = await session.send('Fetch.getResponseBody', { requestId: event.requestId });
    const headers = event.responseHeaders.map(h => h.name.toLowerCase() === 'content-security-policy'
      ? { ...h, value: h.value.replace(/'wasm-unsafe-eval'/g, '') } : h);
    await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: headers,
      body: body.base64Encoded ? body.body : Buffer.from(body.body).toString('base64') });
  })().catch(error => { interceptError = error; }); });
  const production = await fetch(base); const csp = production.headers.get('content-security-policy');
  report.csp = csp;
  assert.ok(csp?.includes("'wasm-unsafe-eval'") && !csp.includes("'unsafe-eval'"), 'production CSP must permit WASM only');
  await session.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
  for (const blocked of [false, true]) {
    blockWasm = blocked;
    await session.send('Network.clearBrowserCache');
    await session.send('Page.navigate', { url: base });
    await session.waitFor(`document.querySelector('[aria-label=' + CSS.escape(${JSON.stringify('播放 ' + title)}) + ']')`, { timeout: 20000 });
    await session.evaluate(`document.querySelector('[aria-label=' + CSS.escape(${JSON.stringify('播放 ' + title)}) + ']').click()`);
    await session.waitFor("document.querySelector('.lmd-stage video')?.readyState >= 2");
    await session.evaluate("document.querySelector('[aria-label=\"字幕选择\"]').click()");
    await session.waitFor("document.querySelector('.lmd-settings-panel select')");
    await session.evaluate(`(() => {
      const s = document.querySelector('.lmd-settings-panel select');
      const o = [...s.options].find(o => /ASS|SSA/.test(o.textContent)); if (!o) throw Error('ASS fixture missing');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await delay(2000);
    for (const seconds of blocked ? [2] : [2,7,12,16,32]) {
      await session.evaluate(`(() => { const v = document.querySelector('.lmd-stage video'); v.pause(); v.currentTime = ${seconds}; })()`);
      await delay(700);
      await session.screenshot(path.join(output, `${blocked ? 'blocked' : 'production'}-${seconds}.png`));
    }
    const state = await session.evaluate(`(() => {
      const mode = [...document.querySelectorAll('.lmd-settings-panel select')].find(s => [...s.options].some(o => o.value === 'styled'));
      return { mode: mode?.value, canvas: !!document.querySelector('.JASSUB canvas'), text: document.querySelector('.lmd-text-subtitles')?.textContent,
        status: document.querySelector('.lmd-panel-message')?.textContent };
    })()`);
    if (interceptError) throw interceptError;
    if (blocked) assert.ok(state.mode === 'text' && state.text?.trim(), 'CSP block must auto-fallback with visible text and updated selector');
    else assert.ok(state.mode === 'styled' && state.canvas, 'production renderer must remain in styled mode');
    report.cases.push({ blocked, state, smokePassed: true });
  }
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (session) { await session.send('Page.navigate', { url: 'about:blank' }).catch(() => {}); await delay(1000); session.close(); }
  browser?.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ output, ...report }, null, 2));
}
