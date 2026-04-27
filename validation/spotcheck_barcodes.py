"""
validation/spotcheck_barcodes.py

Picks 20 random barcode-extracted certs and produces an HTML gallery
so you can visually verify the pipeline is reading barcodes correctly.

For each item:
  - Shows the cert number the pipeline stored
  - Re-runs pyzbar on any images that still exist to confirm the read
  - Shows card name, grader, grade, price from metadata
  - Links to the eBay listing URL if available

Output: data/cert_results/spotcheck_barcodes.html

Usage:
  python validation/spotcheck_barcodes.py
  python validation/spotcheck_barcodes.py --count 30
"""

import argparse
import base64
import json
import random
from pathlib import Path

import cv2
from pyzbar import pyzbar
import contextlib
import os
import re

BASE        = Path(__file__).resolve().parent.parent
CERT_JSON   = BASE / 'data' / 'cert_results' / 'cert_numbers.json'
IMAGES_DIR  = BASE / 'data' / 'images'
OUT_HTML    = BASE / 'data' / 'cert_results' / 'spotcheck_barcodes.html'

CERT_RE = re.compile(r'\b(\d{8,13})\b')


@contextlib.contextmanager
def suppress_c_stderr():
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    old_fd = os.dup(2)
    os.dup2(devnull_fd, 2)
    os.close(devnull_fd)
    try:
        yield
    finally:
        os.dup2(old_fd, 2)
        os.close(old_fd)


def try_barcode_all_images(img_dir: Path) -> tuple[str | None, str | None]:
    """Re-run pyzbar on all images in a folder. Returns (cert, image_path_used)."""
    exts = ('.jpg', '.jpeg', '.png', '.webp')
    images = sorted(f for f in img_dir.iterdir()
                    if f.is_file() and f.suffix.lower() in exts
                    and f.name != '_meta.json')
    for img_path in images:
        try:
            img = cv2.imread(str(img_path))
            if img is None:
                continue
            for scale in [1.0, 2.0, 0.5]:
                if scale != 1.0:
                    h, w = img.shape[:2]
                    scaled = cv2.resize(img, (int(w * scale), int(h * scale)))
                else:
                    scaled = img
                with suppress_c_stderr():
                    barcodes = pyzbar.decode(scaled)
                for bc in barcodes:
                    data = bc.data.decode('utf-8', errors='ignore')
                    m = CERT_RE.search(data)
                    if m:
                        return m.group(1), str(img_path)
        except Exception:
            continue
    return None, None


def img_to_b64(path: str) -> str:
    try:
        with open(path, 'rb') as f:
            return base64.b64encode(f.read()).decode()
    except Exception:
        return ''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--count', type=int, default=20)
    parser.add_argument('--seed',  type=int, default=42)
    args = parser.parse_args()

    cert_db = json.loads(CERT_JSON.read_text(encoding='utf-8'))
    barcode_items = [(iid, v) for iid, v in cert_db.items()
                     if v.get('method') == 'barcode']

    print(f'Total barcode-extracted items: {len(barcode_items)}')

    random.seed(args.seed)
    sample = random.sample(barcode_items, min(args.count, len(barcode_items)))

    rows = []
    for idx, (iid, v) in enumerate(sample, 1):
        stored_cert = v.get('certNumber', '')
        img_dir     = IMAGES_DIR / iid

        meta = {}
        meta_path = img_dir / '_meta.json'
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
            except Exception:
                pass

        img_b64     = ''
        reverify    = None
        img_used    = None
        has_images  = False

        if img_dir.exists():
            reverify, img_used = try_barcode_all_images(img_dir)
            has_images = img_used is not None
            if img_used:
                img_b64 = img_to_b64(img_used)

        match = 'N/A'
        if reverify is not None:
            match = '✓ MATCH' if reverify == stored_cert else f'✗ MISMATCH ({reverify})'

        rows.append({
            'idx':         idx,
            'iid':         iid,
            'stored_cert': stored_cert,
            'reverify':    reverify,
            'match':       match,
            'has_images':  has_images,
            'img_b64':     img_b64,
            'card_name':   meta.get('cardName', ''),
            'grader':      meta.get('grader', ''),
            'grade':       meta.get('grade', ''),
            'price':       meta.get('price', ''),
            'sold_date':   meta.get('soldDate', ''),
            'url':         meta.get('url', ''),
            'title':       meta.get('title', ''),
        })

        status = match if has_images else 'no images'
        print(f'  [{idx:>2}] {iid}  cert={stored_cert}  {status}')

    matches    = sum(1 for r in rows if r['has_images'] and '✓' in r['match'])
    mismatches = sum(1 for r in rows if r['has_images'] and '✗' in r['match'])
    no_imgs    = sum(1 for r in rows if not r['has_images'])
    print(f'\n  Matches: {matches}  Mismatches: {mismatches}  No images: {no_imgs}')

    html = _build_html(rows, matches, mismatches, no_imgs)
    OUT_HTML.write_text(html, encoding='utf-8')
    print(f'\n  HTML: {OUT_HTML}')


