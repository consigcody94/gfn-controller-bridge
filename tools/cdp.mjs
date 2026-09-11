// Minimal CDP driver for Chrome for Testing (no npm deps; Node >= 22 global WebSocket/fetch)
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
// Chrome for Testing binary (branded Chrome 137+ no longer honours --load-extension).
// Override with CHROME_FOR_TESTING=/path/to/binary; default: newest build in the puppeteer cache.
function findChrome() {
  if (process.env.CHROME_FOR_TESTING) return process.env.CHROME_FOR_TESTING;
  const base = `${homedir()}/.cache/puppeteer/chrome`;
  let builds = [];
  try { builds = readdirSync(base).filter((d) => d.startsWith("mac_")).sort(); } catch {}
  if (!builds.length) throw new Error(`No Chrome for Testing found under ${base}; run: npx @puppeteer/browsers install chrome@stable`);
  const b = builds[builds.length - 1];
  return `${base}/${b}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
}
export const CHROME = findChrome();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ ext, profile, port = 9333, headless = true, extraArgs = [] }) {
  rmSync(profile, { recursive: true, force: true }); // fresh profile: a reused one keeps a stale extension worker
  mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--window-size=1280,900",
    ...(headless ? ["--headless=new"] : []),
    ...(ext ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : []),
    ...extraArgs,
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/json/version`); if (r.ok) break; } catch {}
    await sleep(100);
    if (i === 99) throw new Error("Chrome did not start: " + stderr.slice(-2000));
  }
  return {
    proc, base,
    async targets() { return (await fetch(`${base}/json/list`)).json(); },
    async newPage(url = "about:blank") {
      const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      const t = await r.json();
      return Page.connect(t);
    },
    async closeTab(id) { await fetch(`${base}/json/close/${id}`); },
    async close() { proc.kill("SIGTERM"); await sleep(300); try { proc.kill("SIGKILL"); } catch {} },
    stderr: () => stderr,
  };
}

export class Page {
  static async connect(target, { light = false } = {}) {
    const p = new Page(); p.target = target; p.id = 0; p.pending = new Map(); p.console = []; p.events = [];
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { p.ws.onopen = res; p.ws.onerror = rej; });
    p.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && p.pending.has(msg.id)) { const { res, rej } = p.pending.get(msg.id); p.pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else if (msg.method === "Runtime.consoleAPICalled") p.console.push(`[${msg.params.type}] ` + msg.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" "));
      else if (msg.method === "Runtime.exceptionThrown") p.console.push("[exception] " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
      else if (msg.method === "Log.entryAdded") p.console.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url || ""}`);
      else p.events.push(msg);
    };
    await p.send("Runtime.enable"); if (!light) { await p.send("Page.enable"); await p.send("Log.enable"); }
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async navigate(url, waitMs = 4000) {
    await this.send("Page.navigate", { url }); await sleep(waitMs);
  }
  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error("evaluate failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async screenshot(path) {
    const { writeFileSync } = await import("node:fs");
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.data, "base64"));
  }
  url() { return this.evaluate("location.href"); }
  close() { try { this.ws.close(); } catch {} }
}
export { sleep };
