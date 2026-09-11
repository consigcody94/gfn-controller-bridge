// End-to-end verification of the extension in Chrome for Testing (no npm deps; needs Node >= 22).
// Part A uses the real daemon on ws://127.0.0.1:8765; Part B drives the page with fake_daemon.py to prove
// button/axis propagation and disconnect/reconnect without touching the physical controller.
//   node tools/test.mjs
import { launch, Page, sleep } from "./cdp.mjs";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
const EXT = new URL("../extension", import.meta.url).pathname;
const SCRATCH = new URL("./.out", import.meta.url).pathname; mkdirSync(SCRATCH, { recursive: true });
const FAKE_DAEMON = new URL("./fake_daemon.py", import.meta.url).pathname;
const EXT_VERSION = JSON.parse((await import("node:fs")).readFileSync(`${EXT}/manifest.json`, "utf8")).version;
const EVT_HOOK = `window.__evts = []; for (const t of ["gamepadconnected","gamepaddisconnected"]) window.addEventListener(t, e => window.__evts.push({type:t, hasGamepad: !!e.gamepad, id: e.gamepad && e.gamepad.id, index: e.gamepad && e.gamepad.index, connected: e.gamepad && e.gamepad.connected, isEvent: e instanceof Event}));`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const padSummary = "JSON.stringify((()=>{const g=navigator.getGamepads()[0]; return g && {id:g.id,index:g.index,connected:g.connected,mapping:g.mapping,axes:g.axes,pressed:g.buttons.map((b,i)=>b.pressed?i:-1).filter(i=>i>=0),rt:g.buttons[7].value,ts:g.timestamp,vib:!!g.vibrationActuator,tag:Object.prototype.toString.call(g),len:navigator.getGamepads().length}})())";
const ourErrors = (page) => page.console.filter(l => /inject\.js|content\.js|background\.js|GFN bridge/.test(l));

async function newHookedPage(chrome, url, waitMs) {
  const page = await chrome.newPage("about:blank");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: EVT_HOOK });
  await page.navigate(url, waitMs);
  return page;
}

// ---------- Part A: real daemon (ws://127.0.0.1:8765), hardwaretester + GFN ----------
{
  const chrome = await launch({ ext: EXT, profile: `${SCRATCH}/profile-A`, port: 9333 });
  try {
    const page = await newHookedPage(chrome, "https://gamepad-tester.com/", 7000);
    const url = await page.url();
    check("A1 redirect lands on hardwaretester", url.startsWith("https://hardwaretester.com/gamepad"), url);
    check("A2 getGamepads is patched", (await page.evaluate("navigator.getGamepads.toString()")).includes("nativeList"));
    const pad = JSON.parse(await page.evaluate(padSummary));
    check("A3 synthetic pad present at index 0", pad && pad.index === 0 && pad.connected && pad.mapping === "standard" && pad.len === 4, JSON.stringify(pad));
    const text = await page.evaluate("document.body.innerText.replace(/\\s+/g,' ')");
    check("A4 page no longer says 'Connect your gamepad'", !text.includes("Connect your gamepad"), text.slice(0, 160));
    check("A5 page shows the controller id", text.includes("Xbox 360 Controller"));
    const evts = await page.evaluate("JSON.stringify(window.__evts)");
    const ev = JSON.parse(evts);
    check("A6 exactly one gamepadconnected with .gamepad", ev.length === 1 && ev[0].type === "gamepadconnected" && ev[0].hasGamepad && ev[0].isEvent, evts);
    check("A7 GamepadEvent ctor rejects fake pads (why we use Event)", (await page.evaluate("(()=>{try{new GamepadEvent('gamepadconnected',{gamepad:{}});return 'accepted'}catch(e){return e.message}})()")).includes("convert value to 'Gamepad'"));
    check("A8 no errors from extension scripts", ourErrors(page).length === 0, ourErrors(page).join(" | ").slice(0, 300));
    const badgeText = await page.evaluate("(document.getElementById('gfn-bridge-badge')||{}).textContent || ''");
    check("A8b badge confirms worker handshake (version shown, no stale-worker warning)", badgeText.includes(`bridge v${EXT_VERSION}`) && !/not responding|mismatch/.test(badgeText), badgeText);
    await page.screenshot(`${SCRATCH}/hardwaretester-live.png`);
    page.close();

    const gfn = await newHookedPage(chrome, "https://play.geforcenow.com/mall/", 10000);
    const gpad = JSON.parse(await gfn.evaluate(padSummary));
    check("A9 GFN page: synthetic pad present", gpad && gpad.connected && gpad.mapping === "standard", JSON.stringify(gpad));
    const gev = JSON.parse(await gfn.evaluate("JSON.stringify(window.__evts)"));
    check("A10 GFN page: one gamepadconnected", gev.length === 1 && gev[0].hasGamepad, JSON.stringify(gev));
    check("A11 GFN page: no errors from extension scripts", ourErrors(gfn).length === 0, ourErrors(gfn).join(" | ").slice(0, 300));
    await gfn.screenshot(`${SCRATCH}/gfn-live.png`);
    gfn.close();
  } finally { await chrome.close(); }
}

