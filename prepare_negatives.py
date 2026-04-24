"""
prepare_negatives.py

Adds confirmed no-cert images to the YOLO training dataset as negative
examples (images with empty label files = no objects present).

This teaches the model to stop firing on ungraded card images.

What it does:
  1. Collects all images from data/no_cert_export/ (flattened)
  2. Splits 85% → train, 15% → valid
  3. Copies images + writes empty .txt label files for each
  4. Updates train_label_detector.py to run name v2 automatically

Run BEFORE training:
  python prepare_negatives.py

Then train as usual:
  python train_label_detector.py
"""

import os
import shutil
import random
import re
from pathlib import Path

BASE        = Path(__file__).resolve().parent
EXPORT_DIR  = BASE / "data" / "no_cert_export"
DATASET_DIR = BASE / "HXYT5PV7.v1i.yolov11"
TRAIN_IMG   = DATASET_DIR / "train" / "images"
TRAIN_LBL   = DATASET_DIR / "train" / "labels"
VALID_IMG   = DATASET_DIR / "valid" / "images"
VALID_LBL   = DATASET_DIR / "valid" / "labels"
TRAIN_PY    = BASE / "train_label_detector.py"

VALID_SPLIT = 0.15
SEED        = 42

# ── Collect all images ────────────────────────────────────────────────────────

image_paths = []
for listing_dir in EXPORT_DIR.iterdir():
    if not listing_dir.is_dir():
        continue
    for f in listing_dir.iterdir():
        if f.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'):
            image_paths.append(f)

if not image_paths:
    print("No images found in data/no_cert_export/ — run export_no_cert.js first.")
    exit(1)

print(f"\nFound {len(image_paths)} negative images across {sum(1 for d in EXPORT_DIR.iterdir() if d.is_dir())} listings")

# ── Split train / valid ───────────────────────────────────────────────────────

random.seed(SEED)
random.shuffle(image_paths)
split_at    = int(len(image_paths) * (1 - VALID_SPLIT))
train_imgs  = image_paths[:split_at]
valid_imgs  = image_paths[split_at:]

print(f"  → {len(train_imgs)} to train, {len(valid_imgs)} to valid (85/15 split)\n")

# ── Copy images + write empty label files ─────────────────────────────────────

def add_images(imgs, img_dir, lbl_dir, split_name):
    added = 0
    for src in imgs:
        # Use listing_itemId + original filename to avoid collisions
        dest_name = src.parent.name + "_" + src.name
        dest_img  = img_dir / dest_name
        dest_lbl  = lbl_dir / (dest_name.rsplit(".", 1)[0] + ".txt")

        if dest_img.exists():
            continue  # already added in a previous run

        shutil.copy2(src, dest_img)
        dest_lbl.write_text("")   # empty label = no objects in this image
        added += 1

    print(f"  {split_name}: added {added} new images ({len(list(img_dir.iterdir()))} total now)")

add_images(train_imgs, TRAIN_IMG, TRAIN_LBL, "train")
add_images(valid_imgs, VALID_IMG, VALID_LBL, "valid")

# ── Bump run name to v2 in train_label_detector.py ───────────────────────────

if TRAIN_PY.exists():
    src = TRAIN_PY.read_text(encoding="utf-8")
    # Replace RUN_NAME = "grading_labels_v1" → v2
    updated = re.sub(r'(RUN_NAME\s*=\s*["\'])grading_labels_v\d+(["\'])',
                     r'\1grading_labels_v2\2', src)
    if updated != src:
        TRAIN_PY.write_text(updated, encoding="utf-8")
        print("\n  Updated train_label_detector.py → RUN_NAME = grading_labels_v2")
    else:
        print("\n  train_label_detector.py already set to v2 (or pattern not matched)")

# ── Delete labels cache so YOLO re-scans the updated dataset ─────────────────

for cache in DATASET_DIR.rglob("labels.cache"):
    cache.unlink()
    print(f"  Deleted stale cache: {cache}")

print("\n" + "=" * 55)
print("  Dataset ready. Run training with:")
print("    python train_label_detector.py")
print("=" * 55 + "\n")
