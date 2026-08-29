# sick-af-ascii-art

**Turn any image or video into ASCII, dither, and block art — right in the browser.**

sick-af-ascii-art is a client-side art engine and editor. Drop in a photo or a
video clip and it re-renders it as text glyphs, ordered/error-diffusion dither,
braille dots, colour blocks, or a faux-3D voxel field — 15 render modes in all —
then grades the result through a colour pipeline and a chain of 13 CRT/film
post-effects. Everything runs on Canvas 2D in the page. Nothing is uploaded, no
account is needed, and it works offline once loaded.

[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](#license)
![Canvas 2D](https://img.shields.io/badge/render-Canvas%202D-informational.svg)
![Dependencies: light](https://img.shields.io/badge/dependencies-light-informational.svg)

**[Live demo →](https://vb-tyagi.github.io/sick-af-ascii-art/)**

---

## Quickstart

Requires **Node 20+** and **pnpm**.

```bash
pnpm install
pnpm dev        # dev server on http://localhost:7272
pnpm build      # typecheck + production build
pnpm test       # unit tests (vitest)
```

The dev port is **7272**, hard-coded with `strictPort` — it fails loudly rather
than drifting to another port.

| Script | Does |
|---|---|
| `pnpm dev` | Dev server for the editor on :7272 |
| `pnpm build` | Typecheck all packages, then build the web app |
| `pnpm typecheck` | Types only, across the workspace |
| `pnpm test` | Unit tests (vitest) |

---

## What it does

### 15 render modes

Grouped by the shape they draw into each grid cell:

| Family | Modes |
|---|---|
| **Glyph** (text) | `characters`, `block-chars`, `mixed` |
| **Dither** | `dither` (Bayer ordered + 7 error-diffusion kernels) |
| **Shape** | `dots`, `lines`, `diagonal`, `cross`, `diamond` |
| **Block** | `pixel`, `mosaic`, `lego` |
| **Voxel** | `3d` (isometric faux-3D field) |
| **Braille** | `braille` (2×4 sub-cell dot packing) |
| **Disco** | `disco` (animated colour cycle) |

### 13 post-FX

A composited chain of screen-space effects, each independently toggled and
driven by a single amount slider:

Character Bloom · Character Chromatic · Pixelate · Halftone · Bloom · Chromatic ·
RGB Split · Glitch · Scan Lines · CRT Curvature · Film Grain · Film Dust ·
Vignette

### Colour pipeline

Brightness · contrast · saturation · grayscale · 8 photo filters (`warm`, `cool`,
`sepia`, `vintage`, `cyber`, `fade`, `bw`, plus `none`) · full-frame tint, all
applied before glyph selection so they change *which* characters appear, not just
the final colour.

---

## Monorepo layout

A pnpm workspace with a reusable core and a thin editor on top:

```
packages/engine   @sick-af/engine — the rendering core (framework-free, Canvas 2D)
apps/web          @sick-af/web    — the browser editor (vanilla TS + Vite)
```

The engine is the product; the web app is one consumer of it. The app imports the
engine only through its published subpaths (`@sick-af/engine/renderer`,
`@sick-af/engine/modes/glyph`, …), never by relative path — so the same core
drops into any other host unchanged.

### Using the engine

```ts
import { Renderer } from '@sick-af/engine/renderer';
import { glyphModes } from '@sick-af/engine/modes/glyph';

const renderer = new Renderer({ container: document.querySelector('#stage')! });
for (const [id, mode] of Object.entries(glyphModes)) {
  renderer.registerMode(id, mode);
}

const img = new Image();
img.src = 'photo.jpg';
await img.decode();

renderer.setSource(img);
renderer.setOptions({ mode: 'characters' });
renderer.start();     // renders on demand; idles to zero frames at rest
```

The engine is Canvas-2D-context-driven and runs under Node too (via
`@napi-rs/canvas`), which is how the benchmark scripts exercise it headlessly.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how a frame is built, and
[CONTRIBUTING.md](./CONTRIBUTING.md) to hack on it.

---

## Assets & licensing

Every asset in this tree is free-to-use, and that is enforced rather than
aspirational:

| Asset | Licence | Use |
|---|---|---|
| JetBrains Mono | OFL 1.1 | Character grid |
| Inter | OFL 1.1 | UI |
| Test fixtures | Generated in-repo | Zero external surface |

The dither algorithms (Bayer ordered dithering, Floyd–Steinberg, Atkinson,
Burkes, Sierra, Stucki, Jarvis) and the Rec.709 luminance mapping are
independent implementations of published, textbook methods.

## License

MIT. See the `license` field of `packages/engine/package.json`; the engine is
published as `@sick-af/engine`.
