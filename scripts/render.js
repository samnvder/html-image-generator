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
import {
  PAPER_SIZES, PROJECT_ROOT, resolveOutputPath, writeLatest,
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

// opts.preview — the live preview always runs the polyfill, because it needs
// discrete page boxes on screen even when the print path is native. It also gets
// screen-only chrome (a backdrop and a drop shadow) that never touches a render.
export async function composeDocument(spec, opts = {}) {
  const templatePath = path.join(PROJECT_ROOT, 'templates', spec.template);
  let html = await fs.readFile(templatePath, 'utf8');

  const values = { ...spec.content };
  for (const [slot, src] of Object.entries(spec.imageSlots)) values[`image:${slot}`] = src;
  html = html.replace(/\{\{([\w:.-]+)\}\}/g, (m, key) => (key in values ? values[key] : m));

  const leftover = [...html.matchAll(/\{\{([\w:.-]+)\}\}/g)].map((m) => m[1]);
  if (leftover.length) {
    console.warn(`[render] unfilled placeholders left in document: ${[...new Set(leftover)].join(', ')}`);
  }

  const dims = pageDims(spec);
  const paged = opts.preview || needsPagedJs(spec);
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
  const previewChrome = opts.preview
    ? `
<style id="__preview-chrome">
  body { background: #8b8e94; }
  .pagedjs_page { background: #fff; box-shadow: 0 3px 18px rgba(0,0,0,0.28); margin: 0 auto 24px; }
</style>`
    : '';

  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${setup}${previewChrome}${pagedScripts}\n</head>`);
  } else {
    html = setup + previewChrome + pagedScripts + html;
  }
  return { html, paged };
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
      if (!abs.startsWith(PROJECT_ROOT)) {
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

async function renderPdf(page, url, paged) {
  await page.goto(url, { waitUntil: 'networkidle0' });
  if (paged) {
    await page.waitForFunction('window.__pagedDone === true', { timeout: 30_000 });
  }
  await page.evaluateHandle('document.fonts.ready');
  return page.pdf({ preferCSSPageSize: true, printBackground: true });
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

export async function renderJob(rawSpec, opts = {}) {
  const spec = applyDefaults(rawSpec);
  const when = opts.when ?? new Date();
  const ownBrowser = !opts.browser;
  const browser = opts.browser ?? await puppeteer.launch();
  const results = [];

  try {
    // A variant's overrides can be just as wrong as a base spec's. Validate each.
    const runs = [spec, ...spec.variants.map((v) => assertValidSpec({ ...spec, ...v, variants: [] }))];
    for (const run of runs) {
      const { html, paged } = await composeDocument(run);
      const doc = await serveDocument(html);
      try {
        if (run.outputs.includes('pdf')) {
          const page = await browser.newPage();
          const pdf = await renderPdf(page, doc.url, paged);
          await page.close();
          const out = await resolveOutputPath(run, 'pdf', when);
          await fs.writeFile(out, pdf);
          await writeLatest(out);
          results.push({ format: 'pdf', path: out });
        }
        if (run.outputs.includes('png')) {
          // Screen render — Paged.js and @page margins don't apply; templates size
          // themselves with --page-width/--page-height/--page-margin.
          const page = await browser.newPage();
          const png = await renderPng(page, doc.url, run);
          await page.close();
          const out = await resolveOutputPath(run, 'png', when);
          await fs.writeFile(out, png);
          await writeLatest(out);
          results.push({ format: 'png', path: out });
        }
      } finally {
        await doc.close();
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
  return results;
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
  const results = await renderJob(spec, { autoOpen: !noOpen });
  for (const r of results) console.log(`${r.format.toUpperCase()}  ${path.relative(process.cwd(), r.path)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
