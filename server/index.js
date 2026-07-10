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
import { PROJECT_ROOT, OUTPUTS_ROOT, outputDirFor } from '../scripts/paths.js';

const UI_DIR = path.join(PROJECT_ROOT, 'server', 'ui');

// The preview iframe can't POST, so the last previewed spec lives here and
// GET /preview composes from it. Single-user localhost app; one slot is enough.
let lastSpec = null;

const app = Fastify({ logger: false });
const browser = await puppeteer.launch();

await app.register(fastifyWebsocket);

// ---- static mounts -------------------------------------------------------
await app.register(fastifyStatic, { root: UI_DIR });
for (const dir of ['templates', 'fonts', 'assets', 'outputs']) {
  await app.register(fastifyStatic, {
    root: path.join(PROJECT_ROOT, dir),
    prefix: `/${dir}/`,
    decorateReply: false,
  });
}
// Paged.js polyfill, for the preview only.
await app.register(fastifyStatic, {
  root: path.join(PROJECT_ROOT, 'node_modules', 'pagedjs', 'dist'),
  prefix: '/node_modules/pagedjs/dist/',
  decorateReply: false,
});

// ---- api -----------------------------------------------------------------

app.get('/api/schema', async () => JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', 'schema.json'), 'utf8')));

app.get('/api/templates', async () => {
  const files = await fs.readdir(path.join(PROJECT_ROOT, 'templates'));
  // `_`-prefixed templates are test fixtures, not authoring surface.
  return files.filter((f) => f.endsWith('.html') && !f.startsWith('_')).sort();
});

app.get('/api/jobs', async () => {
  const files = await fs.readdir(path.join(PROJECT_ROOT, 'jobs'));
  return files.filter((f) => f.endsWith('.json') && f !== 'schema.json').sort();
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
  try {
    applyDefaults(spec);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
  const file = `${path.basename(spec.name)}.json`;
  await fs.writeFile(path.join(PROJECT_ROOT, 'jobs', file), `${JSON.stringify(spec, null, 2)}\n`);
  return { saved: `jobs/${file}` };
});

// Existing projects and doc types, so the UI's combo boxes know what already exists.
app.get('/api/projects', async () => {
  const out = {};
  let projects = [];
  try {
    projects = (await fs.readdir(OUTPUTS_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* outputs/ not created yet */ }
  for (const p of projects) {
    out[p] = (await fs.readdir(path.join(OUTPUTS_ROOT, p), { withFileTypes: true }))
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
        rows.push({ path: path.relative(PROJECT_ROOT, abs).replaceAll('\\', '/'), size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  try { await walk(OUTPUTS_ROOT); } catch { /* none yet */ }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, 50);
});

// Where would this spec land? Shown live under the render button, so the
// destination is never a surprise.
app.post('/api/resolve-path', async (req, reply) => {
  try {
    return { dir: `${path.relative(PROJECT_ROOT, outputDirFor(req.body)).replaceAll('\\', '/')}/` };
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

app.post('/api/preview', async (req, reply) => {
  try {
    lastSpec = applyDefaults(req.body);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
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
    const results = await renderJob(spec, { browser, autoOpen });
    return results.map((r) => ({ format: r.format, path: path.relative(PROJECT_ROOT, r.path).replaceAll('\\', '/') }));
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

app.post('/api/reveal', async (req, reply) => {
  const target = path.resolve(PROJECT_ROOT, req.body.path);
  if (!target.startsWith(OUTPUTS_ROOT)) return reply.code(403).send({ error: 'outside outputs/' });
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
  .on('all', (_event, file) => broadcast(JSON.stringify({ type: 'reload', file: path.basename(file) })));

// ---- launch --------------------------------------------------------------
await app.listen({ port: 0, host: '127.0.0.1' });
const { port } = app.server.address();
const url = `http://127.0.0.1:${port}`;
console.log(`\n  HTML Image Generator  →  ${url}\n  Ctrl+C to stop.\n`);
if (!process.argv.includes('--no-open')) await open(url);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await browser.close().catch(() => {});
    await app.close();
    process.exit(0);
  });
}
