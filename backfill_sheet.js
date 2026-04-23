'use strict';

/**
 * backfill_sheet.js
 *
 * One-time script: reads all local data/ebay_sold/ card JSON files,
 * computes accurate cardsDone + listingsTotal per set, then patches
 * any sheet rows where those numbers are missing or wrong.
 *
 * Run once:  node backfill_sheet.js
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SOLD_DIR    = path.join(__dirname, 'data', 'ebay_sold');

// ── Load config + coordinator ──────────────────────────────────────────────────

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('No config.json found. Run setup.js first.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { Coordinator } = require('./coordinator');
const coord = new Coordinator(config);

// ── Scan local ebay_sold/ folder ───────────────────────────────────────────────

function scanLocalSets() {
  if (!fs.existsSync(SOLD_DIR)) {
    console.error('data/ebay_sold/ not found — nothing to backfill.');
    process.exit(1);
  }

  const result = {}; // setId → { cardsDone, listingsTotal }

  for (const setId of fs.readdirSync(SOLD_DIR)) {
    const setDir = path.join(SOLD_DIR, setId);
    if (!fs.statSync(setDir).isDirectory()) continue;

    let cardsDone    = 0;
    let listingsTotal = 0;

    for (const file of fs.readdirSync(setDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(setDir, file), 'utf8'));
        const count = Array.isArray(data.listings) ? data.listings.length : (data.totalListings || 0);
        if (count > 0) {
          cardsDone++;
          listingsTotal += count;
        }
      } catch (_) {}
    }

    if (cardsDone > 0) result[setId] = { cardsDone, listingsTotal };
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nScanning local ebay_sold/ folder...');
  const local = scanLocalSets();
  const setIds = Object.keys(local);
  console.log(`Found ${setIds.length} sets with local data.\n`);

  console.log('Connecting to Google Sheet...');
  await coord.init();

  const rows = await coord._readAll();
  if (!rows.length || rows[0][0] !== 'SetID') {
    console.error('Sheet missing or has no header row.');
    process.exit(1);
  }

  let updated = 0;
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const r     = rows[i];
    const setId = r[0];
    if (!setId || !local[setId]) continue;

    const sheetListings = parseInt(r[9]) || 0;  // column J — ListingsTotal
    const sheetCards    = parseInt(r[8]) || 0;  // column I — CardsDone
    const localData     = local[setId];

    // Only patch if local has more data than what's in the sheet
    if (localData.listingsTotal <= sheetListings && localData.cardsDone <= sheetCards) {
      skipped++;
      continue;
    }

    const rowNum = i + 1;
    const updated_row = r.slice();
    while (updated_row.length < 13) updated_row.push('');

    updated_row[8]  = String(localData.cardsDone);
    updated_row[9]  = String(localData.listingsTotal);

    // If status is still pending but we have data, mark it done
    if ((updated_row[4] || 'pending').toLowerCase() === 'pending') {
      updated_row[4] = 'done';
      updated_row[7] = updated_row[7] || new Date().toISOString(); // LastScrapedAt
    }

    await coord._writeRow(rowNum, updated_row);
    console.log(`  ✓ ${setId.padEnd(20)} ${localData.cardsDone} cards  ${localData.listingsTotal.toLocaleString()} listings`);
    updated++;

    // Small delay to avoid hitting Sheets API rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone. Updated ${updated} rows, skipped ${skipped} (already accurate).`);
  console.log('Refresh your dashboard to see the corrected global total.\n');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
