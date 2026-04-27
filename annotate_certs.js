'use strict';

/**
 * annotate_certs.js
 *
 * Draw bounding boxes around cert numbers on cropped label images.
 * Builds the training dataset for the cert-region detector (Model 2).
 *
 * Prerequisite: python prepare_annotation_crops.py
 *
 * Draw a box around the cert number, then press a class key to save + advance.
 * Press a class key without a box to correct the grader label and skip the box.
 *
 * Keys:
 *   P / 1    PSA cert number
 *   B / 2    BGS/Beckett cert number
 *   C / 3    CGC cert number
 *   A / 4    TAG QR code
 *   S / 0    Skip (no cert visible / bad crop)
 *   X / Del  Clear current box
 *   ← →     Navigate (without saving)
 *
 * Annotations saved as YOLO label files in data/annotation_crops/labels/
 * Run: node annotate_certs.js
 * Open: http://localhost:3004
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = 3004;
const CROPS_DIR  = path.join(__dirname, 'data', 'annotation_crops', 'images');
const LABELS_DIR = path.join(__dirname, 'data', 'annotation_crops', 'labels');
const MANIFEST_F = path.join(__dirname, 'data', 'annotation_crops', 'manifest.json');

if (!fs.existsSync(CROPS_DIR))  { console.error('Run prepare_annotation_crops.py first.'); process.exit(1); }
if (!fs.existsSync(LABELS_DIR)) fs.mkdirSync(LABELS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

let _manifestCache = null;
function loadManifest() {
  if (_manifestCache) return _manifestCache;
  try { _manifestCache = JSON.parse(fs.readFileSync(MANIFEST_F, 'utf8')); } catch { _manifestCache = {}; }
  return _manifestCache;
}
function saveManifest(m) {
  _manifestCache = m;
  fs.writeFileSync(MANIFEST_F, JSON.stringify(m, null, 2));
}

function getItems() {
  const manifest = loadManifest();
  return Object.entries(manifest).map(([name, meta]) => ({ name, ...meta }));
}

function getStats() {
  const manifest = loadManifest();
  const vals     = Object.values(manifest);
  const byGrader = {};
  for (const v of vals) {
    const g = v.grader || 'unknown';
    if (!byGrader[g]) byGrader[g] = { total: 0, annotated: 0, skipped: 0 };
    byGrader[g].total++;
    if (v.annotated) byGrader[g].annotated++;
    if (v.skipped)   byGrader[g].skipped++;
  }
  return {
    total:     vals.length,
    annotated: vals.filter(v => v.annotated).length,
    skipped:   vals.filter(v => v.skipped).length,
    byGrader,
  };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Annotate Cert Numbers</title>
<style>
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --bg:#0d1117; --surface:#161b22; --border:#30363d;
    --text:#e6edf3; --muted:#8b949e;
    --psa:#58a6ff; --bgs:#bc8cff; --cgc:#d29922; --ace:#3fb950;
    --skip:#8b949e;
  }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }

  .topbar { background:var(--surface); border-bottom:1px solid var(--border); padding:8px 20px; display:flex; align-items:center; gap:14px; flex-shrink:0; }
  .topbar h1 { font-size:14px; font-weight:600; }
  .pos  { color:var(--muted); font-size:13px; }
  .pos b { color:var(--text); }
  .tally { margin-left:auto; display:flex; gap:14px; font-size:12px; color:var(--muted); }
  .tally b { color:var(--text); }

  .main { display:flex; flex:1; overflow:hidden; }

  /* Canvas panel */
  .canvas-panel { flex:1; position:relative; background:#050709; overflow:hidden; cursor:crosshair; }
  #canvas { display:block; width:100%; height:100%; }

  .hint-overlay { position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
    background:rgba(0,0,0,.7); padding:5px 16px; border-radius:4px; font-size:12px;
    color:var(--muted); white-space:nowrap; pointer-events:none; }
  .hint-overlay b { color:var(--text); }

  /* Info + action panel */
  .side-panel { width:260px; flex-shrink:0; border-left:1px solid var(--border); display:flex; flex-direction:column; }
  .side-body   { flex:1; padding:16px; overflow-y:auto; }

  .lbl { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .val { font-size:14px; font-weight:500; margin-bottom:12px; line-height:1.4; }
  .val.big { font-size:18px; font-weight:700; }
  .detected { font-size:12px; color:var(--muted); margin-top:-8px; margin-bottom:12px; }

  .psa-color { color:var(--psa); }
  .bgs-color { color:var(--bgs); }
  .cgc-color { color:var(--cgc); }
  .ace-color { color:var(--ace); }
  .skip-color { color:var(--skip); }

  .actions { border-top:1px solid var(--border); padding:12px; background:var(--surface); }
  .btn-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px; }
  .btn { padding:10px 6px; border-radius:5px; border:1px solid; font-size:12px; font-weight:700;
         cursor:pointer; letter-spacing:.03em; text-align:center; }
  .btn:hover { opacity:.8; }
  .btn-psa  { border-color:var(--psa);  background:#0d1e33; color:var(--psa); }
  .btn-bgs  { border-color:var(--bgs);  background:#1a0d33; color:var(--bgs); }
  .btn-cgc  { border-color:var(--cgc);  background:#1e1600; color:var(--cgc); }
  .btn-ace  { border-color:var(--ace);  background:#0d2414; color:var(--ace); }
  .btn-skip { border-color:var(--border); background:transparent; color:var(--muted); font-size:11px; }
  .btn-clear{ border-color:var(--border); background:transparent; color:var(--muted); font-size:11px; }
  .btn-row  { display:flex; gap:6px; }

  .key-hint { color:var(--muted); font-size:10px; font-weight:400; }

  .progress-bar { height:3px; background:var(--border); flex-shrink:0; }
  .progress-fill { height:100%; background:var(--psa); transition:width .3s; }

  .flash { position:absolute; top:10px; left:12px; padding:4px 14px; border-radius:4px;
           font-size:14px; font-weight:700; display:none; pointer-events:none; }
  .flash-psa  { background:#0d1e33; border:1px solid var(--psa);  color:var(--psa); }
  .flash-bgs  { background:#1a0d33; border:1px solid var(--bgs);  color:var(--bgs); }
  .flash-cgc  { background:#1e1600; border:1px solid var(--cgc);  color:var(--cgc); }
  .flash-ace  { background:#0d2414; border:1px solid var(--ace);  color:var(--ace); }
  .flash-skip { background:var(--surface); border:1px solid var(--border); color:var(--muted); }

  .done { display:none; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:12px; }
  .done h2 { font-size:22px; }
  .done p  { color:var(--muted); }
</style>
</head>
<body>

<div class="topbar">
  <h1>Annotate Cert Numbers</h1>
  <div class="pos">Item <b id="pos">—</b> / <b id="total">—</b></div>
  <div class="tally">
  <span id="user-count" style="font-size:12px;color:#8b949e;white-space:nowrap;">1 user</span>
    <span>Annotated: <b id="cnt-annotated">0</b></span>
    <span>Skipped: <b id="cnt-skipped">0</b></span>
    <span>Remaining: <b id="cnt-remaining">0</b></span>
  </div>
</div>
<div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>

<div class="main" id="main-view">
  <div class="canvas-panel" id="canvas-panel">
    <canvas id="canvas"></canvas>
    <div class="flash flash-psa"  id="flash-psa">PSA</div>
    <div class="flash flash-bgs"  id="flash-bgs">BGS</div>
    <div class="flash flash-cgc"  id="flash-cgc">CGC</div>
    <div class="flash flash-ace"  id="flash-ace">TAG</div>
    <div class="flash flash-skip" id="flash-skip">Skipped</div>
    <div class="hint-overlay">
      Draw box around cert number · then press class key
      &nbsp;|&nbsp; <b>S</b>=skip &nbsp;<b>X</b>=clear &nbsp;<b>← →</b>=navigate
    </div>
  </div>

  <div class="side-panel">
    <div class="side-body">
      <div class="lbl">Detected As</div>
      <div class="val big" id="info-detected">—</div>
      <div class="detected" id="info-conf"></div>

      <div class="lbl">Grader (from meta)</div>
      <div class="val" id="info-grader">—</div>

      <div class="lbl">Card</div>
      <div class="val" id="info-card" style="font-size:13px">—</div>

      <div class="lbl">Box status</div>
      <div class="val" id="info-box" style="font-size:12px;color:var(--muted)">No box drawn</div>
    </div>

    <div class="actions">
      <div class="btn-grid">
        <button class="btn btn-psa" onclick="annotate(0)">PSA <span class="key-hint">[P]</span></button>
        <button class="btn btn-bgs" onclick="annotate(1)">BGS <span class="key-hint">[B]</span></button>
        <button class="btn btn-cgc" onclick="annotate(2)">CGC <span class="key-hint">[C]</span></button>
        <button class="btn btn-ace" onclick="annotate(3)">TAG <span class="key-hint">[A]</span></button>
      </div>
      <div class="btn-row">
        <button class="btn btn-skip"  style="flex:2" onclick="skip()">Skip — no cert [S]</button>
        <button class="btn btn-clear" style="flex:1" onclick="clearBox()">Clear [X]</button>
      </div>
    </div>
  </div>
</div>

<div class="done" id="done-view">
  <h2>All annotated!</h2>
  <p id="done-msg"></p>
  <p style="color:var(--muted);font-size:13px;margin-top:8px">Run prepare_annotation_crops.py again to load more images.</p>
</div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────

const CLASSES = ['psa_cert', 'bgs_cert', 'cgc_cert', 'tag_qr'];
const NAMES   = ['PSA', 'BGS', 'CGC', 'TAG'];
const COLORS  = ['#58a6ff', '#bc8cff', '#d29922', '#3fb950'];
const KEYS    = { p:'0', '1':'0', b:'1', '2':'1', c:'2', '3':'2', a:'3', '4':'3' };
const GRADER_CLASS = { PSA: 0, BGS: 1, CGC: 2, TAG: 3, TAG: 3 };

let items = [];
let idx   = 0;
let item  = null;
const _clientId = Math.random().toString(36).slice(2);
const _claimed  = new Set();
const _es = new EventSource('/api/events');
_es.onmessage = e => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'users') {
    const el = document.getElementById('user-count');
    if (el) el.textContent = ev.count + (ev.count === 1 ? ' user' : ' users');
  }
  if (ev.type === 'claimed' && ev.clientId !== _clientId) {
    if (ev.name) _claimed.add(ev.name); else _claimed.clear();
  }
  if (ev.type === 'saved') {
    const it = items.find(i => i.name === ev.name);
    if (it) { it.annotated = ev.annotated; it.skipped = ev.skipped; }
    _claimed.delete(ev.name);
    updateTally();
    if (item && item.name === ev.name) advance();
  }
};

// Canvas
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
const panel  = document.getElementById('canvas-panel');

let imgEl  = new Image();
let imgW   = 0, imgH = 0;
let dispW  = 0, dispH = 0;
let offX   = 0, offY  = 0;

// Drawing state
let drawing = false;
let dragSX  = 0, dragSY = 0;
let box     = null;   // {x1,y1,x2,y2} normalized 0-1

let busy = false;

// ── Canvas sizing ─────────────────────────────────────────────────────────────

function layoutCanvas() {
  canvas.width  = panel.clientWidth;
  canvas.height = panel.clientHeight;
  if (!imgW) return;
  const scale = Math.min(canvas.width / imgW, canvas.height / imgH) * 0.95;
  dispW = imgW * scale;
  dispH = imgH * scale;
  offX  = (canvas.width  - dispW) / 2;
  offY  = (canvas.height - dispH) / 2;
}

window.addEventListener('resize', () => { layoutCanvas(); redraw(); });

// ── Drawing ───────────────────────────────────────────────────────────────────

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!imgEl.complete || !imgW) return;
  ctx.drawImage(imgEl, offX, offY, dispW, dispH);
  if (box) drawBox(box, currentBoxClass());
}

function drawBox(b, classId) {
  const color = COLORS[classId] ?? '#ffffff';
  const sx = offX + b.x1 * dispW;
  const sy = offY + b.y1 * dispH;
  const sw = (b.x2 - b.x1) * dispW;
  const sh = (b.y2 - b.y1) * dispH;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2;
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.fillStyle   = color + '22';
  ctx.fillRect(sx, sy, sw, sh);

  // Label tag
  const label = NAMES[classId] ?? '';
  ctx.font = 'bold 13px -apple-system, sans-serif';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(sx, sy - 20, tw, 20);
  ctx.fillStyle = '#0d1117';
  ctx.fillText(label, sx + 5, sy - 5);
  ctx.restore();
}

function currentBoxClass() {
  return GRADER_CLASS[item?.grader?.toUpperCase()] ?? item?.detectedClass ?? 0;
}

function screenToNorm(ex, ey) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (ex - r.left - offX) / dispW)),
    y: Math.max(0, Math.min(1, (ey - r.top  - offY) / dispH)),
  };
}

canvas.addEventListener('mousedown', e => {
  const n = screenToNorm(e.clientX, e.clientY);
  dragSX = n.x; dragSY = n.y;
  drawing = true;
  box = null;
});

canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  const n = screenToNorm(e.clientX, e.clientY);
  box = { x1: Math.min(dragSX, n.x), y1: Math.min(dragSY, n.y),
          x2: Math.max(dragSX, n.x), y2: Math.max(dragSY, n.y) };
  redraw();
});

