// Thin client. Every render goes through POST /api/render, which calls the same
// renderJob() the CLI calls. The UI adds no rendering logic of its own, and no
// second copy of the validation rules — it asks POST /api/validate.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const form = $('#spec');
const frame = $('#frame');
const stage = $('#stage');
const renderBtn = $('#render');
const guard = $('#guard');
const select = $('#template-select');

const PAPER = { letter: [8.5, 11], legal: [8.5, 14] };
const PAPER_LABEL = { letter: 'Letter · 8.5 × 11 in', legal: 'Legal · 8.5 × 14 in' };

// Wrap the iframe so the scaled page reserves real scroll space.
const canvas = document.createElement('div');
canvas.className = 'canvas';
frame.replaceWith(canvas);
canvas.appendChild(frame);

// ---- spec assembly -------------------------------------------------------

function readSpec() {
  const f = new FormData(form);
  const outputs = [];
  if (form.pdf.checked) outputs.push('pdf');
  if (form.png.checked) outputs.push('png');

  const content = {};
  const imageSlots = {};
  for (const el of form.querySelectorAll('[data-field]')) {
    const key = el.dataset.field;
    // An empty image slot means "no image", not "an image at the empty path".
    if (key.startsWith('image:')) { if (el.value.trim()) imageSlots[key.slice(6)] = el.value.trim(); }
    else content[key] = el.value;
  }

  const spec = {
    name: f.get('name')?.trim() || 'untitled',
    project: f.get('project')?.trim() || '',
    docType: f.get('docType')?.trim() || '',
    orientation: f.get('orientation'),
    template: f.get('template'),
    margin: f.get('margin'),
    bleed: f.get('bleed') || '0',
    cropMarks: form.cropMarks.checked,
    outputs: outputs.length ? outputs : ['pdf'],
    dpi: Number(f.get('dpi')) || 300,
    content,
    imageSlots,
  };
  // Omit rather than send "" — the validator should say "required", not "invalid".
  const paper = f.get('paperSize');
  if (paper) spec.paperSize = paper;
  return spec;
}

// ---- template gallery ----------------------------------------------------
// The <select> is the form control and the source of truth; the gallery is a
// visual skin over it. Changing either dispatches `input` on the select, so
// there is exactly one code path.

const TEMPLATES = new Map();
const templateConfig = () => TEMPLATES.get(select.value)?.config ?? {};

