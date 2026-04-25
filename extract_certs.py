"""
extract_certs.py

Second-pass cert number extractor. Reads already-downloaded images from
data/images/{itemId}/ and extracts PSA/BGS/CGC cert numbers using:

  Step 0 — pyzbar barcode decode (fastest, most reliable)
  Step 1 — YOLOv11 label detection → crop
  Step 2 — EasyOCR + PaddleOCR on the crop (parallel)
  Step 3 — Confidence routing to output folders

Output folders:
  data/cert_results/cert_extracted/   ≥95% confidence — images DELETED
  data/cert_results/ocr_success/      cert found, images KEPT (both engines agreed)
  data/cert_results/verify_later/     below threshold — images KEPT for manual review
  data/cert_results/unextractable/    no label detected in any image

Master lookup:
  data/cert_results/cert_numbers.json   { itemId: { certNumber, confidence, method, ... } }

Usage:
  .\\venv\\Scripts\\activate
  python extract_certs.py                  # process all downloaded items
  python extract_certs.py --limit 20       # test on first 20 items
  python extract_certs.py --recheck        # re-process verify_later items only

Requirements:
  models/grading_labels.pt must exist (run train_label_detector.py first)
"""

import argparse
import json
import os
import re
import shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import contextlib
import ctypes
import os

import cv2
import numpy as np
from PIL import Image, ImageFile
from pyzbar import pyzbar

ImageFile.LOAD_TRUNCATED_IMAGES = True
from ultralytics import YOLO


@contextlib.contextmanager
def suppress_c_stderr():
    """
    Silence C-library stderr (e.g. zbar PDF417 assertion warnings).
    Redirects file descriptor 2 to devnull for the duration of the block.
    Python's sys.stderr is unaffected — our own print/logging still works.
    """
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    old_fd = os.dup(2)
    os.dup2(devnull_fd, 2)
    os.close(devnull_fd)
    try:
        yield
    finally:
        os.dup2(old_fd, 2)
        os.close(old_fd)

# ── Config ────────────────────────────────────────────────────────────────────

_BASE        = Path(__file__).resolve().parent
IMAGES_DIR   = _BASE / "data" / "images"
RESULTS_DIR  = _BASE / "data" / "cert_results"
MODEL_PATH        = _BASE / "models" / "grading_labels_v3.pt"
CERT_MODEL_PATH   = _BASE / "models" / "cert_detector_v1.pt"
PROGRESS_F   = RESULTS_DIR / "_progress.json"
CERT_JSON    = RESULTS_DIR / "cert_numbers.json"

# Detection confidence threshold (YOLO)
YOLO_CONF_THRESHOLD = 0.75   # minimum to even attempt OCR on this crop
HIGH_CONF_THRESHOLD = 0.95   # cert_extracted — images deleted

# Label class indices for grading_labels_v3:
#   0=PSA, 1=CGC, 2=BGS, 3=TAG (ACE/TAG both use QR codes)
LABEL_CLASSES = {0, 1, 2, 3}
TAG_CLASS     = 3   # use QR code reading instead of OCR

# Cert number pattern: 8 digits (PSA) or 10 digits (CGC) — word-boundary anchored
CERT_RE = re.compile(r'\b(\d{10}|\d{8})\b')

# Crop padding fraction — adds context around the detected label
CROP_PADDING = 0.12

# Cert detector confidence threshold (Model 2)
CERT_CONF_THRESHOLD = 0.50

# ── Helpers ───────────────────────────────────────────────────────────────────

def ensure_dirs():
    for d in [
        RESULTS_DIR / "cert_extracted",
        RESULTS_DIR / "ocr_success",
        RESULTS_DIR / "verify_later",
        RESULTS_DIR / "unextractable",
    ]:
        d.mkdir(parents=True, exist_ok=True)


def load_json(p, fallback):
    return json.loads(p.read_text()) if p.exists() else fallback


def save_json(p, data):
    p.write_text(json.dumps(data, indent=2))


