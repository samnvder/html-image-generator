// Output routing: outputs/<project-slug>/<doctype-plural>/<job>--<paper>--<timestamp>.<ext>
// Folders are created recursively on demand — no config, no pre-registration.
// Slugification doubles as a security boundary: project/docType/name are free text
// that becomes a filesystem path, so traversal and Windows reserved names are rejected.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUTS_ROOT = path.join(PROJECT_ROOT, 'outputs');

// Inches; portrait. Points = inches * 72, CSS px = inches * 96.
export const PAPER_SIZES = {
  letter: { widthIn: 8.5, heightIn: 11 },
  legal: { widthIn: 8.5, heightIn: 14 },
};

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export function slugify(input, label = 'value') {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/[/\\]/.test(input) || input.includes('..')) {
    throw new Error(`${label} "${input}" contains path separators or traversal — rejected`);
  }
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    throw new Error(`${label} "${input}" slugifies to nothing — rejected`);
  }
  if (WINDOWS_RESERVED.has(slug)) {
    throw new Error(`${label} "${input}" is a Windows reserved name — rejected`);
  }
  return slug;
}

const PLURAL_MAP = {
  flyer: 'flyers',
  certificate: 'certificates',
  poster: 'posters',
  'legal-form': 'legal-forms',
  form: 'forms',
  menu: 'menus',
  letterhead: 'letterheads',
  invoice: 'invoices',
  notice: 'notices',
  sign: 'signs',
  card: 'cards',
  'business-card': 'business-cards',
  label: 'labels',
  brochure: 'brochures',
  handout: 'handouts',
};

const PLURAL_VALUES = new Set(Object.values(PLURAL_MAP));

// The raw rule: singular -> plural. Never call this directly; see pluralizeDocType.
function pluralizeSingular(slug) {
  if (PLURAL_MAP[slug]) return PLURAL_MAP[slug];
  if (/(s|x|z|ch|sh)$/.test(slug)) return `${slug}es`;
  if (/[^aeiou]y$/.test(slug)) return `${slug.slice(0, -1)}ies`;
  return `${slug}s`;
}

function singularizeGuess(slug) {
  if (/ies$/.test(slug)) return `${slug.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes)$/.test(slug)) return slug.slice(0, -2);
  if (/[^s]s$/.test(slug)) return slug.slice(0, -1);
  return slug;
}

// MUST be idempotent: the UI's doc-type combo is populated from existing
// outputs/<project>/* folder names, which are already plural. Re-pluralizing
// them produced `posters` -> `posterses`. So: if the input round-trips as a
// plural, it already is one and passes through unchanged.
export function pluralizeDocType(docTypeSlug) {
  if (PLURAL_VALUES.has(docTypeSlug)) return docTypeSlug;
  if (PLURAL_MAP[docTypeSlug]) return PLURAL_MAP[docTypeSlug];
  if (pluralizeSingular(singularizeGuess(docTypeSlug)) === docTypeSlug) return docTypeSlug;
  return pluralizeSingular(docTypeSlug);
}

export function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function outputDirFor(spec) {
  return path.join(OUTPUTS_ROOT, slugify(spec.project, 'project'), pluralizeDocType(slugify(spec.docType, 'docType')));
}

export async function resolveOutputPath(spec, ext, when = new Date()) {
  const dir = outputDirFor(spec);
  await fs.mkdir(dir, { recursive: true });
  const file = `${slugify(spec.name, 'name')}--${spec.paperSize}--${timestamp(when)}.${ext}`;
  return path.join(dir, file);
}

// Copy (not symlink — Windows) the newest render to latest.<ext> alongside it.
export async function writeLatest(outputPath) {
  const latest = path.join(path.dirname(outputPath), `latest${path.extname(outputPath)}`);
  await fs.copyFile(outputPath, latest);
  return latest;
}
