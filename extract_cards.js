/**
 * extract_cards.js
 *
 * Reads all English card + set data from pokemon-tcg-data-master and writes
 * a clean, flat catalog into this project's /data folder.
 *
 * Outputs:
 *   data/sets.json        — all English sets with metadata
 *   data/cards.json       — all English cards with fields needed for
 *                           cross-platform mapping (TCGplayer, eBay, PokeTrace)
 *
 * Run with:  node extract_cards.js
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ────────────────────────────────────────────────────────────────────

const SOURCE_ROOT = path.resolve(
  'C:/Users/matta/Desktop/Programs/Trading Cards With Victor/pokemon-tcg-data-master'
);
const SETS_FILE   = path.join(SOURCE_ROOT, 'sets', 'en.json');
const CARDS_DIR   = path.join(SOURCE_ROOT, 'cards', 'en');
const OUT_DIR     = path.join(__dirname, 'data');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  Wrote ${data.length.toLocaleString()} records → ${path.relative(__dirname, filePath)}`);
}

// ── Extract Sets ─────────────────────────────────────────────────────────────

function extractSets(raw) {
  return raw.map(s => ({
    id:           s.id,            // e.g. "base1", "sv8"
    name:         s.name,          // e.g. "Base", "Surging Sparks"
    series:       s.series,        // e.g. "Base", "Scarlet & Violet"
    releaseDate:  s.releaseDate,   // e.g. "1999/01/09"
    ptcgoCode:    s.ptcgoCode || null, // e.g. "BS" — used in some platform searches
    printedTotal: s.printedTotal,
    total:        s.total,         // includes secret rares etc.
  }));
}

// ── Extract Cards ─────────────────────────────────────────────────────────────
//
// Fields kept and why:
//   id                   — primary key, format "{setId}-{number}", unique across all sets
//   setId                — extracted from id prefix, links to sets.json
//   name                 — used for eBay / PokeTrace search queries
//   number               — card number within set; links to TCGCSV extNumber
//   supertype            — "Pokémon" | "Trainer" | "Energy" — for filtering
//   subtypes             — ["Basic"] | ["Stage 1"] | ["Supporter"] etc.
//   rarity               — "Common" | "Rare Holo" | "Special Illustration Rare" etc.
//                          critical for matching the right variant in listings
//   types                — ["Fire"] | ["Water"] etc. — for trend correlation
//   nationalPokedexNumbers — [4] — links card to species across all its prints
//   regulationMark       — "H", "G", "F" etc. (newer sets) — format legality proxy
//   tcgplayerId          — null for now; will be filled when we match TCGCSV data

function extractCard(card, setId) {
  return {
    id:                     card.id,
    setId:                  setId,
    name:                   card.name,
    number:                 card.number,
    supertype:              card.supertype,
    subtypes:               card.subtypes   || [],
    rarity:                 card.rarity     || null,
    types:                  card.types      || [],
    nationalPokedexNumbers: card.nationalPokedexNumbers || [],
    regulationMark:         card.regulationMark || null,
    tcgplayerId:            null,   // populated later via TCGCSV match
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  ensureDir(OUT_DIR);

  // 1. Sets
  console.log('\n── Sets ──────────────────────────────────────');
  const rawSets = JSON.parse(fs.readFileSync(SETS_FILE, 'utf8'));
  const sets    = extractSets(rawSets);
  writeJSON(path.join(OUT_DIR, 'sets.json'), sets);

  const setIds = new Set(sets.map(s => s.id));
  console.log(`  ${setIds.size} sets loaded`);

  // 2. Cards — iterate every {setId}.json in cards/en/
  console.log('\n── Cards ─────────────────────────────────────');
  const allCards = [];
  const skipped  = [];

  // Only process files whose setId appears in sets/en.json (English sets only).
  // The cards/en/ folder also contains Japanese sets (ja-* prefixed files) which
  // we exclude here — those will be handled separately when Japanese data is added.
  const files = fs.readdirSync(CARDS_DIR)
    .filter(f => f.endsWith('.json') && setIds.has(path.basename(f, '.json')));

  for (const file of files) {
    const setId   = path.basename(file, '.json');
    const rawPath = path.join(CARDS_DIR, file);
    let   raw;

    try {
      raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    } catch (e) {
      console.warn(`  WARN: could not parse ${file} — ${e.message}`);
      skipped.push(file);
      continue;
    }

    if (!Array.isArray(raw)) {
      console.warn(`  WARN: ${file} is not an array — skipping`);
      skipped.push(file);
      continue;
    }

    for (const card of raw) {
      allCards.push(extractCard(card, setId));
    }
  }

  writeJSON(path.join(OUT_DIR, 'cards.json'), allCards);

  if (skipped.length) {
    console.log(`\n  Skipped files: ${skipped.join(', ')}`);
  }

  // 3. Summary
  console.log('\n── Summary ───────────────────────────────────');
  console.log(`  Sets  : ${sets.length}`);
  console.log(`  Cards : ${allCards.length.toLocaleString()}`);

  const byRarity = {};
  for (const c of allCards) {
    const r = c.rarity || '(none)';
    byRarity[r] = (byRarity[r] || 0) + 1;
  }
  const top = Object.entries(byRarity).sort((a,b) => b[1]-a[1]).slice(0, 12);
  console.log('\n  Top rarities:');
  for (const [r, n] of top) {
    console.log(`    ${n.toString().padStart(5)}  ${r}`);
  }

  console.log('\nDone.\n');
}

main();
