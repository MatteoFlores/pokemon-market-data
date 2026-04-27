"""
eval/diagnose_failures.py

Full diagnostic pass on all evaluation failures.

Outputs:
  recon/failure_diagnostics.json  — per-crop raw OCR results
  recon/failure_samples/          — 30 representative crop copies
  Console report                  — failure breakdown, dimension distribution,
                                    preprocessing experiment
"""

import json, shutil, re, sys, warnings, os
from pathlib import Path
from collections import defaultdict

import cv2
import numpy as np

BASE      = Path(__file__).resolve().parent.parent
LABELED_F = BASE / 'data' / 'labeled_test_set.json'
RECON_DIR = BASE / 'recon' / 'failure_samples'
DIAG_JSON = BASE / 'recon' / 'failure_diagnostics.json'
CERT_RE   = re.compile(r'\b(\d{6,13})\b')

os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'


# ── OCR helpers ────────────────────────────────────────────────────────────────

def init_ocr():
    print('Loading EasyOCR...', flush=True)
    import easyocr
    easy = easyocr.Reader(['en'], gpu=True, verbose=False)

    print('Loading PaddleOCR...', flush=True)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        from paddleocr import PaddleOCR
        paddle = PaddleOCR(use_textline_orientation=True, lang='en')

    return easy, paddle


def _classify_recognition_fail(raw_results):
    """Sub-classify why boxes were found but cert wasn't extracted."""
    if not raw_results:
        return 'no_boxes'
    texts = [r['text'] for r in raw_results]
    combined = ' '.join(texts)
    if not combined.strip():
        return 'empty_text'
    if not re.search(r'\d', combined):
        return 'no_digits'
    # Has digits — check if there's something numeric that's just the wrong length
    nums = re.findall(r'\d+', combined)
    longest = max(nums, key=len) if nums else ''
    if len(longest) < 6:
        return 'digits_too_short'
    if len(longest) > 13:
        return 'digits_too_long'
    return 'close_miss'


def raw_easyocr(easy, img_bgr):
    """Run EasyOCR and return (raw_results, failure_type, sub_type)."""
    try:
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        results = easy.readtext(rgb, detail=1)
        raw = [{'text': str(r[1]), 'conf': round(float(r[2]), 4),
                'bbox': [[int(p[0]), int(p[1])] for p in r[0]]}
               for r in results]
        if not raw:
            return raw, 'detection_failure', None
        combined = ' '.join(r['text'] for r in raw)
        if CERT_RE.search(combined):
            return raw, None, None
        return raw, 'recognition_failure', _classify_recognition_fail(raw)
    except Exception as e:
        return [], f'error', str(e)


def raw_paddleocr(paddle, img_bgr):
    """Run PaddleOCR and return (raw_results, failure_type, sub_type)."""
    try:
        r = paddle.ocr(img_bgr, cls=True)
        raw = []
        if r and r[0]:
            for line in r[0]:
                if line and len(line) >= 2:
                    bbox_pts, (text, conf) = line[0], line[1]
                    raw.append({'text': str(text), 'conf': round(float(conf), 4),
                                'bbox': [[int(p[0]), int(p[1])] for p in bbox_pts]})
        if not raw:
            return raw, 'detection_failure', None
        combined = ' '.join(r['text'] for r in raw)
        if CERT_RE.search(combined):
            return raw, None, None
        return raw, 'recognition_failure', _classify_recognition_fail(raw)
    except Exception as e:
        return [], 'error', str(e)


# ── Preprocessing variations ───────────────────────────────────────────────────

