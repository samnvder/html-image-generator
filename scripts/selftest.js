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
import { slugify, pluralizeDocType, PROJECT_ROOT, isInside } from './paths.js';
import { pdfInfo } from './pdfinfo.js';
import { renderJob } from './render.js';
import { useTempOutputs } from './testenv.js';

// Never render into the user's outputs/. paths.js resolves the root at call time.
const OUTPUTS_ROOT = await useTempOutputs('selftest');

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
  const { outputs: letterOut } = await renderJob({ ...base, outputs: ['pdf', 'png'] }, { browser, autoOpen: false });
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
  const { outputs: legalOut } = await renderJob({
    ...base, name: 'selftest-legal', paperSize: 'legal', content: { title: 'Selftest — Legal', note: 'exit test' },
  }, { browser, autoOpen: false });
  const gp = await pdfInfo(legalOut[0].path);
  check('Legal PDF is 612x1008 pt', gp.width === 612 && gp.height === 1008, `${gp.width}x${gp.height}`);
  check('Legal PDF is 1 page', gp.pages === 1, `${gp.pages} pages`);

  // Probe B — native @page margin boxes (no Paged.js)
  const { outputs: probeOut } = await renderJob({
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
  const { outputs: bleedOut } = await renderJob({
    ...base, name: 'selftest-bleed', bleed: '0.125in', cropMarks: true,
    outputs: ['pdf', 'png'], content: bleedContent,
  }, { browser, autoOpen: false });
  const bp = await pdfInfo(bleedOut.find((r) => r.format === 'pdf').path);
  check('Paged.js path: bleed/marks sheet larger than trim', bp.width > 612 && bp.height > 792, `${bp.width}x${bp.height}`);

  const { outputs: controlOut } = await renderJob({
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
  const { outputs: escapeOut } = await renderJob({
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

  // A4 — every run of a job shares one timestamp, so a variant that overrides only
  // `content` used to resolve to the base run's exact path and overwrite it silently.
  const { outputs: variantOut } = await renderJob({
    ...base, name: 'selftest-variants', outputs: ['pdf'],
    content: { title: 'Variant 1', note: 'base run' },
    variants: [
      { content: { title: 'Variant 2', note: 'second run' } },
      { content: { title: 'Variant 3', note: 'third run' } },
    ],
  }, { browser, autoOpen: false });
  const variantPaths = variantOut.map((r) => r.path);
  check('A4: three runs produce three PDFs', variantPaths.length === 3, `${variantPaths.length}`);
  check('A4: no two runs share an output path', new Set(variantPaths).size === 3, variantPaths.map((p) => path.basename(p)).join(' '));
  check('A4: repeats of a name are numbered --v2, --v3',
    /--v2--letter--/.test(variantPaths[1]) && /--v3--letter--/.test(variantPaths[2]),
    variantPaths.map((p) => path.basename(p)).join(' '));
  const survived = await Promise.all(variantPaths.map((p) => fs.stat(p).then(() => true, () => false)));
  check('A4: every variant file survived (none overwritten)', survived.every(Boolean), JSON.stringify(survived));

  // A variant that renames itself keeps its own name — no suffix, no collision.
  const { outputs: namedOut } = await renderJob({
    ...base, name: 'selftest-named-base', outputs: ['pdf'],
    content: { title: 'Base', note: 'x' },
    variants: [{ name: 'selftest-named-alt', content: { title: 'Alt', note: 'y' } }],
  }, { browser, autoOpen: false });
  check('A4: a renamed variant is not suffixed',
    namedOut.every((r) => !/--v\d/.test(r.path)) && new Set(namedOut.map((r) => r.path)).size === 2,
    namedOut.map((r) => path.basename(r.path)).join(' '));

  // A7 — the suite's artifacts belong in the temp root, not the user's outputs/.
  const everyRender = [...letterOut, ...legalOut, ...probeOut, ...bleedOut, ...controlOut,
    ...escapeOut, ...variantOut, ...namedOut];
  check('A7: every artifact landed under HIG_OUTPUTS_ROOT',
    everyRender.every((r) => isInside(OUTPUTS_ROOT, r.path)), OUTPUTS_ROOT);
  check('A7: nothing was written to the project outputs/',
    !everyRender.some((r) => isInside(path.join(PROJECT_ROOT, 'outputs'), r.path)));
} finally {
  await browser.close();
}

console.log(`\noutputs root: ${OUTPUTS_ROOT}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
