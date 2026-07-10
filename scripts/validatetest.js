// Phase 6A exit tests: routing is idempotent, and bad specs are rejected with
// field-level errors rather than silently rendering something wrong.
//
//   node scripts/validatetest.js

import { pluralizeDocType, outputDirFor } from './paths.js';
import { validateSpec, isCssLength } from './validate.js';
import { applyDefaults } from './render.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('— Routing: pluralize must be idempotent —');
// The UI populates its doc-type combo from existing outputs/*/<doctype> folder
// names, which are already plural. Feeding those back in produced "posterses".
const DOC_TYPES = [
  ['poster', 'posters'], ['posters', 'posters'],
  ['flyer', 'flyers'], ['flyers', 'flyers'],
  ['certificate', 'certificates'], ['certificates', 'certificates'],
  ['legal-form', 'legal-forms'], ['legal-forms', 'legal-forms'],
  ['test-sheet', 'test-sheets'], ['test-sheets', 'test-sheets'],
  ['registry', 'registries'], ['registries', 'registries'],
  ['wash', 'washes'], ['washes', 'washes'],
  ['boss', 'bosses'],
];
for (const [input, want] of DOC_TYPES) {
  check(`${input} -> ${want}`, pluralizeDocType(input) === want, pluralizeDocType(input));
}
for (const [input] of DOC_TYPES) {
  const once = pluralizeDocType(input);
  check(`idempotent: ${input}`, pluralizeDocType(once) === once, `${once} -> ${pluralizeDocType(once)}`);
}
check('the reported bug: posters never becomes posterses',
  !outputDirFor({ project: 'South End', docType: 'posters' }).includes('posterses'),
  outputDirFor({ project: 'South End', docType: 'posters' }));

console.log('— CSS lengths —');
for (const good of ['0', '0.5in', '.5in', '12mm', '1in 0.75in', '10pt 5pt 10pt 5pt', '2rem']) {
  check(`accepts ${JSON.stringify(good)}`, isCssLength(good));
}
for (const bad of ['abc', '-1in', '5', '0.5 in', '1in 2in 3in 4in 5in', '', 'in', '5furlongs']) {
  check(`rejects ${JSON.stringify(bad)}`, !isCssLength(bad));
}

console.log('— Spec validation —');
const base = {
  name: 'v', project: 'Demo', docType: 'probe',
  paperSize: 'letter', template: 'poster-letter.html',
};
check('a valid spec produces no errors', validateSpec(base).length === 0, JSON.stringify(validateSpec(base)));

const fieldOf = (spec) => validateSpec(spec).map((e) => e.field);
const cases = [
  ['missing paperSize', { ...base, paperSize: undefined }, 'paperSize'],
  ['bad paperSize', { ...base, paperSize: 'a4' }, 'paperSize'],
  ['bad orientation', { ...base, orientation: 'sideways' }, 'orientation'],
  ['bad margin', { ...base, margin: 'abc' }, 'margin'],
  ['negative margin', { ...base, margin: '-1in' }, 'margin'],
  ['unitless margin', { ...base, margin: '5' }, 'margin'],
  ['bad bleed', { ...base, bleed: 'lots' }, 'bleed'],
  ['dpi too low', { ...base, dpi: 10 }, 'dpi'],
  ['dpi too high', { ...base, dpi: 5000 }, 'dpi'],
  ['fractional dpi', { ...base, dpi: 300.5 }, 'dpi'],
  ['bad output format', { ...base, outputs: ['pdf', 'jpeg'] }, 'outputs'],
  ['empty outputs', { ...base, outputs: [] }, 'outputs'],
  ['bad colorIntent', { ...base, colorIntent: 'pantone' }, 'colorIntent'],
  ['cropMarks not boolean', { ...base, cropMarks: 'yes' }, 'cropMarks'],
  ['missing template', { ...base, template: undefined }, 'template'],
  ['nonexistent template', { ...base, template: 'nope.html' }, 'template'],
  ['template escapes templates/', { ...base, template: '../package.json' }, 'template'],
  ['typo in key name', { ...base, paperSze: 'letter' }, 'paperSze'],
  ['path traversal in project', { ...base, project: '../../etc' }, 'project'],
  ['windows reserved name', { ...base, project: 'CON' }, 'project'],
  ['nonexistent image slot', { ...base, imageSlots: { bg: '/assets/nope.png' } }, 'imageSlots.bg'],
  ['image slot escapes root', { ...base, imageSlots: { bg: '../../secrets.png' } }, 'imageSlots.bg'],
  ['non-string content value', { ...base, content: { title: 42 } }, 'content.title'],
  ['variants not objects', { ...base, variants: ['nope'] }, 'variants[0]'],
];
for (const [name, spec, wantField] of cases) {
  const fields = fieldOf(spec);
  check(`rejects: ${name}`, fields.includes(wantField), `errors on [${fields.join(', ')}], wanted "${wantField}"`);
}

check('a real image slot passes', validateSpec({ ...base, imageSlots: { bg: '/assets/placeholder-background.png' } }).length === 0);
check('$schema key is allowed', validateSpec({ ...base, $schema: './schema.json' }).length === 0);

console.log('— applyDefaults enforces validation —');
let threw = false;
try { applyDefaults({ ...base, margin: 'abc' }); } catch (err) {
  threw = err.name === 'SpecError' && Array.isArray(err.errors) && err.errors[0].field === 'margin';
}
check('applyDefaults throws SpecError with field-level errors', threw);

let typoThrew = false;
try { applyDefaults({ ...base, paperSze: 'legal' }); } catch { typoThrew = true; }
check('a typo\'d key throws instead of silently defaulting', typoThrew);

const defaulted = applyDefaults(base);
check('applyDefaults still fills defaults', defaulted.dpi === 300 && defaulted.orientation === 'portrait' && defaulted.margin === '0.5in');
check('applyDefaults strips $schema', applyDefaults({ ...base, $schema: 'x' }).$schema === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
