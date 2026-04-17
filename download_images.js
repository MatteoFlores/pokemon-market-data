/**
 * download_images.js
 *
 * Downloads card images for all PSA-graded sold listings saved in data/ebay_sold/.
 * Images are saved to data/images/{itemId}/{n}.jpg for later perceptual hashing
 * or OCR to detect how often the same physical card is being relisted.
 *
 * Progress is tracked in data/images/_progress.json so runs are resumable.
 *
 * Usage:
 *   node download_images.js              (all PSA listings across all sets)
 *   node download_images.js base1        (one set only)
 *   node download_images.js base1 10     (one set, limit to 10 listings — useful for testing)
 *
 * Output:
 *   data/images/{itemId}/1.jpg, 2.jpg, ...
 *   data/images/_progress.json
 */

const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const url           = require('url');

puppeteer.use(StealthPlugin());

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_DIR    = path.join(__dirname, 'data');
const SOLD_DIR    = path.join(DATA_DIR, 'ebay_sold');
const IMAGES_DIR  = path.join(DATA_DIR, 'images');
const PROGRESS_F  = path.join(IMAGES_DIR, '_progress.json');
const TARGET_SET  = process.argv[2] || 'all';
const LIMIT       = parseInt(process.argv[3] || '0', 10); // 0 = no limit
const DELAY_MIN   = 1800;
const DELAY_MAX   = 3500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function randDelay()  { return sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN)); }

function downloadFile(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new url.URL(imageUrl);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(destPath);
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
      file.on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', err => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

// ── Extract image URLs from an eBay listing page ──────────────────────────────

async function getImageUrls(tab, itemId) {
  const listingUrl = `https://www.ebay.com/itm/${itemId}`;
  try {
    await tab.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1200);

    const title = await tab.title();
    if (title.includes('Pardon') || title.includes('Checking')) {
      await sleep(6000);
    }

    const imageUrls = await tab.evaluate(() => {
      const urls = new Set();

      // Primary carousel images
      document.querySelectorAll(
        'div.ux-image-carousel-item img, div.img-cover img, img.img'
      ).forEach(img => {
        const src = img.dataset.src || img.src || '';
        if (src.includes('i.ebayimg.com') && !src.includes('s-l64')) {
          urls.add(src.replace(/s-l\d+/, 's-l1600'));
        }
      });

      // Fallback: any eBay image larger than thumbnail
      document.querySelectorAll('img[src*="i.ebayimg.com"]').forEach(img => {
        const src = img.src || '';
        if (!src.includes('s-l64') && !src.includes('s-l96')) {
          urls.add(src.replace(/s-l\d+/, 's-l1600'));
        }
      });

      return [...urls];
    });

    return imageUrls;
  } catch (err) {
    return { error: err.message };
  }
}

// ── Load all PSA sold listings ────────────────────────────────────────────────

