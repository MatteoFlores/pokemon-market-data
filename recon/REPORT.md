# Recon Report — PSA Cert Extraction Pipeline
Generated: 2026-04-25

---

## 1. File Layout

| Location | Purpose | Count |
|---|---|---|
| `data/images/{itemId}/` | Full listing images (source) | 41,568 folders |
| `data/images/{itemId}/_meta.json` | Per-listing metadata | 41,568 files |
| `data/label_annotation/images/` | Full images used to train Model 1 | 1,934 images |
| `data/annotation_crops/images/` | Label crops used to train Model 2 | 500 images |
| `data/cert_crop_browser/images/` | Debug cert crops (from generate_cert_browser.py) | 93 images |
| `data/cert_results/_progress.json` | Per-item extraction state | 23,302 entries |
| `data/cert_results/cert_numbers.json` | Master cert lookup | 18,144 entries |
| `data/cert_results/cert_extracted/` | High-confidence results (images deleted) | 17,837 items |
| `data/cert_results/verify_later/` | Low-confidence results | 132 items |
| `data/cert_results/ocr_success/` | OCR succeeded, images kept | 112 items |
| `data/cert_results/unextractable/` | Failed extraction | 5,221 items |

**Traceability:** Every crop can be traced back to its source via `itemId` — the folder name IS the eBay item ID, and `_meta.json` inside links to cardId, cardName, setId, etc.

⚠️ **Surprise: avg 54.3 images per listing folder.** This likely includes eBay's zoom/thumbnail variants. With 41,568 listings that's ~2.26 million image files on disk. Only 23,302 listings have been processed so far — ~18,000 are queued.

---

## 2. Extraction State

**Overall:** 23,302 items processed

| Folder | Count | % |
|---|---|---|
| cert_extracted | 17,837 | 76.5% |
| unextractable | 5,221 | 22.4% |
| verify_later | 132 | 0.6% |
| ocr_success | 112 | 0.5% |

**Items with a cert number:** 18,081 / 23,302 = **77.6%**

**Confidence distribution** (items with cert):
- `>=0.95`: 17,949 (99.3% of successful extractions — mostly barcodes returning conf=1.0)
- `0.90–0.95`: 104
- `0.80–0.90`: 18
- `<0.80`: 10

⚠️ **Critical data quality problem: 14,484 items (~80% of cert_db) carry a repeated cert number.**
721 cert numbers appear 4+ times across 14,484 listings. Top offenders:
- `21327121` × 423 listings
- `98105530` × 337 listings
- `97987433` × 320 listings
- `98384792` × 208 listings

These are almost certainly OCR misreads — a single cert number cannot legitimately appear on hundreds of different eBay listings. The database currently has ~3,660 likely-correct unique certs and ~14,484 garbage entries.

---

## 3. Sample Images

Copied to `recon/samples/`. Full listing images (not cert crops), pixel dimensions below.

**Successful extractions:**
| Item ID | Dimensions | Cert |
|---|---|---|
| 157024336391 | 760×1272 | 66914650 |
| 327011469621 | 1200×1600 | 56211932 ⚠️ repeated |
| 306645963742 | 963×1600 | 56211932 ⚠️ repeated |
| 117039305954 | 1200×1600 | 49449016 |
| 287027867550 | 1200×1600 | 61271971 ⚠️ repeated |

**Failed (unextractable):**
| Item ID | Dimensions | Cert |
|---|---|---|
| 117031074486 | 736×1024 | None |
| 117054221111 | 955×1600 | None |
| 306815835823 | 1163×1600 | None |
| 306830665527 | 1200×1600 | None |
| 117057214337 | 1200×1600 | None |

---

## 4. YOLO Model Inventory

### Model 1 — Label Region Detector
- **File:** `models/grading_labels_v3.pt`
- **Size:** 19.2 MB
- **Architecture:** YOLO11s (DetectionModel, 101 layers, 9.4M params)
- **Classes:** `{0: PSA, 1: CGC, 2: BGS, 3: ACE}` ⚠️ still says ACE, should be TAG (cosmetic only)
- **Training data:** `data/label_detector_dataset/` — train=1,248 / val=318 (total 1,566 images)
- **Best mAP50:** 0.9364
- **Best mAP50-95:** 0.8227
- **Epochs:** 60 (early stopped at 60, patience=25)

