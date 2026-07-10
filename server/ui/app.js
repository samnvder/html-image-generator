// Thin client. Every render goes through POST /api/render, which calls the same
// renderJob() the CLI calls. The UI adds no rendering logic of its own.

const $ = (sel) => document.querySelector(sel);
const form = $('#spec');
const frame = $('#frame');
const renderBtn = $('#render');
const guard = $('#guard');

const PAPER = { letter: [8.5, 11], legal: [8.5, 14] };

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

// ---- template config -----------------------------------------------------
// Templates declare what they were built for. Selecting one applies its
// orientation / margin / outputs, and *recommends* a paper size — it never
// picks the paper size for you. That variable is the user's to confirm.

const TEMPLATES = new Map();
const templateConfig = () => TEMPLATES.get(form.template.value)?.config ?? {};

function applyTemplateConfig() {
  const c = templateConfig();
  $('#template-desc').textContent = TEMPLATES.get(form.template.value)?.description ?? '';
  if (c.orientation) form.orientation.value = c.orientation;
  if (c.margin !== undefined) form.margin.value = c.margin;
  if (Array.isArray(c.outputs)) {
    form.pdf.checked = c.outputs.includes('pdf');
    form.png.checked = c.outputs.includes('png');
  }
  // A flowing multi-page template has no meaningful screenshot.
  form.png.disabled = Boolean(c.pdfOnly);
  if (c.pdfOnly) form.png.checked = false;
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
    const value = label.querySelector('input').value;
    label.classList.toggle('recommended', c.paperSize === value);
  }

  const warn = $('#mismatch');
  const problems = [];
  if (chosen && c.paperSize && chosen !== c.paperSize) problems.push(`${TEMPLATES.get(form.template.value)?.title ?? 'This template'} is designed for ${c.paperSize}, not ${chosen}`);
  if (c.orientation && form.orientation.value !== c.orientation) problems.push(`it expects ${c.orientation} orientation`);
  if (c.margin !== undefined && form.margin.value !== c.margin) problems.push(`its intended margin is ${c.margin === '0' ? 'none' : c.margin}`);

  warn.hidden = problems.length === 0;
  warn.textContent = problems.length ? `Heads up — ${problems.join('; ')}. It will still render, but may not look right.` : '';
}

// ---- validation ----------------------------------------------------------
// Uses POST /api/validate, the same validator renderJob() enforces. The UI has
// no second copy of the rules to drift out of sync.

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

// ---- preview -------------------------------------------------------------

function applyZoom() {
  const spec = readSpec();
  const [wIn, hIn] = PAPER[spec.paperSize] ?? PAPER.letter;
  const [pw, ph] = spec.orientation === 'landscape' ? [hIn, wIn] : [wIn, hIn];
  const z = Number($('#zoom').value) / 100;
  $('#zoom-label').textContent = `${$('#zoom').value}%`;

  // Paged.js lays pages out at 96 CSS px/inch, the same units Chromium prints at.
  const frameW = Math.round(pw * 96) + 80;
  frame.style.width = `${frameW}px`;
  frame.style.transform = `scale(${z})`;
  canvas.style.width = `${frameW * z}px`;
  canvas.style.height = `${parseFloat(frame.style.height || 0) * z}px`;
}

// The polyfill runs once on load, so every refresh is a full iframe reload.
function fitFrameHeight() {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 400);
    frame.style.height = `${h + 40}px`;
    applyZoom();
  } catch { /* not ready */ }
}
frame.addEventListener('load', () => {
  fitFrameHeight();
  // Paged.js renders asynchronously after load; re-measure as pages appear.
  let n = 0;
  const t = setInterval(() => { fitFrameHeight(); if (++n > 12) clearInterval(t); }, 250);
});

// Paged.js chunks pages via requestAnimationFrame, which Chrome throttles to a
// standstill in a background tab. Rendering a preview while hidden leaves the
// iframe blank forever — the polyfill never resumes on its own. So: defer while
// hidden, and re-run on the way back if the last pass never finished.
let previewTimer;
let previewPending = false;

