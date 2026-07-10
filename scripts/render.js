// Core render engine — CLI-first, UI-second.
//   node scripts/render.js jobs/<spec>.json [--no-open]
//
// One entry point, two render paths:
//   - Native (default): plain Chromium @page CSS via page.pdf({ preferCSSPageSize: true }).
//   - Paged.js (conditional): only when the spec asks for bleed/crop marks — no browser
//     supports the @page bleed/marks descriptors natively.
//
// The document is always served over a throwaway local HTTP server (Paged.js refuses
// file://; using HTTP unconditionally keeps both paths identical).
//
// PDF is the authoritative print output. PNG is a convenience raster:
// deviceScaleFactor = dpi/96, then sharp stamps the pHYs chunk (Chromium writes none).

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import {
  PAPER_SIZES, PROJECT_ROOT, isInside, outputKey, resolveOutputPath, writeLatest,
} from './paths.js';
import { assertValidSpec } from './validate.js';

const DEFAULTS = {
  orientation: 'portrait',
  outputs: ['pdf'],
  dpi: 300,
  colorIntent: 'rgb',
  margin: '0.5in',
  bleed: '0',
  cropMarks: false,
  content: {},
  imageSlots: {},
  variants: [],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
};

// Validate before defaults, so a typo'd key ("paperSze") errors instead of
// silently taking a default. Every caller — CLI, API, UI — comes through here.
export function applyDefaults(spec) {
  assertValidSpec(spec);
  const { $schema, ...clean } = spec;
  return { ...DEFAULTS, ...clean };
}

export function pageDims(spec) {
  const { widthIn, heightIn } = PAPER_SIZES[spec.paperSize];
  const [w, h] = spec.orientation === 'landscape' ? [heightIn, widthIn] : [widthIn, heightIn];
  return { widthIn: w, heightIn: h, widthPx: Math.round(w * 96), heightPx: Math.round(h * 96) };
}

function needsPagedJs(spec) {
  return spec.cropMarks || (spec.bleed && spec.bleed !== '0' && spec.bleed !== '0in');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// {{{key}}} before {{key}}, in one pass — a raw value that happens to contain
// "{{" must not be re-substituted by a second sweep.
const PLACEHOLDER = /\{\{\{([\w:.-]+)\}\}\}|\{\{([\w:.-]+)\}\}/g;

// Content is text, not markup. `use <Enter> to submit` must survive to the page as
// those exact characters, and a stray `<b>` must never become an element. Templates
// that genuinely want markup from a value ask for it with {{{key}}}.
// Escaping is attribute-safe, so {{image:slot}} inside src="…" keeps working.
export function substitutePlaceholders(html, values) {
  const unfilled = new Set();
  const out = html.replace(PLACEHOLDER, (match, rawKey, escKey) => {
    const key = rawKey ?? escKey;
    if (!(key in values)) { unfilled.add(key); return match; }
    return rawKey !== undefined ? values[key] : escapeHtml(values[key]);
  });
  return { html: out, unfilled: [...unfilled] };
}

// opts.preview — the live preview always runs the polyfill, because it needs
// discrete page boxes on screen even when the print path is native. It also gets
// screen-only chrome (a backdrop and a drop shadow) that never touches a render.
//
// opts.screen — never run the polyfill, whatever the spec says. The PNG is a
// trim-size screen render: bleed and crop marks are print concepts, and letting
// Paged.js restructure the DOM shifts the content by the bleed offset and leaves a
// sliver of the sheet edge in the shot.
export async function composeDocument(spec, opts = {}) {
  const templatePath = path.join(PROJECT_ROOT, 'templates', spec.template);
  const source = await fs.readFile(templatePath, 'utf8');

  const values = { ...spec.content };
  for (const [slot, src] of Object.entries(spec.imageSlots)) values[`image:${slot}`] = src;
  let { html, unfilled } = substitutePlaceholders(source, values);

  const dims = pageDims(spec);
  const paged = opts.preview || (!opts.screen && needsPagedJs(spec));
  const pagedCss = paged
    ? `bleed: ${spec.bleed === '0' ? '0in' : spec.bleed};${spec.cropMarks ? ' marks: crop;' : ''}`
    : '';
  const setup = `
<style id="__print-setup">
  @page {
    size: ${spec.paperSize} ${spec.orientation};
    margin: ${spec.margin};
    ${pagedCss}
  }
  :root {
    --page-width: ${dims.widthIn}in;
    --page-height: ${dims.heightIn}in;
    --page-margin: ${spec.margin};
  }
  html, body { margin: 0; padding: 0; }
</style>`;
  const pagedScripts = paged
    ? `
<script>window.PagedConfig = { auto: true, after: () => { window.__pagedDone = true; } };</script>
<script src="/node_modules/pagedjs/dist/paged.polyfill.js"></script>`
    : '';

  // Screen-only. Never present in a rendered PDF or PNG.
  // The backdrop stays transparent so the app's stage colour shows through —
  // a hardcoded grey here clashes with the UI's dark theme.
  const previewChrome = opts.preview
    ? `
<style id="__preview-chrome">
  html, body { background: transparent; }
  /* The host sizes the iframe to the content, so the iframe's own scrollbar is
     never needed — and with a transparent body it renders as a stray sliver. */
  html { scrollbar-width: none; }
  html::-webkit-scrollbar { display: none; }
  .pagedjs_page { background: #fff; box-shadow: 0 3px 18px rgba(0,0,0,0.35); margin: 0 auto 24px; }
</style>`
    : '';

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${setup}${previewChrome}${pagedScripts}\n</head>`);
  } else {
    html = setup + previewChrome + pagedScripts + html;
  }
  return { html, paged, unfilled };
}

// Throwaway static server rooted at the project dir, with the composed document at /__doc__.html
function serveDocument(html) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/__doc__.html') {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
        return;
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const abs = path.resolve(PROJECT_ROOT, rel);
      if (!isInside(PROJECT_ROOT, abs)) {
        res.writeHead(403).end();
        return;
      }
      const data = await fs.readFile(abs);
      res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/__doc__.html`,
        // Chromium holds keep-alive sockets open after the page closes, and a bare
        // server.close() waits on them forever. Kill the connections outright —
        // the render is finished by the time we get here.
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(r);
        }),
      });
    });
  });
}

