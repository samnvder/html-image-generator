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

**Goal:** `node scripts/render.js jobs/<spec>.json` produces a correct PDF and a correct 300-DPI PNG with zero UI.

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

### 6B — Redesign — **DONE 2026-07-10**

Shipped: template gallery with thumbnails rendered by the real engine (`scripts/thumbs.js`, cached, serialized, atomic writes), three-step guided rail, preview toolbar (paper badge with physical dimensions, page count, fit-page/fit-width/100% presets), empty state, recent-outputs panel, humanized field labels, and a full design-system pass with `prefers-color-scheme` dark mode using the shipped Inter.

**Two behavioural fixes found by looking at it, not by testing it:**
- The background-tab guard now keys off **whether Paged.js actually stalled**, not `document.hidden`. Some environments report a visible tab as hidden, and gating there meant the preview never rendered at all. The preview always starts; a watchdog flags a stall; `visibilitychange` re-runs it.
- Preview chrome no longer hardcodes a grey backdrop (it clashed with dark mode) and hides the iframe's scrollbar. Fit-page fits **one page**, not the whole document.

### 6B — original plan (for reference)

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

## Phase 7 — Audit Remediation — **DONE 2026-07-10** *(executes [AUDIT.md](AUDIT.md))*

Shipped 7A→7E in order, each ending with a cold `npm test`, a commit, and a push. All 11 defects and all 6 gaps closed; suite went 212 → **297 assertions**; CI green. Three deliberate deviations are recorded at the top of [AUDIT.md](AUDIT.md): B2's exit test as planned could not pass (pdf-lib writes `/Author` as a UTF-16BE hex string), `isInside()` landed a sub-phase early because 7C's path rework required it, and apptest's cross-process PNG delta bound was loosened from 2 to 8 while the discriminating ratio bound stayed put.

Five sub-phases, strictly in order — each ends with a **cold** `npm test` (delete `server/.thumbs/` first), a commit, and a push. Item IDs (A1–A11, B1–B6) refer to AUDIT.md. Two standing invariants no fix may break: **paper size is never auto-set** (templates recommend, users choose), and **validation lives only in `scripts/validate.js`**.

### 7A — Output correctness (A1, A2) — the premise bugs

1. **A1 — PNG+bleed corruption.** In `renderJob`, the PNG path must render a **non-paged** composition: bleed/crop marks are print concepts; the PNG is a trim-size screen render. Compose twice when a paged job also wants PNG (`composeDocument(run)` for PDF, a `{ screen: true }` variant that skips polyfill injection for PNG). Do not "fix" by stripping bleed from the spec — the PDF must keep it.
   *Exit tests (selftest):* a bleed+cropMarks job with `outputs:["pdf","png"]` yields (a) a PDF whose sheet is larger than 612×792 pt, and (b) a PNG that is pixel-equivalent (<0.01% subpixels, delta ≤2) to the same job rendered without bleed. This is the exact probe from the audit, made permanent.
2. **A2 — content parsed as HTML.** Escape `& < > " '` in all `content` values at substitution time. Add `{{{key}}}` (triple-stache) for deliberate raw markup; `{{image:slot}}` values keep working in `src` attributes (escaping is attribute-safe). Document both in GUARD.md's template rules.
   *Exit tests (selftest or validatetest):* content `<b>x</b>` appears **literally** in the PDF text (pdfinfo); `use <Enter> to continue` survives intact; the same value through `{{{...}}}` renders as markup (text without the tags).

### 7B — Data-loss & broken-state (A3, A4, A5)

3. **A3** — `/api/jobs` saves to `jobs/${slugify(spec.name)}.json`; response returns the actual filename. *Exit (apptest):* saving name `menu: spring` returns 200 and `jobs/menu-spring.json` exists.
4. **A4** — variant runs that resolve to an already-used output path auto-suffix `--v2`, `--v3`… *Exit (selftest):* a job with two variants overriding only `content` produces three distinct PDFs, none overwritten.
5. **A5** — retarget or remove `jobs/example.json` (it references the hidden `_selftest.html`); UI job picker lists only jobs whose template exists in the gallery. *Exit (apptest):* every job in the picker loads into a valid form state.

