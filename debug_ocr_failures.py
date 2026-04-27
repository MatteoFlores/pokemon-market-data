"""
debug_ocr_failures.py

Investigates two OCR failure modes:
  1. HIGH_CONF_NO_CERT  — YOLO found a label (≥0.75) but OCR read nothing
  2. REPEATED_CERT      — same cert number appearing on many different listings (misread)

For each sampled item saves a 3-panel debug image:
  LEFT   — original photo with detection box
  MIDDLE — the crop sent to OCR
  RIGHT  — text panel: what EasyOCR and PaddleOCR actually read

Output: data/debug_ocr/
Run:    python debug_ocr_failures.py
"""

import json
import re
import os
import random
from collections import Counter
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import cv2
import numpy as np

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

BASE        = Path(__file__).resolve().parent
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
CERT_JSON   = BASE / 'data' / 'cert_results' / 'cert_numbers.json'
IMAGES_DIR  = BASE / 'data' / 'images'
OUTPUT_DIR  = BASE / 'data' / 'debug_ocr'
MODEL_PATH  = BASE / 'models' / 'grading_labels_v3.pt'

YOLO_CONF   = 0.75
SAMPLE_SIZE = 30    # per category
SEED        = 42
FONT_SIZE   = 20
REPEATED_MIN = 4   # flag cert numbers appearing this many times or more

CERT_RE = re.compile(r'\b(\d{8,13})\b')

# ── Font ──────────────────────────────────────────────────────────────────────

def load_font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()

# ── OCR ───────────────────────────────────────────────────────────────────────

_easy_reader = None
_paddle_ocr  = None

def get_easy():
    global _easy_reader
    if _easy_reader is None:
        import easyocr
        _easy_reader = easyocr.Reader(['en'], gpu=True, verbose=False)
    return _easy_reader

def get_paddle():
    global _paddle_ocr
    if _paddle_ocr is None:
        import warnings
        from paddleocr import PaddleOCR
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            _paddle_ocr = PaddleOCR(use_textline_orientation=True, lang='en', show_log=False)
    return _paddle_ocr

def run_easy(crop_bgr):
    try:
        rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        return [str(r) for r in get_easy().readtext(rgb, detail=0)]
    except Exception:
        return []

def run_paddle(crop_bgr):
    try:
        result = get_paddle().ocr(crop_bgr, cls=True)
        if result and result[0]:
            return [str(line[1][0]) for line in result[0] if line and len(line) >= 2]
        return []
    except Exception:
        return []

def preprocess(img_bgr):
    h, w = img_bgr.shape[:2]
    if h < 200 or w < 200:
        scale = max(200/h, 200/w, 1)
        img_bgr = cv2.resize(img_bgr, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4,4))
    img_bgr = cv2.cvtColor(cv2.merge([clahe.apply(l), a, b]), cv2.COLOR_LAB2BGR)
    blur = cv2.GaussianBlur(img_bgr, (0,0), 3)
    return cv2.addWeighted(img_bgr, 1.5, blur, -0.5, 0)

# ── YOLO crop ─────────────────────────────────────────────────────────────────

def get_best_crop(model, img_path):
    """Returns (crop_bgr, conf, cls_name, box_pil_coords) or (None, 0, '', None)."""
    results = model(str(img_path), conf=YOLO_CONF, verbose=False)
    if not results or not len(results[0].boxes):
        return None, 0.0, '', None

    boxes = results[0].boxes
    best  = boxes[boxes.conf.argmax()]
    conf  = float(best.conf[0])
    cls   = results[0].names[int(best.cls[0])]

    img = cv2.imread(str(img_path))
    if img is None:
        return None, 0.0, '', None

    h, w = img.shape[:2]
    x1, y1, x2, y2 = best.xyxy[0].cpu().numpy()
    pad_x = (x2-x1) * 0.12
    pad_y = (y2-y1) * 0.12
    cx1 = max(0, int(x1-pad_x)); cy1 = max(0, int(y1-pad_y))
    cx2 = min(w, int(x2+pad_x)); cy2 = min(h, int(y2+pad_y))

    crop = preprocess(img[cy1:cy2, cx1:cx2])
    box_norm = (x1/w, y1/h, x2/w, y2/h)
    return crop, conf, cls, box_norm

# ── Image builder ─────────────────────────────────────────────────────────────