function buildGallery(templates) {
  const gallery = $('#gallery');
  gallery.innerHTML = '';
  for (const t of templates) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.template = t.file;
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', String(t.file === select.value));
    card.title = t.description;
    card.innerHTML = `
      <img class="shot" alt="" src="/thumbs/${t.file.replace(/\.html$/, '')}.png" loading="lazy">
      <span class="name">${t.title}</span>
      <span class="spec">${t.config.paperSize ?? '?'} · ${t.config.orientation ?? ''}</span>`;
    card.addEventListener('click', () => {
      if (select.value === t.file) return;
      select.value = t.file;
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
    gallery.appendChild(card);
  }
}

function syncGallery() {
  for (const card of $$('.card')) card.setAttribute('aria-checked', String(card.dataset.template === select.value));
}

// Thumbnails regenerate when a template changes; bust the cache.
function refreshThumbs() {
  for (const img of $$('.card .shot')) img.src = `${img.src.split('?')[0]}?t=${Date.now()}`;
}

// ---- template config -----------------------------------------------------
// Templates declare what they were built for. Selecting one applies its
// orientation / margin / outputs, and *recommends* a paper size — it never
// picks the paper size for you. That variable is the user's to confirm.

function applyTemplateConfig() {
  const c = templateConfig();
  $('#template-desc').textContent = TEMPLATES.get(select.value)?.description ?? '';
  if (c.orientation) form.orientation.value = c.orientation;
  if (c.margin !== undefined) form.margin.value = c.margin;
  if (Array.isArray(c.outputs)) {
    form.pdf.checked = c.outputs.includes('pdf');
    form.png.checked = c.outputs.includes('png');
  }
  // A flowing multi-page template has no meaningful screenshot.
  form.png.disabled = Boolean(c.pdfOnly);
  if (c.pdfOnly) form.png.checked = false;
  syncGallery();
}

// Name the job after its own title field instead of shipping "untitled".
function suggestJobName() {
  const c = templateConfig();
  const el = c.titleField && form.querySelector(`[data-field="${c.titleField}"]`);
  const slug = (el?.value ?? '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (slug && (form.name.value === 'untitled' || form.name.value === '')) form.name.value = slug;
}

function updateRecommendation() {
  const c = templateConfig();
  const chosen = new FormData(form).get('paperSize');

  for (const label of form.querySelectorAll('.radio')) {
    label.classList.toggle('recommended', c.paperSize === label.querySelector('input').value);
  }

  const warn = $('#mismatch');
  const problems = [];
  const title = TEMPLATES.get(select.value)?.title ?? 'This template';
  if (chosen && c.paperSize && chosen !== c.paperSize) problems.push(`${title} is designed for ${c.paperSize}, not ${chosen}`);
  if (c.orientation && form.orientation.value !== c.orientation) problems.push(`it expects ${c.orientation} orientation`);
  if (c.margin !== undefined && form.margin.value !== c.margin) problems.push(`its intended margin is ${c.margin === '0' ? 'none' : c.margin}`);

  warn.hidden = problems.length === 0;
  warn.textContent = problems.length ? `Heads up — ${problems.join('; ')}. It will still render, but may not look right.` : '';
}

// ---- validation ----------------------------------------------------------

let currentErrors = [];

function paintErrors(errors) {
  for (const el of form.querySelectorAll('.field-error')) el.remove();
  for (const el of form.querySelectorAll('.invalid')) el.classList.remove('invalid');

  for (const { field, message } of errors) {
    const input = form.querySelector(`[name="${field}"]`) ?? form.querySelector(`[data-field="${field.replace(/^content\./, '')}"]`);
    if (!input) continue;
    input.classList.add('invalid');
    const note = document.createElement('small');
    note.className = 'field-error';
    note.textContent = message;
    (input.closest('label') ?? input).after(note);
  }
}

async function validateNow() {
  const res = await fetch('/api/validate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readSpec()),
  });
  currentErrors = (await res.json()).errors ?? [];
  // "Choose a paper size" is guidance, not an error — the guard panel says it.
  paintErrors(currentErrors.filter((e) => e.field !== 'paperSize'));
  updateGuard();
}

// ---- the guard: paper size is never defaulted ----------------------------

function updateGuard() {
  const chosen = Boolean(new FormData(form).get('paperSize'));
  guard.classList.toggle('satisfied', chosen);

  const blocking = currentErrors.filter((e) => e.field !== 'paperSize');
  renderBtn.disabled = !chosen || blocking.length > 0;

  if (!chosen) renderBtn.textContent = 'Choose a paper size';
  else if (blocking.length) renderBtn.textContent = `Fix ${blocking[0].field || 'the job spec'}`;
  else renderBtn.textContent = 'Render';

  return chosen && blocking.length === 0;
}

// ---- preview & zoom ------------------------------------------------------

let zoomMode = 'fit-page';   // 'fit-page' | 'fit-width' | a number (percent)

function pageInches() {
  const spec = readSpec();
  const [wIn, hIn] = PAPER[spec.paperSize] ?? PAPER.letter;
  return spec.orientation === 'landscape' ? [hIn, wIn] : [wIn, hIn];
}

function applyZoom() {
  const [pw, ph] = pageInches();
  const frameW = Math.round(pw * 96) + 80;
  const frameH = parseFloat(frame.style.height) || 1200;
  // Fit-page fits ONE page, not the whole document — otherwise a ten-page job
  // zooms out to a postage stamp. Extra pages are reached by scrolling.
  const pageH = Math.round(ph * 96) + 40;

  const avail = { w: stage.clientWidth - 48, h: stage.clientHeight - 48 };
  let z;
  if (zoomMode === 'fit-width') z = avail.w / frameW;
  else if (zoomMode === 'fit-page') z = Math.min(avail.w / frameW, avail.h / pageH);
  else z = Number(zoomMode) / 100;
  z = Math.max(0.05, Math.min(z, 4));

  frame.style.width = `${frameW}px`;
  frame.style.transform = `scale(${z})`;
  canvas.style.width = `${frameW * z}px`;
  canvas.style.height = `${frameH * z}px`;

  $('#zoom-label').textContent = `${Math.round(z * 100)}%`;
  for (const chip of $$('.chip')) chip.classList.toggle('active', chip.dataset.zoom === String(zoomMode));
}

function updatePreviewMeta() {
  const spec = readSpec();
  $('#paper-badge').textContent = spec.paperSize
    ? `${PAPER_LABEL[spec.paperSize]}${spec.orientation === 'landscape' ? ' · landscape' : ''}`
    : 'No paper size chosen';
  let pages = 0;
  try { pages = frame.contentDocument?.querySelectorAll('.pagedjs_page').length ?? 0; } catch { /* not ready */ }
  $('#page-count').textContent = pages ? `${pages} page${pages === 1 ? '' : 's'}` : '';
}

// The polyfill runs once on load, so every refresh is a full iframe reload.
function fitFrameHeight() {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 400);
    frame.style.height = `${h + 40}px`;
    if (pagedFinished()) previewStalled = false;
    applyZoom();
    updatePreviewMeta();
  } catch { /* not ready */ }
}
frame.addEventListener('load', () => {
  fitFrameHeight();
  // Paged.js renders asynchronously after load; re-measure as pages appear.
  let n = 0;
  const t = setInterval(() => { fitFrameHeight(); if (++n > 12) clearInterval(t); }, 250);
});
window.addEventListener('resize', applyZoom);

