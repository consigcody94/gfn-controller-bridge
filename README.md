# gfn-controller-bridge

Use a **wired Xbox (GIP) controller** with **GeForce NOW in Chrome** on an Apple Silicon Mac.

macOS has no driver for Xbox controllers over USB (they speak Microsoft's GIP protocol, not USB HID), and Apple only
supports them over Bluetooth. Wired-only pads such as the PowerA Xbox Series X controller are therefore invisible to
every Mac app, including the native GeForce NOW app. The old 360Controller kext never supported these pads and is dead
on Apple Silicon.

This project sidesteps the OS: a small Python daemon talks GIP to the pad through libusb and streams W3C-Gamepad-shaped
state over a local WebSocket, and a Chrome extension presents that state to `play.geforcenow.com` through the standard
Gamepad API. GeForce NOW's web client sees a normal "standard"-mapped Xbox pad.

Verified on a MacBook Air M1, macOS 26.6, Chrome 152, with a PowerA Xbox Series X Wired Controller (`20d6:2062`).

## How it works

```
controller ──USB/GIP──▶ bridge_daemon.py ──ws://127.0.0.1:8765──▶ background.js (extension worker)
                                                                     │ port
                                                                     ▼
                                       page ◀──window.postMessage── content.js
                                        │
                                        └─ inject.js (MAIN world) overrides navigator.getGamepads()
                                           and fires gamepadconnected / gamepaddisconnected
```

- `bridge_daemon.py` claims interface 0, sends the GIP power-on / LED / auth packets, decodes `0x20` input reports
  (16-bit sticks, 10-bit triggers, button bitmask) and `0x07` Guide-button packets, and broadcasts JSON at ~120 Hz.
- `extension/background.js` owns the WebSocket. It has to live in the extension worker: Chrome 138+ blocks
  page-context connections to `ws://127.0.0.1` from HTTPS sites (Local Network Access checks), so a userscript cannot do this.
- `extension/inject.js` returns a fresh, frozen snapshot per `getGamepads()` call, advances `timestamp` only on real
  state changes, and fires each connection event exactly once. A status pill bottom-right shows bridge state.

## Setup

Requirements: Homebrew `libusb`, Python 3 with `websockets`, Google Chrome.

```bash
brew install libusb
python3 -m pip install websockets
```

1. Plug in the controller and start the daemon (leave it running):

   ```bash
   ./start.sh
   ```

   `./start.sh --test` prints decoded buttons and axes in the terminal instead of serving the WebSocket.

2. Load the extension: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, pick the
   `extension/` folder.

3. Open <https://hardwaretester.com/gamepad>. The pad appears as "Xbox 360 Controller (STANDARD GAMEPAD …)" and
   the pill says "Controller ready · bridge vX.Y.Z". Press buttons to confirm the mapping.

4. Play at <https://play.geforcenow.com> in Chrome. The native GeForce NOW app cannot see the pad; only the web client can.

## Troubleshooting

- **Pill says "Bridge worker not responding"** – Chrome kept an older copy of the extension's background worker
  (this happens after editing an unpacked extension; restarting Chrome does not refresh it). Click the Reload arrow on
  the extension card in `chrome://extensions`, then reload the game tab.
- **Pill says "Controller disconnected"** – the daemon is not running or the pad is unplugged.
- **No pill at all** – the site is not in the manifest's `matches`, or the extension is disabled.
- **Game does not react but the pill is green** – make sure the game tab was loaded *after* the extension was
  (re)loaded; content scripts do not inject into already-open tabs.
- Another process holding the USB interface (for example a controller utility) stops the daemon from claiming it.
- To point the worker at a different daemon address, set `wsUrl` in the extension's storage from the worker console:
  `chrome.storage.local.set({wsUrl: 'ws://127.0.0.1:8766'})`.

## Testing

`tools/test.mjs` drives Chrome for Testing over the DevTools protocol (no npm dependencies, Node 22+): it loads the
extension, checks hardwaretester.com and play.geforcenow.com against the live daemon, then swaps in
`tools/fake_daemon.py` to prove button, trigger and axis propagation plus disconnect/reconnect handling.

```bash
npx @puppeteer/browsers install chrome@stable   # once, if no Chrome for Testing is cached
node tools/test.mjs
```

## Limitations

- Rumble is accepted but ignored (`vibrationActuator` is a stub).
- Only the browser client benefits. For system-wide use (native apps, Steam) you need a hardware USB-host-to-HID
  bridge such as an RP2040 board running GP2040-CE.
- Supported VID/PID pairs are listed at the top of `bridge_daemon.py`; other GIP pads usually work if added there.
