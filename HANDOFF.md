# Handoff — HTML Image Generator

*Written 2026-07-09, current as of 2026-07-10. Read this first. **Phases 0–3, 6 and 7 are built, green, and in CI**; Phases 4 and 5 remain planning. The "facts that will bite you" at the bottom are the expensive part.*

---

## What this project is

A **deterministic image generator for print**. Instead of a diffusion model guessing pixels, an LLM writes an **HTML + CSS document at exact physical dimensions** (US Letter 8.5×11in, Legal 8.5×14in), and headless Chromium renders it to a print-ready PDF (vector) and/or a 300-DPI PNG.

**Why:** diffusion models can't do crisp text, exact margins, precise alignment, or reproducibility — the four things print work actually needs. HTML/CSS gives all four, and LLMs are exceptionally fluent in it.

**Two hard requirements set by the owner:**
1. **Letter and Legal paper sizes** must both be first-class options, always explicitly confirmed, never silently defaulted.
2. The whole thing must be a **local app that launches with one command and opens its own UI**, while remaining drivable by *any* LLM in *any* IDE via plain CLI/HTTP.

---

## Current state

| File | What it is | Status |
|---|---|---|
| [INITIAL_BLUEPRINT.md](INITIAL_BLUEPRINT.md) | The concept, the Question Guard, the decided toolchain, output routing | **v1.0 — current** |
| [RESEARCH_REPORT.md](RESEARCH_REPORT.md) | Cited deep research: 23 sources, 25 claims adversarially verified (21 confirmed / 4 refuted) | **Complete**, 3 open questions now answered |
| [BUILD_PLAN.md](BUILD_PLAN.md) | Phased build plan with exit tests per phase | **v1.1 — current** |
| [GUARD.md](GUARD.md) | The Question Guard, as direct LLM operating instructions | **Live** |
| [README.md](README.md) | Entry point for humans and agents | **Live** |
| `HANDOFF.md` | This file | — |

**Phases 0–3, 6 and 7 are built and green. The product exists.** `npm start` (or double-clicking `Start.cmd`) boots a server in ~1s, picks a free port, and opens the browser on a live true-size preview. `npm test` runs five suites, all passing, and **CI runs them on every push** (`.github/workflows/test.yml`, ubuntu-latest, Node 22):

- `validatetest.js` — **100.** Pluralize idempotency (the `posterses` regression), CSS-length parsing, 24 malformed-spec cases each rejected on the right field, `isInside()` containment including the sibling-prefix trap, the `pdfOnly` rule, and every shipped job file walked through both the runtime validator and the published schema.
- `selftest.js` — **36.** Letter PDF exactly 612×792 pt, Legal 612×1008 pt, Letter PNG @300 exactly 2550×3300 px reading back `density: 300`. Path-traversal and Windows-reserved-name rejection. Both build-time probes. A1 (bleed PNG is a trim render), A2 (content is text), A4 (variants don't overwrite), A7 (nothing lands in the user's `outputs/`).
- `templatetest.js` — **67.** All three reference templates: correct page box, expected page count, no unfilled `{{placeholders}}` surviving into the PDF, every declared font embedded, no silent fallback to Arial, PDF metadata stamped, tagging preserved, no object streams.
- `fonttest.js` — WOFF2 and TTF both embed and subset. *(A probe/report script — it prints a verdict and exits non-zero on failure, but has no assertion counter, so it contributes 0 to the total.)*
- `apptest.js` — **94.** Spawns the real server, drives the real UI with a real browser: cold start under budget, the guard blocks render until paper size is chosen, preview measures 816×1056 (Letter) / 816×1344 (Legal) CSS px, the legal form flows to 2 pages with a running header and page counter, editing a template on disk hot-reloads the preview, the gallery renders one real thumbnail per template, template config drives the form, invalid fields block Render with inline messages, dark mode switches, a UI render matches a CLI render, a slugified job name saves, the picker only offers loadable jobs, a SIGKILLed Chromium heals, placeholder warnings reach the drawer, a UI render persists its spec, and image slots offer real assets.

**297 assertions total.**

**Next action is Phase 4** (gated CMYK via Ghostscript) or Phase 5 (print and measure). Both are optional; the MVP is done and the audit is fully remediated.

### What the build proved (research questions closed)

