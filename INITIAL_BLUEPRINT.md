# Initial Blueprint — HTML Image Generator

*Status: v1.0 — toolchain decided via deep research (2026-07-09). Full cited findings in [RESEARCH_REPORT.md](RESEARCH_REPORT.md).*

---

## 1. The Concept

A **deterministic image generator for print**, powered by any LLM. Instead of generating images probabilistically (diffusion models denoising pixels), the LLM writes an **HTML + CSS document at exact physical dimensions**, and a rendering pipeline converts it to print-ready output (PDF and/or high-DPI PNG).

**Why this wins over diffusion for print work:**

- Text is pixel-perfect, never garbled.
- Dimensions, margins, and alignment are exact — CSS understands `in`, `mm`, `pt`.
- Output is reproducible: same document, same result, every time.
- Edits are surgical ("move the logo down 10px") instead of full re-rolls.
- LLMs are exceptionally fluent in HTML/CSS — it's among their strongest output formats.

**Portability requirement:** This project must work as a drop-in folder for *any* LLM-capable IDE or agent (Claude Code, Cursor, Copilot, etc.). The "engine" is a combination of:
1. Instruction files the LLM reads (conventions, templates, the Question Guard),
2. A local rendering toolchain it can invoke (scripts),
3. A predictable folder structure for inputs and outputs.

---

## 2. Embraced Caveats → Features

We identified three limitations of the HTML/CSS approach. Rather than avoid them, each becomes a designed-in feature:

| Caveat | Embraced as |
|---|---|
| HTML/CSS can't produce photographic/illustrative content | **Hybrid image slots.** Layouts declare zones where externally generated artwork (diffusion output, stock, user photos) is placed. The deterministic layer owns all text, dimensions, and layout; the probabilistic layer only fills art zones. |
| Browsers output RGB, not CMYK | **Post-processing pipeline.** RGB PDF/PNG is the default (fine for home/office). An optional CMYK conversion step (e.g., Ghostscript or similar — confirm in research) produces press-ready output. |
| Fonts must be local or embedded | **Font management as a first-class asset.** A `fonts/` directory with project fonts, `@font-face` embedding conventions, and a manifest so any LLM knows exactly which fonts are available. Full typographic control — an advantage diffusion can never offer. |

---

## 3. The Question Guard

**No output is ever generated until the Question Guard is satisfied.** Before rendering anything, the LLM must elicit (or confirm defaults for) the following variables. This is the core interaction contract of the project.

### 3.1 Required variables

| # | Variable | Options / Notes |
|---|---|---|
| 0 | **Project / Client** | The organizing bucket — a client, venue, brand, or campaign (e.g., "South End"). Combined with Document type, this determines the auto-created output folder: `outputs/south-end/flyers/`. Free text; slugified. Defaults to `general` only if the user truly has no project. |
| 1 | **Paper size** | **Letter (8.5 × 11 in)** or **Legal (8.5 × 14 in)** — the two mandatory options. (Research: consider also A4, Tabloid, and custom sizes as extensions.) |
| 2 | **Orientation** | Portrait or Landscape |
| 3 | **Output format** | PDF (print), PNG (raster), or both |
| 4 | **Resolution (raster only)** | Default 300 DPI for print; 150 draft; 96 screen |
| 5 | **Color intent** | RGB (home/office) or CMYK press-ready (triggers post-processing) |
| 6 | **Margins** | Printable-area safe margins (default ~0.25–0.5 in) or full-bleed |
| 7 | **Bleed & crop marks** | If full-bleed / press: bleed size (typ. 0.125 in) and whether to draw crop marks |
| 8 | **Document type** | Poster, flyer, certificate, menu, label sheet, card, letterhead, form, sign, etc. — drives template choice **and the output subfolder** (pluralized: `flyers/`) |
| 9 | **Content** | The actual text/data: headline, body, contact info, dates, prices… |
| 10 | **Style direction** | Tone/aesthetic (minimal, ornate, corporate, playful…), color palette, reference brand if any |
| 11 | **Typography** | Preferred fonts (from `fonts/` manifest) or "designer's choice" |
| 12 | **Image slots** | Any photos/artwork to place? Provided files, AI-generated, or none |
| 13 | **Quantity / variants** | Single design, or N variants to compare |

