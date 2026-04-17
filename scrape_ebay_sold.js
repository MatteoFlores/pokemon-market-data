/**
 * scrape_ebay_sold.js
 *
 * Scrapes eBay completed/sold listings for Pokemon cards.
 * Uses Puppeteer+stealth to bypass eBay bot challenge.
 *
 * Classifies each listing by:
 *   Edition   : 1st Edition | Shadowless | Unlimited
 *   Condition : NM | LP | MP | HP | Damaged | Unspecified | Graded
 *   Grading   : PSA | BGS | CGC | Other (with grade where present)
 *
 * Outlier flagging: >5x or <0.15x median flagged but kept.
 *
 * Usage:
 *   node scrape_ebay_sold.js              (base set default)
 *   node scrape_ebay_sold.js sv8
 *   node scrape_ebay_sold.js all
 *
 * Output:
 *   data/ebay_sold/{setId}/{cardId}.json
 *   data/ebay_sold/_progress.json
 */

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio       = require('cheerio');
const fs            = require('fs');
const path          = require('path');

puppeteer.use(StealthPlugin());

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR     = path.join(__dirname, 'data');
const SOLD_DIR     = path.join(DATA_DIR, 'ebay_sold');
const PROGRESS_F   = path.join(SOLD_DIR, '_progress.json');
const TARGET_SET   = process.argv[2] || 'base1';
const DELAY_MIN    = 2000;
const DELAY_MAX    = 4000;
const MAX_PAGES    = 20;
const ITEMS_PER_PG = 240;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function randDelay()  { return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)); }

// ── Classification ────────────────────────────────────────────────────────────

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

// ── HTML Parser ───────────────────────────────────────────────────────────────

function parseListings(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('li.s-card').each((_, el) => {
    const item      = $(el);
    const title     = item.find('span.su-styled-text.primary').first().text().trim();
    if (!title) return;
    const priceTags = item.find('span.s-card__price');
    if (priceTags.length > 1) return;   // price range = lot, skip
    const price     = parseFloat(priceTags.first().text().replace(/[^0-9.]/g, ''));
    if (!price || price <= 0) return;
    const soldDate  = parseSoldDate(item.find('span.su-styled-text.positive.default').first().text().trim());
    if (!soldDate) return;              // ghost/promo item
    const condLabel = item.find('span.su-styled-text.secondary.default').first().text().trim();
    const href      = item.find('a.s-card__link').first().attr('href') || '';
    const idMatch   = /\/itm\/(\d+)/.exec(href);
    if (!idMatch) return;
    out.push({ itemId: idMatch[1], title, price, soldDate, condLabel, href });
  });

  return { listings: out, hasNext: html.includes('pagination__next') };
}

// ── Page Fetcher ──────────────────────────────────────────────────────────────

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

// ── Per-card Scrape ───────────────────────────────────────────────────────────

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

async function scrapeCard(tab, card, setName) {
  const seen    = new Set();
  const rawList = [];

  for (const query of buildQueries(card, setName)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      await randDelay();
      try {
        const html = await fetchPage(tab, query, page);
        const { listings, hasNext } = parseListings(html);
        for (const item of listings) {
          if (seen.has(item.itemId)) continue;
          seen.add(item.itemId);
          rawList.push(item);
        }
        if (!hasNext) break;
      } catch (err) {
        console.warn(`\n    WARN [${card.id}] q="${query}" pg=${page}: ${err.message}`);
        break;
      }
    }
  }

  // Classify
  const listings = rawList.map(item => {
    const grading   = detectGrading(item.title);
    const edition   = detectEdition(item.title);
    const condition = grading.graded ? 'Graded' : detectCondition(item.title, item.condLabel);
    return {
      itemId:   item.itemId,
      soldDate: item.soldDate,
      price:    item.price,
      title:    item.title,
      edition,
      condition,
      graded:   grading.graded,
      grader:   grading.grader,
      grade:    grading.grade,
      url:      item.href,
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

  return listings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(SOLD_DIR);

  const allCards   = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));
  const allSets    = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sets.json'),  'utf8'));
  const setMap     = Object.fromEntries(allSets.map(s => [s.id, s]));
  const targetSets = TARGET_SET === 'all' ? allSets.map(s => s.id) : [TARGET_SET];
  const progress   = fs.existsSync(PROGRESS_F)
    ? JSON.parse(fs.readFileSync(PROGRESS_F, 'utf8'))
    : {};

  console.log('Launching browser (stealth mode)...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1366, height: 768 });

  // Warm up — visit eBay home to get cookies
  await tab.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  let totalCards = 0, totalListings = 0;

  for (const setId of targetSets) {
    const set = setMap[setId];
    if (!set) { console.warn(`Unknown set: ${setId}`); continue; }

    const setCards = allCards.filter(c => c.setId === setId);
    if (!setCards.length) { console.warn(`No cards for set: ${setId}`); continue; }

    const setTotal = set.printedTotal || set.total;
    setCards.forEach(c => c.setTotal = setTotal);

    ensureDir(path.join(SOLD_DIR, setId));
    console.log(`\n── ${set.name} (${setId}) — ${setCards.length} cards ────────────`);

    for (let i = 0; i < setCards.length; i++) {
      const card    = setCards[i];
      const outFile = path.join(SOLD_DIR, setId, `${card.id}.json`);

      if (progress[card.id]?.done) {
        process.stdout.write(`\r  [${i+1}/${setCards.length}] ${card.name.padEnd(20)} SKIP\n`);
        continue;
      }

      process.stdout.write(`\r  [${i+1}/${setCards.length}] ${card.name.padEnd(20)} scraping...`);

      try {
        const listings = await scrapeCard(tab, card, set.name);

        const output = {
          cardId:        card.id,
          name:          card.name,
          setId:         card.setId,
          setName:       set.name,
          number:        card.number,
          rarity:        card.rarity,
          scrapedAt:     new Date().toISOString(),
          totalListings: listings.length,
          listings,
        };

        fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
        progress[card.id] = { done: true, count: listings.length, scrapedAt: output.scrapedAt };
        fs.writeFileSync(PROGRESS_F, JSON.stringify(progress, null, 2));

        totalCards++;
        totalListings += listings.length;
        process.stdout.write(`\r  [${i+1}/${setCards.length}] ${card.name.padEnd(20)} ${listings.length} listings\n`);
      } catch (err) {
        console.warn(`\n  ERROR [${card.id}]: ${err.message}`);
        progress[card.id] = { done: false, error: err.message };
        fs.writeFileSync(PROGRESS_F, JSON.stringify(progress, null, 2));
      }
    }
  }

  await browser.close();

  console.log('\n── Complete ──────────────────────────────────');
  console.log(`  Cards scraped    : ${totalCards}`);
  console.log(`  Total listings   : ${totalListings.toLocaleString()}`);
  console.log(`  Output           : data/ebay_sold/`);
  console.log(`  Re-run to skip already-scraped cards\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
