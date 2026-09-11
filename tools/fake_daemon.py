# Scripted stand-in for bridge_daemon.py: emits a repeating 4-phase pattern so the browser side
# can be verified without touching the physical controller.
import asyncio, json, sys, time, websockets
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
def btns(pressed=(), values=None):
    out = [{"pressed": False, "value": 0.0} for _ in range(17)]
    for i in pressed: out[i] = {"pressed": True, "value": 1.0}
    for i, v in (values or {}).items(): out[i] = {"pressed": v > 0.1, "value": v}
    return out
PHASES = [  # (duration s, state)
    (1.0, {"connected": True, "axes": [0, 0, 0, 0], "buttons": btns()}),
    (1.0, {"connected": True, "axes": [0, 0, 0, 0], "buttons": btns(pressed=(0,))}),                 # A
    (1.0, {"connected": True, "axes": [-0.5, 0.75, 0.25, -1.0], "buttons": btns(values={7: 0.6})}),  # sticks + RT
    (1.0, {"connected": True, "axes": [0, 0, 0, 0], "buttons": btns(pressed=(12, 9, 16))}),          # D-up, Menu, Guide
]
T0 = time.time()
def current():
    t = (time.time() - T0) % sum(d for d, _ in PHASES)
    for d, s in PHASES:
        if t < d: return s
        t -= d
    return PHASES[0][1]
async def handler(ws):
    try:
        while True:
            await ws.send(json.dumps(current()))
            await asyncio.sleep(0.008)
    except websockets.ConnectionClosed:
        pass
async def main():
    async with websockets.serve(handler, "127.0.0.1", PORT):
        print(f"fake daemon on ws://127.0.0.1:{PORT}", flush=True)
        await asyncio.Future()
asyncio.run(main())
