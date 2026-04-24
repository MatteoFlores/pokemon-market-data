'use strict';

/**
 * review_no_cert.js
 *
 * Review no-cert export images one at a time.
 *
 * ← →   navigate between listings
 * ↑ ↓   flip through images within a listing
 * R     rescue THIS image only → saved to data/rescued_images/ for reprocessing
 *
 * Rescuing one image does not affect the rest of the listing.
 *
 * Run: node review_no_cert.js
 * Open: http://localhost:3002
 */

const http    = require('http');
const fs      = require('fs');
const path    = require('path');

const PORT         = 3002;
const EXPORT_DIR   = path.join(__dirname, 'data', 'no_cert_export');
const IMAGES_DIR   = path.join(__dirname, 'data', 'images');
const RESCUED_DIR  = path.join(__dirname, 'data', 'rescued_images');

if (!fs.existsSync(EXPORT_DIR)) {
  console.error('Run export_no_cert.js first.');
  process.exit(1);
}
if (!fs.existsSync(RESCUED_DIR)) fs.mkdirSync(RESCUED_DIR, { recursive: true });

function loadItems() {
  return fs.readdirSync(EXPORT_DIR)
    .filter(d => {
      try { return fs.statSync(path.join(EXPORT_DIR, d)).isDirectory(); } catch { return false; }
    })
    .map(dirName => {
      const itemId   = dirName.split('_').pop();
      const metaPath = path.join(IMAGES_DIR, itemId, '_meta.json');
      let meta = { itemId, cardName: dirName };
      try { meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) }; } catch (_) {}
      const images = fs.readdirSync(path.join(EXPORT_DIR, dirName))
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
      return { dirName, itemId, meta, images };
    })
    .filter(l => l.images.length > 0);
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Review No-Cert</title>
<style>
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root { --bg:#0d1117; --surface:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --green:#3fb950; --red:#f85149; --blue:#58a6ff; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }

  .topbar { background:var(--surface); border-bottom:1px solid var(--border); padding:10px 20px; display:flex; align-items:center; gap:16px; flex-shrink:0; }
  .topbar h1 { font-size:15px; font-weight:600; }
  .pos { color:var(--muted); font-size:13px; }
  .pos b { color:var(--text); }
  .rescued-count { margin-left:auto; color:var(--green); font-size:13px; }

  .main { display:flex; flex:1; overflow:hidden; }

  .img-panel { flex:1; display:flex; flex-direction:column; background:#0a0d11; position:relative; overflow:hidden; }
  .img-wrap { flex:1; display:flex; align-items:center; justify-content:center; }
  .img-wrap img { max-width:100%; max-height:100%; object-fit:contain; transition:opacity .1s; }
  .img-counter { position:absolute; top:10px; right:12px; background:rgba(0,0,0,.65); padding:3px 10px; border-radius:4px; font-size:12px; color:var(--muted); }
  .rescued-flash { position:absolute; top:10px; left:12px; background:#0d2414; border:1px solid var(--green); color:var(--green); padding:4px 12px; border-radius:4px; font-size:13px; font-weight:600; display:none; }
  .nav-hint { position:absolute; bottom:10px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,.6); padding:4px 14px; border-radius:4px; font-size:12px; color:var(--muted); white-space:nowrap; }

  .info-panel { width:260px; flex-shrink:0; border-left:1px solid var(--border); display:flex; flex-direction:column; }
  .info-body { flex:1; padding:16px; overflow-y:auto; }
  .lbl { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .val { font-size:14px; font-weight:500; margin-bottom:12px; }
  .val.big { font-size:19px; font-weight:700; }
  .val.green { color:var(--green); }
  .val.blue  { color:var(--blue); }
  .title-small { font-size:12px; color:var(--muted); line-height:1.5; }

  .action { border-top:1px solid var(--border); padding:14px; background:var(--surface); }
  .btn-rescue { width:100%; padding:13px; border-radius:6px; border:1px solid var(--green); background:#0d2414; color:var(--green); font-size:14px; font-weight:600; cursor:pointer; }
  .btn-rescue:hover { opacity:.85; }
  .hint { text-align:center; font-size:11px; color:var(--muted); margin-top:8px; }

  .done { display:none; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:10px; }
  .done h2 { font-size:22px; }
  .done p { color:var(--muted); }
</style>
</head>
<body>

<div class="topbar">
  <h1>Review No-Cert Export</h1>
  <div class="pos">Listing <b id="pos">1</b> / <b id="total">—</b></div>
  <div class="rescued-count" id="rescued-count" style="display:none">✓ <b id="rescued-num">0</b> images rescued</div>
</div>

<div class="main" id="main-view">
  <div class="img-panel">
    <div class="img-wrap"><img id="main-img" src="" alt=""></div>
    <div class="img-counter" id="img-counter"></div>
    <div class="rescued-flash" id="rescued-flash">✓ Image rescued</div>
    <div class="nav-hint">← → listings &nbsp;·&nbsp; ↑ ↓ images &nbsp;·&nbsp; R = rescue THIS image only</div>
  </div>

  <div class="info-panel">
    <div class="info-body">
      <div class="lbl">Card</div>
      <div class="val big" id="info-card">—</div>
      <div class="val" id="info-set" style="color:var(--muted);font-size:13px;margin-top:-8px"></div>
      <div style="height:12px"></div>
      <div class="lbl">Grader &amp; Grade</div>
      <div class="val green" id="info-grader">—</div>
      <div class="lbl">Price</div>
      <div class="val blue" id="info-price">—</div>
      <div class="lbl">Sold Date</div>
      <div class="val" id="info-date">—</div>
      <div class="lbl">eBay Title</div>
      <div class="title-small" id="info-title">—</div>
    </div>
    <div class="action">
      <button class="btn-rescue" onclick="rescue()">↩ Rescue this image &nbsp;[R]</button>
      <div class="hint">Saves this image for reprocessing.<br>Other images in this listing are unaffected.</div>
    </div>
  </div>
</div>

<div class="done" id="done-view">
  <h2>All checked!</h2>
  <p id="done-msg"></p>
</div>

<script>
let items   = [];
let idx     = 0;
let imgIdx  = 0;
let rescued = 0;

async function init() {
  const res = await fetch('/api/items');
  items = await res.json();
  document.getElementById('total').textContent = items.length;
  if (!items.length) { showDone(); return; }
  render();
}

function render() {
  if (!items.length) { showDone(); return; }
  if (idx >= items.length) idx = items.length - 1;
  const item = items[idx];
  imgIdx = Math.min(imgIdx, item.images.length - 1);
  showImg();
  document.getElementById('pos').textContent         = idx + 1;
  document.getElementById('info-card').textContent   = item.meta.cardName  || '—';
  document.getElementById('info-set').textContent    = item.meta.setName   || '—';
  document.getElementById('info-grader').textContent = (item.meta.grader||'—') + ' ' + (item.meta.grade ?? '');
  document.getElementById('info-price').textContent  = item.meta.price != null ? '$' + Number(item.meta.price).toFixed(2) : '—';
  document.getElementById('info-date').textContent   = item.meta.soldDate  || '—';
  document.getElementById('info-title').textContent  = item.meta.title     || '—';
}

function showImg() {
  const item = items[idx];
  const img  = document.getElementById('main-img');
  img.style.opacity = '0';
  img.src = '/img/' + item.dirName + '/' + item.images[imgIdx];
  img.onload = () => img.style.opacity = '1';
  document.getElementById('img-counter').textContent = (imgIdx + 1) + ' / ' + item.images.length;
}

async function rescue() {
  const item      = items[idx];
  const imageName = item.images[imgIdx];

  await fetch('/api/rescue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirName: item.dirName, itemId: item.itemId, imageName }),
  });

  // Remove just this image from the local list
  item.images.splice(imgIdx, 1);
  rescued++;
  document.getElementById('rescued-num').textContent         = rescued;
  document.getElementById('rescued-count').style.display     = '';

  // Flash confirmation
  const flash = document.getElementById('rescued-flash');
  flash.style.display = 'block';
  setTimeout(() => flash.style.display = 'none', 1200);

  if (item.images.length === 0) {
    // All images in this listing rescued — remove listing from list
    items.splice(idx, 1);
    document.getElementById('total').textContent = items.length;
    if (idx >= items.length) idx = Math.max(0, items.length - 1);
    imgIdx = 0;
  } else {
    // Stay on same listing, clamp imgIdx
    imgIdx = Math.min(imgIdx, item.images.length - 1);
  }

  render();
}

function showDone() {
  document.getElementById('main-view').style.display  = 'none';
  const dv = document.getElementById('done-view');
  dv.style.display = 'flex';
  document.getElementById('done-msg').textContent =
    rescued + ' images rescued to data/rescued_images/ · remaining listings confirmed no-cert';
}

document.addEventListener('keydown', e => {
  const k = e.key;
  if (k === 'ArrowRight') { idx = Math.min(idx + 1, items.length - 1); imgIdx = 0; render(); }
  if (k === 'ArrowLeft')  { idx = Math.max(idx - 1, 0);               imgIdx = 0; render(); }
  if (k === 'ArrowDown')  { imgIdx = Math.min(imgIdx + 1, (items[idx]?.images.length || 1) - 1); showImg(); }
  if (k === 'ArrowUp')    { imgIdx = Math.max(imgIdx - 1, 0);          showImg(); }
  if (k.toLowerCase() === 'r') rescue();
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

  if (req.url === '/api/rescue' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { dirName, itemId, imageName } = JSON.parse(body);
        const src  = path.join(EXPORT_DIR, dirName, imageName);
        // Save as itemId_imageName so filenames stay unique in the flat folder
        const dest = path.join(RESCUED_DIR, itemId + '_' + imageName);
        if (fs.existsSync(src)) fs.copyFileSync(src, dest);
        // Remove from export folder
        try { fs.unlinkSync(src); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve images from export folder
  const m = req.url.match(/^\/img\/([^/]+)\/(.+)$/);
  if (m) {
    const filePath = path.join(EXPORT_DIR, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
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
  const items = loadItems();
  console.log(`\nNo-cert review running at http://localhost:${PORT}`);
  console.log(`  ${items.length} listings to check`);
  console.log(`  Rescued images → data/rescued_images/`);
  console.log('\n  ← →  navigate listings');
  console.log('  ↑ ↓  flip images within a listing');
  console.log('  R    rescue THIS image only (not the whole listing)\n');
});
