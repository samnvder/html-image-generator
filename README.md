# HTML Image Generator

A **deterministic image generator for print.** Instead of a diffusion model guessing pixels, an LLM writes an HTML + CSS document at exact physical dimensions, and headless Chromium renders it to a print-ready PDF (vector) and/or a 300-DPI PNG.

Diffusion models can't do crisp text, exact margins, precise alignment, or reproducibility — the four things print work actually needs. HTML/CSS gives all four, and LLMs are exceptionally fluent in it.

```
US Letter  →  612 × 792 pt PDF, exactly.  2550 × 3300 px PNG @ 300 DPI, exactly.
US Legal   →  612 × 1008 pt PDF, exactly.
```

---

## Quick start

```bash
npm install    # downloads its own Chromium
npm start      # picks a free port, opens your browser on a live true-size preview
```

On Windows, double-click **`Start.cmd`** instead — it installs on first run.

Prefer the terminal? The renderer never needs the UI:

```bash
node scripts/render.js jobs/poster-example.json
```

The PDF opens in your default viewer and lands in `outputs/south-end/posters/`.

```bash
npm test       # 4 suites: exact page boxes, exact pixel counts, path security,
               # font embedding, all templates, and the app end-to-end
```

## For an LLM agent working in this repo

**Read [`GUARD.md`](GUARD.md) first.** It is the operating contract: fourteen variables must have values before anything renders, thirteen of which you infer and state for confirmation — and one, **paper size, you always explicitly ask about.**

The loop:

1. Elicit / infer the variables → **confirm paper size**
2. Write `jobs/<name>.json` (schema: [`jobs/schema.json`](jobs/schema.json))
3. Pick or author a template in `templates/`
4. `node scripts/render.js jobs/<name>.json`
5. Report the output path

Nothing about this requires the UI. That's the point — any agent in any IDE drives it with one CLI call.

## Output routing

Renders never dump into a flat pile. Folders are created on demand — a new client or a doc type you've never used just works on first render.

```
outputs/<project-slug>/<doctype-plural>/<job>--<paper>--<timestamp>.pdf
outputs/south-end/posters/spring-menu-launch--letter--2026-07-09-204900.pdf
outputs/south-end/posters/latest.pdf          ← copy, not symlink (Windows)
```

Slugification doubles as a security boundary: project names are free text that becomes a filesystem path, so `../../etc` and Windows reserved names (`CON`, `NUL`, `COM1`…) are rejected rather than traversed.

## Templates

| Template | Paper | Exercises |
|---|---|---|
| `poster-letter.html` | Letter, portrait | Full-bleed art zone, display type over a scrim, image slot |
| `certificate-letter.html` | Letter, **landscape** | Bordered layout, single merge field, `variants` batch render |
| `legal-form.html` | **Legal**, portrait | Flowing multi-page text, native running header + `counter(page)` |

All link `templates/base.css`, which carries the `@font-face` declarations, design tokens, and the `.sheet` box. Four OFL-licensed families ship in `fonts/` (see `fonts/manifest.json`); re-fetch with `node scripts/fetch-fonts.js`.

**Image slots** are the deliberate boundary: the layout declares art zones (`{{image:background}}`), and photos or diffusion output fill them. The deterministic layer owns every glyph and every dimension.

## How it renders

One entry point, two paths:

- **Native (default).** Plain Chromium `@page` CSS + `page.pdf({ preferCSSPageSize: true })`. Exact size, orientation, margins, running headers, page counters — all native. Verified in Chrome 148.
- **Paged.js (conditional).** Engaged *only* when the job spec asks for `bleed` or `cropMarks`, because the CSS `@page` `bleed` and `marks` descriptors are supported by no browser.

The document is always served over a throwaway local HTTP server (Paged.js refuses `file://`, and using HTTP unconditionally keeps both paths identical).

**PDF is the authoritative print output.** PNG is a convenience raster: `deviceScaleFactor = dpi/96` gives exact pixel counts, then `sharp` stamps the `pHYs` chunk — because Chromium writes no DPI metadata and the file would otherwise claim 72 DPI.

## The app

`npm start` boots a Fastify server (~1s), picks a free port, and opens your browser. The left panel is the Question Guard as a form — everything defaulted, **paper size demanded**. The right panel is a true-size preview: the document runs through the Paged.js polyfill, so a Letter page is exactly 816×1056 CSS px and a Legal page 816×1344.

Edit a template in any editor and the preview reloads itself. Hit Render and the file opens in your default viewer, with a "Reveal in Explorer" button beside it.

The server keeps one warm Chromium and calls the same `renderJob()` the CLI does. A UI render and a CLI render of the same spec produce the same PDF and a pixel-equivalent PNG.

## Project layout

```
server/index.js        Fastify: static mounts, /api/*, chokidar + WebSocket reload
server/ui/             the UI — plain HTML/CSS/JS, no framework
scripts/render.js      the engine — also exports renderJob(spec, {browser})
scripts/paths.js       slugify, pluralize, output routing, latest.* copies
scripts/pdfinfo.js     PDF page box, text, and embedded-font inspection
scripts/selftest.js    Phase 1 exit tests (hard numbers)
scripts/templatetest.js  every template renders clean
scripts/fonttest.js    font embedding proof
scripts/apptest.js     drives the real server + real browser
templates/             base.css + three reference templates
fonts/                 OFL fonts + manifest.json
jobs/                  schema.json + example specs
outputs/               renders (gitignored)
```

## Status

Phases 0–3 complete — the MVP. Phase 4 (optional Ghostscript CMYK / PDF-X) and Phase 5 (print and measure) are in [`BUILD_PLAN.md`](BUILD_PLAN.md).

Design rationale is in [`INITIAL_BLUEPRINT.md`](INITIAL_BLUEPRINT.md); the cited toolchain research, including four refuted claims, is in [`RESEARCH_REPORT.md`](RESEARCH_REPORT.md).