### 7C — Test isolation, then CI (A7, B4)

6. **A7** — outputs root becomes resolvable at call time: `getOutputsRoot()` reading `process.env.HIG_OUTPUTS_ROOT ?? <default>`; every consumer (paths, server statics/mounts, /api/outputs, /api/projects, reveal check) goes through it. Test suites set it to a temp dir (apptest passes it through the spawned server's env). *Exit:* `git status` clean under `outputs/` after a full cold `npm test`; suites assert their artifacts landed under the temp root.
7. **B4** — `.github/workflows/test.yml`: push + PR, ubuntu-latest, Node 22, `npm ci && npm test`. Fonts are committed; Puppeteer downloads its own Chromium. *Exit:* push, then `gh run watch` until green — the workflow run itself is the test.

### 7D — Hardening (A6, A8, A9, A10, A11)

8. **A6** — add `isInside(parent, child)` to paths.js (`path.relative`: non-empty ⇒ must not start `..` nor be absolute); replace the four `startsWith` prefix checks (render.js static server, `/api/reveal`, validate.js template + imageSlots). *Exit (validatetest):* unit cases incl. the sibling-prefix trap (`C:\x\outputs` vs `C:\x\outputsX`).
9. **A8** — validator reads the target template's `template-config` (cache by mtime); `pdfOnly` + `outputs` containing `png` ⇒ field-level error on `outputs`. *Exit (validatetest):* `legal-form.html` + `["png"]` rejected; `["pdf"]` passes.
10. **A9** — server relaunches Chromium on `disconnected` and retries a failed render once. Add a test-only `POST /api/_test/crash-browser`, enabled only when `HIG_TEST=1` (apptest sets it on the spawned server). *Exit (apptest):* crash the browser via the endpoint, then render successfully.
11. **A10** — `renderJob` returns `{ outputs, warnings }` (unfilled placeholders etc.). Update every caller: CLI prints warnings to stderr, API includes them in the response, UI shows them in the result drawer, thumbs/tests destructure. *Exit (apptest):* rendering with a missing content key surfaces the placeholder name in the UI drawer.
12. **A11** — `jobs/schema.json` gains a `$schema` string property. *Exit (validatetest):* every shipped `jobs/*.json` passes `validateSpec`.

### 7E — Reproducibility & polish (B1, B2, B3, B5, B6)

13. **B1** — every successful `/api/render` also writes `jobs/${slugify(name)}.json` (the Guard's reproducibility promise, enforced from the UI path too); response carries `savedSpec`; UI mentions it. *Exit (apptest):* after a UI render, the job file exists and round-trips through the validator.
14. **B2** — add `pdf-lib` post-step: set Author = project, Subject = docType, Creator = `HTML Image Generator`; leave Chromium's `/Title` (verified: written from `<title>`). Skip Puppeteer's `outline` (experimental, flaky per research). *Exit (templatetest):* pdfinfo-style regex finds `/Author (South End)` in a poster render.
15. **B3** — image-slot picker: `GET /api/assets` lists image files under `assets/`; slot inputs get a `<datalist>` of those paths plus a live thumbnail preview beside the field (hidden on load error). *Exit (apptest):* the slot input offers the placeholder assets; setting a value updates the preview.
16. **B5** — favicon (inline SVG data URI) + `theme-color`. No test needed.
17. **B6 — last, deliberately:** upgrade puppeteer 25 / sharp 0.35 / chokidar 5 / @fastify/static 9 / open 11 (we are ESM on Node 24; `executablePath()` async change doesn't touch us). *Exit:* full cold `npm test` green; if any package breaks, pin it back and record why in AUDIT.md rather than fighting it.

**Close-out:** mark items done in AUDIT.md, update HANDOFF.md (status + any new "facts that will bite you"), bump README test counts, final cold `npm test`, commit, push.

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
