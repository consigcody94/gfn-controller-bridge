// MAIN-world content script (runs inside the page's own JS context at document_start).
// Presents the daemon's controller state through the W3C Gamepad API:
//   - navigator.getGamepads() returns a synthetic "standard"-mapped Gamepad
//   - window receives gamepadconnected / gamepaddisconnected exactly once per transition
(() => {
  if (window.__gfnBridgeInstalled) return;
  Object.defineProperty(window, "__gfnBridgeInstalled", { value: true });

  const GAMEPAD_ID = "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)";
  const BUTTON_COUNT = 17;
  const AXIS_COUNT = 4;

  let connected = false;
  let slot = 0;
  let axes = new Array(AXIS_COUNT).fill(0);
  let buttons = Array.from({ length: BUTTON_COUNT }, () => ({ pressed: false, value: 0 }));
  let timestamp = 0; // like Chrome: time of the last state change

  const nativeGetGamepads = Navigator.prototype.getGamepads;

  const vibrationActuator = Object.freeze({
    type: "dual-rumble",
    playEffect: () => Promise.resolve("complete"),
    reset: () => Promise.resolve("complete"),
  });

  function snapshot(isConnected) {
    const pad = {
      id: GAMEPAD_ID,
      index: slot,
      connected: isConnected,
      timestamp,
      mapping: "standard",
      axes: Object.freeze(axes.slice()),
      buttons: Object.freeze(buttons.map((b) => Object.freeze({ pressed: b.pressed, touched: b.pressed, value: b.value }))),
      vibrationActuator,
      hapticActuators: Object.freeze([]),
    };
    Object.defineProperty(pad, Symbol.toStringTag, { value: "Gamepad" });
    return Object.freeze(pad);
  }

  function nativeList() {
    try { return Array.from(nativeGetGamepads.call(navigator) || []); } catch { return []; }
  }

  function getGamepads() {
    const list = nativeList();
    if (!connected) return list;
    while (list.length <= slot || list.length < 4) list.push(null);
    list[slot] = snapshot(true);
    return list;
  }

  for (const target of [Navigator.prototype, navigator]) {
    try {
      Object.defineProperty(target, "getGamepads", { value: getGamepads, writable: true, configurable: true });
    } catch {}
  }

  function fire(type, pad) {
    // new GamepadEvent(type, {gamepad}) rejects non-native Gamepad objects, so build a plain Event.
    const ev = new Event(type, { bubbles: false, cancelable: false });
    Object.defineProperty(ev, "gamepad", { value: pad, enumerable: true });
    window.dispatchEvent(ev);
  }

  function setConnected(next) {
    if (next === connected) return;
    connected = next;
    timestamp = performance.now();
    if (connected) {
      const real = nativeList();
      slot = Math.max(0, real.findIndex((g) => g === null || g === undefined));
      if (slot === 0 && real[0]) slot = real.length; // real pad sits at 0: take the next free slot
      fire("gamepadconnected", snapshot(true));
      badge("Controller ready" + (workerVersion ? " · bridge v" + workerVersion : ""), "#059669", true);
    } else {
      fire("gamepaddisconnected", snapshot(false));
      axes = new Array(AXIS_COUNT).fill(0);
      buttons = buttons.map(() => ({ pressed: false, value: 0 }));
      badge("Controller disconnected", "#dc2626", false);
    }
  }

  let contentVersion = null;
  let workerVersion = null;
  let workerTimer = null;

  function applyFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.hello === "content") {
      contentVersion = frame.version;
      if (!workerTimer) workerTimer = setTimeout(() => {
        if (!workerVersion) badge("Bridge worker not responding. Reload the extension at chrome://extensions, then reload this page.", "#b45309", false);
      }, 4000);
      return;
    }
    if (frame.hello === "worker") {
      workerVersion = frame.version;
      if (contentVersion && workerVersion !== contentVersion) badge(`Bridge version mismatch (page ${contentVersion}, worker ${workerVersion}). Reload the extension.`, "#b45309", false);
      return;
    }
    if (!frame.connected) { setConnected(false); return; }
    let changed = !connected;
    if (Array.isArray(frame.axes)) {
      for (let i = 0; i < AXIS_COUNT; i++) {
        const v = Number(frame.axes[i]) || 0;
        if (v !== axes[i]) { axes[i] = v; changed = true; }
      }
    }
    if (Array.isArray(frame.buttons)) {
      for (let i = 0; i < BUTTON_COUNT; i++) {
        const src = frame.buttons[i] || {};
        const pressed = !!src.pressed;
        const value = Number(src.value) || 0;
        if (pressed !== buttons[i].pressed || value !== buttons[i].value) {
          buttons[i] = { pressed, value };
          changed = true;
        }
      }
    }
    if (changed) timestamp = performance.now();
    setConnected(true);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.type !== "GFN_BRIDGE_STATE") return;
    try {
      const s = event.data.state;
      applyFrame(typeof s === "string" ? JSON.parse(s) : s);
    } catch {}
  });

  // Small status pill so you can tell the bridge is alive without opening DevTools.
  let badgeEl = null;
  let badgeTimer = null;
  function badge(text, color, autoHide) {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", () => badge(text, color, autoHide), { once: true });
      return;
    }
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.id = "gfn-bridge-badge";
      badgeEl.style.cssText = "position:fixed;bottom:16px;right:16px;padding:6px 12px;border-radius:16px;" +
        "font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff;z-index:2147483647;" +
        "box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .4s ease;pointer-events:none;user-select:none;";
      document.body.appendChild(badgeEl);
    }
    badgeEl.textContent = "🎮 " + text;
    badgeEl.style.backgroundColor = color;
    badgeEl.style.opacity = "1";
    if (badgeTimer) { clearTimeout(badgeTimer); badgeTimer = null; }
    if (autoHide) badgeTimer = setTimeout(() => { badgeEl.style.opacity = "0"; }, 4000);
  }
})();
