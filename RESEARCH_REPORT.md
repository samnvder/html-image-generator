# Deep Research Report — Toolchain & Architecture

*Completed 2026-07-09. Method: 5 parallel search angles → 23 sources fetched → 109 claims extracted → top 25 adversarially verified (3-vote panels) → 21 confirmed, 4 refuted. Feeds INITIAL_BLUEPRINT.md.*

---

## Verified Findings

### 1. Rendering engine: Chromium via Puppeteer or Playwright — they're equivalent

- Both Playwright and Puppeteer generate PDFs through the **same Chrome DevTools Protocol call (`Page.printToPDF`)**, so print fidelity and dimensions are essentially identical. Differences: Puppeteer emits tagged/accessible PDFs by default (Playwright doesn't), and **Playwright's PDF generation only works in headless Chromium** (its Firefox/WebKit support doesn't extend to PDF). *(2-1 and 3-0 votes; pdf4.dev + Playwright source code `crPdf.ts`)*
- Claims that Playwright is "faster" or "recommended over Puppeteer" were **refuted** by the verification panel — no verified performance ranking exists. Choose on ecosystem fit, not speed.
- **Decision driver:** `pagedjs-cli` is itself Puppeteer-backed, so standardizing on **Puppeteer** means one Chromium install serves the whole pipeline.

### 2. Exact dimensions: pure CSS `@page` works; bleed/marks do NOT

- Letter (8.5×11in), Legal (8.5×14in), portrait/landscape, and margins are all declarable in pure CSS via `@page { size: letter portrait; margin: 0.5in; }` — Chromium honors this in print-to-PDF with `preferCSSPageSize: true`. *(3-0; MDN + W3C css-page-3)*
- **The `bleed` and `marks` @page descriptors are supported by NO browser as of mid-2026** (MDN, caniuse, no chromestatus Intent-to-Ship). Bleed and crop marks must be produced by **Paged.js** or **manual layout** (author the page oversized by 2× bleed and draw crop marks as positioned elements). *(3-0)*
- Caveat: `@page` margin boxes (running headers/footers) have historically poor Chromium support — one extracted (unverified) claim says Chrome 131 (Nov 2024) shipped native margin boxes; treat as "verify at build time."

### 3. DPI-exact PNGs: deviceScaleFactor math + a mandatory metadata fix

- Formula confirmed: **`deviceScaleFactor ≈ targetDPI / 96`**. A page authored in physical CSS units at a 96-CSS-px/inch viewport, screenshotted at DSF 3.125, yields exactly 300 DPI pixel counts (Letter → 2550×3300 px). *(3-0; Puppeteer issue #1669 with pngcheck verification)*
- **Neither Puppeteer nor Playwright writes DPI metadata (PNG `pHYs` chunk)** — the "72 DPI" apps report is a default assumption. Maintainers explicitly declined to add the option. **A post-processing step must inject the `pHYs` chunk** (e.g., via `sharp` with `withMetadata({density: 300})` or a PNG chunk tool) so downstream tools read the physical size correctly. *(3-0)*
- Gotcha (extracted, unverified): very high deviceScaleFactor values have produced truncated screenshots (missing bottom-right content) — test at DSF ~3.125 and prefer `page.pdf()` for final print output.

### 4. Paged.js: the print-CSS layer AND the live preview

- Paged.js polyfills the CSS **Paged Media + Generated Content** modules (page breaks, @page rules, running headers via `string-set`, footnotes, page-number counters). *(3-0; official repo, actively maintained, 0.5.x releases + 2024–25 roadmap)*
- Two usage modes, both verified:
  - **`paged.polyfill.js` in the browser** — replaces @page CSS and re-renders the document as discrete page-sized boxes → this *is* the dimensionally accurate live preview (8.5in renders as 816 CSS px, the same units Chromium prints at).
  - **`pagedjs-cli`** — final PDF generation, Puppeteer/Chromium-backed.
- Gotchas *(verified)*: the polyfill runs **once on load** (live editing requires re-invoking the `Previewer`), it applies print styles globally, it **requires HTTP (not `file://`)**, and it's Chromium-focused. With modern Chromium supporting much of css-page-3 natively, Paged.js's main value today is generated-content features + the paginated preview.

### 5. CMYK / press pipeline: Ghostscript, with a BYO ICC profile

- Verified path: Ghostscript's `pdfwrite` device with **`-sColorConversionStrategy=CMYK`**, plus a customized **`PDFX_def.ps`** (from `gs/lib/`) setting OutputCondition, OutputConditionIdentifier, and a fully qualified ICC profile path. **Ghostscript ships NO ICC profile usable as a PDF/X output intent** — a US press profile (GRACoL/SWOP) must be obtained separately. *(3-0; official Ghostscript docs)*
- The claim that Ghostscript supports only PDF/X-1 and X-3 (no X-4) was **refuted** — actual PDF/X version coverage remains an open question to confirm against Ghostscript 10.x docs at build time.
- **press-ready** (Node CLI wrapping Ghostscript): closest existing tool, but **unmaintained (last release Aug 2020)** and hardcoded to Japan Color 2001 Coated — unsuitable for US work. **Mine it as a reference implementation of the Ghostscript PDF/X-1a flags** (see its `src/ghostScript.ts`), don't depend on it. Windows wrinkle: expects `gs` on PATH vs. Windows' `gswin64c.exe`. *(3-0)*

### 6. Existing tools: nothing fits — building is justified

- **pdfme** (MIT, active, v6.0.0 Apr 2026): great WYSIWYG drag-and-drop Designer to *study for UI patterns*, but templates are **JSON schemas, not HTML/CSS** — can't serve our core requirement. *(3-0)*
- **react-print-pdf**: compile() only emits HTML, rendering is delegated to the Fileforge **cloud API**, and the repo is unmaintained since Sep 2024. Not adoptable; component patterns may inform template authoring. *(3-0)*
- Conclusion: a thin custom app around **Chromium + Paged.js + Ghostscript** is the right build.

## Refuted Claims (do not repeat)

1. ~~"Ghostscript supports only PDF/X-1 and PDF/X-3"~~ (0-3)
2. ~~"Recommend Playwright over Puppeteer for PDF generation"~~ (0-3 — editorial, unverified)
3. ~~"Playwright 13ms vs Puppeteer 58ms benchmark"~~ (1-2 — vendor numbers, unreliable)
4. ~~"wkhtmltopdf officially deprecated 2023, no maintainers/arm64"~~ (0-3 as stated — its actual status is unverified, but its QtWebKit engine is ancient; it is not a candidate regardless)

## Coverage Gaps (answered from engineering judgment, not verified sources)

The verification pass produced **no surviving claims** on: font-embedding best practices, the local-app architecture comparison (Node vs Electron vs Tauri vs single-executable), WeasyPrint's current fidelity, and Satori/resvg. Decisions in those areas below are marked **[judgment]**.

*Font embedding has since been settled empirically at build time — see Open Question #1 below.*

---

## Recommended Stack (v1.0 decision)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js (LTS)** | One ecosystem for server, render, post-processing; every LLM agent speaks it |
| Render engine | **Puppeteer** (headless Chromium) | Verified CDP print path; shares Chromium with pagedjs-cli; tagged PDFs by default |
| Print CSS / pagination | **Paged.js** (polyfill for preview, pagedjs-cli or in-page Previewer for output) | Verified: only local path to bleed/crop marks + running headers + accurate preview |
| PDF output | `page.pdf({ preferCSSPageSize: true })` | Vector, exact Letter/Legal from `@page` CSS |
| PNG output | `page.screenshot()` @ `deviceScaleFactor = DPI/96` → **sharp** post-process to write `pHYs` (300 DPI) | Verified formula + verified metadata gap |
| CMYK / press | **Ghostscript** (`gswin64c`) + customized `PDFX_def.ps` + user-supplied GRACoL/SWOP ICC | Verified local pipeline; press-ready mined as reference |
| App server **[judgment]** | **Fastify (or Express) + chokidar file-watch + WebSocket reload** | Live preview over HTTP (Paged.js requires HTTP); hot-reload on template edits |
| Launch **[judgment]** | `npm start` → starts server → **`open` package** auto-launches default browser at `http://localhost:PORT` | One command, opens on its own; zero install beyond `npm i`; no Electron/Tauri bundle weight — we already ship Chromium via Puppeteer |
| LLM interface | **CLI render script** (`node scripts/render.js jobs/<spec>.json`) + the same HTTP API the UI uses | Any IDE agent can render without touching the UI |

**Why not Electron/Tauri [judgment]:** the app already requires a full Chromium (Puppeteer) for rendering; wrapping the UI in a second bundled runtime adds hundreds of MB and packaging friction for zero print-fidelity gain. A localhost server + system browser gets one-command launch, auto-open, live preview, and stays trivially LLM-scriptable. Tauri v2 remains the upgrade path if a "real app" shell is ever wanted.

### The one-command pattern

```jsonc
// package.json
{ "scripts": { "start": "node server/index.js" } }
```

```js
// server/index.js (shape)
const app = buildServer();            // Fastify: serves UI, templates, outputs
const port = await listen(app);       // pick a free port
watchTemplates(broadcastReload);      // chokidar → WebSocket → browser reloads preview
await import('open').then(m => m.default(`http://localhost:${port}`)); // auto-open UI
```

Optionally a `Start.cmd` in the project root (`npm start`) makes it double-clickable on Windows 11.

## Open Questions (carry into build phase)

1. ~~Font embedding guarantees in Chromium PDFs~~ — **ANSWERED 2026-07-09 (Phase 2, `scripts/fonttest.js`):** both WOFF2 and TTF loaded via `@font-face` are **embedded and subsetted identically**. Chromium decodes WOFF2 and re-embeds the glyf table as a subsetted TrueType (`/FontFile2`, `AAAAAA+` subset prefix). Format choice is a delivery detail, not a print-fidelity one — prefer WOFF2 for smaller source files. Bonus finding: Chromium (Skia) writes **no object streams** (`/ObjStm`), so PDF font structure is inspectable by plain regex, no PDF library needed.
2. Ghostscript 10.x actual PDF/X level support (X-4?) and validation via **veraPDF**.
3. Where to legally source/auto-fetch a US CMYK ICC profile (GRACoL2013/CGATS21 or SWOP).
4. ~~Chrome 131+ native `@page` margin-box support~~ — **ANSWERED 2026-07-09 (Phase 1 Probe B):** Chrome 148 renders `@top-center`/`@bottom-right` margin boxes natively in `page.pdf()`, including `counter(page)`. Paged.js is NOT needed for running headers/footers — its role narrows to bleed/crop marks + the paginated preview.
5. ~~deviceScaleFactor truncation bug at high DSF~~ — **ANSWERED 2026-07-09 (Phase 1 Probe A):** no truncation at DSF 3.125 in Chrome 148 / Puppeteer 24; a 0.5in corner marker at the extreme bottom-right of a Letter@300 screenshot survives intact (2550×3300 px exact).

*Build-time note: Paged.js has no 0.5.x stable release — latest stable is **0.4.3** (0.5.0 exists only as betas); the "0.5.x releases" claim in §4 was wrong.*

## Key Sources

- Ghostscript VectorDevices docs — ghostscript.readthedocs.io/en/latest/VectorDevices.html (primary)
- MDN Paged Media guide (modified 2026-05) + W3C css-page-3 draft (primary)
- Paged.js + pagedjs-cli repos — github.com/pagedjs (primary)
- Puppeteer issues #1669 (DPI), #2868 (DSF truncation), #6480 (CMYK) (primary/forum)
- press-ready — github.com/vibranthq/press-ready (primary, reference only)
- pdfme — github.com/pdfme/pdfme; react-print-pdf — github.com/OnedocLabs/react-print-pdf (primary)
- pdf4.dev Playwright-vs-Puppeteer comparison (blog — used only for the CDP-equivalence claim, which was source-code-verified)
