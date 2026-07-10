// Shared PDF inspection used by the test scripts.
//
// Font inspection is regex-based on purpose: Chromium (Skia) writes uncompressed
// font descriptors — no /ObjStm — so /BaseFont and /FontFile2 are readable directly.
// A six-letter `AAAAAA+` prefix on a BaseFont name marks a subsetted embedded font.

import { promises as fs } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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
