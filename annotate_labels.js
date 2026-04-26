'use strict';

/**
 * annotate_labels.js
 *
 * Draw correct bounding boxes around grading labels (top of slab).
 * The red dashed box shows what the current model wrongly detects.
 * Draw a tight box around the actual label at the top, then press the class key.
 *
 * Keys:
 *   P / 1   PSA label
 *   C / 2   CGC label
 *   B / 3   BGS / Beckett label
 *   A / 4   TAG label
 *   S / 0   Skip (bad image / can't tell)
 *   X / Del Clear drawn box
 *   ← →    Navigate without saving
 *
 * Prerequisite: python prepare_label_images.py
 * Run:          node annotate_labels.js
 * Open:         http://localhost:3005
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = 3005;
const IMAGES_DIR = path.join(__dirname, 'data', 'label_annotation', 'images');
const LABELS_DIR = path.join(__dirname, 'data', 'label_annotation', 'labels');
const MANIFEST_F = path.join(__dirname, 'data', 'label_annotation', 'manifest.json');

if (!fs.existsSync(IMAGES_DIR)) {
  console.error('Run prepare_label_images.py first.');
  process.exit(1);
}
if (!fs.existsSync(LABELS_DIR)) fs.mkdirSync(LABELS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_F, 'utf8')); } catch { return {}; }
}
function saveManifest(m) {
  fs.writeFileSync(MANIFEST_F, JSON.stringify(m, null, 2));
}
function getItems() {
  return Object.entries(loadManifest()).map(([name, meta]) => ({ name, ...meta }));
}
function getStats() {
  const vals = Object.values(loadManifest());
  const byGrader = {};
  for (const v of vals) {
    const g = v.grader || '?';
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
<title>Annotate Labels</title>
<style>
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --bg:#0d1117; --surftag:#161b22; --border:#30363d;
    --text:#e6edf3; --muted:#8b949e;
    --psa:#58a6ff; --cgc:#d29922; --bgs:#bc8cff; --tag:#3fb950;
    --wrong:#f85149;
  }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }

  .topbar { background:var(--surftag); border-bottom:1px solid var(--border); padding:8px 20px; display:flex; align-items:center; gap:14px; flex-shrink:0; }
  .topbar h1 { font-size:14px; font-weight:600; }
  .pos b { color:var(--text); }
  .pos  { color:var(--muted); font-size:13px; }
  .tally { margin-left:auto; display:flex; gap:16px; font-size:12px; color:var(--muted); }
  .tally b { color:var(--text); }
  .review-btn { padding:4px 12px; border-radius:4px; border:1px solid var(--border); background:transparent;
    color:var(--muted); font-size:12px; cursor:pointer; }
  .review-btn.active { border-color:#d29922; background:#1e1600; color:#d29922; font-weight:700; }

  .main { display:flex; flex:1; overflow:hidden; }

  .canvas-panel { flex:1; position:relative; background:#050709; overflow:hidden; cursor:crosshair; }
  #canvas { display:block; width:100%; height:100%; }

  .legend { position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
    display:flex; gap:16px; background:rgba(0,0,0,.75); padding:6px 18px;
    border-radius:4px; font-size:12px; white-sptag:nowrap; pointer-events:none; }
  .legend-item { display:flex; align-items:center; gap:5px; color:var(--muted); }
  .swatch { width:18px; height:3px; border-radius:2px; }
  .swatch-wrong  { background:var(--wrong); opacity:.7; border-top:2px dashed var(--wrong); }
  .swatch-correct { background:var(--psa); }

  .hint-bar { position:absolute; top:10px; left:50%; transform:translateX(-50%);
    background:rgba(0,0,0,.75); padding:4px 16px; border-radius:4px;
    font-size:12px; color:var(--muted); white-sptag:nowrap; pointer-events:none; }
  .hint-bar b { color:var(--text); }

  .flash { position:absolute; top:10px; left:12px; padding:4px 14px; border-radius:4px;
           font-size:14px; font-weight:700; display:none; pointer-events:none; }
  .flash-psa  { background:#0d1e33; border:1px solid var(--psa);  color:var(--psa); }
  .flash-cgc  { background:#1e1600; border:1px solid var(--cgc);  color:var(--cgc); }
  .flash-bgs  { background:#1a0d33; border:1px solid var(--bgs);  color:var(--bgs); }
  .flash-tag  { background:#0d2414; border:1px solid var(--tag);  color:var(--tag); }
  .flash-skip { background:var(--surftag); border:1px solid var(--border); color:var(--muted); }

  .side-panel { width:260px; flex-shrink:0; border-left:1px solid var(--border); display:flex; flex-direction:column; }
  .side-body   { flex:1; padding:16px; overflow-y:auto; }
  .lbl { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-bottom:3px; }
  .val { font-size:14px; font-weight:500; margin-bottom:12px; line-height:1.4; }
  .val.big { font-size:18px; font-weight:700; }
  .psa-color { color:var(--psa); }
  .cgc-color { color:var(--cgc); }
  .bgs-color { color:var(--bgs); }
  .tag-color { color:var(--tag); }
  .wrong-color { color:var(--wrong); }

  .predicted-box { background:#1a0000; border:1px solid #f8514940; border-radius:4px;
    padding:8px 10px; margin-bottom:12px; font-size:12px; color:var(--muted); }
  .predicted-box b { color:var(--wrong); }

  .actions { border-top:1px solid var(--border); padding:12px; background:var(--surftag); }
  .btn-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px; }
  .btn { padding:10px 6px; border-radius:5px; border:1px solid; font-size:12px; font-weight:700;
         cursor:pointer; text-align:center; }
  .btn:hover { opacity:.8; }
  .btn-psa  { border-color:var(--psa);    background:#0d1e33; color:var(--psa); }
  .btn-cgc  { border-color:var(--cgc);    background:#1e1600; color:var(--cgc); }
  .btn-bgs  { border-color:var(--bgs);    background:#1a0d33; color:var(--bgs); }
  .btn-tag  { border-color:var(--tag);    background:#0d2414; color:var(--tag); }
  .btn-skip { border-color:var(--border); background:transparent; color:var(--muted); font-size:11px; }
  .btn-clear{ border-color:var(--border); background:transparent; color:var(--muted); font-size:11px; }
  .btn-row  { display:flex; gap:6px; }
  .key { color:var(--muted); font-size:10px; font-weight:400; }

  .progress-bar  { height:3px; background:var(--border); flex-shrink:0; }
  .progress-fill { height:100%; background:var(--psa); transition:width .3s; }

  .info-box-status { font-size:12px; color:var(--muted); margin-bottom:12px; }

  .done { display:none; flex:1; align-items:center; justify-content:center; flex-direction:column; gap:12px; }
  .done h2 { font-size:22px; }
  .done p  { color:var(--muted); }
</style>
</head>
<body>

<div class="topbar">
  <h1>Annotate Label Regions</h1>
  <div class="pos">Item <b id="pos">—</b> / <b id="total">—</b></div>
  <div class="tally">
    <span>Done: <b id="cnt-annotated">0</b></span>
    <span>Skipped: <b id="cnt-skipped">0</b></span>
    <span>Left: <b id="cnt-remaining">0</b></span>
  </div>
  <button class="review-btn" id="review-btn" onclick="toggleReviewMode()" title="R">Review Annotated [R]</button>
  <span id="user-count" style="font-size:12px;color:#8b949e;white-space:nowrap;">1 user</span>
</div>
<div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>

<div class="main" id="main-view">
  <div class="canvas-panel" id="canvas-panel">
    <canvas id="canvas"></canvas>

    <div class="flash flash-psa"  id="flash-psa">PSA</div>
    <div class="flash flash-cgc"  id="flash-cgc">CGC</div>
    <div class="flash flash-bgs"  id="flash-bgs">BGS</div>
    <div class="flash flash-tag"  id="flash-tag">TAG</div>
    <div class="flash flash-skip" id="flash-skip">Skipped</div>

    <div class="hint-bar">
      <b>Enter</b>=confirm model box &nbsp;·&nbsp; or draw your own, then press class key &nbsp;·&nbsp;
      <b>P</b>=PSA &nbsp;<b>C</b>=CGC &nbsp;<b>B</b>=BGS &nbsp;<b>A</b>=TAG &nbsp;
      <b>S</b>=skip &nbsp;<b>X</b>=clear &nbsp;<b>Ctrl+Z</b>=undo &nbsp;<b>← →</b>=navigate
    </div>

    <div class="legend">
      <div class="legend-item"><div class="swatch" style="border-top:2px dashed #f85149;background:transparent;height:0;margin-top:3px"></div> current model (wrong)</div>
      <div class="legend-item"><div class="swatch" style="background:#58a6ff"></div> your annotation (correct)</div>
    </div>
  </div>

  <div class="side-panel">
    <div class="side-body">
      <div class="lbl">Grader (from meta)</div>
      <div class="val big" id="info-grader">—</div>

      <div class="lbl">Current Model Says</div>
      <div class="predicted-box" id="info-predicted">
        <b id="pred-name">—</b> <span id="pred-conf"></span><br>
        <span id="pred-region" style="font-size:11px"></span>
      </div>

      <div class="lbl">Card</div>
      <div class="val" id="info-card" style="font-size:13px">—</div>

      <div class="lbl">Your Box</div>
      <div class="info-box-status" id="info-box">No box drawn yet</div>
    </div>

    <div class="actions">
      <div class="btn-grid">
        <button class="btn btn-psa" onclick="annotate(0)">PSA <span class="key">[P]</span></button>
        <button class="btn btn-cgc" onclick="annotate(1)">CGC <span class="key">[C]</span></button>
        <button class="btn btn-bgs" onclick="annotate(2)">BGS <span class="key">[B]</span></button>
        <button class="btn btn-tag" onclick="annotate(3)">TAG <span class="key">[A]</span></button>
      </div>
      <div class="btn-row">
        <button class="btn btn-skip"  style="flex:2" onclick="skip()">Skip [S]</button>
        <button class="btn btn-clear" style="flex:1" onclick="clearBox()">Clear [X]</button>
      </div>
    </div>
  </div>
</div>

<div class="done" id="done-view">
  <h2>All done!</h2>
  <p id="done-msg"></p>
  <p style="color:var(--muted);font-size:13px;margin-top:8px">Run prepare_label_images.py again to load more images.</p>
</div>

<script>
const NAMES  = ['PSA', 'CGC', 'BGS', 'TAG'];
const COLORS = ['#58a6ff', '#d29922', '#bc8cff', '#3fb950'];
const KEY_MAP = { p:'0','1':'0', c:'1','2':'1', b:'2','3':'2', a:'3','4':'3' };
const GRADER_CLS = { PSA:0, CGC:1, BGS:2, TAG:3 };

let items = [], idx = 0, item = null;
const _clientId = Math.random().toString(36).slice(2);
const _claimed  = new Set(); // names currently being worked on by OTHER clients
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
    if (item && item.name === ev.name && !reviewMode) advance();
  }
};
let imgEl = new Image(), imgW=0, imgH=0, dispW=0, dispH=0, offX=0, offY=0;
let drawing=false, dragSX=0, dragSY=0, box=null, busy=false;
let confirmedBoxes = [];  // [{class, cx, cy, w, h}] pending save for current image
let undoStack = [];       // [{name, idx, wasAnnotated, wasSkipped, prevAnnotations}]
let reviewMode = false;

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
const panel  = document.getElementById('canvas-panel');

// ── Canvas ────────────────────────────────────────────────────────────────────

function layout() {
  canvas.width  = panel.clientWidth;
  canvas.height = panel.clientHeight;
  if (!imgW) return;
  const scale = Math.min(canvas.width / imgW, canvas.height / imgH) * 0.96;
  dispW = imgW * scale;  dispH = imgH * scale;
  offX  = (canvas.width  - dispW) / 2;
  offY  = (canvas.height - dispH) / 2;
}
window.addEventListener('resize', () => { layout(); redraw(); });

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!imgEl.complete || !imgW) return;
  ctx.drawImage(imgEl, offX, offY, dispW, dispH);

  // Draw current model prediction — dashed red (the wrong box)
  if (item && item.predictedBbox) {
    const pb = item.predictedBbox;
    const sx = offX + pb.x1 * dispW, sy = offY + pb.y1 * dispH;
    const sw = (pb.x2 - pb.x1) * dispW, sh = (pb.y2 - pb.y1) * dispH;
    ctx.save();
    ctx.strokeStyle = '#f85149';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Draw confirmed boxes (solid, each colored by class)
  for (const b of confirmedBoxes) {
    drawSolidBox(b.x1, b.y1, b.x2, b.y2, b.class);
  }

  // Draw current in-progress box (being drawn or drawn but not yet confirmed)
  if (box) drawSolidBox(box.x1, box.y1, box.x2, box.y2, currentClass());
}

function drawSolidBox(x1, y1, x2, y2, classId) {
  const color = COLORS[classId] || '#fff';
  const sx = offX + x1 * dispW, sy = offY + y1 * dispH;
  const sw = (x2 - x1) * dispW,  sh = (y2 - y1) * dispH;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([]);
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.fillStyle = color + '18';
  ctx.fillRect(sx, sy, sw, sh);
  ctx.font = 'bold 13px -apple-system,sans-serif';
  const label = NAMES[classId] || '';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillStyle = color;
  ctx.fillRect(sx, sy - 20, tw, 20);
  ctx.fillStyle = '#0d1117';
  ctx.fillText(label, sx + 5, sy - 5);
  ctx.restore();
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
  dragSX=n.x; dragSY=n.y; drawing=true; box=null;
});
canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  const n = screenToNorm(e.clientX, e.clientY);
  box = { x1:Math.min(dragSX,n.x), y1:Math.min(dragSY,n.y),
          x2:Math.max(dragSX,n.x), y2:Math.max(dragSY,n.y) };
  redraw();
});
canvas.addEventListener('mouseup', () => {
  drawing = false;
  if (box && (box.x2-box.x1 < 0.01 || box.y2-box.y1 < 0.01)) box = null;
  updateBoxStatus();
  redraw();
});

function currentClass() {
  return GRADER_CLS[(item?.grader||'').toUpperCase()] ?? 0;
}

// ── Load item ─────────────────────────────────────────────────────────────────

function loadItem() {
  item           = items[idx];
  fetch('/api/claim', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: item.name, clientId: _clientId }) }).catch(()=>{});
  box            = null;
  confirmedBoxes = item.annotations ? item.annotations.map(a => ({ ...a, x1:a.cx-a.w/2, y1:a.cy-a.h/2, x2:a.cx+a.w/2, y2:a.cy+a.h/2 })) : [];
  imgEl  = new Image();
  imgEl.onload = () => {
    imgW = imgEl.naturalWidth; imgH = imgEl.naturalHeight;
    layout(); redraw();
  };
  imgEl.src = '/img/' + encodeURIComponent(item.name);

  if (reviewMode) {
    const annotatedItems = items.filter(i => i.annotated);
    const reviewPos = annotatedItems.indexOf(item) + 1;
    document.getElementById('pos').textContent = reviewPos + ' of ' + annotatedItems.length + ' annotated';
  } else {
    document.getElementById('pos').textContent = idx + 1;
  }

  const g = (item.grader || '').toUpperCase();
  const graderEl = document.getElementById('info-grader');
  graderEl.textContent = g || '—';
  graderEl.className   = 'val big ' + (g.toLowerCase() + '-color');

  document.getElementById('info-card').textContent = item.cardName || '—';

  // Show what current model predicted
  const predName = item.predictedName;
  const predConf = item.predictedConf;
  const pb       = item.predictedBbox;
  document.getElementById('pred-name').textContent = predName || 'nothing detected';
  document.getElementById('pred-conf').textContent = predConf ? '(' + (predConf*100).toFixed(0) + '%)' : '';
  if (pb) {
    const w = ((pb.x2-pb.x1)*100).toFixed(0), h = ((pb.y2-pb.y1)*100).toFixed(0);
    const yPct = (pb.y1*100).toFixed(0);
    document.getElementById('pred-region').textContent =
      w + '% wide, top at ' + yPct + '% down — ' + (pb.y1 < 0.4 ? 'top area' : pb.y1 > 0.6 ? 'BOTTOM (wrong)' : 'middle (wrong)');
  } else {
    document.getElementById('pred-region').textContent = 'no detection';
  }

  updateBoxStatus();
}

function updateBoxStatus() {
  const el = document.getElementById('info-box');
  if (confirmedBoxes.length > 0) {
    el.textContent = confirmedBoxes.length + ' box' + (confirmedBoxes.length > 1 ? 'es' : '') + ' added — press Enter to save';
    el.style.color = '#3fb950';
  } else if (box) {
    const w = ((box.x2-box.x1)*100).toFixed(1), h = ((box.y2-box.y1)*100).toFixed(1);
    el.textContent = 'Box drawn ' + w + '% × ' + h + '% — press class key to add';
    el.style.color = '#d29922';
  } else {
    el.textContent = 'Draw a box, then press P/C/B/A';
    el.style.color = 'var(--muted)';
  }
}

function annToBox(ann) {
  return { x1:ann.cx-ann.w/2, y1:ann.cy-ann.h/2, x2:ann.cx+ann.w/2, y2:ann.cy+ann.h/2 };
}

// ── Actions ───────────────────────────────────────────────────────────────────

// Add current drawn box to pending list (does NOT save yet)
function annotate(classId) {
  if (busy) return;
  if (!box) {
    canvas.style.outline = '2px solid #ff8c00';
    setTimeout(() => canvas.style.outline = '', 500);
    return;
  }
  const cx=(box.x1+box.x2)/2, cy=(box.y1+box.y2)/2, w=box.x2-box.x1, h=box.y2-box.y1;
  confirmedBoxes.push({ class:classId, cx, cy, w, h, x1:box.x1, y1:box.y1, x2:box.x2, y2:box.y2 });
  box = null;
  showFlash(['psa','cgc','bgs','tag'][classId]);
  updateBoxStatus();
  redraw();
}

// Save all confirmed boxes and advance to next image
async function saveAndAdvance() {
  if (busy) return;
  if (confirmedBoxes.length === 0) { confirmPrediction(); return; }
  busy = true;
  undoStack.push({ name:item.name, idx, wasAnnotated:item.annotated, wasSkipped:item.skipped, prevAnnotations:item.annotations||null });
  const boxes = confirmedBoxes.map(b => ({ class:b.class, cx:b.cx, cy:b.cy, w:b.w, h:b.h }));
  await fetch('/api/annotate', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:item.name, boxes }),
  });
  item.annotated   = true;
  item.annotations = boxes;
  confirmedBoxes   = [];
  advance();
  busy = false;
}

async function skip() {
  if (busy) return;
  busy = true;
  undoStack.push({ name:item.name, idx, wasAnnotated:item.annotated, wasSkipped:item.skipped, prevAnnotations:item.annotations||null });
  await fetch('/api/skip', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:item.name }),
  });
  showFlash('skip');
  item.skipped   = true;
  confirmedBoxes = [];
  advance();
  busy = false;
}

function clearBox() {
  if (box) { box = null; }
  else if (confirmedBoxes.length > 0) { confirmedBoxes.pop(); }  // clear last confirmed if no active box
  updateBoxStatus(); redraw();
}

function advance() {
  updateTally();
  if (reviewMode) {
    const next = items.findIndex((it,i) => i > idx && it.annotated);
    if (next >= 0) { idx = next; loadItem(); }
    else { idx = items.findIndex(i => i.annotated); if (idx < 0) idx = 0; loadItem(); }
    return;
  }
  const next = items.findIndex((it,i) => i > idx && !it.annotated && !it.skipped && !_claimed.has(it.name));
  if (next >= 0)              { idx = next; }
  else if (idx < items.length-1) { idx++; }
  else { showDone(); return; }
  loadItem();
}

function toggleReviewMode() {
  reviewMode = !reviewMode;
  const btn = document.getElementById('review-btn');
  btn.classList.toggle('active', reviewMode);
  const hintBar = document.querySelector('.hint-bar');
  if (reviewMode) {
    hintBar.innerHTML = '<b>REVIEW MODE</b> — ← → to navigate · re-draw box + class key to fix · <b>Enter</b>=save · <b>S</b>=skip · <b>R</b>=exit review';
    // Jump to first annotated item
    const first = items.findIndex(i => i.annotated);
    if (first >= 0) { idx = first; loadItem(); }
  } else {
    hintBar.innerHTML = '<b>Enter</b>=confirm model box &nbsp;·&nbsp; or draw your own, then press class key &nbsp;·&nbsp; <b>P</b>=PSA &nbsp;<b>C</b>=CGC &nbsp;<b>B</b>=BGS &nbsp;<b>A</b>=TAG &nbsp;<b>S</b>=skip &nbsp;<b>X</b>=clear &nbsp;<b>Ctrl+Z</b>=undo &nbsp;<b>← →</b>=navigate';
    // Jump to first unannotated item
    const first = items.findIndex(i => !i.annotated && !i.skipped);
    if (first >= 0) { idx = first; loadItem(); }
  }
}

async function undoLast() {
  if (busy) return;
  // If boxes are pending (not yet saved), just pop the last one locally
  if (confirmedBoxes.length > 0) {
    confirmedBoxes.pop();
    updateBoxStatus();
    redraw();
    return;
  }
  if (!undoStack.length) return;
  busy = true;
  const last = undoStack.pop();

  await fetch('/api/undo', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:last.name }),
  });

  // Restore item state locally
  const target = items.find(i => i.name === last.name);
  if (target) {
    target.annotated   = last.wasAnnotated;
    target.skipped     = last.wasSkipped;
    target.annotations = last.prevAnnotations;
  }

  // Navigate back to it
  const found = items.findIndex(i => i.name === last.name);
  idx = found >= 0 ? found : Math.max(0, last.idx);
  box = null;

  document.getElementById('main-view').style.display = 'flex';
  document.getElementById('done-view').style.display = 'none';
  updateTally();
  loadItem();
  busy = false;
}

function showFlash(type) {
  const el = document.getElementById('flash-' + type);
  if (!el) return;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 700);
}

function updateTally() {
  const a = items.filter(i=>i.annotated).length;
  const s = items.filter(i=>i.skipped).length;
  const r = items.filter(i=>!i.annotated && !i.skipped).length;
  const pct = items.length ? (a+s)/items.length*100 : 0;
  document.getElementById('cnt-annotated').textContent = a;
  document.getElementById('cnt-skipped').textContent   = s;
  document.getElementById('cnt-remaining').textContent = r;
  document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';
  document.getElementById('total').textContent = items.length;
}

function showDone() {
  const a=items.filter(i=>i.annotated).length, s=items.filter(i=>i.skipped).length;
  document.getElementById('main-view').style.display = 'none';
  document.getElementById('done-view').style.display = 'flex';
  document.getElementById('done-msg').textContent = a + ' annotations saved · ' + s + ' skipped';
}

async function confirmPrediction() {
  if (!item.predictedBbox) {
    canvas.style.outline = '2px solid #ff8c00';
    setTimeout(() => canvas.style.outline = '', 500);
    return;
  }
  const pb = item.predictedBbox;
  box = { x1: pb.x1, y1: pb.y1, x2: pb.x2, y2: pb.y2 };
  annotate(currentClass());       // adds to confirmedBoxes
  await saveAndAdvance();         // saves immediately (confirmedBoxes now has 1 entry)
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undoLast(); return; }
  if (busy) return;
  const k = e.key.toLowerCase();
  if (k === 'r')                  { toggleReviewMode(); return; }
  if (e.key === 'Enter')          saveAndAdvance();
  if (k in KEY_MAP)               annotate(parseInt(KEY_MAP[k]));
  if (k==='s'||k==='0')           skip();
  if (k==='x'||k==='delete')      clearBox();
  if (k==='arrowright') {
    if (reviewMode) {
      const next = items.findIndex((it,i) => i > idx && it.annotated);
      if (next >= 0) { idx = next; loadItem(); }
    } else if (idx < items.length-1) { idx++; loadItem(); }
  }
  if (k==='arrowleft') {
    if (reviewMode) {
      let prev = -1;
      for (let i = idx-1; i >= 0; i--) { if (items[i].annotated) { prev=i; break; } }
      if (prev >= 0) { idx = prev; loadItem(); }
    } else if (idx > 0) { idx--; loadItem(); }
  }
});

async function init() {
  const res  = await fetch('/api/items');
  items = await res.json();
  updateTally();
  if (!items.length) {
    document.getElementById('done-msg').textContent = 'No images found. Run prepare_label_images.py first.';
    document.getElementById('main-view').style.display='none';
    document.getElementById('done-view').style.display='flex';
    return;
  }
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
const claimed    = new Map(); // name → { clientId, ts }

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getItems()));
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
        const { name, boxes } = JSON.parse(body);
        if (!name || !Array.isArray(boxes) || boxes.length === 0) throw new Error('bad params');

        const labelName  = name.replace(/\.[^.]+$/, '.txt');
        const yoloLines  = boxes.map(b =>
          b.class + ' ' + b.cx.toFixed(6) + ' ' + b.cy.toFixed(6) + ' ' + b.w.toFixed(6) + ' ' + b.h.toFixed(6)
        );
        fs.writeFileSync(path.join(LABELS_DIR, labelName), yoloLines.join('\n') + '\n');

        const manifest = loadManifest();
        if (manifest[name]) {
          manifest[name].annotated   = true;
          manifest[name].skipped     = false;
          manifest[name].annotations = boxes;
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
        if (manifest[name]) { manifest[name].skipped=true; manifest[name].annotated=false; saveManifest(manifest); broadcast({ type:'saved', name, annotated:false, skipped:true }); }
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
        const { name } = JSON.parse(body);
        const manifest = loadManifest();
        if (manifest[name]) {
          manifest[name].annotated   = false;
          manifest[name].skipped     = false;
          delete manifest[name].annotations;
          saveManifest(manifest);
          broadcast({ type: 'saved', name, annotated: false, skipped: false });
        }
        // Delete label file if it exists
        const labelPath = path.join(LABELS_DIR, name.replace(/\.[^.]+$/, '.txt'));
        if (fs.existsSync(labelPath)) fs.unlinkSync(labelPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const m = req.url.match(/^\/img\/(.+)$/);
  if (m) {
    const filePath = path.join(IMAGES_DIR, decodeURIComponent(m[1]));
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
  console.log('\nLabel annotation tool');
  console.log('  This machine : http://localhost:' + PORT);
  for (const ip of ips) console.log('  LAN          : http://' + ip + ':' + PORT);
  console.log('  ' + stats.total + ' images  |  ' + stats.annotated + ' annotated  |  ' + (stats.total - stats.annotated - stats.skipped) + ' remaining');
  if (stats.byGrader) {
    for (const [g, s] of Object.entries(stats.byGrader)) {
      console.log('    ' + g.padEnd(6) + s.total + ' total  (' + s.annotated + ' annotated)');
    }
  }
  console.log('\n  Red dashed box = what current model detects (wrong)');
  console.log('  Draw the correct box around the label at the TOP of the slab');
  console.log('  P=PSA  C=CGC  B=BGS  A=TAG  S=skip\n');
});
