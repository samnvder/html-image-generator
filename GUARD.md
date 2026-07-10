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
| 6 | Color intent | `colorIntent` | Default `rgb`. `cmyk` **requires Ghostscript** and converts the PDF in place — see below. |
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

1. **Write the job spec** to `jobs/<name>.json`, validated against [`jobs/schema.json`](jobs/schema.json). This file *is* the reproducible record — a later session can re-render or edit it without re-deriving anything. (The app enforces this from its own side: every successful `POST /api/render` writes the spec back to `jobs/<slug>.json`, so a UI render is exactly as reproducible as a CLI one.)
2. **Pick or author a template** in `templates/`. Three references ship:
   - `poster-letter.html` — full-bleed art, big display type, image slot
   - `certificate-letter.html` — landscape, bordered, single merge field for the recipient name
   - `legal-form.html` — Legal size, flowing multi-page text, native running header/footer

   **Three is not a library.** They are references, not a catalogue: none of them lays out
   a *list* — a programme, a menu, an agenda, a price sheet. Authoring a new template is
   the expected move, not a last resort. Do not cram a list into `poster-letter`'s
   `subhead`; the `{{key}}` substitution has no line breaks (see below) and you will get
   one run-on paragraph.
3. **Render:** `node scripts/render.js jobs/<name>.json` (add `--no-open` to suppress the viewer).
4. **Report the output path.** Renders land in `outputs/<project-slug>/<doctype-plural>/`, plus a `latest.pdf` copy.

---

## Color intent, if the job is going to a commercial press

`colorIntent` is the only variable that depends on the *machine* rather than the spec.

**It is not a second demand.** Paper size remains the only variable you must have
confirmed. Colour intent you infer and state, exactly like the other twelve.

Infer `cmyk` when the user names a commercial press. But before you write it into the
spec, know that a `cmyk` job **hard-fails without Ghostscript 10.05.0 or newer** — and
headless, you usually cannot verify that it's installed. When you can't:

> **Render `rgb`, and say so out loud.**
>
> *"Rendered RGB. A press-ready CMYK / PDF-X-4 file needs Ghostscript 10.05+ on this
> machine — install it and I'll re-render from the same job spec, no rework."*

Choosing `rgb` and disclosing it is not the forbidden fallback. The forbidden fallback is
the *renderer* quietly handing back an RGB file while the spec says `cmyk` — which it
never does; it refuses. Your job is to not paint yourself into that refusal without
telling the user why.

If you *can* verify Ghostscript (`colorIntent: "cmyk"` renders without error), then:

- **A press job asks for `outputs: ["pdf"]`.** The PNG is a convenience raster with no
  CMYK path, so a cmyk job that also asks for PNG gets a warning saying the PNG is RGB.
- **A cmyk job's PDF deliverable *is* the converted file.** Ghostscript converts it in
  place, before `latest.pdf` is written. No RGB intermediate survives — the job spec
  reproduces the render on demand, which is what the spec is for.
- **No Ghostscript, no render.** `cmyk` on a machine without it is a hard error thrown
  before Chromium starts and before any file is written, naming the fix. There is no RGB
  fallback: an RGB file shipped as press output is a wasted print run, and a silent one.
- **Ghostscript 10.05.0 is the minimum**, and an older one is refused the same way. Before
  10.05 there is no `-dPDFX=4`, and the conversion leaves RGB transparency-blending spaces
  inside a CMYK file. Ubuntu 24.04's `apt-get install ghostscript` gives you 10.02.1.
- **With an ICC profile** at `assets/icc/press.icc` (or `HIG_ICC_PROFILE`) the output is
  **PDF/X-4**, with the profile embedded as the output intent. **Without one** it is a
  plain CMYK PDF, and `warnings[]` says exactly that. The tool never claims a PDF/X
  conformance it did not produce. See [`assets/icc/README.md`](assets/icc/README.md).
- **PDF/X-1a and X-3 are not offered.** Ghostscript writes them as PDF 1.3, which has no
  transparency, so it flattens the page to a bitmap: no embedded fonts, no selectable
  text. If a printer insists on X-1a, tell them; don't hand them a raster.

---

## Rules for authoring templates

- **Physical units only.** `in`, `pt`, `mm` — never `px` for anything that must measure true on paper. The one exception is the renderer's internal viewport math.
- **Link `/templates/base.css`.** It carries the `@font-face` declarations, design tokens, the `.sheet` box, and image-slot styling.
- **Do not write your own `@page { size: … }`.** The renderer injects `size`, `margin`, and (on the Paged.js path) `bleed`/`marks` from the job spec. A template that hardcodes size will fight the spec and win, silently.
- **Use the injected variables** — `--page-width`, `--page-height`, `--page-margin` — so the PNG render matches the PDF. On the screen path there is no `@page`, so a template that relies on `@page margin` alone will look right in PDF and wrong in PNG.
- **Running headers and footers use native `@page` margin boxes** (`@top-left`, `@bottom-center`, `counter(page)`). Verified working in Chrome 148. You do not need Paged.js for these.
- **Flowing multi-page templates are PDF-only.** A screenshot has no page breaks. Set `outputs: ["pdf"]`.
- **`{{placeholder}}`** is the substitution syntax. Image slots use `{{image:slotname}}`. Unfilled placeholders survive into the output and log a warning — they are meant to be visible, not silent.
- **An unfilled `{{image:slot}}` is a broken image, not an absent one.** The `src` keeps the literal placeholder, so the PDF ships with a broken-image glyph where the art should be. Fill every slot: `assets/` carries `placeholder-background.png` and `placeholder-seal.png` for exactly this. If the design genuinely has no art, use a template that has no image slot.
- **Content is text, not markup.** `{{key}}` HTML-escapes its value, so `use <Enter> to submit` reaches the page as those exact characters and a stray `<b>` never becomes an element. Escaping is attribute-safe, so `src="{{image:slot}}"` works unchanged. When a value is *meant* to be markup, ask for it explicitly with the triple-stache **`{{{key}}}`**.
- **`{{key}}` has no line breaks.** A newline in a content value is just whitespace to HTML: six programme items separated by `\n` render as one wrapped paragraph. A list, a stanza, or any multi-line body needs a template that exposes a **`{{{triple-stache}}}`** field and receives real markup (`<li>…</li>`). None of the three reference templates does — write one.

## Facts that will bite you

- **Paged.js is only engaged for bleed and crop marks.** Everything else — exact size, orientation, margins, page counters, running heads — is native Chromium. Do not reach for the polyfill by reflex.
- **A bleed job renders two different documents.** The PDF gets the Paged.js composition; the PNG is composed again without it, because bleed and crop marks are print concepts and the PNG is a trim-size screen render. Never screenshot the paged DOM.
- **Chromium writes no DPI metadata into PNGs.** The renderer's `sharp` post-step stamps the `pHYs` chunk. Never hand-roll a screenshot path that skips it, or Photoshop will read the file as 72 DPI.
- **Project and doc-type names become filesystem paths.** They are slugified and validated; path traversal and Windows reserved names (`CON`, `NUL`, `COM1`…) are rejected outright. Don't route around this.
- **Both WOFF2 and TTF embed and subset identically** in Chromium PDFs (verified — `scripts/fonttest.js`). Prefer WOFF2; the files are smaller.
