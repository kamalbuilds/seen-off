"""Builds the 60 labelled, Ring-watermarked porch frames plus the 10 painted-out frames.

Sources (see FINDINGS.md): two real fixed-camera doorstep clips (Wikimedia Commons, CC BY 3.0) and one CC BY 2.0 box photo.
Every frame gets the Ring-style watermark at a fixed pixel size. Labels are written before any model runs.
"""
import json, random, subprocess, shutil
from pathlib import Path
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
SRC, WORK, OUT = HERE / "src", HERE / "_work", HERE / "frames"
rng = random.Random(20261021)
FONT = "/System/Library/Fonts/Helvetica.ttc"

def extract(video, name):
    d = WORK / name
    shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(SRC / video), "-vf", "fps=2", "-q:v", "2", str(d / "%03d.png")], check=True)
    return d

def load(d, i):  # 1-based index, t = (i-1)/2 s
    return cv2.imread(str(d / f"{i:03d}.png"))

def watermark(bgr, stamp):
    """Ring-style: wordmark block top-left, device id / app / timestamp top-right, fixed pixel size at any resolution."""
    im = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).convert("RGBA")
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    big, small = ImageFont.truetype(FONT, 44, index=1), ImageFont.truetype(FONT, 20)
    d.text((22, 12), "ring", font=big, fill=(0, 0, 0, 120)); d.text((20, 10), "ring", font=big, fill=(255, 255, 255, 235))
    y = 12
    for ln in ("Device 8c1e4f90a2b7", "Outbox", stamp):
        w = d.textlength(ln, font=small)
        d.text((im.width - w - 19, y + 1), ln, font=small, fill=(0, 0, 0, 120))
        d.text((im.width - w - 20, y), ln, font=small, fill=(255, 255, 255, 235)); y += 24
    return Image.alpha_composite(im, ov).convert("RGB")

def to_ir(bgr):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    g = cv2.convertScaleAbs(g, alpha=1.25, beta=-25)
    n = np.random.default_rng(7).normal(0, 6, g.shape)
    return cv2.cvtColor(np.clip(g + n, 0, 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)

def cutout(bgr, rect):
    mask = np.zeros(bgr.shape[:2], np.uint8)
    cv2.grabCut(bgr, mask, rect, np.zeros((1, 65)), np.zeros((1, 65)), 6, cv2.GC_INIT_WITH_RECT)
    m = np.where((mask == 1) | (mask == 3), 255, 0).astype(np.uint8)
    x, y, w, h = cv2.boundingRect(m)
    rgba = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA); rgba[:, :, 3] = cv2.GaussianBlur(m, (3, 3), 0)
    return rgba[y:y + h, x:x + w]

def paste(bg, sprite, foot_xy, base_w):
    """Paste sprite with its bottom-centre at foot_xy, scaled so its width is base_w. Returns bbox."""
    s = cv2.resize(sprite, (base_w, max(1, int(sprite.shape[0] * base_w / sprite.shape[1]))), interpolation=cv2.INTER_AREA)
    h, w = s.shape[:2]; x0, y0 = foot_xy[0] - w // 2, foot_xy[1] - h
    shadow = np.zeros(bg.shape[:2], np.float32)
    cv2.ellipse(shadow, (foot_xy[0], foot_xy[1] - 2), (int(w * 0.62), max(3, int(h * 0.10))), 0, 0, 360, 1, -1)
    shadow = cv2.GaussianBlur(shadow, (0, 0), max(2, w / 14))
    bg[:] = (bg * (1 - 0.35 * shadow[..., None])).astype(np.uint8)
    a = s[:, :, 3:4] / 255.0
    ys, xs = slice(max(0, y0), min(bg.shape[0], y0 + h)), slice(max(0, x0), min(bg.shape[1], x0 + w))
    sy, sx = slice(ys.start - y0, ys.stop - y0), slice(xs.start - x0, xs.stop - x0)
    bg[ys, xs] = (bg[ys, xs] * (1 - a[sy, sx]) + s[sy, sx, :3] * a[sy, sx]).astype(np.uint8)
    return [int(xs.start), int(ys.start), int(xs.stop), int(ys.stop)]

def augment_gone(bgr, k):
    h, w = bgr.shape[:2]; f = rng.uniform(0.82, 0.97)
    cw, ch = int(w * f), int(h * f); x, y = rng.randint(0, w - cw), rng.randint(0, h - ch)
    out = cv2.resize(bgr[y:y + ch, x:x + cw], (w, h), interpolation=cv2.INTER_AREA)
    out = cv2.convertScaleAbs(out, alpha=rng.uniform(0.7, 1.15), beta=rng.uniform(-15, 10))
    return to_ir(out) if k % 3 == 0 else out

