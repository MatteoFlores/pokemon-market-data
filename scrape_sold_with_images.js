/**
 * scrape_sold_with_images.js
 *
 * Combined scraper: scrapes eBay sold listings AND immediately downloads
 * images for every PSA/BGS/CGC-graded listing found.
 *
 * Picks up exactly where scrape_ebay_sold.js left off (reads its _progress.json).
 * Also skips any image itemIds already in data/images/_progress.json, so it
 * plays nicely with a parallel download_images.js run on older data.
 *
 * Stops after completing a whole series so you can check disk space before
 * committing to the rest of the catalog.
 *
 * Usage:
 *   node scrape_sold_with_images.js                   (default: stop after Black & White)
 *   node scrape_sold_with_images.js "Sun & Moon"      (stop after a different series)
 *   node scrape_sold_with_images.js all               (no stop — run every set)
 *
 * Series stop options (cumulative set counts):
 *   Base               →  6 sets  (base5)
 *   Gym                →  8 sets  (gym2)
 *   Neo                → 12 sets  (neo4)
 *   E-Card             → 30 sets  (ecard3)
 *   EX                 → 50 sets  (ex16)
 *   Diamond & Pearl    → 68 sets  (dp7)
 *   Platinum           → 72 sets  (pl4)
 *   HeartGold & SoulSilver → 78 sets (col1)
 *   Black & White      → 91 sets  (bw11)   ← default checkpoint (~53%)
 *   XY                 → 107 sets (xy12)
 *   Sun & Moon         → 125 sets (sm12)
 *   Sword & Shield     → 150 sets (swsh12pt5gg)
 *   Scarlet & Violet   → 168 sets (rsv10pt5)
 *   all                → all 172 sets
 *
 * Output:
 *   data/ebay_sold/{setId}/{cardId}.json   (same format as scrape_ebay_sold.js)
 *   data/ebay_sold/_progress.json          (shared with scrape_ebay_sold.js)
 *   data/images/{itemId}/*.jpg
 *   data/images/{itemId}/_meta.json
 *   data/images/_progress.json             (shared with download_images.js)
 */

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio       = require('cheerio');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const urlLib        = require('url');

puppeteer.use(StealthPlugin());

// ── Coordinator (optional) ────────────────────────────────────────────────────
// If config.json exists the scraper uses Google Sheets to coordinate with other
// machines.  Without it, the scraper runs in standalone mode (original behaviour).

const CONFIG_PATH = path.join(__dirname, 'config.json');
let coordinator   = null;
let coordRowNum   = null;   // row in the sheet for the set we claimed

function loadCoordinator() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const { Coordinator } = require('./coordinator');
    return new Coordinator(config);
  } catch (e) {
    console.warn(`WARN: Could not load coordinator — ${e.message}`);
    console.warn('      Running in standalone mode.\n');
    return null;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(__dirname, 'data');
const SOLD_DIR       = path.join(DATA_DIR, 'ebay_sold');
const IMAGES_DIR     = path.join(DATA_DIR, 'images');
const SOLD_PROG_F    = path.join(SOLD_DIR,   '_progress.json');
const IMG_PROG_F     = path.join(IMAGES_DIR, '_progress.json');

// In coordinator mode this is ignored (the sheet picks the set).
const STOP_AFTER_ARG  = process.argv[2] || 'Black & White';
const DELAY_MIN       = 2000;   // scrape search-page delay (ms)
const DELAY_MAX       = 4000;
const IMG_DELAY_MIN   = 400;    // listing page visit delay — CDN, much lighter
const IMG_DELAY_MAX   = 900;
const MAX_PAGES       = 20;
const ITEMS_PER_PG    = 240;
const IMG_DL_PARALLEL = 8;      // simultaneous image downloads per listing

// Series → last set ID in that series (for stop logic)
const SERIES_LAST_SET = {
  'Base':                        'base5',
  'Gym':                         'gym2',
  'Neo':                         'neo4',
  'E-Card':                      'ecard3',
  'EX':                          'ex16',
  'Diamond & Pearl':             'dp7',
  'Platinum':                    'pl4',
  'HeartGold & SoulSilver':      'col1',
  'Black & White':               'bw11',
  'XY':                          'xy12',
  'Sun & Moon':                  'sm12',
  'Sword & Shield':              'swsh12pt5gg',
  'Scarlet & Violet':            'rsv10pt5',
  'Mega Evolution':              'me3',
  'all':                         null,   // special: no stop
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d)    { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)       { return new Promise(r => setTimeout(r, ms)); }
function randDelay()     { return sleep(DELAY_MIN     + Math.random() * (DELAY_MAX     - DELAY_MIN)); }
function randImgDelay()  { return sleep(IMG_DELAY_MIN + Math.random() * (IMG_DELAY_MAX - IMG_DELAY_MIN)); }
function ts()            { return new Date().toTimeString().slice(0, 8); } // HH:MM:SS

function loadJSON(f, fallback) {
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback;
}

function dirSizeMB(dir) {
  let bytes = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    try {
      const stat = fs.statSync(path.join(dir, f));
      if (stat.isFile()) bytes += stat.size;
    } catch (_) {}
  }
  return (bytes / 1024 / 1024).toFixed(1);
}