def preprocess_crop(img_bgr: np.ndarray) -> np.ndarray:
    """Enhance contrast and sharpness on the label crop for better OCR."""
    # Upscale if small
    h, w = img_bgr.shape[:2]
    if h < 200 or w < 200:
        scale = max(200 / h, 200 / w, 1)
        img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)),
                             interpolation=cv2.INTER_CUBIC)

    # CLAHE contrast enhancement on L channel
    lab  = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    l     = clahe.apply(l)
    img_bgr = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

    # Mild unsharp mask
    blur    = cv2.GaussianBlur(img_bgr, (0, 0), 3)
    img_bgr = cv2.addWeighted(img_bgr, 1.5, blur, -0.5, 0)

    return img_bgr


def extract_cert_from_text(texts: list[str]) -> str | None:
    """Find first 8-digit cert number across a list of OCR text strings."""
    combined = " ".join(texts)
    m = CERT_RE.search(combined)
    return m.group(1) if m else None


# ── Step 0: Barcode decode ────────────────────────────────────────────────────

def try_barcode(image_path: Path) -> str | None:
    """
    Attempt to decode a PSA cert barcode from the image.

    Trust hierarchy (to avoid I25 false positives from card-back stripe patterns):
      1. QR code containing psacard.com/cert/ URL — fully trusted, return immediately
      2. I25/CODE128 that agrees with a QR code on the same image — trusted
      3. I25/CODE128 alone (no QR) — REJECTED (too many false positives)
    """
    try:
        img = cv2.imread(str(image_path))
        if img is None:
            return None
        for scale in [1.0, 2.0, 0.5]:
            if scale != 1.0:
                h, w = img.shape[:2]
                scaled = cv2.resize(img, (int(w * scale), int(h * scale)))
            else:
                scaled = img
            with suppress_c_stderr():
                barcodes = pyzbar.decode(scaled)

            qr_cert    = None
            linear_cert = None
            for bc in barcodes:
                data = bc.data.decode("utf-8", errors="ignore")
                if bc.type == "QRCODE" and "psacard.com/cert/" in data:
                    m = CERT_RE.search(data)
                    if m:
                        return m.group(1)  # QR with URL — unambiguous
                elif bc.type in ("I25", "CODE128", "CODE39"):
                    m = CERT_RE.search(data)
                    if m:
                        linear_cert = m.group(1)
                elif bc.type == "QRCODE":
                    m = CERT_RE.search(data)
                    if m:
                        qr_cert = m.group(1)

            # Accept linear barcode only when confirmed by a QR on the same image
            if linear_cert and qr_cert and linear_cert == qr_cert:
                return linear_cert

    except Exception:
        pass
    return None


def try_qr_on_crop(crop_bgr: np.ndarray) -> str | None:
    """Try to decode a QR code from a label crop (TAG/ACE cards)."""
    try:
        for scale in [1.0, 2.0, 3.0]:
            if scale != 1.0:
                h, w  = crop_bgr.shape[:2]
                scaled = cv2.resize(crop_bgr, (int(w*scale), int(h*scale)))
            else:
                scaled = crop_bgr
            with suppress_c_stderr():
                barcodes = pyzbar.decode(scaled)
            for bc in barcodes:
                data = bc.data.decode("utf-8", errors="ignore")
                m = CERT_RE.search(data)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return None


# ── Step 1: YOLO label detection ──────────────────────────────────────────────

def detect_label_crops_batch(model: YOLO, image_paths: list[Path]) -> list[tuple[np.ndarray, float, str]]:
    """
    Run YOLO on all images for an item in a single batched call.
    Returns all detected label crops above threshold, sorted by confidence descending.
    Each entry is (cropped_label_bgr, confidence, class_name).
    """
    if not image_paths:
        return []

    try:
        results_list = model(
            [str(p) for p in image_paths],
            verbose=False,
            conf=YOLO_CONF_THRESHOLD,
        )
    except Exception:
        results_list = []
        for p in image_paths:
            try:
                results_list.append(model(str(p), verbose=False, conf=YOLO_CONF_THRESHOLD)[0])
            except Exception:
                results_list.append(None)

    if not isinstance(results_list, list):
        results_list = [results_list]

    detections = []  # (conf, crop, cls_name)

    for img_path, results in zip(image_paths, results_list):
        if results is None or results.boxes is None or len(results.boxes) == 0:
            continue

        img = None  # lazy-load once per image
        for box in results.boxes:
            cls_id = int(box.cls[0])
            conf   = float(box.conf[0])
            if cls_id not in LABEL_CLASSES:
                continue

            if img is None:
                img = cv2.imread(str(img_path))
                if img is None:
                    break

            h, w = img.shape[:2]
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            pad_x = (x2 - x1) * CROP_PADDING
            pad_y = (y2 - y1) * CROP_PADDING
            cx1 = max(0, int(x1 - pad_x))
            cy1 = max(0, int(y1 - pad_y))
            cx2 = min(w, int(x2 + pad_x))
            cy2 = min(h, int(y2 + pad_y))

            detections.append((conf, preprocess_crop(img[cy1:cy2, cx1:cx2]), results.names[cls_id], cls_id))

    detections.sort(key=lambda x: x[0], reverse=True)
    return [(crop, conf, cls_name, cls_id) for conf, crop, cls_name, cls_id in detections]