- **Native `@page` margin boxes work** in Chrome 148 — running headers, footers, and `counter(page)`/`counter(pages)` all render without Paged.js. `legal-form.html` uses them for real. **Paged.js is engaged only for bleed/crop marks (print) and pagination (preview).**
- **No deviceScaleFactor truncation** at DSF 3.125 — the known Puppeteer high-DSF bug does not reproduce.
- **WOFF2 and TTF embed identically** (subsetted `/FontFile2`). Prefer WOFF2. Chromium writes **no `/ObjStm`**, so PDF fonts are regex-inspectable — that's how the tests check them.
- Paged.js has **no 0.5.x stable release**; pinned to **0.4.3**. The research report said otherwise.
- **Chromium's rasterizer is not bit-exact across processes.** The same spec rendered by the UI (warm browser) and the CLI (fresh browser) produced PNGs differing in ~24 of 25M subpixels, max delta 2/255 — gradient/glyph antialiasing noise. The PDF is vector and identical. Don't write hash-equality tests against PNG renders; assert dimensions, DPI, and a pixel tolerance.

---

## The decisions already made (don't relitigate these)

These came out of the deep research pass. The evidence and vote counts are in RESEARCH_REPORT.md.

- **Puppeteer** is the render engine. Puppeteer and Playwright drive the *identical* Chromium `Page.printToPDF` path — verified in Playwright's own source — so fidelity is the same. Puppeteer wins because `pagedjs-cli` is Puppeteer-backed (one shared Chromium). Blog claims that Playwright is faster were **refuted** by the verification panel.
- **Paged.js** is required, not optional. The CSS `@page` `bleed` and `marks` descriptors are supported by **no browser** as of mid-2026, so bleed and crop marks have no native path. Paged.js also provides the dimensionally accurate in-browser page preview.
- **Exact page sizes come free** from `@page { size: letter | legal; }` plus Puppeteer's `preferCSSPageSize: true`.
- **PNG DPI needs a fix.** `deviceScaleFactor = targetDPI / 96` (300 DPI → 3.125) gives exact pixel counts, but **Chromium never writes DPI metadata into PNGs** — Photoshop would read 72 DPI. A **sharp** post-step stamps the `pHYs` chunk.
- **CMYK is Ghostscript**, gated and optional. Ghostscript ships **no** press ICC profile; a GRACoL/SWOP profile must be sourced separately. The core app must never require Ghostscript.
- **No Electron, no Tauri.** Puppeteer already ships a full Chromium for rendering; bundling a second runtime for the UI adds hundreds of MB for zero fidelity gain. Architecture is a **localhost Fastify server + the system browser**, auto-opened by the `open` package. (This part is engineering judgment — the research produced no verified claims on app architecture. Tauri v2 remains the upgrade path if a native shell is ever wanted.)
- **Nothing existing fits.** pdfme uses JSON schemas, not HTML/CSS (but its WYSIWYG designer is worth studying). react-print-pdf renders via a *cloud API* and is unmaintained since Sep 2024. Building is justified.

### The three embraced caveats

Rather than dodge the limits of HTML/CSS, each became a feature:
- **Can't draw photos** → layouts declare **image slots**; diffusion/stock/photos fill the art zones while the deterministic layer owns all text and dimensions.
- **RGB only** → optional **Ghostscript CMYK/PDF-X** post-step for press.
- **Fonts must be embedded** → `fonts/` with a manifest and `@font-face` conventions; total typographic control, which diffusion can never offer.

---

## The two core mechanics to understand

### 1. The Question Guard

**No output is generated until it's satisfied.** Before rendering, the LLM elicits or confirms ~14 variables: project/client, paper size, orientation, output format, DPI, color intent, margins, bleed/crop marks, document type, content, style direction, typography, image slots, variants. (Blueprint §3.)

Behavior: infer sensible defaults and **state them for confirmation** — don't interrogate the user fourteen times. But **Letter vs. Legal is always explicitly confirmed.** The answers are saved to `jobs/<name>.json` so any render is reproducible and re-editable.

### 2. Output routing (auto-created folders)

Renders never dump into a flat pile. Path is `outputs/<project-slug>/<doctype-plural>/`, created recursively **on demand** — no config file, no pre-registration. A new client or a doc type you've never used just works on first render.

```
outputs/south-end/flyers/spring-menu-launch--letter--2026-07-09-142301.pdf
outputs/south-end/flyers/latest.pdf        ← copy, not symlink (Windows)
```

