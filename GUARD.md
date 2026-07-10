# The Question Guard

**Read this before generating anything.** You are an LLM agent operating this project. Your job is to author an HTML/CSS document at exact physical dimensions and render it deterministically — not to guess.

**No output is generated until this guard is satisfied.**

---

## The rule

Before any render, fourteen variables must have values. You do **not** interrogate the user fourteen times. You **infer sensible defaults from what they told you, state them in one block, and ask for confirmation.**

One exception, and it is absolute:

> **Paper size is always explicitly confirmed. Letter or Legal. Never silently defaulted, never inferred, never assumed from a previous job.**

A flyer printed on the wrong stock is a wasted print run. Ask.

---

## The fourteen variables

| # | Variable | Spec field | Default behavior |
|---|---|---|---|
| 1 | Project / client | `project` | Ask, or reuse from context. Becomes a folder name. |
| 2 | **Paper size** | `paperSize` | **ALWAYS CONFIRM.** `letter` (8.5×11in) or `legal` (8.5×14in). |
| 3 | Orientation | `orientation` | Default `portrait`. State it. |
| 4 | Output format | `outputs` | Default `["pdf"]`. Add `"png"` if they want a raster. |
| 5 | DPI | `dpi` | Default `300` (press standard). Only matters for PNG. |
| 6 | Color intent | `colorIntent` | Default `rgb`. `cmyk` requires Ghostscript (Phase 4). |
| 7 | Margins | `margin` | Default `0.5in`. Use `0` for full-bleed designs. |
| 8 | Bleed | `bleed` | Default `0`. Commercial press → `0.125in`. |
| 9 | Crop marks | `cropMarks` | Default `false`. Commercial press → `true`. |
| 10 | Document type | `docType` | Ask or infer (`flyer`, `poster`, `certificate`, `legal-form`…). Becomes a folder name. |
| 11 | Content | `content` | The actual words. Elicit or draft, then confirm. |
| 12 | Style direction | *(template + CSS)* | Infer from the content and the client. State your read. |
| 13 | Typography | `fonts` | Default to the shipped families. See `fonts/manifest.json`. |
| 14 | Image slots | `imageSlots` | Templates declare art zones; fill them or leave placeholders. |
| — | Variants | `variants` | Optional. Each entry re-renders with content overrides (data merge). |

---

## What good behavior looks like

> **User:** Make me a flyer for the spring menu launch at South End.
>
> **You:** Here's what I'll build unless you correct me:
>
> - **Project:** South End · **Type:** poster
> - **Paper:** ⚠️ **Letter (8.5×11in) or Legal (8.5×14in)?** — I need you to pick.
> - **Orientation:** portrait · **Output:** PDF + 300-DPI PNG
> - **Margins:** none (full-bleed art) · **Bleed/crop marks:** off — turn on if a commercial printer is doing this
> - **Style:** warm, food-forward; Playfair display over a photo, ink-dark scrim
> - **Image slot:** `background` — I'll use a placeholder unless you have a photo
> - **Copy:** I'll draft headline, subhead, date/time/location — you approve before render
>
> Confirm the paper size and I'll write `jobs/spring-menu-launch.json` and render.

Note what happened: thirteen decisions were made *for* the user and shown for correction. One was demanded.

---

## Then, mechanically

1. **Write the job spec** to `jobs/<name>.json`, validated against [`jobs/schema.json`](jobs/schema.json). This file *is* the reproducible record — a later session can re-render or edit it without re-deriving anything.
2. **Pick or author a template** in `templates/`. Three references ship:
   - `poster-letter.html` — full-bleed art, big display type, image slot
   - `certificate-letter.html` — landscape, bordered, single merge field for the recipient name
   - `legal-form.html` — Legal size, flowing multi-page text, native running header/footer
3. **Render:** `node scripts/render.js jobs/<name>.json` (add `--no-open` to suppress the viewer).
4. **Report the output path.** Renders land in `outputs/<project-slug>/<doctype-plural>/`, plus a `latest.pdf` copy.

---

## Rules for authoring templates

- **Physical units only.** `in`, `pt`, `mm` — never `px` for anything that must measure true on paper. The one exception is the renderer's internal viewport math.
- **Link `/templates/base.css`.** It carries the `@font-face` declarations, design tokens, the `.sheet` box, and image-slot styling.
- **Do not write your own `@page { size: … }`.** The renderer injects `size`, `margin`, and (on the Paged.js path) `bleed`/`marks` from the job spec. A template that hardcodes size will fight the spec and win, silently.
- **Use the injected variables** — `--page-width`, `--page-height`, `--page-margin` — so the PNG render matches the PDF. On the screen path there is no `@page`, so a template that relies on `@page margin` alone will look right in PDF and wrong in PNG.
- **Running headers and footers use native `@page` margin boxes** (`@top-left`, `@bottom-center`, `counter(page)`). Verified working in Chrome 148. You do not need Paged.js for these.
- **Flowing multi-page templates are PDF-only.** A screenshot has no page breaks. Set `outputs: ["pdf"]`.
- **`{{placeholder}}`** is the substitution syntax. Image slots use `{{image:slotname}}`. Unfilled placeholders survive into the output and log a warning — they are meant to be visible, not silent.
- **Content is text, not markup.** `{{key}}` HTML-escapes its value, so `use <Enter> to submit` reaches the page as those exact characters and a stray `<b>` never becomes an element. Escaping is attribute-safe, so `src="{{image:slot}}"` works unchanged. When a value is *meant* to be markup, ask for it explicitly with the triple-stache **`{{{key}}}`**.

## Facts that will bite you

- **Paged.js is only engaged for bleed and crop marks.** Everything else — exact size, orientation, margins, page counters, running heads — is native Chromium. Do not reach for the polyfill by reflex.
- **A bleed job renders two different documents.** The PDF gets the Paged.js composition; the PNG is composed again without it, because bleed and crop marks are print concepts and the PNG is a trim-size screen render. Never screenshot the paged DOM.
- **Chromium writes no DPI metadata into PNGs.** The renderer's `sharp` post-step stamps the `pHYs` chunk. Never hand-roll a screenshot path that skips it, or Photoshop will read the file as 72 DPI.
- **Project and doc-type names become filesystem paths.** They are slugified and validated; path traversal and Windows reserved names (`CON`, `NUL`, `COM1`…) are rejected outright. Don't route around this.
- **Both WOFF2 and TTF embed and subset identically** in Chromium PDFs (verified — `scripts/fonttest.js`). Prefer WOFF2; the files are smaller.
