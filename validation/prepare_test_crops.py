"""
validation/prepare_test_crops.py

Generates 350 cert-region crops for hand-labeling.

For each sampled item:
  1. Run Model 1 (YOLO) to find the grading label
  2. Run Model 2 (cert detector) to find the cert sub-region
  3. Save the crop to data/test_crops/images/
  4. Record the pipeline's cert guess (if any) in the manifest

If YOLO finds nothing, saves a 400×300 thumbnail of the first image
so the human labeler can confirm "no cert here" (pipeline-impossible cases).

Output:
  data/test_crops/images/   - cropped images
  data/test_crops/manifest.json

Usage:
  .\\venv\\Scripts\\activate
  python validation/prepare_test_crops.py
  python validation/prepare_test_crops.py --count 500
"""

import argparse
import json
import random
import re
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True

BASE        = Path(__file__).resolve().parent.parent
IMAGES_DIR  = BASE / 'data' / 'images'
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
CERT_JSON   = BASE / 'data' / 'cert_results' / 'cert_numbers.json'
OUT_DIR     = BASE / 'data' / 'test_crops' / 'images'
MANIFEST_F  = BASE / 'data' / 'test_crops' / 'manifest.json'
MODEL_PATH  = BASE / 'models' / 'grading_labels_v3.pt'
CERT_MODEL  = BASE / 'models' / 'cert_detector_v1.pt'

YOLO_CONF   = 0.75
CERT_CONF   = 0.50
CROP_PAD    = 0.12
CERT_PAD    = 0.08
CERT_RE     = re.compile(r'\b(\d{8,13})\b')


def get_items_with_images() -> list[str]:
    """Return item IDs that have at least one .jpg image."""
    if not IMAGES_DIR.exists():
        return []
    items = []
    for d in IMAGES_DIR.iterdir():
        if d.is_dir() and list(d.glob('*.jpg')):
            items.append(d.name)
    return items


def crop_label(img_bgr, box, pad=CROP_PAD):
    h, w = img_bgr.shape[:2]
    x1, y1, x2, y2 = box
    px = (x2 - x1) * pad
    py = (y2 - y1) * pad
    return img_bgr[
        max(0, int(y1 - py)):min(h, int(y2 + py)),
        max(0, int(x1 - px)):min(w, int(x2 + px)),
    ]


def crop_cert(label_bgr, box, pad=CERT_PAD):
    h, w = label_bgr.shape[:2]
    x1, y1, x2, y2 = box
    px = (x2 - x1) * pad
    py = (y2 - y1) * pad
    return label_bgr[
        max(0, int(y1 - py)):min(h, int(y2 + py)),
        max(0, int(x1 - px)):min(w, int(x2 + px)),
    ]


def thumbnail(img_bgr, w=400, h=300):
    return cv2.resize(img_bgr, (w, h), interpolation=cv2.INTER_AREA)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--count', type=int, default=350,
                        help='Number of crops to generate (default 350)')
    parser.add_argument('--seed',  type=int, default=99)
    args = parser.parse_args()

    if not MODEL_PATH.exists():
        print(f'ERROR: {MODEL_PATH} not found — run train_label_detector_v3.py first')
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST_F.read_text(encoding='utf-8')) if MANIFEST_F.exists() else {}
    cert_db  = json.loads(CERT_JSON.read_text(encoding='utf-8')) if CERT_JSON.exists() else {}

    from ultralytics import YOLO
    print('Loading models...')
    model1 = YOLO(str(MODEL_PATH))
    model2 = YOLO(str(CERT_MODEL)) if CERT_MODEL.exists() else None
    if model2:
        print(f'  Model 2 loaded: {CERT_MODEL.name}')
    else:
        print('  Model 2 not found — using full label crop')

    print('Scanning image folders...')
    all_items = get_items_with_images()
    # Exclude items already in manifest
    already = set(v['itemId'] for v in manifest.values())
    candidates = [iid for iid in all_items if iid not in already]

    random.seed(args.seed)
    random.shuffle(candidates)
    targets = candidates[:args.count * 2]  # oversample to hit count after skips

    print(f'  Candidates: {len(candidates)}  Targeting: {args.count} crops\n')

    saved = 0
    for iid in targets:
        if saved >= args.count:
            break

        img_dir = IMAGES_DIR / iid
        images  = sorted(img_dir.glob('*.jpg'))
        if not images:
            continue

        meta = {}
        meta_path = img_dir / '_meta.json'
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
            except Exception:
                pass

        grader = (meta.get('grader') or 'UNKNOWN').upper()

        # Pipeline cert guess (from existing cert_db)
        pipeline_cert = cert_db.get(iid, {}).get('certNumber')

        # Try YOLO on first image
        img_path = images[0]
        img = cv2.imread(str(img_path))
        if img is None:
            continue

        crop = None
        yolo_conf = 0.0
        cls_name  = None
        crop_type = 'fallback'

        try:
            results = model1(str(img_path), conf=YOLO_CONF, verbose=False)
            if results and results[0].boxes and len(results[0].boxes):
                boxes = results[0].boxes
                best  = boxes[boxes.conf.argmax()]
                x1, y1, x2, y2 = best.xyxy[0].cpu().numpy()
                yolo_conf = float(best.conf[0])
                cls_name  = results[0].names[int(best.cls[0])]

                label_crop = crop_label(img, (x1, y1, x2, y2))
                if label_crop.size == 0:
                    raise ValueError('empty label crop')

                if model2 is not None:
                    r2 = model2(label_crop, conf=CERT_CONF, verbose=False)
                    if r2 and r2[0].boxes and len(r2[0].boxes):
                        b2   = r2[0].boxes
                        best2 = b2[b2.conf.argmax()]
                        cx1, cy1, cx2, cy2 = best2.xyxy[0].cpu().numpy()
                        c2 = crop_cert(label_crop, (cx1, cy1, cx2, cy2))
                        if c2.size > 0:
                            crop = c2
                            crop_type = 'cert_region'

                if crop is None:
                    crop = label_crop
                    crop_type = 'label_crop'
        except Exception:
            pass

        if crop is None:
            crop = thumbnail(img)
            crop_type = 'fallback'

        # Save
        out_name = f'{iid}_crop.jpg'
        out_path = OUT_DIR / out_name
        try:
            cv2.imwrite(str(out_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
        except Exception:
            continue

        manifest[out_name] = {
            'itemId':       iid,
            'grader':       grader,
            'cardName':     meta.get('cardName', ''),
            'pipelineCert': pipeline_cert,
            'yoloConf':     round(yolo_conf, 3),
            'yoloCls':      cls_name,
            'cropType':     crop_type,
            'trueCert':     None,
            'skipped':      False,
        }
        saved += 1

        if saved % 25 == 0:
            MANIFEST_F.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
            print(f'  {saved} / {args.count}  (fallback: {sum(1 for v in manifest.values() if v["cropType"]=="fallback")})')

    MANIFEST_F.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    by_type = {}
    for v in manifest.values():
        by_type[v['cropType']] = by_type.get(v['cropType'], 0) + 1
    print(f'\nDone. {saved} crops saved to {OUT_DIR}')
    for t, n in sorted(by_type.items()):
        print(f'  {t}: {n}')
    print(f'\nNext: node validation/label_certs.js  →  http://localhost:3006')


if __name__ == '__main__':
    main()
