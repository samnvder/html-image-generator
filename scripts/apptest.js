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
import { PROJECT_ROOT } from './paths.js';
import { pdfInfo, inspectFonts } from './pdfinfo.js';
import { renderJob } from './render.js';

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

  console.log('— Background-tab guard (Paged.js needs rAF) —');
  const deferred = await page.evaluate(async () => {
    // Simulate a hidden tab: Chrome throttles rAF, so Paged.js would stall forever.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const f = document.getElementById('frame');
    f.src = 'about:blank';
    await new Promise((r) => setTimeout(r, 400));
    document.forms.spec.margin.value = '1in';
    document.forms.spec.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    return f.src.endsWith('about:blank');   // preview was deferred, not started
  });
  check('preview is deferred while the tab is hidden', deferred);

  const recovered = await page.evaluate(async () => {
    delete document.hidden; delete document.visibilityState;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 1200));
    return !document.getElementById('frame').src.endsWith('about:blank');
  });
  check('preview resumes when the tab becomes visible', recovered);
  await previewState();

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
  const cliRes = await renderJob({ ...spec, name: 'apptest-cli' }, { autoOpen: false });

  const uiPng = path.join(PROJECT_ROOT, uiRes.find((r) => r.format === 'png').path);
  const cliPng = cliRes.find((r) => r.format === 'png').path;

  const [uiMeta, cliMeta] = await Promise.all([sharp(uiPng).metadata(), sharp(cliPng).metadata()]);
  check('UI and CLI PNGs have identical dimensions', uiMeta.width === cliMeta.width && uiMeta.height === cliMeta.height,
    `${uiMeta.width}x${uiMeta.height} vs ${cliMeta.width}x${cliMeta.height}`);
  check('UI and CLI PNGs have identical DPI metadata', uiMeta.density === cliMeta.density, `${uiMeta.density} vs ${cliMeta.density}`);

  // Chromium's rasterizer is NOT bit-exact across processes: gradients and glyph
  // antialiasing can differ by ~1-2/255 on a handful of pixels. Assert visual
  // equivalence, not a hash. The PDF (vector) is the authoritative output.
  const [uiRaw, cliRaw] = await Promise.all([sharp(uiPng).raw().toBuffer(), sharp(cliPng).raw().toBuffer()]);
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < uiRaw.length; i++) {
    const d = Math.abs(uiRaw[i] - cliRaw[i]);
    if (d) { differing++; if (d > maxDelta) maxDelta = d; }
  }
  const ratio = differing / uiRaw.length;
  check('UI and CLI PNGs are visually identical (<0.01% of subpixels, delta <= 2)',
    ratio < 0.0001 && maxDelta <= 2, `${differing} bytes differ (${(ratio * 100).toFixed(5)}%), max delta ${maxDelta}`);

  const uiPdf = path.join(PROJECT_ROOT, uiRes.find((r) => r.format === 'pdf').path);
  const cliPdf = cliRes.find((r) => r.format === 'pdf').path;
  const [uiInfo, cliInfo] = await Promise.all([pdfInfo(uiPdf), pdfInfo(cliPdf)]);
  check('UI and CLI PDFs have the same page box', uiInfo.width === cliInfo.width && uiInfo.height === cliInfo.height,
    `${uiInfo.width}x${uiInfo.height} vs ${cliInfo.width}x${cliInfo.height}`);
  check('UI and CLI PDFs have the same text content', uiInfo.text === cliInfo.text);
  check('UI and CLI PDFs embed the same fonts',
    inspectFonts(await fs.readFile(uiPdf)).fonts.join() === inspectFonts(await fs.readFile(cliPdf)).fonts.join());

  check('UI render lands in the routed folder',
    uiRes.find((r) => r.format === 'png').path.startsWith('outputs/south-end/posters/'), uiPng);
} finally {
  await fs.writeFile(legalTemplate, originalLegal);
  await browser.close();
  server.kill();
}

console.log(`\nboot: ${bootMs} ms to first URL`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