for (const chip of $$('.chip')) {
  chip.addEventListener('click', () => { zoomMode = chip.dataset.zoom; applyZoom(); });
}

// Paged.js chunks pages via requestAnimationFrame, which Chrome throttles to a
// standstill in a background tab: the polyfill stalls with an empty page container
// and never resumes on its own.
//
// We do NOT gate on document.hidden — some environments report a visible tab as
// hidden, and gating there means the preview never renders at all. Instead we
// always start the render and watch for a stall; a stalled preview is re-run the
// moment the tab is visible again.
let previewTimer;
let watchdog;
let previewStalled = false;

const pagedFinished = () => {
  try { return frame.contentWindow?.__pagedDone === true; } catch { return false; }
};

function armStallWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { previewStalled = !pagedFinished(); }, 4000);
}

async function refreshPreview() {
  const spec = readSpec();
  if (!spec.paperSize || !spec.template) return;

  const res = await fetch('/api/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  });
  if (!res.ok) return;
  previewStalled = false;
  stage.classList.add('has-preview');
  frame.src = `/preview?t=${Date.now()}`;
  armStallWatchdog();
}
const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 220); };

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // The polyfill stalled (throttled rAF) or never finished. Run it again now that
  // the tab can paint.
  if (previewStalled || !pagedFinished()) refreshPreview();
});

async function refreshDest() {
  const spec = readSpec();
  const dest = $('#dest');
  if (!spec.project || !spec.docType) { dest.textContent = '→ outputs/…'; dest.classList.remove('bad'); return; }
  const res = await fetch('/api/resolve-path', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  });
  const body = await res.json();
  if (res.ok) { dest.textContent = `→ ${body.dir}`; dest.classList.remove('bad'); }
  else { dest.textContent = `✕ ${body.error}`; dest.classList.add('bad'); }
}

// ---- content fields, discovered from the template ------------------------

const LONG = /citation|subhead|recital|clause|notice|governing|entire|attest|parties|footer|body|paragraph/i;

const humanize = (key) => key
  .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
  .replace(/[-_]/g, ' ')
  .replace(/^./, (c) => c.toUpperCase());

// Every image file under assets/, offered to the image-slot inputs.
let ASSETS = [];

// A slot input gets a <datalist> of real assets and a preview of whatever it points
// at. The preview hides itself when the path doesn't load, so a typo is visible.
function attachSlotPreview(label, input) {
  const img = document.createElement('img');
  img.className = 'slot-preview';
  img.alt = '';
  img.hidden = true;
  const sync = () => {
    const src = input.value.trim();
    if (!src) { img.hidden = true; return; }
    img.src = src;
  };
  img.onload = () => { img.hidden = false; };
  img.onerror = () => { img.hidden = true; };
  input.addEventListener('input', sync);
  label.appendChild(img);
  sync();
}

