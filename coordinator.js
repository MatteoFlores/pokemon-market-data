/**
 * coordinator.js
 *
 * Google Sheets coordination layer for distributed Pokemon scraping.
 * Multiple scrapers can run simultaneously without claiming the same set,
 * by reading/writing a shared Google Sheet as a lightweight task queue.
 *
 * Sheet structure (tab: "Sets"):
 *   A SetID | B Series | C SetName | D TotalCards | E Status
 *   F ClaimedBy | G ClaimedAt | H LastScrapedAt | I CardsDone
 *   J ListingsTotal | K FailedCards | L CertsDone | M Notes
 *
 * Status values:  pending | scraping | done
 */

'use strict';

const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const STALE_CLAIM_HOURS = 2;    // hours before an unfinished claim is considered abandoned
const STALE_SCRAPE_DAYS = 3;    // days before a "done" set is re-scraped
const TAB               = 'Sets';

// 0-based column indices
const C = {
  SET_ID:         0,   // A
  SERIES:         1,   // B
  SET_NAME:       2,   // C
  TOTAL_CARDS:    3,   // D
  STATUS:         4,   // E
  CLAIMED_BY:     5,   // F
  CLAIMED_AT:     6,   // G
  LAST_SCRAPED:   7,   // H
  CARDS_DONE:     8,   // I
  LISTINGS_TOTAL: 9,   // J
  FAILED_CARDS:   10,  // K
  CERTS_DONE:     11,  // L
  NOTES:          12,  // M
};

const HEADERS = [
  'SetID', 'Series', 'SetName', 'TotalCards', 'Status',
  'ClaimedBy', 'ClaimedAt', 'LastScrapedAt', 'CardsDone',
  'ListingsTotal', 'FailedCards', 'CertsDone', 'Notes',
];

// ── Coordinator class ─────────────────────────────────────────────────────────

class Coordinator {
  constructor(config) {
    this.sheetId  = config.sheetId;
    this.nickname = config.nickname;
    this.credPath = config.credentialsPath;
    this.sheets   = null;
  }

  // ── Initialise Google Sheets client ────────────────────────────────────────

