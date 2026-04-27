"""
generate_cert_browser.py

Runs 500 items through the full pipeline (Model 1 → Model 2 → OCR),
saves each cert number crop, and generates an HTML gallery to browse them.

Output: data/cert_crop_browser/
        data/cert_crop_browser/index.html  ← open this in a browser

Run:    python generate_cert_browser.py
"""

import json
import os
import random
import re
import base64
from pathlib import Path
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

BASE        = Path(__file__).resolve().parent
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
CERT_JSON   = BASE / 'data' / 'cert_results' / 'cert_numbers.json'
IMAGES_DIR  = BASE / 'data' / 'images'
OUT_DIR     = BASE / 'data' / 'cert_crop_browser'
IMG_DIR     = OUT_DIR / 'images'

MODEL_PATH      = BASE / 'models' / 'grading_labels_v3.pt'
CERT_MODEL_PATH = BASE / 'models' / 'cert_detector_v1.pt'

YOLO_CONF   = 0.75
CERT_CONF   = 0.50
SAMPLE_SIZE = 500
SEED        = 7
CERT_RE     = re.compile(r'\b(\d{8,13})\b')

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_font(size):
    try:    return ImageFont.load_default(size=size)
    except: return ImageFont.load_default()

def preprocess(img_bgr):
    h, w = img_bgr.shape[:2]
    if h < 200 or w < 200:
        scale   = max(200/h, 200/w, 1)
        img_bgr = cv2.resize(img_bgr, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_CUBIC)
    lab     = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe   = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4,4))
    img_bgr = cv2.cvtColor(cv2.merge([clahe.apply(l), a, b]), cv2.COLOR_LAB2BGR)
    blur    = cv2.GaussianBlur(img_bgr, (0,0), 3)
    return cv2.addWeighted(img_bgr, 1.5, blur, -0.5, 0)

def get_label_crop(model, img_path):
    results = model(str(img_path), conf=YOLO_CONF, verbose=False)
    if not results or not len(results[0].boxes):
        return None, 0.0
    boxes = results[0].boxes
    best  = boxes[boxes.conf.argmax()]
    conf  = float(best.conf[0])
    img   = cv2.imread(str(img_path))
    if img is None: return None, 0.0
    h, w  = img.shape[:2]
    x1,y1,x2,y2 = best.xyxy[0].cpu().numpy()
    pad_x = (x2-x1)*0.12; pad_y = (y2-y1)*0.12
    cx1=max(0,int(x1-pad_x)); cy1=max(0,int(y1-pad_y))
    cx2=min(w,int(x2+pad_x)); cy2=min(h,int(y2+pad_y))
    return preprocess(img[cy1:cy2, cx1:cx2]), conf

def get_cert_crop(cert_model, label_bgr):
    if cert_model is None: return label_bgr
    try:
        results = cert_model(label_bgr, conf=CERT_CONF, verbose=False)
        if not results or not len(results[0].boxes): return label_bgr
        boxes = results[0].boxes
        best  = boxes[boxes.conf.argmax()]
        h, w  = label_bgr.shape[:2]
        x1,y1,x2,y2 = best.xyxy[0].cpu().numpy()
        pad_x=(x2-x1)*0.08; pad_y=(y2-y1)*0.08
        cx1=max(0,int(x1-pad_x)); cy1=max(0,int(y1-pad_y))
        cx2=min(w,int(x2+pad_x)); cy2=min(h,int(y2+pad_y))
        sub = label_bgr[cy1:cy2, cx1:cx2]
        return preprocess(sub) if sub.size > 0 else label_bgr
    except: return label_bgr

def run_easy(crop_bgr):
    try:
        import easyocr
        global _easy
        if '_easy' not in globals():
            _easy = easyocr.Reader(['en'], gpu=True, verbose=False)
        rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        return [str(r) for r in _easy.readtext(rgb, detail=0)]
    except: return []