Slugification doubles as a security boundary: reject path traversal (`../../etc`) and Windows reserved names (`CON`, `NUL`, `COM1`…), since project names are free text that becomes a filesystem path. After rendering, the file **auto-opens** in the default viewer (`--no-open` suppresses; batch runs skip).

---

## How the app is put together

`server/index.js` (Fastify) keeps **one warm Chromium** and calls the same `renderJob(spec, { browser })` the CLI calls — the UI adds no rendering logic of its own. It serves `server/ui/`, plus `templates/ fonts/ assets/ outputs/` and the Paged.js polyfill; exposes `/api/{schema,templates,jobs,projects,outputs,render,preview,resolve-path,reveal}`; listens on port 0 and `open()`s the browser at whatever port it got.

The UI (`server/ui/`, plain HTML/JS, no framework) is the Question Guard as a form: everything defaulted and shown for correction, **paper size demanded** — the Render button stays disabled and reads "Choose a paper size" until you pick one. The preview iframe renders the composed document through the Paged.js polyfill (`composeDocument(spec, { preview: true })`) so page boxes are discrete and true-size; chokidar watches `templates/` and `jobs/` and pushes a WebSocket message that reloads the iframe.

**Phase 6A is DONE (2026-07-09)** — validation and correctness, prompted by the first real user session. Three bugs it fixed:

