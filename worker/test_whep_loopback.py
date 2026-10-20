"""WHEP worker against a local WHEP server (aiortc) that serves a real frame. The server is a test double shaped per the Ring
Live Video docs: POST application/sdp -> 201 + SDP answer + Location, DELETE closes. It is not Ring.

Run: .venv-rtc/bin/python worker/test_whep_loopback.py
Cases: the grabbed JPEG matches the served frame (green); a server that answers 500 makes the worker exit non-zero (must-fail); the session is DELETEd.
"""
import asyncio, os, subprocess, sys, tempfile
from pathlib import Path
import av, numpy as np
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_FRAME = ROOT / "spikes" / "porch" / "frames" / "f001.jpg"
TOKEN = "loopback-token-not-a-secret"


class StillTrack(VideoStreamTrack):
    def __init__(self, arr):
        super().__init__()
        self.arr = arr

    async def recv(self):
        pts, tb = await self.next_timestamp()
        f = av.VideoFrame.from_ndarray(self.arr, format="rgb24")
        f.pts, f.time_base = pts, tb
        return f


async def run_case(mode: str) -> tuple[int, bool, bytes | None, str]:
    arr = np.asarray(Image.open(SRC_FRAME).convert("RGB"))
    arr = arr[: arr.shape[0] // 2 * 2, : arr.shape[1] // 2 * 2]
    pcs, state = set(), {"deleted": False}

    async def whep(request):
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return web.Response(status=401, text="bad token")
        if mode == "server_error":
            return web.Response(status=500, text="boom")
        pc = RTCPeerConnection(); pcs.add(pc)
        await pc.setRemoteDescription(RTCSessionDescription(sdp=await request.text(), type="offer"))
        pc.addTrack(StillTrack(arr))
        await pc.setLocalDescription(await pc.createAnswer())
        return web.Response(status=201, text=pc.localDescription.sdp, content_type="application/sdp",
                            headers={"Location": f"http://127.0.0.1:{port}/v1/devices/D/media/streaming/whep/sessions/s1"})

    async def delete(request):
        state["deleted"] = True
        return web.Response(status=200)

    app = web.Application()
    app.router.add_post("/v1/devices/D/media/streaming/whep/sessions", whep)
    app.router.add_delete("/v1/devices/D/media/streaming/whep/sessions/s1", delete)
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0); await site.start()
    port = site._server.sockets[0].getsockname()[1]
    out = Path(tempfile.mkdtemp()) / "frame.jpg"
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(ROOT / "worker" / "whep_frame.py"), "--device", "D", "--out", str(out),
        "--api-base", f"http://127.0.0.1:{port}", "--sample", "3", "--timeout", "20",
        env={**os.environ, "RING_ACCESS_TOKEN": TOKEN}, stderr=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    for pc in pcs: await pc.close()
    await runner.cleanup()
    return proc.returncode, state["deleted"], (out.read_bytes() if out.exists() else None), err.decode()[-300:]


async def main():
    rc, deleted, jpeg, err = await run_case("ok")
    assert rc == 0 and jpeg, f"worker failed: rc={rc} {err}"
    import io
    got = np.asarray(Image.open(io.BytesIO(jpeg)).convert("RGB")).astype(np.int16)
    want = np.asarray(Image.open(SRC_FRAME).convert("RGB")).astype(np.int16)[: got.shape[0], : got.shape[1]]
    diff = float(np.abs(got - want).mean())
    print(f"served frame vs grabbed frame: mean abs pixel difference {diff:.2f} (size {got.shape[1]}x{got.shape[0]}), session deleted: {deleted}")
    assert diff < 12, "grabbed frame does not match the served frame"
    assert deleted, "worker did not DELETE the WHEP session"

    rc, deleted, jpeg, err = await run_case("server_error")
    print(f"must-fail, server answers 500: rc={rc}, frame written: {jpeg is not None}, stderr: {err.strip()[:90]}")
    assert rc != 0 and jpeg is None, "worker reported success against a failing server"
    print("whep loopback: OK")

asyncio.run(main())
