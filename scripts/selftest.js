// Phase 1 exit tests — hard numbers, not vibes.
//   node scripts/selftest.js
//
// Letter PDF must measure exactly 612x792 pt, Legal 612x1008 pt,
// Letter PNG @300 exactly 2550x3300 px with density 300.
// Probes A (DSF truncation) and B (native @page margin boxes) run here because
// their answers decide Phase 2's template architecture.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { slugify, pluralizeDocType, OUTPUTS_ROOT } from './paths.js';
import { pdfInfo } from './pdfinfo.js';
import { renderJob } from './render.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('— Routing & slug security (pure) —');
check('slugify basic', slugify('South End') === 'south-end');
check('slugify unicode/punctuation', slugify("St. Mary's Café!") === 'st-mary-s-cafe');
check('pluralize map', pluralizeDocType('flyer') === 'flyers');
check('pluralize -y', pluralizeDocType('registry') === 'registries');
check('pluralize -sh', pluralizeDocType('wash') === 'washes');
for (const bad of ['../../etc', 'a/b', 'a\\b', 'CON', 'com1', '   ', '***']) {
  let threw = false;
  try { slugify(bad); } catch { threw = true; }
  check(`rejects "${bad}"`, threw);
}

console.log('— Render engine —');
const browser = await puppeteer.launch();
try {
  const base = {
    name: 'selftest-letter',
    project: 'South End',
    docType: 'flyer',
    paperSize: 'letter',
    margin: '0',
    template: '_selftest.html',
    content: { title: 'Selftest — Letter', note: 'exit test' },
  };

  // Letter PDF + PNG (also the routing test: South End/flyer -> south-end/flyers)
  const letterOut = await renderJob({ ...base, outputs: ['pdf', 'png'] }, { browser, autoOpen: false });
  const letterPdf = letterOut.find((r) => r.format === 'pdf').path;
  const letterPng = letterOut.find((r) => r.format === 'png').path;

  const expectedDir = path.join(OUTPUTS_ROOT, 'south-end', 'flyers');
  check('routing: outputs/south-end/flyers/', path.dirname(letterPdf) === expectedDir, path.dirname(letterPdf));
  check('routing: latest.pdf written', await fs.stat(path.join(expectedDir, 'latest.pdf')).then(() => true, () => false));
  check('routing: latest.png written', await fs.stat(path.join(expectedDir, 'latest.png')).then(() => true, () => false));

  const lp = await pdfInfo(letterPdf);
  check('Letter PDF is 612x792 pt', lp.width === 612 && lp.height === 792, `${lp.width}x${lp.height}`);
  check('Letter PDF is 1 page', lp.pages === 1, `${lp.pages} pages`);

  const meta = await sharp(letterPng).metadata();
  check('Letter PNG @300 is 2550x3300 px', meta.width === 2550 && meta.height === 3300, `${meta.width}x${meta.height}`);
  check('PNG density reads 300 DPI', Math.round(meta.density) === 300, `density ${meta.density}`);

  // Probe A — DSF 3.125 truncation: the bottom-right 0.5in corner marker must survive.
  // (sharp's stats() ignores pipeline ops like extract(), so measure via raw pixels.)
  const corner = await sharp(letterPng)
    .extract({ left: meta.width - 20, top: meta.height - 20, width: 20, height: 20 })
    .greyscale().raw().toBuffer();
  const brMean = corner.reduce((a, b) => a + b, 0) / corner.length;
  check('Probe A: no truncation at DSF 3.125 (bottom-right marker present)', brMean < 100, `corner mean ${brMean.toFixed(1)} (want <100 = dark)`);

  // Legal PDF
  const legalOut = await renderJob({
    ...base, name: 'selftest-legal', paperSize: 'legal', content: { title: 'Selftest — Legal', note: 'exit test' },
  }, { browser, autoOpen: false });
  const gp = await pdfInfo(legalOut[0].path);
  check('Legal PDF is 612x1008 pt', gp.width === 612 && gp.height === 1008, `${gp.width}x${gp.height}`);
  check('Legal PDF is 1 page', gp.pages === 1, `${gp.pages} pages`);

  // Probe B — native @page margin boxes (no Paged.js)
  const probeOut = await renderJob({
    name: 'probe-marginboxes', project: 'Demo', docType: 'probe',
    paperSize: 'letter', margin: '0.75in', template: '_probe-marginboxes.html',
  }, { browser, autoOpen: false });
  const pb = await pdfInfo(probeOut[0].path);
  const bodyOk = pb.text.includes('MBPROBE-BODY');
  const native = pb.text.includes('MBPROBE-NATIVE');
  check('Probe B: probe body rendered', bodyOk);
  console.log(`  INFO  Probe B verdict: native @page margin boxes ${native ? 'SUPPORTED — Paged.js not needed for headers/footers' : 'NOT supported — use Paged.js string-set for running headers'}`);

  // A1 — a bleed job asks for two different documents. The PDF gets the Paged.js
  // composition (sheet grows past trim); the PNG must be the plain screen render.
  // Before the fix, the PNG captured the polyfill-restructured DOM: content shifted
  // by the bleed offset, corner markers pulled inward, sheet edge visible.
  const bleedContent = { title: 'Selftest — Bleed', note: 'Paged.js path' };
  const bleedOut = await renderJob({
    ...base, name: 'selftest-bleed', bleed: '0.125in', cropMarks: true,
    outputs: ['pdf', 'png'], content: bleedContent,
  }, { browser, autoOpen: false });
  const bp = await pdfInfo(bleedOut.find((r) => r.format === 'pdf').path);
  check('Paged.js path: bleed/marks sheet larger than trim', bp.width > 612 && bp.height > 792, `${bp.width}x${bp.height}`);

  const controlOut = await renderJob({
    ...base, name: 'selftest-bleed-control', outputs: ['png'], content: bleedContent,
  }, { browser, autoOpen: false });

  const bleedPng = bleedOut.find((r) => r.format === 'png').path;
  const controlPng = controlOut[0].path;
  const [bleedMeta, controlMeta] = await Promise.all([sharp(bleedPng).metadata(), sharp(controlPng).metadata()]);
  check('A1: bleed PNG is still trim size (2550x3300)',
    bleedMeta.width === 2550 && bleedMeta.height === 3300, `${bleedMeta.width}x${bleedMeta.height}`);

  // The audit's probe, made permanent. Chromium's rasterizer is not bit-exact across
  // processes, so this is a pixel-equivalence bound, not a hash. Pre-fix this measured
  // 1.1% of subpixels differing against a 0.0001% noise floor.
  const [bleedRaw, controlRaw] = await Promise.all([sharp(bleedPng).raw().toBuffer(), sharp(controlPng).raw().toBuffer()]);
  let differing = 0;
  let maxDelta = 0;
  if (bleedRaw.length === controlRaw.length) {
    for (let i = 0; i < bleedRaw.length; i++) {
      const d = Math.abs(bleedRaw[i] - controlRaw[i]);
      if (d) { differing++; if (d > maxDelta) maxDelta = d; }
    }
  } else {
    differing = Infinity;
  }
  const ratio = differing / bleedRaw.length;
  check('A1: bleed PNG is pixel-equivalent to the no-bleed PNG (<0.01% subpixels, delta <= 2)',
    ratio < 0.0001 && maxDelta <= 2,
    `${differing} subpixels differ (${(ratio * 100).toFixed(5)}%), max delta ${maxDelta}`);

  // A2 — content is text, not markup. {{key}} escapes; {{{key}}} is the explicit opt-in.
  const escapeOut = await renderJob({
    name: 'selftest-escape', project: 'Demo', docType: 'probe',
    paperSize: 'letter', margin: '0', template: '_escape.html',
    content: {
      plain: '<b>bold?</b>',
      angle: 'use <Enter> to continue',
      raw: '<b>MARKUP</b>',
    },
  }, { browser, autoOpen: false });
  // pdfjs emits one item per glyph run, so compare with whitespace removed.
  const esc = (await pdfInfo(escapeOut[0].path)).text.replace(/\s+/g, '');
  check('A2: {{key}} renders tags literally', esc.includes('<b>bold?</b>'), esc.slice(0, 120));
  check('A2: text like "use <Enter> to continue" survives intact', esc.includes('use<Enter>tocontinue'), esc.slice(0, 120));
  check('A2: {{{key}}} renders as markup', esc.includes('MARKUP') && !esc.includes('<b>MARKUP</b>'), esc.slice(0, 120));
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
