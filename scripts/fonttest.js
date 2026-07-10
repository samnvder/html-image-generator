// Settles research open question #1: do @font-face fonts embed in Chromium PDFs,
// and does WOFF2 behave differently from TTF?
//   node scripts/fonttest.js
//
// Chromium (Skia) writes uncompressed font descriptors — no /ObjStm — so the PDF
// can be inspected by scanning for /BaseFont, /FontFile2, and the six-letter
// subset prefix that marks a subsetted embedded font.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { renderJob } from './render.js';
import { inspectFonts, isSubsetted } from './pdfinfo.js';
import { PROJECT_ROOT } from './paths.js';
import { useTempOutputs } from './testenv.js';

await useTempOutputs('fonttest');

const TEMPLATE = path.join(PROJECT_ROOT, 'templates', '_fonttest.html');
await fs.writeFile(TEMPLATE, `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'FT Woff2'; src: url('/fonts/inter-400.woff2') format('woff2'); font-display: block; }
  @font-face { font-family: 'FT Ttf'; src: url('/fonts/open-sans-400.ttf') format('truetype'); font-display: block; }
  body { margin: 0.5in; font-size: 18pt; }
  .w { font-family: 'FT Woff2'; }
  .t { font-family: 'FT Ttf'; }
</style></head>
<body>
  <p class="w">Woff2 sample — Handgloves 0123456789</p>
  <p class="t">Ttf sample — Handgloves 0123456789</p>
</body></html>
`);

const browser = await puppeteer.launch();
let out;
try {
  out = await renderJob({
    name: 'fonttest',
    project: 'Demo',
    docType: 'probe',
    paperSize: 'letter',
    margin: '0.5in',
    template: '_fonttest.html',
    outputs: ['pdf'],
  }, { browser, autoOpen: false });
} finally {
  await browser.close();
  await fs.rm(TEMPLATE, { force: true });
}

const info = inspectFonts(await fs.readFile(out[0].path));

console.log('\nEmbedded fonts in the PDF:');
for (const f of info.fonts) console.log(`  ${f}`);
console.log(`\n  /FontFile* entries: ${info.embedded}`);
console.log(`  object streams:     ${info.objStreams}`);

const named = (needle) => info.fonts.find((f) => f.toLowerCase().includes(needle));
const woff2 = named('inter');
const ttf = named('opensans') ?? named('open');
const subset = isSubsetted;

console.log('\nVerdict (research open question #1):');
console.log(`  WOFF2 via @font-face embedded: ${woff2 ? 'YES' : 'NO'}${woff2 ? `  (${subset(woff2) ? 'subsetted' : 'FULL — not subsetted'})` : ''}`);
console.log(`  TTF   via @font-face embedded: ${ttf ? 'YES' : 'NO'}${ttf ? `  (${subset(ttf) ? 'subsetted' : 'FULL — not subsetted'})` : ''}`);

const ok = Boolean(woff2 && ttf && subset(woff2) && subset(ttf));
console.log(ok
  ? '\n  => Both formats embed and subset identically. Chromium decodes WOFF2 and re-embeds\n     the glyf table as a subsetted TrueType (/FontFile2). Format choice is a delivery\n     detail, not a print-fidelity one. Prefer WOFF2 (smaller source files).'
  : '\n  => Unexpected result — do not assume font embedding. Inspect the PDF manually.');

console.log(`\n  PDF: ${path.relative(process.cwd(), out[0].path)}`);
process.exit(ok ? 0 : 1);
