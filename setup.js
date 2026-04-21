/**
 * setup.js — First-run wizard for the Pokemon Market Data scraper.
 *
 * Creates config.json with your nickname and Google Sheets credentials,
 * then populates the coordination sheet with all 172 sets.
 *
 * Run once per machine:
 *   node setup.js
 *
 * What you need before running:
 *   1. A Google Sheet (blank is fine) — copy its ID from the URL:
 *        docs.google.com/spreadsheets/d/  ← THIS PART →  /edit
 *   2. A Google Cloud service account JSON key file.
 *      Steps to create one (free, takes ~5 min):
 *        a. Go to console.cloud.google.com → New Project
 *        b. APIs & Services → Enable → search "Google Sheets API" → Enable
 *        c. APIs & Services → Credentials → Create Credentials → Service Account
 *        d. Give it any name, click Done
 *        e. Click the service account → Keys → Add Key → JSON → download the file
 *        f. Open your Google Sheet → Share → paste the service account email → Editor
 */

'use strict';

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, a => res(a.trim())));

function stripQuotes(s) { return s.replace(/^["']|["']$/g, ''); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ✗ ${msg}`); }
function info(msg) { console.log(`  ${msg}`); }

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Pokemon Market Data — Scraper Setup');
  console.log('══════════════════════════════════════════\n');

  if (fs.existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    info(`Existing config found.  Nickname: "${existing.nickname}"`);
    const overwrite = await ask('  Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      info('Setup cancelled — existing config kept.\n');
      rl.close();
      return;
    }
    console.log();
  }

  console.log('Step 1 — Your display name');
  info('This is shown in the Google Sheet when you claim a set.');
  info('Use something that identifies your machine (e.g. "Matt-Desktop", "Alex-Laptop").');
  const nickname = await ask('  Nickname: ');
  if (!nickname) { warn('Nickname cannot be empty.'); rl.close(); return; }
  console.log();

  console.log('Step 2 — Google Sheet ID');
  info('Open your Google Sheet and copy the ID from the URL:');
  info('  docs.google.com/spreadsheets/d/ [PASTE THIS PART] /edit');
  const sheetId = await ask('  Sheet ID: ');
  if (!sheetId) { warn('Sheet ID cannot be empty.'); rl.close(); return; }
  console.log();

  console.log('Step 3 — Service account credentials');
  info('Path to the JSON key file you downloaded from Google Cloud.');
  info('Example: C:\\Users\\You\\Downloads\\pokemon-scraper-abc123.json');
  const rawPath   = await ask('  Credentials file path: ');
  const credPath  = stripQuotes(rawPath);

  if (!fs.existsSync(credPath)) {
    warn(`File not found: ${credPath}`);
    warn('Check the path and run setup again.');
    rl.close();
    return;
  }

  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    if (!creds.client_email || !creds.private_key) throw new Error('Missing client_email or private_key');
  } catch (e) {
    warn(`Invalid credentials file — ${e.message}`);
    rl.close();
    return;
  }
  console.log();

  console.log('Step 4 — Testing connection...');
  let sheets;
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    ok(`Connected!  Sheet title: "${res.data.properties.title}"`);
  } catch (e) {
    warn(`Connection failed — ${e.message}`);
    info('');
    info('Things to check:');
    info(`  1. The sheet is shared with: ${creds.client_email}`);
    info('  2. The Sheet ID is correct');
    info('  3. Google Sheets API is enabled in your Google Cloud project');
    rl.close();
    return;
  }
  console.log();

  const config = { nickname, sheetId, credentialsPath: credPath };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  ok(`Config saved → ${CONFIG_PATH}`);
  console.log();

  console.log('Step 5 — Initialising coordination sheet...');
  try {
    const { Coordinator } = require('./coordinator');
    const coord = new Coordinator(config);
    await coord.init();
    const added = await coord.initSets();
    if (added > 0) ok(`Added ${added} sets to the sheet.`);
    else            ok('Sheet already has all sets — nothing added.');
  } catch (e) {
    warn(`Sheet init failed — ${e.message}`);
    info('You can retry by running: node setup.js');
    rl.close();
    return;
  }
  console.log();

  console.log('══════════════════════════════════════════');
  console.log('  Setup complete!');
  console.log('');
  console.log('  To start scraping:');
  console.log('    node scrape_sold_with_images.js');
  console.log('');
  console.log('  The scraper will automatically pick the best');
  console.log('  available set from the Google Sheet so you and');
  console.log('  your collaborators never scrape the same set twice.');
  console.log('══════════════════════════════════════════\n');

  rl.close();
}

main().catch(e => {
  console.error('\nFatal setup error:', e.message);
  rl.close();
  process.exit(1);
});
