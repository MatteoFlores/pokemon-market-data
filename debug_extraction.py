"""
debug_extraction.py

Samples 50 unextractable items, runs YOLO, and saves side-by-side debug images:
  LEFT  — original photo with detection box drawn on it
  RIGHT — the crop that gets sent to OCR

Output: data/debug_extractions/
Run:    python debug_extraction.py
"""

import json
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

BASE        = Path(__file__).resolve().parent
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
IMAGES_DIR  = BASE / 'data' / 'images'
OUTPUT_DIR  = BASE / 'data' / 'debug_extractions'
MODEL_PATH  = BASE / 'models' / 'grading_labels_v3.pt'

CONF        = 0.25   # low threshold so we see whatever the model finds
SAMPLE_SIZE = 50
SEED        = 99
MAX_W       = 700    # max display width for the left panel
FONT_SIZE   = 28     # label text size on debug images

def load_font(size):
    try:
        return ImageFont.load_default(size=size)   # Pillow 10+
    except TypeError:
        return ImageFont.load_default()


def main():
    from ultralytics import YOLO

    OUTPUT_DIR.mkdir(exist_ok=True)

    font  = load_font(FONT_SIZE)
    model = YOLO(str(MODEL_PATH))
    progress = json.loads(PROGRESS_F.read_text(encoding='utf-8'))

    unextractable = [(iid, e) for iid, e in progress.items()
                     if e.get('folder') == 'unextractable']

    print(f'\nTotal unextractable: {len(unextractable)}')
    print(f'Sampling {SAMPLE_SIZE}...\n')

    random.seed(SEED)
    sample = random.sample(unextractable, min(SAMPLE_SIZE, len(unextractable)))

    done = 0
    for i, (itemId, _entry) in enumerate(sample):
        img_dir = IMAGES_DIR / itemId
        if not img_dir.exists():
            continue

        imgs = sorted(f for f in img_dir.iterdir()
                      if f.suffix.lower() in ('.jpg', '.jpeg', '.png', '.webp'))
        if not imgs:
            continue

        img_path = imgs[0]

        try:
            pil = Image.open(img_path).convert('RGB')
            W, H = pil.size

            # ── Run YOLO ──────────────────────────────────────────────────────
            results  = model(str(img_path), conf=CONF, verbose=False)
            detected = False
            crop_pil = None
            label    = 'NO DETECTION'

            if results and len(results[0].boxes):
                boxes    = results[0].boxes
                best     = boxes[boxes.conf.argmax()]
                x1, y1, x2, y2 = [int(v) for v in best.xyxy[0].tolist()]
                conf_val = float(best.conf[0])
                cls_name = results[0].names[int(best.cls[0])]
                detected = True
                label    = f'{cls_name}  {conf_val:.0%}'

                # Crop (with small padding)
                pad  = 8
                cx1  = max(0, x1 - pad)
                cy1  = max(0, y1 - pad)
                cx2  = min(W, x2 + pad)
                cy2  = min(H, y2 + pad)
                crop_pil = pil.crop((cx1, cy1, cx2, cy2))

                # Draw box on a copy
                annotated = pil.copy()
                draw = ImageDraw.Draw(annotated)
                lw = max(3, W // 200)
                draw.rectangle([x1, y1, x2, y2], outline='#00ff00', width=lw)
                # Large label bar above box
                bar_h = FONT_SIZE + 12
                bar_y = max(0, y1 - bar_h)
                bar_w = len(label) * (FONT_SIZE // 2) + 20
                draw.rectangle([x1, bar_y, x1 + bar_w, y1], fill='#00ff00')
                draw.text((x1 + 6, bar_y + 4), label, fill='#000000', font=font)
                # Also stamp conf in top-left corner of full image
                draw.rectangle([0, 0, bar_w + 20, bar_h + 8], fill='#000000')
                draw.text((8, 4), label, fill='#00ff00', font=font)
                pil = annotated
            else:
                # No detection — draw a red border so it's obvious
                draw = ImageDraw.Draw(pil)
                lw = max(4, W // 150)
                draw.rectangle([lw, lw, W - lw, H - lw], outline='#ff0000', width=lw)
                no_det_w = len('NO DETECTION') * (FONT_SIZE // 2) + 20
                draw.rectangle([0, 0, no_det_w, FONT_SIZE + 16], fill='#000000')
                draw.text((8, 4), 'NO DETECTION', fill='#ff0000', font=font)

            # ── Load meta ─────────────────────────────────────────────────────
            meta = {}
            try:
                meta = json.loads((img_dir / '_meta.json').read_text(encoding='utf-8'))
            except Exception:
                pass

            grader   = meta.get('grader', '?')
            cardname = (meta.get('cardName') or itemId)[:25].replace('/', '-')

            # ── Resize left panel ─────────────────────────────────────────────
            scale = min(1.0, MAX_W / W)
            lw_px = int(W * scale)
            lh_px = int(H * scale)
            left  = pil.resize((lw_px, lh_px), Image.LANCZOS)

            # ── Build combined image ──────────────────────────────────────────
            if crop_pil:
                # Scale crop to same height as left panel
                cr_h  = lh_px
                cr_w  = max(1, int(crop_pil.width * cr_h / crop_pil.height))
                right = crop_pil.resize((cr_w, cr_h), Image.LANCZOS)
                gap   = 6
                combined = Image.new('RGB', (lw_px + gap + cr_w, lh_px), (20, 20, 20))
                combined.paste(left,  (0, 0))
                combined.paste(right, (lw_px + gap, 0))
            else:
                combined = left

            # ── Save ─────────────────────────────────────────────────────────
            fname = f'{done+1:02d}_{grader}_{cardname}_{itemId}.jpg'
            combined.save(OUTPUT_DIR / fname, quality=88)
            conf_str = f'{conf_val:.0%}' if detected else 'NONE'
            print(f'  {done+1:2d}/50  {grader:<4}  {conf_str:<6}  {label:<20}  {cardname}')
            done += 1

        except Exception as e:
            print(f'  Error {itemId}: {e}')
            continue

    print(f'\nDone. {done} images saved to:')
    print(f'  {OUTPUT_DIR}')
    print('\nLook for:')
    print('  GREEN box on card face (not label) → model still detecting wrong region')
    print('  GREEN box on label strip at top    → model correct, OCR is the problem')
    print('  RED border / no detection          → model found nothing\n')

if __name__ == '__main__':
    main()
