// The one-command app: `npm start` → free port → browser opens itself on a live preview.
//
// This is a thin layer over the same renderJob() the CLI calls. Nothing here is
// required to render — that's the point. The server just keeps one warm Chromium
// and hands the UI the same code path an LLM agent drives from the terminal.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import chokidar from 'chokidar';
import puppeteer from 'puppeteer';
import open from 'open';
import { renderJob, composeDocument, applyDefaults } from '../scripts/render.js';
import {
  PROJECT_ROOT, getOutputsRoot, outputDirFor, slugify, isInside, toOutputsUrlPath, fromOutputsUrlPath,
} from '../scripts/paths.js';
import { validateSpec } from '../scripts/validate.js';
import { listTemplates } from '../scripts/templates.js';
import { ensureThumbnails, THUMB_DIR } from '../scripts/thumbs.js';

const UI_DIR = path.join(PROJECT_ROOT, 'server', 'ui');
// Usually <project>/outputs; HIG_OUTPUTS_ROOT redirects it (the test suites point it
// at a temp dir). `/outputs/…` URLs are mounted on it wherever it lives.
const OUTPUTS_DIR = getOutputsRoot();

// The preview iframe can't POST, so the last previewed spec lives here and
// GET /preview composes from it. Single-user localhost app; one slot is enough.
let lastSpec = null;

const app = Fastify({ logger: false });

// One warm Chromium, and it is allowed to die. Before this, a crashed browser meant
// every subsequent render 400'd until the user restarted the app.
let browser = await puppeteer.launch();
let relaunching = null;
let shuttingDown = false;

async function getBrowser() {
  if (browser.connected) return browser;
  if (shuttingDown) throw new Error('server is shutting down');
  relaunching ??= puppeteer.launch()
    .then((b) => { browser = b; relaunching = null; return b; })
    .catch((err) => { relaunching = null; throw err; });
  return relaunching;
}

// A render that dies mid-flight because the browser went away is worth exactly one
// retry against a fresh one. A SpecError is the caller's fault; don't retry that.
async function renderWithRecovery(spec, autoOpen) {
  try {
    return await renderJob(spec, { browser: await getBrowser(), autoOpen });
  } catch (err) {
    if (err.name === 'SpecError' || browser.connected) throw err;
    console.warn('[render] shared Chromium died — relaunching and retrying once');
    return renderJob(spec, { browser: await getBrowser(), autoOpen });
  }
}

await app.register(fastifyWebsocket);

// ---- static mounts -------------------------------------------------------
await app.register(fastifyStatic, { root: UI_DIR });
for (const dir of ['templates', 'fonts', 'assets']) {
  await app.register(fastifyStatic, {
    root: path.join(PROJECT_ROOT, dir),
    prefix: `/${dir}/`,
    decorateReply: false,
  });
}
await fs.mkdir(OUTPUTS_DIR, { recursive: true });
await app.register(fastifyStatic, { root: OUTPUTS_DIR, prefix: '/outputs/', decorateReply: false });
// Paged.js polyfill, for the preview only.
await app.register(fastifyStatic, {
  root: path.join(PROJECT_ROOT, 'node_modules', 'pagedjs', 'dist'),
  prefix: '/node_modules/pagedjs/dist/',
  decorateReply: false,
});
await fs.mkdir(THUMB_DIR, { recursive: true });
await app.register(fastifyStatic, { root: THUMB_DIR, prefix: '/thumbs/', decorateReply: false });

// ---- api -----------------------------------------------------------------

app.get('/api/schema', async () => JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', 'schema.json'), 'utf8')));

// Each entry carries the template's declared config (paper, orientation, margin)
// and its {{placeholders}}, so the UI configures itself on selection.
app.get('/api/templates', async () => listTemplates());

// The same validator the CLI and renderJob() use. The UI never re-implements it.
app.post('/api/validate', async (req) => ({ errors: validateSpec(req.body) }));

// Only jobs the UI can actually load: a job pointing at a template that isn't in the
// gallery (a `_`-prefixed fixture, or one since deleted) leaves the form in a state
// the guard logic never anticipated.
app.get('/api/jobs', async () => {
  const dir = path.join(PROJECT_ROOT, 'jobs');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'schema.json').sort();
  const known = new Set((await listTemplates()).map((t) => t.file));
  const listable = await Promise.all(files.map(async (f) => {
    try {
      const spec = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      return known.has(spec.template) ? f : null;
    } catch { return null; }   // a malformed job shouldn't break the picker
  }));
  return listable.filter(Boolean);
});

app.get('/api/jobs/:name', async (req, reply) => {
  const name = path.basename(req.params.name); // no traversal out of jobs/
  try {
    return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', name), 'utf8'));
  } catch {
    return reply.code(404).send({ error: `no such job: ${name}` });
  }
});

