"""Builds the 30 replay pickup days (frames + days.json). Synthetic by construction and labelled so.

Composition (ring.md 5.4): 10 taken, 10 missed, 5 partial, 5 taken-but-unscanned. Porch frames are parcel cut-outs composited
onto the empty backgrounds of the two real doorstep clips; close frames of taken days are real empty frames from those clips.
Truth comes from how each day is built, never from a model. Tracking uses Shippo's documented test numbers:
SHIPPO_TRANSIT (carrier scan exists) and SHIPPO_PRE_TRANSIT (label created, never scanned).

Run:  .venv/bin/python simulator/build_days.py   (needs spikes/porch/src from fetch_sources.sh)
"""
import json, random, sys
from pathlib import Path
import cv2, numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "spikes" / "porch"))
import build_frames as bf  # noqa: E402

OUT = ROOT / "simulator" / "days"
rng = random.Random(20261022)
DEVICE = "ava1.ring.device.REPLAYSIMULATOR01"
H = 3600_000
DAY0 = 1792947600000  # 2026-10-25T17:00:00Z = 10:00 PDT, replay dates are simulated

def jitter(img, k_ir):
    out = cv2.convertScaleAbs(img, alpha=rng.uniform(0.85, 1.1), beta=rng.uniform(-10, 8))
    return bf.to_ir(out) if k_ir else out

def stamp(ms):
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

def main():
    import shutil
    shutil.rmtree(OUT, ignore_errors=True); OUT.mkdir(parents=True)
    fp, dt = bf.extract("front_porch_theft.ogv", "fp"), bf.extract("dont_tempt.ogv", "dt")
    sp = {"fp": bf.cutout(bf.load(fp, 1), (415, 240, 65, 85)), "dt": bf.cutout(bf.load(dt, 1), (498, 640, 114, 80)),
          "dmg": bf.cutout(cv2.imread(str(bf.SRC / "damaged_box.jpg")), (358, 119, 704, 469))}
    bg = {"fp": np.median(np.stack([bf.load(fp, i) for i in range(19, 29)]), axis=0).astype(np.uint8),
          "dt": np.median(np.stack([bf.load(dt, i) for i in range(46, 51)]), axis=0).astype(np.uint8)}
    real_empty = {"fp": [bf.load(fp, i) for i in range(19, 29)], "dt": [bf.load(dt, i) for i in range(46, 51)]}

    def spots(scene, k):
        """k non-overlapping parcel placements on the porch floor: (sprite, foot x, foot y, width)."""
        out = []
        while len(out) < k:
            if scene == "fp": y = rng.randint(420, 690); x = rng.randint(150, 400); w = int(48 + (y - 380) * 0.30)
            else: y = rng.randint(620, 712); x = rng.randint(680, 1140); w = int(64 + (y - 560) * 0.45)
            if all(abs(x - ox) > 0.9 * (w + ow) / 2 or abs(y - oy) > 40 for _, ox, oy, ow in out):
                out.append((rng.choice([scene, "dmg"]), x, y, w))
        return out

    def render(scene, placements, ir, ms):
        img = bg[scene].copy()
        for name, x, y, w in placements: bf.paste(img, sp[name], (x, y), w)
        return bf.watermark(jitter(img, ir), stamp(ms))

    def render_empty(scene, ir, ms):
        return bf.watermark(jitter(rng.choice(real_empty[scene]).copy(), ir), stamp(ms))

    plan = ([("taken", k, "SHIPPO_TRANSIT") for k in (1, 1, 2, 2, 3, 1, 2, 3, 1, 2)]
            + [("missed", k, "SHIPPO_PRE_TRANSIT") for k in (1, 2, 3, 1, 2, 3, 1, 2, 1, 3)]
            + [("partial", k, None) for k in (3, 3, 2, 3, 2)]
            + [("unscanned", k, "SHIPPO_PRE_TRANSIT") for k in (1, 2, 3, 2, 1)])
    rng.shuffle(plan)
    days = []
    for n, (scenario, k, trk) in enumerate(plan, 1):
        did = f"day{n:02d}"
        scene = rng.choice(["fp", "dt"])
        start = DAY0 + n * 24 * H
        end = start + 7 * H
        ir_close = rng.random() < 0.2
        place = spots(scene, k)
        frames, motion = [], []

        def save(img, kind, ms, parcels):
            f = f"{did}_{kind}.jpg"; img.save(OUT / f, quality=85)
            frames.append({"atMs": ms, "file": f, "parcels": parcels, "kind": kind})

        save(render(scene, place, False, start), "open", start, k)
        if scenario in ("taken", "unscanned"):
            t = start + rng.randint(2, 6) * H + rng.randint(0, 59) * 60_000
            motion.append({"atMs": t, "subType": "human"})
            save(render_empty(scene, False, t + 30_000), "after", t + 30_000, 0)
            save(render_empty(scene, ir_close, end), "close", end, 0)
            labels = [{"trackingNumber": trk, "carrier": "shippo"} for _ in range(k)]
            tracking24 = [trk] * k
            close_parcels, taken = 0, k
        elif scenario == "missed":
            if rng.random() < 0.4:  # a person walks by (neighbour, courier of something else): motion fires, parcels stay
                t = start + rng.randint(2, 6) * H
                motion.append({"atMs": t, "subType": "human"})
                save(render(scene, place, False, t + 30_000), "after", t + 30_000, k)
            save(render(scene, place, ir_close, end), "close", end, k)
            labels = [{"trackingNumber": trk, "carrier": "shippo"} for _ in range(k)]
            tracking24 = [trk] * k
            close_parcels, taken = k, 0
        else:  # partial: j of k parcels leave
            j = rng.randint(1, k - 1)
            left = place[j:]
            t = start + rng.randint(2, 6) * H
            motion.append({"atMs": t, "subType": "human"})
            save(render(scene, left, False, t + 30_000), "after", t + 30_000, len(left))
            save(render(scene, left, ir_close, end), "close", end, len(left))
            labels = [{"trackingNumber": "SHIPPO_TRANSIT" if i < j else "SHIPPO_PRE_TRANSIT", "carrier": "shippo"} for i in range(k)]
            tracking24 = [l["trackingNumber"] for l in labels]
            close_parcels, taken = len(left), j
        days.append({"dayId": did, "scenario": scenario, "truth": scenario, "deviceId": DEVICE, "windowStartMs": start, "windowEndMs": end,
                     "labels": labels, "frames": frames, "motion": motion, "truthCounts": {"baseline": k, "close": close_parcels, "taken": taken}})
    (ROOT / "simulator" / "days.json").write_text(json.dumps(days, indent=1))
    from collections import Counter
    print(len(days), Counter(d["truth"] for d in days))

if __name__ == "__main__":
    main()