// ── Classification (same as scrape_ebay_sold.js) ──────────────────────────────

function detectEdition(title) {
  const t = title.toUpperCase();
  if (/1ST\s*ED(ITION)?|FIRST\s*ED(ITION)?/.test(t)) return '1st Edition';
  if (/SHADOWLESS/.test(t))                             return 'Shadowless';
  return 'Unlimited';
}

function detectGrading(title) {
  const patterns = [
    { re: /\bPSA\s*(\d+(?:\.\d+)?)\b/i,     grader: 'PSA' },
    { re: /\bBGS\s*(\d+(?:\.\d+)?)\b/i,     grader: 'BGS' },
    { re: /\bBECKETT\s*(\d+(?:\.\d+)?)\b/i, grader: 'BGS' },
    { re: /\bCGC\s*(\d+(?:\.\d+)?)\b/i,     grader: 'CGC' },
    { re: /\bSGC\s*(\d+(?:\.\d+)?)\b/i,     grader: 'Other' },
    { re: /\bHGA\s*(\d+(?:\.\d+)?)\b/i,     grader: 'Other' },
    { re: /\bACE\s*(\d+(?:\.\d+)?)\b/i,     grader: 'Other' },
    { re: /\bCSG\s*(\d+(?:\.\d+)?)\b/i,     grader: 'Other' },
    { re: /\bGMA\s*(\d+(?:\.\d+)?)\b/i,     grader: 'Other' },
  ];
  for (const { re, grader } of patterns) {
    const m = re.exec(title);
    if (m) return { graded: true, grader, grade: parseFloat(m[1]) };
  }
  if (/\bGRADED\b/i.test(title)) return { graded: true, grader: 'Other', grade: null };
  return { graded: false, grader: null, grade: null };
}

function detectCondition(title, ebayConditionLabel) {
  const t  = title.toUpperCase();
  const el = (ebayConditionLabel || '').toUpperCase();
  const labelMap = {
    'NEAR MINT OR BETTER': 'NM', 'NEAR MINT': 'NM', 'MINT': 'NM',
    'LIGHTLY PLAYED':    'LP',
    'MODERATELY PLAYED': 'MP',
    'HEAVILY PLAYED':    'HP',
    'DAMAGED':           'Damaged',
    'POOR':              'Damaged',
  };
  for (const [key, val] of Object.entries(labelMap)) {
    if (el.includes(key)) return val;
  }
  if (/NEAR\s*MINT|[\s(]NM[\s)\-/]|NM\/MINT/.test(t)) return 'NM';
  if (/\bMINT\b/.test(t) && !/NEAR/.test(t))           return 'NM';
  if (/LIGHTLY\s*PLAYED|[\s(]LP[\s)\-/]/.test(t))      return 'LP';
  if (/MODERATELY\s*PLAYED|[\s(]MP[\s)\-/]/.test(t))   return 'MP';
  if (/HEAVILY\s*PLAYED|[\s(]HP[\s)\-/]/.test(t))      return 'HP';
  if (/\bDAMAGED\b|\bDMG\b/.test(t))                   return 'Damaged';
  return 'Unspecified';
}

