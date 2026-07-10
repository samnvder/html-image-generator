// Shared PDF inspection used by the test scripts.
//
// Font inspection is regex-based on purpose: Chromium (Skia) writes uncompressed
// font descriptors — no /ObjStm — so /BaseFont and /FontFile2 are readable directly.
// A six-letter `AAAAAA+` prefix on a BaseFont name marks a subsetted embedded font.

import { promises as fs } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';

export async function pdfInfo(file) {
  const task = getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true });
  const doc = await task.promise;
  const [x0, y0, x1, y1] = (await doc.getPage(1)).view;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    text += `${(await (await doc.getPage(i)).getTextContent()).items.map((it) => it.str).join(' ')} `;
  }
  // Read the Info dict through pdf.js, not a regex: pdf-lib writes /Author as a
  // UTF-16BE hex string (`/Author <FEFF0053…>`), so a `/Author \((.*)\)` match would
  // report a false failure. Chromium writes /Title as a literal. Both decode here.
  const { info } = await doc.getMetadata();
  const out = { pages: doc.numPages, width: x1 - x0, height: y1 - y0, text, info };
  await task.destroy();
  return out;
}

export function inspectFonts(buf) {
  const s = buf.toString('latin1');
  const names = [...s.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#-]+)/g)].map((m) => m[1]);
  return {
    fonts: [...new Set(names)],
    embedded: (s.match(/\/FontFile[23]?/g) ?? []).length,
    objStreams: (s.match(/\/ObjStm/g) ?? []).length,
  };
}

export const isSubsetted = (name) => Boolean(name && /^[A-Z]{6}\+/.test(name));

// Everything the regex above cannot see.
//
// Chromium writes no object streams, which is why `inspectFonts()` works at all. A
// Ghostscript PDF/X-4 conversion is PDF 1.6, where Ghostscript DOES write them, and the
// font descriptors vanish inside an /ObjStm. pdf-lib decodes object streams, so this
// walks the real object graph instead of the bytes.
//
// Also returns the structures that make a PDF/X claim true or false: the output intent,
// the ICC profile it points at, the XMP identification, and page 1's TrimBox.
export async function inspectPdfDeep(buf) {
  const doc = await PDFDocument.load(buf, { updateMetadata: false, throwOnInvalidObject: false });

  const fonts = new Set();
  let embedded = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    // Not `obj.dict ?? obj`: a PDFDict's own `.dict` is its internal Map, so that
    // spelling silently skips every dictionary in the file.
    const dict = obj instanceof PDFStream ? obj.dict : obj;
    if (!(dict instanceof PDFDict)) continue;
    const base = dict.get(PDFName.of('BaseFont'));
    if (base) fonts.add(String(base).replace(/^\//, ''));
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      if (dict.get(PDFName.of(key))) embedded++;
    }
  }

  let outputIntent = null;
  const intents = doc.catalog.lookupMaybe(PDFName.of('OutputIntents'), PDFArray);
  if (intents && intents.size() > 0) {
    const first = intents.lookup(0, PDFDict);
    const profile = first.lookup(PDFName.of('DestOutputProfile'));
    outputIntent = {
      subtype: String(first.get(PDFName.of('S')) ?? ''),
      identifier: String(first.lookup(PDFName.of('OutputConditionIdentifier')) ?? ''),
      // /N is the profile's component count. A press intent must be four-channel.
      destOutputProfileN: profile ? Number(profile.dict?.get(PDFName.of('N'))?.asNumber?.() ?? NaN) : null,
    };
  }

  let xmp = '';
  const meta = doc.catalog.lookup(PDFName.of('Metadata'));
  if (meta?.contents) xmp = Buffer.from(meta.contents).toString('utf8');

  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  const raw = buf.toString('latin1');

  return {
    version: raw.slice(0, 8),                              // "%PDF-1.4"
    fonts: [...fonts],
    embedded,
    objStreams: (raw.match(/\/ObjStm/g) ?? []).length,
    outputIntent,
    xmp,
    // PDF/X wants a TrimBox on every page and /Trapped set to True or False.
    trimBoxOnEveryPage: doc.getPages().every((p) => Boolean(p.node.get(PDFName.of('TrimBox')))),
    trapped: String(info?.get(PDFName.of('Trapped')) ?? ''),
    encrypted: Boolean(doc.context.trailerInfo.Encrypt),
    deviceRgb: (raw.match(/\/DeviceRGB/g) ?? []).length,
    deviceCmyk: (raw.match(/\/DeviceCMYK/g) ?? []).length,
  };
}
