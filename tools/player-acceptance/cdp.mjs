// Minimal Chrome DevTools Protocol client used for real browser verification of
// the LMD player. Development-only helper; never imported by the server.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

export async function launchBrowser({ port = 9333, headless = true, userDataDir, extraArgs = [] } = {}) {
  const executable = process.env.LMD_BROWSER_EXECUTABLE || CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  if (executable && !existsSync(executable)) throw new Error(`指定浏览器不存在：${executable}`);
  if (!executable) throw new Error("未找到 Chrome 或 Edge，请安装浏览器后重试。");
  const args = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking", "--disable-sync", "--disable-features=Translate,MediaRouter",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio",
    headless ? "--headless=new" : "--start-maximized",
    `--user-data-dir=${userDataDir}`, ...extraArgs, "about:blank"];
  const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
  let launchError = null;
  child.once("error", error => { launchError = error; });
  const deadline = Date.now() + 25000;
  let version = null;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`浏览器提前退出（${child.exitCode}）`);
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await delay(200); }
  }
  if (!version) { child.kill(); throw new Error("浏览器调试端口未就绪"); }
  // The first page target already exists because about:blank was requested.
  let target = null;
  const targetDeadline = Date.now() + 8000;
  while (Date.now() < targetDeadline && !target) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
    target = list.find(item => item.type === "page" && item.webSocketDebuggerUrl) || null;
    if (!target) await delay(200);
  }
  if (!target) { child.kill(); throw new Error("浏览器没有可用的页面目标"); }
  return { child, version, wsUrl: target.webSocketDebuggerUrl, target, port, close: () => { child.kill(); } };
}

export class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.logs = []; this.failures = []; this.socketError = ""; }
  static async connect(url) {
    const ws = new WebSocket(url);
    const session = new Session(ws);
    ws.addEventListener("error", event => session.socketError = event.error?.message || event.message || "websocket error");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), 10000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket 连接失败")); }, { once: true });
    });
    ws.addEventListener("message", event => session.onMessage(JSON.parse(event.data)));
    return session;
  }
  onMessage(message) {
    if (message.id) {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id);
      message.error ? entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code })) : entry.resolve(message.result);
      return;
    }
    const list = this.handlers.get(message.method);
    if (list) for (const handler of list) handler(message.params);
  }
  on(method, handler) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(handler); }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 命令超时: ${method}`)); }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async waitFor(expression, { timeout = 20000, interval = 200, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`)) return true;
      await delay(interval);
    }
    throw new Error(`等待条件超时: ${label}`);
  }
  async screenshot(file, { fullPage = false } = {}) {
    const { writeFile } = await import("node:fs/promises");
    const params = { format: "png", captureBeyondViewport: fullPage };
    const shot = await this.send("Page.captureScreenshot", params);
    await writeFile(file, Buffer.from(shot.data, "base64"));
  }
  collect() {
    this.on("Runtime.consoleAPICalled", ({ type, args }) => {
      const text = args.map(arg => arg.value ?? arg.description ?? arg.type).join(" ");
      this.logs.push({ type, text });
      if (type === "error") this.failures.push(`console.error: ${text}`);
    });
    this.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      this.failures.push(`exception: ${exceptionDetails.exception?.description || exceptionDetails.text}`);
    });
    this.on("Log.entryAdded", ({ entry }) => {
      this.logs.push({ type: entry.level, text: entry.text });
      if (entry.level === "error") this.failures.push(`log.error: ${entry.text} ${entry.url || ""}`);
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

export { delay };