function parseSoldDate(text) {
  if (!text) return null;
  const d = new Date(text.replace(/sold\s*/i, '').trim());
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ── Mismatch / Misleading-Listing Detection ───────────────────────────────────
//
// Flags listings that are probably NOT the card being searched.
// Adds potentialMismatch: bool and mismatchFlags: string[] to each listing.
// Flagged items are kept — they are excluded from price analysis downstream.

function validateListing(listing, card, set) {
  const flags = [];
  const title = listing.title;

  // 1. Lot / bundle — not a single-card sale
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

  // 4. Wrong card number or wrong set total in title
  //    card.number = "4", card.setTotal = 102
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

  // 5. Base Set vs Base Set 2 confusion
  //    base1 = 102 cards, base2 = 130 cards
  if (set.id === 'base1') {
    if (/base\s*set\s*2|\bbase\s*2\b|\bbs2\b/i.test(title)) {
      flags.push('base_set_2_confusion');
    }
  }

  // 6. Suspiciously cheap for a graded card (likely a slab photo / print)
  if (listing.graded && listing.price < 4) {
    flags.push('suspiciously_low_graded_price');
  }

  listing.potentialMismatch = flags.length > 0;
  listing.mismatchFlags     = flags;
  return listing;
}

// ── HTML Parser (sold listings search page) ───────────────────────────────────

function parseListings(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('li.s-card').each((_, el) => {
    const item      = $(el);
    const title     = item.find('span.su-styled-text.primary').first().text().trim();
    if (!title) return;
    const priceTags = item.find('span.s-card__price');
    if (priceTags.length > 1) return;
    const price     = parseFloat(priceTags.first().text().replace(/[^0-9.]/g, ''));
    if (!price || price <= 0) return;
    const soldDate  = parseSoldDate(item.find('span.su-styled-text.positive.default').first().text().trim());
    if (!soldDate) return;
    const condLabel = item.find('span.su-styled-text.secondary.default').first().text().trim();
    const href      = item.find('a.s-card__link').first().attr('href') || '';
    const idMatch   = /\/itm\/(\d+)/.exec(href);
    if (!idMatch) return;
    out.push({ itemId: idMatch[1], title, price, soldDate, condLabel, href });
  });

  return { listings: out, hasNext: html.includes('pagination__next') };
}

// ── Fetch sold search page ────────────────────────────────────────────────────

async function fetchPage(tab, query, pageNum) {
  const params = new URLSearchParams({
    _nkw: query, LH_Complete: '1', LH_Sold: '1',
    _sacat: '2536', _ipg: String(ITEMS_PER_PG), _pgn: String(pageNum), _sop: '10',
  });
  await tab.goto('https://www.ebay.com/sch/i.html?' + params, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await sleep(1500);
  const title = await tab.title();
  if (title.includes('Pardon') || title.includes('Checking')) await sleep(6000);
  return tab.content();
}

// ── Build search queries (same as scrape_ebay_sold.js) ───────────────────────

function buildQueries(card, setName) {
  const base = `${card.name} ${card.number}/${card.setTotal} ${setName} pokemon`;
  return [
    `${base} near mint`,
    `${base} lightly played`,
    `${base} moderately played`,
    `${base} heavily played`,
    `${base} damaged`,
    `${base} PSA`,
    `${base} BGS`,
    `${base} CGC`,
    base,
  ];
}

// ── Scrape sold listings for one card ────────────────────────────────────────

// cutoffDate: YYYY-MM-DD string.  When set, stops paginating a query once
// every listing on a page is older than this date (eBay is newest-first).
async function scrapeCard(tab, card, set, cutoffDate = null) {
  const setName = set.name;
  const seen    = new Set();
  const rawList = [];

  for (const query of buildQueries(card, setName)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      await randDelay();
      try {
        const html = await fetchPage(tab, query, page);
        const { listings, hasNext } = parseListings(html);
        let hitCutoff = false;
        for (const item of listings) {
          if (seen.has(item.itemId)) continue;
          seen.add(item.itemId);
          rawList.push(item);
        }
        // If every result on this page predates our cutoff we've caught up —
        // no need to fetch deeper pages for this query.
        if (cutoffDate && listings.length > 0 &&
            listings.every(l => l.soldDate && l.soldDate <= cutoffDate)) {
          hitCutoff = true;
        }
        if (!hasNext || hitCutoff) break;
      } catch (err) {
        console.warn(`\n    WARN [${card.id}] q="${query}" pg=${page}: ${err.message}`);
        break;
      }
    }
  }

  // Classify each listing
  const listings = rawList.map(item => {
    const grading   = detectGrading(item.title);
    const edition   = detectEdition(item.title);
    const condition = grading.graded ? 'Graded' : detectCondition(item.title, item.condLabel);
    return {
      itemId:          item.itemId,
      soldDate:        item.soldDate,
      price:           item.price,
      title:           item.title,
      edition,         // '1st Edition' | 'Shadowless' | 'Unlimited'
      condition,       // 'NM' | 'LP' | 'MP' | 'HP' | 'Damaged' | 'Unspecified' | 'Graded'
      graded:          grading.graded,
      grader:          grading.grader,   // 'PSA' | 'BGS' | 'CGC' | 'Other' | null
      grade:           grading.grade,    // numeric grade or null
      url:             item.href,
      potentialOutlier: false,
    };
  });

  // Outlier flagging per edition+condition bucket
  const buckets = {};
  for (const l of listings) {
    const key = `${l.edition}||${l.condition}||${l.grader || 'raw'}`;
    (buckets[key] = buckets[key] || []).push(l);
  }
  for (const group of Object.values(buckets)) {
    const prices = group.map(l => l.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const n = prices.length;
    // Lower threshold scales with sample size: rare cards with few sales have
    // naturally wide price swings, so we allow more variance.
    //   n=1  → 50%,  n=4  → 25%,  n=9  → 17%,  n≥12 → 15% floor
    const lowerThresh = Math.max(0.15, 0.50 / Math.sqrt(n));
    for (const l of group) {
      if (l.price > median * 5)              { l.potentialOutlier = true; l.outlierDirection = 'high'; }
      else if (l.price < median * lowerThresh) { l.potentialOutlier = true; l.outlierDirection = 'low';  }
      else                                     { l.outlierDirection = null; }
    }
  }

  // Mismatch / misleading-listing detection
  for (const l of listings) validateListing(l, card, set);

  return listings;
}

// ── Download images for a single eBay item ───────────────────────────────────

function downloadFile(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new urlLib.URL(imageUrl);
    const lib    = parsed.protocol === 'https:' ? https : http;
    let file;
    try {
      file = fs.createWriteStream(destPath);
    } catch (err) {
      return reject(err);
    }
    // Attach error handler immediately — before any async op — so EPERM and
    // other stream errors are always caught even if they fire synchronously.
    file.on('error', err => { try { file.close(); } catch (_) {} fs.unlink(destPath, () => {}); reject(err); });
    lib.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlink(destPath, () => {});
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { try { file.close(); } catch (_) {} fs.unlink(destPath, () => {}); reject(err); });
  });
}

