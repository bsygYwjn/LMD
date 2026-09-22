// Real Chromium layout regression; emulation is explicitly NOT phone hardware acceptance.
// Require an explicit test URL to avoid silently targeting the shared service.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchBrowser, Session, delay } from './cdp.mjs';
const base = process.env.LMD_BASE_URL;
assert.ok(base, 'Set LMD_BASE_URL to an isolated production build with a playable fixture');
const output = await mkdtemp(path.join(tmpdir(), 'lmd-mobile-matrix-'));
const results = [], report = { base, scope: 'Chromium responsive emulation, not Android/iOS hardware', results };
let browser, session;
try {
  browser = await launchBrowser({ userDataDir: path.join(output, 'profile'), port: Number(process.env.LMD_CDP_PORT || 9438) });
  session = await Session.connect(browser.target.webSocketDebuggerUrl);
  await session.send('Page.enable'); await session.send('Runtime.enable');
  for (const [width, height] of [[320,568],[360,800],[390,844],[412,915],[844,390]]) {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await session.send('Page.navigate', { url: base });
    await session.waitFor("document.querySelector('.mcard-hit, .media-card .card-hit-area')");
    for (let depth = 0; depth < 8; depth++) {
      const opened = await session.evaluate(`(() => {
        const items = [...document.querySelectorAll('.mcard-hit, .media-card .card-hit-area')];
        const media = items.find(x => (x.getAttribute('aria-label') || '').startsWith('播放 '));
        if (media) { media.click(); return true; }
        const folder = items.find(x => (x.getAttribute('aria-label') || '').startsWith('打开文件夹 '));
        if (!folder) throw Error('No playable fixture'); folder.click(); return false;
      })()`);
      if (opened) break; await delay(500);
    }
    await session.waitFor("document.querySelector('.lmd-stage video')?.readyState >= 2", { timeout: 30000 });
    // Pause to make controls and screenshot stable; do not alter CSS under test.
    await session.evaluate("document.querySelector('.lmd-stage video').pause()");
    await delay(300);
    const before = await session.evaluate(`(() => {
      const stage = document.querySelector('.lmd-stage').getBoundingClientRect();
      const clipped = [...document.querySelectorAll('.lmd-controls button')].filter(b => {
        const r = b.getBoundingClientRect(); return r.width > 0 && (r.left < stage.left - 1 || r.right > stage.right + 1);
      }).map(b => b.getAttribute('aria-label'));
      return { height: stage.height, clipped, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`);
    await session.screenshot(path.join(output, `${width}-controls.png`));
    await session.evaluate(`(() => {
      const b = document.querySelector('.lmd-stage button[aria-label="播放设置"]');
      if (!b) throw Error('Settings button missing'); b.click();
    })()`);
    await session.waitFor("document.querySelector('.lmd-settings-panel')"); await delay(300);
    const after = await session.evaluate(`(() => {
      const r = document.querySelector('.lmd-settings-panel').getBoundingClientRect();
      return { height: document.querySelector('.lmd-stage').getBoundingClientRect().height,
        panelFits: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 };
    })()`);
    await session.screenshot(path.join(output, `${width}-settings.png`));
    results.push({ width, height, before, after, ok: !before.overflow && !before.clipped.length && Math.abs(after.height - before.height) <= 1 && after.panelFits });
  }
  assert.ok(results.every(r => r.ok), 'Layout regression; inspect report and screenshots');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (session) { await session.send('Page.navigate', { url: 'about:blank' }).catch(() => {}); await delay(1000); session.close(); }
  browser?.child?.kill();
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
