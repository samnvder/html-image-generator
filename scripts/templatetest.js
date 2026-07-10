// Phase 2 exit test: every reference template renders clean on its paper size.
//   node scripts/templatetest.js
//
// "Clean" = correct page box, expected page count, no unfilled {{placeholders}}
// surviving into the PDF text, and every declared font actually embedded.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { renderJob } from './render.js';
import { pdfInfo, inspectFonts } from './pdfinfo.js';
import { PROJECT_ROOT } from './paths.js';
import { listTemplates } from './templates.js';
import { isCssLength } from './validate.js';
import { useTempOutputs } from './testenv.js';

const OUTPUTS_ROOT = await useTempOutputs('templatetest');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// pdfjs emits one text item per glyph run, so CSS letter-spacing and text-transform
// turn "South End Kitchen" into "S O U T H  E N D ...". Compare on letters only.
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const CASES = [
  {
    spec: 'poster-example.json',
    expect: { width: 612, height: 792, pages: 1 },
    mustContain: ['Spring Menu Launch', 'South End Kitchen', '412 Mill Street'],
    fonts: ['Playfair', 'SourceSerif', 'Inter'],
  },
  {
    spec: 'certificate-example.json',
    expect: { width: 792, height: 612, pages: 1 }, // landscape Letter
    mustContain: ['Certificate of Completion', 'Marisol Trevino', 'Executive Chef'],
    fonts: ['Playfair', 'SourceSerif', 'Inter'],
  },
  {
    spec: 'legal-form-example.json',
    expect: { width: 612, height: 1008, minPages: 2 }, // Legal, flows multi-page
    mustContain: ['Vendor Supply Agreement', 'FORM SE-114', 'Page 1 of', 'Governing Law'],
    fonts: ['SourceSerif', 'Inter'],
  },
];

console.log('— Template metadata —');
const declared = await listTemplates();
check('three authoring templates are listed', declared.length === 3, declared.map((t) => t.file).join(', '));
for (const t of declared) {
  check(`${t.file}: declares template-config`, Object.keys(t.config).length > 0);
  check(`${t.file}: config names a valid paperSize`, ['letter', 'legal'].includes(t.config.paperSize), t.config.paperSize);
  check(`${t.file}: config names a valid orientation`, ['portrait', 'landscape'].includes(t.config.orientation), t.config.orientation);
  check(`${t.file}: config margin is a CSS length`, isCssLength(t.config.margin ?? ''), JSON.stringify(t.config.margin));
  check(`${t.file}: has a description`, typeof t.description === 'string' && t.description.length > 10);
  check(`${t.file}: titleField names a real placeholder`, t.placeholders.includes(t.config.titleField), `${t.config.titleField} not in [${t.placeholders}]`);
}

const browser = await puppeteer.launch();
try {
  for (const c of CASES) {
    const spec = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'jobs', c.spec), 'utf8'));
    console.log(`— ${c.spec} (${spec.template}) —`);
    const { outputs: outs } = await renderJob(spec, { browser, autoOpen: false });
    const pdf = outs.find((r) => r.format === 'pdf').path;
    const info = await pdfInfo(pdf);

    check(`page box ${c.expect.width}x${c.expect.height} pt`,
      info.width === c.expect.width && info.height === c.expect.height,
      `${info.width}x${info.height}`);

    if (c.expect.pages !== undefined) {
      check(`${c.expect.pages} page(s)`, info.pages === c.expect.pages, `${info.pages}`);
    } else {
      check(`at least ${c.expect.minPages} pages (content flows)`, info.pages >= c.expect.minPages, `${info.pages}`);
    }

    const flat = normalize(info.text);
    for (const needle of c.mustContain) {
      check(`content present: "${needle}"`, flat.includes(normalize(needle)));
    }

    check('no unfilled {{placeholders}} in output', !/\{\{[\w:.-]+\}\}/.test(info.text),
      (info.text.match(/\{\{[\w:.-]+\}\}/g) ?? []).join(' '));

    const embedded = inspectFonts(await fs.readFile(pdf));
    for (const f of c.fonts) {
      check(`font embedded: ${f}`, embedded.fonts.some((n) => n.includes(f)), embedded.fonts.join(', '));
    }
    check('no fallback to Arial/Times (fonts actually loaded)',
      !embedded.fonts.some((n) => /Arial|TimesNewRoman|LiberationSerif/i.test(n)),
      embedded.fonts.join(', '));

    // B2 — Chromium sets /Title from <title> but exposes no Author/Subject/Creator.
    // A pdf-lib post-step stamps them. (It writes them as UTF-16BE hex strings, so
    // read the Info dict through pdf.js rather than regexing for `/Author (…)`.)
    check(`metadata: /Author is the project ("${spec.project}")`, info.info.Author === spec.project, String(info.info.Author));
    check(`metadata: /Subject is the docType ("${spec.docType}")`, info.info.Subject === spec.docType, String(info.info.Subject));
    check('metadata: /Creator is this tool', info.info.Creator === 'HTML Image Generator', String(info.info.Creator));
    check('metadata: Chromium\'s /Title from <title> survives the post-step',
      typeof info.info.Title === 'string' && info.info.Title.length > 0, String(info.info.Title));

    // The post-step must not compress the font descriptors into an /ObjStm — that is
    // exactly what makes these PDFs inspectable by regex.
    check('post-step writes no object streams', embedded.objStreams === 0, `${embedded.objStreams}`);
    // Chromium tags its PDFs (accessibility for free). Re-saving must not drop that.
    const raw = (await fs.readFile(pdf)).toString('latin1');
    check('post-step preserves the tagged-PDF structure tree',
      raw.includes('/StructTreeRoot') && raw.includes('/MarkInfo'));
  }
} finally {
  await browser.close();
}

console.log(`\noutputs root: ${OUTPUTS_ROOT}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
