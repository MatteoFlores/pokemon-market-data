"""
train_cert_detector.py

Trains Model 2 — the cert number sub-region detector.
Input:  label crops from prepare_annotation_crops.py
Output: models/cert_detector_v1.pt

Classes:
  0  psa_cert   PSA cert number region
  1  bgs_cert   BGS cert number region
  2  cgc_cert   CGC cert number region
  3  ace_qr     ACE QR code region

Usage:
  .\\venv\\Scripts\\activate
  python train_cert_detector.py
"""

import json
import random
import shutil
from pathlib import Path
from ultralytics import YOLO
import torch

BASE         = Path(__file__).resolve().parent
MANIFEST_F   = BASE / 'data' / 'annotation_crops' / 'manifest.json'
IMAGES_SRC   = BASE / 'data' / 'annotation_crops' / 'images'
LABELS_SRC   = BASE / 'data' / 'annotation_crops' / 'labels'
DATASET_DIR  = BASE / 'data' / 'cert_detector_dataset'
MODELS_DIR   = BASE / 'models'

VALID_SPLIT  = 0.15
SEED         = 42
CLASSES      = ['psa_cert', 'bgs_cert', 'cgc_cert', 'tag_qr']
RUN_NAME     = 'cert_detector_v1'

EPOCHS       = 150
BATCH_SIZE   = 32
IMAGE_SIZE   = 640
PATIENCE     = 25
WORKERS      = 4


def build_dataset():
    manifest  = json.loads(MANIFEST_F.read_text(encoding='utf-8'))
    annotated = [(n, m) for n, m in manifest.items() if m.get('annotated')]

    if not annotated:
        raise RuntimeError('No annotated crops found. Run annotate_certs.js first.')

    print(f'  Annotated crops : {len(annotated)}')

    by_class = {}
    for _, m in annotated:
        for ann in (m.get('annotations') or []):
            cls = CLASSES[ann['class']] if ann['class'] < len(CLASSES) else str(ann['class'])
            by_class[cls] = by_class.get(cls, 0) + 1
    for cls, n in sorted(by_class.items()):
        print(f'    {cls}: {n} boxes')

    random.seed(SEED)
    random.shuffle(annotated)
    cut   = int(len(annotated) * (1 - VALID_SPLIT))
    train = annotated[:cut]
    valid = annotated[cut:]
    print(f'  Train: {len(train)}   Valid: {len(valid)}')

    for split_name, items in [('train', train), ('valid', valid)]:
        img_dir = DATASET_DIR / split_name / 'images'
        lbl_dir = DATASET_DIR / split_name / 'labels'
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        copied, missing = 0, 0
        for name, _ in items:
            src_img = IMAGES_SRC / name
            src_lbl = LABELS_SRC / (Path(name).stem + '.txt')
            if not src_img.exists() or not src_lbl.exists():
                missing += 1
                continue
            shutil.copy2(src_img, img_dir / name)
            shutil.copy2(src_lbl, lbl_dir / (Path(name).stem + '.txt'))
            copied += 1

        print(f'  {split_name}: {copied} copied' + (f', {missing} missing' if missing else ''))

    for cache in DATASET_DIR.rglob('labels.cache'):
        cache.unlink()

    yaml_path = DATASET_DIR / 'dataset.yaml'
    yaml_path.write_text(
        f'path: {DATASET_DIR.as_posix()}\n'
        f'train: train/images\n'
        f'val:   valid/images\n\n'
        f'nc: {len(CLASSES)}\n'
        f'names: {CLASSES}\n'
    )
    return yaml_path


def main():
    print('=' * 60)
    print('  Cert Number Detector — Training')
    print('=' * 60)
    print(f'\n  GPU  : {torch.cuda.get_device_name(0)}')
    print(f'  VRAM : {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB')
    print(f'  Epochs: {EPOCHS}  Batch: {BATCH_SIZE}  Patience: {PATIENCE}\n')

    print('Building dataset...')
    yaml_path = build_dataset()
    print(f'  Dataset yaml: {yaml_path}\n')

    MODELS_DIR.mkdir(exist_ok=True)
    model = YOLO('yolo11s.pt')

    print(f'Starting training (run: {RUN_NAME})...\n')
    results = model.train(
        data      = str(yaml_path),
        epochs    = EPOCHS,
        batch     = BATCH_SIZE,
        imgsz     = IMAGE_SIZE,
        patience  = PATIENCE,
        workers   = WORKERS,
        device    = 0,
        project   = str(MODELS_DIR / 'runs'),
        name      = RUN_NAME,
        exist_ok  = True,

        hsv_h     = 0.015,
        hsv_s     = 0.7,
        hsv_v     = 0.4,
        degrees   = 5.0,
        translate = 0.1,
        scale     = 0.3,
        fliplr    = 0.5,
        mosaic    = 0.3,
        mixup     = 0.05,

        verbose   = True,
        plots     = True,
    )

    best_src = MODELS_DIR / 'runs' / RUN_NAME / 'weights' / 'best.pt'
    best_dst = MODELS_DIR / 'cert_detector_v1.pt'
    if best_src.exists():
        shutil.copy2(best_src, best_dst)
        print(f'\n✓ Best model saved to {best_dst}')
    else:
        print(f'\nWARN: best.pt not found at {best_src}')

    print('\n' + '=' * 60)
    print('  Training complete!')
    try:
        print(f'  mAP50    : {results.results_dict.get("metrics/mAP50(B)", "N/A"):.4f}')
        print(f'  mAP50-95 : {results.results_dict.get("metrics/mAP50-95(B)", "N/A"):.4f}')
    except Exception:
        pass
    print('=' * 60)
    print('\nNext: python wire_cert_detector.py  (updates extract_certs.py pipeline)\n')


if __name__ == '__main__':
    main()
