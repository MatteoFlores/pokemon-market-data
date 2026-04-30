"""
redownload_images.py

Re-downloads listing images for items that have _meta.json with stored
imageUrls but no .jpg images on disk (e.g. after the barcode false-positive
purge deleted images for cert_extracted items).

Usage:
  python redownload_images.py           # dry run — shows what would download
  python redownload_images.py --apply   # actually download
  python redownload_images.py --apply --limit 200  # test on first 200 items
"""

import argparse
import json
import time
import urllib.request
from collections import Counter
from pathlib import Path

BASE       = Path(__file__).resolve().parent
IMAGES_DIR = BASE / "data" / "images"
PROGRESS_F = BASE / "data" / "cert_results" / "_progress.json"

MAX_IMAGES_PER_ITEM = 8   # match extract_certs.py cap
REQUEST_DELAY       = 0.3 # seconds between requests — polite to eBay CDN
TIMEOUT             = 15  # seconds per image fetch


def find_redownloadable():
    """Return list of (item_id, image_urls) for items needing re-download."""
    progress = json.loads(PROGRESS_F.read_text(encoding="utf-8"))
    targets = []

    for item_dir in sorted(IMAGES_DIR.iterdir()):
        if not item_dir.is_dir():
            continue
        item_id   = item_dir.name
        meta_path = item_dir / "_meta.json"
        if not meta_path.exists():
            continue

        # Already has images — skip
        if list(item_dir.glob("*.jpg")):
            continue

        meta = json.loads(meta_path.read_text(encoding="utf-8", errors="replace"))
        urls = meta.get("imageUrls") or []
        if not urls:
            continue

        targets.append((item_id, urls))

    return targets


def download_images(item_id: str, urls: list[str], item_dir: Path, dry: bool) -> tuple[int, int]:
    """Download up to MAX_IMAGES_PER_ITEM images. Returns (saved, failed)."""
    saved = failed = 0
    for i, url in enumerate(urls[:MAX_IMAGES_PER_ITEM]):
        dest = item_dir / f"{i+1}.jpg"
        if dry:
            saved += 1
            continue
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read()
            if len(data) < 1000:  # skip tiny error responses
                failed += 1
                continue
            dest.write_bytes(data)
            saved += 1
            time.sleep(REQUEST_DELAY)
        except Exception as e:
            failed += 1
    return saved, failed


def clear_progress_for(item_ids: list[str], progress: dict):
    """Remove progress entries so extract_certs.py will re-process these items."""
    cleared = 0
    for iid in item_ids:
        if iid in progress:
            del progress[iid]
            cleared += 1
    return cleared


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true",
                        help="Actually download images (default: dry run)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Cap number of items to process")
    args = parser.parse_args()

    dry = not args.apply
    if dry:
        print("DRY RUN — pass --apply to actually download\n")

    targets = find_redownloadable()
    if args.limit:
        targets = targets[:args.limit]

    print(f"Items with stored imageUrls but no images: {len(targets)}")
    if not targets:
        print("Nothing to re-download.")
        return

    if dry:
        total_urls = sum(min(len(u), MAX_IMAGES_PER_ITEM) for _, u in targets)
        print(f"Would download up to {total_urls} images across {len(targets)} items")
        print("\nFirst 10 items:")
        for item_id, urls in targets[:10]:
            print(f"  {item_id}  ({min(len(urls), MAX_IMAGES_PER_ITEM)} images)")
        print("\nRe-run with --apply to download.")
        return

    # Apply — resumes automatically if interrupted (find_redownloadable skips
    # items that already have .jpg files on disk)
    progress   = json.loads(PROGRESS_F.read_text(encoding="utf-8"))
    results    = Counter()
    failed_ids = []

    for i, (item_id, urls) in enumerate(targets, 1):
        item_dir = IMAGES_DIR / item_id
        saved, failed = download_images(item_id, urls, item_dir, dry=False)

        if saved > 0:
            results["items_recovered"] += 1
            results["images_saved"]    += saved
            results["images_failed"]   += failed
            # Clear progress immediately so a mid-run --recheck can start early
            if item_id in progress:
                del progress[item_id]
        else:
            results["items_failed"] += 1
            failed_ids.append(item_id)

        if i % 50 == 0 or i == len(targets):
            PROGRESS_F.write_text(json.dumps(progress, indent=2))
            print(f"  [{i}/{len(targets)}]  recovered={results['items_recovered']}  "
                  f"images={results['images_saved']}  failed_items={results['items_failed']}")

    PROGRESS_F.write_text(json.dumps(progress, indent=2))
    print(f"\nDone.")
    print(f"  Items recovered  : {results['items_recovered']}")
    print(f"  Images saved     : {results['images_saved']}")
    print(f"  Items failed     : {results['items_failed']}")
    if failed_ids:
        print(f"\n  {len(failed_ids)} items had all images fail (CDN links expired).")
    print(f"\nNext: python extract_certs.py --recheck")


if __name__ == "__main__":
    main()
