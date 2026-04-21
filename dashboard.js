/**
 * dashboard.js
 *
 * Lightweight live progress dashboard for the Pokemon Market Data pipeline.
 * Reads the existing _progress.json files only — zero overhead on the scrapers.
 *
 * Usage:
 *   node dashboard.js
 *   Open http://localhost:3000
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT     = 3000;
const DATA_DIR = path.join(__dirname, 'data');

// ── Cache large static files once on startup ──────────────────────────────────

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

const ALL_CARDS = loadJSON(path.join(DATA_DIR, 'cards.json'), []);
const ALL_SETS  = loadJSON(path.join(DATA_DIR, 'sets.json'),  []);
const SET_MAP   = Object.fromEntries(ALL_SETS.map(s => [s.id, s]));

// Pre-group card IDs by set for fast lookup
const CARDS_BY_SET = {};
for (const c of ALL_CARDS) {
  (CARDS_BY_SET[c.setId] = CARDS_BY_SET[c.setId] || []).push(c.id);
}

console.log(`Loaded ${ALL_CARDS.length.toLocaleString()} cards across ${ALL_SETS.length} sets.`);

// ── Status computation (runs on every poll — only reads progress files) ───────

function timeSince(isoStr) {
  if (!isoStr) return null;
  return (Date.now() - new Date(isoStr)) / 60000; // minutes ago
}

function activityStatus(minutesAgo) {
  if (minutesAgo === null) return 'idle';
  if (minutesAgo < 10)    return 'running';
  if (minutesAgo < 60)    return 'stalled';
  return 'idle';
}

function recentRate(entries, timeKey, windowSize = 20) {
  // entries: array of objects with a timestamp field
  // returns items/hour computed over the most recent `windowSize` entries
  const sorted = entries
    .filter(e => e[timeKey])
    .sort((a, b) => new Date(b[timeKey]) - new Date(a[timeKey]))
    .slice(0, windowSize);
  if (sorted.length < 2) return null;
  const newest = new Date(sorted[0][timeKey]);
  const oldest = new Date(sorted[sorted.length - 1][timeKey]);
  const hrs = (newest - oldest) / 3600000;
  return hrs > 0 ? (sorted.length - 1) / hrs : null;
}

function fmtEta(remainingItems, ratePerHour) {
  if (!ratePerHour || ratePerHour <= 0) return null;
  const hrs = remainingItems / ratePerHour;
  if (hrs < 1)        return Math.round(hrs * 60) + ' min';
  if (hrs < 48)       return hrs.toFixed(1) + ' hrs';
  return Math.round(hrs / 24) + ' days';
}

function getStatus() {
  const soldProg = loadJSON(path.join(DATA_DIR, 'ebay_sold',    '_progress.json'), {});
  const imgProg  = loadJSON(path.join(DATA_DIR, 'images',       '_progress.json'), {});
  const certProg = loadJSON(path.join(DATA_DIR, 'cert_results', '_progress.json'), {});
  const certNums = loadJSON(path.join(DATA_DIR, 'cert_results', 'cert_numbers.json'), {});

  // ── Scraping ────────────────────────────────────────────────────────────────
  const soldValues  = Object.values(soldProg);
  const soldDone    = soldValues.filter(v => v.done && v.count > 0);
  const soldZero    = soldValues.filter(v => v.done && v.count === 0);
  const soldFailed  = soldValues.filter(v => !v.done);
  const totalListings = soldDone.reduce((a, v) => a + (v.count || 0), 0);

  const lastScrapeAt = soldDone
    .map(v => v.scrapedAt).filter(Boolean)
    .sort().pop() || null;

  const scrapeRate = recentRate(soldDone, 'scrapedAt');
  const remaining  = ALL_CARDS.length - soldDone.length;

  // Per-set breakdown — only sets that have any progress entries
  const activeSets = [...new Set(Object.keys(soldProg).map(k => k.replace(/-\d+$/, '')))];
  const setRows = activeSets.map(setId => {
    const ids    = CARDS_BY_SET[setId] || [];
    const done   = ids.filter(id => soldProg[id]?.done && soldProg[id]?.count > 0).length;
    const redone = ids.filter(id => soldProg[id]?.done && soldProg[id]?.count === 0).length;
    return { id: setId, name: SET_MAP[setId]?.name || setId, done, needsRedo: redone, total: ids.length };
  });

  // ── Images ──────────────────────────────────────────────────────────────────
  const imgValues  = Object.values(imgProg);
  const imgDone    = imgValues.filter(v => v.done);
  const imgFailed  = imgValues.filter(v => !v.done);
  const totalFiles = imgDone.reduce((a, v) => a + (v.imageCount || 0), 0);

  const lastImgAt  = imgDone.map(v => v.downloadedAt).filter(Boolean).sort().pop() || null;
  const imgRate    = recentRate(imgDone, 'downloadedAt');

  // ── Cert extraction ─────────────────────────────────────────────────────────
  const certValues = Object.values(certProg);
  const folders    = {};
  certValues.forEach(v => { folders[v.folder] = (folders[v.folder] || 0) + 1; });
  const certPending = Math.max(0, imgDone.length - certValues.length);

  // Cert rate: use folder timestamp if available, otherwise estimate from count
  const lastCertAt = certValues
    .map(v => v.processedAt).filter(Boolean).sort().pop() || null;

  return {
    scraping: {
      totalCards:  ALL_CARDS.length,
      done:        soldDone.length,
      totalListings,
      zero:        soldZero.length,
      failed:      soldFailed.length,
      remaining,
      lastActivity: lastScrapeAt,
      status:      activityStatus(timeSince(lastScrapeAt)),
      ratePerHour: scrapeRate ? +scrapeRate.toFixed(1) : null,
      eta:         fmtEta(remaining, scrapeRate),
      sets:        setRows,
    },
    images: {
      downloaded:  imgDone.length,
      failed:      imgFailed.length,
      totalFiles,
      lastActivity: lastImgAt,
      status:      activityStatus(timeSince(lastImgAt)),
      ratePerHour: imgRate ? +imgRate.toFixed(1) : null,
    },
    certs: {
      processed:   certValues.length,
      pending:     certPending,
      certsFound:  Object.keys(certNums).length,
      folders,
      lastActivity: lastCertAt,
      status:      activityStatus(timeSince(lastCertAt)),
    },
    serverTime: new Date().toISOString(),
  };
}

// ── HTML template ─────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pokemon Market Data — Pipeline</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:      #0d1117;
    --surface: #161b22;
    --border:  #30363d;
    --text:    #e6edf3;
    --muted:   #8b949e;
    --green:   #3fb950;
    --yellow:  #d29922;
    --red:     #f85149;
    --blue:    #58a6ff;
    --purple:  #bc8cff;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 24px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  header h1 { font-size: 18px; font-weight: 600; }
  header h1 span { color: var(--muted); font-weight: 400; font-size: 14px; margin-left: 8px; }

  #refresh-info { color: var(--muted); font-size: 12px; text-align: right; }
  #refresh-info b { color: var(--text); }
  #countdown { color: var(--blue); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 16px;
    margin-bottom: 16px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .card-header h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }

  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: .05em;
  }
  .badge-running  { background: #1a3a1e; color: var(--green); }
  .badge-stalled  { background: #3a2e10; color: var(--yellow); }
  .badge-idle     { background: #1c1c1c; color: var(--muted); }
  .badge-complete { background: #1a3a1e; color: var(--blue); }

  .big-number {
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
    margin-bottom: 4px;
  }
  .big-sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }

  .progress-track {
    background: var(--border);
    border-radius: 4px;
    height: 8px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .progress-fill {
    height: 100%;
    border-radius: 4px;
    transition: width .5s ease;
  }
  .fill-green  { background: var(--green); }
  .fill-blue   { background: var(--blue); }
  .fill-purple { background: var(--purple); }

  .stats-row {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .stat { }
  .stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .stat-value { font-size: 15px; font-weight: 600; }
  .stat-value.green  { color: var(--green); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.red    { color: var(--red); }
  .stat-value.blue   { color: var(--blue); }
  .stat-value.muted  { color: var(--muted); }

  .divider { border: none; border-top: 1px solid var(--border); margin: 16px 0; }

  .set-table { width: 100%; border-collapse: collapse; }
  .set-table th {
    color: var(--muted); font-size: 11px; text-transform: uppercase;
    letter-spacing: .04em; padding: 4px 0; text-align: left; border-bottom: 1px solid var(--border);
  }
  .set-table th:last-child, .set-table td:last-child { text-align: right; }
  .set-table td { padding: 5px 0; font-size: 13px; border-bottom: 1px solid #1c2128; }
  .set-table td:first-child { color: var(--muted); font-size: 11px; width: 60px; }
  .mini-bar {
    display: inline-block; height: 4px; border-radius: 2px;
    vertical-align: middle; margin-right: 6px;
    transition: width .5s ease;
  }
  .complete { color: var(--green); }
  .partial  { color: var(--yellow); }
  .pending  { color: var(--muted); }
  .redo     { color: var(--red); font-size: 11px; margin-left: 4px; }

  .folders { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .folder-chip {
    background: #1c2128; border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 10px; font-size: 12px;
  }
  .folder-chip b { color: var(--text); }
  .folder-chip span { color: var(--muted); font-size: 11px; margin-left: 4px; }

  .error-note { color: var(--red); font-size: 12px; margin-top: 8px; }
  .loading { color: var(--muted); font-style: italic; }
</style>
</head>
<body>

<header>
  <h1>Pokemon Market Data <span>Pipeline Monitor</span></h1>
  <div id="refresh-info">
    Refreshing in <span id="countdown">10</span>s &nbsp;·&nbsp;
    Last update: <b id="last-update">—</b>
  </div>
</header>

<div class="grid">

  <!-- SCRAPING -->
  <div class="card" id="card-scraping">
    <div class="card-header">
      <h2>Sold Listings</h2>
      <span class="badge badge-idle" id="scraping-badge">Idle</span>
    </div>
    <div class="big-number" id="scraping-done">—</div>
    <div class="big-sub" id="scraping-sub">of — cards scraped</div>
    <div class="progress-track"><div class="progress-fill fill-green" id="scraping-bar" style="width:0%"></div></div>
    <div class="stats-row">
      <div class="stat">
        <div class="stat-label">Remaining</div>
        <div class="stat-value" id="scraping-remaining">—</div>
      </div>
      <div class="stat">
        <div class="stat-label">Rate</div>
        <div class="stat-value blue" id="scraping-rate">—</div>
      </div>
      <div class="stat">
        <div class="stat-label">ETA</div>
        <div class="stat-value" id="scraping-eta">—</div>
      </div>
      <div class="stat">
        <div class="stat-label">Last activity</div>
        <div class="stat-value muted" id="scraping-last">—</div>
      </div>
    </div>
    <div id="scraping-issues"></div>
    <hr class="divider">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span style="font-size:12px;color:var(--muted)" id="set-count"></span>
      <button id="hide-complete-btn" onclick="toggleHideComplete()"
        style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid var(--border);
               background:var(--surface);color:var(--muted);cursor:pointer;">
        Hide Complete
      </button>
    </div>
    <table class="set-table">
      <thead><tr><th>Set</th><th>Name</th><th colspan="2">Progress</th></tr></thead>
      <tbody id="set-rows"></tbody>
    </table>
  </div>

  <!-- RIGHT COLUMN: images + certs stacked -->
  <div style="display:flex; flex-direction:column; gap:16px;">

    <!-- IMAGES -->
    <div class="card" id="card-images">
      <div class="card-header">
        <h2>Image Downloads</h2>
        <span class="badge badge-idle" id="images-badge">Idle</span>
      </div>
      <div class="big-number" id="images-done">—</div>
      <div class="big-sub" id="images-sub">listings with images saved</div>
      <div class="progress-track"><div class="progress-fill fill-blue" id="images-bar" style="width:0%"></div></div>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-label">Total files</div>
          <div class="stat-value" id="images-files">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Rate</div>
          <div class="stat-value blue" id="images-rate">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Failed</div>
          <div class="stat-value" id="images-failed">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Last activity</div>
          <div class="stat-value muted" id="images-last">—</div>
        </div>
      </div>
    </div>

    <!-- CERT EXTRACTION -->
    <div class="card" id="card-certs">
      <div class="card-header">
        <h2>Cert Extraction</h2>
        <span class="badge badge-idle" id="certs-badge">Idle</span>
      </div>
      <div class="big-number" id="certs-done">—</div>
      <div class="big-sub" id="certs-sub">of — image sets processed</div>
      <div class="progress-track"><div class="progress-fill fill-purple" id="certs-bar" style="width:0%"></div></div>
      <div class="stats-row">
        <div class="stat">
          <div class="stat-label">Pending</div>
          <div class="stat-value yellow" id="certs-pending">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Certs found</div>
          <div class="stat-value green" id="certs-found">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Last activity</div>
          <div class="stat-value muted" id="certs-last">—</div>
        </div>
      </div>
      <div class="folders" id="cert-folders"></div>
    </div>

  </div>
</div>

<script>
const POLL_INTERVAL = 10; // seconds
let countdown = POLL_INTERVAL;
let hideComplete = false;

function toggleHideComplete() {
  hideComplete = !hideComplete;
  const btn = document.getElementById('hide-complete-btn');
  btn.textContent = hideComplete ? 'Show All' : 'Hide Complete';
  btn.style.color = hideComplete ? 'var(--blue)' : 'var(--muted)';
  btn.style.borderColor = hideComplete ? 'var(--blue)' : 'var(--border)';
  renderSetRows();
}

function renderSetRows() {
  const sets = window._lastSets || [];
  const tbody = document.getElementById('set-rows');
  if (!tbody) return;
  const visible = hideComplete ? sets.filter(s => s.done < s.total) : sets;
  const countEl = document.getElementById('set-count');
  if (countEl) countEl.textContent = hideComplete
    ? (sets.length - visible.length) + ' complete hidden'
    : sets.length + ' sets';
  tbody.innerHTML = '';
  for (const s of visible) {
    const pct  = s.total > 0 ? s.done / s.total * 100 : 0;
    const cls  = s.done === s.total ? 'complete' : s.done > 0 ? 'partial' : 'pending';
    const redo = s.needsRedo > 0 ? '<span class="redo">(' + s.needsRedo + ' redo)</span>' : '';
    const barW = Math.round(pct);
    tbody.innerHTML +=
      '<tr>' +
      '<td>' + s.id + '</td>' +
      '<td>' +
        '<span class="mini-bar fill-green" style="width:' + barW + 'px;background:' + (cls==='complete'?'#3fb950':cls==='partial'?'#d29922':'#30363d') + '"></span>' +
        '<span class="' + cls + '">' + s.name + '</span>' + redo +
      '</td>' +
      '<td style="text-align:right">' + s.done + ' / ' + s.total + '</td>' +
      '</tr>';
  }
}
let timer;

function fmt(n) { return n == null ? '—' : Number(n).toLocaleString(); }

function fmtAgo(isoStr) {
  if (!isoStr) return '—';
  const mins = (Date.now() - new Date(isoStr)) / 60000;
  if (mins < 1)    return 'just now';
  if (mins < 60)   return Math.round(mins) + ' min ago';
  if (mins < 1440) return (mins / 60).toFixed(1) + ' hrs ago';
  return Math.round(mins / 1440) + ' days ago';
}

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setBadge(id, status) {
  const el = document.getElementById(id);
  el.className = 'badge badge-' + status;
  el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

function setBar(id, pct) {
  document.getElementById(id).style.width = Math.min(100, pct).toFixed(2) + '%';
}

function applyStatus(data) {
  const { scraping, images, certs } = data;

  // ── Scraping ──────────────────────────────────────────────────────────────
  const scrapePct = (scraping.done / scraping.totalCards * 100);
  document.getElementById('scraping-done').textContent   = fmt(scraping.totalListings);
  document.getElementById('scraping-sub').textContent    = fmt(scraping.done) + ' of ' + fmt(scraping.totalCards) + ' cards scraped (' + scrapePct.toFixed(1) + '%)';
  document.getElementById('scraping-remaining').textContent = fmt(scraping.remaining);
  document.getElementById('scraping-rate').textContent   = scraping.ratePerHour ? scraping.ratePerHour + '/hr' : '—';
  document.getElementById('scraping-eta').textContent    = scraping.eta || '—';
  document.getElementById('scraping-last').textContent   = fmtAgo(scraping.lastActivity);
  setBar('scraping-bar', scrapePct);
  setBadge('scraping-badge', scraping.done >= scraping.totalCards ? 'complete' : scraping.status);

  const issues = document.getElementById('scraping-issues');
  const parts = [];
  if (scraping.zero   > 0) parts.push('<span class="error-note">⚠ ' + scraping.zero   + ' cards returned 0 listings (need redo)</span>');
  if (scraping.failed > 0) parts.push('<span class="error-note">✕ ' + scraping.failed + ' cards failed</span>');
  issues.innerHTML = parts.join('');

  // Set rows
  window._lastSets = scraping.sets;
  renderSetRows();

  // ── Images ────────────────────────────────────────────────────────────────
  const totalExpected = scraping.done; // rough proxy: each scraped card has some graded listings
  document.getElementById('images-done').textContent  = fmt(images.downloaded);
  document.getElementById('images-sub').textContent   = 'listings with images saved';
  document.getElementById('images-files').textContent = fmt(images.totalFiles);
  document.getElementById('images-rate').textContent  = images.ratePerHour ? images.ratePerHour + '/hr' : '—';
  document.getElementById('images-failed').textContent = images.failed > 0
    ? '<span style="color:var(--red)">' + fmt(images.failed) + '</span>'
    : '0';
  document.getElementById('images-failed').innerHTML = images.failed > 0
    ? '<span style="color:var(--red)">' + fmt(images.failed) + '</span>'
    : '0';
  document.getElementById('images-last').textContent  = fmtAgo(images.lastActivity);
  // progress bar: downloaded vs (downloaded + pending from image downloader perspective)
  const imgPct = images.downloaded > 0 ? Math.min(100, (images.downloaded / (images.downloaded + images.failed + 1)) * 100) : 0;
  setBar('images-bar', imgPct);
  setBadge('images-badge', images.status);

  // ── Certs ─────────────────────────────────────────────────────────────────
  const certTotal  = certs.processed + certs.pending;
  const certPct    = certTotal > 0 ? certs.processed / certTotal * 100 : 0;
  document.getElementById('certs-done').textContent    = fmt(certs.processed);
  document.getElementById('certs-sub').textContent     = 'of ' + fmt(certTotal) + ' image sets processed (' + certPct.toFixed(1) + '%)';
  document.getElementById('certs-pending').textContent = fmt(certs.pending);
  document.getElementById('certs-found').textContent   = fmt(certs.certsFound);
  document.getElementById('certs-last').textContent    = fmtAgo(certs.lastActivity);
  setBar('certs-bar', certPct);
  setBadge('certs-badge', certPct >= 100 ? 'complete' : certs.status);

  const folderColors = { cert_extracted: '#3fb950', ocr_success: '#58a6ff', verify_later: '#d29922', unextractable: '#8b949e' };
  const folderLabels = { cert_extracted: 'Extracted', ocr_success: 'OCR Success', verify_later: 'Verify Later', unextractable: 'No Label' };
  const foldersEl = document.getElementById('cert-folders');
  foldersEl.innerHTML = Object.entries(certs.folders || {}).map(([k, v]) =>
    '<div class="folder-chip" style="border-color:' + (folderColors[k] || '#30363d') + '22">' +
    '<b style="color:' + (folderColors[k] || '#8b949e') + '">' + fmt(v) + '</b>' +
    '<span>' + (folderLabels[k] || k) + '</span>' +
    '</div>'
  ).join('');
}

async function poll() {
  try {
    const res  = await fetch('/api/status');
    const data = await res.json();
    applyStatus(data);
    document.getElementById('last-update').textContent = fmtTime(data.serverTime);
  } catch (e) {
    console.warn('Poll failed:', e.message);
  }
}

function tick() {
  countdown--;
  document.getElementById('countdown').textContent = countdown;
  if (countdown <= 0) {
    countdown = POLL_INTERVAL;
    poll();
  }
}

poll();
timer = setInterval(tick, 1000);
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    try {
      const status = getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  console.log('Polls progress files every 10 seconds — zero overhead on scrapers.');
});
