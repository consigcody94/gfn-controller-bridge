# Notes for AI coding agents working in this repo

This file is read automatically by agent IDEs (Antigravity, Codex and others look for `AGENTS.md`). It records what
this project is, what went wrong the first time it was built, and how to work on it without repeating that.

## What this is

A userspace bridge that lets a wired Xbox (GIP) controller drive GeForce NOW's web client in Chrome on Apple Silicon.
`bridge_daemon.py` reads the pad with libusb and serves JSON on `ws://127.0.0.1:8765`; the MV3 extension in
`extension/` presents that as a standard-mapped gamepad through `navigator.getGamepads()`. See README for the design.

## What was actually broken on 2026-09-11, and what fixed it

The first build had a working daemon and an extension that looked right but "didn't see the controller". Each layer
was checked with evidence before anything was changed. Findings, in the order they were found:

1. **Wrong domain.** gamepad-tester.com now 301-redirects to hardwaretester.com/gamepad. The manifest only matched
   the old domain, so nothing was injected on the page the user was looking at. Verified with `curl -I`.
2. **Invalid events.** `new GamepadEvent(type, {gamepad})` throws for a non-native object (Chrome: "Failed to convert
   value to 'Gamepad'"). The fallback dispatched a `CustomEvent` without `.gamepad`, and the code re-fired
   `gamepadconnected` on every frame while a button was held (~111 Hz). Fixed with a plain `Event` carrying a
   `gamepad` property, fired once per transition.
3. **Stale service worker.** After the extension files were rewritten, Chrome kept running the old `background.js`
   (confirmed in `~/Library/Application Support/Google/Chrome/Default/Service Worker/ScriptCache`), even across two
   Chrome restarts. The new content scripts used a new port name the old worker ignored, so frames never reached the
   page. Only the Reload button on the extension card re-registers the worker. `inject.js` now shows a
   "worker not responding" pill when the version handshake fails.
4. **Local Network Access.** Chrome 152 blocks a page-context `ws://127.0.0.1` from an HTTPS origin
   (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`). The extension worker is exempt. This rules out a userscript design.
5. **GeForce NOW's streaming code** (vendor bundle, gamepad handler) scans `navigator.getGamepads()` when the stream
   starts, requires `mapping === "standard"`, and forwards a frame only when `timestamp` advanced. The synthetic pad
   now satisfies all three.

## How to think about work here

- **Verify each boundary before touching code.** Daemon → WebSocket → worker → content script → page → site. Read the
  bytes at each hop (a WebSocket probe, `lsof -i :8765`, a `message` listener in the page) and find the hop where the
  data stops. Guessing at the injection strategy cost hours; the actual causes were a redirect and a cached worker.
- **"Connected" must mean packets flow.** The daemon sets `connected` right after the USB handshake. Prove input
  by watching for a state change, never by the flag.
- **After editing `extension/`, click Reload on the extension card and reload the game tab.** A Chrome restart is not
  enough, and content scripts never inject into tabs that were already open.
- **Match the page that actually loads**, not the URL that was typed. Follow redirects with `curl -IL`.
- **Test without the hardware.** `node tools/test.mjs` runs 25 checks in Chrome for Testing with a fresh profile,
  using `tools/fake_daemon.py` to script presses. Run it before claiming anything works. A reused profile reproduces
  the stale-worker failure, which is why the harness deletes the profile first.
- **Don't propose a kext, a DriverKit extension, or Bluetooth.** All three were checked and are dead ends for this pad
  on Apple Silicon (no signed arm64 kext, restricted HID entitlement, wired-only hardware).
- **Keep trademarks out of the artwork.** The banner uses original controller and laptop silhouettes on purpose.
- The daemon is a plain Python process; if it was launched from an IDE it dies with that IDE. `start.sh` runs it standalone.
