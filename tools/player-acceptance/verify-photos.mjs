import path from "node:path";
import { launchBrowser, Session, delay } from "./cdp.mjs";
const BASE = "http://127.0.0.1:8096";
const browser = await launchBrowser({ port: 9341, userDataDir: path.resolve("chrome-profile") });
const session = await Session.connect(browser.target.webSocketDebuggerUrl);
session.collect();
await Promise.all([session.send("Page.enable"), session.send("Runtime.enable"), session.send("Log.enable")]);
try {
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  for (const [name, url] of [["观看端", BASE], ["管理端总览", `${BASE}/admin`]]) {
    await session.send("Page.navigate", { url });
    await delay(3500);
    const state = await session.evaluate(`(() => ({ root: document.querySelector('#root')?.children.length ?? 0,
      hasPhotos: Boolean([...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('图片'))),
      sections: [...document.querySelectorAll('.section-tabs button, nav button')].map(b => b.textContent.trim()).slice(0, 8),
      text: (document.body.innerText || '').slice(0, 90).replace(/\\n/g, ' / ') }))()`);
    console.log(`${name}: photos入口=${state.hasPhotos} root=${state.root} | ${state.text}`);
  }
  // Photo section renders its own view without errors.
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('图片'))?.click()`);
  await delay(2500);
  const photoView = await session.evaluate(`(() => ({ url: location.href, text: (document.body.innerText || '').slice(0, 120).replace(/\\n/g, ' / ') }))()`);
  console.log("照片视图:", photoView.url, "|", photoView.text);
  console.log("页面错误:", session.failures.length ? session.failures.slice(0, 3) : "none");
} finally { session.close(); browser.close(); }