### 3.2 Candidate additional variables *(to validate during deep research)*

- **Duplex / multi-page** — single page vs. front-and-back vs. multi-page document.
- **Imposition** — e.g., multiple business cards or labels tiled per sheet (n-up), with a target label template (Avery #, etc.).
- **Accessibility/legibility floor** — minimum font size, contrast requirements.
- **Language/script** — affects font selection and text direction (RTL support).
- **Printer constraints** — inkjet vs. laser vs. commercial press; borderless-capable or not.
- **Grayscale/black-and-white mode** — for cheap printing.
- **Data merge** — one template, many outputs from CSV/JSON (certificates with names, price tags…).

### 3.3 Guard behavior

- Ask only what's not already answered; infer sensible defaults and **state them for confirmation** rather than interrogating the user 13 times.
- Letter vs. Legal must always be explicitly confirmed — never silently defaulted.
- The guard's answers are saved alongside each job (a small spec file) so any output is reproducible and editable later.
- **Project and Document type are always captured**, because together they route the output. If the user has used a project before, offer it; if the doc type is new for that project, the folder is created silently — never an error, never a prompt.

---

## 3.4 Output Routing (auto-created folders)

Renders are filed automatically, never dumped into one flat pile:

```
outputs/
├── south-end/
│   ├── flyers/
│   │   ├── spring-menu-launch--letter--2026-07-09-142301.pdf
│   │   └── spring-menu-launch--letter--2026-07-09-142301.png
│   └── posters/
│       └── live-music-night--legal--2026-07-09-151120.pdf
├── acme-corp/
│   └── certificates/
└── general/            ← fallback when there's no project
```

**Rules:**
- Path = `outputs/<project-slug>/<doctype-plural>/`, created recursively on demand (`fs.mkdir({recursive: true})`) — no pre-registration of categories, no config file to maintain. A new project or a new document type just works.
- Slugification: lowercase, spaces → hyphens, strip anything outside `[a-z0-9-]` ("South End" → `south-end`). Guards against path traversal and Windows-reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…).
- Filename = `<job-slug>--<paperSize>--<timestamp>.<ext>`, so PDF and PNG of the same render share a stem and sort chronologically.
- Variants (Guard #13) get a `--v1`, `--v2` suffix on the stem.
- A `latest/` convenience: each render also refreshes `outputs/<project>/<doctype>/latest.<ext>` (copy, not symlink — Windows-friendly) so "the newest one" is always at a stable path for printing or scripting.
- **After render, the file opens.** The output (PDF by default) is launched in the system's default viewer via the `open` package; a `--no-open` CLI flag and a UI toggle suppress it for batch jobs. The UI additionally exposes "Reveal in File Explorer."

---

## 4. Rendering Pipeline & Toolchain (DECIDED — see RESEARCH_REPORT.md for evidence)

```
LLM writes spec (Question Guard answers)  →  jobs/<name>.json
        ↓
LLM writes HTML/CSS from template + spec  (@page size: letter|legal; physical units)
        ↓
Puppeteer (headless Chromium)
   ├─ PDF:  page.pdf({ preferCSSPageSize: true })          → vector, exact Letter/Legal
   └─ PNG:  page.screenshot() @ deviceScaleFactor = DPI/96 → sharp writes pHYs chunk (300 DPI)
        ↓
Optional press step:  Ghostscript → CMYK PDF/X (custom PDFX_def.ps + GRACoL/SWOP ICC)
        ↓
outputs/ folder, named + dated
```

**Decided stack:**

- **Runtime:** Node.js LTS — one ecosystem for server, render, and post-processing.
- **Render engine:** **Puppeteer.** Verified: Puppeteer and Playwright drive the identical Chromium `Page.printToPDF` path, so fidelity is the same; Puppeteer wins on ecosystem fit (pagedjs-cli is Puppeteer-backed → one shared Chromium) and emits tagged/accessible PDFs by default.
- **Print CSS / pagination:** **Paged.js.** Required because the `@page` `bleed`/`marks` descriptors are supported by **no browser** — Paged.js (or manual oversized-page layout) is the only local route to bleed and crop marks, plus running headers/footers and the dimensionally accurate in-browser preview.
- **PNG DPI fix:** Chromium never writes DPI metadata into PNGs — **sharp** post-processes each raster output to embed the `pHYs` chunk (e.g., 300 DPI).
- **CMYK / press:** **Ghostscript** (`gswin64c` on Windows) with `-sColorConversionStrategy=CMYK` + customized `PDFX_def.ps` + a separately obtained US press ICC profile (GRACoL/SWOP — Ghostscript ships none). The unmaintained `press-ready` CLI serves as a flag reference, not a dependency.
- **Rejected:** wkhtmltopdf (ancient QtWebKit engine), WeasyPrint (no JS execution), pdfme (JSON schemas, not HTML/CSS — but study its WYSIWYG designer UI), react-print-pdf (cloud-rendered, unmaintained), Satori (SVG-subset flexbox only).

## 4b. Local App — One Command, Opens Itself

**Architecture: localhost server + system browser.** No Electron/Tauri — the project already ships a full Chromium via Puppeteer for rendering; a second bundled runtime adds bulk for zero print-fidelity gain. A local server keeps everything LLM-scriptable and satisfies Paged.js's requirement of HTTP (it won't run from `file://`).

