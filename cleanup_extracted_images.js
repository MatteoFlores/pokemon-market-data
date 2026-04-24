'use strict';

/**
 * cleanup_extracted_images.js
 *
 * Deletes image folders for listings where the cert was already extracted
 * with high confidence (folder = cert_extracted or ocr_success).
 * The cert number is safely stored in cert_results/ — images no longer needed.
 *
 * Usage:
 *   node cleanup_extracted_images.js          -- dry run (shows what would be deleted)
 *   node cleanup_extracted_images.js --delete -- actually deletes
 */

const fs   = require('fs');
const path = require('path');

const DRY_RUN    = !process.argv.includes('--delete');
const CERT_PROG  = path.join(__dirname, 'data', 'cert_results', '_progress.json');
const IMAGES_DIR = path.join(__dirname, 'data', 'images');

const HIGH_CONFIDENCE = new Set(['cert_extracted', 'ocr_success']);

function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch (_) {}
    }
  } catch (_) {}
  return total;
}

function fmtMB(bytes) { return (bytes / 1_048_576).toFixed(1) + ' MB'; }

async function main() {
  if (DRY_RUN) {
    console.log('\n── DRY RUN (no files will be deleted) ──────────────────────');
    console.log('  Run with --delete to actually free the space.\n');
  } else {
    console.log('\n── DELETING extracted image folders ─────────────────────────\n');
  }

  const certProg = JSON.parse(fs.readFileSync(CERT_PROG, 'utf8'));

  const targets = Object.entries(certProg)
    .filter(([, v]) => HIGH_CONFIDENCE.has(v.folder))
    .map(([itemId]) => itemId);

  console.log(`Cert-extracted listings: ${targets.length.toLocaleString()}`);

  let found = 0, totalBytes = 0, deleted = 0;

  for (const itemId of targets) {
    const imgDir = path.join(IMAGES_DIR, itemId);
    if (!fs.existsSync(imgDir)) continue;
    found++;
    const bytes = dirSizeBytes(imgDir);
    totalBytes += bytes;

    if (!DRY_RUN) {
      try {
        fs.rmSync(imgDir, { recursive: true, force: true });
        deleted++;
        if (deleted % 500 === 0) console.log(`  Deleted ${deleted.toLocaleString()} folders so far...`);
      } catch (e) {
        console.warn(`  WARN: could not delete ${imgDir} — ${e.message}`);
      }
    }
  }

  console.log(`\nFolders found on disk : ${found.toLocaleString()}`);
  console.log(`Space to free         : ${fmtMB(totalBytes)} (${(totalBytes / 1_073_741_824).toFixed(2)} GB)`);

  if (!DRY_RUN) {
    console.log(`Folders deleted       : ${deleted.toLocaleString()}`);
    console.log('\nDone. Run node cleanup_extracted_images.js to verify remaining folders.');
  } else {
    console.log('\nRun with --delete to free this space:');
    console.log('  node cleanup_extracted_images.js --delete\n');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
