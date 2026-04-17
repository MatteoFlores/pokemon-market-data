"""
evaluate_model.py

Evaluates the trained grading label detector in two ways:

  1. FORMAL METRICS  — runs model.val() on the held-out test set and prints
                        per-class precision, recall, mAP50, and mAP50-95.

  2. REAL-WORLD TEST — picks random images from data/images/ (actual eBay
                        listing photos) and runs inference. Saves annotated
                        images to data/eval_samples/ so you can visually
                        inspect what the model detects (and misses) on real
                        cards before committing to a full extraction run.

Usage:
  .\\venv\\Scripts\\activate
  python evaluate_model.py              # 30 sample real-world images
  python evaluate_model.py --samples 60 # more samples

Output:
  data/eval_samples/
    formal_metrics.txt          — full test-set metric report
    {itemId}_{imgName}.jpg      — annotated real-world detections
    summary.json                — machine-readable summary
"""

import argparse
import json
import random
import shutil
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

# ── Config ────────────────────────────────────────────────────────────────────

_BASE        = Path(__file__).resolve().parent
MODEL_PATH   = _BASE / "models" / "grading_labels.pt"
DATASET_YAML = _BASE / "HXYT5PV7.v1i.yolov11" / "data_fixed.yaml"
IMAGES_DIR   = _BASE / "data" / "images"
EVAL_DIR     = _BASE / "data" / "eval_samples"

# Classes we specifically care about for cert extraction
KEY_CLASSES  = {"psa_label", "psa_label_old", "psa_slab",
                "cgc_label", "cgc_label_old",
                "bgs_label", "bgs_label_auto", "bgs_label_black"}