  async init() {
    const creds = JSON.parse(fs.readFileSync(this.credPath, 'utf8'));
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  // ── Low-level helpers ──────────────────────────────────────────────────────

  async _readAll() {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${TAB}!A:M`,
    });
    return res.data.values || [];
  }

  // rowNum is 1-indexed (row 1 = header, row 2 = first data row)
  async _writeRow(rowNum, values) {
    // Pad to 13 columns
    const row = values.slice();
    while (row.length < 13) row.push('');
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: `${TAB}!A${rowNum}:M${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  // ── Sheet initialisation ───────────────────────────────────────────────────

  // Called once on setup or first run.  Writes headers if missing, then
  // appends any sets from sets.json that aren't already in the sheet.
  async initSets() {
    const dataDir  = path.join(__dirname, 'data');
    const allSets  = JSON.parse(fs.readFileSync(path.join(dataDir, 'sets.json'),  'utf8'));
    const allCards = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf8'));

    const cardsBySet = {};
    for (const c of allCards) (cardsBySet[c.setId] = cardsBySet[c.setId] || []).push(c);

    // Ensure the "Sets" tab exists — create it if not
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    const hasTab = meta.data.sheets.some(s => s.properties.title === TAB);
    if (!hasTab) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
      });
    }

    // Ensure header row
    const rows = await this._readAll();
    if (!rows.length || rows[0][0] !== 'SetID') {
      await this._writeRow(1, HEADERS);
    }

    // Find which sets are already in the sheet
    const existing = await this._readAll();
    const existingIds = new Set(existing.slice(1).map(r => r[C.SET_ID]).filter(Boolean));

    // Skip sets with 0 cards — they're ghost entries in the API with nothing to scrape
    const toAdd = allSets.filter(s => !existingIds.has(s.id) && (cardsBySet[s.id]?.length || 0) > 0);
    if (!toAdd.length) return 0;

    const newRows = toAdd.map(s => {
      const cards = cardsBySet[s.id] || [];
      return [
        s.id, s.series || '', s.name, String(cards.length),
        'pending', '', '', '', '0', '0', '0', '0', '',
      ];
    });

    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: `${TAB}!A:M`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newRows },
    });

    return toAdd.length;
  }

  // ── Set discovery ──────────────────────────────────────────────────────────

  // Returns { setId, rowNum, totalCards, lastScrapedAt } for the best
  // available set to work on, or null if nothing is available.
  //
  // Priority:
  //   1. pending sets (never scraped) — largest first
  //   2. stale done sets (>STALE_SCRAPE_DAYS old) — oldest scrape first
  //
  // Skips sets that are actively claimed (status=scraping AND ClaimedAt fresh).
  async findBestSet() {
    const rows = await this._readAll();
    if (!rows.length || rows[0][0] !== 'SetID') return null;

    const now = Date.now();
    const candidates = [];

    for (let i = 1; i < rows.length; i++) {
      const r      = rows[i];
      const setId  = r[C.SET_ID];
      if (!setId) continue;

      const status     = (r[C.STATUS] || 'pending').toLowerCase();
      const totalCards = parseInt(r[C.TOTAL_CARDS]) || 0;
      const lastScraped = r[C.LAST_SCRAPED] ? new Date(r[C.LAST_SCRAPED]).getTime() : 0;
      const claimedAt  = r[C.CLAIMED_AT]   ? new Date(r[C.CLAIMED_AT]).getTime()   : 0;
      const rowNum = i + 1; // rows array is 0-indexed; sheet rows are 1-indexed

      if (status === 'scraping') {
        const hoursAgo = (now - claimedAt) / 3_600_000;
        if (hoursAgo < STALE_CLAIM_HOURS) continue; // actively in progress
        // else: stale claim — treat as available
        candidates.push({ setId, rowNum, totalCards, lastScrapedAt: null, priority: 0 });
      } else if (status === 'pending') {
        candidates.push({ setId, rowNum, totalCards, lastScrapedAt: null, priority: 0 });
      } else if (status === 'done') {
        const daysAgo = (now - lastScraped) / 86_400_000;
        if (daysAgo < STALE_SCRAPE_DAYS) continue;
        candidates.push({ setId, rowNum, totalCards, lastScrapedAt: r[C.LAST_SCRAPED] || null, priority: 1 });
      }
    }

    if (!candidates.length) return null;

    // Sort: pending (priority 0) before stale (priority 1), then by most cards
    candidates.sort((a, b) => a.priority - b.priority || b.totalCards - a.totalCards);
    return candidates[0];
  }

  // ── Claim / release ────────────────────────────────────────────────────────

  // Atomically claims a set. Returns true on success, false if someone else
  // claimed it between findBestSet() and now.
  async claimSet(rowNum) {
    // Re-read just that row to check for race condition
    const rows = await this._readAll();
    const r    = rows[rowNum - 1];
    if (!r) return false;

    const status    = (r[C.STATUS] || 'pending').toLowerCase();
    const claimedAt = r[C.CLAIMED_AT] ? new Date(r[C.CLAIMED_AT]).getTime() : 0;
    if (status === 'scraping') {
      const hoursAgo = (Date.now() - claimedAt) / 3_600_000;
      if (hoursAgo < STALE_CLAIM_HOURS) return false; // freshly claimed by someone else
    }

    const updated = r.slice();
    updated[C.STATUS]     = 'scraping';
    updated[C.CLAIMED_BY] = this.nickname;
    updated[C.CLAIMED_AT] = new Date().toISOString();
    await this._writeRow(rowNum, updated);
    return true;
  }

  // Heartbeat: refreshes ClaimedAt so the 2-hour stale timer doesn't fire
  // during a long set.  Also updates in-progress card/listing counts.
  async heartbeat(rowNum, { cardsDone, listingsTotal, failedCards }) {
    const rows = await this._readAll();
    const r    = (rows[rowNum - 1] || []).slice();
    while (r.length < 13) r.push('');
    r[C.CLAIMED_AT]     = new Date().toISOString();
    r[C.CARDS_DONE]     = String(cardsDone);
    r[C.LISTINGS_TOTAL] = String(listingsTotal);
    r[C.FAILED_CARDS]   = String(failedCards);
    await this._writeRow(rowNum, r);
  }

  // Mark a set as fully scraped and release the claim.
  async releaseSet(rowNum, { cardsDone, listingsTotal, failedCards, certsDone = 0, notes = '' }) {
    const rows = await this._readAll();
    const r    = (rows[rowNum - 1] || []).slice();
    while (r.length < 13) r.push('');
    r[C.STATUS]          = 'done';
    r[C.LAST_SCRAPED]    = new Date().toISOString();
    r[C.CLAIMED_BY]      = '';
    r[C.CLAIMED_AT]      = '';
    r[C.CARDS_DONE]      = String(cardsDone);
    r[C.LISTINGS_TOTAL]  = String(listingsTotal);
    r[C.FAILED_CARDS]    = String(failedCards);
    r[C.CERTS_DONE]      = String(certsDone);
    r[C.NOTES]           = notes;
    await this._writeRow(rowNum, r);
  }

  // ── Status read (for dashboard) ────────────────────────────────────────────

  async getAllStatuses() {
    const rows = await this._readAll();
    if (!rows.length || rows[0][0] !== 'SetID') return [];
    return rows.slice(1)
      .filter(r => r[C.SET_ID])
      .map(r => ({
        setId:          r[C.SET_ID]         || '',
        series:         r[C.SERIES]         || '',
        setName:        r[C.SET_NAME]       || '',
        totalCards:     parseInt(r[C.TOTAL_CARDS])     || 0,
        status:         r[C.STATUS]         || 'pending',
        claimedBy:      r[C.CLAIMED_BY]     || '',
        claimedAt:      r[C.CLAIMED_AT]     || '',
        lastScrapedAt:  r[C.LAST_SCRAPED]   || '',
        cardsDone:      parseInt(r[C.CARDS_DONE])      || 0,
        listingsTotal:  parseInt(r[C.LISTINGS_TOTAL])  || 0,
        failedCards:    parseInt(r[C.FAILED_CARDS])    || 0,
        certsDone:      parseInt(r[C.CERTS_DONE])      || 0,
        notes:          r[C.NOTES]          || '',
      }));
  }
}

module.exports = { Coordinator, STALE_SCRAPE_DAYS };
