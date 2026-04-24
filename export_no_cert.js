'use strict';

/**
 * export_no_cert.js
 *
 * Copies all images marked 'D' (no cert) in the review decisions
 * to data/no_cert_export/ so you can verify them before training.
 *
 * Each listing keeps its own subfolder so you can see them by card.
 * Nothing is deleted from data/images/ — this is a copy only.
 *
 * Run: node export_no_cert.js
 */

const fs   = require('fs');
const path = require('path');

const DECISIONS_F = path.join(__dirname, 'data', 'cert_results', '_review_decisions.json');
const IMAGES_DIR  = path.join(__dirname, 'data', 'images');
const EXPORT_DIR  = path.join(__dirname, 'data', 'no_cert_export');

if (!fs.existsSync(DECISIONS_F)) {
  console.error('No review decisions file found. Run the review tool first.');
  process.exit(1);
}

const decisions = JSON.parse(fs.readFileSync(DECISIONS_F, 'utf8'));
const targets   = Object.entries(decisions).filter(([, v]) => v.decision === 'd').map(([id]) => id);

console.log(`\nExporting ${targets.length} 'no cert' listings to data/no_cert_export/\n`);

if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

let copied = 0, skipped = 0;

for (const itemId of targets) {
  const srcDir  = path.join(IMAGES_DIR, itemId);
  const destDir = path.join(EXPORT_DIR, itemId);

  if (!fs.existsSync(srcDir)) { skipped++; continue; }

  // Read meta for a useful folder name prefix
  let label = itemId;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(srcDir, '_meta.json'), 'utf8'));
    label = (meta.cardName || '').replace(/[^a-zA-Z0-9 ]/g, '').trim() + '_' + itemId;
  } catch (_) {}

  const namedDest = path.join(EXPORT_DIR, label);
  if (!fs.existsSync(namedDest)) fs.mkdirSync(namedDest, { recursive: true });

  const files = fs.readdirSync(srcDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(namedDest, f));
  }

  copied++;
  if (copied % 20 === 0) console.log(`  Copied ${copied} / ${targets.length}...`);
}

console.log(`\nDone.`);
console.log(`  Exported : ${copied} listings → data/no_cert_export/`);
console.log(`  Skipped  : ${skipped} (image folder missing)`);
console.log(`\nOpen data/no_cert_export/ in File Explorer to verify.`);
console.log(`Each subfolder is named  CardName_itemId  so you can see what card it is.\n`);
