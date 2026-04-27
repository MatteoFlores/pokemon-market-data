"""
eval/measure_accuracy.py

Evaluates the current extraction pipeline against a hand-labeled test set.
Produces: extraction rate, exact-match accuracy, per-digit accuracy,
          confusion matrix (which digit pairs get confused).

Requirements:
  data/labeled_test_set.json  (produced by validation/label_certs.js)

Usage:
  python eval/measure_accuracy.py
  python eval/measure_accuracy.py --show-failures
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

BASE        = Path(__file__).resolve().parent.parent
LABELED_F   = BASE / 'data' / 'labeled_test_set.json'
CERT_MODEL  = BASE / 'models' / 'cert_detector_v1.pt'
MODEL_PATH  = BASE / 'models' / 'grading_labels_v3.pt'
IMAGES_DIR  = BASE / 'data' / 'images'
CONF_THRESH = 0.75
CERT_CONF   = 0.50
CERT_RE     = re.compile(r'\b(\d{8,13})\b')


# ── Metric helpers ─────────────────────────────────────────────────────────────

def digit_accuracy(pred: str, true: str) -> float:
    """Character-level accuracy for two strings of equal length."""
    if not pred or not true:
        return 0.0
    length = max(len(pred), len(true))
    matches = sum(a == b for a, b in zip(pred.zfill(length), true.zfill(length)))
    return matches / length


def digit_confusion(pred: str, true: str) -> list[tuple[str, str]]:
    """Return (true_digit, pred_digit) pairs for mismatches."""
    length = max(len(pred), len(true))
    p = pred.zfill(length)
    t = true.zfill(length)
    return [(t[i], p[i]) for i in range(length) if t[i] != p[i]]


# ── Pipeline runner ────────────────────────────────────────────────────────────

def run_pipeline_on_crop(crop_path: str, model1, model2):
    """
    Run the current extraction pipeline on a pre-generated crop.
    Mirrors production: EasyOCR + PaddleOCR in parallel.
    Returns the extracted cert string or None.
    """
    import cv2
    import numpy as np

    img = cv2.imread(crop_path)
    if img is None:
        return None

    try:
        # Lazy-load OCR engines
        if not hasattr(run_pipeline_on_crop, '_easy'):
            import easyocr
            run_pipeline_on_crop._easy = easyocr.Reader(['en'], gpu=True, verbose=False)
        if not hasattr(run_pipeline_on_crop, '_paddle'):
            import warnings, os
            os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
            from paddleocr import PaddleOCR
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                run_pipeline_on_crop._paddle = PaddleOCR(use_textline_orientation=True, lang='en')

        easy   = run_pipeline_on_crop._easy
        paddle = run_pipeline_on_crop._paddle

        # The saved crop is already the cert region — OCR directly
        cert_crop = img

        try:
            rgb = cv2.cvtColor(cert_crop, cv2.COLOR_BGR2RGB)
            easy_texts = [str(t) for t in easy.readtext(rgb, detail=0)]
        except Exception:
            easy_texts = []

        try:
            r = paddle.ocr(cert_crop, cls=True)
            paddle_texts = [str(line[1][0]) for line in (r[0] or []) if line and len(line) >= 2]
        except Exception:
            paddle_texts = []

        for texts in [easy_texts + paddle_texts, easy_texts, paddle_texts]:
            m = CERT_RE.search(' '.join(texts))
            if m:
                return m.group(1)

    except Exception:
        pass
    return None


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--show-failures', action='store_true',
                        help='Print each failure case')
    parser.add_argument('--no-rerun', action='store_true',
                        help='Skip pipeline re-run; compare pipelineCert vs trueCert only')
    args = parser.parse_args()

    if not LABELED_F.exists():
        print(f'ERROR: {LABELED_F} not found.')
        print('Run: node validation/label_certs.js  and label at least 50 images first.')
        sys.exit(1)

    labeled = json.loads(LABELED_F.read_text(encoding='utf-8'))
    # Only use non-skipped entries
    test_set = {k: v for k, v in labeled.items() if not v.get('skipped') and v.get('trueCert')}

    print(f'Labeled test set   : {len(labeled)} total')
    print(f'  Skipped (human)  : {sum(1 for v in labeled.values() if v.get("skipped"))}')
    print(f'  Labeled (usable) : {len(test_set)}')

    if not test_set:
        print('\nNo usable labels yet. Label more images first.')
        sys.exit(0)

    model2 = None
    if not args.no_rerun:
        print('\nLoading models...')
        try:
            from ultralytics import YOLO
            model2 = YOLO(str(CERT_MODEL)) if CERT_MODEL.exists() else None
            if model2:
                print(f'  Model 2 loaded: {CERT_MODEL.name}')
        except Exception as e:
            print(f'  Model load failed: {e}')

    results = []
    print(f'\nRunning on {len(test_set)} labeled crops...\n')

    for name, item in test_set.items():
        true_cert = item['trueCert']
        img_path  = item['imagePath']

        if args.no_rerun:
            pred_cert = item.get('pipelineCert')
        else:
            pred_cert = run_pipeline_on_crop(img_path, None, model2)

        results.append({
            'name':      name,
            'itemId':    item['itemId'],
            'grader':    item.get('grader', '?'),
            'true':      true_cert,
            'pred':      pred_cert,
            'extracted': pred_cert is not None,
            'exact':     pred_cert == true_cert,
            'da':        digit_accuracy(pred_cert or '', true_cert) if pred_cert else 0.0,
        })

    # ── Metrics ────────────────────────────────────────────────────────────────
    n             = len(results)
    extracted     = sum(1 for r in results if r['extracted'])
    exact_matches = sum(1 for r in results if r['exact'])
    extraction_rate = extracted / n * 100
    exact_rate      = exact_matches / n * 100
    exact_when_ext  = exact_matches / extracted * 100 if extracted else 0.0
    avg_da          = sum(r['da'] for r in results) / n * 100

    print('=' * 56)
    print('  Evaluation Results')
    print('=' * 56)
    print(f'  Test set size      : {n}')
    print(f'  Extraction rate    : {extraction_rate:.1f}%  ({extracted}/{n})')
    print(f'  Exact match (all)  : {exact_rate:.1f}%  ({exact_matches}/{n})')
    print(f'  Exact (when extracted): {exact_when_ext:.1f}%  ({exact_matches}/{extracted})')
    print(f'  Avg digit accuracy : {avg_da:.1f}%')

    # Per-grader breakdown
    by_grader = defaultdict(list)
    for r in results:
        by_grader[r['grader']].append(r)
    print('\n  Per-grader:')
    for grader, items in sorted(by_grader.items()):
        g_ext   = sum(1 for r in items if r['extracted'])
        g_exact = sum(1 for r in items if r['exact'])
        print(f'    {grader:<8}: {g_exact}/{len(items)} exact  ({g_ext}/{len(items)} extracted)')

    # Digit confusion (only on cases where both exist)
    confusion = Counter()
    for r in results:
        if r['pred'] and r['true'] and r['pred'] != r['true']:
            for true_d, pred_d in digit_confusion(r['pred'], r['true']):
                confusion[(true_d, pred_d)] += 1
    if confusion:
        print('\n  Top digit confusions (true→pred):')
        for (t, p), n_err in confusion.most_common(10):
            print(f'    {t} → {p}   ({n_err}×)')

    # Failure cases
    if args.show_failures:
        failures = [r for r in results if not r['exact']]
        print(f'\n  Failures ({len(failures)}):')
        for r in failures[:30]:
            pred_str = r['pred'] or 'None'
            print(f'    {r["itemId"]}  true={r["true"]}  pred={pred_str}  grader={r["grader"]}')

    print('=' * 56)
    print(f'\n  Baseline: {exact_rate:.1f}% exact match on {n} labeled samples')
    print()


if __name__ == '__main__':
    main()
