/**
 * fetch_ebay.js
 *
 * Pulls active eBay listings for Pokemon cards using the Browse API.
 * Searches by set name to collect all card listings per set efficiently.
 * Detects graded cards (PSA/BGS/CGC/CGC) in listing titles.
 *
 * Outputs:
 *   data/ebay_listings/{YYYY-MM-DD}.json   — all listings collected today
 *   data/ebay_token_cache.json             — cached OAuth token (auto-refreshed)
 *
 * Run: node fetch_ebay.js
 * Re-running same day appends new results to the existing daily file.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────

const { ebay } = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const DATA_DIR    = path.join(__dirname, 'data');
const EBAY_DIR    = path.join(DATA_DIR, 'ebay_listings');
const TOKEN_CACHE = path.join(DATA_DIR, 'ebay_token_cache.json');
const TODAY       = new Date().toISOString().slice(0, 10);
const DELAY_MS    = 300;   // polite delay between requests

// eBay Browse API — category 2536 = Collectible Card Games (Pokemon)
const CATEGORY_ID = '2536';
const BROWSE_BASE = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const PAGE_SIZE   = 200;   // must stay constant per request; offset must be a multiple of this

// Grading company patterns for title parsing
const GRADE_REGEX = /\b(PSA|BGS|CGC|SGC|CSG|HGA|ACE|AGS)\s*(\d+(?:\.\d+)?)\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('POST parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('GET parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ── OAuth Token Management ────────────────────────────────────────────────────

async function getToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (fs.existsSync(TOKEN_CACHE)) {
    const cache = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    if (cache.expiresAt > Date.now() + 5 * 60 * 1000) {
      return cache.access_token;
    }
  }

  console.log('  Refreshing eBay OAuth token...');
  const encoded = Buffer.from(`${ebay.appId}:${ebay.certId}`).toString('base64');
  const resp = await httpsPost(
    'https://api.ebay.com/identity/v1/oauth2/token',
    {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${encoded}`,
    },
    'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  );

  if (!resp.access_token) throw new Error('Token fetch failed: ' + JSON.stringify(resp));

  const cache = {
    access_token: resp.access_token,
    expiresAt:    Date.now() + (resp.expires_in * 1000),
  };
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(cache));
  return cache.access_token;
}

// ── Title Parser ──────────────────────────────────────────────────────────────

function parseTitle(title) {
  const upper = title.toUpperCase();

  // Graded detection
  const gradeMatch = GRADE_REGEX.exec(title);
  const isGraded   = !!gradeMatch;
  const grader     = gradeMatch ? gradeMatch[1].toUpperCase() : null;
  const grade      = gradeMatch ? parseFloat(gradeMatch[2]) : null;

  // Condition keywords (for ungraded)
  let condition = null;
  if (!isGraded) {
    if (upper.includes('NEAR MINT') || upper.includes('NM'))         condition = 'Near Mint';
    else if (upper.includes('LIGHTLY PLAYED') || upper.includes('LP')) condition = 'Lightly Played';
    else if (upper.includes('MODERATELY PLAYED') || upper.includes('MP')) condition = 'Moderately Played';
    else if (upper.includes('HEAVILY PLAYED') || upper.includes('HP')) condition = 'Heavily Played';
    else if (upper.includes('DAMAGED') || upper.includes('DMG'))     condition = 'Damaged';
  }

  // First edition detection
  const isFirstEd = /1ST\s*ED|FIRST\s*ED|1ST\s*EDITION/i.test(title);

  // Shadowless detection (Base Set)
  const isShadowless = /SHADOWLESS/i.test(title);

  return { isGraded, grader, grade, condition, isFirstEd, isShadowless };
}

// ── eBay Search ───────────────────────────────────────────────────────────────

async function searchEbay(token, query, offset = 0) {
  const params = new URLSearchParams({
    q:            query,
    category_ids: CATEGORY_ID,
    limit:        String(PAGE_SIZE),
    offset:       String(offset),
    fieldgroups:  'MATCHING_ITEMS',
  });
  const url = `${BROWSE_BASE}?${params}`;
  return httpsGet(url, {
    'Authorization':            `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID':  'EBAY_US',
    'User-Agent':               'PokemonMarketData/1.0',
  });
}

// ── Card Matcher ──────────────────────────────────────────────────────────────
// Try to match an eBay listing title back to a card in our catalog.
// Uses card number pattern (e.g. "4/102" or "196/191") as the strongest signal.

function matchCard(title, setCards) {
  // Try to extract card number from title: "4/102", "196/191", "SV001/SV122"
  const numMatch = /\b(\w+)\/(\w+)\b/.exec(title);
  if (numMatch) {
    const rawNum = numMatch[1];
    // Strip leading zeros
    const num = /^\d+$/.test(rawNum) ? String(parseInt(rawNum, 10)) : rawNum;
    const byNum = setCards.filter(c => c.number === num);
    if (byNum.length === 1) return byNum[0];
    if (byNum.length > 1) {
      // Multiple cards with same number (shouldn't happen often) — try name match
      const nameMatch = title.toLowerCase();
      return byNum.find(c => nameMatch.includes(c.name.toLowerCase())) || byNum[0];
    }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(EBAY_DIR);

  const sets  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sets.json'), 'utf8'));
  const cards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));

  // Group cards by setId for fast lookup during matching
  const cardsBySet = {};
  for (const c of cards) {
    if (!cardsBySet[c.setId]) cardsBySet[c.setId] = [];
    cardsBySet[c.setId].push(c);
  }

  // Load or start today's output file
  const outFile  = path.join(EBAY_DIR, `${TODAY}.json`);
  const existing = fs.existsSync(outFile)
    ? JSON.parse(fs.readFileSync(outFile, 'utf8'))
    : [];
  const seenSets = new Set(existing.map(r => r.setId));

  console.log('\n── eBay Browse API Fetch ─────────────────────');
  console.log(`  Cards: ${cards.length.toLocaleString()}  |  Sets: ${sets.length}`);
  console.log(`  Output: ${path.relative(__dirname, outFile)}`);
  if (seenSets.size) console.log(`  Skipping ${seenSets.size} already-fetched sets`);

  const results  = [...existing];
  let   token    = await getToken();
  let   apiCalls = 0;

  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    if (seenSets.has(set.id)) continue;

    const setCards = cardsBySet[set.id] || [];
    if (!setCards.length) continue;

    // Build search query: "<set name> pokemon card"
    const query   = `${set.name} pokemon card`;
    let   offset  = 0;
    let   fetched = 0;
    let   total   = Infinity;

    while (offset < total && offset < 1000) {  // cap at 1000 results per set
      // Refresh token if needed
      if (apiCalls % 100 === 0) token = await getToken();

      try {
        await sleep(DELAY_MS);
        const resp = await searchEbay(token, query, offset);
        apiCalls++;

        if (resp.errors) {
          console.warn(`\n  WARN [${set.id}]: ${JSON.stringify(resp.errors[0])}`);
          break;
        }

        total = Math.min(resp.total || 0, 1000);
        const items = resp.itemSummaries || [];
        if (!items.length) break;

        for (const item of items) {
          const parsed   = parseTitle(item.title || '');
          const matched  = matchCard(item.title || '', setCards);

          results.push({
            date:         TODAY,
            setId:        set.id,
            cardId:       matched?.id || null,
            cardName:     matched?.name || null,
            ebayItemId:   item.itemId,
            title:        item.title,
            price:        parseFloat(item.price?.value || 0),
            currency:     item.price?.currency || 'USD',
            condition:    item.condition || null,
            conditionId:  item.conditionId || null,
            // Grading info parsed from title
            isGraded:     parsed.isGraded,
            grader:       parsed.grader,
            grade:        parsed.grade,
            titleCondition: parsed.condition,
            isFirstEd:    parsed.isFirstEd,
            isShadowless: parsed.isShadowless,
            // Listing metadata
            buyingOptions: (item.buyingOptions || []).join('|'),
            seller:       item.seller?.username || null,
            itemUrl:      item.itemWebUrl || null,
          });
        }

        fetched += items.length;
        offset  += PAGE_SIZE;  // must be a fixed multiple of limit, not items.length

      } catch (err) {
        console.warn(`\n  WARN [${set.id}] offset ${offset}: ${err.message}`);
        break;
      }
    }

    process.stdout.write(`\r  [${i+1}/${sets.length}] ${set.name.padEnd(30)} ${fetched} listings  (${apiCalls} API calls)`);

    // Save progress every 10 sets in case of interruption
    if ((i + 1) % 10 === 0) {
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    }
  }

  // Final save
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  // ── Summary ────────────────────────────────────────────────────────────────
  const matched   = results.filter(r => r.cardId).length;
  const graded    = results.filter(r => r.isGraded).length;
  const psa10     = results.filter(r => r.grader === 'PSA' && r.grade === 10).length;

  console.log(`\n\n── Summary ───────────────────────────────────`);
  console.log(`  Total listings   : ${results.length.toLocaleString()}`);
  console.log(`  Matched to cards : ${matched.toLocaleString()}`);
  console.log(`  Graded listings  : ${graded.toLocaleString()}`);
  console.log(`    PSA 10         : ${psa10.toLocaleString()}`);
  console.log(`  API calls made   : ${apiCalls}`);
  console.log(`\nDone. Saved to ${path.relative(__dirname, outFile)}\n`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
