#!/usr/bin/env python3
"""
PowerA Xbox Series X Wired Controller Bridge Daemon
Reads raw GIP packets from the PowerA controller via libusb and broadcasts
standard W3C Gamepad state over WebSocket (ws://127.0.0.1:8765) for GeForce NOW.
"""

import sys
import os
import time
import json
import asyncio
import argparse
import ctypes
from ctypes import c_void_p, c_int, c_uint16, c_uint8, c_ubyte, byref, POINTER

import websockets

# Controller Vendor & Product IDs (PowerA Xbox Series X / One)
SUPPORTED_DEVICES = [
    (0x20D6, 0x2062, "PowerA Xbox Series X Wired Controller Black"),
    (0x20D6, 0x2079, "PowerA Xbox Series X Advantage Hall Effect"),
    (0x20D6, 0x2009, "PowerA Enhanced Wired Controller Series X|S"),
    (0x20D6, 0x200E, "PowerA Spectra Infinity"),
    (0x20D6, 0x2064, "PowerA Wired Controller for Xbox"),
    (0x20D6, 0x2001, "PowerA Series X Wired Controller"),
    (0x20D6, 0x2003, "PowerA Fusion Pro 2"),
    (0x20D6, 0x2004, "PowerA Enhanced Wired Pink Inline"),
    (0x045E, 0x0B12, "Microsoft Xbox Series X|S Wired"),
    (0x045E, 0x02EA, "Microsoft Xbox One S Wired"),
]

LIBUSB_PATH = "/opt/homebrew/lib/libusb-1.0.dylib"

# Global controller state matching W3C Gamepad
current_gamepad_state = {
    "connected": False,
    "axes": [0.0, 0.0, 0.0, 0.0],
    "buttons": [{"pressed": False, "value": 0.0} for _ in range(17)]
}

guide_button_pressed = False
connected_clients = set()


def load_libusb():
    if not os.path.exists(LIBUSB_PATH):
        raise RuntimeError(f"libusb not found at {LIBUSB_PATH}")
    lib = ctypes.cdll.LoadLibrary(LIBUSB_PATH)
    lib.libusb_init(None)

    lib.libusb_open_device_with_vid_pid.restype = c_void_p
    lib.libusb_open_device_with_vid_pid.argtypes = [c_void_p, c_uint16, c_uint16]

    lib.libusb_claim_interface.argtypes = [c_void_p, c_int]
    lib.libusb_release_interface.argtypes = [c_void_p, c_int]

    lib.libusb_interrupt_transfer.restype = c_int
    lib.libusb_interrupt_transfer.argtypes = [
        c_void_p, c_uint8, c_void_p, c_int, POINTER(c_int), c_uint16
    ]

    lib.libusb_close.argtypes = [c_void_p]
    return lib


def apply_deadzone(val: float, deadzone: float = 0.08) -> float:
    if abs(val) < deadzone:
        return 0.0
    sign = 1.0 if val > 0 else -1.0
    return sign * ((abs(val) - deadzone) / (1.0 - deadzone))


def parse_gip_packet(data: list[int]):
    global current_gamepad_state, guide_button_pressed
    if len(data) < 4:
        return False

    cmd = data[0]

    # Command 0x07: Virtual Key (Guide / Xbox button)
    if cmd == 0x07 and len(data) >= 5:
        guide_button_pressed = (data[4] != 0)
        current_gamepad_state["buttons"][16] = {
            "pressed": guide_button_pressed,
            "value": 1.0 if guide_button_pressed else 0.0
        }
        return True

    # Command 0x20: Standard GIP Input Report
    if cmd == 0x20 and len(data) >= 18:
        buttons_raw = data[4] | (data[5] << 8)

        # Triggers (10-bit LE: 0 to 1023)
        lt_raw = (data[6] | (data[7] << 8)) & 0x03FF
        rt_raw = (data[8] | (data[9] << 8)) & 0x03FF

        # Analog Sticks (signed 16-bit LE: -32768 to 32767)
        def to_i16(lo, hi):
            val = lo | (hi << 8)
            return val - 65536 if val > 32767 else val

        lx_raw = to_i16(data[10], data[11])
        ly_raw = to_i16(data[12], data[13])
        rx_raw = to_i16(data[14], data[15])
        ry_raw = to_i16(data[16], data[17])

        # Normalize Triggers: 0.0 to 1.0
        lt_val = min(1.0, max(0.0, lt_raw / 1023.0))
        rt_val = min(1.0, max(0.0, rt_raw / 1023.0))

        # Normalize Sticks: -1.0 to +1.0
        # W3C Gamepad convention: Up is negative (-1.0), Down is positive (+1.0)
        lx_val = apply_deadzone(lx_raw / 32767.0)
        ly_val = apply_deadzone(-(ly_raw / 32767.0))
        rx_val = apply_deadzone(rx_raw / 32767.0)
        ry_val = apply_deadzone(-(ry_raw / 32767.0))

        current_gamepad_state["axes"] = [
            round(lx_val, 4),
            round(ly_val, 4),
            round(rx_val, 4),
            round(ry_val, 4)
        ]

        btn = lambda bit: bool(buttons_raw & (1 << bit))

        def make_btn(pressed: bool, val: float = None):
            v = val if val is not None else (1.0 if pressed else 0.0)
            return {"pressed": pressed, "value": round(v, 3)}

        current_gamepad_state["buttons"] = [
            make_btn(btn(4)),                     # 0: A
            make_btn(btn(5)),                     # 1: B
            make_btn(btn(6)),                     # 2: X
            make_btn(btn(7)),                     # 3: Y
            make_btn(btn(12)),                    # 4: LB
            make_btn(btn(13)),                    # 5: RB
            make_btn(lt_val > 0.1, lt_val),       # 6: LT
            make_btn(rt_val > 0.1, rt_val),       # 7: RT
            make_btn(btn(3)),                     # 8: Back/View
            make_btn(btn(2)),                     # 9: Start/Menu
            make_btn(btn(14)),                    # 10: LS Click
            make_btn(btn(15)),                    # 11: RS Click
            make_btn(btn(8)),                     # 12: D-Up
            make_btn(btn(9)),                     # 13: D-Down
            make_btn(btn(10)),                    # 14: D-Left
            make_btn(btn(11)),                    # 15: D-Right
            make_btn(guide_button_pressed)        # 16: Guide / Xbox
        ]
        return True

    return False