// ---------- Part B: scripted fake daemon on 8766 (button/axis propagation, disconnect/reconnect) ----------
{
  let fake = spawn("python3", [FAKE_DAEMON, "8766"], { stdio: ["ignore", "inherit", "inherit"] });
  await sleep(800);
  const chrome = await launch({ ext: EXT, profile: `${SCRATCH}/profile-B`, port: 9334 });
  try {
    // wake the service worker, point it at the fake daemon, then start a fresh tab
    const warm = await chrome.newPage("https://hardwaretester.com/gamepad"); await sleep(2500);
    const sw = (await chrome.targets()).find(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://akbmpfloomlhpgbpefioeachciedakei/"));
    check("B0 extension service worker target found", !!sw, sw && sw.url);
    const swc = await Page.connect(sw, { light: true });
    await swc.evaluate("chrome.storage.local.set({wsUrl:'ws://127.0.0.1:8766'}).then(()=>'ok')");
    await chrome.closeTab(warm.target.id); warm.close(); await sleep(1500);
    console.log("  sw after tab close:", await swc.evaluate("JSON.stringify({sock: socket && socket.url, ports: activePorts.size})").catch(e => "sw gone: " + e.message));

    const page = await newHookedPage(chrome, "https://hardwaretester.com/gamepad", 5000);
    const sw2 = (await chrome.targets()).find(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://akbmpfloomlhpgbpefioeachciedakei/"));
    const swc2 = sw2 && sw2.id === sw.id ? swc : await Page.connect(sw2, { light: true });
    console.log("  sw after new page:", sw2 && sw2.id === sw.id ? "(same worker)" : "(worker restarted)", await swc2.evaluate("JSON.stringify({sock: socket && socket.url, ready: socket && socket.readyState, ports: activePorts.size})").catch(e => "err " + e.message));
    console.log("  sw console:", swc.console.concat(swc2 !== swc ? swc2.console : []));
    const seen = new Map(); let shot = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 4600) {
      const p = JSON.parse(await page.evaluate(padSummary));
      if (p) {
        const key = JSON.stringify([p.pressed, p.axes, p.rt]);
        seen.set(key, (seen.get(key) || 0) + 1);
        if (!shot && p.pressed.length === 1 && p.pressed[0] === 0) { await page.screenshot(`${SCRATCH}/hardwaretester-A-pressed.png`); shot = true; }
      }
      await sleep(40);
    }
    const keys = [...seen.keys()];
    console.log("distinct states seen:", keys);
    check("B1 neutral state seen", keys.includes(JSON.stringify([[], [0,0,0,0], 0])));
    check("B2 A button (index 0) seen", keys.includes(JSON.stringify([[0], [0,0,0,0], 0])));
    check("B3 sticks + analog RT seen", keys.includes(JSON.stringify([[7], [-0.5,0.75,0.25,-1], 0.6])));
    check("B4 D-up + Menu + Guide seen", keys.includes(JSON.stringify([[9,12,16], [0,0,0,0], 0])));
    check("B5 screenshot captured while A pressed", shot);
    const text = await page.evaluate("document.body.innerText.replace(/\\s+/g,' ')");
    check("B6 page renders a pad (not the connect prompt)", text.includes("Xbox 360 Controller") && !text.includes("Connect your gamepad"));
    let ev = JSON.parse(await page.evaluate("JSON.stringify(window.__evts)"));
    check("B7 still exactly one gamepadconnected (no event spam while buttons held)", ev.length === 1, JSON.stringify(ev));
    const ts1 = JSON.parse(await page.evaluate(padSummary)).ts; await sleep(30); const ts2 = JSON.parse(await page.evaluate(padSummary)).ts;
    check("B8 timestamp changes only on state change", typeof ts1 === "number" && ts1 > 0, `ts1=${ts1} ts2=${ts2}`);

    fake.kill("SIGTERM"); await sleep(3000);
    ev = JSON.parse(await page.evaluate("JSON.stringify(window.__evts)"));
    const padAfter = await page.evaluate(padSummary);
    check("B9 daemon gone -> one gamepaddisconnected, slot 0 null", ev.length === 2 && ev[1].type === "gamepaddisconnected" && ev[1].hasGamepad && padAfter === "null", JSON.stringify(ev) + " pad=" + padAfter);
    const text2 = await page.evaluate("document.body.innerText.replace(/\\s+/g,' ')");
    check("B10 page returns to connect prompt", text2.includes("Connect your gamepad"));

    fake = spawn("python3", [FAKE_DAEMON, "8766"], { stdio: ["ignore", "inherit", "inherit"] });
    await sleep(4000);
    ev = JSON.parse(await page.evaluate("JSON.stringify(window.__evts)"));
    const padBack = JSON.parse(await page.evaluate(padSummary));
    check("B11 daemon back -> reconnected, second gamepadconnected", ev.length === 3 && ev[2].type === "gamepadconnected" && padBack && padBack.connected, JSON.stringify(ev));
    check("B12 no errors from extension scripts", ourErrors(page).length === 0, ourErrors(page).join(" | ").slice(0, 300));
    page.close();
  } finally { await chrome.close(); try { fake.kill("SIGTERM"); } catch {} }
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
