# Build Plan — HTML Image Generator

*v1.1 — 2026-07-09. Executes the decisions in [INITIAL_BLUEPRINT.md](INITIAL_BLUEPRINT.md) (v1.0) and [RESEARCH_REPORT.md](RESEARCH_REPORT.md).*

*v1.1 changes: applied verified research findings structurally — native Chromium `@page` is the **default** render path with Paged.js as a conditional branch (research §4: modern Chromium covers most of css-page-3; Paged.js earns its keep only for bleed/marks, generated content, and the preview); the two build-time probes (Chrome margin boxes, DSF truncation) moved from Phase 5 into Phase 1's selftest because their answers decide Phase 2's template architecture; PDF declared the authoritative print output (the screenshot path carries the known truncation bug); exact sharp call pinned.*

**Guiding principle: CLI-first, UI-second.** The render engine must work headlessly from one script call before any UI exists — that's what makes the project drivable by any LLM agent. The app UI is a thin layer over the same code path.

---

## Phase 0 — Environment & Skeleton *(~small)*

**Goal:** a Node project that installs cleanly on Windows 11.

1. `npm init` with `"type": "module"`, Node LTS engines field.
2. Install dependencies:
   - Runtime: `puppeteer`, `pagedjs`, `sharp`, `fastify`, `@fastify/static`, `@fastify/websocket`, `chokidar`, `open`
   - No global installs; Puppeteer downloads its own Chromium on `npm i`.
3. Create the folder skeleton from Blueprint §5: `server/ templates/ fonts/ assets/ scripts/ jobs/ outputs/` (with `.gitkeep`s).
4. Optional but recommended: `git init` + `.gitignore` (`node_modules/`, `outputs/`).
5. **Ghostscript deferred to Phase 4** — the core app must never require it.

**Exit test:** `npm i` completes; `node -e "import('puppeteer')"` resolves; Puppeteer launches headless Chromium and prints its version.

---

## Phase 1 — Core Render Engine (CLI) *(~large — the heart)*

**Goal:** `node scripts/render.js jobs/example.json` produces a correct PDF and a correct 300-DPI PNG with zero UI.

1. **Job spec schema** — `jobs/schema.json` encoding the Question Guard variables (Blueprint §3.1): **project**, paperSize (`letter`|`legal`), orientation, outputs (`pdf`|`png`|both), dpi, colorIntent, margins, bleed/cropMarks, **docType**, template, content fields, fonts, imageSlots, variants. A job file is the saved, reproducible record of one generation.
2. **`scripts/paths.js`** — output routing (Blueprint §3.4), built and unit-tested *before* the renderer needs it:
   - `slugify()` — lowercase, spaces→hyphens, strip to `[a-z0-9-]`; reject path traversal (`..`, separators) and Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`).
   - `pluralizeDocType()` — `flyer`→`flyers`, `certificate`→`certificates` (small explicit map + `+s` fallback; no inflection library).
   - `resolveOutputPath(spec, ext)` → `outputs/<project-slug>/<doctype-plural>/<job-slug>--<paper>--<timestamp>.<ext>`, with `fs.mkdir(..., {recursive: true})`. New project or new doc type = folder springs into existence, no config, no error.
   - `writeLatest()` — after each render, copy to `outputs/<project>/<doctype>/latest.<ext>` (copy, not symlink — Windows).
3. **`scripts/render.js`** — one entry point, **two render paths** (research §4):
   - Load job spec → resolve template → inject content (simple `{{placeholder}}` substitution; no template engine dependency in v1).
   - Serve the document over a throwaway local HTTP server during render (Paged.js refuses `file://`; using HTTP unconditionally keeps both paths identical).
   - **Native path (default):** plain Chromium `@page` CSS + `page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true })`. Modern Chromium covers exact size/orientation/margins natively — no polyfill in the loop, faster and fewer moving parts. Puppeteer's tagged PDFs come free.
   - **Paged.js path (conditional):** engaged only when the spec asks for **bleed/crop marks** or generated-content features (running headers via `string-set`, page-number counters) that the Phase 1 margin-box probe shows Chromium can't do natively. Inject the polyfill, wait for `Previewer` completion, then the same `page.pdf()` call.
   - **PDF is the authoritative print output.** PNG is a convenience deliverable: set viewport to page size in CSS px (Letter = 816×1056), `deviceScaleFactor = dpi/96` (300 DPI → 3.125), screenshot, then **sharp** `.withMetadata({ density: dpi })` re-encode so the pHYs chunk reads correctly (Chromium writes none).
   - Write via `resolveOutputPath()`; refresh `latest.*`.
   - **Auto-open on completion:** launch the primary output (PDF if produced, else PNG) in the system default viewer via `open`. Suppressed by `--no-open`, and skipped automatically for multi-variant batch runs (open only the last, or none).
