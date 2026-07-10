// The optional press pipeline: RGB PDF -> CMYK, and PDF/X-4 when an ICC profile is
// available. Ghostscript only. The core app never requires it.
//
// Everything here resolves its environment at CALL TIME, never at import time —
// the test suites set HIG_GS and HIG_ICC_PROFILE after this module has been imported
// (ESM hoists imports), exactly as they do with HIG_OUTPUTS_ROOT.
//
//   HIG_GS            explicit path to the binary; the literal "0" forces "absent"
//   HIG_ICC_PROFILE   explicit path to a CMYK ICC profile; "0" forces "none"
//
// Two facts, measured against Ghostscript 10.07.1 (see RESEARCH_REPORT §5):
//
//   1. `-dPDFX` (i.e. PDF/X-1a or X-3) clamps CompatibilityLevel to PDF 1.3, which has
//      no transparency. Any page with an rgba() colour or a gradient scrim — which is
//      most of what an HTML poster is — gets FLATTENED TO A BITMAP. The poster loses
//      all four embedded fonts and every extractable character. A press PDF whose text
//      is a 600-dpi raster is an A1-class bug shipped as a feature.
//   2. `-dPDFX=4` forces PDF 1.6, preserves live transparency, keeps the text vector,
//      and writes the XMP `pdfxid:GTS_PDFXVersion` that PDF/X-4 identification requires.
//
// So: PDF/X-4 is the level this tool claims, and only when a profile is present. The
// cost is that PDF 1.6 lets Ghostscript write object streams, so a converted PDF/X-4
// file is not regex-inspectable — use pdfinfo.js's `inspectFontsDeep()` on it.
//
// Without a profile there is no honest output intent to embed, so we do a plain CMYK
// conversion at PDF 1.4 (no object streams) and say so in warnings[]. We never stamp a
// PDF/X identifier onto a file that isn't one.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PROJECT_ROOT } from './paths.js';

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';
// On Windows the binary is gswin64c.exe, never `gs`. The unmaintained press-ready CLI
// trips on exactly this.
const GS_NAMES = IS_WINDOWS ? ['gswin64c.exe', 'gswin32c.exe'] : ['gs'];
const GS_PROGRAM_DIRS = ['C:\\Program Files\\gs', 'C:\\Program Files (x86)\\gs'];

export const PDFX_LEVEL = 'PDF/X-4';

export const NO_ICC_WARNING =
  'colorIntent "cmyk": converted to DeviceCMYK, but no ICC profile was found, so no '
  + 'output intent was embedded — this is a CMYK PDF, not PDF/X. See assets/icc/README.md.';

export function ghostscriptMissingMessage() {
  const hint = IS_WINDOWS
    ? 'install Ghostscript (https://ghostscript.com/releases/) — its binary is gswin64c.exe'
    : 'install Ghostscript (apt-get install ghostscript, brew install ghostscript)';
  return `colorIntent "cmyk" requires Ghostscript, which was not found: ${hint}, `
    + 'or point HIG_GS at the binary, or render with colorIntent "rgb".';
}

