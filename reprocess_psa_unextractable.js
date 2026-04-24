'use strict';

/**
 * reprocess_psa_unextractable.js
 *
 * Prepares for a re-run of extract_certs.py on PSA images that previously
 * failed cert extraction, using the newly trained model.
 *
 * What this does:
 *   1. Deletes data/no_cert_export/ (training images no longer needed)
 *   2. Clears PSA-only unextractable entries from cert_results/_progress.json
 *      so extract_certs.py picks them up on next run
 *   3. Leaves CGC/BGS unextractable entries untouched
 *
 * Run: node reprocess_psa_unextractable.js
 * Then: python extract_certs.py
 */

const fs   = require('fs');
const path = require('path');

const PROGRESS_F  = path.join(__dirname, 'data', 'cert_results', '_progress.json');
const IMAGES_DIR  = path.join(__dirname, 'data', 'images');
const EXPORT_DIR  = path.join(__dirname, 'data', 'no_cert_export');

// ── Step 1: Delete no_cert_export ─────────────────────────────────────────────

if (fs.existsSync(EXPORT_DIR)) {
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  console.log('✓ Deleted data/no_cert_export/');
} else {
  console.log('  data/no_cert_export/ already gone — skipping');
}

// ── Step 2: Clear PSA unextractable from progress ────────────────────────────

const progress = JSON.parse(fs.readFileSync(PROGRESS_F, 'utf8'));

let cleared = 0, skippedCgc = 0, skippedBgs = 0, skippedNoMeta = 0;

for (const [itemId, entry] of Object.entries(progress)) {
  if (entry.folder !== 'unextractable') continue;

  // Check grader from meta
  const metaPath = path.join(IMAGES_DIR, itemId, '_meta.json');
  if (!fs.existsSync(metaPath)) { skippedNoMeta++; continue; }

  let grader;
  try {
    grader = JSON.parse(fs.readFileSync(metaPath, 'utf8')).grader || '';
  } catch { skippedNoMeta++; continue; }

  if (grader === 'PSA') {
    delete progress[itemId];
    cleared++;
  } else if (grader === 'CGC') {
    skippedCgc++;
  } else if (grader === 'BGS') {
    skippedBgs++;
  } else {
    skippedNoMeta++;
  }
}

fs.writeFileSync(PROGRESS_F, JSON.stringify(progress, null, 2));

console.log(`\n✓ Cleared ${cleared} PSA unextractable entries from _progress.json`);
console.log(`  Left untouched: ${skippedCgc} CGC, ${skippedBgs} BGS, ${skippedNoMeta} other/no-meta`);
console.log(`\nReady. Run extraction on the cleared PSA items:`);
console.log(`  .\\venv\\Scripts\\activate`);
console.log(`  python extract_certs.py\n`);