async function fetchItemImageUrls(tab, itemId) {
  const listingUrl = `https://www.ebay.com/itm/${itemId}`;
  try {
    await tab.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1200);
    const title = await tab.title();
    if (title.includes('Pardon') || title.includes('Checking')) await sleep(6000);

    return await tab.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll(
        'div.ux-image-carousel-item img, div.img-cover img, img.img'
      ).forEach(img => {
        const src = img.dataset.src || img.src || '';
        if (src.includes('i.ebayimg.com') && !src.includes('s-l64')) {
          urls.add(src.replace(/s-l\d+/, 's-l1600'));
        }
      });
      document.querySelectorAll('img[src*="i.ebayimg.com"]').forEach(img => {
        const src = img.src || '';
        if (!src.includes('s-l64') && !src.includes('s-l96')) {
          urls.add(src.replace(/s-l\d+/, 's-l1600'));
        }
      });
      return [...urls];
    });
  } catch (err) {
    return [];
  }
}

async function downloadImagesForListing(tab, listing, cardMeta, imgProgress) {
  const { itemId } = listing;
  if (imgProgress[itemId]?.done) return;

  const itemDir = path.join(IMAGES_DIR, itemId);

  try {
    // Shorter delay — we're visiting a listing page, not hammering search
    await randImgDelay();
    const imageUrls = await fetchItemImageUrls(tab, itemId);

    if (!imageUrls.length) {
      imgProgress[itemId] = { done: false, error: 'no images found' };
      return;
    }

    ensureDir(itemDir);

    fs.writeFileSync(
      path.join(itemDir, '_meta.json'),
      JSON.stringify({
        itemId,
        cardId:      cardMeta.cardId,
        cardName:    cardMeta.cardName,
        setId:       cardMeta.setId,
        setName:     cardMeta.setName,
        grade:       listing.grade,
        grader:      listing.grader,
        edition:     listing.edition,
        price:       listing.price,
        soldDate:    listing.soldDate,
        title:       listing.title,
        url:         listing.url,
        imageUrls,
        downloadedAt: new Date().toISOString(),
      }, null, 2)
    );

    // Download all images in parallel batches instead of one-by-one
    let savedCount = 0;
    for (let i = 0; i < imageUrls.length; i += IMG_DL_PARALLEL) {
      const batch = imageUrls.slice(i, i + IMG_DL_PARALLEL);
      const results = await Promise.allSettled(
        batch.map((url, j) => downloadFile(url, path.join(itemDir, `${i + j + 1}.jpg`)))
      );
      savedCount += results.filter(r => r.status === 'fulfilled').length;
    }

    imgProgress[itemId] = {
      done:         true,
      imageCount:   savedCount,
      cardId:       cardMeta.cardId,
      grade:        listing.grade,
      downloadedAt: new Date().toISOString(),
    };
  } catch (err) {
    imgProgress[itemId] = { done: false, error: err.message };
  }
}