# ── Step 1b: Cert sub-region detector (Model 2) ───────────────────────────────

def extract_cert_subcrop(cert_model: YOLO, label_crop_bgr: np.ndarray) -> tuple[np.ndarray, bool]:
    """
    Run Model 2 on a label crop to find the cert number sub-region.
    Returns (subcrop, model2_found) where model2_found=True means Model 2 detected
    a cert region. Returns (original_crop, False) as fallback.
    """
    try:
        results = cert_model(label_crop_bgr, conf=CERT_CONF_THRESHOLD, verbose=False)
        if not results or not len(results[0].boxes):
            return label_crop_bgr, False

        boxes = results[0].boxes
        best  = boxes[boxes.conf.argmax()]
        h, w  = label_crop_bgr.shape[:2]
        x1, y1, x2, y2 = best.xyxy[0].cpu().numpy()

        pad_x = (x2 - x1) * 0.08
        pad_y = (y2 - y1) * 0.08
        cx1 = max(0, int(x1 - pad_x))
        cy1 = max(0, int(y1 - pad_y))
        cx2 = min(w, int(x2 + pad_x))
        cy2 = min(h, int(y2 + pad_y))

        subcrop = label_crop_bgr[cy1:cy2, cx1:cx2]
        if subcrop.size == 0:
            return label_crop_bgr, False
        return preprocess_crop(subcrop), True
    except Exception:
        return label_crop_bgr, False


# ── Step 2: OCR engines ───────────────────────────────────────────────────────

_easy_reader = None
_paddle_ocr  = None

def get_easy_reader():
    global _easy_reader
    if _easy_reader is None:
        import easyocr
        _easy_reader = easyocr.Reader(["en"], gpu=True, verbose=False)
    return _easy_reader

def get_paddle_ocr():
    global _paddle_ocr
    if _paddle_ocr is None:
        import warnings
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        from paddleocr import PaddleOCR
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            _paddle_ocr = PaddleOCR(use_textline_orientation=True, lang="en", show_log=False)
    return _paddle_ocr


def ocr_easy(crop_bgr: np.ndarray) -> list[str]:
    try:
        reader  = get_easy_reader()
        rgb     = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        results = reader.readtext(rgb, detail=0)
        return [str(r) for r in results]
    except Exception:
        return []

def ocr_paddle(crop_bgr: np.ndarray) -> list[str]:
    try:
        ocr     = get_paddle_ocr()
        result  = ocr.ocr(crop_bgr, cls=True)
        texts   = []
        if result and result[0]:
            for line in result[0]:
                if line and len(line) >= 2:
                    texts.append(str(line[1][0]))
        return texts
    except Exception:
        return []


def run_ocr_both(crop_bgr: np.ndarray) -> tuple[str | None, str | None, str]:
    """
    Run both OCR engines, return (easy_cert, paddle_cert, agreement_status).
    agreement_status: 'both' | 'easy_only' | 'paddle_only' | 'none'
    """
    with ThreadPoolExecutor(max_workers=2) as ex:
        fut_easy   = ex.submit(ocr_easy,   crop_bgr)
        fut_paddle = ex.submit(ocr_paddle, crop_bgr)
        easy_texts   = fut_easy.result()
        paddle_texts = fut_paddle.result()

    easy_cert   = extract_cert_from_text(easy_texts)
    paddle_cert = extract_cert_from_text(paddle_texts)

    if easy_cert and paddle_cert:
        status = "both" if easy_cert == paddle_cert else "disagree"
    elif easy_cert:
        status = "easy_only"
    elif paddle_cert:
        status = "paddle_only"
    else:
        status = "none"

    return easy_cert, paddle_cert, status