// Resolution order: HIG_GS, then PATH, then the Windows default install root.
export function findGhostscript() {
  const override = process.env.HIG_GS;
  if (override === '0') return null;                       // forced-absent, for tests
  if (override) return existsSync(override) ? override : null;

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of GS_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  if (IS_WINDOWS) {
    for (const base of GS_PROGRAM_DIRS) {
      let versions;
      try { versions = readdirSync(base).sort().reverse(); } catch { continue; }
      for (const v of versions) {
        for (const name of GS_NAMES) {
          const candidate = path.join(base, v, 'bin', name);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

export const isPressAvailable = () => findGhostscript() !== null;

// The ICC slot. assets/icc/ is gitignored except its README — no profile ships with
// this repo, because none of the US press profiles permit redistribution outright.
export function findIccProfile() {
  const override = process.env.HIG_ICC_PROFILE;
  if (override === '0') return null;                       // forced-none, for tests
  if (override) return existsSync(override) ? path.resolve(override) : null;
  const slot = path.join(PROJECT_ROOT, 'assets', 'icc', 'press.icc');
  return existsSync(slot) ? slot : null;
}

export async function ghostscriptVersion() {
  const gs = findGhostscript();
  if (!gs) return null;
  const { stdout } = await execFileAsync(gs, ['--version'], { timeout: 30_000 });
  return stdout.trim();
}

// PostScript string literals escape `(`, `)` and `\`. Ghostscript accepts forward
// slashes in paths on Windows, which sidesteps the backslash-as-escape trap entirely.
const psString = (s) => String(s).replaceAll('\\', '/').replace(/[()]/g, (c) => `\\${c}`);

// The pdfmark prologue that turns a plain CMYK conversion into PDF/X-4: it embeds the
// profile as the /DestOutputProfile of a /GTS_PDFX output intent and declares the
// version. Derived from Ghostscript's own lib/PDFX_def.ps, with the guesswork removed
// (we always convert to CMYK, so /N is always 4) and with /Title deliberately omitted —
// the stock template hardcodes `/Title (Title)`, which would clobber the title Chromium
// wrote from the document's <title>.
function pdfxDefPs(iccPath) {
  return `%!
% Generated by HTML Image Generator (scripts/press.js). Do not edit; it is a temp file.
[ /GTS_PDFXVersion (${PDFX_LEVEL})
  /Trapped /False                       % PDF/X requires True or False, never Unknown.
/DOCINFO pdfmark

/ICCProfile (${psString(iccPath)}) def

[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[{icc_PDFX} << /N 4 >> /PUT pdfmark      % DeviceCMYK: four components, always.
[{icc_PDFX} ICCProfile (r) file /PUT pdfmark

[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[{OutputIntent_PDFX} <<
  /Type /OutputIntent
  /S /GTS_PDFX
  /OutputCondition (Commercial and specialty printing)
  /OutputConditionIdentifier (Custom)
  /Info (${psString(path.basename(iccPath))})
  /RegistryName (http://www.color.org)
  /DestOutputProfile {icc_PDFX}
>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark
`;
}

// Flags mined from press-ready's src/ghostScript.ts (reference only — the package is
// unmaintained and hardcoded to Japan Color 2001 Coated). Deviations, all deliberate:
//   - CompatibilityLevel is pinned, not left to -dPDFSETTINGS: 1.4 for the plain path so
//     no object streams appear; 1.6 for X-4 because Ghostscript demands it there.
//   - -dPDFX=4 rather than press-ready's -dPDFX (which means X-3 and rasterizes text).
//   - --permit-file-read for the profile: SAFER has been the default since gs 9.50, and
//     without it the PDFX_def.ps `(profile) (r) file` call dies with /invalidfileaccess.
function gsArgs({ input, output, icc, defPs }) {
  const args = [
    '-dBATCH', '-dNOPAUSE', '-dNOOUTERSAVE', '-dPDFSTOPONERROR', '-dShowAnnots=false',
    '-sDEVICE=pdfwrite',
    '-dPDFSETTINGS=/prepress',
    '-dPrinted',
    '-r600', '-dColorImageResolution=600', '-dGrayImageResolution=600', '-dMonoImageResolution=600',
    '-sColorConversionStrategy=CMYK',
    '-sColorConversionStrategyForImages=CMYK',
    '-dProcessColorModel=/DeviceCMYK',
  ];
  if (icc) {
    args.unshift(`--permit-file-read=${icc}`);
    args.push('-dPDFX=4', '-dCompatibilityLevel=1.6', '-dOverrideICC', `-sOutputICCProfile=${icc}`);
  } else {
    args.push('-dCompatibilityLevel=1.4');
  }
  args.push(`-sOutputFile=${output}`);
  if (defPs) args.push(defPs);
  args.push(input);
  return args;
}

// Convert `pdfIn` to CMYK at `pdfOut`. Returns { pdfx, warnings }.
//
// `pdfOut` exists only if the conversion succeeded: Ghostscript happily leaves a
// truncated file behind when it errors out (a 1.4 KB stub, observed), and a partial
// PDF at the deliverable path is worse than no file at all.
export async function convertToCmyk(pdfIn, pdfOut, { icc = findIccProfile() } = {}) {
  const gs = findGhostscript();
  if (!gs) throw new Error(ghostscriptMissingMessage());

  const warnings = [];
  let workDir;
  let defPs;
  if (icc) {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hig-press-'));
    defPs = path.join(workDir, 'PDFX_def.ps');
    await fs.writeFile(defPs, pdfxDefPs(icc));
  } else {
    warnings.push(NO_ICC_WARNING);
  }

  try {
    await execFileAsync(gs, gsArgs({ input: pdfIn, output: pdfOut, icc, defPs }), {
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    await fs.rm(pdfOut, { force: true });
    const detail = String(err.stderr || err.stdout || err.message).trim().split('\n').slice(-4).join(' ');
    throw new Error(`Ghostscript failed to convert to CMYK: ${detail}`);
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  }

  return { pdfx: icc ? PDFX_LEVEL : null, warnings };
}
