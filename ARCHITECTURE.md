# Architecture

sick-af-ascii-art renders a source image or video frame into a grid of glyphs or
shapes, entirely on Canvas 2D. This document describes how one frame is built and
why the pipeline is shaped the way it is.

## The frame pipeline

```
source (image | video)
  │
  ├─ transform            crop / rotate / flip, applied by the sampler
  ▼
downscale-to-grid sampler        packages/engine/src/sample.ts
  │  draws the source into an offscreen canvas sized to the CELL grid
  │  (one pixel per cell), then reads it back once
  ▼
colour pipeline                  packages/engine/src/color.ts
  │  brightness · contrast · saturation · grayscale · filter · tint pre-grade
  ▼
Rec.709 luminance                packages/engine/src/color.ts
  │  per-cell luminance = 0.2126 R + 0.7152 G + 0.0722 B
  ▼
lights (optional)                packages/engine/src/lights.ts
  │  raise cell RGB BEFORE glyph selection — changes which glyph is chosen
  ▼
mode dispatch                    packages/engine/src/modes/*
  │  the active ModeRenderer draws each cell onto an isolated glyph layer
  ▼
post-FX chain                    packages/engine/src/postfx/chain.ts
  │  glyph-stage effects → composite over backdrop → frame-stage effects
  ▼
tint                             packages/engine/src/tint.ts
  │  full-frame colour grade of the finished image
  ▼
output canvas
```

The orchestration lives in `packages/engine/src/renderer.ts` — the canvas host
that owns sizing, the frame loop, and the order above.

## Two load-bearing decisions

### Measured `charAspect`, never hardcoded — `grid.ts`

A monospace cell is taller than it is wide, and the exact ratio depends on the
font, its size, and the platform's rasteriser. Guessing it warps every mode: the
grid maps luminance onto a cell whose real proportions must match what the
browser will actually paint. So `grid.ts` measures the glyph box with the live
2D context (`measureText`) and derives the cell geometry from that measurement.
The ratio is discovered, not assumed — the image stays correctly proportioned
across fonts and DPRs.

### Downscale-to-grid before `getImageData` — `sample.ts`

The naïve approach — read the source at full resolution, then average blocks down
to the grid — reads millions of pixels per frame and stalls video. Instead the
sampler draws the source into an offscreen canvas sized to the grid itself (the
browser's own scaler does the box-filter down-sampling on the GPU), then issues a
single `getImageData` at grid resolution. One cheap read per frame instead of a
full-resolution one; this is the framerate-critical path, and it is what lets
video play in real time.

## Render modes

Every mode implements the `ModeRenderer` contract from `renderer.ts`. A mode
provides exactly one entry point:

- **`renderCell`** — invoked once per cell, for stateless per-cell modes.
- **`renderGrid`** — owns the whole grid in one call, for modes with cross-cell
  state (error-diffusion dither carries quantisation error between cells and must
  see them in order).

Modes are grouped into registry modules, each exporting a
`Record<string, ModeRenderer>`:

| Family | Module | Keys |
|---|---|---|
| Glyph | `modes/glyph.ts` | `characters`, `block-chars`, `mixed` |
| Dither | `modes/dither.ts` | `dither` |
| Shape | `modes/shape.ts` | `dots`, `lines`, `diagonal`, `cross`, `diamond` |
| Block | `modes/block.ts` | `pixel`, `mosaic`, `lego` |
| Voxel | `modes/voxel.ts` | `3d` |
| Braille | `modes/braille.ts` | `braille` |
| Disco | `modes/disco.ts` | `disco` |

Fifteen modes total. The web app merges the seven records and registers each key;
a short count is a hard error at startup rather than a UI whose mode pills
dispatch to nothing.

### Dither algorithms

`dither.ts` implements two textbook families:

- **Ordered (Bayer)** — a recursively constructed threshold matrix; stateless
  per-pixel, cheap and parallelisable.
- **Error diffusion** — quantise each cell, then push the residual error to
  not-yet-visited neighbours by a fixed kernel. Seven kernels ship:
  Floyd–Steinberg, Atkinson, Burkes, Sierra, Sierra Lite, Stucki, and Jarvis.
  (Atkinson deliberately distributes only 6/8 of the error — the missing quarter
  is what gives it the crisp, slightly blown-out classic Mac look.)

Quantisation is done in linear RGB. All of these are published methods,
independently implemented here.

## The post-FX chain

`postfx/chain.ts` composites the frame and runs a chain of screen-space effects.
The chain's contract has two stages, defined by where an effect runs relative to
the composite:

- **glyph stage** — runs on the isolated, transparent glyph layer *before* it
  composites over the backdrop. Effects that should bleed only from the glyphs
  (Character Bloom, Character Chromatic) live here.
- **frame stage** — runs on the composited output *after* the glyph layer is
  down, over the whole image.

The composite order is therefore: *glyph-stage effects → composite glyph over
backdrop → frame-stage effects → tint*. All three surfaces (glyph layer,
backdrop, output) share one untransformed pixel space, and effects that read
previous state (bloom, chromatic) borrow round-robin scratch surfaces from the
chain rather than allocating per frame.

The 13 effects, in canonical run order:

Character Bloom · Character Chromatic *(glyph stage)* → Pixelate · Halftone ·
Bloom · Chromatic · RGB Split · Glitch · Scan Lines · CRT Curvature · Film Grain
· Film Dust · Vignette *(frame stage)*.

The frame ordering is deliberate: pixelate/halftone reshape the base tone first;
bloom then chromatic/rgb-split colour the light bleed; glitch displaces the
coloured slices; scanlines and curvature build the CRT tube; grain and dust sit
over the tube; vignette frames the finished image last. Every effect defaults off
and is a genuine no-op while disabled or at amount 0.

## The frame loop

A still image at rest schedules **no frames at all**. There is no permanent
`requestAnimationFrame` that ticks and no-ops; the loop is armed only while there
is work — a pending `markDirty`, a playing video, or an `animated` mode (disco) —
and disarms itself the instant there isn't. Video uses
`requestVideoFrameCallback` where available so the render is paced to decoded
frames rather than the display refresh. This is what keeps a paused editor off
the CPU and off the battery.

## Monorepo structure

A pnpm workspace (`pnpm-workspace.yaml`: `packages/*`, `apps/*`):

```
packages/engine   @sick-af/engine   the rendering core
  src/renderer.ts     canvas host, frame loop, ModeRenderer contract
  src/grid.ts         measured cell geometry
  src/sample.ts       downscale-to-grid sampler
  src/color.ts        Rec.709 luminance, tonal pipeline, filters, ramp mapping
  src/dither.ts       Bayer + error-diffusion kernels
  src/modes/*         the 15 render modes
  src/postfx/*        the 13-effect chain
  src/{backdrop,blur,lights,mask,tint,palettes,animate}.ts   supporting stages

apps/web          @sick-af/web      the browser editor (vanilla TS + Vite)
  src/main.ts         wires engine → UI: registers modes, owns one shared chain
  src/ui/*            topbar, sidebar, dropzone, recipes, crop modal
  src/io/*            source loading and image/GIF/MP4 export scaffolding
```

`@sick-af/engine` declares its public surface through package `exports`: a barrel
at `.` and every module at `./*`. The web app consumes subpaths only
(`@sick-af/engine/renderer`, `@sick-af/engine/modes/glyph`, …) — the workspace
link means the same import graph works whether the engine is local source or an
installed package.
