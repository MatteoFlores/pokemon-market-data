"""
train_label_detector.py

Trains a YOLOv11s model on the Roboflow grading label dataset to detect
PSA, BGS, and CGC label regions in eBay listing images.

After training, the best model is saved to:
  models/grading_labels.pt

Usage:
  # Make sure venv is active:
  .\\venv\\Scripts\\activate

  # Then run:
  python train_label_detector.py

Classes in the dataset (11 total):
  0  bgs_label
  1  bgs_label_auto
  2  bgs_label_black
  3  bgs_slab
  4  card
  5  cgc_label
  6  cgc_label_old
  7  cgc_slab
  8  psa_label        ← primary target
  9  psa_label_old    ← primary target
  10 psa_slab
"""

import os
import shutil
from pathlib import Path
from ultralytics import YOLO

# ── Config ────────────────────────────────────────────────────────────────────

_BASE         = Path(__file__).resolve().parent
DATASET_YAML  = str(_BASE / "HXYT5PV7.v1i.yolov11" / "data.yaml")
MODELS_DIR    = _BASE / "models"
RUN_NAME      = "grading_labels_v2"

# Training hyperparameters — tuned for your 3080 Ti (12 GB VRAM)
EPOCHS        = 150
BATCH_SIZE    = 32      # fits comfortably in 12 GB with yolo11s
IMAGE_SIZE    = 640
PATIENCE      = 30      # early stop if val/mAP doesn't improve for 30 epochs
WORKERS       = 4

# ── Fix data.yaml paths (Roboflow uses relative paths that break on Windows) ──

def fix_yaml_paths(yaml_path: str) -> str:
    """
    Roboflow exports data.yaml with Linux-style relative paths (../train/images).
    On Windows this can confuse ultralytics. We rewrite it with absolute paths
    and save a fixed copy next to the original.
    """
    import yaml
    yaml_path = Path(yaml_path)
    dataset_root = yaml_path.parent

    with open(yaml_path) as f:
        data = yaml.safe_load(f)

    for key in ("train", "val", "test"):
        if key in data and data[key]:
            rel = data[key].lstrip("./").lstrip("../")
            # Handle both ../train/images and train/images patterns
            for candidate in [
                dataset_root / rel,
                dataset_root.parent / rel,
                dataset_root / rel.split("/")[-2] / rel.split("/")[-1],
            ]:
                if candidate.exists():
                    data[key] = str(candidate)
                    break

    fixed_path = yaml_path.parent / "data_fixed.yaml"
    with open(fixed_path, "w") as f:
        yaml.dump(data, f, default_flow_style=False)

    print(f"  Fixed YAML written to: {fixed_path}")
    print(f"  train : {data.get('train')}")
    print(f"  val   : {data.get('val')}")
    print(f"  test  : {data.get('test')}")
    return str(fixed_path)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    MODELS_DIR.mkdir(exist_ok=True)

    print("=" * 60)
    print("  Grading Label Detector — YOLOv11s Training")
    print("=" * 60)

    import torch
    print(f"\n  GPU      : {torch.cuda.get_device_name(0)}")
    print(f"  VRAM     : {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")
    print(f"  Epochs   : {EPOCHS}  (early stop patience: {PATIENCE})")
    print(f"  Batch    : {BATCH_SIZE}  |  Image size: {IMAGE_SIZE}")

    # Fix dataset YAML paths for Windows
    print("\n  Fixing dataset YAML paths...")
    fixed_yaml = fix_yaml_paths(DATASET_YAML)

    # Load pretrained YOLOv11s (downloads ~22 MB on first run)
    print("\n  Loading YOLOv11s base weights...")
    model = YOLO("yolo11s.pt")

    # Train
    print(f"\n  Starting training (run name: {RUN_NAME})...")
    print("  Progress will stream below. Ctrl+C safely stops and keeps best weights.\n")

    results = model.train(
        data      = fixed_yaml,
        epochs    = EPOCHS,
        batch     = BATCH_SIZE,
        imgsz     = IMAGE_SIZE,
        patience  = PATIENCE,
        workers   = WORKERS,
        device    = 0,          # GPU 0
        project   = str(MODELS_DIR / "runs"),
        name      = RUN_NAME,
        exist_ok  = True,

        # Augmentation — good for variable eBay photo conditions
        hsv_h     = 0.015,
        hsv_s     = 0.7,
        hsv_v     = 0.4,
        degrees   = 10.0,       # labels can be slightly rotated in photos
        translate = 0.1,
        scale     = 0.5,
        fliplr    = 0.5,
        mosaic    = 1.0,
        mixup     = 0.1,

        # Logging
        verbose   = True,
        plots     = True,       # saves confusion matrix, PR curves, etc.
    )

    # Copy best weights to models/ root for easy access
    best_src = MODELS_DIR / "runs" / RUN_NAME / "weights" / "best.pt"
    best_dst = MODELS_DIR / "grading_labels.pt"
    if best_src.exists():
        shutil.copy(best_src, best_dst)
        print(f"\n  Best model copied to: {best_dst}")
    else:
        print(f"\n  WARN: best.pt not found at {best_src}")
        print(f"        Check {MODELS_DIR / 'runs' / RUN_NAME / 'weights'} manually")

    # Print final metrics
    print("\n" + "=" * 60)
    print("  Training complete!")
    print(f"  Best model : {best_dst}")
    print(f"  Run folder : {MODELS_DIR / 'runs' / RUN_NAME}")
    print(f"\n  mAP50      : {results.results_dict.get('metrics/mAP50(B)', 'N/A'):.4f}")
    print(f"  mAP50-95   : {results.results_dict.get('metrics/mAP50-95(B)', 'N/A'):.4f}")
    print("=" * 60)
    print("\n  Next step: python extract_certs.py")


if __name__ == "__main__":
    main()