app.post('/api/jobs', async (req, reply) => {
  const spec = req.body;
  const errors = validateSpec(spec);
  if (errors.length) return reply.code(400).send({ error: 'Invalid job spec', errors });
  // The name is free text and validates fine as `menu: spring` — but a colon is
  // illegal on NTFS. Slugify it, exactly as the output path does.
  const file = `${slugify(spec.name, 'name')}.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, 'jobs', file), `${JSON.stringify(spec, null, 2)}\n`);
  return { saved: `jobs/${file}`, file };
});

// Existing projects and doc types, so the UI's combo boxes know what already exists.
app.get('/api/projects', async () => {
  const out = {};
  let projects = [];
  try {
    projects = (await fs.readdir(OUTPUTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* outputs/ not created yet */ }
  for (const p of projects) {
    out[p] = (await fs.readdir(path.join(OUTPUTS_DIR, p), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  }
  return out;
});

app.get('/api/outputs', async () => {
  const rows = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (/\.(pdf|png)$/.test(e.name) && !e.name.startsWith('latest.')) {
        const st = await fs.stat(abs);
        rows.push({ path: toOutputsUrlPath(abs), size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  try { await walk(OUTPUTS_DIR); } catch { /* none yet */ }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, 50);
});

// Where would this spec land? Shown live under the render button, so the
// destination is never a surprise.
app.post('/api/resolve-path', async (req, reply) => {
  try {
    return { dir: `${toOutputsUrlPath(outputDirFor(req.body))}/` };
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

app.post('/api/preview', async (req, reply) => {
  try {
    lastSpec = applyDefaults(req.body);
  } catch (err) {
    return reply.code(400).send({ error: err.message, errors: err.errors ?? [] });
  }
  return { ok: true };
});

app.get('/preview', async (req, reply) => {
  if (!lastSpec) return reply.type('text/html').send('<p style="font:14px system-ui;padding:2rem;color:#666">No preview yet.</p>');
  try {
    // preview: discrete page boxes on screen even though the print path is native
    // Chromium @page, plus screen-only chrome.
    const { html } = await composeDocument(lastSpec, { preview: true });
    return reply.type('text/html').send(html);
  } catch (err) {
    return reply.type('text/html').send(`<pre style="font:13px ui-monospace;padding:2rem;color:#b00">${err.message}</pre>`);
  }
});

app.post('/api/render', async (req, reply) => {
  const { spec, autoOpen = true } = req.body;
  try {
    const { outputs, warnings } = await renderWithRecovery(spec, autoOpen);
    return {
      outputs: outputs.map((r) => ({ format: r.format, path: toOutputsUrlPath(r.path) })),
      warnings,
    };
  } catch (err) {
    // SpecError carries field-level errors; anything else is a genuine render failure.
    return reply.code(400).send({ error: err.message, errors: err.errors ?? [] });
  }
});

// Test-only: kill the shared Chromium so apptest can prove the server heals.
if (process.env.HIG_TEST === '1') {
  app.post('/api/_test/crash-browser', async () => {
    (await getBrowser()).process()?.kill('SIGKILL');
    return { killed: true };
  });
}

app.post('/api/reveal', async (req, reply) => {
  const target = fromOutputsUrlPath(req.body.path);
  if (!isInside(OUTPUTS_DIR, target)) return reply.code(403).send({ error: 'outside outputs/' });
  await open(path.dirname(target));
  return { ok: true };
});

// ---- hot reload ----------------------------------------------------------
const sockets = new Set();
app.get('/ws', { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
const broadcast = (msg) => { for (const s of sockets) { try { s.send(msg); } catch { /* closed */ } } };

chokidar
  .watch([path.join(PROJECT_ROOT, 'templates'), path.join(PROJECT_ROOT, 'jobs')], { ignoreInitial: true })
  .on('all', async (_event, file) => {
    broadcast(JSON.stringify({ type: 'reload', file: path.basename(file) }));
    // A changed template (or the example job that feeds it) means a stale thumbnail.
    // ensureThumbnails() is serialized, so this can't race the boot-time pass.
    const written = await ensureThumbnails(await getBrowser()).catch((err) => {
      console.warn(`[thumbs] ${err.message}`);
      return [];
    });
    if (written.length) broadcast(JSON.stringify({ type: 'thumbs' }));
  });

// ---- launch --------------------------------------------------------------
await app.listen({ port: 0, host: '127.0.0.1' });
const { port } = app.server.address();
const url = `http://127.0.0.1:${port}`;
console.log(`\n  HTML Image Generator  →  ${url}\n  Ctrl+C to stop.\n`);
if (!process.argv.includes('--no-open')) await open(url);

// Thumbnails render in the background — the UI must not wait on Chromium to boot.
ensureThumbnails(browser)
  .then((written) => { if (written.length) broadcast(JSON.stringify({ type: 'thumbs' })); })
  .catch((err) => console.warn(`[thumbs] ${err.message}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    shuttingDown = true;
    await browser.close().catch(() => {});
    await app.close();
    process.exit(0);
  });
}
