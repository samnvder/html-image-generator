// Templates declare what they were designed for, so the UI can configure itself
// instead of letting you render a landscape certificate on Legal portrait.
//
//   <meta name="template-config" content='{ "paperSize": "letter", ... }'>

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';

export const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates');

const CONFIG_RE = /<meta\s+name=["']template-config["']\s+content=(["'])([\s\S]*?)\1\s*\/?>/i;

const decodeEntities = (s) => s
  .replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function parseTemplateConfig(html, file = '') {
  const m = html.match(CONFIG_RE);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[2]));
  } catch (err) {
    throw new Error(`${file}: template-config is not valid JSON — ${err.message}`);
  }
}

export function placeholdersIn(html) {
  return [...new Set([...html.matchAll(/\{\{([\w:.-]+)\}\}/g)].map((m) => m[1]))];
}

// `_`-prefixed templates are test fixtures, not authoring surface.
export async function listTemplates() {
  const files = (await fs.readdir(TEMPLATE_DIR))
    .filter((f) => f.endsWith('.html') && !f.startsWith('_'))
    .sort();

  return Promise.all(files.map(async (file) => {
    const html = await fs.readFile(path.join(TEMPLATE_DIR, file), 'utf8');
    const config = parseTemplateConfig(html, file);
    return {
      file,
      title: config?.title ?? file.replace(/\.html$/, ''),
      description: config?.description ?? '',
      config: config ?? {},
      placeholders: placeholdersIn(html),
    };
  }));
}