def main():
    shutil.rmtree(OUT, ignore_errors=True); OUT.mkdir(parents=True); WORK.mkdir(exist_ok=True)
    fp, dt = extract("front_porch_theft.ogv", "fp"), extract("dont_tempt.ogv", "dt")
    labels, n = [], 0
    stamp = lambda i: f"2026-10-21 {10 + i % 7:02d}:{(i * 7) % 60:02d}:{(i * 13) % 60:02d} PDT"

    def emit(bgr, kind, source, present, count, extra=None):
        nonlocal n
        n += 1; fid = f"f{n:03d}"
        watermark(bgr, stamp(n)).save(OUT / f"{fid}.jpg", quality=85)
        labels.append({"id": fid, "kind": kind, "source": source, "present": present, "count": count, **(extra or {})})

    # real frames: label = parcel resting on the porch (present) or no parcel anywhere in frame (gone). Handling/carrying frames excluded.
    for i in range(1, 8):   emit(load(fp, i), "real", f"front_porch_theft t={(i-1)/2:.1f}s", True, None)   # box + paper bag: count not labelled
    for i in range(1, 11):  emit(load(dt, i), "real", f"dont_tempt t={(i-1)/2:.1f}s", True, 1)
    for i in range(17, 29): emit(load(fp, i), "real", f"front_porch_theft t={(i-1)/2:.1f}s", False, 0)
    for i in range(45, 51): emit(load(dt, i), "real", f"dont_tempt t={(i-1)/2:.1f}s", False, 0)

    sp = {"fp": cutout(load(fp, 1), (415, 240, 65, 85)), "dt": cutout(load(dt, 1), (498, 640, 114, 80)),
          "dmg": cutout(cv2.imread(str(SRC / "damaged_box.jpg")), (358, 119, 704, 469))}
    fp_bg = np.median(np.stack([load(fp, i) for i in range(19, 29)]), axis=0).astype(np.uint8)
    dt_bg = np.median(np.stack([load(dt, i) for i in range(46, 51)]), axis=0).astype(np.uint8)
    cv2.imwrite(str(WORK / "fp_bg.png"), fp_bg); cv2.imwrite(str(WORK / "dt_bg.png"), dt_bg)

    # composites: sprites pasted on the empty real backgrounds. fp floor: x 130-420,y 380-700; dt floor: x 640-1180,y 560-715
    def comp(scene, k):
        bg = (fp_bg if scene == "fp" else dt_bg).copy(); boxes, cnt = [], rng.choice([1, 1, 2, 3])
        for _ in range(cnt):
            if scene == "fp": y = rng.randint(400, 690); x = rng.randint(140, 400); wdt = int(40 + (y - 380) * 0.30)
            else: y = rng.randint(610, 712); x = rng.randint(660, 1150); wdt = int(60 + (y - 560) * 0.45)
            boxes.append(paste(bg, sp[rng.choice([scene, "dmg"])], (x, y), wdt))
        return (to_ir(bg) if k % 4 == 3 else bg), cnt, boxes
    for k in range(13):
        scene = "fp" if k < 7 else "dt"
        bg, cnt, boxes = comp(scene, k)
        emit(bg, "composite", f"{scene} empty background + {cnt} pasted parcel(s)" + (" (IR-style)" if k % 4 == 3 else ""), True, cnt, {"bboxes": boxes})

    gone_src = [load(fp, i) for i in (19, 22, 25, 28)] + [load(dt, i) for i in (46, 48, 50)]
    for k in range(12): emit(augment_gone(rng.choice(gone_src), k), "augmented", "jittered real empty frame (crop, exposure, IR-style)", False, 0)

    assert len(labels) == 60 and sum(l["present"] for l in labels) == 30, (len(labels), sum(l["present"] for l in labels))
    (HERE / "labels.json").write_text(json.dumps(labels, indent=1))

    # painted-out set: 10 real present frames, parcel region replaced with pixels from the same camera's empty frames
    PO = HERE / "frames_painted_out"; shutil.rmtree(PO, ignore_errors=True); PO.mkdir()
    po, m = [], 0
    for scene, idxs, bg, boxes in (("fp", [1, 2, 3, 4, 5], fp_bg, [(290, 245, 335, 312), (410, 236, 485, 330)]),
                                   ("dt", [1, 2, 4, 5, 6], dt_bg, [(490, 630, 620, 720)])):
        for i in idxs:
            im = (load(fp, i) if scene == "fp" else load(dt, i)).copy()
            for (x0, y0, x1, y1) in boxes: im[y0:y1, x0:x1] = bg[y0:y1, x0:x1]
            m += 1; fid = f"p{m:02d}"
            watermark(im, stamp(100 + m)).save(PO / f"{fid}.jpg", quality=85)
            po.append({"id": fid, "source": f"{'front_porch_theft' if scene=='fp' else 'dont_tempt'} t={(i-1)/2:.1f}s, parcel region painted out", "present": False, "count": 0})
    (HERE / "labels_painted_out.json").write_text(json.dumps(po, indent=1))
    print("frames", len(labels), "painted_out", len(po))

main()