def run_paddle(crop_bgr):
    try:
        import warnings
        from paddleocr import PaddleOCR
        global _paddle
        if '_paddle' not in globals():
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                _paddle = PaddleOCR(use_textline_orientation=True, lang='en', show_log=False)
        result = _paddle.ocr(crop_bgr, cls=True)
        if result and result[0]:
            return [str(l[1][0]) for l in result[0] if l and len(l)>=2]
        return []
    except: return []

def find_cert(texts):
    combined = ' '.join(texts)
    m = CERT_RE.search(combined)
    return m.group(1) if m else None

def crop_to_png_b64(crop_bgr, cert, grader):
    """Stamp cert number on crop and return base64 PNG."""
    rgb  = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
    pil  = Image.fromarray(rgb)
    # Scale to standard display height
    dh   = 160
    dw   = max(1, int(pil.width * dh / pil.height))
    pil  = pil.resize((dw, dh), Image.LANCZOS)
    buf  = BytesIO()
    pil.save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode()

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    from ultralytics import YOLO

    OUT_DIR.mkdir(exist_ok=True)
    IMG_DIR.mkdir(exist_ok=True)

    model      = YOLO(str(MODEL_PATH))
    cert_model = YOLO(str(CERT_MODEL_PATH)) if CERT_MODEL_PATH.exists() else None
    font       = load_font(20)

    progress = json.loads(PROGRESS_F.read_text(encoding='utf-8'))
    cert_db  = json.loads(CERT_JSON.read_text(encoding='utf-8')) if CERT_JSON.exists() else {}

    # Sample mix: 60% from folders with images, 40% unextractable
    all_items = list(progress.items())
    random.seed(SEED)
    random.shuffle(all_items)
    sample = all_items[:SAMPLE_SIZE]

    print(f'Loading OCR engines...')
    dummy = np.zeros((80, 160, 3), dtype=np.uint8)
    run_easy(dummy); run_paddle(dummy)
    print(f'Running pipeline on {SAMPLE_SIZE} items...\n')

    records = []

    for i, (item_id, entry) in enumerate(sample):
        img_dir = IMAGES_DIR / item_id
        if not img_dir.exists(): continue

        imgs = sorted(f for f in img_dir.iterdir()
                      if f.suffix.lower() in ('.jpg','.jpeg','.png','.webp'))
        if not imgs: continue

        meta = {}
        try: meta = json.loads((img_dir / '_meta.json').read_text(encoding='utf-8'))
        except: pass

        grader   = meta.get('grader', '?')
        cardname = (meta.get('cardName') or item_id)[:30]
        folder   = entry.get('folder', '?')
        stored_cert = cert_db.get(item_id, {}).get('certNumber')

        try:
            label_crop, conf = get_label_crop(model, imgs[0])

            if label_crop is None:
                cert   = None
                crop   = np.zeros((80, 200, 3), dtype=np.uint8)
                status = 'no_detection'
            else:
                cert_crop = get_cert_crop(cert_model, label_crop)
                easy_t    = run_easy(cert_crop)
                paddle_t  = run_paddle(cert_crop)
                cert      = find_cert(easy_t) or find_cert(paddle_t)
                crop      = cert_crop
                status    = 'found' if cert else 'ocr_fail'

            # Save crop image
            rgb     = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            pil     = Image.fromarray(rgb)
            dh      = 160
            dw      = max(1, int(pil.width * dh / pil.height))
            pil     = pil.resize((dw, dh), Image.LANCZOS)
            fname   = f'{i:04d}_{grader}_{item_id}.jpg'
            pil.save(IMG_DIR / fname, quality=88)

            records.append({
                'fname':       fname,
                'item_id':     item_id,
                'grader':      grader,
                'cardname':    cardname,
                'cert':        cert,
                'stored_cert': stored_cert,
                'conf':        round(conf, 2),
                'folder':      folder,
                'status':      status,
            })

            status_str = f'cert={cert}' if cert else 'NO CERT'
            print(f'  {i+1:3d}/500  {grader:<4}  {conf:.0%}  {status_str:<14}  {cardname[:25]}')

        except Exception as e:
            print(f'  {i+1:3d}/500  ERROR {item_id}: {e}')
            continue

    # ── Build HTML gallery ────────────────────────────────────────────────────
    found  = sum(1 for r in records if r['cert'])
    none   = sum(1 for r in records if not r['cert'])

    cards_html = ''
    for r in records:
        cert_display = r['cert'] or 'NO CERT'
        border_color = '#3fb950' if r['cert'] else '#f85149'
        cert_color   = '#3fb950' if r['cert'] else '#f85149'
        match_warn   = ''
        if r['cert'] and r['stored_cert'] and r['cert'] != r['stored_cert']:
            match_warn = f'<div class="warn">stored: {r["stored_cert"]}</div>'

        cards_html += f'''
        <div class="card" style="border-color:{border_color}">
          <img src="images/{r["fname"]}" loading="lazy">
          <div class="cert" style="color:{cert_color}">{cert_display}</div>
          <div class="meta">{r["grader"]} · {r["conf"]:.0%}</div>
          <div class="name">{r["cardname"][:28]}</div>
          {match_warn}
        </div>'''

    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cert Crop Browser</title>