# ── Routing logic ─────────────────────────────────────────────────────────────

def route_result(item_id: str, cert: str | None, yolo_conf: float,
                 method: str, ocr_status: str, meta: dict,
                 image_dir: Path, progress: dict, cert_db: dict,
                 all_certs: list[str] | None = None,
                 yolo_detected: bool = False,
                 cert_region_detected: bool | None = None):
    """
    Decide which output folder this result goes to, write result JSON,
    and delete images if high-confidence.
    """
    if cert is None:
        folder = "unextractable"
        confidence = 0.0
    elif method == "barcode":
        folder = "cert_extracted"
        confidence = 1.0
    elif ocr_status == "both" and yolo_conf >= HIGH_CONF_THRESHOLD:
        folder = "cert_extracted"
        confidence = yolo_conf
    elif ocr_status in ("both", "easy_only", "paddle_only") and yolo_conf >= HIGH_CONF_THRESHOLD:
        folder = "ocr_success"
        confidence = yolo_conf
    elif cert:
        folder = "verify_later"
        confidence = yolo_conf
    else:
        folder = "unextractable"
        confidence = 0.0

    result_record = {
        "itemId":      item_id,
        "certNumber":  cert,
        "allCerts":    all_certs if all_certs and len(all_certs) > 1 else None,
        "confidence":  round(confidence, 4),
        "method":      method,
        "ocrStatus":   ocr_status,
        "folder":      folder,
        "cardId":      meta.get("cardId"),
        "cardName":    meta.get("cardName"),
        "setId":       meta.get("setId"),
        "grade":       meta.get("grade"),
        "grader":      meta.get("grader"),
        "price":       meta.get("price"),
        "soldDate":    meta.get("soldDate"),
    }

    # Write result JSON to the appropriate subfolder
    out_path = RESULTS_DIR / folder / f"{item_id}.json"
    save_json(out_path, result_record)

    # Update master cert DB
    if cert:
        cert_db[item_id] = {
            "certNumber": cert,
            "confidence": round(confidence, 4),
            "method":     method,
            "folder":     folder,
            "cardId":     meta.get("cardId"),
            "cardName":   meta.get("cardName"),
        }

    # Delete images if high confidence to save disk space
    if folder == "cert_extracted" and image_dir.exists():
        for img_file in image_dir.glob("*.jpg"):
            try:
                img_file.unlink()
            except Exception:
                pass
        # Keep _meta.json for reference; remove the folder if empty
        remaining = list(image_dir.iterdir())
        if not remaining or all(f.name == "_meta.json" for f in remaining):
            pass  # keep meta, folder stays

    if cert is not None:
        fail_stage = None
    elif not yolo_detected:
        fail_stage = "no_detection"
    elif cert_region_detected is False:
        fail_stage = "no_cert_region"
    else:
        fail_stage = "ocr_failed"

    progress[item_id] = {
        "done":               True,
        "folder":             folder,
        "certNumber":         cert,
        "confidence":         round(confidence, 4),
        "yoloConf":           round(yolo_conf, 4) if yolo_conf else 0.0,
        "failStage":          fail_stage,
    }


# ── Process one item ──────────────────────────────────────────────────────────

