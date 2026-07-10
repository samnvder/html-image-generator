# Build Plan — HTML Image Generator

*v1.2 — 2026-07-10. Executes the decisions in [INITIAL_BLUEPRINT.md](INITIAL_BLUEPRINT.md) (v1.0) and [RESEARCH_REPORT.md](RESEARCH_REPORT.md).*

*v1.2 changes: Phase 7 marked done; Phases 4 and 5 expanded from sketches into executable plans with per-item exit tests, to the Phase-7 standard; Phase 8 added for the three residuals Phase 7's close-out identified. Phase 4's original exit test ("veraPDF reports conformance") was environmental hand-waving — it now specifies which assertions run in `npm test`, which self-skip, and which are one-time manual probes.*

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

## Phase 4 — Press Pipeline (optional CMYK/PDF-X) — **DONE 2026-07-10**

Shipped 4A→4D in order, each ending with a cold `npm test`, a commit, and a push. The three pre-taken decisions all survived contact; two *planned exit tests* did not, and both were the test's fault, not the code's.

**Four deviations, all forced by measurement and recorded in [RESEARCH_REPORT.md](RESEARCH_REPORT.md) §5:**

1. **The level is PDF/X-4, via `-dPDFX=4` — not `-dPDFX`.** The plan said to mine press-ready's flags, and press-ready uses `-dPDFX`. That clamps Ghostscript to PDF 1.3, which has no transparency, so it **flattens the page to a bitmap**: on the shipped poster, all four embedded fonts vanish and pdf.js extracts zero characters. Exit code 0, no warning. Correct PDF/X-3 behaviour, catastrophic for this tool. **PDF/X-1a is therefore not offerable at all**, and `assets/icc/README.md` tells a printer so rather than handing them a raster.
2. **`-dCompatibilityLevel=1.4` holds only on the no-profile path.** PDF/X-4 requires 1.6, where Ghostscript *does* write object streams — the 7E `useObjectStreams` lesson arriving from the other direction. `pdfinfo.js` grew `inspectPdfDeep()`, a pdf-lib walk of the object graph, so the fonts stay checkable. The plain CMYK conversion remains 1.4 and `/ObjStm`-free, exactly as planned.
3. **`colorIntent: "cmyk"` requires Ghostscript ≥ 10.05.0.** Below it, `PDFX` is a *boolean* — `-dPDFX=4` dies with `/typecheck in --pdfmark--` — and a plain CMYK conversion leaves `/Group << /CS /DeviceRGB >>` behind: the objects are CMYK, the compositing is not. Both reproduced against Ubuntu 24.04's 10.02.1, downloaded and run. An old Ghostscript is, for press purposes, no Ghostscript, so it raises the same hard error. This extends decision 2 rather than departing from it: `warnings[]` may degrade a *claim*, never the pixels. CI builds 10.07.1 from source rather than test against a version the product refuses.
4. **veraPDF cannot validate PDF/X, so the planned probe was unsatisfiable** — the third such case in this project, after B2's `/Author` regex. Its built-in profiles are PDF/A, PDF/UA and WTPDF. Conformance is asserted structurally instead, one X-4 requirement at a time, which is a harder test than a validator's green tick.

One thing was added beyond the plan: a cmyk job that also asks for PNG now warns that **the PNG is RGB**. Chromium and sharp have no CMYK raster path, and a "cmyk" job silently handing back an sRGB PNG is the same shape of lie the phase exists to prevent.

**Goal:** `colorIntent: "cmyk"` produces a press-ready CMYK PDF when Ghostscript is present, and a clear, immediate error when it isn't. Never a crash — and **never a silently-RGB file shipped as press output.** For a deterministic print tool, quietly delivering the wrong color space is the same class of bug as A1.

Standing invariants, unchanged from Phase 7: paper size is never auto-set; validation lives only in `scripts/validate.js`. One clarification the second invariant forces: Ghostscript availability is **environmental**, not a property of the spec — so the spec-shape check (`colorIntent` enum) stays in the validator, and the "is gs actually installed" check lives in `renderJob()`. Each sub-phase ends with a cold `npm test`, a commit, and a push, same as 7.

