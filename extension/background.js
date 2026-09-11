// Background service worker: owns the WebSocket to the local USB bridge daemon.
// Extension origins are exempt from Chrome's Local Network Access checks, so this
// is the only place a ws://127.0.0.1 connection works reliably from an HTTPS site.
const DEFAULT_WS_URL = "ws://127.0.0.1:8765";
const RECONNECT_MS = 1500;

let socket = null;
let reconnectTimer = null;
const activePorts = new Set();
let latestState = null;

async function wsUrl() {
  try {
    const { wsUrl } = await chrome.storage.local.get("wsUrl");
    return wsUrl || DEFAULT_WS_URL;
  } catch {
    return DEFAULT_WS_URL;
  }
}

function broadcast(text) {
  for (const port of activePorts) {
    try { port.postMessage(text); } catch { activePorts.delete(port); }
  }
}

async function ensureSocket() {
  if (socket || activePorts.size === 0) return;
  const url = await wsUrl();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => console.log(`[GFN bridge] connected to ${url}`);
  ws.onmessage = (event) => {
    if (event.data === latestState) return; // daemon streams at ~120 Hz; forward only changes
    latestState = event.data;
    broadcast(latestState);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (latestState !== null) {
      latestState = null;
      broadcast(JSON.stringify({ connected: false }));
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer || activePorts.size === 0) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; ensureSocket(); }, RECONNECT_MS);
}

function dropSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { const ws = socket; socket = null; try { ws.close(); } catch {} }
  latestState = null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "gfn-bridge") return;
  activePorts.add(port);
  port.postMessage(JSON.stringify({ hello: "worker", version: chrome.runtime.getManifest().version }));
  if (latestState) port.postMessage(latestState);
  port.onDisconnect.addListener(() => {
    activePorts.delete(port);
    if (activePorts.size === 0) dropSocket(); // let the worker idle out when no game tab is open
  });
  ensureSocket();
});
