# Audit — 2026-07-10

*Full-project audit for bugs and missing capability, followed by targeted research. Method: hostile re-read of every module, five empirical probes against the real renderer, four web-research checks. Items marked **[probed]** were demonstrated, not inferred.*

> **Status: all 11 defects and all 6 gaps are closed.** Remediated in [BUILD_PLAN.md → Phase 7](BUILD_PLAN.md) (7A–7E, 2026-07-10). The suite went 212 → **297 assertions** and now runs in CI on every push. Each item below carries the sub-phase that fixed it.
>
> **Three deviations from the plan, and why:**
> 1. **B2's exit test as written was wrong.** It said "pdfinfo-style regex finds `/Author (South End)`". `pdf-lib` writes `/Author` as a UTF-16BE hex string (`<FEFF0053…>`), so that regex can never match. `pdfInfo()` now returns the Info dict decoded by pdf.js instead. Separately, `pdf-lib`'s `save()` defaults to `useObjectStreams: true`, which would have compressed the font descriptors that `pdfinfo.js` inspects by regex — pinned to `false` and asserted.
> 2. **`isInside()` (A6) landed in 7C, not 7D.** 7C rerouted `/api/reveal` through the outputs root, and a `startsWith` containment check there would have been wrong the moment the root moved. The other three call sites and the unit tests stayed in 7D.
> 3. **One bound was loosened.** apptest's UI-vs-CLI PNG comparison required `maxDelta <= 2`, which was a single observation mistaken for a law: under load, cross-process Chromium antialiasing differs by up to 5/255 on ~0.0005% of subpixels. The **ratio** is the discriminating bound (A1's bug moved 1.1% of subpixels, four orders of magnitude over), so the ratio stayed at 0.01% and the delta ceiling moved to 8. A1's own test compares two *same-process* renders and keeps `delta <= 2`.

---

## A. Confirmed bugs

### A1. PNG output is corrupted on bleed/crop-mark jobs **[probed]** — worst bug found — **FIXED (7A)**
`renderJob` composes the document once. When the spec asks for bleed, that composition includes the Paged.js polyfill — correct for the PDF, wrong for the PNG: the screenshot captures the polyfill-restructured DOM (content shifted by the bleed offset, corner markers pulled inward, a sliver of the Paged.js sheet edge visible). Probe: bleed-PNG diverges from plain-PNG by **1.1% of subpixels** against a 0.0001% noise floor; visual inspection confirms the shift. No test caught it because no test renders PNG+bleed.
**Fix:** compose a second, non-paged document for the PNG path (PNG is a trim-size screen render; bleed is a print concept). Add the missing test.

### A2. Job content is parsed as HTML **[probed]** — **FIXED (7A)**
`{{placeholder}}` substitution injects values raw. Probe: content `<b>bold?</b>` rendered as a bold element; text like `use <Enter> to submit` would silently swallow "<Enter>" as an unknown tag. For a deterministic text-perfect print tool this is a correctness hole, not just hygiene.
**Fix:** HTML-escape all content values by default; opt into raw markup explicitly (e.g. `{{{key}}}`).

### A3. `/api/jobs` writes the raw name as a filename **[probed]** — **FIXED (7B)**
`name: "menu: spring"` passes validation (it slugifies fine) but the save handler writes `menu: spring.json` — a colon is illegal on NTFS → unhandled 500.
**Fix:** save as `jobs/<slugify(name)>.json`, same as the output path does.

### A4. Variants without a `name` override silently overwrite each other — **FIXED (7B)**
All runs share one `when` timestamp (by design), so a variant that only overrides `content` produces the *identical* output path as the base run — last write wins, no error. The certificate example dodges this only because its variant happens to rename itself.
**Fix:** auto-suffix (`--v2`) or reject duplicate effective names across runs.

### A5. Loading `example.json` breaks the UI form — **FIXED (7B)**
It references `_selftest.html`, which is filtered out of the gallery/select (underscore = test fixture). Loading it sets `select.value = ''` and the form is in a state the guard logic never anticipated.
**Fix:** point the example at a real template, and make the picker skip jobs whose template isn't listed.

### A6. Path-prefix checks are subtly wrong in four places — **FIXED (7D)**
`abs.startsWith(PROJECT_ROOT)` / `startsWith(OUTPUTS_ROOT)` / `startsWith(templatesDir)` (render.js static server, `/api/reveal`, validate.js template + imageSlots). A sibling directory named e.g. `outputsX` passes the check. Severity is genuinely low — localhost-only, requires an attacker-created sibling dir — but the pattern is wrong and cheap to fix.
**Fix:** `path.relative()`-based containment (or compare against root + `path.sep`).

### A7. Tests pollute the user's real outputs — **FIXED (7C)**
`selftest`/`templatetest`/`apptest` write into `outputs/south-end/*` and `outputs/demo/*` — the Recent Outputs panel then shows `selftest-letter`, `audit-probe`, etc. next to real client work.
**Fix:** honor an `OUTPUTS_ROOT` env override; tests point it at a temp dir.

