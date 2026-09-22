// Optional development transport for machines whose native WebSocket CDP
// connection stalls. No Playwright dependency is loaded by production code.
import { pathToFileURL } from "node:url";
import { launchBrowser, Session } from "./cdp.mjs";

export async function launchAcceptanceSession(options) {
  if (!process.env.PLAYWRIGHT_MODULE) {
    const browser = await launchBrowser(options);
    try { return { browser, session: await Session.connect(browser.wsUrl) }; }
    catch (error) { await browser.close(); throw error; }
  }
  const module = process.env.PLAYWRIGHT_MODULE;
  const { chromium } = await import(module.startsWith("file:") ? module : pathToFileURL(module).href);
  const browser = await chromium.launch({ headless: options?.headless !== false,
    executablePath: process.env.LMD_BROWSER_EXECUTABLE || undefined,
    args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", ...(options?.extraArgs || [])] });
  try {
    const page = await browser.newPage(), transport = await page.context().newCDPSession(page);
    const session = new Session({
      send(message) {
        const { id, method, params } = JSON.parse(message);
        void transport.send(method, params).then(
          result => session.onMessage({ id, result }),
          error => session.onMessage({ id, error: { message: error.message } }),
        );
      },
      close() { void transport.detach().catch(() => {}); },
    });
    const on = session.on;
    session.on = function(method, handler) {
      if (!this.handlers.has(method)) transport.on(method, params => this.onMessage({ method, params }));
      return on.call(this, method, handler);
    };
    return { browser, session };
  } catch (error) { await browser.close(); throw error; }
}