4. **Warm-browser option:** export a `renderJob(spec, browser)` function so the Phase 3 server reuses one Chromium instance; the CLI launches/closes its own.

**Exit tests (scripted, `scripts/selftest.js`):**
- PDF page box is exactly 612×792 pt (Letter) and 612×1008 pt (Legal) — read with `pdf-lib` or Puppeteer itself.
- PNG is exactly 2550×3300 px (Letter @300) and sharp reads back `density: 300`.
- **Probe A — DSF truncation (open question #5):** full-page content grid at deviceScaleFactor 3.125; verify no missing bottom-right content (known Puppeteer high-DSF bug). Failure ⇒ PNG renders fall back to tiled capture or PDF-rasterize; record the result.
- **Probe B — Chrome native `@page` margin boxes (open question #4):** render a doc using `@top-center`/`@bottom-right` margin boxes *without* Paged.js; check whether the content appears. The answer decides whether Phase 2's `legal-form` running header uses native CSS or the Paged.js path; record the result in RESEARCH_REPORT.md.
- Routing: a spec with `project: "South End", docType: "flyer"` lands at `outputs/south-end/flyers/…` with the folder created on the fly; `latest.pdf` points at it. A malicious `project: "../../etc"` is rejected, not traversed.

---

## Phase 2 — Templates, Fonts & the Question Guard *(~medium)*

**Goal:** an LLM agent dropped into this folder knows exactly how to behave, and has real templates to work from.

1. **`GUARD.md`** — the Question Guard as direct LLM instructions: the 13 variables, defaults-with-confirmation behavior, the rule that Letter vs Legal is always explicitly confirmed, and "write the answers to `jobs/<name>.json` before rendering."
2. **`templates/base.css`** — shared print foundation: `@page` size variants (letter/legal × portrait/landscape), margin presets, bleed variant, CSS variables for palette/typography.
3. **Three reference templates** (each a complete HTML file with `{{placeholders}}` and an image slot), authored against the **native path** by default — a template only opts into Paged.js features when it actually needs them:
   - `poster-letter` — big type, full-bleed background zone (native path; bleed variant exercises the Paged.js path).
   - `certificate-letter` — border, script/serif pairing, data-merge-ready name field (native path).
   - `legal-form` — Legal size, dense text, running header (exercises pagination; header mechanism per Phase 1 Probe B — native margin boxes if supported, else Paged.js `string-set`).
4. **Fonts:** `fonts/manifest.json` (family, file, weights, license) + `@font-face` conventions in base.css; ship 2–3 open-license fonts (e.g., Inter + a serif + a display face).
5. **`README.md`** — how any LLM/IDE uses the project: read GUARD.md → write job spec → run render.js (or POST /api/render) → check outputs/.

**Exit tests:**
- Each template renders clean on its paper size with no overflow.
- **Font-embedding check (research open question #1):** render a PDF using each manifest font, verify embedding — WOFF2 vs TTF empirically compared, result recorded in RESEARCH_REPORT.md's checklist.

---

## Phase 3 — Local App: One Command, Opens Itself *(~medium)*

**Goal:** `npm start` (or double-click `Start.cmd`) → browser opens on a live, true-size preview.

1. **`server/index.js`** (Fastify):
   - Static UI + `templates/`, `fonts/`, `assets/`, `outputs/`.
   - `GET /api/templates`, `GET/POST /api/jobs`, `POST /api/render` (calls the same `renderJob()` as the CLI, against one warm Chromium), `GET /api/outputs`.
   - Free-port selection (listen on 0, read assigned port); then `open('http://localhost:<port>')`.
2. **Live preview UI** (`server/ui/` — plain HTML/JS, no framework in v1):
   - Left: job spec form generated from `jobs/schema.json` (the Question Guard as a form) + template picker.
   - Right: iframe running the document through the **Paged.js polyfill** → true discrete Letter/Legal page boxes; zoom via CSS `transform: scale()`.
   - **Hot reload:** chokidar watches `templates/` and `jobs/` → WebSocket message → iframe reloads and re-invokes the Paged.js `Previewer` (it only runs on load — verified gotcha).
   - Render button → `POST /api/render` → the file opens in the default viewer (respecting an "auto-open" toggle), plus an in-UI link and a **"Reveal in File Explorer"** button (`open` on the containing folder).
   - **Project / doc-type controls:** the form's Project field is a combo box pre-populated from existing `outputs/*` folder names (via `GET /api/projects`) with free-text entry for new ones; same for doc type. The output path is shown live under the button ("→ outputs/south-end/flyers/") so the destination is never a surprise.
3. **`Start.cmd`**: `@npm start` — double-clickable on Windows 11.

**Exit tests:**
- Cold start: one command → browser opens itself → preview visible in under ~10s.
- Edit a template file in any editor → preview updates without touching the browser.
- UI render and CLI render of the same job spec produce byte-comparable outputs.

---

## Phase 4 — Press Pipeline (optional CMYK/PDF-X) *(~medium, gated)*

**Goal:** `colorIntent: "cmyk"` in a job spec produces a press-ready PDF — but only when Ghostscript is present; otherwise a clear message, never a crash.

1. **`scripts/press.js`**: detect `gswin64c.exe` (PATH + standard install dirs); wrap Ghostscript with `-sColorConversionStrategy=CMYK`, `-dPDFX`, and a project `PDFX_def.ps` template (mine the flag set from press-ready's `src/ghostScript.ts` — reference only, not a dependency).
2. **ICC slot:** `assets/icc/` + config pointing at a user-supplied GRACoL/SWOP profile; README documents where to legally obtain one (research open question #3 — resolve here).
3. Confirm Ghostscript 10.x PDF/X level support empirically (open question #2); validate one output with veraPDF if feasible.
4. Wire into render.js as a post-step when the spec demands press output.

**Exit test:** RGB test PDF → CMYK PDF/X; veraPDF (or Acrobat preflight) reports the expected conformance; pipeline degrades gracefully with Ghostscript absent.

---

## Phase 5 — End-to-End Proof & Hardening *(~small)*

1. Run the full loop as an LLM would: read GUARD.md → elicit variables → write job spec → CLI render → confirm output.
2. Print one Letter and one Legal page on a physical printer; measure with a ruler.
3. Close out the Blueprint §4c checklist — Probes A/B were answered in Phase 1 and fonts in Phase 2; confirm all results are recorded in RESEARCH_REPORT.md.
4. Update all docs to match reality; bump Blueprint to v1.1.

---

## Phase 6 — Validation & UX Overhaul *(~large, planned 2026-07-09 after first real use)*

First real user session surfaced this phase. The screenshot evidence: doc type "posters" routed to `outputs/south-end/posterses/`, a certificate template previewed on Legal portrait as a broken half-empty page, and a render shipped named `untitled--legal`. Three failures, three causes: a routing bug, zero validation, and a UI that lets every wrong combination happen silently.

### 6A — Correctness & validation — **DONE 2026-07-09**

Shipped: `scripts/validate.js` (one validator, enforced inside `applyDefaults()` so CLI, API, and UI cannot diverge), the idempotent `pluralizeDocType()` fix, `scripts/templates.js` + `<meta name="template-config">` in all three templates, `/api/validate` and `/api/templates` (now returning config + placeholders), inline field errors in the UI, and a mismatch warning. **77 new assertions in `scripts/validatetest.js`; suite total 193.**

**One deliberate deviation from the plan below:** it said template selection should auto-apply `paperSize`. It must not — that would silently choose the one variable the Question Guard exists to protect. Templates now apply orientation/margin/outputs and *recommend* a paper size (dashed "recommended" badge); the user still picks. Choosing differently produces a visible warning rather than a silent bad render.

### 6A — original plan (for reference)

1. **Fix the double-pluralization bug.** The UI's doc-type combo is populated from `outputs/*` folder names, which are already plural — `posters` → `pluralizeDocType()` → `posterses`. Fix in `paths.js`: build a reverse map of known plurals and pass anything already plural through unchanged (`posters` → `posters`, `flyer` → `flyers`); generic fallback: if the slug ends in `s` and singularizing it round-trips, treat as plural. Add regression tests: every value the UI can offer must round-trip stably (`pluralizeDocType(pluralizeDocType(x)) === pluralizeDocType(x)`).
2. **Server-side spec validation** in one place (`scripts/validate.js`), used by `renderJob()` itself so the CLI, the API, and the UI all get it:
   - enums (`paperSize`, `orientation`, `outputs`, `colorIntent`), `dpi` range,
   - `margin`/`bleed` must parse as CSS lengths (`0` | `0.5in` | `12mm` | `1in 0.75in`…) — reject `abc`, negative values,
   - `template` must exist on disk; `imageSlots` paths must exist and stay inside the project; `content` values are strings,
   - reject unknown top-level fields (typo protection: `paperSze` should error, not silently default).
   - API returns field-level errors (`{ field, message }[]`); exit tests feed a malformed spec through both CLI and API.
3. **Template metadata.** Each template declares what it's designed for in a `<meta name="template-config" content='{...}'>` block: recommended `paperSize`, `orientation`, `margin`, plus a human description. Selecting a template in the UI **auto-applies its recommendations**; a mismatch the user forces (certificate on Legal portrait) shows a visible warning, not silence. `templatetest.js` asserts every shipped template carries valid metadata.
4. **Field-level UI validation.** Inline errors under each field as you type (reusing the same validator via a `/api/validate` endpoint); Render disabled while invalid, with the button naming the first problem ("Fix margin: 'abc' is not a length"). Job name: default to a slug of the template's title/headline content instead of `untitled`.

### 6B — Redesign: modern, guided, visual

Direction: keep the no-framework constraint (the state is small); rebuild `server/ui/` around a **guided flow that mirrors the Question Guard** instead of one undifferentiated form column.

1. **Template gallery, not a dropdown.** At server start, render each template once with its example content to a small cached PNG thumbnail (the renderer already exists — reuse `renderJob` at dpi 40 into `server/.thumbs/`). Picking is visual; each card shows the template's paper/orientation badge and description from its metadata.
2. **Three-step left rail:** ① Template (gallery) → ② Setup (destination, paper-size guard, layout — pre-filled from template metadata) → ③ Content (fields with Title-Cased labels, autosizing textareas, image-slot pickers that show thumbnails of `assets/`). Progress states make "what do I do next" self-answering. Paper size keeps its hard-stop treatment.
3. **Preview pane upgrades:** paper-size badge with physical dimensions ("Legal · 8.5 × 14 in"), page count, fit-width / fit-page / 100% zoom presets replacing the raw slider, and page navigation for multi-page docs.
4. **Recent outputs panel** — `/api/outputs` already exists and the UI never calls it. Show the last renders with open/reveal actions, so the app is also the place you *find* what you made.
5. **Design system pass:** the UI should look like it was made by the tool it is — use the shipped Inter for the interface, one accent, generous spacing, consistent 8px rhythm, visible focus states, `prefers-color-scheme` dark variant. No CSS framework; one rewritten `style.css`.

### 6C — Exit tests (extend `apptest.js`)

- `posters` as doc type routes to `outputs/<project>/posters/` — **not** `posterses/`.
- A spec with `margin: "abc"`, bad enum, unknown field, or missing template is rejected by CLI, API, and UI alike, with field-level messages.
- Selecting the certificate template auto-sets landscape + Letter + margin 0; forcing Legal portrait shows the mismatch warning.
- Gallery shows a thumbnail per template; Render stays disabled while any field is invalid and the button names the blocker.
- Full `npm test` stays green.

---

## Build Order & Dependencies

```
Phase 0 ──> Phase 1 ──> Phase 2 ──┐
                        (1+2 must exist before UI matters)
                                  ├──> Phase 3 ──> Phase 5
Phase 4 (independent after 1) ────┘
```

Phases 1–3 are the MVP: after Phase 3 the product exists ("one command, opens itself, LLM-drivable"). Phase 4 is the press upgrade; Phase 5 is proof.

## Deliberate v1 exclusions (future work)

- Data merge (CSV → N certificates), n-up imposition/label sheets, A4/Tabloid/custom sizes, a WYSIWYG editor (study pdfme later), packaging as a single executable. All are additive on top of this architecture.
