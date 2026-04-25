"""
validation/invalidate_repeated.py

Auto-invalidation pass: marks cert numbers that appear >=10 times across
different listings as likely garbage OCR reads.

Actions:
  - Re-queues item in _progress.json (done=False) so extract_certs.py
    will re-process it on the next run.
  - Removes the item from cert_numbers.json.
  - Deletes the result JSON from its folder (cert_extracted/, unextractable/, etc).
  - Does NOT delete images (already gone for cert_extracted; needed for others).

Writes: data/cert_results/invalidated_report.json

Usage:
  python validation/invalidate_repeated.py --dry-run   # preview
  python validation/invalidate_repeated.py             # apply
  python validation/invalidate_repeated.py --threshold 5
"""

import argparse
import json
from collections import Counter
from pathlib import Path

BASE        = Path(__file__).resolve().parent.parent
CERT_JSON   = BASE / 'data' / 'cert_results' / 'cert_numbers.json'
PROGRESS_F  = BASE / 'data' / 'cert_results' / '_progress.json'
RESULTS_DIR = BASE / 'data' / 'cert_results'
REPORT_F    = RESULTS_DIR / 'invalidated_report.json'

DEFAULT_THRESHOLD = 10


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview without making changes')
    parser.add_argument('--threshold', type=int, default=DEFAULT_THRESHOLD,
                        help=f'Flag certs appearing >= N times (default {DEFAULT_THRESHOLD})')
    args = parser.parse_args()

    cert_db  = json.loads(CERT_JSON.read_text(encoding='utf-8'))
    progress = json.loads(PROGRESS_F.read_text(encoding='utf-8'))

    cert_counts = Counter(
        v['certNumber'] for v in cert_db.values() if v.get('certNumber')
    )
    bad_certs = {c for c, n in cert_counts.items() if n >= args.threshold}
    bad_items = {iid: v for iid, v in cert_db.items()
                 if v.get('certNumber') in bad_certs}

    print(f'Threshold        : >= {args.threshold} occurrences')
    print(f'Bad cert numbers : {len(bad_certs)}')
    print(f'Items to purge   : {len(bad_items)}')
    print(f'Items remaining  : {len(cert_db) - len(bad_items)}')

    by_cert = {}
    for iid, v in bad_items.items():
        c = v['certNumber']
        by_cert.setdefault(c, {'count': cert_counts[c], 'items': []})['items'].append(iid)

    sorted_certs = sorted(by_cert.items(), key=lambda x: x[1]['count'], reverse=True)
    print('\nTop offenders:')
    for cert, info in sorted_certs[:15]:
        print(f'  {cert}  ×{info["count"]:>4}')

    if args.dry_run:
        print('\n[dry-run] No changes made.')
        return

    removed_jsons = 0
    for iid in bad_items:
        old_entry = progress.get(iid, {})
        old_folder = old_entry.get('folder')

        progress[iid] = {
            'done':          False,
            'folder':        None,
            'certNumber':    None,
            'confidence':    None,
            'invalidated':   True,
            'invalidReason': 'invalid_cert_repeated',
        }

        if old_folder:
            old_json = RESULTS_DIR / old_folder / f'{iid}.json'
            if old_json.exists():
                old_json.unlink()
                removed_jsons += 1

        cert_db.pop(iid, None)

    CERT_JSON.write_text(json.dumps(cert_db, indent=2), encoding='utf-8')
    PROGRESS_F.write_text(json.dumps(progress, indent=2), encoding='utf-8')

    report = {
        'threshold':       args.threshold,
        'bad_cert_count':  len(bad_certs),
        'items_purged':    len(bad_items),
        'result_jsons_deleted': removed_jsons,
        'cert_db_remaining': len(cert_db),
        'top_offenders': {c: n for c, n in sorted_certs[:50]},
    }
    REPORT_F.write_text(json.dumps(report, indent=2), encoding='utf-8')

    print(f'\nDone.')
    print(f'  Purged {len(bad_items)} items, deleted {removed_jsons} result JSONs.')
    print(f'  cert_numbers.json now has {len(cert_db)} entries.')
    print(f'  Re-queued items will be re-processed on next extract_certs.py run.')
    print(f'  Report: {REPORT_F}')


if __name__ == '__main__':
    main()