async function loadContentFields(template, values = {}, slots = {}) {
  const box = $('#content-fields');
  box.innerHTML = '';
  if (!template) return;
  const keys = TEMPLATES.get(template)?.placeholders ?? [];

  for (const key of keys) {
    const isImage = key.startsWith('image:');
    const current = isImage ? (slots[key.slice(6)] ?? '') : (values[key] ?? '');
    const label = document.createElement('label');
    label.textContent = isImage ? `${humanize(key.slice(6))} — image slot` : humanize(key);

    const long = !isImage && (LONG.test(key) || current.length > 60);
    const input = document.createElement(long ? 'textarea' : 'input');
    if (long) input.rows = 3;
    input.dataset.field = key;
    input.value = current;
    if (isImage) {
      input.placeholder = '/assets/…';
      input.setAttribute('list', 'assets');
    }
    label.appendChild(input);
    if (isImage) attachSlotPreview(label, input);
    box.appendChild(label);
  }
  if (!keys.length) box.innerHTML = '<p class="hint">This template has no content fields.</p>';
}

async function refreshAssets() {
  ASSETS = await (await fetch('/api/assets')).json();
  $('#assets').innerHTML = ASSETS.map((a) => `<option value="${a}">`).join('');
}

// ---- render --------------------------------------------------------------

const revealButton = (p) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ghost';
  b.textContent = 'Reveal';
  b.onclick = () => fetch('/api/reveal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }),
  });
  return b;
};

function fileRow(r, when) {
  const row = document.createElement('div');
  row.className = 'file';
  row.innerHTML = `<span class="fmt">${r.format.toUpperCase()}</span>
    <a href="/${r.path}" target="_blank" rel="noopener">${r.path.split('/').pop()}</a>`;
  if (when) {
    const t = document.createElement('span');
    t.className = 'when';
    t.textContent = when;
    row.appendChild(t);
  }
  row.appendChild(revealButton(r.path));
  return row;
}

renderBtn.addEventListener('click', async () => {
  if (!updateGuard()) return;
  const result = $('#result');
  showTab('result');
  renderBtn.disabled = true;
  renderBtn.textContent = 'Rendering…';
  result.innerHTML = '<p class="hint">Rendering…</p>';

  const res = await fetch('/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec: readSpec(), autoOpen: form.autoOpen.checked }),
  });
  const body = await res.json();

  if (!res.ok) {
    paintErrors(body.errors ?? []);
    result.innerHTML = `<div class="err">${body.error}</div>`;
  } else {
    result.innerHTML = '';
    // A document shipped with holes in it used to say so only in the server's console.
    for (const w of body.warnings ?? []) {
      const note = document.createElement('div');
      note.className = 'warn';
      note.textContent = w;
      result.appendChild(note);
    }
    for (const r of body.outputs) result.appendChild(fileRow(r));
    if (body.savedSpec) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = `Spec saved to ${body.savedSpec} — this render is reproducible.`;
      result.appendChild(note);
    }
    refreshProjects();
    refreshJobs();
    refreshOutputs();
  }
  renderBtn.disabled = false;
  updateGuard();
});

// ---- outputs panel -------------------------------------------------------

const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

async function refreshOutputs() {
  const rows = await (await fetch('/api/outputs')).json();
  const box = $('#outputs');
  box.innerHTML = '';
  if (!rows.length) { box.innerHTML = '<p class="hint">No renders yet.</p>'; return; }
  for (const r of rows.slice(0, 25)) {
    box.appendChild(fileRow({ format: r.path.endsWith('.pdf') ? 'pdf' : 'png', path: r.path }, ago(r.mtime)));
  }
}

function showTab(name) {
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of $$('.panel')) p.classList.toggle('active', p.id === name);
}
for (const t of $$('.tab')) t.addEventListener('click', () => { showTab(t.dataset.tab); if (t.dataset.tab === 'outputs') refreshOutputs(); });

// ---- saved jobs ----------------------------------------------------------

