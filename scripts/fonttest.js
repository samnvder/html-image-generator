// Settles research open question #1: do @font-face fonts embed in Chromium PDFs,
// and does WOFF2 behave differently from TTF?
//   node scripts/fonttest.js
//
// Chromium (Skia) writes uncompressed font descriptors — no /ObjStm — so the PDF
// can be inspected by scanning for /BaseFont, /FontFile2, and the six-letter
// subset prefix that marks a subsetted embedded font.
//
// This was a probe that printed a verdict and exited non-zero. It is now a suite: real
// coverage that contributed nothing to the total and could not fail one check at a time.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { renderJob } from './render.js';
import { inspectFonts, isSubsetted, pdfInfo } from './pdfinfo.js';
import { PROJECT_ROOT } from './paths.js';
import { useTempOutputs } from './testenv.js';

await useTempOutputs('fonttest');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

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
  ({ outputs: out } = await renderJob({
    name: 'fonttest',
    project: 'Demo',
    docType: 'probe',
    paperSize: 'letter',
    margin: '0.5in',
    template: '_fonttest.html',
    outputs: ['pdf'],
  }, { browser, autoOpen: false }));
} finally {
  await browser.close();
  await fs.rm(TEMPLATE, { force: true });
}

const buf = await fs.readFile(out[0].path);
const info = inspectFonts(buf);
const text = (await pdfInfo(out[0].path)).text;

console.log('\nEmbedded fonts in the PDF:');
for (const f of info.fonts) console.log(`  ${f}`);
console.log(`\n  /FontFile* entries: ${info.embedded}`);
console.log(`  object streams:     ${info.objStreams}\n`);

const named = (needle) => info.fonts.find((f) => f.toLowerCase().includes(needle));
const woff2 = named('inter');
const ttf = named('opensans') ?? named('open');

check('a WOFF2 @font-face family is embedded', Boolean(woff2), info.fonts.join(', '));
check('a TTF @font-face family is embedded', Boolean(ttf), info.fonts.join(', '));
check('the WOFF2 font is subsetted', isSubsetted(woff2), String(woff2));
check('the TTF font is subsetted', isSubsetted(ttf), String(ttf));
check('both fonts carry an embedded /FontFile* program', info.embedded >= 2, `${info.embedded}`);
// A missing @font-face silently falls back to a system font, and the PDF renders fine —
// which is exactly why nothing would notice. Chromium substitutes Arial (or Liberation
// Sans on CI); either name means the font never loaded.
check('neither family silently fell back to a system font',
  !info.fonts.some((f) => /arial|liberation|helvetica|dejavu/i.test(f)), info.fonts.join(', '));
check('Chromium wrote no object streams, which is what makes the check above possible',
  info.objStreams === 0, `${info.objStreams}`);
check('both samples survive as extractable text', /Handgloves/.test(text) && text.split('Handgloves').length === 3, text.slice(0, 80));

const ok = failed === 0;
console.log(ok
  ? '\n  => Both formats embed and subset identically. Chromium decodes WOFF2 and re-embeds\n     the glyf table as a subsetted TrueType (/FontFile2). Format choice is a delivery\n     detail, not a print-fidelity one. Prefer WOFF2 (smaller source files).'
  : '\n  => Unexpected result — do not assume font embedding. Inspect the PDF manually.');

console.log(`\n  PDF: ${path.relative(process.cwd(), out[0].path)}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
