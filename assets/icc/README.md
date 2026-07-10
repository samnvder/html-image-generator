# The ICC profile slot

> **Ghostscript 10.05.0 or newer is required for any `colorIntent: "cmyk"` render.**
> `-dPDFX=4` does not exist before it, and older builds leave RGB transparency-blending
> spaces inside a CMYK file. Ubuntu 24.04's `apt-get install ghostscript` gives 10.02.1 —
> too old. The tool refuses rather than degrading; see `RESEARCH_REPORT.md` §5.

**Nothing in this folder is committed except this file.** Drop a CMYK ICC profile at
`assets/icc/press.icc` and every `colorIntent: "cmyk"` render becomes **PDF/X-4**:
the profile is embedded as the `/DestOutputProfile` of a `/GTS_PDFX` output intent,
and the file carries the XMP `pdfxid` identification that PDF/X-4 conformance requires.

Without a profile the render still succeeds — it converts to DeviceCMYK and returns a
`warnings[]` entry saying no output intent was embedded. It is a CMYK PDF, not a PDF/X
one, and the tool says so rather than claiming a conformance it did not produce.

Resolution order, both read at call time:

| | |
|---|---|
| `HIG_ICC_PROFILE` | absolute path to a profile. The literal `0` forces "no profile", so the degraded path stays testable on a machine that has one. |
| `assets/icc/press.icc` | the default slot. |

---

## Why no profile ships with this repo

Because none of the US press profiles can be redistributed by us without checking, and
"probably fine" is not a licence. **Verify before you commit one here** — this folder is
gitignored precisely so that a profile can't be added by accident.

| Profile | What it is | Where to get it | Redistribution |
|---|---|---|---|
| **GRACoL2013 (CRPC6)** | The current US commercial sheetfed/offset characterization (CGATS.21-2 CRPC6). The default choice for US coated stock. | Idealliance publishes the CGATS.21 CRPCn profile set at [idealliance.org](https://www.idealliance.org/) (free download, registration). Also bundled with Adobe apps as `GRACoL2013_CRPC6.icc`. | Free to **use**. Redistribution terms come with the download — read them. Do not assume the Adobe-bundled copy may be republished. |
| **SWOP2013 (CRPC5/CRPC3)** | US web offset publication printing. Ask your printer whether they want SWOP or GRACoL. | Same Idealliance set. | Same caveat. |
| **Coated FOGRA39 / FOGRA51** | The European equivalents. Wrong for US work unless your printer asks for them. | [ECI.org](https://www.eci.org/) — ECI offset profiles ship under a licence that *does* permit redistribution. | Permitted, with the licence file. Read it. |
| `default_cmyk.icc` | Ships **with Ghostscript**, in its `iccprofiles/` directory. A generic device CMYK profile, **not** a press characterization. | Already on any machine with Ghostscript. | AGPL, with Ghostscript. |

### About `default_cmyk.icc`

The test suite uses it in CI (`HIG_ICC_PROFILE` points at Ghostscript's own copy) to
exercise the PDF/X-4 code path end to end. That proves the *plumbing*: the intent is
embedded, the profile is four-channel, the identification is written, the text stays
vector. It does **not** make the output press-correct. A real job needs a real
characterization, and the printer is the one who tells you which.

### The one question worth asking your printer

> *"Which output intent do you want — GRACoL2013 CRPC6, SWOP2013, or something of
> your own? And do you want PDF/X-4, or do you need X-1a?"*

If they need **PDF/X-1a**, this tool cannot give it to you honestly today, and the
reason is worth knowing: X-1a is PDF 1.3, which has no transparency, so Ghostscript
flattens the page to a bitmap — every font unembedded, every character unselectable.
A deterministic-text tool that ships a raster is not doing its job. See
`RESEARCH_REPORT.md` §5 for the measurements.

---

## Adding one

```bash
cp ~/Downloads/GRACoL2013_CRPC6.icc assets/icc/press.icc
node scripts/presstest.js        # the PDF/X-4 block stops skipping
```

If you keep the profile somewhere else, `HIG_ICC_PROFILE=/path/to/profile.icc` works
just as well and touches nothing in the repo.
