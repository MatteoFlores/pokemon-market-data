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
const DIAG_F      = path.join(BASE, 'recon', 'failure_diagnostics.json');

// Manifest is loaded once into memory. All reads use this object directly —
// no per-request disk reads, so concurrent saves can't overwrite each other.
if (!fs.existsSync(MANIFEST_F)) {
  console.error('ERROR: manifest not found. Run: python validation/prepare_test_crops.py');
  process.exit(1);
}
let manifest = JSON.parse(fs.readFileSync(MANIFEST_F, 'utf8'));

// Review items: mismatch crops from failure_diagnostics.json
// { name → { ocrPred: string|null } }
const CERT_RE_JS = /\b(\d{8,13})\b/;
const reviewItems = {};
if (fs.existsSync(DIAG_F)) {
  const diag = JSON.parse(fs.readFileSync(DIAG_F, 'utf8'));
  for (const [name, e] of Object.entries(diag)) {
    const allTexts = [
      ...e.easyOcr.results.map(r => r.text),
      ...e.paddleOcr.results.map(r => r.text),
    ];
    const m = CERT_RE_JS.exec(allTexts.join(' '));
    const ocrPred = m ? m[1] : null;
    if (ocrPred !== e.trueCert) {
      reviewItems[name] = { ocrPred, easyTexts: e.easyOcr.results.map(r => r.text) };
    }
  }
}

function saveManifest() {
  fs.writeFileSync(MANIFEST_F, JSON.stringify(manifest, null, 2), 'utf8');
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

// ── Live sync ─────────────────────────────────────────────────────────────────

const sseClients = new Set();
const claimed    = new Map(); // name → { clientId, ts }

function broadcast(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ── API: save label ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/label') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { name, trueCert, skipped } = JSON.parse(body);
        if (!manifest[name]) {
          res.writeHead(404); res.end('not found'); return;
        }
        manifest[name].trueCert = trueCert || null;
        manifest[name].skipped  = skipped  || false;
        saveManifest();
        const total = saveOutput(manifest);
        broadcast({ type: 'saved', name, trueCert: manifest[name].trueCert, skipped: manifest[name].skipped });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
    return;
  }

  // ── API: review items (mismatch list) ────────────────────────────────────────
  if (url.pathname === '/api/review-items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reviewItems));
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

  // ── SSE: live updates ───────────────────────────────────────────────────────
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'users', count: sseClients.size + 1 }) + '\n\n');
    sseClients.add(res);
    broadcast({ type: 'users', count: sseClients.size });
    req.on('close', () => { sseClients.delete(res); broadcast({ type: 'users', count: sseClients.size }); });
    return;
  }

  // ── Next item: atomic pick + claim (no two clients get the same item) ────────
  if (req.method === 'POST' && url.pathname === '/api/next') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { clientId, afterName } = JSON.parse(body);
        // Release any previous claim by this client
        for (const [k, v] of claimed) if (v.clientId === clientId) claimed.delete(k);
        // Find next unclaimed, unlabeled item after afterName
        const names  = Object.keys(manifest);
        const start  = afterName ? names.indexOf(afterName) + 1 : 0;
        const next   = names.slice(start).find(n =>
          !manifest[n].trueCert && !manifest[n].skipped && !claimed.has(n)
        );
        if (next) {
          claimed.set(next, { clientId, ts: Date.now() });
          broadcast({ type: 'claimed', name: next, clientId });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: next || null }));
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }

  // ── Claim only (manual navigation) ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/claim') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { clientId, name } = JSON.parse(body);
        for (const [k, v] of claimed) if (v.clientId === clientId) claimed.delete(k);
        if (name) claimed.set(name, { clientId, ts: Date.now() });
        broadcast({ type: 'claimed', name: name || null, clientId });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
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

  const total   = Object.keys(manifest).length;
  const labeled = Object.values(manifest).filter(v => v.trueCert || v.skipped).length;
  console.log(`\nCert Labeling Tool`);
  console.log(`  This machine : http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN          : http://${ip}:${PORT}`);
  console.log(`\n  Total crops : ${total}`);
  console.log(`  Labeled     : ${labeled}`);
  console.log(`  Remaining   : ${total - labeled}`);
  const nReview = Object.keys(reviewItems).length;
  if (nReview > 0) {
    console.log(`\n  Review mode  : http://localhost:${PORT}/?mode=review  (${nReview} mismatches)`);
    for (const ip of ips) console.log(`  Review (LAN) : http://${ip}:${PORT}/?mode=review`);
  }
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
#review-badge { background: #e67e22; color: #000; font-size: 11px; font-weight: bold;
                padding: 2px 8px; border-radius: 10px; letter-spacing: 0.05em;
                display: none; }