### Model 2 — Cert Number Sub-Region Detector
- **File:** `models/cert_detector_v1.pt`
- **Size:** 19.2 MB
- **Architecture:** YOLO11s (DetectionModel, 101 layers, 9.4M params)
- **Classes:** `{0: psa_cert, 1: bgs_cert, 2: cgc_cert, 3: ace_qr}` ⚠️ should be tag_qr
- **Training data:** `data/cert_detector_dataset/` — train=396 / val=71 (total 467 images)
- **Best mAP50:** 0.9950
- **Best mAP50-95:** 0.8521
- **Epochs:** 125 (early stopped, best at epoch 100)

⚠️ **Model 2 was trained on only 467 images.** The mAP50 looks great but the validation set is only 71 images — this may overfit. More annotation data recommended.

---

## 5. Listing Metadata

Full schema (from `_meta.json`):

```
itemId, cardId, cardName, setId, setName, grade, grader, edition,
price, soldDate, title, url, imageUrls, downloadedAt
```

**Title IS preserved** — e.g. `"PSA 10 VAPOREON V 172 EVOLVING SKIES SWORD & SHIELD FULL ART"`. This can be used for cross-validation (grader + grade + card name all appear in title for most listings).

**Sample records:** See section above in Extraction State for 3 full examples.

---

## 6. Hardware & Environment

| Item | Value |
|---|---|
| GPU | NVIDIA GeForce RTX 3080 Ti |
| VRAM | 12.9 GB |
| Python | 3.13.7 |
| PyTorch | 2.6.0+cu124 |
| Ultralytics | 8.4.37 |
| EasyOCR | 1.7.2 |
| PaddlePaddle | 3.3.1 |

---

## 7. Failure Mode Breakdown

⚠️ **Known bug in progress.json:** `route_result()` hardcodes `confidence=0.0` for all unextractable items regardless of YOLO detection confidence. This means the stored progress cannot distinguish between:
- "YOLO found nothing" (truly undetectable — probably ungraded cards)
- "YOLO found label at 94%, but OCR returned nothing"

From live debug runs (`debug_extraction.py`, `debug_ocr_failures.py`) we observed:
- **~15/50 sampled unextractable = NO DETECTION** — consistent across multiple runs, same cards each time, strongly suggests legitimately ungraded cards
- **~35/50 = YOLO detected, OCR failed** — model found label correctly but OCR returned card description text instead of cert number, or returned nothing

**OCR failure patterns observed:**
1. Reading card description text (year, set, card name) instead of cert number — crop captures top of label, cert number is at bottom
2. Returning nothing on clean, human-readable crops — OCR simply can't handle grading label fonts/holographic backgrounds
3. 13-digit partial reads — cert crop cutting off left edge of number

---

## Flags & Surprises

1. **🚨 14,484 items (~80% of cert_db) have garbage cert numbers** — repeated values prove OCR was misreading labels. The database needs a purge pass filtering out any cert that appears more than 2-3 times.
2. **🚨 progress.json confidence bug** — cannot distinguish OCR failure from no-detection without re-running. Need to store YOLO conf separately from cert confidence.
3. **⚠️ 54 images per listing on average** — disk usage is very high. May want to keep only the first 1-2 images per listing after extraction.
4. **⚠️ Model 2 only 467 training images** — functionally good (mAP50=0.995) but small dataset. Validation set of 71 images is thin.
5. **⚠️ Model class names still say ACE** — cosmetic, code has been updated but weights baked in old name. Doesn't affect detection.
6. **ℹ️ 18,000+ listings not yet processed** — pipeline has a large backlog.
7. **ℹ️ Title field preserved** — enables cross-validation: parse grader/grade from title and compare against extracted cert.