canvas.addEventListener('mouseup', () => {
  drawing = false;
  if (box && (box.x2 - box.x1 < 0.01 || box.y2 - box.y1 < 0.01)) {
    box = null;  // too small, discard
  }
  updateBoxStatus();
  redraw();
});

// ── Item loading ──────────────────────────────────────────────────────────────

function loadItem() {
  item = items[idx];
  fetch('/api/claim', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: item.name, clientId: _clientId }) }).catch(()=>{});
  box    = item.annotation ? annToBox(item.annotation) : null;
  imgEl  = new Image();
  imgEl.onload = () => {
    imgW = imgEl.naturalWidth;
    imgH = imgEl.naturalHeight;
    layoutCanvas();
    redraw();
  };
  imgEl.src = '/img/' + encodeURIComponent(item.name);

  // Info panel
  document.getElementById('pos').textContent = idx + 1;

  const detName  = item.detectedName || '?';
  const detEl    = document.getElementById('info-detected');
  detEl.textContent = detName;
  detEl.className   = 'val big ' + (detName.toLowerCase() + '-color');

  document.getElementById('info-conf').textContent =
    item.confidence ? (item.confidence * 100).toFixed(0) + '% confidence' : '';

  const graderEl = document.getElementById('info-grader');
  graderEl.textContent = item.grader || '—';
  graderEl.className   = 'val ' + ((item.grader||'').toLowerCase() + '-color');

  document.getElementById('info-card').textContent = item.cardName || '—';
  updateBoxStatus();
}

