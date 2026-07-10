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

  // Paged.js path smoke test — bleed + crop marks must grow the sheet past 612x792.
  const bleedOut = await renderJob({
    ...base, name: 'selftest-bleed', bleed: '0.125in', cropMarks: true,
    content: { title: 'Selftest — Bleed', note: 'Paged.js path' },
  }, { browser, autoOpen: false });
  const bp = await pdfInfo(bleedOut[0].path);
  check('Paged.js path: bleed/marks sheet larger than trim', bp.width > 612 && bp.height > 792, `${bp.width}x${bp.height}`);
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