def make_debug_image(img_path, crop_bgr, conf, cls_name, box_norm,
                     easy_texts, paddle_texts, label, font):
    pil = Image.open(img_path).convert('RGB')
    W, H = pil.size

    # Left panel — annotated original
    ann = pil.copy()
    draw = ImageDraw.Draw(ann)
    if box_norm:
        x1,y1,x2,y2 = box_norm
        px1,py1,px2,py2 = int(x1*W), int(y1*H), int(x2*W), int(y2*H)
        lw = max(3, W//200)
        draw.rectangle([px1,py1,px2,py2], outline='#00ff00', width=lw)
        bar_h = FONT_SIZE + 10
        bar_y = max(0, py1 - bar_h)
        tag   = f'{cls_name}  {conf:.0%}'
        bar_w = len(tag) * (FONT_SIZE//2) + 20
        draw.rectangle([px1, bar_y, px1+bar_w, py1], fill='#00ff00')
        draw.text((px1+6, bar_y+4), tag, fill='#000000', font=font)
    else:
        lw = max(4, W//150)
        draw.rectangle([lw,lw,W-lw,H-lw], outline='#ff0000', width=lw)
        draw.text((8,4), 'NO DETECTION', fill='#ff0000', font=font)

    # Scale left panel to max 600px wide
    scale  = min(1.0, 600/W)
    lw_px  = int(W*scale); lh_px = int(H*scale)
    left   = ann.resize((lw_px, lh_px), Image.LANCZOS)

    # Middle panel — crop
    if crop_bgr is not None:
        crop_pil = Image.fromarray(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB))
        cr_h = lh_px
        cr_w = max(1, int(crop_pil.width * cr_h / crop_pil.height))
        mid  = crop_pil.resize((cr_w, cr_h), Image.LANCZOS)
    else:
        mid = Image.new('RGB', (200, lh_px), (40, 0, 0))
        ImageDraw.Draw(mid).text((10,10), 'NO CROP', fill='#ff4444', font=font)

    # Right panel — OCR text
    TEXT_W = 340
    right  = Image.new('RGB', (TEXT_W, lh_px), (13, 17, 23))
    td     = ImageDraw.Draw(right)

    def wrap(texts, max_w=TEXT_W-20):
        lines = []
        for t in texts:
            if not t.strip():
                continue
            # highlight 8-digit cert candidates in yellow
            lines.append(t)
        return lines

    y_cur = 8
    td.text((8, y_cur), 'EasyOCR:', fill='#58a6ff', font=font); y_cur += FONT_SIZE+4
    easy_lines = wrap(easy_texts) if easy_texts else ['(nothing)']
    for line in easy_lines:
        color = '#ffea00' if CERT_RE.search(line) else '#e6edf3'
        td.text((8, y_cur), line[:38], fill=color, font=font)
        y_cur += FONT_SIZE + 2
        if y_cur > lh_px - FONT_SIZE*4:
            break

    y_cur += 10
    td.text((8, y_cur), 'PaddleOCR:', fill='#d29922', font=font); y_cur += FONT_SIZE+4
    paddle_lines = wrap(paddle_texts) if paddle_texts else ['(nothing)']
    for line in paddle_lines:
        color = '#ffea00' if CERT_RE.search(line) else '#e6edf3'
        td.text((8, y_cur), line[:38], fill=color, font=font)
        y_cur += FONT_SIZE + 2
        if y_cur > lh_px - FONT_SIZE*2:
            break

    # Label at bottom
    td.text((8, lh_px - FONT_SIZE - 8), label[:40], fill='#8b949e', font=font)

    gap = 6
    total_w = lw_px + gap + mid.width + gap + TEXT_W
    combined = Image.new('RGB', (total_w, lh_px), (20, 20, 20))
    combined.paste(left, (0, 0))
    combined.paste(mid,  (lw_px + gap, 0))
    combined.paste(right,(lw_px + gap + mid.width + gap, 0))
    return combined

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    from ultralytics import YOLO

    OUTPUT_DIR.mkdir(exist_ok=True)
    font  = load_font(FONT_SIZE)
    model = YOLO(str(MODEL_PATH))

    progress  = json.loads(PROGRESS_F.read_text(encoding='utf-8'))
    cert_db   = json.loads(CERT_JSON.read_text(encoding='utf-8')) if CERT_JSON.exists() else {}

    # ── Category 1: unextractable items ──────────────────────────────────────
    unextractable = [iid for iid, e in progress.items()
                     if e.get('folder') == 'unextractable']

    # ── Category 2: repeated cert numbers ────────────────────────────────────
    cert_counts = Counter(v['certNumber'] for v in cert_db.values() if v.get('certNumber'))
    repeated    = {c for c, n in cert_counts.items() if n >= REPEATED_MIN}
    repeated_ids = [iid for iid, v in cert_db.items()
                    if v.get('certNumber') in repeated]

    print(f'\nUnextractable : {len(unextractable)}')
    print(f'Repeated certs: {len(repeated)} cert numbers  ({len(repeated_ids)} items)')
    if repeated:
        top = cert_counts.most_common(8)
        print('  Top repeated:')
        for cert, n in top:
            if cert in repeated:
                print(f'    {cert}  ×{n}')

    print(f'\nSampling {SAMPLE_SIZE} from each category...\n')

    random.seed(SEED)
    sample_unext = random.sample(unextractable,  min(SAMPLE_SIZE, len(unextractable)))
    sample_rep   = random.sample(repeated_ids,   min(SAMPLE_SIZE, len(repeated_ids)))

    print('Loading OCR engines...')
    dummy = np.zeros((100, 200, 3), dtype=np.uint8)
    run_easy(dummy); run_paddle(dummy)
    print('Ready.\n')

    def process_batch(items, prefix, category):
        done = 0
        for item_id in items:
            img_dir = IMAGES_DIR / item_id
            if not img_dir.exists():
                continue
            imgs = sorted(f for f in img_dir.iterdir()
                          if f.suffix.lower() in ('.jpg','.jpeg','.png','.webp'))
            if not imgs:
                continue

            img_path = imgs[0]
            meta = {}
            try:
                meta = json.loads((img_dir / '_meta.json').read_text(encoding='utf-8'))
            except Exception:
                pass

            grader   = meta.get('grader', '?')
            cardname = (meta.get('cardName') or item_id)[:20].replace('/', '-')

            try:
                crop_bgr, conf, cls_name, box_norm = get_best_crop(model, img_path)

                easy_texts   = run_easy(crop_bgr)   if crop_bgr is not None else []
                paddle_texts = run_paddle(crop_bgr) if crop_bgr is not None else []

                easy_cert   = next((m.group(1) for t in easy_texts   for m in [CERT_RE.search(t)] if m), None)
                paddle_cert = next((m.group(1) for t in paddle_texts for m in [CERT_RE.search(t)] if m), None)

                cert_str  = easy_cert or paddle_cert or 'NONE'
                conf_str  = f'{conf:.0%}' if conf else 'NO DET'
                label_tag = f'{grader}  {conf_str}  cert={cert_str}'

                img = make_debug_image(img_path, crop_bgr, conf, cls_name, box_norm,
                                       easy_texts, paddle_texts, label_tag, font)

                fname = f'{prefix}{done+1:02d}_{grader}_{cardname}_{item_id}.jpg'
                img.save(OUTPUT_DIR / fname, quality=88)

                easy_short   = ' | '.join(easy_texts[:3])[:60]   or '(none)'
                paddle_short = ' | '.join(paddle_texts[:3])[:60] or '(none)'
                print(f'  {prefix}{done+1:2d}  {grader:<4}  {conf_str:<6}  cert={cert_str:<10}')
                print(f'       easy:   {easy_short}')
                print(f'       paddle: {paddle_short}')
                done += 1

            except Exception as e:
                print(f'  Error {item_id}: {e}')

        print(f'\n  → {done} images saved  ({category})\n')

    print('═' * 60)
    print('  Category 1: UNEXTRACTABLE (model found label, OCR failed)')
    print('═' * 60)
    process_batch(sample_unext, 'U', 'unextractable')

    print('═' * 60)
    print('  Category 2: REPEATED CERT NUMBERS (likely misreads)')
    print('═' * 60)
    process_batch(sample_rep, 'R', 'repeated certs')

    print(f'Done. All images saved to:')
    print(f'  {OUTPUT_DIR}')
    print('\nU## = unextractable cases  |  R## = repeated cert cases')
    print('Yellow text in right panel = 8-digit number OCR found\n')

if __name__ == '__main__':
    main()
