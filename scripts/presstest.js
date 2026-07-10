// Phase 4 exit tests — the optional press pipeline.
//   node scripts/presstest.js
//
// This suite is the only one allowed to need software the core app doesn't. It
// SELF-SKIPS without Ghostscript and exits 0, because `npm test` must stay green on a
// machine that never installs it. CI installs Ghostscript so the conversion path runs
// on every push — a suite that silently skipped everywhere would prove nothing, so the
// summary line says out loud which path it took, and CI greps for it.
//
// Two escapes make the environment testable from either side:
//   HIG_GS=0            pretend Ghostscript is absent, on a machine that has it
//   HIG_ICC_PROFILE=0   pretend no ICC profile exists, on a machine that has one

import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { pdfInfo, inspectFonts, inspectPdfDeep, isSubsetted } from './pdfinfo.js';
import { renderJob } from './render.js';
import { PROJECT_ROOT } from './paths.js';
import {
  NO_ICC_WARNING, convertToCmyk, findGhostscript, findIccProfile,
  ghostscriptVersion, isPressAvailable,
} from './press.js';
import { useTempOutputs } from './testenv.js';

const OUTPUTS_ROOT = await useTempOutputs('presstest');

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  SKIP  ${name} — ${why}`); }

// pdfjs emits one item per glyph run; letter-spacing and text-transform mean the two
// renders of one document agree on letters, not on whitespace.
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- the environment contract, which needs no Ghostscript at all ----------
console.log('— Detection —');
{
  const real = process.env.HIG_GS;
  process.env.HIG_GS = '0';
  check('HIG_GS=0 forces "Ghostscript absent" (so the missing-gs path is testable)',
    findGhostscript() === null && isPressAvailable() === false);
  if (real === undefined) delete process.env.HIG_GS; else process.env.HIG_GS = real;
}
{
  const real = process.env.HIG_ICC_PROFILE;
  process.env.HIG_ICC_PROFILE = '0';
  check('HIG_ICC_PROFILE=0 forces "no profile"', findIccProfile() === null);
  process.env.HIG_ICC_PROFILE = path.join(PROJECT_ROOT, 'definitely-not-a-profile.icc');
  check('a HIG_ICC_PROFILE that does not exist resolves to none, not to a bad path',
    findIccProfile() === null);
  if (real === undefined) delete process.env.HIG_ICC_PROFILE; else process.env.HIG_ICC_PROFILE = real;
}

const gs = findGhostscript();
if (!gs) {
  console.log('\n— Conversion —');
  skip('convert an RGB PDF to DeviceCMYK', 'Ghostscript not found');
  skip('PDF/X-4 output intent', 'Ghostscript not found');
  console.log('\npresstest: Ghostscript not found — conversion path SKIPPED.');
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

console.log(`\n  Ghostscript: ${gs} (${await ghostscriptVersion()})`);

// ---- render one real RGB poster, then convert it --------------------------
const posterSpec = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', 'poster-example.json'), 'utf8'));
const browser = await puppeteer.launch();
let rgbPdf;
try {
  const { outputs } = await renderJob(
    { ...posterSpec, name: 'presstest-source', outputs: ['pdf'] },
    { browser, autoOpen: false },
  );
  rgbPdf = outputs[0].path;
} finally {
  await browser.close();
}
const rgbInfo = await pdfInfo(rgbPdf);
const workDir = path.dirname(rgbPdf);

console.log('\n— Conversion: plain CMYK (no ICC profile) —');
{
  const out = path.join(workDir, 'presstest-plain-cmyk.pdf');
  const { pdfx, warnings } = await convertToCmyk(rgbPdf, out, { icc: null });
  const buf = await fs.readFile(out);
  const info = await pdfInfo(out);
  const deep = await inspectPdfDeep(buf);
  const regex = inspectFonts(buf);

  check('cmyk: the converted PDF measures exactly 612x792 pt',
    info.width === 612 && info.height === 792, `${info.width}x${info.height}`);
  check('cmyk: it is PDF 1.4 — the pinned CompatibilityLevel', deep.version === '%PDF-1.4', deep.version);
  check('cmyk: zero object streams, so pdfinfo.js can still read it by regex',
    deep.objStreams === 0 && regex.embedded > 0, `objStm=${deep.objStreams} fontfiles=${regex.embedded}`);
  check('cmyk: every font is still embedded and subsetted',
    deep.embedded === 4 && deep.fonts.length === 4 && deep.fonts.every(isSubsetted),
    `${deep.embedded} /FontFile*, ${deep.fonts.join(' ')}`);
  check('cmyk: the text is unchanged — Ghostscript did not rasterize the page',
    normalize(info.text) === normalize(rgbInfo.text) && normalize(info.text).length > 100,
    `${normalize(info.text).length} chars vs ${normalize(rgbInfo.text).length}`);
  check('cmyk: the page is DeviceCMYK with no DeviceRGB left',
    deep.deviceCmyk > 0 && deep.deviceRgb === 0, `cmyk=${deep.deviceCmyk} rgb=${deep.deviceRgb}`);
  check('cmyk: the job\'s provenance survives conversion (Author/Subject/Creator)',
    info.info.Author === posterSpec.project && info.info.Subject === posterSpec.docType
      && info.info.Creator === 'HTML Image Generator',
    JSON.stringify({ a: info.info.Author, s: info.info.Subject, c: info.info.Creator }));
  check('cmyk: the document title Chromium wrote from <title> survives',
    info.info.Title === rgbInfo.info.Title && Boolean(info.info.Title), String(info.info.Title));
  check('cmyk: no ICC profile means no output intent — and no PDF/X claim',
    pdfx === null && deep.outputIntent === null && !deep.xmp.includes('pdfxid'));
  check('cmyk: and it says so, in warnings[], rather than silently degrading',
    warnings.length === 1 && warnings[0] === NO_ICC_WARNING, JSON.stringify(warnings));
}

console.log('\n— Conversion: PDF/X-4 (with an ICC profile) —');
const icc = findIccProfile();
if (!icc) {
  skip('PDF/X-4 output intent', 'no ICC profile: set HIG_ICC_PROFILE or drop one at assets/icc/press.icc (see its README)');
} else {
  console.log(`  ICC: ${icc}`);
  const out = path.join(workDir, 'presstest-pdfx4.pdf');
  const { pdfx, warnings } = await convertToCmyk(rgbPdf, out, { icc });
  const buf = await fs.readFile(out);
  const info = await pdfInfo(out);
  const deep = await inspectPdfDeep(buf);

  check('pdfx: the converted PDF measures exactly 612x792 pt',
    info.width === 612 && info.height === 792, `${info.width}x${info.height}`);
  check('pdfx: it is PDF 1.6 — PDF/X-4 requires it, and Ghostscript forces it',
    deep.version === '%PDF-1.6', deep.version);
  check('pdfx: the catalog carries /OutputIntents with subtype /GTS_PDFX',
    deep.outputIntent?.subtype === '/GTS_PDFX', JSON.stringify(deep.outputIntent));
  check('pdfx: the output intent embeds a four-channel /DestOutputProfile',
    deep.outputIntent?.destOutputProfileN === 4, String(deep.outputIntent?.destOutputProfileN));
  check('pdfx: the Info dict declares GTS_PDFXVersion PDF/X-4',
    info.info.Custom?.GTS_PDFXVersion === 'PDF/X-4', JSON.stringify(info.info.Custom));
  check('pdfx: the XMP carries the pdfxid identification PDF/X-4 conformance requires',
    /pdfxid:GTS_PDFXVersion\s*=\s*'PDF\/X-4'/.test(deep.xmp) || /pdfxid:GTS_PDFXVersion\s*=\s*"PDF\/X-4"/.test(deep.xmp),
    deep.xmp.slice(0, 200));
  check('pdfx: every page carries a TrimBox, and the file is unencrypted',
    deep.trimBoxOnEveryPage && !deep.encrypted);
  check('pdfx: /Trapped is False — PDF/X forbids leaving it Unknown',
    deep.trapped === '/False', deep.trapped || '(absent)');
  // The trap that -dPDFX (X-3, PDF 1.3) falls into: no transparency in 1.3, so the
  // gradient scrim flattens the whole page to a bitmap and all four fonts disappear.
  check('pdfx: all four fonts are STILL embedded and subsetted (X-3 would have rasterized them)',
    deep.embedded === 4 && deep.fonts.length === 4 && deep.fonts.every(isSubsetted),
    `${deep.embedded} /FontFile*, ${deep.fonts.join(' ')}`);
  check('pdfx: the text is still selectable vector text, unchanged from the RGB source',
    normalize(info.text) === normalize(rgbInfo.text) && normalize(info.text).length > 100,
    `${normalize(info.text).length} chars vs ${normalize(rgbInfo.text).length}`);
  check('pdfx: object streams appear at PDF 1.6 — so a converted X-4 file needs inspectPdfDeep(), not a regex',
    deep.objStreams > 0 && inspectFonts(buf).embedded === 0,
    `objStm=${deep.objStreams} regexFontFiles=${inspectFonts(buf).embedded}`);
  check('pdfx: a real output intent means no degradation warning',
    pdfx === 'PDF/X-4' && warnings.length === 0, JSON.stringify(warnings));
}

console.log(`\noutputs root: ${OUTPUTS_ROOT}`);
console.log('presstest: Ghostscript present — conversion path EXERCISED.');
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