### A8. `pdfOnly` is only a UI hint — **FIXED (7D)**
The CLI happily renders `legal-form` with `outputs: ["png"]` — a viewport screenshot of page 1 of a flowing document, presented as if it were the document.
**Fix:** enforce in the validator using the template's own config (warning or rejection).

### A9. Warm-Chromium crash bricks the server — **FIXED (7D)**
If the shared browser dies, every subsequent render 400s until the app is restarted, with no self-healing.
**Fix:** relaunch on `disconnected`.

### A10. Placeholder warnings never reach the caller — **FIXED (7D)**
Unfilled `{{placeholders}}` log to the *server* console only. The UI user and API caller ship a render with holes in it and are never told.
**Fix:** return `warnings: []` in the render result; surface in the UI drawer.

### A11. `jobs/schema.json` rejects its own examples — **FIXED (7D)**
`additionalProperties: false` + no `$schema` property, while every shipped job file carries `$schema`. Our runtime validator allows it; the published schema contradicts it. One-line fix.

## B. Missing features (the gap between "works" and "perfect")

- **B1. UI renders aren't reproducible.** — **DONE (7E).** The Guard's core promise is "the job spec is the saved record of one generation" — the CLI enforces it structurally (it renders *from* a file), but the UI could render without ever persisting a spec. Every successful `POST /api/render` now writes `jobs/<slug>.json` and returns its path.
- **B2. PDF metadata post-step.** — **DONE (7E).** Verified locally: Chrome 148 writes `/Title` from `<title>` and tags PDFs (StructTreeRoot present — accessibility for free), but Author/Subject/Keywords are not settable and Producer reads `Skia/PDF m148`. Shipped as a `pdf-lib` post-step setting Author/Subject/Creator. Puppeteer's experimental `outline` option was skipped, as planned.
- **B3. Image-slot picker** — **DONE (7E).** Was: bare text inputs. Now `GET /api/assets` feeds a `<datalist>` on each slot, plus a live preview beside the field that hides itself when the path doesn't resolve.
- **B4. No CI.** — **DONE (7C).** `.github/workflows/test.yml`: push + PR, ubuntu-latest, Node 22, `npm ci && npm test`, plus a step asserting the suite left the tree clean.
- **B5. Favicon/title polish** — **DONE (7E).** Inline SVG favicon (the header mark) and a `theme-color` matching the accent.
- **B6. Dependency majors available:** puppeteer 25 (ESM-only, Node ≥22 — both fine for us), sharp 0.35, chokidar 5, @fastify/static 9, open 11. No urgency; upgrade deliberately, not reflexively.
  **DONE (7E).** All five upgraded; nothing needed pinning back. `engines.node` moved `>=20` → `>=22` to match puppeteer 25's floor (CI already ran Node 22). Full cold suite green on the first attempt: puppeteer's ESM-only move is a no-op for us (we were already ESM), and the `executablePath()` async change touches no call site of ours. `pagedjs` stays at 0.4.3 — still no 0.5 stable.

## C. Research notes (what was checked, what came back)

1. **PDF metadata:** no native Chromium/Puppeteer support for Author/Subject/Keywords ([puppeteer#3054](https://github.com/puppeteer/puppeteer/issues/3054)); pdf-lib post-write is the accepted pattern. `/Title` **is** written from `<title>` — verified against our own output, which several older sources get wrong.
2. **Tagged + outline:** `tagged` is effectively on (our PDFs carry `StructTreeRoot`/`MarkInfo`); `outline` exists but is experimental ([PDFOptions](https://pptr.dev/api/puppeteer.pdfoptions), [puppeteer#12360](https://github.com/puppeteer/puppeteer/issues/12360) notes flakiness). Treat outline as a Phase-4-adjacent experiment, not a dependency.
3. **Puppeteer 25** (May 2026): ESM-only, Node ≥22, `executablePath()` now async ([changelog](https://pptr.dev/CHANGELOG)). We are ESM on Node 24 — safe when we choose to move.
4. **Paged.js health:** actively maintained; NLnet-funded modernization underway incl. PDF/UA tagging ([nlnet.nl/project/PagedJS](https://nlnet.nl/project/PagedJS/)). Dependency risk low. Still no 0.5 stable.

## D. Suggested order of attack

*Superseded by the executable plan: [BUILD_PLAN.md → Phase 7](BUILD_PLAN.md), which turns every item below into a step with an exit test.*

1. **A1 + A2** — output correctness (the product's whole premise).
2. **A3, A4, A5** — data-loss / broken-state bugs.
3. **A7 + B4** — test isolation, then CI (CI is only meaningful once tests don't dirty the tree).
4. **A6, A8, A9, A10, A11** — hardening batch.
5. **B1** — reproducibility promise.
6. **B2, B3, B5, B6** — polish batch.

Phases 4 (CMYK) and 5 (print & measure) remain open as before and are unaffected.
