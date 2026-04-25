"""
prepare_label_images.py

Samples full (un-cropped) images and records the current model's bounding box
prediction (likely wrong — pointing at card face instead of top label).

Use with annotate_labels.js to draw the CORRECT bounding box around the
grading label at the top of the slab.

Usage:
  python prepare_label_images.py                   # 150 per grader
  python prepare_label_images.py --per-grader 200
  python prepare_label_images.py --grader PSA --limit 300
"""

import argparse
import json
import random
from pathlib import Path
from PIL import Image

BASE        = Path(__file__).resolve().parent
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
IMAGES_DIR  = BASE / 'data' / 'images'
OUT_DIR     = BASE / 'data' / 'label_annotation' / 'images'
MANIFEST_F  = BASE / 'data' / 'label_annotation' / 'manifest.json'
MODEL_PATH  = BASE / 'models' / 'grading_labels.pt'

CONF        = 0.25   # low threshold — we want to capture whatever the model sees
CLASS_NAMES = {0: 'PSA', 1: 'CGC', 2: 'BGS', 3: 'TAG'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--per-grader', type=int, default=150,
                        help='Images to sample per grader (default 150)')
    parser.add_argument('--grader', type=str, default=None,
                        help='Only sample one grader: PSA / CGC / BGS / ACE')
    parser.add_argument('--limit', type=int, default=None,
                        help='Hard cap on total images (used with --grader)')
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {}
    if MANIFEST_F.exists():
        manifest = json.loads(MANIFEST_F.read_text(encoding='utf-8'))
    already = len(manifest)

    from ultralytics import YOLO
    model = YOLO(str(MODEL_PATH))

    progress = json.loads(PROGRESS_F.read_text(encoding='utf-8'))
    targets  = [(iid, e) for iid, e in progress.items()
                if e.get('folder') in ('cert_extracted', 'unextractable')]
    random.shuffle(targets)

    counts  = {'PSA': 0, 'CGC': 0, 'BGS': 0, 'ACE': 0, 'OTHER': 0}
    total   = 0
    # When targeting a single grader, cap = --limit if given, else --per-grader
    cap     = args.limit if args.limit else (args.per_grader if args.grader else 999_999)

    print(f"\nAlready in manifest: {already}")
    print(f"Target: {args.per_grader} per grader\n")

    for itemId, _entry in targets:
        # Stop conditions
        if args.grader:
            if total >= cap:
                break
        else:
            if all(counts.get(g, 0) >= args.per_grader for g in ('PSA', 'CGC', 'BGS', 'ACE')):
                break

        img_dir = IMAGES_DIR / itemId
        if not img_dir.exists():
            continue

        meta = {}
        try:
            meta = json.loads((img_dir / '_meta.json').read_text(encoding='utf-8'))
        except Exception:
            pass

        grader = (meta.get('grader') or 'OTHER').upper()
        if args.grader and grader != args.grader.upper():
            continue

        g_key = grader if grader in counts else 'OTHER'
        if counts.get(g_key, 0) >= args.per_grader:
            continue

        imgs = sorted(f for f in img_dir.iterdir()
                      if f.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'))
        if not imgs:
            continue

        img_path  = imgs[0]
        dest_name = f"{itemId}_{img_path.name}"
        if dest_name in manifest:
            counts[g_key] = counts.get(g_key, 0) + 1
            total += 1
            continue

        try:
            pil = Image.open(img_path).convert('RGB')
            W, H = pil.size

            # Save full image (no crop)
            pil.save(OUT_DIR / dest_name, quality=92)

            # Record current model prediction (this is what we're fixing)
            results = model(str(img_path), conf=CONF, verbose=False)
            pred_bbox  = None
            pred_cls   = None
            pred_conf  = None

            if results and len(results[0].boxes):
                boxes = results[0].boxes
                best  = boxes[boxes.conf.argmax()]
                x1, y1, x2, y2 = best.xyxy[0].tolist()
                pred_bbox = {'x1': x1/W, 'y1': y1/H, 'x2': x2/W, 'y2': y2/H}
                pred_cls  = int(best.cls[0])
                pred_conf = round(float(best.conf[0]), 3)

            manifest[dest_name] = {
                'itemId':        itemId,
                'grader':        grader,
                'cardName':      meta.get('cardName', ''),
                'predictedBbox': pred_bbox,
                'predictedCls':  pred_cls,
                'predictedName': CLASS_NAMES.get(pred_cls, '?') if pred_cls is not None else None,
                'predictedConf': pred_conf,
                'annotated':     False,
                'skipped':       False,
            }

            counts[g_key] = counts.get(g_key, 0) + 1
            total += 1

            if total % 50 == 0:
                MANIFEST_F.write_text(json.dumps(manifest, indent=2))
                print(f"  {total}  —  PSA:{counts['PSA']}  CGC:{counts['CGC']}  "
                      f"BGS:{counts['BGS']}  ACE:{counts['ACE']}")

        except Exception:
            continue

    MANIFEST_F.write_text(json.dumps(manifest, indent=2))
    print(f"\nDone.  {total} images saved to data/label_annotation/images/")
    print(f"  PSA:{counts['PSA']}  CGC:{counts['CGC']}  BGS:{counts['BGS']}  ACE:{counts['ACE']}")
    print(f"\nNext: node annotate_labels.js  →  http://localhost:3005\n")

if __name__ == '__main__':
    main()
