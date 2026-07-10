// One-shot dev utility: download the open-license fonts shipped with this project.
// Run once; the font files are then committed. Not part of the render path.
//   node scripts/fetch-fonts.js

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const FONT_DIR = path.join(PROJECT_ROOT, 'fonts');

// Google Fonts serves per-subset woff2. We only need latin.
async function latinWoff2(family, weight) {
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
  const css = await (await fetch(url, { headers: { 'user-agent': UA } })).text();
  // Blocks are preceded by a /* subset */ comment; take the one labelled exactly "latin".
  const blocks = css.split('/*').map((b) => `/*${b}`);
  const latin = blocks.find((b) => b.startsWith('/* latin */'));
  if (!latin) throw new Error(`no latin subset for ${family} ${weight}`);
  const m = latin.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!m) throw new Error(`no woff2 url for ${family} ${weight}`);
  return m[1];
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  console.log(`  ${path.basename(dest).padEnd(32)} ${(buf.length / 1024).toFixed(1)} KB`);
  return buf.length;
}

const WOFF2 = [
  ['Inter', 400, 'inter-400.woff2'],
  ['Inter', 700, 'inter-700.woff2'],
  ['Source Serif 4', 400, 'source-serif-400.woff2'],
  ['Source Serif 4', 700, 'source-serif-700.woff2'],
  ['Playfair Display', 700, 'playfair-display-700.woff2'],
];

// One static TTF, to settle open question #1 (WOFF2 vs TTF embedding in Chromium PDFs).
const TTF = [
  ['https://raw.githubusercontent.com/googlefonts/opensans/main/fonts/ttf/OpenSans-Regular.ttf', 'open-sans-400.ttf'],
];

// The SIL Open Font License requires its text to accompany the fonts wherever they
// are redistributed. Shipping the .woff2/.ttf without these files is a violation.
const LICENSES = [
  ['https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt', 'Inter-OFL.txt'],
  ['https://raw.githubusercontent.com/google/fonts/main/ofl/sourceserif4/OFL.txt', 'SourceSerif4-OFL.txt'],
  ['https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/OFL.txt', 'PlayfairDisplay-OFL.txt'],
  ['https://raw.githubusercontent.com/google/fonts/main/ofl/opensans/OFL.txt', 'OpenSans-OFL.txt'],
];

const LICENSE_DIR = path.join(FONT_DIR, 'licenses');
await fs.mkdir(LICENSE_DIR, { recursive: true });

console.log('fonts/');
for (const [family, weight, file] of WOFF2) {
  await download(await latinWoff2(family, weight), path.join(FONT_DIR, file));
}
for (const [url, file] of TTF) {
  await download(url, path.join(FONT_DIR, file));
}

console.log('fonts/licenses/');
for (const [url, file] of LICENSES) {
  await download(url, path.join(LICENSE_DIR, file));
}