def process_item(item_id: str, image_dir: Path, model: YOLO, cert_model: YOLO,
                 progress: dict, cert_db: dict, verbose: bool = True):
    # Load metadata
    meta_path = image_dir / "_meta.json"
    meta = json.loads(meta_path.read_text(encoding='utf-8')) if meta_path.exists() else {}

    images = sorted(image_dir.glob("*.jpg"))
    if not images:
        progress[item_id] = {"done": True, "folder": "unextractable", "certNumber": None}
        return "unextractable"

    # ── Step 0: Barcode across all images ────────────────────────────────────
    for img_path in images:
        cert = try_barcode(img_path)
        if cert:
            route_result(item_id, cert, 1.0, "barcode", "barcode",
                         meta, image_dir, progress, cert_db,
                         yolo_detected=False, cert_region_detected=None)
            if verbose:
                print(f"    BARCODE  → {cert}")
            return "cert_extracted"

    # ── Step 1+2: YOLO (batched) + OCR on every detected crop ───────────────
    crops = detect_label_crops_batch(model, images)

    model1_detected       = len(crops) > 0
    cert_region_detected  = None   # None = not applicable (no Model 1 detection)
    best_conf             = 0.0
    best_cert             = None
    best_ocr_status       = "none"
    all_certs             = []

    for crop, conf, cls_name, cls_id in crops:
        m2_found = False
        if cert_model is not None:
            crop, m2_found = extract_cert_subcrop(cert_model, crop)
            # cert_region_detected = True if ANY crop yielded a Model 2 detection
            if m2_found:
                cert_region_detected = True
            elif cert_region_detected is None:
                cert_region_detected = False

        # TAG/ACE: try QR code first, skip OCR
        if cls_id == TAG_CLASS:
            img_cert   = try_qr_on_crop(crop)
            ocr_status = "qr" if img_cert else "none"
        else:
            easy_cert, paddle_cert, ocr_status = run_ocr_both(crop)
            img_cert = None
            if ocr_status == "both":
                img_cert = easy_cert
            elif ocr_status in ("easy_only", "paddle_only"):
                img_cert = easy_cert or paddle_cert

        if img_cert and img_cert not in all_certs:
            all_certs.append(img_cert)

        # Best = highest-conf crop that yielded a cert; fall back to highest conf
        if img_cert and (best_cert is None or conf > best_conf):
            best_conf       = conf
            best_cert       = img_cert
            best_ocr_status = ocr_status
        elif best_cert is None and conf > best_conf:
            best_conf       = conf
            best_ocr_status = ocr_status

    route_result(item_id, best_cert, best_conf, "yolo+ocr", best_ocr_status,
                 meta, image_dir, progress, cert_db, all_certs=all_certs,
                 yolo_detected=model1_detected,
                 cert_region_detected=cert_region_detected)

    folder = progress[item_id]["folder"]
    if verbose:
        cert_str  = best_cert or "none"
        extra     = f"  +{len(all_certs)-1} more cert(s)" if len(all_certs) > 1 else ""
        print(f"    {folder.upper():<16} cert={cert_str:<10} conf={best_conf:.2f}  ocr={best_ocr_status}{extra}")
    return folder


# ── Main ──────────────────────────────────────────────────────────────────────

WATCH_POLL_SECONDS = 60   # how long to wait between scans in --watch mode


def get_pending_item_ids(progress: dict) -> list[str]:
    """Return item IDs in data/images/ that haven't been processed yet."""
    if not IMAGES_DIR.exists():
        return []
    return [
        d.name for d in sorted(IMAGES_DIR.iterdir())
        if d.is_dir() and not progress.get(d.name, {}).get("done")
    ]


def print_summary(counts: dict, watch: bool = False):
    print("\n── Summary ──────────────────────────────────────────")
    print(f"  cert_extracted  : {counts.get('cert_extracted', 0):>6}  (images deleted)")
    print(f"  ocr_success     : {counts.get('ocr_success',    0):>6}  (images kept)")
    print(f"  verify_later    : {counts.get('verify_later',   0):>6}  (needs your review)")
    print(f"  unextractable   : {counts.get('unextractable',  0):>6}  (no label found)")
    if watch:
        print(f"\n  Watching for new images every {WATCH_POLL_SECONDS}s — Ctrl+C to stop.")
    else:
        print(f"\n  cert_numbers.json : {CERT_JSON}")
        print(f"  verify_later folder : {RESULTS_DIR / 'verify_later'}")
        print(f"\n  To re-process verify_later:  python extract_certs.py --recheck")
        print(f"  To watch continuously:        python extract_certs.py --watch")