function updateBoxStatus() {
  const el = document.getElementById('info-box');
  if (box) {
    const w = ((box.x2 - box.x1) * 100).toFixed(1);
    const h = ((box.y2 - box.y1) * 100).toFixed(1);
    el.textContent = 'Box drawn  ' + w + '% × ' + h + '%';
    el.style.color = '#3fb950';
  } else {
    el.textContent = 'No box drawn';
    el.style.color = 'var(--muted)';
  }
}

function annToBox(ann) {
  return {
    x1: ann.cx - ann.w / 2,
    y1: ann.cy - ann.h / 2,
    x2: ann.cx + ann.w / 2,
    y2: ann.cy + ann.h / 2,
  };
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function annotate(classId) {
  if (busy) return;
  if (!box) {
    // Remind user to draw a box first (flash red briefly)
    canvas.style.outline = '2px solid #f85149';
    setTimeout(() => canvas.style.outline = '', 400);
    return;
  }
  busy = true;

  const cx = (box.x1 + box.x2) / 2;
  const cy = (box.y1 + box.y2) / 2;
  const w  = box.x2 - box.x1;
  const h  = box.y2 - box.y1;

  await fetch('/api/annotate', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name: item.name, class: classId, cx, cy, w, h }),
  });

  showFlash(['psa','bgs','cgc','ace'][classId]);
  item.annotated  = true;
  item.annotation = { class: classId, cx, cy, w, h };
  advance();
  busy = false;
}