**Decisions taken here (veto before starting, not after):**
- The CMYK job's PDF deliverable **is** the converted file, converted in place before `writeLatest()`. No `--rgb` intermediate is kept — the job spec reproduces it on demand, which is the whole point of the spec.
- `cmyk` requested + Ghostscript absent = **hard error before anything renders**, naming the fix. Not a warning, not an RGB fallback.
- No ICC profile on disk = plain CMYK conversion with a `warnings[]` entry (the A10 channel) saying no output intent was embedded. Honest degradation — the tool never claims PDF/X compliance it didn't produce.

### 4A — Detection & wrapper — **DONE**

1. **`scripts/press.js`** — `findGhostscript()`: honor `HIG_GS` first (an explicit path; the literal `0` forces "absent", so the missing-gs path is testable on a machine that has it — same trick as `HIG_OUTPUTS_ROOT`), then PATH (**`gswin64c.exe`** on Windows, never `gs` — the press-ready bug; `gs` on POSIX for CI), then `C:\Program Files\gs\gs*\bin`. Export `isPressAvailable()`.
2. **`convertToCmyk(pdfIn, pdfOut, { icc })`** — Ghostscript `pdfwrite` with the flag set mined from press-ready's `src/ghostScript.ts`: `-sColorConversionStrategy=CMYK`, `-dProcessColorModel=/DeviceCMYK`, `-dPDFX` + a generated `PDFX_def.ps`. **Pin `-dCompatibilityLevel=1.4`:** PDF/X-3 is PDF-1.4-based anyway, and 1.4 forbids object streams — which keeps converted PDFs inspectable by the same regex tooling (`pdfinfo.js`) the whole suite depends on. This is the pdf-lib `useObjectStreams` lesson (7E) applied preemptively.

*Exit tests (`scripts/presstest.js`, added to `npm test`, self-skipping):* with `HIG_GS=0` the suite prints SKIP lines and exits 0 — the core app must stay green on a machine with no Ghostscript. With gs present: the converted poster PDF still measures **exactly 612×792 pt**; text content unchanged (pdfInfo normalize-compare); fonts still embedded (`/FontFile` count > 0); **zero `/ObjStm`**; and `/Author` (the B2 metadata) survives conversion — Ghostscript may rewrite the file, not lose the job's provenance.

### 4B — ICC profile & PDF/X level — **DONE** *(closes both remaining research questions; the profile itself is Sam's to source)*

