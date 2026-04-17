/**
 * scrape_psa_active.js
 *
 * Scrapes active eBay listings for PSA-graded Pokemon cards.
 * Saves full listing detail including all image URLs so cert numbers
 * can later be extracted via OCR.
 *
 * Output folder: data/psa_active/
 *
 * File naming:
 *   data/psa_active/{ebayItemId}.json
 *
 * Each file contains:
 *   - All listing metadata (title, price, seller, condition, etc.)
 *   - imageUrls[]  — all listing photo URLs for OCR processing
 *   - psaCertNumber: null  — filled in later by OCR pipeline
 *   - psaCertVerified: false
 *   - cardId / setId — matched from our catalog if possible
 *
 * Usage:
 *   node scrape_psa_active.js              (scans all sets, saves new listings)
 *   node scrape_psa_active.js base1        (one set only)
 *
 * Re-running appends new listings and skips already-saved itemIds.
 */

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio       = require('cheerio');
const fs            = require('fs');
const path          = require('path');

puppeteer.use(StealthPlugin());

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR   = path.join(__dirname, 'data');
const OUT_DIR    = path.join(DATA_DIR, 'psa_active');
const TARGET_SET = process.argv[2] || 'all';
const DELAY_MIN  = 2000;
const DELAY_MAX  = 4000;
const MAX_PAGES  = 10;    // 10 x 240 = 2,400 active listings per query

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function randDelay()  { return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)); }

// ── Grade Detection ───────────────────────────────────────────────────────────

function detectPsaGrade(title) {
  const m = /\bPSA\s*(\d+(?:\.\d+)?)\b/i.exec(title);
  return m ? parseFloat(m[1]) : null;
}

function detectEdition(title) {
  const t = title.toUpperCase();
  if (/1ST\s*ED(ITION)?|FIRST\s*ED(ITION)?/.test(t)) return '1st Edition';
  if (/SHADOWLESS/.test(t))                             return 'Shadowless';
  return 'Unlimited';
}

// ── Card Matcher ──────────────────────────────────────────────────────────────

function matchCard(title, cards) {
  const numMatch = /\b(\w+)\/(\w+)\b/.exec(title);
  if (!numMatch) return null;
  const rawNum = numMatch[1];
  const num    = /^\d+$/.test(rawNum) ? String(parseInt(rawNum, 10)) : rawNum;
  const byNum  = cards.filter(c => c.number === num);
  if (byNum.length === 1) return byNum[0];
  if (byNum.length > 1) {
    const lower = title.toLowerCase();
    return byNum.find(c => lower.includes(c.name.toLowerCase())) || byNum[0];
  }
  return null;
}

// ── HTML Parser ───────────────────────────────────────────────────────────────

function parseListingCards(html) {
  const $ = cheerio.load(html);
  const out = [];

  $('li.s-card').each((_, el) => {
    const item      = $(el);
    const title     = item.find('span.su-styled-text.primary').first().text().trim();
    if (!title) return;

    // Skip if no PSA in title
    if (!/\bPSA\b/i.test(title)) return;

    // Price — skip ranges (lots)
    const priceTags = item.find('span.s-card__price');
    if (priceTags.length > 1) return;
    const price = parseFloat(priceTags.first().text().replace(/[^0-9.]/g, ''));
    if (!price || price <= 0) return;

    const condLabel = item.find('span.su-styled-text.secondary.default').first().text().trim();
    const href      = item.find('a.s-card__link').first().attr('href') || '';
    const idMatch   = /\/itm\/(\d+)/.exec(href);
    if (!idMatch) return;

    // Thumbnail image URL (for quick OCR — full images fetched separately per listing)
    const imgSrc = item.find('img').first().attr('src') || item.find('img').first().attr('data-src') || null;

    out.push({
      itemId:     idMatch[1],
      title,
      price,
      condLabel,
      href:       href.split('?')[0],   // strip tracking params
      thumbUrl:   imgSrc,
    });
  });

  const hasNext = html.includes('pagination__next');
  return { listings: out, hasNext };
}

// ── Fetch Listing Detail Page ─────────────────────────────────────────────────
// Visits the individual item page to grab images, seller, and description.