- **`npm start`** (or double-click `Start.cmd`) → Fastify/Express server boots on a free port → **`open` package auto-launches the default browser** at `http://localhost:PORT`.
- **Live preview:** the UI serves the working document through the Paged.js polyfill, so Letter/Legal pages render as true discrete page boxes on screen; **chokidar** watches `templates/`/`jobs/` and a WebSocket pushes reloads on every save (re-invoking the Paged.js `Previewer`, which only runs on load).
- **Two equal entry points:**
  1. **UI** — for the human: preview, zoom, pick job specs, hit Render.
  2. **CLI / HTTP API** — for any LLM agent: `node scripts/render.js jobs/<spec>.json` (and the same endpoint the UI's Render button calls). Agents never need the UI to produce output.

## 4c. Build-Time Verification Checklist (open questions from research)

- [ ] Font embedding: confirm WOFF2 vs TTF `@font-face` behavior in Chromium PDFs empirically (`pdffonts` on a test render).
- [ ] Ghostscript 10.x PDF/X-4 support; validate outputs with veraPDF.
- [ ] Legal source for a US CMYK ICC profile (GRACoL2013/CGATS21 or SWOP).
- [ ] Whether Chrome 131+ native `@page` margin boxes reduce the need for Paged.js on headers/footers.
- [ ] Screenshot truncation at high deviceScaleFactor — regression-test at DSF 3.125 (300 DPI).

---

## 5. Proposed Folder Structure (draft)

```
HTML Image Generator/
├── INITIAL_BLUEPRINT.md      ← this file
├── RESEARCH_REPORT.md        ← cited deep-research findings behind the decisions
├── README.md                 ← how any LLM/IDE should use this project
├── GUARD.md                  ← the Question Guard, as LLM instructions
├── package.json              ← "npm start" = server + auto-open browser
├── Start.cmd                 ← double-click launcher (Windows)
├── server/                   ← Fastify server, live-reload, render API
├── templates/                ← starter HTML/CSS per document type
├── fonts/                    ← project fonts + manifest
├── assets/                   ← logos, images, artwork drops
├── scripts/                  ← render.js (CLI), png-dpi fix, CMYK post-process
├── jobs/                     ← saved specs (guard answers) per job
└── outputs/                  ← auto-foldered: <project>/<doctype>/  (see §3.4)
    └── south-end/flyers/     ← e.g. created on demand, never pre-registered
```

---

## 6. Next Steps

1. ✅ This blueprint (v0.1).
2. ✅ **Deep research** — 23 sources, 25 claims adversarially verified → [RESEARCH_REPORT.md](RESEARCH_REPORT.md).
3. ✅ Toolchain decided: Node + Puppeteer + Paged.js + sharp + Ghostscript; localhost app with `npm start` auto-open (blueprint updated to v1.0).
4. **Scaffold** the folder structure, server, render CLI, and `GUARD.md`.
5. Build 2–3 reference templates (Letter + Legal) and run end-to-end test prints.
6. Work through the §4c verification checklist during the first build.