def _build_html(rows, matches, mismatches, no_imgs):
    def row_html(r):
        img_tag = ''
        if r['img_b64']:
            img_tag = f'<img src="data:image/jpeg;base64,{r["img_b64"]}" style="max-width:300px;max-height:400px;border-radius:4px;">'
        else:
            img_tag = '<div style="width:200px;height:150px;background:#222;display:flex;align-items:center;justify-content:center;color:#666;border-radius:4px;">images deleted</div>'

        match_color = '#2ecc71' if '✓' in r['match'] else ('#e74c3c' if '✗' in r['match'] else '#888')
        url_link = f'<a href="{r["url"]}" target="_blank" style="color:#3498db">eBay listing</a>' if r['url'] else ''

        return f'''
<div style="display:flex;gap:20px;padding:16px;border:1px solid #333;border-radius:8px;margin-bottom:12px;background:#1a1a1a;">
  <div style="flex-shrink:0">{img_tag}</div>
  <div style="flex:1;font-family:monospace;font-size:13px;line-height:1.8;">
    <div style="font-size:15px;font-weight:bold;color:#eee">#{r["idx"]} &nbsp; {r["iid"]}</div>
    <div><span style="color:#888">Stored cert&nbsp;&nbsp;:</span> <span style="font-size:18px;color:#f1c40f;font-weight:bold">{r["stored_cert"]}</span></div>
    <div><span style="color:#888">Re-verified&nbsp;&nbsp;:</span> <span style="color:{match_color};font-weight:bold">{r["match"]}</span></div>
    <div><span style="color:#888">Card&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:</span> {r["card_name"]}</div>
    <div><span style="color:#888">Title&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:</span> <span style="color:#bbb">{r["title"][:80]}</span></div>
    <div><span style="color:#888">Grader/Grade :</span> {r["grader"]} {r["grade"]}</div>
    <div><span style="color:#888">Price/Date&nbsp;&nbsp;&nbsp;:</span> ${r["price"]} &nbsp; {r["sold_date"]}</div>
    <div>{url_link}</div>
  </div>
</div>'''

    body = '\n'.join(row_html(r) for r in rows)

    return f'''<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Barcode Spot-check</title>
<style>body{{background:#0d0d0d;color:#ddd;font-family:sans-serif;padding:24px;max-width:900px;margin:0 auto;}}</style>
</head>
<body>
<h2 style="color:#eee">Barcode Spot-check — {len(rows)} random samples</h2>
<p style="color:#888">
  Matches: <span style="color:#2ecc71;font-weight:bold">{matches}</span> &nbsp;
  Mismatches: <span style="color:#e74c3c;font-weight:bold">{mismatches}</span> &nbsp;
  No images (deleted): <span style="color:#888">{no_imgs}</span>
</p>
<hr style="border-color:#333;margin-bottom:20px">
{body}
</body>
</html>'''


if __name__ == '__main__':
    main()