<style>
  body {{ background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:16px; }}
  h1   {{ font-size:18px; margin-bottom:4px; }}
  .stats {{ color:#8b949e; font-size:13px; margin-bottom:16px; }}
  .stats b {{ color:#3fb950; }}
  .stats .bad {{ color:#f85149; }}
  .filters {{ margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; }}
  .filters button {{ padding:6px 14px; border-radius:4px; border:1px solid #30363d;
    background:#161b22; color:#8b949e; cursor:pointer; font-size:12px; }}
  .filters button.active {{ border-color:#58a6ff; color:#58a6ff; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }}
  .card {{ background:#161b22; border:2px solid #30363d; border-radius:6px;
    padding:8px; display:flex; flex-direction:column; gap:4px; }}
  .card img {{ width:100%; height:130px; object-fit:contain; background:#050709; border-radius:3px; }}
  .cert {{ font-size:13px; font-weight:700; text-align:center; letter-spacing:.05em; }}
  .meta {{ font-size:11px; color:#8b949e; text-align:center; }}
  .name {{ font-size:11px; color:#8b949e; text-align:center; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; }}
  .warn {{ font-size:10px; color:#d29922; text-align:center; }}
  .hidden {{ display:none !important; }}
</style>
</head>
<body>
<h1>Cert Crop Browser — {len(records)} items</h1>
<div class="stats">
  <b>{found} certs found</b> &nbsp;·&nbsp;
  <span class="bad">{none} failed</span> &nbsp;·&nbsp;
  {found/max(len(records),1)*100:.0f}% success rate
</div>
<div class="filters">
  <button class="active" onclick="filter('all',this)">All ({len(records)})</button>
  <button onclick="filter('found',this)">Found ({found})</button>
  <button onclick="filter('fail',this)">Failed ({none})</button>
</div>
<div class="grid" id="grid">
{cards_html}
</div>
<script>
function filter(type, btn) {{
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.card').forEach(card => {{
    const cert  = card.querySelector('.cert').textContent;
    const found = cert !== 'NO CERT';
    if (type === 'all')   card.classList.remove('hidden');
    if (type === 'found') card.classList.toggle('hidden', !found);
    if (type === 'fail')  card.classList.toggle('hidden', found);
  }});
}}
</script>
</body>
</html>'''

    html_path = OUT_DIR / 'index.html'
    html_path.write_text(html, encoding='utf-8')

    print(f'\n{"="*50}')
    print(f'  Done.  {found}/{len(records)} certs found  ({found/max(len(records),1)*100:.0f}%)')
    print(f'  Gallery: {html_path}')
    print(f'  Open index.html in your browser to browse\n')


if __name__ == '__main__':
    main()