async function fetchListingDetail(tab, itemId) {
  const url = `https://www.ebay.com/itm/${itemId}`;
  try {
    await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1200);

    const html = await tab.content();
    const $    = cheerio.load(html);

    // All listing images (eBay puts them in data-src or src on picture/img tags)
    const imageUrls = new Set();
    $('div.ux-image-carousel-item img, div.img-cover img, img.img').each((_, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src') || '';
      // Filter to real eBay image URLs (i.ebayimg.com), exclude tiny icons
      if (src.includes('i.ebayimg.com') && !src.includes('s-l64')) {
        // Upgrade to largest available size
        const large = src.replace(/s-l\d+/, 's-l1600');
        imageUrls.add(large);
      }
    });

    // Seller username
    const seller = $('span[data-testid="ux-seller-section__item--seller"] a').first().text().trim()
      || $('a.ux-action[href*="/usr/"]').first().text().trim()
      || null;

    // Item specifics (e.g. "Grading Service: PSA", "Grade: 10")
    const specifics = {};
    $('div.ux-layout-section__item').each((_, row) => {
      const label = $(row).find('.ux-labels-values__labels').first().text().trim();
      const value = $(row).find('.ux-labels-values__values').first().text().trim();
      if (label && value) specifics[label] = value;
    });

    // Description — eBay loads it inside an iframe; grab the iframe src and fetch it
    let description = null;
    const descIframeSrc = $('iframe#desc_ifr, iframe[id*="desc"]').first().attr('src') || null;
    if (descIframeSrc) {
      try {
        await tab.goto(descIframeSrc, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(800);
        const descHtml = await tab.content();
        const $d = cheerio.load(descHtml);
        $d('script, style').remove();
        description = $d('body').text().replace(/\s+/g, ' ').trim() || null;
        // Navigate back to continue scraping
        await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(800);
      } catch (_) {
        // Description iframe unavailable — leave as null
      }
    }

    return {
      imageUrls:   [...imageUrls],
      seller,
      specifics,
      description,
    };
  } catch (err) {
    return { imageUrls: [], seller: null, specifics: {}, description: null, error: err.message };
  }
}

// ── Search Page Fetcher ───────────────────────────────────────────────────────

async function fetchSearchPage(tab, query, pageNum) {
  const params = new URLSearchParams({
    _nkw:    query,
    _sacat:  '2536',
    _ipg:    '240',
    _pgn:    String(pageNum),
    _sop:    '10',
    // Active listings only (no LH_Sold)
  });
  await tab.goto('https://www.ebay.com/sch/i.html?' + params, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await sleep(1500);
  const title = await tab.title();
  if (title.includes('Pardon') || title.includes('Checking')) await sleep(6000);
  return tab.content();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(OUT_DIR);

  const allCards = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf8'));
  const allSets  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sets.json'),  'utf8'));

  // Build set → cards lookup
  const cardsBySet = {};
  for (const c of allCards) {
    (cardsBySet[c.setId] = cardsBySet[c.setId] || []).push(c);
  }

  const targetSets = TARGET_SET === 'all'
    ? allSets
    : allSets.filter(s => s.id === TARGET_SET);

  if (!targetSets.length) {
    console.error(`Unknown set: ${TARGET_SET}`); process.exit(1);
  }

  // Load existing itemIds so we don't duplicate
  const existingIds = new Set(
    fs.readdirSync(OUT_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
  );
  console.log(`\nExisting saved listings: ${existingIds.size}`);

  console.log('Launching browser (stealth mode)...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1366, height: 768 });
  await tab.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  let totalNew = 0;

  for (const set of targetSets) {
    const setCards = cardsBySet[set.id] || [];
    if (!setCards.length) continue;

    // One search per set: "PSA <set name> pokemon card"
    const query = `PSA ${set.name} pokemon card`;
    process.stdout.write(`\n[${set.id}] ${set.name} — searching...`);

    const found = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      await randDelay();
      try {
        const html = await fetchSearchPage(tab, query, page);
        const { listings, hasNext } = parseListingCards(html);

        for (const item of listings) {
          if (existingIds.has(item.itemId) || found.find(f => f.itemId === item.itemId)) continue;
          found.push(item);
        }

        if (!hasNext || !listings.length) break;
      } catch (err) {
        console.warn(`\n  WARN page ${page}: ${err.message}`);
        break;
      }
    }

    process.stdout.write(` ${found.length} PSA listings found`);

    // For each new listing, fetch detail page for images + seller
    let saved = 0;
    for (const item of found) {
      await randDelay();
      const detail = await fetchListingDetail(tab, item.itemId);
      const matched = matchCard(item.title, setCards);

      const record = {
        // Identifiers
        ebayItemId:     item.itemId,
        listingUrl:     item.href,
        scrapedAt:      new Date().toISOString(),

        // Card match (best-effort from title)
        cardId:         matched?.id   || null,
        cardName:       matched?.name || null,
        setId:          set.id,
        setName:        set.name,

        // Listing data
        title:          item.title,
        price:          item.price,
        condLabel:      item.condLabel,
        seller:         detail.seller,
        specifics:      detail.specifics,
        description:    detail.description,

        // Classification
        psaGrade:       detectPsaGrade(item.title),
        edition:        detectEdition(item.title),

        // Images — for OCR cert number extraction later
        thumbUrl:       item.thumbUrl,
        imageUrls:      detail.imageUrls,

        // PSA cert — to be filled by OCR pipeline
        psaCertNumber:  null,
        psaCertVerified: false,
      };

      fs.writeFileSync(
        path.join(OUT_DIR, `${item.itemId}.json`),
        JSON.stringify(record, null, 2)
      );
      existingIds.add(item.itemId);
      saved++;
      totalNew++;
    }

    process.stdout.write(` — ${saved} saved\n`);
  }

  await browser.close();

  console.log('\n── Complete ──────────────────────────────────');
  console.log(`  New listings saved : ${totalNew}`);
  console.log(`  Total in folder    : ${existingIds.size}`);
  console.log(`  Output             : data/psa_active/`);
  console.log(`  psaCertNumber      : null (ready for OCR pipeline)\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