async function refreshPreview() {
  const spec = readSpec();
  if (!spec.paperSize || !spec.template) return;
  if (document.hidden) { previewPending = true; return; }
  previewPending = false;

  const res = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!res.ok) return;
  frame.src = `/preview?t=${Date.now()}`;
}
const schedulePreview = () => { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 220); };

const pagedFinished = () => {
  try { return frame.contentWindow?.__pagedDone === true; } catch { return false; }
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Either a preview was queued while hidden, or one started and stalled mid-chunk.
  if (previewPending || !pagedFinished()) refreshPreview();
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

async function loadContentFields(template, values = {}, slots = {}) {
  const box = $('#content-fields');
  box.innerHTML = '';
  if (!template) return;
  const keys = TEMPLATES.get(template)?.placeholders ?? [];

  for (const key of keys) {
    const isImage = key.startsWith('image:');
    const current = isImage ? (slots[key.slice(6)] ?? '') : (values[key] ?? '');
    const label = document.createElement('label');
    label.textContent = isImage ? `${key.slice(6)} (image slot)` : key;
    const long = !isImage && (LONG.test(key) || current.length > 60);
    const input = document.createElement(long ? 'textarea' : 'input');
    if (long) input.rows = 3;
    input.dataset.field = key;
    input.value = current;
    if (isImage) input.placeholder = '/assets/…';
    label.appendChild(input);
    box.appendChild(label);
  }
}

// ---- render --------------------------------------------------------------

renderBtn.addEventListener('click', async () => {
  if (!updateGuard()) return;
  const result = $('#result');
  renderBtn.disabled = true;
  renderBtn.textContent = 'Rendering…';
  result.hidden = false;
  result.innerHTML = '<span class="hint">Rendering…</span>';

  const res = await fetch('/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec: readSpec(), autoOpen: form.autoOpen.checked }),
  });
  const body = await res.json();

  if (!res.ok) {
    result.innerHTML = `<div class="err">${body.error}</div>`;
  } else {
    result.innerHTML = '';
    for (const r of body) {
      const row = document.createElement('div');
      row.className = 'file';
      row.innerHTML = `<span class="fmt">${r.format.toUpperCase()}</span>
        <a href="/${r.path}" target="_blank">${r.path}</a>`;
      const reveal = document.createElement('button');
      reveal.className = 'ghost';
      reveal.textContent = 'Reveal in Explorer';
      reveal.onclick = () => fetch('/api/reveal', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: r.path }),
      });
      row.appendChild(reveal);
      result.appendChild(row);
    }
    refreshProjects();
  }
  renderBtn.disabled = false;
  renderBtn.textContent = 'Render';
});

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
  form.template.value = spec.template ?? '';
  form.orientation.value = spec.orientation ?? 'portrait';
  form.margin.value = spec.margin ?? '0.5in';
  form.bleed.value = spec.bleed ?? '0';
  form.cropMarks.checked = Boolean(spec.cropMarks);
  form.dpi.value = spec.dpi ?? 300;
  form.pdf.checked = (spec.outputs ?? ['pdf']).includes('pdf');
  form.png.checked = (spec.outputs ?? []).includes('png');
  for (const r of form.querySelectorAll('[name=paperSize]')) r.checked = r.value === spec.paperSize;

  await loadContentFields(spec.template, spec.content ?? {}, spec.imageSlots ?? {});
  onChange();
});

// ---- wiring --------------------------------------------------------------

function onChange() {
  updateRecommendation();
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
    loadContentFields(form.template.value).then(() => { suggestJobName(); onChange(); });
  } else {
    if (e.target.dataset?.field) suggestJobName();
    onChange();
  }
});
$('#zoom').addEventListener('input', applyZoom);

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
  };
}

// ---- boot ----------------------------------------------------------------

const templates = await (await fetch('/api/templates')).json();
for (const t of templates) TEMPLATES.set(t.file, t);
form.template.innerHTML = templates
  .map((t) => `<option value="${t.file}">${t.title} — ${t.config.paperSize ?? '?'} ${t.config.orientation ?? ''}</option>`)
  .join('');
$('#template-desc').textContent = TEMPLATES.get(form.template.value)?.description ?? '';

applyTemplateConfig();
await loadContentFields(form.template.value);
await Promise.all([refreshProjects(), refreshJobs()]);
connect();
onChange();
applyZoom();