async function skip() {
  if (busy) return;
  busy = true;
  await fetch('/api/skip', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name: item.name }),
  });
  showFlash('skip');
  item.skipped = true;
  advance();
  busy = false;
}

function clearBox() {
  box = null;
  updateBoxStatus();
  redraw();
}

function advance() {
  updateTally();
  const next = items.findIndex((it, i) => i > idx && !it.annotated && !it.skipped && !_claimed.has(it.name));
  if (next >= 0) {
    idx = next;
  } else if (idx < items.length - 1) {
    idx++;
  } else {
    showDone();
    return;
  }
  loadItem();
}

// ── Flash ─────────────────────────────────────────────────────────────────────

function showFlash(type) {
  const el = document.getElementById('flash-' + type);
  if (!el) return;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 700);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateTally() {
  const annotated = items.filter(i => i.annotated).length;
  const skipped   = items.filter(i => i.skipped).length;
  const remaining = items.filter(i => !i.annotated && !i.skipped).length;
  const pct = items.length ? (annotated + skipped) / items.length * 100 : 0;

  document.getElementById('cnt-annotated').textContent = annotated;
  document.getElementById('cnt-skipped').textContent   = skipped;
  document.getElementById('cnt-remaining').textContent = remaining;
  document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';
  document.getElementById('total').textContent = items.length;
}

