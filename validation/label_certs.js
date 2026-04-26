/**
 * validation/label_certs.js
 *
 * Simple labeling tool for cert number crops.
 * Opens at http://localhost:3006
 *
 * Controls:
 *   Type a number + Enter  — save as true cert
 *   S key                  — skip (unreadable to human, don't count against pipeline)
 *   left arrow / Backspace — go back one
 *   right arrow            — advance without saving
 *
 * Saves labeled certs to: data/labeled_test_set.json
 * Progress tracked in:    data/test_crops/manifest.json  (trueCert / skipped fields)
 *
 * Usage:
 *   node validation/label_certs.js
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const PORT        = 3006;
const BASE        = path.resolve(__dirname, '..');
const MANIFEST_F  = path.join(BASE, 'data', 'test_crops', 'manifest.json');
const IMAGES_DIR  = path.join(BASE, 'data', 'test_crops', 'images');
const OUTPUT_F    = path.join(BASE, 'data', 'labeled_test_set.json');

function loadManifest() {
  if (!fs.existsSync(MANIFEST_F)) {
    console.error('ERROR: manifest not found. Run: python validation/prepare_test_crops.py');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_F, 'utf8'));
}

function saveManifest(m) {
  fs.writeFileSync(MANIFEST_F, JSON.stringify(m, null, 2), 'utf8');
}

function saveOutput(manifest) {
  const labeled = {};
  for (const [name, item] of Object.entries(manifest)) {
    if (item.trueCert || item.skipped) {
      labeled[name] = {
        itemId:       item.itemId,
        imagePath:    path.join(IMAGES_DIR, name),
        trueCert:     item.trueCert || null,
        skipped:      item.skipped || false,
        grader:       item.grader,
        cardName:     item.cardName,
        pipelineCert: item.pipelineCert,
        cropType:     item.cropType,
      };
    }
  }
  fs.writeFileSync(OUTPUT_F, JSON.stringify(labeled, null, 2), 'utf8');
  return Object.keys(labeled).length;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ── API: save label ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/label') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, trueCert, skipped } = JSON.parse(body);
        const manifest = loadManifest();
        if (!manifest[name]) {
          res.writeHead(404); res.end('not found'); return;
        }
        manifest[name].trueCert = trueCert || null;
        manifest[name].skipped  = skipped  || false;
        saveManifest(manifest);
        const total = saveOutput(manifest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, totalLabeled: total }));
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    return;
  }

  // ── API: manifest data ───────────────────────────────────────────────────────
  if (url.pathname === '/api/manifest') {
    const manifest = loadManifest();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
    return;
  }

  // ── Static: serve crop images ────────────────────────────────────────────────
  if (url.pathname.startsWith('/images/')) {
    const name = path.basename(url.pathname);
    const p    = path.join(IMAGES_DIR, name);
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(fs.readFileSync(p));
    } else {
      res.writeHead(404); res.end('not found');
    }
    return;
  }

  // ── Main page ────────────────────────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(nets)) {
    for (const n of iface) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }

  const m = loadManifest();
  const total   = Object.keys(m).length;
  const labeled = Object.values(m).filter(v => v.trueCert || v.skipped).length;
  console.log(`\nCert Labeling Tool`);
  console.log(`  This machine : http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN          : http://${ip}:${PORT}`);
  console.log(`\n  Total crops : ${total}`);
  console.log(`  Labeled     : ${labeled}`);
  console.log(`  Remaining   : ${total - labeled}`);
  console.log(`\nControls: type cert + Enter  |  S = skip  |  ← back\n`);
});

// ── HTML ─────────────────────────────────────────────────────────────────────

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Cert Labeling</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0d0d0d; color: #ddd; font-family: 'Segoe UI', sans-serif;
       display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

#topbar { background: #1a1a1a; border-bottom: 1px solid #333; padding: 10px 20px;
          display: flex; align-items: center; gap: 20px; flex-shrink: 0; }
#topbar h1 { font-size: 16px; color: #eee; }
#progress-text { font-size: 13px; color: #888; margin-left: auto; }

#main { display: flex; flex: 1; overflow: hidden; }

#img-panel { flex: 1; display: flex; align-items: center; justify-content: center;
             background: #111; padding: 20px; overflow: hidden; }
#crop-img { max-width: 100%; max-height: 100%; object-fit: contain;
            border-radius: 6px; border: 2px solid #333; }

#side-panel { width: 320px; background: #1a1a1a; border-left: 1px solid #333;
              padding: 20px; display: flex; flex-direction: column; gap: 14px;
              overflow-y: auto; flex-shrink: 0; }

.info-row { display: flex; flex-direction: column; gap: 3px; }
.info-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
.info-value { font-size: 14px; color: #ddd; font-family: monospace; }
.pipeline-cert { font-size: 18px; color: #f1c40f; font-weight: bold; }

#cert-input { width: 100%; padding: 12px; font-size: 22px; font-family: monospace;
              background: #111; color: #2ecc71; border: 2px solid #2ecc71;
              border-radius: 6px; text-align: center; letter-spacing: 0.1em; outline: none; }
#cert-input:focus { border-color: #27ae60; box-shadow: 0 0 0 3px rgba(46,204,113,0.2); }
#cert-input.bad { border-color: #e74c3c; color: #e74c3c; }

#btn-row { display: flex; gap: 8px; }
button { flex: 1; padding: 10px; border: none; border-radius: 6px; cursor: pointer;
         font-size: 13px; font-weight: bold; }
#btn-save   { background: #2ecc71; color: #000; }
#btn-save:hover { background: #27ae60; }
#btn-skip   { background: #555; color: #eee; }
#btn-skip:hover { background: #444; }
#btn-back   { background: #333; color: #eee; }
#btn-back:hover { background: #2a2a2a; }

#flash { height: 28px; display: flex; align-items: center; justify-content: center;
         font-size: 13px; font-weight: bold; border-radius: 6px;
         transition: opacity 0.4s; }
#flash.saved  { background: rgba(46,204,113,0.2); color: #2ecc71; }
#flash.skip   { background: rgba(149,165,166,0.2); color: #95a5a6; }
#flash.err    { background: rgba(231,76,60,0.2); color: #e74c3c; }
#flash.hidden { opacity: 0; }

#hintbar { background: #111; border-top: 1px solid #222; padding: 6px 20px;
           font-size: 11px; color: #555; text-align: center; flex-shrink: 0; }
</style>
</head>
<body>
<div id="topbar">
  <h1>Cert Labeling</h1>
  <div id="progress-text">Loading...</div>
</div>
<div id="main">
  <div id="img-panel">
    <img id="crop-img" src="" alt="crop">
  </div>
  <div id="side-panel">
    <div class="info-row">
      <span class="info-label">Item ID</span>
      <span class="info-value" id="item-id">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Card</span>
      <span class="info-value" id="card-name">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Grader</span>
      <span class="info-value" id="grader">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Crop type</span>
      <span class="info-value" id="crop-type">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Pipeline guess</span>
      <span class="info-value pipeline-cert" id="pipeline-cert">—</span>
    </div>
    <hr style="border-color:#333">
    <div class="info-row">
      <span class="info-label">Type cert number — exactly what you see (Enter to save)</span>
      <input id="cert-input" type="text" placeholder="e.g. 12345678"
             maxlength="13" autocomplete="off" spellcheck="false">
    </div>
    <div id="btn-row">
      <button id="btn-save">Save (Enter)</button>
      <button id="btn-skip">Skip [S]</button>
      <button id="btn-back">← Back</button>
    </div>
    <div id="flash" class="hidden"></div>
  </div>
</div>
<div id="hintbar">
  Enter = save cert &nbsp;|&nbsp; S = skip (unreadable) &nbsp;|&nbsp;
  ← = go back &nbsp;|&nbsp; → = next without saving
</div>

<script>
let manifest = {};
let items = [];   // array of names in order
let idx   = 0;

function flash(msg, cls) {
  const el = document.getElementById('flash');
  el.textContent = msg;
  el.className = cls;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 1800);
}

function updateProgress() {
  const labeled = items.filter(n => manifest[n].trueCert || manifest[n].skipped).length;
  document.getElementById('progress-text').textContent =
    labeled + ' / ' + items.length + ' labeled';
}

function load(i) {
  if (i < 0 || i >= items.length) return;
  idx = i;
  const name = items[idx];
  const item = manifest[name];

  document.getElementById('crop-img').src = '/images/' + encodeURIComponent(name);
  document.getElementById('item-id').textContent   = item.itemId;
  document.getElementById('card-name').textContent  = item.cardName || '—';
  document.getElementById('grader').textContent     = item.grader  || '—';
  document.getElementById('crop-type').textContent  = item.cropType || '—';
  document.getElementById('pipeline-cert').textContent = item.pipelineCert || '—';

  const inp = document.getElementById('cert-input');
  inp.value = item.trueCert || '';
  inp.classList.remove('bad');
  inp.focus();

  document.getElementById('flash').className = 'hidden';
  updateProgress();
}

async function saveLabel(skipped) {
  const name = items[idx];
  const inp  = document.getElementById('cert-input');
  const raw  = inp.value.trim().replace(/\\s+/g,'');

  if (!skipped && !/^\\d{6,13}$/.test(raw)) {
    inp.classList.add('bad');
    flash('Need digits only (6–13 digits)', 'err');
    return;
  }
  inp.classList.remove('bad');

  const payload = { name, trueCert: skipped ? null : raw, skipped: !!skipped };
  const r = await fetch('/api/label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) { flash('Save failed', 'err'); return; }

  manifest[name].trueCert = payload.trueCert;
  manifest[name].skipped  = payload.skipped;

  if (skipped) {
    flash('Skipped', 'skip');
  } else {
    flash('Saved: ' + raw, 'saved');
  }

  // Advance to next unlabeled
  let next = idx + 1;
  while (next < items.length && (manifest[items[next]].trueCert || manifest[items[next]].skipped)) {
    next++;
  }
  if (next < items.length) {
    load(next);
  } else {
    updateProgress();
    flash('All done!', 'saved');
  }
}

document.getElementById('btn-save').onclick = () => saveLabel(false);
document.getElementById('btn-skip').onclick = () => saveLabel(true);
document.getElementById('btn-back').onclick = () => load(Math.max(0, idx - 1));

document.addEventListener('keydown', e => {
  if (e.target.id === 'cert-input') {
    if (e.key === 'Enter') { e.preventDefault(); saveLabel(false); return; }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); saveLabel(true); return; }
    if (e.key === 'Backspace' && e.target.value === '') { e.preventDefault(); load(Math.max(0, idx-1)); return; }
    return;
  }
  if (e.key === 'ArrowLeft')  load(Math.max(0, idx - 1));
  if (e.key === 'ArrowRight') load(Math.min(items.length - 1, idx + 1));
});

(async () => {
  const r = await fetch('/api/manifest');
  manifest = await r.json();
  items = Object.keys(manifest);

  // Jump to first unlabeled
  let start = items.findIndex(n => !manifest[n].trueCert && !manifest[n].skipped);
  if (start === -1) start = 0;
  load(start);
})();
</script>
</body>
</html>`;