#progress-text { font-size: 13px; color: #888; margin-left: auto; }

#main { display: flex; flex: 1; overflow: hidden; }

#img-panel { flex: 1; display: flex; align-items: center; justify-content: center;
             background: #111; padding: 20px; overflow: hidden; position: relative; }
#crop-img { max-width: 100%; max-height: calc(100% - 60px); object-fit: contain;
            border-radius: 6px; border: 2px solid #333;
            image-rendering: pixelated; }
#zoom-hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
             font-size: 11px; color: #444; }

#side-panel { width: 320px; background: #1a1a1a; border-left: 1px solid #333;
              padding: 20px; display: flex; flex-direction: column; gap: 14px;
              overflow-y: auto; flex-shrink: 0; }

.info-row { display: flex; flex-direction: column; gap: 3px; }
.info-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
.info-value { font-size: 14px; color: #ddd; font-family: monospace; }
.pipeline-cert { font-size: 18px; color: #f1c40f; font-weight: bold; }

/* Review mode comparison block */
#review-block { display: none; background: #141414; border: 1px solid #444;
                border-radius: 8px; padding: 12px; gap: 10px; flex-direction: column; }
#review-block.visible { display: flex; }
.review-row { display: flex; flex-direction: column; gap: 3px; }
.review-lbl { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
.review-val { font-size: 20px; font-family: monospace; font-weight: bold;
              letter-spacing: 0.08em; }
.review-val.my-label { color: #3498db; }
.review-val.ocr-pred  { color: #e67e22; }
.review-val.match     { color: #2ecc71; }
.diff-chars span.ok  { color: #2ecc71; }
.diff-chars span.bad { color: #e74c3c; background: rgba(231,76,60,0.2);
                       border-radius: 3px; padding: 0 1px; }

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
  <span id="review-badge">REVIEW MODE</span>
  <div id="progress-text">Loading...</div>
  <span id="user-count" style="font-size:12px;color:#888;margin-left:8px;white-space:nowrap;">1 user</span>
</div>
<div id="main">
  <div id="img-panel">
    <img id="crop-img" src="" alt="crop">
    <div id="zoom-hint">image shown at full pixel size</div>
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

    <!-- Review mode: side-by-side comparison -->
    <div id="review-block">
      <div class="review-row">
        <span class="review-lbl">Your label (blue)</span>
        <span class="review-val my-label" id="rv-my-label">—</span>
      </div>
      <div class="review-row">
        <span class="review-lbl">OCR read (orange)</span>
        <span class="review-val ocr-pred" id="rv-ocr-pred">—</span>
      </div>
      <div class="review-row">
        <span class="review-lbl">Diff (red = mismatch)</span>
        <span class="diff-chars" id="rv-diff">—</span>
      </div>
    </div>

    <hr style="border-color:#333">
    <div class="info-row">
      <span class="info-label" id="input-label">Type cert number — exactly what you see (Enter to save)</span>
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
<div id="hintbar" id="hintbar">
  Enter = save cert &nbsp;|&nbsp; S = skip (unreadable) &nbsp;|&nbsp;
  ← = go back &nbsp;|&nbsp; → = next without saving
</div>

<script>
let manifest = {};
let reviewData = {};  // { name: { ocrPred } } — populated in review mode
let items = [];
let idx   = 0;
const _clientId = Math.random().toString(36).slice(2);
const isReview = new URLSearchParams(location.search).get('mode') === 'review';

if (isReview) {
  document.getElementById('review-badge').style.display = 'inline';
  document.getElementById('review-block').classList.add('visible');
  document.getElementById('input-label').textContent =
    'Correct if wrong, keep if right — Enter to confirm';
  document.getElementById('hintbar').textContent =
    'Enter = confirm/correct  |  S = mark unreadable  |  ← = back  |  → = next';
}

const _es = new EventSource('/api/events');
_es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'users') {
    const el = document.getElementById('user-count');
    if (el) el.textContent = ev.count + (ev.count === 1 ? ' user' : ' users');
  }
  if (ev.type === 'saved' && ev.name in manifest) {
    manifest[ev.name].trueCert = ev.trueCert;
    manifest[ev.name].skipped  = ev.skipped;
    updateProgress();
  }
};

function flash(msg, cls) {
  const el = document.getElementById('flash');
  el.textContent = msg;
  el.className = cls;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 1800);
}

function diffSpans(a, b) {
  // Render b (OCR pred) with each char highlighted if it differs from a (true)
  const len = Math.max(a.length, b.length);
  const pa = a.padStart(len, ' '), pb = b.padStart(len, ' ');
  return pb.split('').map((ch, i) =>
    \`<span class="\${pa[i] === ch ? 'ok' : 'bad'}">\${ch}</span>\`
  ).join('');
}

function updateProgress() {
  const reviewed = items.filter(n => manifest[n].trueCert || manifest[n].skipped).length;
  document.getElementById('progress-text').textContent =
    isReview
      ? reviewed + ' / ' + items.length + ' reviewed'
      : reviewed + ' / ' + items.length + ' labeled';
}

function load(i) {
  if (i < 0 || i >= items.length) return;
  idx = i;
  const name = items[idx];
  fetch('/api/claim', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name, clientId: _clientId }) }).catch(()=>{});
  const item = manifest[name];

  // Scale image up so tiny crops are visible
  const imgEl = document.getElementById('crop-img');
  imgEl.style.imageRendering = 'pixelated';
  imgEl.style.width  = '';
  imgEl.style.height = '';
  imgEl.src = '/images/' + encodeURIComponent(name);
  imgEl.onload = () => {
    // If image is very small, scale up to be visible (up to 4x, max 600px wide)
    const naturalW = imgEl.naturalWidth;
    if (naturalW < 200) {
      const scale = Math.min(4, Math.floor(600 / naturalW));
      imgEl.style.width  = (naturalW * scale) + 'px';
      imgEl.style.height = 'auto';
    }
  };

  document.getElementById('item-id').textContent   = item.itemId;
  document.getElementById('card-name').textContent  = item.cardName || '—';
  document.getElementById('grader').textContent     = item.grader  || '—';
  document.getElementById('crop-type').textContent  = item.cropType || '—';
  document.getElementById('pipeline-cert').textContent = item.pipelineCert || '—';

  // Review mode: populate comparison block
  if (isReview && reviewData[name]) {
    const myLabel = item.trueCert || '';
    const ocrPred = reviewData[name].ocrPred || '(nothing)';
    document.getElementById('rv-my-label').textContent = myLabel || '(none)';
    document.getElementById('rv-ocr-pred').textContent = ocrPred;
    if (myLabel && ocrPred && myLabel === ocrPred) {
      document.getElementById('rv-diff').innerHTML =
        '<span class="ok">exact match</span>';
    } else {
      document.getElementById('rv-diff').innerHTML = diffSpans(myLabel, ocrPred);
    }
  }

  const inp = document.getElementById('cert-input');
  inp.value = item.trueCert || '';
  inp.classList.remove('bad');
  inp.focus();
  // Select all so user can immediately retype if wrong
  inp.select();

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

  if (isReview) {
    // In review mode just advance manually — no atomic next needed (small fixed set)
    if (idx + 1 < items.length) load(idx + 1);
    else { updateProgress(); flash('All reviewed!', 'saved'); }
    return;
  }

  const nr = await fetch('/api/next', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: _clientId, afterName: name }),
  });
  const { name: nextName } = await nr.json();
  if (nextName) {
    const nextIdx = items.indexOf(nextName);
    if (nextIdx >= 0) load(nextIdx);
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
  const [mRes, rvRes] = await Promise.all([
    fetch('/api/manifest'),
    fetch('/api/review-items'),
  ]);
  manifest    = await mRes.json();
  reviewData  = await rvRes.json();

  if (isReview) {
    // Only show the mismatch crops, in order
    items = Object.keys(manifest).filter(n => n in reviewData);
    if (items.length === 0) {
      document.getElementById('progress-text').textContent = 'No mismatches found — run eval first';
      return;
    }
    load(0);
  } else {
    items = Object.keys(manifest);
    let start = items.findIndex(n => !manifest[n].trueCert && !manifest[n].skipped);
    if (start === -1) start = 0;
    load(start);
  }
})();
</script>
</body>
</html>`;

