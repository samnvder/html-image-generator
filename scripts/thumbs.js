// Template thumbnails for the UI gallery.
//
// Rendered by the real engine at low DPI, using each template's own example job
// for content — so a thumbnail can never drift from what the template actually
// produces. Cached on disk and regenerated only when the template or its example
// job changes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';
import { renderPngBuffer } from './render.js';
import { listTemplates, TEMPLATE_DIR } from './templates.js';

export const THUMB_DIR = path.join(PROJECT_ROOT, 'server', '.thumbs');
const JOBS_DIR = path.join(PROJECT_ROOT, 'jobs');
const THUMB_DPI = 48; // Letter -> 408x528 px

const mtime = async (file) => fs.stat(file).then((s) => s.mtimeMs, () => 0);

// The example job that showcases a template, if one exists.
async function exampleJobFor(templateFile) {
  const files = (await fs.readdir(JOBS_DIR)).filter((f) => f.endsWith('.json') && f !== 'schema.json');
  for (const f of files) {
    try {
      const spec = JSON.parse(await fs.readFile(path.join(JOBS_DIR, f), 'utf8'));
      if (spec.template === templateFile) return { spec, file: path.join(JOBS_DIR, f) };
    } catch { /* a malformed job shouldn't break the gallery */ }
  }
  return null;
}

function thumbSpec(template, example) {
  const c = template.config;
  const base = example?.spec ?? {};
  return {
    name: 'thumb',
    project: 'thumbs',
    docType: 'thumb',
    template: template.file,
    paperSize: base.paperSize ?? c.paperSize ?? 'letter',
    orientation: base.orientation ?? c.orientation ?? 'portrait',
    margin: base.margin ?? c.margin ?? '0.5in',
    content: base.content ?? {},
    imageSlots: base.imageSlots ?? {},
    // No `outputs`: renderPngBuffer never reads it, and claiming ["png"] would trip
    // the validator's pdfOnly rule on legal-form. A thumbnail is a page-1 preview of
    // the template, not a deliverable the spec is asking for.
  };
}

async function generate(browser, force) {
  await fs.mkdir(THUMB_DIR, { recursive: true });
  const templates = await listTemplates();
  const written = [];

  for (const t of templates) {
    const out = path.join(THUMB_DIR, `${t.file.replace(/\.html$/, '')}.png`);
    const example = await exampleJobFor(t.file);

    if (!force) {
      const [thumbAt, tplAt, jobAt] = await Promise.all([
        mtime(out), mtime(path.join(TEMPLATE_DIR, t.file)), example ? mtime(example.file) : 0,
      ]);
      if (thumbAt && thumbAt > tplAt && thumbAt > jobAt) continue;
    }

    try {
      const png = await renderPngBuffer(thumbSpec(t, example), browser, { dpi: THUMB_DPI });
      // Write-then-rename: a reader never sees a half-written PNG, and on Windows
      // two overlapping writers can't collide on the same open handle.
      const tmp = `${out}.${process.pid}.tmp`;
      await fs.writeFile(tmp, png);
      await fs.rename(tmp, out);
      written.push(path.basename(out));
    } catch (err) {
      // A broken template must not take the app down; the card shows no image and
      // the reason is logged.
      console.warn(`[thumbs] ${t.file}: ${err.message.split('\n')[0]}`);
    }
  }
  return written;
}

// Boot generation and the file-watcher's regeneration can otherwise overlap —
// a template edited while the first pass is still running had both writing the
// same file, which intermittently left the gallery with no thumbnails at all.
let queue = Promise.resolve([]);

/** Render any missing or stale thumbnails. Serialized. Returns the files it wrote. */
export function ensureThumbnails(browser, { force = false } = {}) {
  queue = queue.then(() => generate(browser, force), () => generate(browser, force));
  return queue;
}
