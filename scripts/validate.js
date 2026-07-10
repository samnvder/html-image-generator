// One validator, three callers: the CLI, the HTTP API, and the UI (via /api/validate).
// renderJob() runs it before touching Chromium, so no caller can skip it.
//
// Returns [] when valid, else [{ field, message }] — field-level so the UI can put
// the error under the input that caused it.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { PAPER_SIZES, PROJECT_ROOT, slugify } from './paths.js';

const ALLOWED = new Set([
  '$schema', 'name', 'project', 'docType', 'paperSize', 'orientation', 'outputs',
  'dpi', 'colorIntent', 'margin', 'bleed', 'cropMarks', 'template', 'content',
  'fonts', 'imageSlots', 'variants',
]);

const ORIENTATIONS = ['portrait', 'landscape'];
const FORMATS = ['pdf', 'png'];
const COLOR_INTENTS = ['rgb', 'cmyk'];

// A CSS length: `0`, or a number with a unit. Up to four, as in `1in 0.75in`.
const LENGTH = /^(0|\d*\.?\d+(px|pt|pc|in|cm|mm|q|em|rem))$/i;

export function isCssLength(value) {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split(/\s+/);
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => LENGTH.test(p));
}

const list = (arr) => arr.map((v) => `"${v}"`).join(', ');

export function validateSpec(rawSpec) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });

  if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
    return [{ field: '', message: 'Job spec must be an object' }];
  }
  const spec = rawSpec;

  // Typo protection: a misspelled key must error, not silently take the default.
  for (const key of Object.keys(spec)) {
    if (!ALLOWED.has(key)) bad(key, `Unknown field "${key}". Allowed: ${[...ALLOWED].filter((k) => k !== '$schema').join(', ')}`);
  }

  for (const field of ['name', 'project', 'docType']) {
    if (spec[field] === undefined) { bad(field, `${field} is required`); continue; }
    try {
      slugify(spec[field], field);
    } catch (err) {
      bad(field, err.message);
    }
  }

  // Paper size is the one variable that is never inferred. See GUARD.md.
  if (spec.paperSize === undefined) bad('paperSize', 'paperSize is required and must be explicitly chosen — never defaulted');
  else if (!PAPER_SIZES[spec.paperSize]) bad('paperSize', `paperSize must be one of ${list(Object.keys(PAPER_SIZES))} — got "${spec.paperSize}"`);

  if (spec.orientation !== undefined && !ORIENTATIONS.includes(spec.orientation)) {
    bad('orientation', `orientation must be one of ${list(ORIENTATIONS)} — got "${spec.orientation}"`);
  }

  if (spec.outputs !== undefined) {
    if (!Array.isArray(spec.outputs) || spec.outputs.length === 0) bad('outputs', 'outputs must be a non-empty array');
    else {
      const unknown = spec.outputs.filter((o) => !FORMATS.includes(o));
      if (unknown.length) bad('outputs', `outputs may only contain ${list(FORMATS)} — got ${list(unknown)}`);
      if (new Set(spec.outputs).size !== spec.outputs.length) bad('outputs', 'outputs must not repeat a format');
    }
  }

  if (spec.dpi !== undefined) {
    if (!Number.isInteger(spec.dpi) || spec.dpi < 72 || spec.dpi > 1200) {
      bad('dpi', `dpi must be a whole number between 72 and 1200 — got ${JSON.stringify(spec.dpi)}`);
    }
  }

  if (spec.colorIntent !== undefined && !COLOR_INTENTS.includes(spec.colorIntent)) {
    bad('colorIntent', `colorIntent must be one of ${list(COLOR_INTENTS)} — got "${spec.colorIntent}"`);
  }

  for (const field of ['margin', 'bleed']) {
    if (spec[field] === undefined) continue;
    if (!isCssLength(spec[field])) {
      bad(field, `${field} must be a CSS length like "0", "0.5in", or "1in 0.75in" — got ${JSON.stringify(spec[field])}`);
    }
  }

  if (spec.cropMarks !== undefined && typeof spec.cropMarks !== 'boolean') {
    bad('cropMarks', `cropMarks must be true or false — got ${JSON.stringify(spec.cropMarks)}`);
  }

  if (spec.template === undefined) bad('template', 'template is required');
  else if (typeof spec.template !== 'string') bad('template', 'template must be a filename');
  else {
    // Must resolve inside templates/ — the name comes from user input.
    const dir = path.join(PROJECT_ROOT, 'templates');
    const abs = path.resolve(dir, spec.template);
    if (!abs.startsWith(dir)) bad('template', `template "${spec.template}" escapes templates/`);
    else if (!existsSync(abs)) bad('template', `template "${spec.template}" does not exist in templates/`);
  }

  if (spec.content !== undefined) {
    if (typeof spec.content !== 'object' || spec.content === null || Array.isArray(spec.content)) {
      bad('content', 'content must be an object of string values');
    } else {
      for (const [k, v] of Object.entries(spec.content)) {
        if (typeof v !== 'string') bad(`content.${k}`, `content.${k} must be a string — got ${typeof v}`);
      }
    }
  }

  if (spec.imageSlots !== undefined) {
    if (typeof spec.imageSlots !== 'object' || spec.imageSlots === null || Array.isArray(spec.imageSlots)) {
      bad('imageSlots', 'imageSlots must be an object mapping slot name to image path');
    } else {
      for (const [slot, src] of Object.entries(spec.imageSlots)) {
        if (typeof src !== 'string' || src === '') { bad(`imageSlots.${slot}`, `imageSlots.${slot} must be a non-empty path`); continue; }
        if (/^(https?:)?\/\//.test(src)) continue;   // remote images are the caller's problem
        const abs = path.resolve(PROJECT_ROOT, src.replace(/^\/+/, ''));
        if (!abs.startsWith(PROJECT_ROOT)) bad(`imageSlots.${slot}`, `imageSlots.${slot} escapes the project directory`);
        else if (!existsSync(abs)) bad(`imageSlots.${slot}`, `image "${src}" does not exist`);
      }
    }
  }

  if (spec.fonts !== undefined && (!Array.isArray(spec.fonts) || spec.fonts.some((f) => typeof f !== 'string'))) {
    bad('fonts', 'fonts must be an array of family names');
  }

  if (spec.variants !== undefined) {
    if (!Array.isArray(spec.variants)) bad('variants', 'variants must be an array');
    else spec.variants.forEach((v, i) => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(`variants[${i}]`, `variants[${i}] must be an object of overrides`);
    });
  }

  return errors;
}

export class SpecError extends Error {
  constructor(errors) {
    super(`Invalid job spec:\n${errors.map((e) => `  - ${e.field ? `${e.field}: ` : ''}${e.message}`).join('\n')}`);
    this.name = 'SpecError';
    this.errors = errors;
  }
}

export function assertValidSpec(spec) {
  const errors = validateSpec(spec);
  if (errors.length) throw new SpecError(errors);
  return spec;
}