// ── Done ──────────────────────────────────────────────────────────────────────

function showDone() {
  const a = items.filter(i => i.annotated).length;
  const s = items.filter(i => i.skipped).length;
  document.getElementById('main-view').style.display = 'none';
  document.getElementById('done-view').style.display = 'flex';
  document.getElementById('done-msg').textContent =
    a + ' annotations saved · ' + s + ' skipped';
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (busy) return;
  const k = e.key.toLowerCase();
  if (k in KEYS)               annotate(parseInt(KEYS[k]));
  if (k === 's' || k === '0')  skip();
  if (k === 'x' || k === 'delete') clearBox();
  if (k === 'arrowright') { if (idx < items.length - 1) { idx++; loadItem(); } }
  if (k === 'arrowleft')  { if (idx > 0)                { idx--; loadItem(); } }
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const res = await fetch('/api/items');
  items = await res.json();
  document.getElementById('total').textContent = items.length;
  updateTally();

  if (!items.length) {
    document.getElementById('main-view').style.display = 'none';
    document.getElementById('done-view').style.display = 'flex';
    document.getElementById('done-msg').textContent = 'No crops found. Run prepare_annotation_crops.py first.';
    return;
  }

  // Start at first unannotated
  idx = items.findIndex(i => !i.annotated && !i.skipped);
  if (idx < 0) idx = 0;
  loadItem();
}

init();
</script>
</body>
</html>`;

// ── Live sync ─────────────────────────────────────────────────────────────────

const sseClients = new Set();
const claimed    = new Map();

function broadcast(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (req.url === '/api/items') {
    const items = getItems();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(items));
    return;
  }

  if (req.url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStats()));
    return;
  }

  if (req.url === '/api/annotate' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, class: cls, cx, cy, w, h } = JSON.parse(body);
        if (!name || cls == null) throw new Error('bad params');

        // Write YOLO label file
        const labelName = name.replace(/\.[^.]+$/, '.txt');
        const yoloLine  = `${cls} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
        fs.writeFileSync(path.join(LABELS_DIR, labelName), yoloLine + '\n');

        // Update manifest
        const manifest = loadManifest();
        if (manifest[name]) {
          manifest[name].annotated  = true;
          manifest[name].skipped    = false;
          manifest[name].annotation = { class: cls, cx, cy, w, h };
          saveManifest(manifest);
          broadcast({ type: 'saved', name, annotated: true, skipped: false });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/api/skip' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const manifest = loadManifest();
        if (manifest[name]) {
          manifest[name].skipped    = true;
          manifest[name].annotated  = false;
          saveManifest(manifest);
          broadcast({ type: 'saved', name, annotated: false, skipped: true });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve crop images
  const m = req.url.match(/^\/img\/(.+)$/);
  if (m) {
    const filePath = path.join(CROPS_DIR, decodeURIComponent(m[1]));
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
    const ext  = path.extname(m[1]).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: ' + JSON.stringify({ type: 'users', count: sseClients.size + 1 }) + '\n\n');
    sseClients.add(res);
    broadcast({ type: 'users', count: sseClients.size });
    req.on('close', () => { sseClients.delete(res); broadcast({ type: 'users', count: sseClients.size }); });
    return;
  }

  if (req.url === '/api/claim' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, clientId } = JSON.parse(body);
        for (const [k, v] of claimed) if (v.clientId === clientId) claimed.delete(k);
        if (name) claimed.set(name, { clientId, ts: Date.now() });
        broadcast({ type: 'claimed', name, clientId });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  const os   = require('os');
  const nets = os.networkInterfaces();
  const ips  = [];
  for (const iface of Object.values(nets))
    for (const n of iface) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  const stats = getStats();
  console.log(`\nCert annotation tool`);
  console.log(`  This machine : http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN          : http://${ip}:${PORT}`);
  console.log(`  ${stats.total} crops loaded`);
  console.log(`  ${stats.annotated} annotated · ${stats.skipped} skipped · ${stats.total - stats.annotated - stats.skipped} remaining`);
  if (stats.byGrader) {
    for (const [g, s] of Object.entries(stats.byGrader)) {
      console.log(`    ${g.padEnd(6)} ${s.total} total  (${s.annotated} annotated)`);
    }
  }
  console.log(`\n  Draw box → press class key to save`);
  console.log(`  P=PSA  B=BGS  C=CGC  A=TAG  S=skip  X=clear\n`);
});