def try_variations(easy, img_bgr):
    """Run 6 preprocessing variations, return dict of {variant: cert_or_None}."""
    results = {}
    h, w = img_bgr.shape[:2]

    def ocr(image_bgr):
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        texts = easy.readtext(rgb, detail=0)
        m = CERT_RE.search(' '.join(str(t) for t in texts))
        return m.group(1) if m else None

    # 1. Original
    results['original'] = ocr(img_bgr)

    # 2. 2× upscale INTER_CUBIC
    up2 = cv2.resize(img_bgr, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)
    results['2x_upscale'] = ocr(up2)

    # 3. 4× upscale INTER_CUBIC
    up4 = cv2.resize(img_bgr, (w * 4, h * 4), interpolation=cv2.INTER_CUBIC)
    results['4x_upscale'] = ocr(up4)

    # 4. Grayscale + adaptive threshold
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    thresh = cv2.adaptiveThreshold(gray, 255,
                                   cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, 11, 2)
    thresh_bgr = cv2.cvtColor(thresh, cv2.COLOR_GRAY2BGR)
    results['adaptive_thresh'] = ocr(thresh_bgr)

    # 5. Grayscale + CLAHE
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    enhanced = clahe.apply(gray)
    enhanced_bgr = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
    results['clahe'] = ocr(enhanced_bgr)

    # 6. Bypass detection — pass entire crop as single recognized region
    try:
        gray_full = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
        # horizontal_list format: [[x_min, x_max, y_min, y_max]]
        bypass_results = easy.recognize(gray_full,
                                        horizontal_list=[[0, w, 0, h]],
                                        free_list=[])
        texts = [str(r[1]) for r in bypass_results if r and len(r) >= 2]
        m = CERT_RE.search(' '.join(texts))
        results['bypass_detection'] = m.group(1) if m else None
    except Exception:
        results['bypass_detection'] = None

    return results


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    labeled = json.loads(LABELED_F.read_text(encoding='utf-8'))
    test_set = {k: v for k, v in labeled.items()
                if not v.get('skipped') and v.get('trueCert')}

    print(f'Labeled (usable): {len(test_set)} crops')
    easy, paddle = init_ocr()

    # ── Pass 1: collect raw OCR for every item ─────────────────────────────────
    all_entries = {}
    success_list = []
    failure_list = []

    print(f'\nRunning raw OCR diagnostic on {len(test_set)} crops...\n', flush=True)

    for idx, (name, item) in enumerate(test_set.items()):
        true_cert  = item['trueCert']
        img_path   = item['imagePath']
        grader     = item.get('grader', '?')

        img = cv2.imread(img_path)
        if img is None:
            print(f'  MISSING image: {img_path}')
            continue

        h, w  = img.shape[:2]
        fsize = Path(img_path).stat().st_size

        easy_raw, easy_fail, easy_sub  = raw_easyocr(easy, img)
        pad_raw,  pad_fail,  pad_sub   = raw_paddleocr(paddle, img)

        # Combined cert extraction
        all_texts = [r['text'] for r in easy_raw] + [r['text'] for r in pad_raw]
        m = CERT_RE.search(' '.join(all_texts))
        pred_cert = m.group(1) if m else None
        exact = pred_cert == true_cert

        # Primary failure type (EasyOCR drives classification)
        if exact:
            failure_type = None
            failure_sub  = None
        elif easy_fail == 'detection_failure' and pad_fail == 'detection_failure':
            failure_type = 'detection_failure'
            failure_sub  = None
        elif easy_fail == 'detection_failure':
            # Paddle found something but it didn't match
            failure_type = 'recognition_failure'
            failure_sub  = pad_sub
        else:
            failure_type = easy_fail or 'recognition_failure'
            failure_sub  = easy_sub

        entry = {
            'name':        name,
            'grader':      grader,
            'trueCert':    true_cert,
            'predCert':    pred_cert,
            'exact':       exact,
            'failureType': failure_type,
            'failureSub':  failure_sub,
            'width':       w,
            'height':      h,
            'fileSize':    fsize,
            'imagePath':   img_path,
            'easyOcr': {
                'failureType': easy_fail,
                'failureSub':  easy_sub,
                'results':     easy_raw,
            },
            'paddleOcr': {
                'failureType': pad_fail,
                'failureSub':  pad_sub,
                'results':     pad_raw,
            },
        }

        all_entries[name] = entry
        (success_list if exact else failure_list).append(entry)

        if (idx + 1) % 25 == 0:
            print(f'  {idx+1}/{len(test_set)}  '
                  f'(so far: {len(success_list)} ok, {len(failure_list)} fail)', flush=True)

    RECON_DIR.mkdir(parents=True, exist_ok=True)
    (BASE / 'recon').mkdir(exist_ok=True)
    DIAG_JSON.write_text(json.dumps(all_entries, indent=2), encoding='utf-8')
    print(f'\nSaved per-crop diagnostics -> {DIAG_JSON}')

    # ── Report 1: failure type breakdown by grader ─────────────────────────────
    print('\n' + '=' * 62)
    print('  Failure Type Breakdown by Grader')
    print('=' * 62)

    by_grader = defaultdict(lambda: defaultdict(int))
    sub_counts = defaultdict(lambda: defaultdict(int))

    for e in all_entries.values():
        g = e['grader']
        by_grader[g]['total'] += 1
        if e['exact']:
            by_grader[g]['exact'] += 1
        else:
            ft = e['failureType'] or 'unknown'
            by_grader[g][ft] += 1
            if e['failureSub']:
                sub_counts[g][e['failureSub']] += 1

    for g in sorted(by_grader):
        d = by_grader[g]
        n = d['total']
        fails = n - d['exact']
        det   = d.get('detection_failure', 0)
        rec   = d.get('recognition_failure', 0)
        print(f'\n  {g}  ({n} crops, {fails} failures):')
        print(f'    Exact match        : {d["exact"]:3d} / {n}  ({d["exact"]/n*100:.0f}%)')
        print(f'    Detection failure  : {det:3d} / {fails}  ({det/fails*100:.0f}% of failures)' if fails else '')
        print(f'    Recognition failure: {rec:3d} / {fails}  ({rec/fails*100:.0f}% of failures)' if fails else '')
        if sub_counts[g]:
            print(f'    Recognition sub-types:')
            for sub, cnt in sorted(sub_counts[g].items(), key=lambda x: -x[1]):
                print(f'      {sub:<22}: {cnt}')

    # ── Report 2: dimension distribution ──────────────────────────────────────
    print('\n' + '=' * 62)
    print('  Dimension Distribution — Failed vs Successful by Grader')
    print('=' * 62)

    for g in sorted(by_grader):
        s = [e for e in success_list if e['grader'] == g]
        f = [e for e in failure_list if e['grader'] == g]
        if not s and not f:
            continue
        print(f'\n  {g}:')
        if s:
            sw = [e['width'] for e in s]
            sh = [e['height'] for e in s]
            print(f'    SUCCESS ({len(s):3d}): '
                  f'w {min(sw)}-{max(sw)} avg {sum(sw)//len(sw)}  '
                  f'h {min(sh)}-{max(sh)} avg {sum(sh)//len(sh)}')
        if f:
            fw = [e['width'] for e in f]
            fh = [e['height'] for e in f]
            print(f'    FAILURE ({len(f):3d}): '
                  f'w {min(fw)}-{max(fw)} avg {sum(fw)//len(fw)}  '
                  f'h {min(fh)}-{max(fh)} avg {sum(fh)//len(fh)}')

        # PSA resolution cliff — 20px width buckets
        if g == 'PSA' and (s or f):
            all_w = [(e['width'], True) for e in s] + [(e['width'], False) for e in f]
            lo = (min(e['width'] for e in s + f) // 20) * 20
            hi = (max(e['width'] for e in s + f) // 20) * 20 + 20
            print(f'\n    PSA width buckets (20px):')
            print(f'    {"Range":<14}  {"Succ":>4}  {"Fail":>4}  {"Rate":>5}  Bar')
            for bkt in range(lo, hi + 1, 20):
                bs = sum(1 for w, ok in all_w if bkt <= w < bkt + 20 and ok)
                bf = sum(1 for w, ok in all_w if bkt <= w < bkt + 20 and not ok)
                bt = bs + bf
                if bt == 0:
                    continue
                rate = bs / bt * 100
                bar  = '#' * bs + '.' * bf
                print(f'    {bkt:3d}-{bkt+19:3d}px  :  {bs:4d}  {bf:4d}  {rate:4.0f}%  {bar}')

    # ── Copy 30 representative failures ───────────────────────────────────────
    print('\n' + '=' * 62)
    print('  Copying 30 representative failures -> recon/failure_samples/')
    print('=' * 62)

    def sort_key(e):
        # detection failures first, then by width (smallest first — most interesting)
        return (0 if e['failureType'] == 'detection_failure' else 1, e['width'])

    psa_f = sorted([e for e in failure_list if e['grader'] == 'PSA'], key=sort_key)
    cgc_f = sorted([e for e in failure_list if e['grader'] == 'CGC'], key=sort_key)
    bgs_f = sorted([e for e in failure_list if e['grader'] == 'BGS'], key=sort_key)

    psa_sample = psa_f[:20]
    cgc_sample = cgc_f[:5]
    bgs_sample = bgs_f[:5]

    # Clear existing
    for p in RECON_DIR.glob('*.jpg'):
        p.unlink()

    copied = 0
    for e in psa_sample + cgc_sample + bgs_sample:
        src = Path(e['imagePath'])
        if not src.exists():
            continue
        ft = 'det' if e.get('failureType') == 'detection_failure' else 'rec'
        dst = RECON_DIR / f"{e['grader']}_{ft}_{e['width']}w_{src.name}"
        shutil.copy2(src, dst)
        copied += 1
    print(f'  Copied {copied} files')
    print(f'  Layout: {{grader}}_{{det|rec}}_{{width}}w_{{original_name}}.jpg')

    # ── Preprocessing experiment — 20 failed PSA crops ─────────────────────────
    print('\n' + '=' * 62)
    print('  Preprocessing Experiment — 20 Failed PSA Crops (EasyOCR only)')
    print('=' * 62)

    variant_keys = ['original', '2x_upscale', '4x_upscale',
                    'adaptive_thresh', 'clahe', 'bypass_detection']
    header_abbr  = ['orig', '2x', '4x', 'adth', 'clah', 'byps']

    psa_exp = psa_f[:20]
    totals  = defaultdict(int)
    n_valid = 0

    fmt_header = f"  {'Crop (width)':<26}  {'  '.join(f'{a:>4}' for a in header_abbr)}  True cert"
    print(fmt_header)
    print('  ' + '-' * (len(fmt_header) + 4))

    for e in psa_exp:
        img = cv2.imread(e['imagePath'])
        if img is None:
            continue
        n_valid += 1
        v = try_variations(easy, img)
        cols = []
        for k in variant_keys:
            hit = v[k] is not None
            if hit:
                totals[k] += 1
            cols.append('Y' if hit else '.')
        short = f"{Path(e['imagePath']).stem[:22]} ({e['width']}w)"
        print(f"  {short:<26}  {'  '.join(f'{c:>4}' for c in cols)}  {e['trueCert']}")

    print(f'\n  Recovery counts (out of {n_valid}):')
    for k, abbr in zip(variant_keys, header_abbr):
        n = totals[k]
        print(f'    {k:<22}: {n:2d}/{n_valid}  ({n/n_valid*100:.0f}%)')

    print('\n' + '=' * 62)
    print(f'  Summary: {len(success_list)} success, {len(failure_list)} failure out of {len(all_entries)}')
    print('=' * 62)
    print()


if __name__ == '__main__':
    main()
