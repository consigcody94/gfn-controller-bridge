// Isolated-world content script: relays daemon frames from the background worker
// to the page (MAIN world) via window.postMessage. inject.js consumes them.
(() => {
  let port = null;

  function connect() {
    if (!chrome.runtime || !chrome.runtime.id) return; // extension was reloaded; page reload needed
    try {
      port = chrome.runtime.connect({ name: "gfn-bridge" });
    } catch (e) {
      setTimeout(connect, 1000);
      return;
    }
    window.postMessage({ type: "GFN_BRIDGE_STATE", state: JSON.stringify({ hello: "content", version: chrome.runtime.getManifest().version }) }, "*");
    port.onMessage.addListener((text) => {
      window.postMessage({ type: "GFN_BRIDGE_STATE", state: text }, "*");
    });
    port.onDisconnect.addListener(() => {
      port = null;
      window.postMessage({ type: "GFN_BRIDGE_STATE", state: JSON.stringify({ connected: false }) }, "*");
      setTimeout(connect, 1000);
    });
  }

  connect();
})();
