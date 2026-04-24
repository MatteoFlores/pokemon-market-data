'use strict';

/**
 * review_images.js
 *
 * Web UI for manually reviewing "unextractable" cert images.
 *
 * Keys:
 *   D — Delete    (no cert visible, image is useless)
 *   K — Keep      (looks like there's a cert number, queue for reprocessing)
 *   U — Unsure    (save for later decision)
 *   ← → — browse images within the current listing
 *
 * Decisions saved to: data/cert_results/_review_decisions.json
 * Run: node review_images.js
 * Open: http://localhost:3001
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT          = 3001;
const CERT_PROG_F   = path.join(__dirname, 'data', 'cert_results', '_progress.json');
const DECISIONS_F   = path.join(__dirname, 'data', 'cert_results', '_review_decisions.json');
const IMAGES_DIR    = path.join(__dirname, 'data', 'images');

// ── Load state ────────────────────────────────────────────────────────────────

const certProg  = JSON.parse(fs.readFileSync(CERT_PROG_F, 'utf8'));
let   decisions = fs.existsSync(DECISIONS_F)
  ? JSON.parse(fs.readFileSync(DECISIONS_F, 'utf8'))
  : {};

const queue = Object.entries(certProg)
  .filter(([id, v]) => v.folder === 'unextractable' && !decisions[id])
  .map(([id]) => id);

let currentIndex = 0;

function saveDecisions() {
  fs.writeFileSync(DECISIONS_F, JSON.stringify(decisions, null, 2));
}

function getItem(itemId) {
  const metaPath = path.join(IMAGES_DIR, itemId, '_meta.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta  = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const files = fs.readdirSync(path.join(IMAGES_DIR, itemId))
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .sort((a, b) => {
      const n = s => parseInt(s) || s;
      return n(a) < n(b) ? -1 : 1;
    });
  return { ...meta, images: files };
}

function getStats() {
  const decided = Object.values(decisions);
  return {
    total:     queue.length + decided.length,
    remaining: queue.length - currentIndex,
    reviewed:  decided.length + currentIndex,
    deleted:   decided.filter(d => d.decision === 'd').length,
    keep:      decided.filter(d => d.decision === 'k').length,
    unsure:    decided.filter(d => d.decision === 'u').length,
  };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Image Review</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
  }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  /* ── top bar ── */
  .topbar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; align-items: center; gap: 20px; flex-shrink: 0; }
  .topbar h1 { font-size: 15px; font-weight: 600; }
  .progress-text { color: var(--muted); font-size: 13px; }
  .progress-text b { color: var(--text); }
  .stats { display: flex; gap: 16px; margin-left: auto; font-size: 12px; }
  .stat-d { color: var(--red); } .stat-k { color: var(--green); } .stat-u { color: var(--yellow); }

  /* ── main layout ── */
  .main { display: flex; flex: 1; overflow: hidden; }

  /* ── image panel ── */
  .img-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
  .img-wrap { flex: 1; display: flex; align-items: center; justify-content: center; background: #0a0d11; overflow: hidden; cursor: pointer; }
  .img-wrap img { max-width: 100%; max-height: 100%; object-fit: contain; transition: opacity .15s; }
  .img-nav { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px; background: var(--surface); border-top: 1px solid var(--border); flex-shrink: 0; }
  .img-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); cursor: pointer; transition: background .15s; }
  .img-dot.active { background: var(--blue); }
  .img-counter { color: var(--muted); font-size: 12px; position: absolute; top: 10px; right: 12px; background: rgba(0,0,0,.6); padding: 3px 8px; border-radius: 4px; }

  /* ── info panel ── */
  .info-panel { width: 300px; flex-shrink: 0; border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  .info-scroll { flex: 1; overflow-y: auto; padding: 16px; }
  .info-section { margin-bottom: 16px; }
  .info-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
  .info-value { font-size: 14px; font-weight: 500; }
  .info-value.big { font-size: 20px; font-weight: 700; }
  .info-value.green { color: var(--green); }
  .info-value.blue  { color: var(--blue); }
  .info-value.yellow { color: var(--yellow); }
  .title-text { font-size: 12px; color: var(--muted); line-height: 1.5; margin-top: 4px; }
  .divider { border: none; border-top: 1px solid var(--border); margin: 12px 0; }

  /* ── action bar ── */
  .action-bar { border-top: 1px solid var(--border); padding: 14px 16px; background: var(--surface); flex-shrink: 0; }
  .action-row { display: flex; gap: 10px; }
  .btn { flex: 1; padding: 12px 8px; border-radius: 6px; border: 1px solid; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity .15s; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .btn:hover { opacity: .85; }
  .btn-d { background: #2d1215; border-color: var(--red);   color: var(--red);   }
  .btn-k { background: #0d2414; border-color: var(--green); color: var(--green); }
  .btn-u { background: #2a200a; border-color: var(--yellow);color: var(--yellow);}
  .key-hint { font-size: 11px; opacity: .7; }
  .hint-text { text-align: center; font-size: 11px; color: var(--muted); margin-top: 8px; }

  /* ── done screen ── */
  .done-screen { display: none; flex: 1; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
  .done-screen h2 { font-size: 24px; }
  .done-screen p  { color: var(--muted); }
</style>
</head>
<body>

<div class="topbar">
  <h1>Image Review</h1>
  <div class="progress-text">
    <b id="prog-reviewed">—</b> reviewed &nbsp;·&nbsp; <b id="prog-remaining">—</b> remaining
  </div>
  <div class="stats">
    <span class="stat-d">✕ <b id="stat-d">0</b> deleted</span>
    <span class="stat-k">✓ <b id="stat-k">0</b> keep</span>
    <span class="stat-u">? <b id="stat-u">0</b> unsure</span>
  </div>
</div>

<div class="main" id="main-view">
  <div class="img-panel">
    <div class="img-wrap" id="img-wrap" onclick="nextImage()">
      <img id="main-img" src="" alt="">
    </div>
    <div class="img-counter" id="img-counter"></div>
    <div class="img-nav" id="img-nav"></div>
  </div>

  <div class="info-panel">
    <div class="info-scroll">
      <div class="info-section">
        <div class="info-label">Card</div>
        <div class="info-value big" id="info-card">—</div>
        <div class="info-value" id="info-set" style="color:var(--muted);font-size:13px"></div>
      </div>
      <hr class="divider">
      <div class="info-section">
        <div class="info-label">Grader &amp; Grade</div>
        <div class="info-value green" id="info-grader">—</div>
      </div>
      <div class="info-section">
        <div class="info-label">Edition</div>
        <div class="info-value" id="info-edition">—</div>
      </div>
      <div class="info-section">
        <div class="info-label">Sale Price</div>
        <div class="info-value blue" id="info-price">—</div>
      </div>
      <div class="info-section">
        <div class="info-label">Sold Date</div>
        <div class="info-value" id="info-date">—</div>
      </div>
      <hr class="divider">
      <div class="info-section">
        <div class="info-label">eBay Title</div>
        <div class="title-text" id="info-title">—</div>
      </div>
    </div>

    <div class="action-bar">
      <div class="action-row">
        <button class="btn btn-d" onclick="decide('d')">✕ No Cert <span class="key-hint">[D]</span></button>
        <button class="btn btn-k" onclick="decide('k')">✓ Keep <span class="key-hint">[K]</span></button>
        <button class="btn btn-u" onclick="decide('u')">? Unsure <span class="key-hint">[U]</span></button>
      </div>
      <div style="margin-top:10px">
        <button class="btn" onclick="goBack()" style="background:#1c2128;border-color:var(--border);color:var(--muted);width:100%">
          ← Back / Undo <span class="key-hint">[B]</span>
        </button>
      </div>
      <div class="hint-text">← → to browse images &nbsp;·&nbsp; click image to advance</div>
    </div>
  </div>
</div>

<div class="done-screen" id="done-screen">
  <h2>All done!</h2>
  <p id="done-stats"></p>
</div>

<script>
let current = null;
let imgIndex = 0;

async function loadCurrent() {
  const res  = await fetch('/api/current');
  const data = await res.json();
  if (data.done) {
    document.getElementById('main-view').style.display  = 'none';
    document.getElementById('done-screen').style.display = 'flex';
    document.getElementById('done-stats').textContent = data.stats.deleted + ' deleted, ' + data.stats.keep + ' kept for reprocessing, ' + data.stats.unsure + ' unsure';
    return;
  }
  current  = data;
  imgIndex = 0;
  renderItem();
  updateStats(data.stats);
}

function renderItem() {
  if (!current) return;
  const { meta, images, stats } = current;

  // images
  showImage(0);
  const nav = document.getElementById('img-nav');
  nav.innerHTML = images.map((_, i) =>
    '<div class="img-dot' + (i === 0 ? ' active' : '') + '" onclick="showImage(' + i + ')"></div>'
  ).join('');
  document.getElementById('img-counter').textContent = '1 / ' + images.length;

  // info
  document.getElementById('info-card').textContent    = meta.cardName || '—';
  document.getElementById('info-set').textContent     = meta.setName  || '—';
  document.getElementById('info-grader').textContent  = (meta.grader || '—') + ' ' + (meta.grade != null ? meta.grade : '');
  document.getElementById('info-edition').textContent = meta.edition  || 'Standard';
  document.getElementById('info-price').textContent   = meta.price != null ? '$' + meta.price.toFixed(2) : '—';
  document.getElementById('info-date').textContent    = meta.soldDate || '—';
  document.getElementById('info-title').textContent   = meta.title    || '—';

  // progress
  document.getElementById('prog-reviewed').textContent  = stats.reviewed;
  document.getElementById('prog-remaining').textContent = stats.remaining;
}

function showImage(idx) {
  if (!current) return;
  imgIndex = idx;
  const img = document.getElementById('main-img');
  img.style.opacity = '0';
  img.src = '/img/' + current.meta.itemId + '/' + current.images[idx];
  img.onload = () => { img.style.opacity = '1'; };
  document.getElementById('img-counter').textContent = (idx + 1) + ' / ' + current.images.length;
  document.querySelectorAll('.img-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

function nextImage() {
  if (!current) return;
  showImage((imgIndex + 1) % current.images.length);
}
function prevImage() {
  if (!current) return;
  showImage((imgIndex - 1 + current.images.length) % current.images.length);
}

function updateStats(stats) {
  document.getElementById('stat-d').textContent = stats.deleted;
  document.getElementById('stat-k').textContent = stats.keep;
  document.getElementById('stat-u').textContent = stats.unsure;
}

async function decide(decision) {
  if (!current) return;
  const itemId = current.meta.itemId;
  // Optimistically advance
  current = null;
  await fetch('/api/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, decision }),
  });
  loadCurrent();
}

async function goBack() {
  await fetch('/api/back', { method: 'POST' });
  loadCurrent();
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const key = e.key.toLowerCase();
  if      (key === 'd')          decide('d');
  else if (key === 'k')          decide('k');
  else if (key === 'u')          decide('u');
  else if (key === 'b')          goBack();
  else if (key === 'arrowright') nextImage();
  else if (key === 'arrowleft')  prevImage();
});

loadCurrent();
</script>
</body>
</html>`;

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {

  // Serve the UI
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  // Current item
  if (req.url === '/api/current') {
    while (currentIndex < queue.length) {
      const itemId = queue[currentIndex];
      const item   = getItem(itemId);
      if (item && item.images.length > 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ meta: item, images: item.images, stats: getStats() }));
        return;
      }
      currentIndex++; // skip folders with no images
    }
    // All done
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ done: true, stats: getStats() }));
    return;
  }

  // Record decision
  if (req.url === '/api/decision' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { itemId, decision } = JSON.parse(body);
        decisions[itemId] = { decision, decidedAt: new Date().toISOString() };
        saveDecisions();
        // Images are kept on disk for all decisions — 'd' items become
        // negative training examples for YOLO before deletion.
        currentIndex++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Go back one item (undo last decision)
  if (req.url === '/api/back' && req.method === 'POST') {
    if (currentIndex > 0) {
      currentIndex--;
      const itemId = queue[currentIndex];
      delete decisions[itemId];
      saveDecisions();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Serve image files
  const imgMatch = req.url.match(/^\/img\/([^/]+)\/(.+)$/);
  if (imgMatch) {
    const [, itemId, filename] = imgMatch;
    const filePath = path.join(IMAGES_DIR, itemId, filename);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    const ext  = path.extname(filename).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  const stats = getStats();
  console.log(`\nImage review tool running at http://localhost:${PORT}`);
  console.log(`  ${stats.total.toLocaleString()} unextractable images to review`);
  if (stats.reviewed > 0) console.log(`  ${stats.reviewed.toLocaleString()} already reviewed — resuming where you left off`);
  console.log('\nKeys: D = delete  K = keep for reprocessing  U = unsure\n');
});
