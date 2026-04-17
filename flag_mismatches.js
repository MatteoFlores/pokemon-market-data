/**
 * flag_mismatches.js
 *
 * Post-processes all existing data/ebay_sold/{setId}/{cardId}.json files
 * and adds potentialMismatch / mismatchFlags fields to every listing that
 * looks like it might not actually be the card being searched.
 *
 * Safe to run multiple times — rewrites each file in place.
 * Does not re-scrape anything.
 *
 * Usage:
 *   node flag_mismatches.js
 *   node flag_mismatches.js --dry-run   (print stats, don't write files)
 *
 * Mismatch flags:
 *   bundle_or_lot                 — multiple cards / lot / bundle
 *   proxy_or_reprint              — proxy, reprint, fake, custom card
 *   japanese_card                 — Japanese-language listing
 *   wrong_card_number:title=N...  — N/TOTAL in title doesn't match card.number
 *   wrong_set_total:title=N...    — /TOTAL in title doesn't match set total
 *   base_set_2_confusion          — base1 search returned a Base Set 2 title
 *   suspiciously_low_graded_price — graded card listed under $4
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SOLD_DIR = path.join(DATA_DIR, 'ebay_sold');
const DRY_RUN  = process.argv.includes('--dry-run');

// ── Mismatch detection (mirrors scrape_sold_with_images.js) ──────────────────

function validateListing(listing, card, set) {
  const flags = [];
  const title = listing.title || '';

  // 1. Lot / bundle
  if (/\b(lot|bundle|collection|pick\s+any|choose\s+any|set\s+of\s+\d|\dx\d|\d\s*x\s*psa)\b/i.test(title)) {
    flags.push('bundle_or_lot');
  }

  // 2. Proxy / reprint / fake
  if (/\b(proxy|reprint|custom\s+card|fake|replica|non[- ]?holo)\b/i.test(title)) {
    flags.push('proxy_or_reprint');
  }

  // 3. Japanese card
  if (/\b(japanese|japan)\b/i.test(title) || /\bjp\s+(psa|bgs|cgc|holo|pack)\b/i.test(title)) {
    flags.push('japanese_card');
  }

  // 4. Wrong card number or set total
  const numMatch = /\b(\d{1,3})\/(\d{2,3})\b/.exec(title);
  if (numMatch) {
    const titleNum   = parseInt(numMatch[1], 10);
    const titleTotal = parseInt(numMatch[2], 10);
    const cardNum    = parseInt(card.number,   10);
    const cardTotal  = parseInt(card.setTotal, 10);

    if (!isNaN(cardNum) && titleNum !== cardNum) {
      flags.push(`wrong_card_number:title=${titleNum},expected=${cardNum}`);
    }
    if (!isNaN(cardTotal) && titleTotal !== cardTotal) {
      flags.push(`wrong_set_total:title=${titleTotal},expected=${cardTotal}`);
    }
  }

  // 5. Base Set vs Base Set 2
  if (set.id === 'base1') {
    if (/base\s*set\s*2|\bbase\s*2\b|\bbs2\b/i.test(title)) {
      flags.push('base_set_2_confusion');
    }
  }

  // 6. Suspiciously cheap for a graded card
  if (listing.graded && listing.price < 4) {
    flags.push('suspiciously_low_graded_price');
  }

  return {
    ...listing,
    potentialMismatch: flags.length > 0,
    mismatchFlags:     flags,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(SOLD_DIR)) {
    console.error(`data/ebay_sold/ not found at ${SOLD_DIR}`);
    process.exit(1);
  }

  let filesProcessed    = 0;
  let listingsProcessed = 0;
  let mismatchCount     = 0;

  const flagCounts = {};

  for (const setId of fs.readdirSync(SOLD_DIR)) {
    const setDir = path.join(SOLD_DIR, setId);
    if (!fs.statSync(setDir).isDirectory()) continue;

    for (const fname of fs.readdirSync(setDir)) {
      if (!fname.endsWith('.json')) continue;

      const fpath = path.join(setDir, fname);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      } catch (e) {
        console.warn(`  WARN: could not parse ${fpath}: ${e.message}`);
        continue;
      }

      if (!Array.isArray(data.listings)) continue;

      // Build minimal card/set objects for the validator
      const card = {
        number:   data.number   || '',
        setTotal: data.setTotal || extractSetTotalFromListings(data.listings),
      };
      const set = { id: data.setId || setId };

      data.listings = data.listings.map(l => {
        const validated = validateListing(l, card, set);
        if (validated.potentialMismatch) {
          mismatchCount++;
          for (const f of validated.mismatchFlags) {
            flagCounts[f] = (flagCounts[f] || 0) + 1;
          }
        }
        listingsProcessed++;
        return validated;
      });

      if (!DRY_RUN) {
        fs.writeFileSync(fpath, JSON.stringify(data, null, 2));
      }

      filesProcessed++;
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('\n── flag_mismatches.js ─────────────────────────────────────');
  if (DRY_RUN) console.log('  DRY RUN — no files written');
  console.log(`  Files processed    : ${filesProcessed.toLocaleString()}`);
  console.log(`  Listings checked   : ${listingsProcessed.toLocaleString()}`);
  console.log(`  Mismatches flagged : ${mismatchCount.toLocaleString()} ` +
    `(${listingsProcessed ? ((mismatchCount / listingsProcessed) * 100).toFixed(1) : 0}%)`);
  console.log('\n  Flags breakdown:');
  for (const [flag, cnt] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) {
    // Truncate long wrong_card_number details for readability
    const label = flag.length > 50 ? flag.slice(0, 47) + '...' : flag;
    console.log(`    ${label.padEnd(50)} ${cnt.toLocaleString()}`);
  }
  console.log('──────────────────────────────────────────────────────────\n');
}

/**
 * Infer the set total from existing listing titles (e.g. "Charizard 4/102").
 * Returns the most common /TOTAL seen, or NaN if none found.
 */
function extractSetTotalFromListings(listings) {
  const counts = {};
  for (const l of listings) {
    const m = /\/(\d{2,3})\b/.exec(l.title || '');
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? parseInt(entries[0][0], 10) : NaN;
}

main();