def run_batch(item_ids: list[str], model, cert_model, progress: dict, cert_db: dict,
              total_label: str = "") -> dict:
    """Process a list of item IDs and return per-folder counts."""
    counts = {"cert_extracted": 0, "ocr_success": 0, "verify_later": 0, "unextractable": 0}

    for i, item_id in enumerate(item_ids):
        image_dir = IMAGES_DIR / item_id
        idx_label = f"[{i+1}/{len(item_ids)}{total_label}]"
        print(f"  {idx_label} {item_id}")

        folder = process_item(item_id, image_dir, model, cert_model, progress, cert_db)
        counts[folder] = counts.get(folder, 0) + 1

        if (i + 1) % 10 == 0:
            save_json(PROGRESS_F, progress)
            save_json(CERT_JSON,  cert_db)
            print(f"\n  ── checkpoint saved ({i+1}/{len(item_ids)}) ──\n")

    save_json(PROGRESS_F, progress)
    save_json(CERT_JSON,  cert_db)
    return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit",   type=int, default=0,
                        help="Process only first N items (0 = no limit, ignored in --watch mode)")
    parser.add_argument("--recheck", action="store_true",
                        help="Re-process items currently in verify_later/")
    parser.add_argument("--watch",   action="store_true",
                        help=f"Keep running — pick up new images every {WATCH_POLL_SECONDS}s as scrapers download them")
    args = parser.parse_args()

    if not MODEL_PATH.exists():
        print(f"\nERROR: Model not found at {MODEL_PATH}")
        print("Run train_label_detector.py first.\n")
        return

    ensure_dirs()
    progress = load_json(PROGRESS_F, {})
    cert_db  = load_json(CERT_JSON,  {})

    print(f"\n── Cert Extraction ─────────────────────────────────")
    print(f"  Model  : {MODEL_PATH.name}")
    print(f"  Output : {RESULTS_DIR}")
    if args.watch:
        print(f"  Mode   : watch (polls every {WATCH_POLL_SECONDS}s — Ctrl+C to stop)")
    print()

    print("  Loading YOLO models...")
    model = YOLO(str(MODEL_PATH))
    model.to("cuda")
    cert_model = YOLO(str(CERT_MODEL_PATH)) if CERT_MODEL_PATH.exists() else None
    if cert_model:
        cert_model.to("cuda")
        print(f"  Cert detector : {CERT_MODEL_PATH.name}")
    else:
        print(f"  Cert detector : NOT FOUND — running OCR on full label crop")

    print("  Warming up OCR engines...")
    dummy = np.zeros((100, 200, 3), dtype=np.uint8)
    ocr_easy(dummy)
    ocr_paddle(dummy)
    print("  OCR engines ready.\n")

    # ── --recheck mode ────────────────────────────────────────────────────────
    if args.recheck:
        recheck_dir = RESULTS_DIR / "verify_later"
        item_ids = [p.stem for p in recheck_dir.glob("*.json")]
        for iid in item_ids:
            progress.pop(iid, None)
        print(f"  Re-checking {len(item_ids)} items from verify_later/\n")
        counts = run_batch(item_ids, model, cert_model, progress, cert_db)
        print_summary(counts)
        return

    # ── --watch mode ──────────────────────────────────────────────────────────
    if args.watch:
        total_counts = {"cert_extracted": 0, "ocr_success": 0,
                        "verify_later": 0, "unextractable": 0}
        import time
        try:
            while True:
                item_ids = get_pending_item_ids(progress)
                if item_ids:
                    print(f"  {len(item_ids)} new item(s) to process...\n")
                    counts = run_batch(item_ids, model, cert_model, progress, cert_db)
                    for k, v in counts.items():
                        total_counts[k] = total_counts.get(k, 0) + v
                    print_summary(total_counts, watch=True)
                else:
                    done_total = sum(1 for v in progress.values() if v.get("done"))
                    print(f"  No new images yet ({done_total} already processed). "
                          f"Checking again in {WATCH_POLL_SECONDS}s...")
                time.sleep(WATCH_POLL_SECONDS)
        except KeyboardInterrupt:
            print("\n\n  Watch mode stopped.")
            print_summary(total_counts)
        return

    # ── normal one-shot mode ──────────────────────────────────────────────────
    item_ids = get_pending_item_ids(progress)
    if args.limit > 0:
        item_ids = item_ids[:args.limit]

    print(f"  Items to process : {len(item_ids)}\n")

    if not item_ids:
        print("  Nothing to do — all downloaded images already processed.\n")
        return

    counts = run_batch(item_ids, model, cert_model, progress, cert_db)
    print_summary(counts)


if __name__ == "__main__":
    main()
