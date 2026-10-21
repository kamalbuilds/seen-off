"""Per-condition breakdown of a porch run: present vs gone, by frame kind, by parcel count, and night/infrared vs daylight.
Night/infrared is measured from the pixels (mean saturation of the frame under 8 of 255), not taken from the labels.

Run:  .venv/bin/python spikes/porch/breakdown.py [results/main-bedrock-mantle.json]
"""
import json, sys
from pathlib import Path
import cv2

HERE = Path(__file__).resolve().parent
res_path = HERE / (sys.argv[1] if len(sys.argv) > 1 else "results/main-bedrock-mantle.json")
labels = {l["id"]: l for l in json.loads((HERE / "labels.json").read_text())}
rows = json.loads(res_path.read_text())["rows"]
assert len(rows) == 60 and len(labels) == 60, "a full 60-frame run is required"

def infrared(fid):
    img = cv2.imread(str(HERE / "frames" / f"{fid}.jpg"))
    return float(cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 1].mean()) < 8

groups = {}
def add(name, ok_present, ok_count):
    g = groups.setdefault(name, {"frames": 0, "present_ok": 0, "count_n": 0, "count_ok": 0})
    g["frames"] += 1; g["present_ok"] += ok_present
    if ok_count is not None: g["count_n"] += 1; g["count_ok"] += ok_count

for r in rows:
    l = labels[r["id"]]
    ok_p = r["pred"] == l["present"]
    ok_c = None if l["count"] is None else (r["predCount"] == l["count"])
    ir = infrared(r["id"])
    add("all frames", ok_p, ok_c)
    add("parcels on the porch", ok_p, ok_c) if l["present"] else add("porch empty", ok_p, ok_c)
    add({"real": "real footage", "composite": "parcels composited in", "augmented": "empty porch, exposure and IR variants"}[l["kind"]], ok_p, ok_c)
    add("night / infrared" if ir else "daylight", ok_p, ok_c)
    if l["present"] and l["count"] is not None:
        add(f"{l['count']} parcel{'s' if l['count'] > 1 else ''} on the porch" if l["count"] < 3 else "3 or more parcels", ok_p, ok_c)

out = {"run": str(res_path.relative_to(HERE)), "model": json.loads(res_path.read_text())["summary"]["model"], "groups": groups}
(HERE / "results" / ("breakdown-" + res_path.name)).write_text(json.dumps(out, indent=1))
for k, g in groups.items():
    c = f"{g['count_ok']}/{g['count_n']}" if g["count_n"] else "n/a"
    print(f"{k:42s} frames {g['frames']:3d}  present/gone {g['present_ok']}/{g['frames']}  count exact {c}")