function collectPsaListings(targetSet) {
  const listings = [];

  const sets = TARGET_SET === 'all'
    ? fs.readdirSync(SOLD_DIR).filter(f => {
        const full = path.join(SOLD_DIR, f);
        return fs.statSync(full).isDirectory();
      })
    : [targetSet];

  for (const setId of sets) {
    const setDir = path.join(SOLD_DIR, setId);
    if (!fs.existsSync(setDir) || !fs.statSync(setDir).isDirectory()) continue;

    for (const file of fs.readdirSync(setDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(setDir, file), 'utf8'));
        for (const l of data.listings || []) {
          if (l.grader !== 'PSA' && l.grader !== 'BGS' && l.grader !== 'CGC') continue;
          // Extract clean item ID (some URLs have query params)
          const idMatch = /\/itm\/(\d+)/.exec(l.url || '');
          const itemId  = idMatch ? idMatch[1] : l.itemId;
          if (!itemId) continue;

          listings.push({
            itemId,
            cardId:   data.cardId,
            cardName: data.name,
            setId:    data.setId,
            setName:  data.setName,
            grade:    l.grade,
            grader:   l.grader,
            edition:  l.edition,
            price:    l.price,
            soldDate: l.soldDate,
            title:    l.title,
          });
        }
      } catch (_) {
        // Skip unreadable files
      }
    }
  }

  return listings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  ensureDir(IMAGES_DIR);

  // Load progress
  const progress = fs.existsSync(PROGRESS_F)
    ? JSON.parse(fs.readFileSync(PROGRESS_F, 'utf8'))
    : {};

  console.log('\n── Collecting PSA listings from ebay_sold... ──');
  const allListings = collectPsaListings(TARGET_SET);

  // Deduplicate by itemId
  const seen    = new Set();
  const unique  = [];
  for (const l of allListings) {
    if (seen.has(l.itemId)) continue;
    seen.add(l.itemId);
    unique.push(l);
  }

  // Apply set filter label and limit
  const todo = unique.filter(l => !progress[l.itemId]?.done);
  const work = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;

  console.log(`  Total unique PSA item IDs : ${unique.length.toLocaleString()}`);
  console.log(`  Already downloaded        : ${unique.length - todo.length}`);
  console.log(`  To process this run       : ${work.length.toLocaleString()}`);
  if (LIMIT > 0) console.log(`  (capped at ${LIMIT} by CLI arg)`);

  if (!work.length) {
    console.log('\nNothing to do — all listings already downloaded.\n');
    return;
  }

  console.log('\nLaunching browser (stealth mode)...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1366, height: 768 });

  // Warm-up visit
  await tab.goto('https://www.ebay.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  let downloaded = 0;
  let errors     = 0;

  for (let i = 0; i < work.length; i++) {
    const listing = work[i];
    const label   = `[${i + 1}/${work.length}] ${listing.cardName || '?'} PSA${listing.grade || '?'} (${listing.itemId})`;

    process.stdout.write(`\r  ${label.padEnd(70)} ...`);
    await randDelay();

    const itemDir = path.join(IMAGES_DIR, listing.itemId);

    try {
      const imageUrls = await getImageUrls(tab, listing.itemId);

      if (!Array.isArray(imageUrls) || !imageUrls.length) {
        const errMsg = imageUrls?.error || 'no images found';
        process.stdout.write(`\r  ${label.padEnd(70)} SKIP (${errMsg})\n`);
        progress[listing.itemId] = { done: false, error: errMsg, ...listing };
        errors++;
      } else {
        ensureDir(itemDir);

        // Save metadata alongside images
        fs.writeFileSync(
          path.join(itemDir, '_meta.json'),
          JSON.stringify({ ...listing, imageUrls, downloadedAt: new Date().toISOString() }, null, 2)
        );

        let savedCount = 0;
        for (let j = 0; j < imageUrls.length; j++) {
          const dest = path.join(itemDir, `${j + 1}.jpg`);
          try {
            await downloadFile(imageUrls[j], dest);
            savedCount++;
          } catch (dlErr) {
            // Non-fatal: image URL may be stale; keep going
          }
        }

        progress[listing.itemId] = {
          done:        true,
          imageCount:  savedCount,
          cardId:      listing.cardId,
          grade:       listing.grade,
          downloadedAt: new Date().toISOString(),
        };
        downloaded++;
        process.stdout.write(`\r  ${label.padEnd(70)} ${savedCount} img(s)\n`);
      }
    } catch (err) {
      process.stdout.write(`\r  ${label.padEnd(70)} ERROR: ${err.message}\n`);
      progress[listing.itemId] = { done: false, error: err.message };
      errors++;
    }

    // Save progress every 25 items
    if ((i + 1) % 25 === 0) {
      fs.writeFileSync(PROGRESS_F, JSON.stringify(progress, null, 2));
    }
  }

  // Final progress save
  fs.writeFileSync(PROGRESS_F, JSON.stringify(progress, null, 2));
  await browser.close();

  console.log('\n── Complete ──────────────────────────────────');
  console.log(`  Images downloaded : ${downloaded}`);
  console.log(`  Errors / skipped  : ${errors}`);
  console.log(`  Output            : data/images/`);
  console.log(`  Progress file     : data/images/_progress.json`);
  console.log(`  Re-run to resume (skips already-downloaded items)\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
