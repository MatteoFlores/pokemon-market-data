'use strict';

/**
 * review_unextractable.js
 *
 * Manually categorize unextractable images while extract_certs.py runs.
 * Safe to run concurrently — does not write to _progress.json.
 *
 * ← →   navigate listings
 * ↑ ↓   flip through images within a listing
 * P     PSA   → copies images to data/review_psa/{itemId}/
 * O     Other → copies images to data/review_other/{itemId}/
 * D     No cert / bad listing → flagged only, no copy
 * B     Undo last decision
 *
 * Run: node review_unextractable.js
 * Open: http://localhost:3003
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT        = 3003;
const PROGRESS_F  = path.join(__dirname, 'data', 'cert_results', '_progress.json');
const IMAGES_DIR  = path.join(__dirname, 'data', 'images');
const DECISIONS_F = path.join(__dirname, 'data', 'cert_results', '_review_unextractable.json');
const PSA_DIR     = path.join(__dirname, 'data', 'review_psa');
const OTHER_DIR   = path.join(__dirname, 'data', 'review_other');

for (const d of [PSA_DIR, OTHER_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadDecisions() {
  try { return JSON.parse(fs.readFileSync(DECISIONS_F, 'utf8')); } catch { return {}; }
}

function saveDecisions(d) {
  fs.writeFileSync(DECISIONS_F, JSON.stringify(d, null, 2));
}

function loadItems() {
  const progress  = JSON.parse(fs.readFileSync(PROGRESS_F, 'utf8'));
  const decisions = loadDecisions();
  return Object.entries(progress)
    .filter(([, e]) => e.folder === 'unextractable')
    .filter(([id]) => !decisions[id])
    .map(([itemId]) => {
      const metaPath = path.join(IMAGES_DIR, itemId, '_meta.json');
      let meta = { itemId };
      try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (_) {}
      const imgDir = path.join(IMAGES_DIR, itemId);
      const images = fs.existsSync(imgDir)
        ? fs.readdirSync(imgDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f)).sort()
        : [];
      return { itemId, meta, images };
    })
    .filter(l => l.images.length > 0);
}

function getStats() {
  const progress  = JSON.parse(fs.readFileSync(PROGRESS_F, 'utf8'));
  const decisions = loadDecisions();
  const all   = Object.values(progress).filter(e => e.folder === 'unextractable').length;
  const vals  = Object.values(decisions);
  return {
    total:     all,
    reviewed:  vals.length,
    remaining: all - vals.length,
    p:         vals.filter(v => v.decision === 'p').length,
    o:         vals.filter(v => v.decision === 'o').length,
    d:         vals.filter(v => v.decision === 'd').length,
  };
}

function copyImages(itemId, destDir) {
  const srcDir = path.join(IMAGES_DIR, itemId);
  if (!fs.existsSync(srcDir)) return;
  const dest = path.join(destDir, itemId);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(srcDir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(dest, f)));
}

function removeDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Review Unextractable</title>
<style>
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --bg:#0d1117; --surface:#161b22; --border:#30363d;
    --text:#e6edf3; --muted:#8b949e;
    --psa:#58a6ff; --other:#d29922; --del:#f85149; --undo:#8b949e;
  }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }

  .topbar { background:var(--surface); border-bottom:1px solid var(--border); padding:10px 20px; display:flex; align-items:center; gap:16px; flex-shrink:0; flex-wrap:wrap; }
  .topbar h1 { font-size:15px; font-weight:600; }
  .pos  { color:var(--muted); font-size:13px; }
  .pos b { color:var(--text); }
  .tally { margin-left:auto; display:flex; gap:14px; font-size:12px; }
  .tally span { display:flex; align-items:center; gap:4px; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .dot-p { background:var(--psa); }
  .dot-o { background:var(--other); }
  .dot-d { background:var(--del); }
  .btn-refresh { margin-left:8px; background:transparent; border:1px solid var(--border); color:var(--muted); font-size:12px; padding:4px 10px; border-radius:4px; cursor:pointer; }
  .btn-refresh:hover { border-color:var(--text); color:var(--text); }

  .main { display:flex; flex:1; overflow:hidden; }

  .img-panel { flex:1; display:flex; flex-direction:column; background:#0a0d11; position:relative; overflow:hidden; }
  .img-wrap  { flex:1; display:flex; align-items:center; justify-content:center; }
  .img-wrap img { max-width:100%; max-height:100%; object-fit:contain; transition:opacity .1s; }
  .img-counter { position:absolute; top:10px; right:12px; background:rgba(0,0,0,.65); padding:3px 10px; border-radius:4px; font-size:12px; color:var(--muted); }
  .flash { position:absolute; top:10px; left:12px; padding:4px 14px; border-radius:4px; font-size:13px; font-weight:700; display:none; }
  .flash-p { background:#0d1e33; border:1px solid var(--psa); color:var(--psa); }
  .flash-o { background:#1e1600; border:1px solid var(--other); color:var(--other); }
  .flash-d { background:#2d0d0d; border:1px solid var(--del); color:var(--del); }
  .nav-hint { position:absolute; bottom:10px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,.65); padding:4px 16px; border-radius:4px; font-size:12px; color:var(--muted); white-space:nowrap; }

  .info-panel { width:270px; flex-shrink:0; border-left:1px solid var(--border); display:flex; flex-direction:column; }
  .info-body  { flex:1; padding:16px; overflow-y:auto; }
  .lbl { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .val { font-size:14px; font-weight:500; margin-bottom:12px; }
  .val.big { font-size:20px; font-weight:700; }
  .val.grader-psa   { color:var(--psa); }
  .val.grader-cgc   { color:var(--other); }
  .val.grader-bgs   { color:#bc8cff; }
  .val.grader-other { color:var(--muted); }
  .val.price { color:#3fb950; }
  .title-small { font-size:12px; color:var(--muted); line-height:1.5; }

  .actions { border-top:1px solid var(--border); padding:14px; background:var(--surface); display:flex; flex-direction:column; gap:8px; }
  .btn-row { display:flex; gap:8px; }
  .btn { flex:1; padding:11px 6px; border-radius:6px; border:1px solid; font-size:13px; font-weight:700; cursor:pointer; letter-spacing:.03em; }
  .btn:hover { opacity:.8; }
  .btn-p { border-color:var(--psa);   background:#0d1e33; color:var(--psa); }
  .btn-o { border-color:var(--other); background:#1e1600; color:var(--other); }
  .btn-d { border-color:var(--del);   background:#2d0d0d; color:var(--del); }
  .btn-b { border-color:var(--border); background:transparent; color:var(--muted); font-size:12px; }

  .loading { display:flex; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:10px; }
  .loading p { color:var(--muted); font-size:14px; }
  .spinner { width:32px; height:32px; border:3px solid var(--border); border-top-color:var(--psa); border-radius:50%; animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }

  .done { display:none; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:10px; }
  .done h2 { font-size:22px; }
  .done p  { color:var(--muted); }
</style>
</head>
<body>

<div class="topbar">
  <h1>Review Unextractable</h1>
  <div class="pos">Listing <b id="pos">—</b> / <b id="total">—</b> remaining</div>
  <div class="tally">
    <span><span class="dot dot-p"></span><b id="cnt-p">0</b> PSA</span>
    <span><span class="dot dot-o"></span><b id="cnt-o">0</b> Other</span>
    <span><span class="dot dot-d"></span><b id="cnt-d">0</b> No-cert</span>
  </div>
  <button class="btn-refresh" onclick="refreshList()">↻ Refresh list</button>
</div>

<div id="loading-view" class="loading">
  <div class="spinner"></div>
  <p>Loading listings…</p>
</div>

<div class="main" id="main-view" style="display:none">
  <div class="img-panel">
    <div class="img-wrap"><img id="main-img" src="" alt=""></div>
    <div class="img-counter" id="img-counter"></div>
    <div class="flash flash-p" id="flash-p">PSA</div>
    <div class="flash flash-o" id="flash-o">Other</div>
    <div class="flash flash-d" id="flash-d">No Cert</div>
    <div class="nav-hint">← → listings &nbsp;·&nbsp; ↑ ↓ images &nbsp;·&nbsp; <b style="color:#58a6ff">P</b>=PSA &nbsp;<b style="color:#d29922">O</b>=Other &nbsp;<b style="color:#f85149">D</b>=No cert &nbsp;<b style="color:#8b949e">B</b>=Undo</div>
  </div>

  <div class="info-panel">
    <div class="info-body">
      <div class="lbl">Grader / Grade</div>
      <div class="val big" id="info-grader">—</div>
      <div class="lbl">Card</div>
      <div class="val" id="info-card">—</div>
      <div class="val" id="info-set" style="color:var(--muted);font-size:12px;margin-top:-8px"></div>
      <div style="height:8px"></div>
      <div class="lbl">Price</div>
      <div class="val price" id="info-price">—</div>
      <div class="lbl">Sold Date</div>
      <div class="val" id="info-date">—</div>
      <div class="lbl">eBay Title</div>
      <div class="title-small" id="info-title">—</div>
    </div>
    <div class="actions">
      <div class="btn-row">
        <button class="btn btn-p" onclick="decide('p')">PSA [P]</button>
        <button class="btn btn-o" onclick="decide('o')">Other [O]</button>
        <button class="btn btn-d" onclick="decide('d')">No Cert [D]</button>
      </div>
      <button class="btn btn-b" onclick="undo()">↩ Undo [B]</button>
    </div>
  </div>
</div>

<div class="done" id="done-view">
  <h2>All reviewed!</h2>
  <p id="done-msg"></p>
</div>

<script>
let items   = [];
let idx     = 0;
let imgIdx  = 0;
let history = [];  // [{itemId, idx}]
let busy    = false;

async function init() {
  await refreshList();
}

async function refreshList() {
  document.getElementById('loading-view').style.display = 'flex';
  document.getElementById('main-view').style.display   = 'none';
  document.getElementById('done-view').style.display   = 'none';

  const [itemsRes, statsRes] = await Promise.all([
    fetch('/api/items'),
    fetch('/api/stats'),
  ]);
  items = await itemsRes.json();
  const stats = await statsRes.json();

  document.getElementById('total').textContent = items.length;
  updateTally(stats);

  document.getElementById('loading-view').style.display = 'none';

  if (!items.length) { showDone(stats); return; }

  idx    = Math.min(idx, items.length - 1);
  imgIdx = 0;
  document.getElementById('main-view').style.display = 'flex';
  render();
}

function updateTally(stats) {
  document.getElementById('cnt-p').textContent = stats.p;
  document.getElementById('cnt-o').textContent = stats.o;
  document.getElementById('cnt-d').textContent = stats.d;
}

function graderClass(g) {
  if (!g) return 'grader-other';
  const u = g.toUpperCase();
  if (u === 'PSA') return 'grader-psa';
  if (u === 'CGC') return 'grader-cgc';
  if (u === 'BGS' || u === 'BECKETT') return 'grader-bgs';
  return 'grader-other';
}

function render() {
  if (!items.length) { showDone(); return; }
  if (idx >= items.length) idx = items.length - 1;
  const item = items[idx];
  imgIdx = Math.min(imgIdx, item.images.length - 1);

  showImg();
  document.getElementById('pos').textContent = idx + 1;

  const g = item.meta.grader || '';
  const gradeEl = document.getElementById('info-grader');
  gradeEl.textContent = (g || '—') + (item.meta.grade != null ? ' ' + item.meta.grade : '');
  gradeEl.className   = 'val big ' + graderClass(g);

  document.getElementById('info-card').textContent  = item.meta.cardName  || '—';
  document.getElementById('info-set').textContent   = item.meta.setName   || '';
  document.getElementById('info-price').textContent = item.meta.price != null ? '$' + Number(item.meta.price).toFixed(2) : '—';
  document.getElementById('info-date').textContent  = item.meta.soldDate  || '—';
  document.getElementById('info-title').textContent = item.meta.title     || '—';
}

function showImg() {
  const item = items[idx];
  const img  = document.getElementById('main-img');
  img.style.opacity = '0';
  img.src = '/img/' + encodeURIComponent(item.itemId) + '/' + encodeURIComponent(item.images[imgIdx]);
  img.onload = () => img.style.opacity = '1';
  document.getElementById('img-counter').textContent = (imgIdx + 1) + ' / ' + item.images.length;
}

function flash(type) {
  const el = document.getElementById('flash-' + type);
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 800);
}

async function decide(decision) {
  if (busy || !items.length) return;
  busy = true;
  const item = items[idx];

  await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: item.itemId, decision }),
  });

  history.push({ itemId: item.itemId, prevIdx: idx });
  flash(decision);

  // Remove from list and advance
  items.splice(idx, 1);
  document.getElementById('total').textContent = items.length;
  if (idx >= items.length) idx = Math.max(0, items.length - 1);
  imgIdx = 0;

  // Update tally
  const statsRes = await fetch('/api/stats');
  updateTally(await statsRes.json());

  if (!items.length) { showDone(); }
  else { render(); }
  busy = false;
}

async function undo() {
  if (busy || !history.length) return;
  busy = true;
  const last = history.pop();

  await fetch('/api/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: last.itemId }),
  });

  // Reload list and navigate back to where we were
  const itemsRes = await fetch('/api/items');
  items = await itemsRes.json();
  document.getElementById('total').textContent = items.length;

  // Find the undone item in the refreshed list
  const found = items.findIndex(i => i.itemId === last.itemId);
  idx    = found >= 0 ? found : Math.min(last.prevIdx, items.length - 1);
  imgIdx = 0;

  const statsRes = await fetch('/api/stats');
  updateTally(await statsRes.json());

  document.getElementById('main-view').style.display = 'flex';
  document.getElementById('done-view').style.display = 'none';
  render();
  busy = false;
}

function showDone(stats) {
  document.getElementById('main-view').style.display = 'none';
  const dv = document.getElementById('done-view');
  dv.style.display = 'flex';
  if (stats) {
    document.getElementById('done-msg').textContent =
      stats.p + ' PSA · ' + stats.o + ' Other · ' + stats.d + ' No-cert  — hit Refresh if extract_certs.py added new items';
  }
}

document.addEventListener('keydown', e => {
  if (busy) return;
  const k = e.key;
  if (k === 'ArrowRight') { idx = Math.min(idx + 1, items.length - 1); imgIdx = 0; render(); }
  if (k === 'ArrowLeft')  { idx = Math.max(idx - 1, 0);               imgIdx = 0; render(); }
  if (k === 'ArrowDown')  { imgIdx = Math.min(imgIdx + 1, (items[idx]?.images.length||1)-1); showImg(); }
  if (k === 'ArrowUp')    { imgIdx = Math.max(imgIdx - 1, 0); showImg(); }
  if (k.toLowerCase() === 'p') decide('p');
  if (k.toLowerCase() === 'o') decide('o');
  if (k.toLowerCase() === 'd') decide('d');
  if (k.toLowerCase() === 'b') undo();
});

init();
</script>
</body>
</html>`;

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (req.url === '/api/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadItems()));
    return;
  }

  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStats()));
    return;
  }

  if (req.url === '/api/decide' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { itemId, decision } = JSON.parse(body);
        if (!itemId || !['p','o','d'].includes(decision)) throw new Error('bad params');

        if (decision === 'p') copyImages(itemId, PSA_DIR);
        if (decision === 'o') copyImages(itemId, OTHER_DIR);

        const decisions = loadDecisions();
        decisions[itemId] = { decision, timestamp: new Date().toISOString() };
        saveDecisions(decisions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/undo' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { itemId } = JSON.parse(body);
        const decisions  = loadDecisions();
        const prev = decisions[itemId];

        if (prev?.decision === 'p') removeDir(path.join(PSA_DIR,   itemId));
        if (prev?.decision === 'o') removeDir(path.join(OTHER_DIR, itemId));

        delete decisions[itemId];
        saveDecisions(decisions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve images from data/images/
  const m = req.url.match(/^\/img\/([^/]+)\/(.+)$/);
  if (m) {
    const filePath = path.join(IMAGES_DIR, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    const ext  = path.extname(m[2]).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  const stats = getStats();
  console.log(`\nUnextractable review at http://localhost:${PORT}`);
  console.log(`  ${stats.remaining} listings remaining to review  (${stats.total} total unextractable)`);
  console.log(`  Already reviewed: ${stats.p} PSA | ${stats.o} Other | ${stats.d} No-cert`);
  console.log(`\n  P = PSA    → data/review_psa/`);
  console.log(`  O = Other  → data/review_other/`);
  console.log(`  D = No cert (flagged only)`);
  console.log(`  B = Undo last decision\n`);
});
