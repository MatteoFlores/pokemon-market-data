/**
 * fetch_tcgcsv.js
 *
 * 1. Matches our local sets → TCGCSV groupIds via name normalization
 * 2. Fetches products + prices JSON for every matched group
 * 3. Joins on productId, extracts card number from extendedData
 * 4. Matches to our cards by setId + card number
 * 5. Writes:
 *      data/raw/tcgcsv/{groupId}.json       — raw joined product+price per group
 *      data/tcgplayer_map.json              — cardId → { tcgplayerId, printingType }[]
 *      data/price_snapshots/{date}.json     — flat price records with timestamp
 *      data/unmatched_sets.json             — sets we couldn't auto-match (review manually)
 *
 * Run: node fetch_tcgcsv.js
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR     = path.join(__dirname, 'data');
const RAW_DIR      = path.join(DATA_DIR, 'raw', 'tcgcsv');
const SNAP_DIR     = path.join(DATA_DIR, 'price_snapshots');
const DELAY_MS     = 250;   // polite delay between requests
const TODAY        = new Date().toISOString().slice(0, 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PokemonMarketData/1.0' } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Name Normalizer ───────────────────────────────────────────────────────────
// Strips noise so "SWSH01: Sword & Shield Base Set" ≈ "Sword & Shield"

function normalizeName(name) {
  return name
    .toLowerCase()
    // remove series prefixes like "SWSH01:", "SV08:", "SM -", "XY -"
    .replace(/^(sw?sh\d*pt?\d*|sv\d*pt?\d*|sm\d*|xy\d*|dp\d*|pl\d*|bw\d*|hgss\d*|ex\d*|pop\d*|me\d*)[\s:\-]*/i, '')
    // "XY - BREAKpoint" → strip "XY - "
    .replace(/^(swsh|sv|sm|xy|dp|pl|bw|hgss|ex|pop|me)\s*[-:]\s*/i, '')
    // "SWSH09: Brilliant Stars Trainer Gallery" → keep but normalized
    .replace(/trainer\s*gallery/g, 'tg')
    .replace(/galarian\s*gallery/g, 'gg')
    .replace(/shiny\s*vault/g, 'sv')
    .replace(/radiant\s*collection/g, 'rc')
    .replace(/classic\s*collection/g, 'cc')
    // normalize separators and symbols
    .replace(/[&]/g, 'and')
    .replace(/[—–-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    // collapse spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// Token overlap score between two normalized names (0–1)
function similarity(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  const inter = [...ta].filter(t => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size, 1);
}

// ── Manual overrides ─────────────────────────────────────────────────────────
// Sets where auto-matching fails due to name differences.
// Format: ourSetId → TCGCSV groupId

const MANUAL_OVERRIDES = {
  xy1:     1387,   // "XY"           → "XY Base Set"
  sm1:     1863,   // "Sun & Moon"   → "SM Base Set"
  sv3pt5:  23237,  // "151"          → "SV: Scarlet & Violet 151"
  // fut20 (Pokémon Futsal Collection) and mcd21 (McDonald's 2021) have no TCGCSV equivalent
};

// ── Set Matcher ───────────────────────────────────────────────────────────────

function buildSetMapping(ourSets, tcgGroups) {
  const matched   = {};  // ourSetId → { groupId, groupName, score }
  const unmatched = [];
  const groupById = Object.fromEntries(tcgGroups.map(g => [g.groupId, g]));

  for (const ourSet of ourSets) {
    // Check manual override first
    if (MANUAL_OVERRIDES[ourSet.id]) {
      const g = groupById[MANUAL_OVERRIDES[ourSet.id]];
      if (g) {
        matched[ourSet.id] = { groupId: g.groupId, groupName: g.name, score: 1.0 };
        continue;
      }
    }

    const ourNorm  = normalizeName(ourSet.name);
    let   best     = null;
    let   bestScore = 0;

    for (const g of tcgGroups) {
      const gNorm = normalizeName(g.name);

      // Exact match after normalization
      if (ourNorm === gNorm) {
        best      = g;
        bestScore = 1.0;
        break;
      }

      // Token overlap
      const score = similarity(ourNorm, gNorm);
      if (score > bestScore) {
        bestScore = score;
        best      = g;
      }
    }

    if (best && bestScore >= 0.5) {
      matched[ourSet.id] = { groupId: best.groupId, groupName: best.name, score: bestScore };
    } else {
      unmatched.push({ setId: ourSet.id, setName: ourSet.name, bestCandidate: best?.name, score: bestScore });
    }
  }

  return { matched, unmatched };
}

// ── Card Number Normalizer ────────────────────────────────────────────────────
// TCGCSV returns "001/102", "SV001/SV122", "TG01/TG30", etc.
// Our data has "1", "SV001", "TG01", etc.

function normalizeCardNumber(raw) {
  if (!raw) return null;
  // Strip the "/total" portion: "001/102" → "001"
  const base = raw.split('/')[0];
  // Remove leading zeros for pure numeric: "001" → "1"
  if (/^\d+$/.test(base)) return String(parseInt(base, 10));
  // Remove leading zeros from numeric suffix: "SV001" → "SV1", "TG01" → "TG1"
  return base.replace(/^([A-Za-z]+)0*(\d+)$/, (_, prefix, num) => prefix + parseInt(num, 10));
}

function getExtData(extendedData, key) {
  if (!Array.isArray(extendedData)) return null;
  const entry = extendedData.find(e => e.name === key);
  return entry ? entry.value : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(RAW_DIR);
  ensureDir(SNAP_DIR);

  const ourSets  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sets.json'), 'utf8'));
  const ourCards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));
  const tcgGroups = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'tcgcsv_groups_raw.json'), 'utf8')
  ).results;

  // Build card lookup: setId+number → card
  const cardLookup = {};
  for (const c of ourCards) {
    const key = `${c.setId}||${c.number}`;
    if (!cardLookup[key]) cardLookup[key] = [];
    cardLookup[key].push(c);
  }

  // ── 1. Match sets ──────────────────────────────────────────────────────────
  console.log('\n── Matching sets ─────────────────────────────');
  const { matched, unmatched } = buildSetMapping(ourSets, tcgGroups);

  const matchedCount = Object.keys(matched).length;
  console.log(`  Matched  : ${matchedCount} / ${ourSets.length} sets`);
  console.log(`  Unmatched: ${unmatched.length} sets`);

  fs.writeFileSync(
    path.join(DATA_DIR, 'unmatched_sets.json'),
    JSON.stringify(unmatched, null, 2)
  );
  if (unmatched.length) {
    console.log(`  → Saved unmatched_sets.json for manual review`);
  }

  // ── 2. Fetch + match cards ─────────────────────────────────────────────────
  console.log('\n── Fetching prices from TCGCSV ───────────────');

  const tcgplayerMap  = {};   // cardId → [{ tcgplayerId, subTypeName }]
  const priceRecords  = [];   // flat snapshot records

  const entries = Object.entries(matched);
  let   done    = 0;

  for (const [setId, { groupId, groupName }] of entries) {
    const rawFile = path.join(RAW_DIR, `${groupId}.json`);
    let   joined;

    // Use cached file if exists (re-running won't re-fetch)
    if (fs.existsSync(rawFile)) {
      joined = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    } else {
      try {
        await sleep(DELAY_MS);
        const [prodResp, priceResp] = await Promise.all([
          fetchJSON(`https://tcgcsv.com/tcgplayer/3/${groupId}/products`),
          fetchJSON(`https://tcgcsv.com/tcgplayer/3/${groupId}/prices`),
        ]);

        // Build price lookup by productId
        const priceByProduct = {};
        for (const p of (priceResp.results || [])) {
          if (!priceByProduct[p.productId]) priceByProduct[p.productId] = [];
          priceByProduct[p.productId].push(p);
        }

        // Join products + prices
        joined = (prodResp.results || []).map(prod => ({
          productId:    prod.productId,
          name:         prod.name,
          cleanName:    prod.cleanName,
          url:          prod.url,
          cardNumber:   normalizeCardNumber(getExtData(prod.extendedData, 'Number')),
          rarity:       getExtData(prod.extendedData, 'Rarity'),
          prices:       priceByProduct[prod.productId] || [],
        }));

        fs.writeFileSync(rawFile, JSON.stringify(joined, null, 2));
      } catch (err) {
        console.warn(`  WARN [${setId}/${groupId}] ${err.message}`);
        done++;
        continue;
      }
    }

    // ── 3. Match products → our cards ────────────────────────────────────────
    for (const prod of joined) {
      const key       = `${setId}||${prod.cardNumber}`;
      const ourMatches = cardLookup[key] || [];

      // If we only have one card for this set+number, match directly.
      // If multiple (same number, different variants), match by name too.
      let targets = ourMatches;
      if (ourMatches.length > 1) {
        const byName = ourMatches.filter(c =>
          c.name.toLowerCase() === (prod.cleanName || '').toLowerCase()
        );
        if (byName.length) targets = byName;
      }

      for (const card of targets) {
        // Record tcgplayerId mapping
        if (!tcgplayerMap[card.id]) tcgplayerMap[card.id] = [];
        tcgplayerMap[card.id].push({
          tcgplayerId: prod.productId,
          subTypeName: prod.prices.map(p => p.subTypeName).join('/') || null,
        });

        // Record price snapshots
        for (const price of prod.prices) {
          priceRecords.push({
            date:          TODAY,
            cardId:        card.id,
            tcgplayerId:   prod.productId,
            subTypeName:   price.subTypeName,   // Normal | Holofoil | Reverse Holofoil
            lowPrice:      price.lowPrice,
            midPrice:      price.midPrice,
            highPrice:     price.highPrice,
            marketPrice:   price.marketPrice,
            directLowPrice: price.directLowPrice,
          });
        }
      }
    }

    done++;
    process.stdout.write(`\r  ${done}/${entries.length} sets processed...`);
  }

  console.log(`\n\n── Saving results ────────────────────────────`);

  // tcgplayer_map.json
  fs.writeFileSync(
    path.join(DATA_DIR, 'tcgplayer_map.json'),
    JSON.stringify(tcgplayerMap, null, 2)
  );
  console.log(`  tcgplayer_map.json   — ${Object.keys(tcgplayerMap).length.toLocaleString()} cards mapped`);

  // price_snapshots/{date}.json
  const snapFile = path.join(SNAP_DIR, `${TODAY}.json`);
  fs.writeFileSync(snapFile, JSON.stringify(priceRecords, null, 2));
  console.log(`  price_snapshots/${TODAY}.json — ${priceRecords.length.toLocaleString()} price records`);

  // Summary stats
  const withPrice    = new Set(priceRecords.map(r => r.cardId)).size;
  const totalCards   = ourCards.length;
  const coverage     = ((withPrice / totalCards) * 100).toFixed(1);
  console.log(`\n── Coverage ──────────────────────────────────`);
  console.log(`  Cards with price data : ${withPrice.toLocaleString()} / ${totalCards.toLocaleString()} (${coverage}%)`);
  console.log(`  Price records total   : ${priceRecords.length.toLocaleString()}`);
  console.log(`  (Multiple records per card = different print variants)`);

  // Print unmatched sets if any
  if (unmatched.length) {
    console.log(`\n── Unmatched sets (review unmatched_sets.json) ─`);
    for (const u of unmatched) {
      console.log(`  ${u.setId.padEnd(16)} "${u.setName}"  →  best: "${u.bestCandidate}" (score ${u.score.toFixed(2)})`);
    }
  }

  console.log('\nDone.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