// ── Work queue builders ───────────────────────────────────────────────────────

// Returns the newest soldDate from an existing card JSON file, or null.
function newestSoldDate(cardJsonPath) {
  if (!fs.existsSync(cardJsonPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cardJsonPath, 'utf8'));
    const dates = (data.listings || []).map(l => l.soldDate).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : null;
  } catch (_) { return null; }
}

// Build work queue for a specific set.
//   - Fresh cards (never scraped) get cutoffDate = null → full scrape.
//   - Stale cards (scraped >STALE_SCRAPE_DAYS ago) get cutoffDate = newest
//     existing soldDate so we only fetch newer listings.
//   - Also re-queues failed image downloads for all cards in the set.
function buildSetWorkQueue(setId, soldProgress, imgProgress, allCards, allSets) {
  const { STALE_SCRAPE_DAYS } = require('./coordinator');
  const set     = allSets.find(s => s.id === setId);
  if (!set) throw new Error(`Unknown setId: ${setId}`);
  const setTotal = set.printedTotal || set.total;
  const setCards = allCards.filter(c => c.setId === setId);
  const nowMs    = Date.now();

  const scrapeQueue = [];   // { card, set, cutoffDate }
  const imgRetries  = [];   // { listing, cardMeta } — failed image downloads

  for (const card of setCards) {
    card.setTotal = setTotal;
    const prog = soldProgress[card.id];

    if (!prog?.done) {
      // Never successfully scraped
      scrapeQueue.push({ card, set, cutoffDate: null });
    } else {
      const scrapedMs = prog.scrapedAt ? new Date(prog.scrapedAt).getTime() : 0;
      const daysAgo   = (nowMs - scrapedMs) / 86_400_000;
      if (daysAgo >= STALE_SCRAPE_DAYS) {
        // Stale — incremental re-scrape from newest listing we already have
        const cardJsonPath = path.join(SOLD_DIR, setId, `${card.id}.json`);
        const cutoffDate   = newestSoldDate(cardJsonPath);
        scrapeQueue.push({ card, set, cutoffDate });
      }
      // Either way, recover failed image downloads for this card
      const cardJsonPath = path.join(SOLD_DIR, setId, `${card.id}.json`);
      if (fs.existsSync(cardJsonPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(cardJsonPath, 'utf8'));
          const cardMeta = { cardId: card.id, cardName: card.name, setId, setName: set.name };
          for (const l of (data.listings || [])) {
            if ((l.grader === 'PSA' || l.grader === 'BGS' || l.grader === 'CGC') &&
                l.outlierDirection !== 'low' && !l.potentialMismatch &&
                !imgProgress[l.itemId]?.done) {
              imgRetries.push({ listing: l, cardMeta });
            }
          }
        } catch (_) {}
      }
    }
  }

  return { scrapeQueue, imgRetries, set };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(SOLD_DIR);
  ensureDir(IMAGES_DIR);

  // Worker counts: default 2 scrape + 3 image workers.
  //   Standalone:    node scrape_sold_with_images.js all 2 3
  //   Coordinator:   node scrape_sold_with_images.js       (no args needed)
  const SCRAPE_WORKERS = Math.max(1, parseInt(process.argv[3]) || 2);
  const IMG_WORKERS    = Math.max(1, parseInt(process.argv[4]) || 3);

  const allCards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));
  const allSets  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sets.json'),  'utf8'));

  // ── Coordinator mode (config.json exists) ─────────────────────────────────
  coordinator = loadCoordinator();
  if (coordinator) await coordinator.init();

  // Coordinator loops automatically through all sets; standalone runs once.
  while (true) {
    coordRowNum = null;

    // Reload progress files fresh each iteration so incremental mode sees
    // cards that were completed by previous iterations or other machines.
    const soldProgress = loadJSON(SOLD_PROG_F, {});
    const imgProgress  = loadJSON(IMG_PROG_F,  {});

    let workQueue;           // { card, set, cutoffDate }[]
    let activeSetId   = null;
    let activeSetName = null;

    if (coordinator) {
      // Find the best unclaimed / stale set
      let best;
      try {
        best = await coordinator.findBestSet();
      } catch (e) {
        console.error(`\n  Coordinator error (findBestSet): ${e.message}`);
        console.error('  If you see "invalid_grant", sync your system clock and restart.\n');
        break;
      }
      if (!best) {
        console.log('\nAll sets are up to date or currently being scraped by another machine.\n');
        break;
      }

      // Claim it — re-check to handle race conditions with other scrapers
      let claimed;
      try {
        claimed = await coordinator.claimSet(best.rowNum);
      } catch (e) {
        console.error(`\n  Coordinator error (claimSet): ${e.message}\n`);
        break;
      }
      if (!claimed) {
        console.log(`\nSet ${best.setId} was just claimed by another scraper. Retrying in 10s...\n`);
        await sleep(10000);
        continue;
      }

      coordRowNum   = best.rowNum;
      activeSetId   = best.setId;
      const setObj  = allSets.find(s => s.id === activeSetId);
      activeSetName = setObj?.name || activeSetId;

      console.log(`\n  Coordinator mode — claimed set: ${activeSetName} (${activeSetId})`);
      if (best.lastScrapedAt) {
        console.log(`  Last scraped: ${best.lastScrapedAt} — incremental re-scrape`);
      }

      ensureDir(path.join(SOLD_DIR, activeSetId));
      const { scrapeQueue, imgRetries } = buildSetWorkQueue(
        activeSetId, soldProgress, imgProgress, allCards, allSets
      );
      // Pre-load image retry queue; scrape queue is the work queue
      workQueue = scrapeQueue;
      // Seed imgQueue with retries after browser is up (see below)
      coordinator._imgRetries = imgRetries;

    } else {
      // ── Standalone mode (original behaviour) ────────────────────────────
      if (STOP_AFTER_ARG !== 'all' && !SERIES_LAST_SET[STOP_AFTER_ARG]) {
        console.error(`Unknown series: "${STOP_AFTER_ARG}"`);
        console.error('Valid options:', Object.keys(SERIES_LAST_SET).join(', '), 'all');
        process.exit(1);
      }
      const stopLastSetId = STOP_AFTER_ARG === 'all' ? null : SERIES_LAST_SET[STOP_AFTER_ARG];

      workQueue = [];
      for (const set of allSets) {
        const setCards = allCards.filter(c => c.setId === set.id);
        const setTotal = set.printedTotal || set.total;
        for (const card of setCards) {
          if (!soldProgress[card.id]?.done) {
            card.setTotal = setTotal;
            workQueue.push({ card, set, cutoffDate: null });
          }
        }
        if (stopLastSetId && set.id === stopLastSetId) break;
      }
    }

    if (!workQueue.length && !(coordinator?._imgRetries?.length)) {
      console.log('\nNothing to scrape for this set — all cards are up to date.');
      if (coordRowNum) {
        const setCards  = allCards.filter(c => c.setId === activeSetId);
        const cardsDone = setCards.filter(c => soldProgress[c.id]?.done).length;
        const listings  = setCards.reduce((a, c) => a + (soldProgress[c.id]?.count || 0), 0);
        await coordinator.releaseSet(coordRowNum, {
          cardsDone, listingsTotal: listings, failedCards: 0,
        }).catch(() => {});
        console.log(`Marked "${activeSetName}" as done in sheet. Moving to next set...\n`);
        continue;
      }
      break;
    }

    // Pre-create output directories
    const seenSetDirs = new Set();
    for (const { set } of workQueue) {
      if (!seenSetDirs.has(set.id)) {
        ensureDir(path.join(SOLD_DIR, set.id));
        seenSetDirs.add(set.id);
      }
    }

    const totalQueued = workQueue.length;

    const modeLabel = coordinator
      ? `Coordinator mode — set: ${activeSetName}`
      : `Standalone mode — stop after: ${STOP_AFTER_ARG}`;

    console.log('\n── scrape_sold_with_images.js ────────────────────────────────');
    console.log(`  Mode               : ${modeLabel}`);
    console.log(`  Scrape workers     : ${SCRAPE_WORKERS}  (search queries, 2-4s delay each)`);
    console.log(`  Image workers      : ${IMG_WORKERS}  (listing pages, 0.4-0.9s delay, parallel DL)`);
    console.log(`  Cards pending      : ${totalQueued.toLocaleString()}`);

    // ── Serialised file saves (promise-chain mutex) ──────────────────────────
    let soldSaveLock = Promise.resolve();
    let imgSaveLock  = Promise.resolve();
    const saveSold = () => {
      soldSaveLock = soldSaveLock.then(() =>
        fs.promises.writeFile(SOLD_PROG_F, JSON.stringify(soldProgress, null, 2))
      );
    };
    const saveImgs = () => {
      imgSaveLock = imgSaveLock.then(() =>
        fs.promises.writeFile(IMG_PROG_F, JSON.stringify(imgProgress, null, 2))
      );
    };

    // ── Shared image download queue (producer-consumer) ──────────────────────
    // Scrape workers push here; image workers drain it concurrently.
    // Pre-seed with any failed image retries from coordinator mode.
    const imgQueue   = coordinator?._imgRetries ? [...coordinator._imgRetries] : [];
    let scrapersDone = false;

    // ── Launch browser ───────────────────────────────────────────────────────
    const totalTabs = SCRAPE_WORKERS + IMG_WORKERS;
    console.log(`\nLaunching browser with ${totalTabs} tabs (stealth)...`);
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const allTabs = await Promise.all(
      Array.from({ length: totalTabs }, () => browser.newPage())
    );
    await Promise.all(allTabs.map(t => t.setViewport({ width: 1366, height: 768 })));

    const scrapeTabs = allTabs.slice(0, SCRAPE_WORKERS);
    const imgTabs    = allTabs.slice(SCRAPE_WORKERS);

    // Warm up only the scrape tabs — image tabs don't need the eBay cookie warmup
    console.log('Warming up scrape tabs...');
    await Promise.all(scrapeTabs.map(t =>
      t.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
    ));
    await sleep(2000);

    // ── Shared counters ──────────────────────────────────────────────────────
    let totalCards = 0, totalListings = 0, totalImgDownloads = 0, completed = 0;
    let totalFailed = 0;

    // Heartbeat: update coordinator every 10 completed cards so the 2-hour
    // stale-claim timer resets and progress is visible in the sheet.
    const HEARTBEAT_EVERY = 10;
    async function maybeHeartbeat() {
      if (!coordinator || !coordRowNum) return;
      if (completed % HEARTBEAT_EVERY !== 0) return;
      try {
        await coordinator.heartbeat(coordRowNum, {
          cardsDone:     completed,
          listingsTotal: totalListings,
          failedCards:   totalFailed,
        });
      } catch (_) {} // non-fatal — don't crash the scraper over a sheet write
    }

    // Recover a tab after eBay detection (detached frame / bot check).
    // Navigates back to eBay homepage and waits for things to settle.
    async function recoverTab(tab, tag) {
      console.log(`[${ts()}] ${tag} Tab recovery — reloading eBay...`);
      try {
        await tab.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(5000 + Math.random() * 5000); // 5-10s cooldown
      } catch (_) {}
    }

    // ── Scrape workers: search eBay, save listings, push to imgQueue ─────────
    async function scraperWorker(tab, id) {
      const tag = `[S${id}]`;
      let consecutiveDetached = 0;  // track repeated detached-frame errors
      while (workQueue.length > 0) {
        const item = workQueue.shift();
        if (!item) break;
        const { card, set, cutoffDate } = item;

        // In standalone mode skip if already done; in coordinator mode
        // cutoffDate being set means we intentionally re-scrape for new listings.
        if (!cutoffDate && soldProgress[card.id]?.done) continue;

        const modeTag = cutoffDate ? ` (since ${cutoffDate})` : '';
        console.log(`[${ts()}] ${tag} ${card.id.padEnd(14)} ${card.name.padEnd(22)} scraping...${modeTag}`);
        try {
          const newListings = await scrapeCard(tab, card, set, cutoffDate);
          consecutiveDetached = 0; // reset on success

          // Incremental merge: keep existing listings, prepend newly found ones
          let listings = newListings;
          const cardJsonPath = path.join(SOLD_DIR, set.id, `${card.id}.json`);
          if (cutoffDate && fs.existsSync(cardJsonPath)) {
            try {
              const existing    = JSON.parse(fs.readFileSync(cardJsonPath, 'utf8'));
              const existingIds = new Set((existing.listings || []).map(l => l.itemId));
              const truly_new   = newListings.filter(l => !existingIds.has(l.itemId));
              listings = [...truly_new, ...(existing.listings || [])];
            } catch (_) {}
          }

          const output = {
            cardId: card.id, name: card.name, setId: card.setId, setName: set.name,
            number: card.number, rarity: card.rarity,
            scrapedAt: new Date().toISOString(), totalListings: listings.length, listings,
          };
          fs.writeFileSync(cardJsonPath, JSON.stringify(output, null, 2));
          soldProgress[card.id] = { done: true, count: listings.length, scrapedAt: output.scrapedAt };
          saveSold();

          totalCards++;
          totalListings += listings.length;
          completed++;

          // Push eligible graded listings to the image queue
          const cardMeta = { cardId: card.id, cardName: card.name, setId: card.setId, setName: set.name };
          const eligible  = listings.filter(l =>
            (l.grader === 'PSA' || l.grader === 'BGS' || l.grader === 'CGC') &&
            l.outlierDirection !== 'low' && !l.potentialMismatch &&
            !imgProgress[l.itemId]?.done
          );
          for (const listing of eligible) imgQueue.push({ listing, cardMeta });

          console.log(`[${ts()}] ${tag} ${card.id.padEnd(14)} ${card.name.padEnd(22)} ✓ ${listings.length} sold | ${eligible.length} queued for imgs  [${completed}/${totalQueued}]`);
          await maybeHeartbeat();
        } catch (err) {
          const isDetached = err.message?.includes('detached') || err.message?.includes('Execution context');
          if (isDetached) {
            consecutiveDetached++;
            console.warn(`[${ts()}] ${tag} WARN [${card.id}]: detached frame (${consecutiveDetached} in a row)`);
            // Put the card back so it gets retried after recovery
            workQueue.unshift(item);
            await recoverTab(tab, tag);
            // If still failing after 3 recovery attempts, skip and mark as failed
            if (consecutiveDetached >= 3) {
              workQueue.shift(); // remove it for real
              soldProgress[card.id] = { done: false, error: 'detached frame after recovery' };
              totalFailed++;
              consecutiveDetached = 0;
              saveSold();
            }
          } else {
            console.warn(`[${ts()}] ${tag} ERROR [${card.id}]: ${err.message}`);
            soldProgress[card.id] = { done: false, error: err.message };
            totalFailed++;
            saveSold();
          }
        }
      }
      console.log(`${tag} Done.`);
    }

    // ── Image workers: drain imgQueue until scrapers finish and queue empties ─
    async function imageWorker(tab, id) {
      const tag = `[I${id}]`;
      let idle = 0;
      while (true) {
        const item = imgQueue.shift();
        if (!item) {
          if (scrapersDone && imgQueue.length === 0) break;
          await sleep(500);   // wait for scrapers to produce more
          if (++idle % 20 === 0) console.log(`[${ts()}] ${tag} waiting for image queue...`);
          continue;
        }
        idle = 0;
        const { listing, cardMeta } = item;
        try {
          await downloadImagesForListing(tab, listing, cardMeta, imgProgress);
          if (imgProgress[listing.itemId]?.done) {
            totalImgDownloads++;
            saveImgs();
          }
        } catch (err) {
          console.warn(`[${ts()}] ${tag} img ERROR [${listing.itemId}]: ${err.message}`);
        }
      }
      console.log(`${tag} Done.`);
    }

    // ── Run both pools concurrently ──────────────────────────────────────────
    const scraperPromises = scrapeTabs.map((tab, i) => scraperWorker(tab, i + 1));
    const imgPromises     = imgTabs.map((tab, i)    => imageWorker(tab, i + 1));

    // When all scrapers finish, signal image workers to drain and exit
    Promise.all(scraperPromises).then(() => { scrapersDone = true; });

    await Promise.all([...scraperPromises, ...imgPromises]);

    await soldSaveLock;
    await imgSaveLock;
    await browser.close();

    // ── Release coordinator claim ────────────────────────────────────────────
    if (coordinator && coordRowNum) {
      try {
        await coordinator.releaseSet(coordRowNum, {
          cardsDone:     completed,
          listingsTotal: totalListings,
          failedCards:   totalFailed,
          notes:         totalFailed > 0 ? `${totalFailed} cards failed` : '',
        });
        console.log(`\n  Coordinator: released set "${activeSetName}" as done.`);
      } catch (e) {
        console.warn(`  WARN: could not update coordinator sheet — ${e.message}`);
      }
    }

    console.log('\n── Complete ─────────────────────────────────────────────────');
    console.log(`  Scrape workers       : ${SCRAPE_WORKERS}`);
    console.log(`  Image workers        : ${IMG_WORKERS}`);
    console.log(`  Cards scraped        : ${totalCards}`);
    console.log(`  Failed cards         : ${totalFailed}`);
    console.log(`  Total listings found : ${totalListings.toLocaleString()}`);
    console.log(`  Graded image sets    : ${totalImgDownloads.toLocaleString()}  (PSA/BGS/CGC)`);
    console.log(`  Images folder size   : ${dirSizeMB(IMAGES_DIR)} MB`);
    console.log(`  Sold data size       : ${dirSizeMB(SOLD_DIR)} MB`);
    if (!coordinator && STOP_AFTER_ARG !== 'all') {
      console.log(`\n  Stopped after "${STOP_AFTER_ARG}" series as requested.`);
      console.log(`  Re-run with next series name (or "all") to continue.`);
    }
    console.log();

    if (!coordinator) break; // standalone: single run, exit loop
    // coordinator: loop back and pick up the next available set
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
