/**
 * Quick test — scrapes just Charizard (base1-4) and prints a summary.
 * Uses Puppeteer+stealth to bypass eBay's bot challenge.
 * Run: node test_single_card.js
 */

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio       = require('cheerio');
const fs            = require('fs');

puppeteer.use(StealthPlugin());

const DELAY_MS = 2500;

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
    { re: /\b(SGC|HGA|ACE|CSG|GMA)\s*(\d+(?:\.\d+)?)\b/i, grader: 'Other' },
  ];
  for (const { re, grader } of patterns) {
    const m = re.exec(title);
    if (m) return { graded: true, grader, grade: parseFloat(m[m.length - 1]) };
  }
  if (/\bGRADED\b/i.test(title)) return { graded: true, grader: 'Other', grade: null };
  return { graded: false, grader: null, grade: null };
}

function detectCondition(title, condLabel) {
  const t = title.toUpperCase();
  const l = (condLabel || '').toUpperCase();
  const check = t + ' ' + l;
  if (/NEAR\s*MINT|[\s\(]NM[\s\)\-\/]|NM\/MINT/.test(check)) return 'NM';
  if (/\bMINT\b/.test(check) && !/NEAR/.test(check))          return 'NM';
  if (/LIGHTLY\s*PLAYED|[\s\(]LP[\s\)\-\/]/.test(check))      return 'LP';
  if (/MODERATELY\s*PLAYED|[\s\(]MP[\s\)\-\/]/.test(check))   return 'MP';
  if (/HEAVILY\s*PLAYED|[\s\(]HP[\s\)\-\/]/.test(check))      return 'HP';
  if (/\bDAMAGED\b|\bDMG\b/.test(check))                      return 'Damaged';
  return 'Unspecified';
}

function parseSoldDate(text) {
  const cleaned = text.replace(/sold\s*/i, '').trim();
  const d = new Date(cleaned);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseListingsFromHtml(html) {
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
    const dateText  = item.find('span.su-styled-text.positive.default').first().text().trim();
    const soldDate  = parseSoldDate(dateText);
    if (!soldDate) return;
    const condLabel = item.find('span.su-styled-text.secondary.default').first().text().trim();
    const href      = item.find('a.s-card__link').first().attr('href') || '';
    const idMatch   = /\/itm\/(\d+)/.exec(href);
    if (!idMatch) return;
    out.push({ itemId: idMatch[1], title, price, soldDate, condLabel });
  });

  return out;
}

async function scrapeQuery(page, query, pageNum = 1) {
  const params = new URLSearchParams({
    _nkw: query, LH_Complete: '1', LH_Sold: '1',
    _sacat: '2536', _ipg: '240', _pgn: String(pageNum), _sop: '10',
  });
  const url = 'https://www.ebay.com/sch/i.html?' + params;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const pageTitle = await page.title();
  if (pageTitle.includes('Pardon') || pageTitle.includes('Checking')) {
    console.log('    (challenge page — waiting extra 6s...)');
    await sleep(6000);
  }

  const html = await page.content();

  const listingCount = (html.match(/li[^>]+s-card[^>]*>/g) || []).length;
  if (listingCount === 0 && pageNum === 1) {
    fs.writeFileSync('ebay_debug_puppeteer.html', html);
    console.log(`    (0 li.s-card — saved ebay_debug_puppeteer.html)`);
  }

  const listings = parseListingsFromHtml(html);
  const hasNext  = html.includes('pagination__next');
  return { listings, hasNext };
}

async function main() {
  console.log('Launching browser (stealth mode)...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const tab = await browser.newPage();
  await tab.setViewport({ width: 1366, height: 768 });

  console.log('Visiting eBay home to warm up cookies...');
  await tab.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const queries = [
    'charizard 4/102 base set pokemon near mint',
    'charizard 4/102 base set pokemon lightly played',
    'charizard 4/102 base set pokemon moderately played',
    'charizard 4/102 base set pokemon heavily played',
    'charizard 4/102 base set pokemon damaged',
    'charizard 4/102 base set PSA',
    'charizard 4/102 base set BGS',
    'charizard 4/102 base set CGC',
    'charizard 4/102 base set pokemon',
  ];

  const seen = new Set();
  const all  = [];

  for (const q of queries) {
    process.stdout.write(`  Searching: "${q}"... `);
    await sleep(DELAY_MS);
    const { listings } = await scrapeQuery(tab, q, 1);
    let newCount = 0;
    for (const l of listings) {
      if (seen.has(l.itemId)) continue;
      seen.add(l.itemId);
      const grading   = detectGrading(l.title);
      const edition   = detectEdition(l.title);
      const condition = grading.graded ? 'Graded' : detectCondition(l.title, l.condLabel);
      all.push({ ...l, edition, condition, graded: grading.graded, grader: grading.grader, grade: grading.grade });
      newCount++;
    }
    console.log(`${listings.length} found, ${newCount} new`);
  }

  await browser.close();

  console.log(`\nTotal unique listings: ${all.length}`);
  console.log('\nBreakdown by Edition x Condition:');
  const buckets = {};
  for (const l of all) {
    const key = `${l.edition} | ${l.graded ? l.grader + ' ' + (l.grade || '?') : l.condition}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(l.price);
  }
  const sorted = Object.entries(buckets).sort((a,b) => b[1].length - a[1].length);
  for (const [key, prices] of sorted) {
    prices.sort((a,b) => a - b);
    const med = prices[Math.floor(prices.length / 2)];
    console.log(`  ${key.padEnd(35)} ${String(prices.length).padStart(4)} listings  median $${med.toFixed(0)}`);
  }

  console.log('\nSample listings:');
  all.slice(0, 5).forEach(l =>
    console.log(`  $${l.price.toFixed(0).padStart(6)}  ${l.soldDate}  ${l.edition.padEnd(14)} ${(l.graded ? l.grader+' '+l.grade : l.condition).padEnd(15)}  ${l.title.slice(0,60)}`)
  );
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