1. **`posters` → `posterses/`.** The UI's doc-type combo is populated from existing `outputs/*` folder names, which are already plural, and `pluralizeDocType()` pluralized them again. It is now **idempotent** — `pluralizeDocType(pluralizeDocType(x)) === pluralizeDocType(x)` for every doc type the UI can offer.
2. **No validation anywhere.** `scripts/validate.js` is now the single validator, called from inside `applyDefaults()`, so the CLI, the HTTP API, and the UI all enforce it and cannot drift. It rejects bad enums, out-of-range DPI, non-CSS-length margins, missing/escaping templates, nonexistent image slots, and **unknown keys** (a typo'd `paperSze` errors instead of silently defaulting). Errors are field-level: `[{ field, message }]`.
3. **The UI let every wrong combination happen silently.** Templates now declare `<meta name="template-config">` (paper, orientation, margin, outputs, description, titleField). Selecting one applies orientation/margin/outputs and **recommends** a paper size; picking a different one shows a mismatch warning. Invalid fields get inline messages, and Render disables with the button naming the blocker ("Fix margin"). Job names derive from content instead of `untitled`.

**Deliberate deviation:** the plan said template selection should auto-apply `paperSize`. It must not — that would silently choose the one variable the Question Guard exists to protect. Templates recommend; the user still confirms.

**Phase 6B is DONE (2026-07-10)** — the redesign. Template gallery whose thumbnails are rendered by the real engine (so a card can never misrepresent its template), a three-step guided rail (Template → Setup → Content), a preview toolbar (paper badge with physical dimensions, page count, fit-page/fit-width/100%), an empty state, a recent-outputs panel, humanized field labels, and a design-system pass with dark mode using the shipped Inter.

Two fixes came from *looking* at the app rather than testing it:
- **The background-tab guard was wrong.** It gated on `document.hidden`, but some environments report a visible tab as hidden — the preview then never rendered at all. It now always starts the render, arms a 4s watchdog to detect a stall, and re-runs on `visibilitychange`. Gate on the symptom, not the proxy.
- **Preview chrome hardcoded a grey backdrop** that clashed with dark mode, and left a scrollbar sliver. Now transparent with the scrollbar hidden. Fit-page fits *one page*, not the whole document.

**Phase 7 is DONE (2026-07-10)** — audit remediation. All 11 defects and all 6 gaps in [AUDIT.md](AUDIT.md) are closed, in five sub-phases, each ending with a cold `npm test` and a push.

- **7A — the two premise bugs.** A bleed job's PNG captured the Paged.js-restructured DOM (content shifted by the bleed offset, sheet edge showing); it now composes a *second, non-paged* document for the PNG, while the PDF keeps its bleed. And `{{placeholder}}` injected values as raw HTML — they are now escaped, with `{{{key}}}` as the explicit opt-in for markup.
- **7B — data loss.** Saving a job named `menu: spring` wrote an illegal NTFS filename and 500'd. Variants that overrode only `content` silently overwrote each other (now numbered `--v2`, `--v3`). `jobs/example.json` pointed at a hidden fixture template and broke the form; it's gone, and the picker only offers jobs it can load.
- **7C — test isolation, then CI.** The suites rendered into the user's `outputs/`. The outputs root is now resolved at call time from `HIG_OUTPUTS_ROOT`; the API speaks `outputs/…` URL paths that are a namespace over wherever it lives. Then GitHub Actions, which is only meaningful once the tests don't dirty the tree.
- **7D — hardening.** `startsWith` containment → `isInside()`; `pdfOnly` enforced in the validator instead of being a UI hint; a crashed Chromium relaunches instead of bricking the server; unfilled-placeholder warnings travel back to the caller; the published schema stopped rejecting its own examples.
- **7E — reproducibility & polish.** Every UI render persists its spec (the Guard's promise, now enforced from both sides). PDF Author/Subject/Creator via `pdf-lib`. Image-slot picker with live previews. Favicon. All five dependency majors upgraded, none needed pinning back.

Phases 4 (gated CMYK) and 5 (print and measure) remain open.

---

## Open questions

Three of the five are now closed by build-time tests. Two remain — both in Phase 4. Don't assume; test.

**Still open:**

1. **Ghostscript 10.x PDF/X levels:** does it do X-4? The "X-1 and X-3 only" claim was refuted, so its real coverage is unknown. Validate output with veraPDF. (Phase 4.)
2. **US CMYK ICC profile:** where to legally obtain/redistribute GRACoL2013 or SWOP. (Phase 4.)

**Closed:**

3. ~~Font embedding, WOFF2 vs TTF~~ — both embed and subset identically; prefer WOFF2. (`scripts/fonttest.js`.)
4. ~~Chrome native `@page` margin boxes~~ — supported in Chrome 148, `counter(page)` included. Paged.js is not needed for headers/footers. (`selftest.js` Probe B, and `legal-form.html` uses them.)
5. ~~deviceScaleFactor truncation~~ — does not reproduce at DSF 3.125. (`selftest.js` Probe A.)

---

## Deliberate v1 exclusions

Data merge (CSV → N certificates), n-up imposition / label sheets (Avery), A4 / Tabloid / custom sizes, a WYSIWYG editor, single-executable packaging. All stack cleanly on this architecture later — none belong in v1.

---

## Facts that will bite you

- Paged.js **refuses `file://`** — the renderer must serve the document over HTTP even for a one-shot CLI render.
- The Paged.js polyfill **runs once on load** — hot reload does a full iframe reload rather than re-invoking the `Previewer`.
- **Paged.js chunks pages via `requestAnimationFrame`, which Chrome throttles to a standstill in a background tab.** Render a preview while the tab is hidden and it stalls forever with an empty `.pagedjs_pages` container and *no error*. `app.js` defers previews while `document.hidden` and re-runs on `visibilitychange`. This is easy to hit for real: start the app, switch to your editor, save a template.
- **Paged.js puts margin-box text in a CSS `::after { content }`, not in the DOM.** `textContent`/`innerText` return empty; read `getComputedStyle(el, '::after').content`. Counters stay unresolved there (`counter(page)`) — to assert "Page 1 of 2" you must read the rendered PDF.
- **`iframe.src` flips the instant you assign it**, while the old document stays loaded. Waiting for "src changed + polyfill done" silently measures the *previous* page. Clear a flag on the current document, then wait for it to come back true.
- Chromium writes **no DPI metadata** into PNGs. The pixels are right; the file lies about its physical size until sharp fixes it.
- **Chromium holds keep-alive sockets open after `page.close()`.** A bare `server.close()` on the throwaway render server hangs forever. Call `server.closeAllConnections()` first — this cost real time to find, and it only showed up on multi-render (`variants`) jobs.
- **`sharp`'s `.stats()` ignores pipeline ops** like `.extract()` — it always measures the source image. To measure a region, pull `.raw()` pixels. A test that gets this wrong reports a false failure.
- A template must **not** declare `@page { size: … }` — the renderer injects size/margin/bleed from the job spec, and a hardcoded size wins silently.
- **`pluralizeDocType()` must stay idempotent.** The UI feeds it its own output (folder names are already plural). Any change to it needs `pluralizeDocType(pluralizeDocType(x)) === pluralizeDocType(x)` to hold, which `validatetest.js` asserts. Known limitation: `canvas` is treated as already-plural.
- **Validation lives in exactly one place** (`scripts/validate.js`, called from `applyDefaults()`). Do not add a second copy in the UI — it will drift. The UI calls `POST /api/validate`.
- In the UI, the form's `input` handler keys off `e.target.name`. Dispatching `input` on the **form** rather than the changed control skips template-config application — a trap that produced two false test failures.
- **Thumbnail generation must stay serialized.** Boot-time generation and the file-watcher's regeneration overlapped, and two writers on the same PNG intermittently left the gallery empty on Windows. `ensureThumbnails()` queues; writes go to a temp file and are renamed.
- **A card click on the already-selected template is deliberately a no-op**, so a test that clicks it and then waits for a fresh preview will hang.
- Don't gate UI behaviour on `document.hidden` — some environments (including this repo's own browser automation) report a visible tab as hidden. Detect the actual stall.
- On Windows, Ghostscript's binary is **`gswin64c.exe`**, not `gs` — the unmaintained `press-ready` CLI trips on exactly this.
- `press-ready` is **reference material only** (last release Aug 2020, hardcoded to Japan Color 2001 Coated). Mine its Ghostscript flags from `src/ghostScript.ts`; do not depend on it.

### Earned in Phase 7

- **A bleed job is two documents, not one.** The PDF gets the Paged.js composition; the PNG must be composed again with `{ screen: true }`. Screenshotting the paged DOM is exactly the A1 bug. `composeDocument()` takes the flag; `renderJob()` calls it twice when a paged job also wants PNG.
- **`pdf-lib`'s `save()` defaults to `useObjectStreams: true`.** That would compress the font descriptors into an `/ObjStm` — and the whole reason `pdfinfo.js` can inspect fonts by regex is that Chromium writes none. Always `save({ useObjectStreams: false })`. `templatetest` asserts `objStreams === 0`.
- **`pdf-lib` writes `/Author` as a UTF-16BE hex string** (`/Author <FEFF0053…>`), not `/Author (South End)`. A literal-string regex will report a false failure. Read the Info dict through pdf.js (`pdfInfo().info`), which decodes both.
- **The delta bound on a PNG comparison is not the discriminating one; the ratio is.** Cross-process Chromium antialiasing can differ by 5/255 on a few hundred of 25M subpixels. A structural bug (A1) moves ~1% of subpixels. Bound the *ratio* tightly (0.01%) and leave the per-subpixel delta loose. Same-process comparisons can keep `delta <= 2`.
- **`renderJob()` returns `{ outputs, warnings }`, not an array.** Every caller destructures. Warnings carry unfilled placeholders back to the CLI (stderr), the API, and the UI drawer.
- **The API speaks `outputs/…` URL paths, not project-relative ones.** The outputs root is `HIG_OUTPUTS_ROOT` or `<project>/outputs`, resolved *at call time* — it can live outside the project entirely (the test suites put it in a temp dir), so `path.relative(PROJECT_ROOT, …)` is wrong. Use `toOutputsUrlPath()` / `fromOutputsUrlPath()`.
- **`getOutputsRoot()` must never be captured at import time.** The suites set the env var *after* `paths.js` has already been imported (ESM imports hoist). Anything that caches the root at module scope silently ignores the override — the server reads it once at boot on purpose, since its env is fixed by then.
- **Every UI render writes a job file** (B1), so `jobs/` grows during a test run. `apptest` snapshots the directory up front and deletes whatever is new. For the same reason, `thumbs.js` prefers `*-example.json` when choosing a template's showcase job — otherwise a job saved as `aaa.json` would quietly become the poster's gallery thumbnail.
- **A `_`-prefixed template is a fixture, invisible to the gallery.** A job spec pointing at one is therefore unloadable in the UI, which is why `/api/jobs` filters by "template is in the gallery" and not merely by filename.
- **Chromium's sandbox needs unprivileged user namespaces, which Ubuntu 24.04 blocks by AppArmor.** CI relaxes `kernel.apparmor_restrict_unprivileged_userns` rather than threading `--no-sandbox` through five `puppeteer.launch()` sites.
- **A9's retry branch is belt, not braces.** `getBrowser()` notices `browser.connected === false` and relaunches *before* `renderJob()` runs, so the crash test exercises the lazy relaunch, not the one-shot retry. A browser that dies *mid-render* is what the retry catches, and nothing tests that path.