3. **ICC slot:** `assets/icc/` (gitignored except its own README). Resolution order: `HIG_ICC_PROFILE`, then `assets/icc/press.icc`. With a profile: full PDF/X output intent, ICC embedded. Without: the degradation above.
4. **Sourcing (decision gate, owner: Sam, ~10 minutes):** `assets/icc/README.md` documents where to legally obtain GRACoL2013 (Idealliance CRPC6) or SWOP2013. **Do not commit a profile** unless its license explicitly permits redistribution — verify, don't assume.
5. **PDF/X-4 probe (one-time, manual):** attempt X-4 output; validate one file with veraPDF locally (it's Java — a manual probe, never a CI or runtime dependency). Whatever level actually validates is the product's claim; record the verdict in RESEARCH_REPORT.md. If only X-3 validates, the answer is X-3 and we stop wanting X-4.

*Exit tests (presstest):* with a profile present, the converted PDF's catalog carries `/OutputIntents` with subtype `/GTS_PDFX` and its Info carries `GTS_PDFXVersion` (walk the catalog with pdf-lib — precise, and already a dependency). Without a profile, conversion still succeeds and the render result's `warnings[]` says why it isn't PDF/X.

### 4C — Integration: renderJob, API, UI — **DONE**

6. **`renderJob()`**: when `run.colorIntent === 'cmyk'` — check `isPressAvailable()` **before composing anything** and throw the clear error if not ("colorIntent 'cmyk' requires Ghostscript; install it or use 'rgb'"); otherwise render → pdf-lib metadata stamp → convert in place → `writeLatest()`. Zero files written on the failure path.
7. **`GET /api/capabilities`** → `{ press: boolean }`. The UI gains a Color intent control in Setup (it does not exist today — check the form, not memory), disabled with a hint when press is unavailable. No validator copy in the UI; the enum stays in `validate.js`, the environmental check stays in `renderJob`.
8. **GUARD.md**: update variable #6 (`colorIntent`) with the real behavior and the ICC slot convention; add the "a press job is converted in place" fact.

*Exit tests (presstest + apptest):* cmyk job with gs → the deliverable and `latest.pdf` are the converted file; with `HIG_GS=0` → CLI exits nonzero and `/api/render` returns 400, both messages containing "Ghostscript", and **no output file exists afterward**; apptest: `/api/capabilities` drives the control's disabled state.

### 4D — CI — **DONE**

9. `sudo apt-get install -y ghostscript` in the workflow, so the full conversion path runs on every push even if the dev machine never installs it. While touching the file, bump `actions/checkout` and `actions/setup-node` to v5 — kills the Node-20 deprecation annotation on every run.

*Exit:* `gh run watch` green, with presstest's **non-skip** path visibly exercised in the CI log (grep the log for the conversion PASS lines; a suite that silently skipped in CI proves nothing).

---

## Phase 5 — End-to-End Proof & Hardening *(~small; item 2 needs a human at a printer)*

1. **The LLM loop, cold (agent-executable).** In a fresh session with no prior context, follow README → GUARD only: elicit the fourteen variables, write a *new* job spec (not an example), CLI render, confirm routing and warnings. Any friction found is a **docs bug** — fix the docs, not the reader. *Exit:* the loop completes without consulting anything outside README/GUARD/schema.
2. **Physical print & measure (owner: Sam).** Print `latest.pdf` of the poster (Letter) and the legal form (Legal) with the print dialog set to **Actual size** — "Fit to page" is how a perfect 612×792 pt file gets silently shrunk ~4% and "fails" the ruler. Measure: the full-bleed poster covers the sheet edge-to-edge; the legal form's top margin reads 0.9 in ± 1 mm and the running header sits at the same offset on page 2 as page 1. *Exit:* the numbers and the printer model recorded in HANDOFF.md. If a measurement misses, that's a finding, not a failure — diagnose before "fixing".
3. **Docs close-out.** Blueprint §4c checklist complete; INITIAL_BLUEPRINT bumped to v1.1; Phase 4's PDF/X and ICC verdicts folded into RESEARCH_REPORT.md so all five research questions carry recorded answers. HANDOFF's "Open questions" section goes to zero.

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

## Phase 8 — Residuals from Phase 7's close-out — **DONE 2026-07-10**

All three resolved: two done, one confirmed still not actionable.

1. **`fonttest.js` has no assertion counter — DONE.** It is now a suite with the same `check()` harness as the others: **8 assertions** (WOFF2 embedded, TTF embedded, both subsetted, both carry a `/FontFile*`, no silent system-font fallback, no `/ObjStm`, both samples survive as extractable text). It printed a verdict and exited non-zero before; it could not fail one check at a time.
2. **A9's mid-render retry branch — DONE, and it did not flake.** `/api/_test/crash-browser` takes `{ delayMs }`, which schedules the kill instead of performing it. apptest measures a warm legal-form render, schedules the crash at 40% of that (a hardcoded millisecond count is how this test would have become flaky on a slow CI box), and then asserts three things: the render still returns 200, the *server's own stderr* carries `shared Chromium died — relaunching and retrying once`, and the retried render produced a real PDF. That middle assertion is the point — a 200 alone cannot distinguish a retried render from one the kill simply missed.
3. **Paged.js 0.5 watch — still not actionable.** Re-checked 2026-07-10: `npm view pagedjs dist-tags` gives `latest: 0.4.3`, `beta: 0.5.0-beta.2`; the package was last published 2024-10-04. No stable tag, so nothing to upgrade to. The NLnet-funded PDF/UA tagging work remains the thing worth waiting for. Re-check when a stable 0.5.x appears.

### Original plan (for reference)

1. **`fonttest.js` has no assertion counter.** It's real coverage (embedding + subsetting for both formats) that contributes 0 to the suite total and can't fail per-check. Give it the same `check()` harness as the other suites (~6 assertions: WOFF2 embedded, TTF embedded, both subsetted, no Arial fallback, no `/ObjStm`). *Exit:* suite total rises accordingly and README/HANDOFF counts updated in the same commit.
2. **A9's mid-render retry branch is untested.** `getBrowser()` heals a browser that died *between* renders; nothing exercises one that dies *during* `renderJob()`. Either extend `/api/_test/crash-browser` with `{ delayMs }` and fire it mid-way through a slow legal-form render — or write it off in HANDOFF as accepted risk. Budget: one honest attempt; if it flakes twice, document and stop. A flaky test is worse than a documented gap.
3. **Paged.js 0.5 watch.** Still no stable release as of 2026-07-10. Re-check when Phase 4 starts; the NLnet-funded PDF/UA tagging work is the thing worth waiting for. Not an action item until a stable tag exists.

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