# Colour per class for annotation boxes (BGR)
CLASS_COLORS = {
    "psa_label":       (0,   200, 255),   # orange
    "psa_label_old":   (0,   165, 255),   # dark orange
    "psa_slab":        (0,   100, 255),   # amber
    "cgc_label":       (255, 180,   0),   # blue
    "cgc_label_old":   (255, 140,   0),   # darker blue
    "cgc_slab":        (255, 100,   0),   # dark blue
    "bgs_label":       (0,   230,   0),   # green
    "bgs_label_auto":  (0,   190,  50),
    "bgs_label_black": (0,   150,  50),
    "bgs_slab":        (0,   100,  50),
    "card":            (180, 180, 180),   # grey
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def draw_detections(img_bgr: np.ndarray, result, names: dict) -> np.ndarray:
    """Draw bounding boxes + labels on a copy of the image."""
    out = img_bgr.copy()
    if result.boxes is None:
        return out

    for box in result.boxes:
        cls_name = names[int(box.cls[0])]
        conf     = float(box.conf[0])
        x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
        color = CLASS_COLORS.get(cls_name, (200, 200, 200))

        # Box
        thickness = 3 if cls_name in KEY_CLASSES else 1
        cv2.rectangle(out, (x1, y1), (x2, y2), color, thickness)

        # Label background
        label    = f"{cls_name} {conf:.2f}"
        font     = cv2.FONT_HERSHEY_SIMPLEX
        scale    = 0.55
        (tw, th), baseline = cv2.getTextSize(label, font, scale, 1)
        cv2.rectangle(out, (x1, y1 - th - baseline - 4), (x1 + tw + 4, y1), color, -1)
        cv2.putText(out, label, (x1 + 2, y1 - baseline - 2),
                    font, scale, (0, 0, 0), 1, cv2.LINE_AA)
    return out


def collect_sample_images(n: int) -> list[tuple[str, Path]]:
    """
    Pick n random images from data/images/ subdirectories.
    Returns list of (item_id, image_path).
    """
    all_images = []
    if not IMAGES_DIR.exists():
        return []

    for item_dir in IMAGES_DIR.iterdir():
        if not item_dir.is_dir():
            continue
        for img in item_dir.glob("*.jpg"):
            all_images.append((item_dir.name, img))

    random.shuffle(all_images)
    return all_images[:n]


# ── Part 1: Formal test-set metrics ──────────────────────────────────────────

def run_formal_metrics(model: YOLO) -> dict:
    if not DATASET_YAML.exists():
        # Try unfixed version
        fallback = DATASET_YAML.parent / "data.yaml"
        if not fallback.exists():
            print(f"  WARN: dataset YAML not found, skipping formal metrics.")
            return {}
        yaml_path = str(fallback)
    else:
        yaml_path = str(DATASET_YAML)

    print("  Running validation on test split...")
    metrics = model.val(
        data   = yaml_path,
        split  = "test",
        device = 0,
        verbose= False,
        plots  = True,
        save_json = False,
        project= str(EVAL_DIR / "formal_runs"),
        name   = "test_eval",
        exist_ok = True,
    )

    names    = model.names
    results  = {}
    lines    = []

    lines.append("=" * 62)
    lines.append("  FORMAL TEST-SET METRICS")
    lines.append("=" * 62)
    lines.append(f"  {'Class':<22} {'Prec':>6} {'Rec':>6} {'mAP50':>7} {'mAP50-95':>9}")
    lines.append("  " + "-" * 58)

    # Overall
    mp    = float(metrics.box.mp)    # mean precision
    mr    = float(metrics.box.mr)    # mean recall
    map50 = float(metrics.box.map50)
    map   = float(metrics.box.map)

    lines.append(f"  {'ALL CLASSES':<22} {mp:>6.3f} {mr:>6.3f} {map50:>7.3f} {map:>9.3f}")
    lines.append("  " + "-" * 58)

    results["overall"] = {"precision": mp, "recall": mr, "mAP50": map50, "mAP50-95": map}

    # Per-class (maps50 is array per class)
    if hasattr(metrics.box, "maps") and metrics.box.maps is not None:
        maps_per_class = metrics.box.maps  # mAP50-95 per class
    else:
        maps_per_class = [None] * len(names)

    if hasattr(metrics.box, "ap_class_index"):
        class_indices = metrics.box.ap_class_index
        ap50_per      = metrics.box.ap50   # per-class AP50
        prec_per      = metrics.box.p
        rec_per       = metrics.box.r
        for i, cls_idx in enumerate(class_indices):
            cname  = names[cls_idx]
            flag   = " ◄" if cname in KEY_CLASSES else ""
            p_val  = float(prec_per[i]) if prec_per is not None else 0.0
            r_val  = float(rec_per[i])  if rec_per  is not None else 0.0
            a50    = float(ap50_per[i]) if ap50_per  is not None else 0.0
            a5095  = float(maps_per_class[i]) if maps_per_class[i] is not None else 0.0
            lines.append(f"  {cname:<22} {p_val:>6.3f} {r_val:>6.3f} {a50:>7.3f} {a5095:>9.3f}{flag}")
            results[cname] = {"precision": p_val, "recall": r_val, "mAP50": a50, "mAP50-95": a5095}

    lines.append("=" * 62)
    lines.append("  ◄ = classes used for cert number extraction")

    report = "\n".join(lines)
    print(report)

    # Save to file
    out_txt = EVAL_DIR / "formal_metrics.txt"
    out_txt.write_text(report, encoding="utf-8")
    print(f"\n  Saved to: {out_txt}")
    return results


# ── Part 2: Real-world visual evaluation ─────────────────────────────────────

def run_realworld_eval(model: YOLO, n_samples: int) -> dict:
    print(f"\n  Sampling {n_samples} real eBay listing images...")
    samples = collect_sample_images(n_samples)

    if not samples:
        print("  No images found in data/images/ yet — run the scrapers first.")
        return {}

    print(f"  Found {len(samples)} images. Running inference...")

    detected_count   = 0
    key_class_count  = 0
    no_detect_count  = 0
    per_class_counts = {}

    for item_id, img_path in samples:
        img = cv2.imread(str(img_path))
        if img is None:
            continue

        results  = model(str(img_path), verbose=False, conf=0.40)[0]
        annotated = draw_detections(img, results, model.names)

        # Count detections
        found_key = False
        if results.boxes is not None and len(results.boxes) > 0:
            detected_count += 1
            for box in results.boxes:
                cname = model.names[int(box.cls[0])]
                per_class_counts[cname] = per_class_counts.get(cname, 0) + 1
                if cname in KEY_CLASSES:
                    found_key = True
            if found_key:
                key_class_count += 1
        else:
            no_detect_count += 1

        # Save annotated image (resize to max 800px wide for readability)
        h, w = annotated.shape[:2]
        if w > 800:
            scale    = 800 / w
            annotated = cv2.resize(annotated, (800, int(h * scale)))

        out_name = f"{item_id}_{img_path.stem}.jpg"
        cv2.imwrite(str(EVAL_DIR / out_name), annotated)

    total = len(samples)
    print(f"\n  Real-world detection results ({total} images):")
    print(f"    Any detection found : {detected_count}/{total}  ({detected_count/total*100:.1f}%)")
    print(f"    Label class found   : {key_class_count}/{total}  ({key_class_count/total*100:.1f}%)")
    print(f"    Nothing detected    : {no_detect_count}/{total}  ({no_detect_count/total*100:.1f}%)")
    print(f"\n  Detections per class:")
    for cls, cnt in sorted(per_class_counts.items(), key=lambda x: -x[1]):
        marker = " ◄" if cls in KEY_CLASSES else ""
        print(f"    {cls:<24} {cnt:>4}{marker}")

    return {
        "total_images":     total,
        "any_detection":    detected_count,
        "label_class_hit":  key_class_count,
        "no_detection":     no_detect_count,
        "per_class":        per_class_counts,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=30,
                        help="Number of real-world images to test (default: 30)")
    args = parser.parse_args()

    if not MODEL_PATH.exists():
        print(f"\nERROR: {MODEL_PATH} not found.")
        print("Training must complete first (train_label_detector.py).\n")
        return

    EVAL_DIR.mkdir(parents=True, exist_ok=True)

    print("\n" + "=" * 62)
    print("  Grading Label Detector — Evaluation")
    print("=" * 62)
    print(f"  Model   : {MODEL_PATH}")
    print(f"  Output  : {EVAL_DIR}\n")

    model = YOLO(str(MODEL_PATH))
    model.to("cuda")

    # Part 1 — formal test metrics
    formal_results = run_formal_metrics(model)

    # Part 2 — real-world visual check
    rw_results = run_realworld_eval(model, args.samples)

    # Save combined summary
    summary = {
        "model":       str(MODEL_PATH),
        "formal":      formal_results,
        "realworld":   rw_results,
    }
    summary_path = EVAL_DIR / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2))

    print(f"\n  Annotated images saved to : {EVAL_DIR}")
    print(f"  Summary JSON              : {summary_path}")

    # Guidance based on mAP
    overall_map50 = formal_results.get("overall", {}).get("mAP50", 0)
    print("\n" + "=" * 62)
    if overall_map50 >= 0.90:
        print(f"  mAP50 = {overall_map50:.3f} ✓  Model looks strong.")
        print("  You can proceed to: python extract_certs.py --limit 50")
        print("  to test cert extraction on 50 real listings.")
    elif overall_map50 >= 0.75:
        print(f"  mAP50 = {overall_map50:.3f}  Decent but check per-class metrics above.")
        print("  Look at verify_later/ after running extract_certs.py --limit 50.")
        print("  Adding more labeled images for weak classes will help.")
    else:
        print(f"  mAP50 = {overall_map50:.3f}  Low — check annotated images in eval_samples/")
        print("  The model may need more training images for some classes.")
        print("  Consider adding your own labeled images via Roboflow and retraining.")
    print("=" * 62 + "\n")


if __name__ == "__main__":
    main()