$('#save-job').addEventListener('click', async () => {
  const res = await fetch('/api/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(readSpec()),
  });
  const body = await res.json();
  const dest = $('#dest');
  if (res.ok) dest.textContent = `✓ saved ${body.saved}`;
  else {
    paintErrors(body.errors ?? []);
    const first = body.errors?.[0];
    dest.textContent = first ? `✕ ${first.field}: ${first.message}` : `✕ ${body.error}`;
  }
  dest.classList.toggle('bad', !res.ok);
  setTimeout(refreshDest, 2500);
  if (res.ok) refreshJobs();
});

$('#load-job').addEventListener('click', async () => {
  const file = $('#job-picker').value;
  if (!file) return;
  const spec = await (await fetch(`/api/jobs/${file}`)).json();

  form.name.value = spec.name ?? '';
  form.project.value = spec.project ?? '';
  form.docType.value = spec.docType ?? '';
  select.value = spec.template ?? '';
  form.orientation.value = spec.orientation ?? 'portrait';
  form.margin.value = spec.margin ?? '0.5in';
  form.bleed.value = spec.bleed ?? '0';
  form.cropMarks.checked = Boolean(spec.cropMarks);
  form.dpi.value = spec.dpi ?? 300;
  form.png.disabled = Boolean(TEMPLATES.get(spec.template)?.config?.pdfOnly);
  form.pdf.checked = (spec.outputs ?? ['pdf']).includes('pdf');
  form.png.checked = (spec.outputs ?? []).includes('png');
  for (const r of form.querySelectorAll('[name=paperSize]')) r.checked = r.value === spec.paperSize;

  syncGallery();
  $('#template-desc').textContent = TEMPLATES.get(spec.template)?.description ?? '';
  await loadContentFields(spec.template, spec.content ?? {}, spec.imageSlots ?? {});
  onChange();
});

// ---- wiring --------------------------------------------------------------

function onChange() {
  updateRecommendation();
  updatePreviewMeta();
  validateNow();
  refreshDest();
  schedulePreview();
  $('#paged-note').hidden = !(form.cropMarks.checked || (form.bleed.value && form.bleed.value !== '0'));
}

form.addEventListener('input', (e) => {
  // The job picker sits inside the form but isn't part of the spec. Without this,
  // choosing a job kicks off a preview of the spec you're about to replace.
  if (e.target.id === 'job-picker') return;
  if (e.target.name === 'template') {
    applyTemplateConfig();
    loadContentFields(select.value).then(() => { suggestJobName(); onChange(); });
  } else {
    if (e.target.dataset?.field) suggestJobName();
    onChange();
  }
});

async function refreshProjects() {
  const projects = await (await fetch('/api/projects')).json();
  $('#projects').innerHTML = Object.keys(projects).map((p) => `<option value="${p}">`).join('');
  $('#doctypes').innerHTML = [...new Set(Object.values(projects).flat())].map((d) => `<option value="${d}">`).join('');
}

async function refreshJobs() {
  const jobs = await (await fetch('/api/jobs')).json();
  $('#job-picker').innerHTML = '<option value="">—</option>' + jobs.map((j) => `<option value="${j}">${j}</option>`).join('');
}

// ---- hot reload ----------------------------------------------------------

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  const dot = $('#ws-dot');
  const label = $('#ws-label');
  ws.onopen = () => { dot.className = 'dot live'; label.textContent = 'watching templates/ jobs/'; };
  ws.onclose = () => { dot.className = 'dot dead'; label.textContent = 'disconnected'; setTimeout(connect, 1500); };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // Full iframe reload — the Paged.js polyfill only runs on load.
    if (msg.type === 'reload') { label.textContent = `reloaded · ${msg.file}`; refreshPreview(); }
    if (msg.type === 'thumbs') refreshThumbs();
  };
}

// ---- boot ----------------------------------------------------------------

const templates = await (await fetch('/api/templates')).json();
for (const t of templates) TEMPLATES.set(t.file, t);
select.innerHTML = templates.map((t) => `<option value="${t.file}">${t.title}</option>`).join('');
buildGallery(templates);

await refreshAssets();
applyTemplateConfig();
await loadContentFields(select.value);
await Promise.all([refreshProjects(), refreshJobs(), refreshOutputs()]);
connect();
onChange();
applyZoom();