def run_usb_reader(lib, stop_event, test_mode=False):
    """Background thread that continuously reads USB packets."""
    global current_gamepad_state

    buf = (c_ubyte * 64)()
    transferred = c_int(0)

    while not stop_event.is_set():
        handle = None
        device_name = ""
        for vid, pid, name in SUPPORTED_DEVICES:
            h = lib.libusb_open_device_with_vid_pid(None, vid, pid)
            if h:
                handle = h
                device_name = name
                break

        if not handle:
            current_gamepad_state["connected"] = False
            if test_mode:
                print("Waiting for controller to be plugged in...")
            time.sleep(1.0)
            continue

        print(f"Connected to: {device_name}")
        lib.libusb_claim_interface(handle, 0)

        def send_pkt(payload):
            p_buf = (c_ubyte * len(payload))(*payload)
            t = c_int(0)
            lib.libusb_interrupt_transfer(handle, 0x01, p_buf, len(payload), byref(t), 500)

        send_pkt([0x05, 0x20, 0x00, 0x01, 0x00]) # Power on
        send_pkt([0x0a, 0x20, 0x00, 0x03, 0x00, 0x01, 0x14]) # LED on
        send_pkt([0x06, 0x20, 0x00, 0x02, 0x01, 0x00]) # Auth done

        current_gamepad_state["connected"] = True
        last_print = 0

        try:
            while not stop_event.is_set():
                res = lib.libusb_interrupt_transfer(handle, 0x81, buf, 64, byref(transferred), 100)
                if res == 0 and transferred.value > 0:
                    raw_data = list(buf)[:transferred.value]
                    changed = parse_gip_packet(raw_data)
                    if test_mode and changed:
                        now = time.time()
                        if now - last_print > 0.05:
                            pressed = [i for i, b in enumerate(current_gamepad_state["buttons"]) if b["pressed"]]
                            axes = current_gamepad_state["axes"]
                            print(f"\rButtons: {pressed:<15} Axes: {axes}", end="", flush=True)
                            last_print = now
                elif res not in (0, -7): # -7 is normal timeout
                    print(f"USB read error: {res}, reconnecting...")
                    break
        finally:
            current_gamepad_state["connected"] = False
            lib.libusb_release_interface(handle, 0)
            lib.libusb_close(handle)
            time.sleep(0.5)


async def ws_handler(websocket):
    """Handles WebSocket connections from the Chrome extension."""
    connected_clients.add(websocket)
    print(f"Chrome client connected! (Total: {len(connected_clients)})")
    try:
        await websocket.send(json.dumps(current_gamepad_state))
        while True:
            await asyncio.sleep(0.008) # ~120 Hz
            await websocket.send(json.dumps(current_gamepad_state))
    except (websockets.ConnectionClosed, asyncio.CancelledError):
        pass
    finally:
        connected_clients.remove(websocket)
        print(f"Chrome client disconnected. (Remaining: {len(connected_clients)})")


async def main():
    parser = argparse.ArgumentParser(description="PowerA Xbox Controller Bridge for GeForce NOW")
    parser.add_argument("--test", action="store_true", help="Run in terminal test mode to verify inputs")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port (default: 8765)")
    args = parser.parse_args()

    lib = load_libusb()

    import threading
    stop_event = threading.Event()
    reader_thread = threading.Thread(
        target=run_usb_reader,
        args=(lib, stop_event, args.test),
        daemon=True
    )
    reader_thread.start()

    if args.test:
        print("Running in test mode. Press buttons or move sticks on your controller...")
        print("Press Ctrl+C to exit.\n")
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("\nExiting.")
            stop_event.set()
            return

    print(f"Starting GeForce NOW Controller Bridge WebSocket on ws://127.0.0.1:{args.port}...")
    async with websockets.serve(ws_handler, "127.0.0.1", args.port):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nDaemon stopped.")
