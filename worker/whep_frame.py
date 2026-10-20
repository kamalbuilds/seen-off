"""Grab one porch frame from a Ring WHEP live-view session.

RING_ACCESS_TOKEN=... python worker/whep_frame.py --device <id> --out frame.jpg [--component N] [--api-base URL] [--sample 8]

Flow (Ring docs, Live Video): recvonly video transceiver, wait for ICE gathering, POST the SDP offer as application/sdp,
expect 201 with an SDP answer and a Location header, receive frames, keep the sharpest (variance of the Laplacian, as the
CV Guidelines advise), DELETE the session so a battery camera stops streaming.
"""
import argparse, asyncio, io, os, sys
import aiohttp, numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription
from PIL import Image


def sharpness(rgb: np.ndarray) -> float:
    g = rgb.astype(np.float32).mean(axis=2)
    lap = -4 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return float(lap.var())


async def grab(api_base: str, device: str, component: str | None, token: str, sample: int, timeout: float) -> bytes:
    pc = RTCPeerConnection()
    pc.addTransceiver("video", direction="recvonly")
    got: asyncio.Future = asyncio.get_running_loop().create_future()

    @pc.on("track")
    def on_track(track):
        async def pump():
            best, best_score = None, -1.0
            try:
                for i in range(sample + 3):
                    frame = await track.recv()
                    if i < 3:  # first frames precede the keyframe settling
                        continue
                    rgb = frame.to_ndarray(format="rgb24")
                    s = sharpness(rgb)
                    if s > best_score:
                        best, best_score = rgb, s
                got.set_result(best)
            except Exception as e:  # surfaced through the future
                if not got.done():
                    got.set_exception(e)
        asyncio.ensure_future(pump())

    await pc.setLocalDescription(await pc.createOffer())  # aiortc finishes ICE gathering inside setLocalDescription
    q = f"?component_id={component}" if component is not None else ""
    url = f"{api_base}/v1/devices/{device}/media/streaming/whep/sessions{q}"
    session_url = None
    async with aiohttp.ClientSession() as http:
        try:
            async with http.post(url, data=pc.localDescription.sdp, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/sdp"}) as r:
                if r.status != 201:
                    raise RuntimeError(f"WHEP session not created: HTTP {r.status} {(await r.text())[:200]}")
                session_url = r.headers.get("Location")
                if not session_url:
                    raise RuntimeError("WHEP 201 without Location header")
                await pc.setRemoteDescription(RTCSessionDescription(sdp=await r.text(), type="answer"))
            rgb = await asyncio.wait_for(got, timeout)
        finally:
            if session_url:
                try:
                    await http.delete(session_url, headers={"Authorization": f"Bearer {token}"})
                except Exception as e:
                    print(f"warning: session delete failed: {e}", file=sys.stderr)
            await pc.close()
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--component")
    ap.add_argument("--api-base", default="https://api.amazonvision.com")
    ap.add_argument("--sample", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=25.0)
    a = ap.parse_args()
    token = os.environ.get("RING_ACCESS_TOKEN")
    if not token:
        print("RING_ACCESS_TOKEN is not set", file=sys.stderr)
        return 2
    try:
        jpeg = asyncio.run(grab(a.api_base.rstrip("/"), a.device, a.component, token, a.sample, a.timeout))
    except Exception as e:
        print(f"whep frame grab failed: {e}", file=sys.stderr)
        return 1
    with open(a.out, "wb") as f:
        f.write(jpeg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
