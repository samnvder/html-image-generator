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

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { pdfInfo, inspectFonts, inspectPdfDeep, isSubsetted } from './pdfinfo.js';
import { renderJob } from './render.js';
import { PROJECT_ROOT, outputDirFor } from './paths.js';
import {
  MIN_GS_VERSION, NO_ICC_WARNING, compareVersions, convertToCmyk, findGhostscript,
  findIccProfile, ghostscriptVersion, isPressAvailable, isVersionSupported,
  pressCapability, pressUnavailableMessage,
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
    findGhostscript() === null && (await isPressAvailable()) === false);
  if (real === undefined) delete process.env.HIG_GS; else process.env.HIG_GS = real;
}

console.log('— The minimum Ghostscript version, and why there is one —');
// -dPDFX=4 arrived in 10.05.0. Ubuntu 24.04 ships 10.02.1, where PDFX is a *boolean*:
// -dPDFX=4 dies with "/typecheck in --pdfmark--", and a plain CMYK conversion leaves
// `/Group << /CS /DeviceRGB >>` behind — the objects are CMYK, the blending is not.
// Both were observed against the real 10.02.1 binary. So old Ghostscript is, for press
// purposes, no Ghostscript.
check('compareVersions orders release numbers, not strings',
  compareVersions('10.02.1', '10.05.0') < 0 && compareVersions('9.55.0', '10.05.0') < 0
  && compareVersions('10.07.1', '10.05.0') > 0 && compareVersions('10.05', '10.05.0') === 0);
check(`Ghostscript 10.02.1 (Ubuntu 24.04's) is rejected: it predates -dPDFX=4`, !isVersionSupported('10.02.1'));
check('9.55.0 is rejected', !isVersionSupported('9.55.0'));
check(`${MIN_GS_VERSION} is the floor, and is accepted`, isVersionSupported(MIN_GS_VERSION));
check('10.07.1 is accepted', isVersionSupported('10.07.1'));
check('an unknown version is rejected rather than assumed', !isVersionSupported(null) && !isVersionSupported(''));
{
  const message = pressUnavailableMessage({ reason: 'too-old', version: '10.02.1', gs: '/usr/bin/gs' });
  check('the too-old error names the version found, the floor, and the alternative',
    message.includes('10.02.1') && message.includes(MIN_GS_VERSION) && message.includes('"rgb"'), message);
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

// ---- the hard-fail contract, which also needs no Ghostscript -------------
// This block runs on EVERY machine. It is the half of Phase 4 that matters most: a cmyk
// job on a box without Ghostscript must fail loudly, before anything renders, and never
// silently ship RGB as press output.
console.log('\n— cmyk without Ghostscript: hard error, nothing written —');
{
  const posterExample = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', 'poster-example.json'), 'utf8'));
  const spec = { ...posterExample, $schema: undefined, name: 'presstest-nogs', project: 'Press Probe', colorIntent: 'cmyk' };
  delete spec.$schema;

  const realGs = process.env.HIG_GS;
  process.env.HIG_GS = '0';
  const dir = outputDirFor(spec);

  let err = null;
  const t0 = Date.now();
  try { await renderJob(spec, { autoOpen: false }); } catch (e) { err = e; }
  const elapsed = Date.now() - t0;

  check('renderJob() rejects a cmyk job when Ghostscript is absent', err !== null);
  check('the error names Ghostscript and the fix', /Ghostscript/.test(err?.message ?? ''), err?.message);
  check('it says "rgb" is the alternative', /"rgb"/.test(err?.message ?? ''), err?.message);
  // Chromium takes ~400ms to launch. Failing in a fraction of that proves the check ran
  // before the browser, not after a render was thrown away.
  check('it fails before Chromium even launches', elapsed < 250, `${elapsed} ms`);
  check('and no output file exists afterward — not even the folder',
    !(await fs.stat(dir).then(() => true, () => false)), dir);

  // The CLI is the interface an LLM agent drives. Same contract, through a real process.
  const jobFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'hig-nogs-')), 'nogs.json');
  await fs.writeFile(jobFile, JSON.stringify({ ...spec, name: 'presstest-nogs-cli' }, null, 2));
  let cli = null;
  try {
    await promisify(execFile)(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'render.js'), jobFile, '--no-open'], {
      env: { ...process.env, HIG_GS: '0', HIG_OUTPUTS_ROOT: OUTPUTS_ROOT },
    });
  } catch (e) { cli = e; }
  check('the CLI exits nonzero on a cmyk job without Ghostscript', cli !== null && cli.code !== 0, `code ${cli?.code}`);
  check('and prints a message naming Ghostscript to stderr', /Ghostscript/.test(cli?.stderr ?? ''), (cli?.stderr ?? '').trim());
  await fs.rm(path.dirname(jobFile), { recursive: true, force: true });

  if (realGs === undefined) delete process.env.HIG_GS; else process.env.HIG_GS = realGs;
}

