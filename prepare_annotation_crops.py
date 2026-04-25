"""
prepare_annotation_crops.py

Runs the existing YOLO label detector on a sample of images and saves
the cropped label regions to data/annotation_crops/images/.

These crops are the input for annotate_certs.js — you draw cert number
bounding boxes on each crop to train the cert-region detector (Model 2).

Usage:
  python prepare_annotation_crops.py               # 500 crops, all graders
  python prepare_annotation_crops.py --limit 200   # fewer crops
  python prepare_annotation_crops.py --grader PSA  # PSA only
  python prepare_annotation_crops.py --source unextractable
"""

import argparse
import json
import random
from pathlib import Path
from PIL import Image

BASE        = Path(__file__).resolve().parent
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
IMAGES_DIR  = BASE / 'data' / 'images'
CROPS_DIR   = BASE / 'data' / 'annotation_crops' / 'images'
MANIFEST_F  = BASE / 'data' / 'annotation_crops' / 'manifest.json'
MODEL_PATH  = BASE / 'models' / 'grading_labels_v3.pt'

CONF  = 0.75
PAD   = 0.06   # 6% padding around detected box

CLASS_NAMES = {0: 'PSA', 1: 'CGC', 2: 'BGS', 3: 'ACE'}  # adjust to match your model

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit',  type=int, default=500)
    parser.add_argument('--grader', type=str, default=None, help='PSA / CGC / BGS / ACE')
    parser.add_argument('--source', type=str, default='both',
                        choices=['cert_extracted', 'unextractable', 'both'])
    args = parser.parse_args()

    CROPS_DIR.mkdir(parents=True, exist_ok=True)

    # Load existing manifest so we don't regenerate
    manifest = {}
    if MANIFEST_F.exists():
        manifest = json.loads(MANIFEST_F.read_text(encoding='utf-8'))
    already  = len(manifest)

    from ultralytics import YOLO
    model = YOLO(str(MODEL_PATH))

    progress = json.loads(PROGRESS_F.read_text(encoding='utf-8'))

    # Build target list
    folders = []
    if args.source in ('cert_extracted', 'both'):  folders.append('cert_extracted')
    if args.source in ('unextractable',  'both'):  folders.append('unextractable')

    targets = [(iid, e) for iid, e in progress.items() if e.get('folder') in folders]
    random.shuffle(targets)

    print(f"\nSource pool: {len(targets)} listings  |  target crops: {args.limit}")
    print(f"Already in manifest: {already}\n")

    generated = 0
    skipped   = 0

    for itemId, _entry in targets:
        if generated >= args.limit:
            break

        img_dir = IMAGES_DIR / itemId
        if not img_dir.exists():
            continue

        meta = {}
        try:
            meta = json.loads((img_dir / '_meta.json').read_text(encoding='utf-8'))
        except Exception:
            pass

        grader = (meta.get('grader') or 'unknown').upper()
        if args.grader and grader != args.grader.upper():
            continue

        imgs = sorted(f for f in img_dir.iterdir()
                      if f.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'))
        if not imgs:
            continue

        saved = False
        for img_path in imgs[:4]:
            crop_name = f"{itemId}_{img_path.name}"
            if crop_name in manifest:
                saved = True
                break

            try:
                results = model(str(img_path), conf=CONF, verbose=False)
                if not results or not len(results[0].boxes):
                    continue

                boxes = results[0].boxes
                best  = boxes[boxes.conf.argmax()]

                x1, y1, x2, y2 = best.xyxy[0].tolist()
                cls_id   = int(best.cls[0])
                conf_val = float(best.conf[0])

                pil = Image.open(img_path).convert('RGB')
                W, H = pil.size

                pad_x = (x2 - x1) * PAD
                pad_y = (y2 - y1) * PAD
                cx1 = max(0, x1 - pad_x)
                cy1 = max(0, y1 - pad_y)
                cx2 = min(W, x2 + pad_x)
                cy2 = min(H, y2 + pad_y)

                crop = pil.crop((cx1, cy1, cx2, cy2))
                crop_path = CROPS_DIR / crop_name
                crop.save(crop_path, quality=95)

                manifest[crop_name] = {
                    'itemId':          itemId,
                    'grader':          grader,
                    'cardName':        meta.get('cardName', ''),
                    'detectedClass':   cls_id,
                    'detectedName':    CLASS_NAMES.get(cls_id, str(cls_id)),
                    'confidence':      round(conf_val, 3),
                    'annotated':       False,
                    'skipped':         False,
                }

                generated += 1
                saved = True

                if generated % 50 == 0:
                    MANIFEST_F.write_text(json.dumps(manifest, indent=2))
                    print(f"  {generated} crops generated...")
                break

            except Exception as e:
                skipped += 1
                continue

    MANIFEST_F.write_text(json.dumps(manifest, indent=2))

    total = len(manifest)
    annotated = sum(1 for v in manifest.values() if v.get('annotated'))
    print(f"\nDone.")
    print(f"  New crops this run : {generated}")
    print(f"  Total in manifest  : {total}  ({annotated} already annotated)")
    print(f"  Skipped (no detect): {skipped}")
    print(f"\nNow run the annotation tool:")
    print(f"  node annotate_certs.js")
    print(f"  Open http://localhost:3004\n")

if __name__ == '__main__':
    main()
