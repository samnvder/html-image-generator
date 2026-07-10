// Phase 3 exit tests: the app boots on one command, opens on a dimensionally
// accurate preview, hot-reloads on a template edit, and its UI render is
// byte-identical to a CLI render of the same spec.
//
//   node scripts/apptest.js
//
// Spawns the real server as a child process and drives the real UI with a real
// browser. Nothing is stubbed.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { PROJECT_ROOT, isInside, fromOutputsUrlPath } from './paths.js';
import { pdfInfo, inspectFonts } from './pdfinfo.js';
import { renderJob } from './render.js';
import { validateSpec } from './validate.js';
import { useTempOutputs } from './testenv.js';

// Set before the server is spawned, so the child inherits it and parent and child
// render into the same temp root — never the user's outputs/.
const OUTPUTS_ROOT = await useTempOutputs('apptest');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---- boot the real server ------------------------------------------------
const t0 = Date.now();
const server = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'index.js'), '--no-open'], {
  cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  // HIG_TEST=1 exposes POST /api/_test/crash-browser, which exists only so this suite
  // can prove the server survives a dead Chromium.
  env: { ...process.env, HIG_OUTPUTS_ROOT: OUTPUTS_ROOT, HIG_TEST: '1' },
});

const base = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not report a URL within 30s')), 30_000);
  server.stdout.on('data', (d) => {
    const m = String(d).match(/(http:\/\/127\.0\.0\.1:\d+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});
const bootMs = Date.now() - t0;

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

// Waiting on a *fresh* preview is subtle. `iframe.src` flips the moment it's
// assigned, while the old document stays loaded (and still has __pagedDone === true)
// until the new one commits. So clear the flag on the current document first, then
// wait for it to come back true — that can only happen after the new document runs.
const clearPagedFlag = () => page.evaluate(() => {
  try { document.getElementById('frame').contentWindow.__pagedDone = false; } catch { /* about:blank */ }
});
const waitPaged = () => page.waitForFunction(
  () => document.getElementById('frame')?.contentWindow?.__pagedDone === true,
  { timeout: 30_000 },
);

async function previewState() {
  await waitPaged();
  return page.evaluate(() => {
    const d = document.getElementById('frame').contentDocument;
    const w = d.defaultView;
    const pages = d.querySelectorAll('.pagedjs_page');
    // Paged.js puts margin-box text in a ::after `content` property, not in the DOM,
    // so textContent/innerText see nothing. Counters stay unresolved in computed style.
    const marginBox = (corner) => [...d.querySelectorAll(`.pagedjs_margin-${corner} .pagedjs_margin-content`)]
      .map((e) => w.getComputedStyle(e, '::after').content)
      .filter((c) => c && c !== 'none');
    return {
      count: pages.length,
      box: [pages[0].offsetWidth, pages[0].offsetHeight],
      headers: marginBox('top-left'),
      footers: marginBox('bottom-center'),
      text: d.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
    };
  });
}

const loadJob = async (file) => {
  await clearPagedFlag();
  await page.select('#job-picker', file);
  await page.click('#load-job');
  await waitPaged();
};

const legalTemplate = path.join(PROJECT_ROOT, 'templates', 'legal-form.html');
const originalLegal = await fs.readFile(legalTemplate, 'utf8');

// Every UI render now persists its spec (B1), so this suite scatters job files. Snapshot
// jobs/ up front and delete whatever is new in the finally block — a test must not leave
// the user's picker holding its scratch work.
const JOBS_DIR = path.join(PROJECT_ROOT, 'jobs');
const HIDDEN_JOB = path.join(JOBS_DIR, '_apptest-hidden.json');
const jobsBefore = new Set(await fs.readdir(JOBS_DIR));

try {
  console.log('— Cold start —');
  await page.goto(base, { waitUntil: 'networkidle0' });
  const bootTotal = Date.now() - t0;
  check(`server reports URL and UI loads (${bootTotal} ms, budget 10000)`, bootTotal < 10_000, `${bootTotal} ms`);
  check('websocket connected (watching templates/ jobs/)',
    (await page.$eval('#ws-label', (e) => e.textContent)).includes('watching'));

  console.log('— The Question Guard —');
  check('render disabled until a paper size is chosen', await page.$eval('#render', (b) => b.disabled));
  check('button says so', (await page.$eval('#render', (b) => b.textContent)).includes('Choose a paper size'));

  console.log('— Preview: Letter poster (native path) —');
  await loadJob('poster-example.json');
  const poster = await previewState();
  check('render enabled once paper size is set', !(await page.$eval('#render', (b) => b.disabled)));
  check('preview page box is 816x1056 CSS px (8.5x11in)', poster.box[0] === 816 && poster.box[1] === 1056, poster.box.join('x'));
  check('single page', poster.count === 1, `${poster.count}`);
  check('content rendered', poster.text.includes('Spring Menu Launch'));

  console.log('— Preview: Legal form (flows, running header) —');
  await loadJob('legal-form-example.json');
  const legal = await previewState();
  check('preview page box is 816x1344 CSS px (8.5x14in)', legal.box[0] === 816 && legal.box[1] === 1344, legal.box.join('x'));
  check('content flows to 2+ pages', legal.count >= 2, `${legal.count}`);
  check('running header on every page',
    legal.headers.length === legal.count && legal.count > 0 && legal.headers.every((h) => h.includes('FORM SE-114')),
    JSON.stringify(legal.headers));
  // The resolved text ("Page 1 of 2") is asserted against the real PDF in templatetest.js;
  // computed style never resolves counters, so here we assert the counter is wired up.
  check('page-counter footer on every page',
    legal.footers.length === legal.count && legal.footers.every((f) => f.includes('counter(page)')),
    JSON.stringify(legal.footers));

  console.log('— Hot reload on template edit —');
  await page.evaluate(() => { window.__reloads = 0; document.getElementById('frame').addEventListener('load', () => { window.__reloads++; }); });
  await clearPagedFlag();
  // Edit the template on disk, exactly as an editor would. Nobody touches the browser.
  await fs.writeFile(legalTemplate, originalLegal.replace('Section 5 — Entire Agreement', 'Section 5 — HOTRELOAD MARKER'));
  await waitPaged();
  const reloaded = await previewState();
  check('editing a template reloads the preview', (await page.evaluate(() => window.__reloads)) > 0);
  check('edited text appears without touching the browser',
    (await page.evaluate(() => document.getElementById('frame').contentDocument.body.innerText)).includes('HOTRELOAD MARKER'));
  check('ws status names the changed file', (await page.$eval('#ws-label', (e) => e.textContent)).includes('legal-form.html'));
  check('reloaded preview still measures Legal', reloaded.box[0] === 816 && reloaded.box[1] === 1344, reloaded.box.join('x'));

  console.log('— Stalled-preview recovery (Paged.js needs rAF) —');
  // Chrome throttles requestAnimationFrame in a background tab, so Paged.js stalls
  // with an empty page container and no error. The UI must re-run it on return.
  // Note we do NOT gate on document.hidden: some environments report a visible tab
  // as hidden, and gating there means the preview never renders at all.
  const stalled = await page.evaluate(async () => {
    const f = document.getElementById('frame');
    f.src = 'about:blank';                       // simulate a preview that never finished
    await new Promise((r) => setTimeout(r, 500));
    return { blank: f.src.endsWith('about:blank'), done: f.contentWindow?.__pagedDone === true };
  });
  check('a stalled preview is detectable (polyfill never signalled done)', stalled.blank && !stalled.done);

  const recovered = await page.evaluate(async () => {
    document.dispatchEvent(new Event('visibilitychange'));   // tab comes back to the front
    await new Promise((r) => setTimeout(r, 1500));
    return !document.getElementById('frame').src.endsWith('about:blank');
  });
  check('returning to the tab re-runs the stalled preview', recovered);
  await waitPaged();
  const restored = await previewState();
  check('the recovered preview is complete and correct', restored.count >= 2 && restored.box[1] === 1344, JSON.stringify(restored.box));

  console.log('— Template gallery —');
  // Start from the poster, so clicking the legal-form card is a real change.
  // (A card click on the already-selected template is deliberately a no-op.)
  await loadJob('poster-example.json');
  // Thumbnails render in the background after the server starts listening.
  // Wait for them on the wire, then force the <img>s to re-fetch.
  await page.waitForFunction(
    async () => (await Promise.all(['poster-letter', 'certificate-letter', 'legal-form']
      .map((n) => fetch(`/thumbs/${n}.png`).then((r) => r.ok, () => false)))).every(Boolean),
    { timeout: 90_000, polling: 1000 },
  );
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.card img.shot')];
    await Promise.all(imgs.map((img) => new Promise((r) => {
      img.onload = r; img.onerror = r;
      img.src = `${img.src.split('?')[0]}?t=${Date.now()}`;
    })));
  });

  const gallery = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll('.card')];
    return {
      count: cards.length,
      names: cards.map((c) => c.querySelector('.name').textContent),
      thumbsLoaded: cards.filter((c) => c.querySelector('img.shot').naturalWidth > 0).length,
      // The certificate thumbnail must be landscape — it is the real renderer's output.
      certLandscape: (() => {
        const img = cards.find((c) => c.dataset.template === 'certificate-letter.html')?.querySelector('img.shot');
        return img ? img.naturalWidth > img.naturalHeight : false;
      })(),
      checkedCount: cards.filter((c) => c.getAttribute('aria-checked') === 'true').length,
    };
  });
  check('gallery shows one card per template', gallery.count === 3, `${gallery.count}`);
  check('cards are named from template config', gallery.names.includes('Certificate') && gallery.names.includes('Legal Form'), gallery.names.join(', '));
  check('every thumbnail loaded', gallery.thumbsLoaded === 3, `${gallery.thumbsLoaded}/3`);
  check('certificate thumbnail is landscape (real render, not a mock)', gallery.certLandscape);
  check('exactly one card is selected', gallery.checkedCount === 1, `${gallery.checkedCount}`);

  await clearPagedFlag();
  const clicked = await page.evaluate(async () => {
    document.querySelector('.card[data-template="legal-form.html"]').click();
    await new Promise((r) => setTimeout(r, 600));
    const f = document.forms.spec;
    return {
      selectValue: f.template.value,
      orientation: f.orientation.value,
      pngDisabled: f.png.disabled,
      checked: document.querySelector('.card[data-template="legal-form.html"]').getAttribute('aria-checked'),
    };
  });
  check('clicking a card selects that template', clicked.selectValue === 'legal-form.html', clicked.selectValue);
  check('clicking a card applies its config', clicked.orientation === 'portrait' && clicked.pngDisabled === true);
  check('clicked card is marked selected', clicked.checked === 'true');

  console.log('— Preview toolbar —');
  await waitPaged();            // page count is only meaningful once Paged.js finishes
  await new Promise((r) => setTimeout(r, 600));
  const toolbar = await page.evaluate(async () => {
    const zoomBefore = document.getElementById('zoom-label').textContent;
    document.querySelector('.chip[data-zoom="100"]').click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      badge: document.getElementById('paper-badge').textContent,
      pages: document.getElementById('page-count').textContent,
      zoomBefore,
      zoomAfter: document.getElementById('zoom-label').textContent,
      activeChip: document.querySelector('.chip.active')?.dataset.zoom,
    };
  });
  // The legal-form card was just selected, but paper size is still the user's Letter:
  // a template may not change it. The badge must report the truth, not the template's wish.
  check('paper badge reports the CHOSEN paper, not the template default',
    /Letter · 8\.5 × 11 in/.test(toolbar.badge), toolbar.badge);
  check('page count is shown', /^\d+ pages?$/.test(toolbar.pages), toolbar.pages);
  check('100% zoom preset sets 100%', toolbar.zoomAfter === '100%', `${toolbar.zoomBefore} -> ${toolbar.zoomAfter}`);
  check('active zoom chip is marked', toolbar.activeChip === '100', String(toolbar.activeChip));

  const badgeAfterLegal = await page.evaluate(async () => {
    const legal = document.forms.spec.querySelector('[name=paperSize][value=legal]');
    legal.checked = true;
    legal.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    return document.getElementById('paper-badge').textContent;
  });
  check('badge follows the user choosing Legal', /Legal · 8\.5 × 14 in/.test(badgeAfterLegal), badgeAfterLegal);

  console.log('— Recent outputs panel —');
  // The temp outputs root starts empty. Give the panel a real render to list, through
  // the server's warm Chromium rather than a second browser launch.
  const posterSpec = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', 'poster-example.json'), 'utf8'));
  await page.evaluate(async (s) => {
    const r = await fetch('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: s, autoOpen: false }),
    });
    if (!r.ok) throw new Error(`seed render failed: ${r.status}`);
  }, { ...posterSpec, name: 'apptest-seed' });

  const outputs = await page.evaluate(async () => {
    document.querySelector('.tab[data-tab="outputs"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('#outputs .file')];
    return {
      visible: document.getElementById('outputs').classList.contains('active'),
      rows: rows.length,
      hasFormat: rows[0]?.querySelector('.fmt')?.textContent ?? '',
      hasReveal: Boolean(rows[0]?.querySelector('button')),
      hasWhen: Boolean(rows[0]?.querySelector('.when')),
    };
  });
  check('outputs tab shows the panel', outputs.visible);
  check('recent renders are listed', outputs.rows > 0, `${outputs.rows} rows`);
  check('each row has a format badge', ['PDF', 'PNG'].includes(outputs.hasFormat), outputs.hasFormat);
  check('each row has a reveal button and a timestamp', outputs.hasReveal && outputs.hasWhen);

  console.log('— Dark mode ---');
  const dark = await page.evaluate(async () => {
    const light = getComputedStyle(document.body).backgroundColor;
    return { light };
  });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark mode changes the theme', darkBg !== dark.light, `${dark.light} -> ${darkBg}`);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);

  // Back to a known state for the tests that follow.
  await loadJob('poster-example.json');

  console.log('— A3: a job name is slugified before it becomes a filename —');
  // "menu: spring" validates fine (it slugifies), but a colon is illegal on NTFS —
  // the save handler used to write it raw and 500.
  const savedDest = await page.evaluate(async () => {
    const f = document.forms.spec;
    f.name.value = 'menu: spring';
    f.name.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    document.getElementById('save-job').click();
    await new Promise((r) => setTimeout(r, 900));
    return document.getElementById('dest').textContent;
  });
  check('saving a name with a colon succeeds', savedDest.startsWith('✓'), savedDest);
  check('it lands at jobs/menu-spring.json', savedDest.includes('jobs/menu-spring.json'), savedDest);
  check('the slugified job file exists on disk',
    await fs.stat(path.join(JOBS_DIR, 'menu-spring.json')).then(() => true, () => false));

  console.log('— A5: the picker only offers jobs it can actually load —');
  // A job pointing at a `_`-prefixed fixture template isn't in the gallery, so loading
  // it left select.value = '' and the form in a state the guard never anticipated.
  await fs.writeFile(HIDDEN_JOB, `${JSON.stringify({
    name: 'apptest-hidden', project: 'Demo', docType: 'probe', paperSize: 'letter',
    template: '_selftest.html', content: { title: 'hidden', note: 'fixture' },
  }, null, 2)}\n`);
  await new Promise((r) => setTimeout(r, 800));

  const jobList = await page.evaluate(() => fetch('/api/jobs').then((r) => r.json()));
  check('a job on a hidden fixture template is not offered', !jobList.includes('_apptest-hidden.json'), jobList.join(', '));
  check('the real example jobs are still offered',
    ['poster-example.json', 'certificate-example.json', 'legal-form-example.json'].every((f) => jobList.includes(f)),
    jobList.join(', '));
  check('the just-saved job is offered', jobList.includes('menu-spring.json'), jobList.join(', '));

  const pickerFiles = await page.$$eval('#job-picker option', (opts) => opts.map((o) => o.value).filter(Boolean));
  check('every offered job appears in the picker', pickerFiles.length === jobList.length, `${pickerFiles.length} vs ${jobList.length}`);
  for (const file of pickerFiles) {
    await loadJob(file);
    const state = await page.evaluate(() => ({
      template: document.forms.spec.template.value,
      disabled: document.getElementById('render').disabled,
      errors: document.querySelectorAll('.field-error').length,
    }));
    check(`loading ${file} leaves a valid form state`,
      state.template !== '' && !state.disabled && state.errors === 0,
      JSON.stringify(state));
  }

  // Back to a known state for the tests that follow.
  await loadJob('poster-example.json');

  console.log('— Routing regression: the posterses bug —');
  const routed = await page.evaluate(async () => {
    const r = await fetch('/api/resolve-path', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'South End', docType: 'posters' }),
    });
    return (await r.json()).dir;
  });
  check('docType "posters" routes to outputs/south-end/posters/', routed === 'outputs/south-end/posters/', routed);
  check('never posterses', !routed.includes('posterses'), routed);

  console.log('— API rejects invalid specs with field-level errors —');
  const rejected = await page.evaluate(async () => {
    const bad = {
      name: 'x', project: 'Demo', docType: 'probe', paperSize: 'letter',
      template: 'poster-letter.html', margin: 'abc', dpi: 99999, orientation: 'sideways',
    };
    const r = await fetch('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: bad, autoOpen: false }),
    });
    return { status: r.status, body: await r.json() };
  });
  check('POST /api/render rejects a bad spec with 400', rejected.status === 400, `${rejected.status}`);
  const badFields = (rejected.body.errors ?? []).map((e) => e.field);
  check('error names the offending fields', ['margin', 'dpi', 'orientation'].every((f) => badFields.includes(f)), badFields.join(', '));

  console.log('— Template config drives the form —');
  await loadJob('poster-example.json');
  const cfg = await page.evaluate(async () => {
    const f = document.forms.spec;
    f.template.value = 'certificate-letter.html';
    // Dispatch on the select, as a real change does — the handler keys off e.target.
    f.template.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    return {
      orientation: f.orientation.value,
      margin: f.margin.value,
      png: f.png.checked,
      recommendedIsLetter: document.querySelector('.radio.recommended input')?.value,
      desc: document.getElementById('template-desc').textContent,
      // The guard must survive: selecting a template must not choose paper size.
      paperStillChosenByUser: new FormData(f).get('paperSize'),
    };
  });
  check('certificate template applies landscape', cfg.orientation === 'landscape', cfg.orientation);
  check('certificate template applies margin 0', cfg.margin === '0', cfg.margin);
  check('certificate template turns PNG off', cfg.png === false);
  check('template recommends a paper size', cfg.recommendedIsLetter === 'letter', String(cfg.recommendedIsLetter));
  check('template description is shown', cfg.desc.length > 10, cfg.desc);
  check('template never picks paper size for you (the Guard holds)', cfg.paperStillChosenByUser === 'letter', String(cfg.paperStillChosenByUser));

  console.log('— Mismatch warning —');
  const mismatch = await page.evaluate(async () => {
    const f = document.forms.spec;
    const legal = f.querySelector('[name=paperSize][value=legal]');
    legal.checked = true;
    legal.dispatchEvent(new Event('input', { bubbles: true }));
    f.orientation.value = 'portrait';
    f.orientation.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    const w = document.getElementById('mismatch');
    return { hidden: w.hidden, text: w.textContent };
  });
  check('forcing certificate onto Legal portrait warns', !mismatch.hidden, 'warning stayed hidden');
  check('warning explains the mismatch', /designed for letter/i.test(mismatch.text) && /landscape/i.test(mismatch.text), mismatch.text);

  console.log('— Inline field validation blocks Render —');
  const invalid = await page.evaluate(async () => {
    const f = document.forms.spec;
    f.margin.value = 'abc';
    f.margin.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    const btn = document.getElementById('render');
    return {
      disabled: btn.disabled,
      label: btn.textContent,
      marked: f.margin.classList.contains('invalid'),
      message: f.querySelector('.field-error')?.textContent ?? '',
    };
  });
  check('Render disabled while a field is invalid', invalid.disabled);
  check('button names the blocking field', invalid.label === 'Fix margin', invalid.label);
  check('the offending input is marked invalid', invalid.marked);
  check('an inline message explains why', /CSS length/i.test(invalid.message), invalid.message);

  const recovered2 = await page.evaluate(async () => {
    const f = document.forms.spec;
    f.margin.value = '0.5in';
    f.margin.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    return { disabled: document.getElementById('render').disabled, errors: document.querySelectorAll('.field-error').length };
  });
  check('fixing the field re-enables Render', !recovered2.disabled);
  check('inline errors clear', recovered2.errors === 0, `${recovered2.errors} left`);

  console.log('— UI render == CLI render —');
  const spec = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', 'poster-example.json'), 'utf8'));
  const uiSpec = { ...spec, name: 'apptest-ui' };
  const uiRes = await page.evaluate(async (s) => {
    const r = await fetch('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: s, autoOpen: false }),
    });
    return r.json();
  }, uiSpec);
  const { outputs: cliRes } = await renderJob({ ...spec, name: 'apptest-cli' }, { autoOpen: false });

  // The API speaks `outputs/…` URL paths; they resolve against the outputs root,
  // which under test is a temp dir outside the project.
  const uiPng = fromOutputsUrlPath(uiRes.outputs.find((r) => r.format === 'png').path);
  const cliPng = cliRes.find((r) => r.format === 'png').path;

  const [uiMeta, cliMeta] = await Promise.all([sharp(uiPng).metadata(), sharp(cliPng).metadata()]);
  check('UI and CLI PNGs have identical dimensions', uiMeta.width === cliMeta.width && uiMeta.height === cliMeta.height,
    `${uiMeta.width}x${uiMeta.height} vs ${cliMeta.width}x${cliMeta.height}`);
  check('UI and CLI PNGs have identical DPI metadata', uiMeta.density === cliMeta.density, `${uiMeta.density} vs ${cliMeta.density}`);

  // Chromium's rasterizer is NOT bit-exact across processes: gradients and glyph
  // antialiasing differ on a handful of subpixels. Assert visual equivalence, not a
  // hash. The PDF (vector) is the authoritative output.
  //
  // The RATIO is the bound that discriminates. A structural difference — the A1
  // bleed-PNG bug — moved 1.1% of subpixels, four orders of magnitude over this
  // limit. The per-subpixel delta is the weak signal: under load this render has been
  // seen at 129 differing subpixels (0.0005%) with a max delta of 5/255, which is one
  // invisible pixel on an antialiased gradient edge, not a wrong picture. A delta
  // ceiling of 2 was one observation mistaken for a law.
  const [uiRaw, cliRaw] = await Promise.all([sharp(uiPng).raw().toBuffer(), sharp(cliPng).raw().toBuffer()]);
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < uiRaw.length; i++) {
    const d = Math.abs(uiRaw[i] - cliRaw[i]);
    if (d) { differing++; if (d > maxDelta) maxDelta = d; }
  }
  const ratio = differing / uiRaw.length;
  check('UI and CLI PNGs are visually identical (<0.01% of subpixels, delta <= 8)',
    ratio < 0.0001 && maxDelta <= 8, `${differing} bytes differ (${(ratio * 100).toFixed(5)}%), max delta ${maxDelta}`);

  check('a clean render reports no warnings', uiRes.warnings.length === 0, JSON.stringify(uiRes.warnings));

  console.log('— B1: a UI render is as reproducible as a CLI one —');
  // The Guard's promise is that the job spec is the saved record of one generation.
  // The CLI enforces it structurally; the UI used to render without persisting anything.
  check('the render response names the spec it saved', uiRes.savedSpec === 'jobs/apptest-ui.json', String(uiRes.savedSpec));
  const savedPath = path.join(PROJECT_ROOT, 'jobs', 'apptest-ui.json');
  const savedRaw = await fs.readFile(savedPath, 'utf8').catch(() => null);
  check('the spec file exists on disk', savedRaw !== null);
  const savedSpec = savedRaw && JSON.parse(savedRaw);
  check('the saved spec round-trips through the validator', savedSpec && validateSpec(savedSpec).length === 0,
    JSON.stringify(savedSpec ? validateSpec(savedSpec) : 'unreadable'));
  check('the saved spec reproduces the render it came from',
    savedSpec?.template === spec.template && savedSpec?.paperSize === spec.paperSize
      && JSON.stringify(savedSpec?.content) === JSON.stringify(spec.content),
    JSON.stringify({ template: savedSpec?.template, paperSize: savedSpec?.paperSize }));

  const uiPdf = fromOutputsUrlPath(uiRes.outputs.find((r) => r.format === 'pdf').path);
  const cliPdf = cliRes.find((r) => r.format === 'pdf').path;
  const [uiInfo, cliInfo] = await Promise.all([pdfInfo(uiPdf), pdfInfo(cliPdf)]);
  check('UI and CLI PDFs have the same page box', uiInfo.width === cliInfo.width && uiInfo.height === cliInfo.height,
    `${uiInfo.width}x${uiInfo.height} vs ${cliInfo.width}x${cliInfo.height}`);
  check('UI and CLI PDFs have the same text content', uiInfo.text === cliInfo.text);
  check('UI and CLI PDFs embed the same fonts',
    inspectFonts(await fs.readFile(uiPdf)).fonts.join() === inspectFonts(await fs.readFile(cliPdf)).fonts.join());

  check('UI render lands in the routed folder',
    uiRes.outputs.find((r) => r.format === 'png').path.startsWith('outputs/south-end/posters/'), uiPng);

  console.log('— A7: the suite renders into a temp outputs root —');
  check('the server honoured HIG_OUTPUTS_ROOT', isInside(OUTPUTS_ROOT, uiPng), uiPng);
  check('the in-process CLI render honoured it too', isInside(OUTPUTS_ROOT, cliPng), cliPng);
  check('nothing was written to the project outputs/',
    !isInside(path.join(PROJECT_ROOT, 'outputs'), uiPng) && !isInside(path.join(PROJECT_ROOT, 'outputs'), cliPng));
  // The Recent Outputs panel reads the same root, so it must still find the renders.
  const panel = await page.evaluate(() => fetch('/api/outputs').then((r) => r.json()));
  check('the outputs panel lists renders from the temp root',
    panel.some((r) => r.path.includes('apptest-ui')), `${panel.length} rows`);

  console.log('— A10: unfilled placeholders reach the user, not just the console —');
  // Clear the image slot and render through the real button. The document ships with a
  // hole in it; the drawer has to say so.
  await loadJob('poster-example.json');
  const drawer = await page.evaluate(async () => {
    const slot = document.querySelector('[data-field="image:background"]');
    slot.value = '';
    slot.dispatchEvent(new Event('input', { bubbles: true }));
    document.forms.spec.name.value = 'apptest-warn';
    document.forms.spec.autoOpen.checked = false;
    await new Promise((r) => setTimeout(r, 900));
    document.getElementById('render').click();
    // Wait for the render to land in the drawer.
    for (let i = 0; i < 120 && !document.querySelector('#result .file, #result .err'); i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      warnings: [...document.querySelectorAll('#result .warn')].map((e) => e.textContent),
      files: document.querySelectorAll('#result .file').length,
    };
  });
  check('the render still succeeded', drawer.files > 0, `${drawer.files} files`);
  check('the drawer warns about the unfilled placeholder',
    drawer.warnings.some((w) => w.includes('image:background')), JSON.stringify(drawer.warnings));

  console.log('— A9: a crashed Chromium heals instead of bricking the server —');
  const crashed = await page.evaluate(() => fetch('/api/_test/crash-browser', { method: 'POST' }).then((r) => r.json()));
  check('the test-only crash endpoint killed the browser', crashed.killed === true, JSON.stringify(crashed));
  await new Promise((r) => setTimeout(r, 500));   // let puppeteer notice the disconnect

  const afterCrash = await page.evaluate(async (s) => {
    const r = await fetch('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: s, autoOpen: false }),
    });
    return { status: r.status, body: await r.json() };
  }, { ...posterSpec, name: 'apptest-after-crash', outputs: ['pdf'] });
  check('a render after the crash succeeds (browser relaunched)', afterCrash.status === 200,
    `${afterCrash.status} ${JSON.stringify(afterCrash.body).slice(0, 160)}`);
  check('and it produced a real PDF', afterCrash.body.outputs?.[0]?.format === 'pdf',
    JSON.stringify(afterCrash.body.outputs));
  check('the relaunched browser stays usable',
    (await page.evaluate(async (s) => {
      const r = await fetch('/api/render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: s, autoOpen: false }),
      });
      return r.status;
    }, { ...posterSpec, name: 'apptest-after-crash-2', outputs: ['pdf'] })) === 200);

  console.log('— B3: image slots offer the real assets —');
  await loadJob('poster-example.json');
  const slotUi = await page.evaluate(async () => {
    const assets = await (await fetch('/api/assets')).json();
    const input = document.querySelector('[data-field="image:background"]');
    const options = [...document.querySelectorAll('#assets option')].map((o) => o.value);
    const img = input.parentElement.querySelector('img.slot-preview');
    // The example job already points at a real asset, so the preview should be showing.
    const shownFor = { src: img?.getAttribute('src'), hidden: img?.hidden, natural: img?.naturalWidth ?? 0 };

    // Point it at a path that doesn't exist: the preview must hide, not show a broken icon.
    input.value = '/assets/definitely-not-here.png';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const afterBadPath = img?.hidden;

    return { assets, options, listAttr: input.getAttribute('list'), shownFor, afterBadPath };
  });
  check('GET /api/assets finds the placeholder images',
    slotUi.assets.includes('/assets/placeholder-background.png') && slotUi.assets.includes('/assets/placeholder-seal.png'),
    slotUi.assets.join(', '));
  check('the slot input is wired to the assets datalist', slotUi.listAttr === 'assets', String(slotUi.listAttr));
  check('the datalist offers every asset', slotUi.options.length === slotUi.assets.length,
    `${slotUi.options.length} options vs ${slotUi.assets.length} assets`);
  check('a slot with a real path shows a live preview',
    slotUi.shownFor.hidden === false && slotUi.shownFor.natural > 0, JSON.stringify(slotUi.shownFor));
  check('a slot with a bad path hides the preview', slotUi.afterBadPath === true, String(slotUi.afterBadPath));
} finally {
  await fs.writeFile(legalTemplate, originalLegal);
  const strays = (await fs.readdir(JOBS_DIR)).filter((f) => !jobsBefore.has(f));
  await Promise.all(strays.map((f) => fs.rm(path.join(JOBS_DIR, f), { force: true })));
  await browser.close();
  server.kill();
}

console.log(`\noutputs root: ${OUTPUTS_ROOT}`);
console.log(`boot: ${bootMs} ms to first URL`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