const capability = await pressCapability();
if (!capability.press) {
  const why = capability.reason === 'too-old'
    ? `Ghostscript ${capability.version} is older than ${MIN_GS_VERSION}`
    : 'Ghostscript not found';
  console.log('\n— Conversion —');
  skip('convert an RGB PDF to DeviceCMYK', why);
  skip('PDF/X-4 output intent', why);
  console.log(`\npresstest: ${why} — conversion path SKIPPED.`);
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

console.log(`\n  Ghostscript: ${capability.gs} (${await ghostscriptVersion()})`);

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

// A conversion that dies should read as one FAIL line carrying Ghostscript's own words,
// not as a stack trace that takes the rest of the suite with it.
async function convert(out, icc) {
  try {
    const result = await convertToCmyk(rgbPdf, out, { icc });
    check(`${icc ? 'pdfx' : 'cmyk'}: Ghostscript completes the conversion`, true);
    return result;
  } catch (err) {
    check(`${icc ? 'pdfx' : 'cmyk'}: Ghostscript completes the conversion`, false, `\n${err.message}`);
    return null;
  }
}

console.log('\n— Conversion: plain CMYK (no ICC profile) —');
await (async () => {
  const out = path.join(workDir, 'presstest-plain-cmyk.pdf');
  const converted = await convert(out, null);
  if (!converted) return;
  const { pdfx, warnings } = converted;
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
  check('cmyk: no object in the file still declares an RGB colour space',
    deep.deviceCmyk > 0 && deep.rgbCarriers.length === 0,
    `cmyk=${deep.deviceCmyk}, rgb carriers: ${deep.rgbCarriers.join('; ') || 'none'}`);
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
})();

console.log('\n— Conversion: PDF/X-4 (with an ICC profile) —');
const icc = findIccProfile();
if (!icc) {
  skip('PDF/X-4 output intent', 'no ICC profile: set HIG_ICC_PROFILE or drop one at assets/icc/press.icc (see its README)');
} else {
  console.log(`  ICC: ${icc}`);
  const out = path.join(workDir, 'presstest-pdfx4.pdf');
  const converted = await convert(out, icc);
  if (converted) {
  const { pdfx, warnings } = converted;
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
  check('pdfx: no object in the file still declares an RGB colour space',
    deep.rgbCarriers.length === 0, deep.rgbCarriers.join('; '));
  check('pdfx: a real output intent means no degradation warning',
    pdfx === 'PDF/X-4' && warnings.length === 0, JSON.stringify(warnings));
  }
}

console.log('\n— Integration: a cmyk job through renderJob() —');
{
  const browser2 = await puppeteer.launch();
  let outputs;
  let warnings;
  try {
    ({ outputs, warnings } = await renderJob({
      ...posterSpec, name: 'presstest-cmyk', colorIntent: 'cmyk', outputs: ['pdf', 'png'],
    }, { browser: browser2, autoOpen: false }));
  } finally {
    await browser2.close();
  }

  const pdf = outputs.find((r) => r.format === 'pdf').path;
  const deep = await inspectPdfDeep(await fs.readFile(pdf));
  check('cmyk job: the PDF deliverable IS the converted file, converted in place',
    deep.deviceCmyk > 0 && deep.rgbCarriers.length === 0,
    `cmyk=${deep.deviceCmyk}, rgb carriers: ${deep.rgbCarriers.join('; ') || 'none'}`);

  const dir = path.dirname(pdf);
  const [deliverable, latest] = await Promise.all([fs.readFile(pdf), fs.readFile(path.join(dir, 'latest.pdf'))]);
  check('cmyk job: latest.pdf is the converted file, not the RGB original', deliverable.equals(latest));
  const strays = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  check('cmyk job: no RGB intermediate survives the render', strays.length === 0, strays.join(' '));

  check('cmyk job: the PNG is flagged as RGB rather than passed off as press output',
    warnings.some((w) => /the PNG is RGB/.test(w)), JSON.stringify(warnings));
  check(icc
    ? 'cmyk job: with a profile, no degradation warning'
    : 'cmyk job: without a profile, warnings[] says it is not PDF/X',
    icc ? !warnings.includes(NO_ICC_WARNING) : warnings.includes(NO_ICC_WARNING),
    JSON.stringify(warnings));
}

console.log(`\noutputs root: ${OUTPUTS_ROOT}`);
console.log('presstest: Ghostscript present — conversion path EXERCISED.');
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