// Chromium writes /Title from <title> and tags the PDF (StructTreeRoot), but exposes
// no way to set Author/Subject/Creator. pdf-lib stamps them after the fact.
//
// useObjectStreams MUST stay false: pdf-lib defaults to true, and an /ObjStm would
// compress the font descriptors that pdfinfo.js inspects by regex — the very property
// that makes Chromium's PDFs checkable.
async function stampMetadata(pdfBuffer, spec) {
  const doc = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  doc.setAuthor(spec.project);
  doc.setSubject(spec.docType);
  doc.setCreator('HTML Image Generator');
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function renderPdf(page, url, paged, spec) {
  await page.goto(url, { waitUntil: 'networkidle0' });
  if (paged) {
    await page.waitForFunction('window.__pagedDone === true', { timeout: 30_000 });
  }
  await page.evaluateHandle('document.fonts.ready');
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  return stampMetadata(pdf, spec);
}

async function renderPng(page, url, spec) {
  const dims = pageDims(spec);
  await page.setViewport({
    width: dims.widthPx,
    height: dims.heightPx,
    deviceScaleFactor: spec.dpi / 96,
  });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.evaluateHandle('document.fonts.ready');
  const shot = await page.screenshot({ type: 'png' });
  return sharp(shot).withMetadata({ density: spec.dpi }).png().toBuffer();
}

// A PNG of the first page, straight to a buffer — nothing touches outputs/.
// Used for the UI's template thumbnails, so they are the real renderer's output
// rather than a hand-drawn approximation that can drift from reality.
export async function renderPngBuffer(rawSpec, browser, { dpi = 48 } = {}) {
  const spec = { ...applyDefaults(rawSpec), dpi };
  const { html } = await composeDocument(spec, { screen: true });
  const doc = await serveDocument(html);
  try {
    const page = await browser.newPage();
    try {
      return await renderPng(page, doc.url, spec);
    } finally {
      await page.close();
    }
  } finally {
    await doc.close();
  }
}

// Serve one composition, hand its URL to fn, then tear the server down.
async function withDocument(html, fn) {
  const doc = await serveDocument(html);
  try {
    return await fn(doc.url);
  } finally {
    await doc.close();
  }
}

// Returns { outputs: [{format, path}], warnings: [string] }.
//
// Unfilled {{placeholders}} used to log to the *server's* console and nowhere else:
// the UI user and the API caller shipped a document with holes in it and were never
// told. Warnings now travel back to whoever asked for the render.
export async function renderJob(rawSpec, opts = {}) {
  const spec = applyDefaults(rawSpec);
  const when = opts.when ?? new Date();
  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? await puppeteer.launch();
  const results = [];
  const warnings = new Set();

  const noteUnfilled = (run, unfilled) => {
    if (!unfilled.length) return;
    // Both compositions of one run report the same holes; a Set collapses them.
    warnings.add(`${run.name}: unfilled placeholder${unfilled.length > 1 ? 's' : ''} ${unfilled.join(', ')}`);
  };

  try {
    // A variant's overrides can be just as wrong as a base spec's. Validate each.
    const runs = [spec, ...spec.variants.map((v) => assertValidSpec({ ...spec, ...v, variants: [] }))];

    // A variant that overrides only `content` keeps the base name, and all runs share
    // one timestamp — so the second write silently replaced the first. Number the
    // repeats instead: base, base--v2, base--v3.
    const runsPerKey = new Map();
    const suffixFor = (run) => {
      const key = outputKey(run);
      const n = (runsPerKey.get(key) ?? 0) + 1;
      runsPerKey.set(key, n);
      return n === 1 ? '' : `--v${n}`;
    };

    for (const run of runs) {
      const suffix = suffixFor(run);
      // The two outputs are two different documents whenever the job asks for bleed
      // or crop marks: the PDF gets the Paged.js composition, the PNG never does.
      if (run.outputs.includes('pdf')) {
        const { html, paged, unfilled } = await composeDocument(run);
        noteUnfilled(run, unfilled);
        const pdf = await withDocument(html, async (url) => {
          const page = await browser.newPage();
          try { return await renderPdf(page, url, paged, run); } finally { await page.close(); }
        });
        const out = await resolveOutputPath(run, 'pdf', when, suffix);
        await fs.writeFile(out, pdf);
        await writeLatest(out);
        results.push({ format: 'pdf', path: out });
      }
      if (run.outputs.includes('png')) {
        // Screen render — no polyfill, no @page. Templates size themselves with
        // --page-width/--page-height/--page-margin.
        const { html, unfilled } = await composeDocument(run, { screen: true });
        noteUnfilled(run, unfilled);
        const png = await withDocument(html, async (url) => {
          const page = await browser.newPage();
          try { return await renderPng(page, url, run); } finally { await page.close(); }
        });
        const out = await resolveOutputPath(run, 'png', when, suffix);
        await fs.writeFile(out, png);
        await writeLatest(out);
        results.push({ format: 'png', path: out });
      }
    }
  } finally {
    if (ownBrowser) await browser.close();
  }

  // Auto-open the primary output (PDF first), unless suppressed or a batch run.
  const isBatch = spec.variants.length > 0;
  if (opts.autoOpen !== false && !isBatch && results.length) {
    const primary = results.find((r) => r.format === 'pdf') ?? results[0];
    const { default: open } = await import('open');
    await open(primary.path);
  }
  return { outputs: results, warnings: [...warnings] };
}

async function main() {
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open');
  const specPath = args.find((a) => !a.startsWith('--'));
  if (!specPath) {
    console.error('Usage: node scripts/render.js jobs/<spec>.json [--no-open]');
    process.exit(1);
  }
  const spec = JSON.parse(await fs.readFile(path.resolve(specPath), 'utf8'));
  const { outputs, warnings } = await renderJob(spec, { autoOpen: !noOpen });
  for (const w of warnings) console.error(`[warning] ${w}`);
  for (const r of outputs) console.log(`${r.format.toUpperCase()}  ${path.relative(process.cwd(), r.path)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
