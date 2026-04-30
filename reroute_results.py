"""
reroute_results.py

Re-applies the updated routing logic to already-processed result JSONs
without re-running OCR or YOLO. Reads existing result files, applies new
rules, moves files between folders, and updates progress + cert_numbers.json.

New routing vs old:
  - CGC filter: cert > 11 digits or starts with "1401" → verify_later
  - Lowered threshold: cert + yolo_conf >= 0.75 → ocr_success (was 0.95)

Usage:
  python reroute_results.py          # dry run — shows what would move
  python reroute_results.py --apply  # apply changes
"""

import argparse
import json
import shutil
from collections import Counter
from pathlib import Path

BASE        = Path(__file__).resolve().parent
RESULTS_DIR = BASE / "data" / "cert_results"
PROGRESS_F  = RESULTS_DIR / "_progress.json"
CERT_JSON   = RESULTS_DIR / "cert_numbers.json"

YOLO_CONF_THRESHOLD = 0.75
HIGH_CONF_THRESHOLD = 0.95

FOLDERS = ["cert_extracted", "ocr_success", "verify_later", "unextractable"]


def new_folder(cert, confidence, method, ocr_status):
    if cert is None:
        return "unextractable"
    if method == "barcode":
        return "cert_extracted"
    if len(cert) > 11 or cert.startswith("1401"):
        return "verify_later"
    if ocr_status == "both" and confidence >= HIGH_CONF_THRESHOLD:
        return "cert_extracted"
    if confidence >= YOLO_CONF_THRESHOLD:
        return "ocr_success"
    if cert:
        return "verify_later"
    return "unextractable"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="Actually move files (default: dry run)")
    args = parser.parse_args()

    dry = not args.apply
    if dry:
        print("DRY RUN — pass --apply to commit changes\n")

    progress  = json.loads(PROGRESS_F.read_text(encoding="utf-8"))
    cert_db   = json.loads(CERT_JSON.read_text(encoding="utf-8")) if CERT_JSON.exists() else {}

    moves    = Counter()   # (old_folder, new_folder) → count
    affected = []

    for folder in FOLDERS:
        folder_dir = RESULTS_DIR / folder
        if not folder_dir.exists():
            continue
        for result_path in folder_dir.glob("*.json"):
            item_id = result_path.stem
            try:
                rec = json.loads(result_path.read_text(encoding="utf-8"))
            except Exception:
                continue

            cert       = rec.get("certNumber")
            confidence = rec.get("confidence", 0.0)
            method     = rec.get("method", "")
            ocr_status = rec.get("ocrStatus", "none")

            target = new_folder(cert, confidence, method, ocr_status)

            if target != folder:
                moves[(folder, target)] += 1
                affected.append((item_id, folder, target, result_path, rec))

    print(f"Items to move: {sum(moves.values())}")
    for (src, dst), n in sorted(moves.items(), key=lambda x: -x[1]):
        print(f"  {src:<18} → {dst:<18}  ({n})")

    if dry:
        print("\nRe-run with --apply to commit.")
        return

    print("\nApplying...")
    for item_id, old_folder, target_folder, result_path, rec in affected:
        dest_dir  = RESULTS_DIR / target_folder
        dest_dir.mkdir(exist_ok=True)
        dest_path = dest_dir / result_path.name

        rec["folder"] = target_folder
        dest_path.write_text(json.dumps(rec, indent=2))
        result_path.unlink()

        # Update progress
        if item_id in progress:
            progress[item_id]["folder"] = target_folder

        # Update cert_db
        if item_id in cert_db:
            cert_db[item_id]["folder"] = target_folder

    PROGRESS_F.write_text(json.dumps(progress, indent=2))
    CERT_JSON.write_text(json.dumps(cert_db, indent=2))

    # Final counts
    print("\nNew folder counts:")
    for folder in FOLDERS:
        count = sum(1 for _ in (RESULTS_DIR / folder).glob("*.json"))
        print(f"  {folder:<18} : {count}")


if __name__ == "__main__":
    main()
