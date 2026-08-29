# Contributing

Thanks for wanting to hack on sick-af-ascii-art. It stays deliberately small and
dependency-light — please keep it that way.

## Dev setup

Requires **Node 20+** and **pnpm**. It's a pnpm workspace, so install once at the
root:

```bash
pnpm install
pnpm dev          # editor on http://localhost:7272 (strictPort — never drifts)
```

| Script (run at root) | Does |
|---|---|
| `pnpm dev` | Dev server for the web editor on :7272 |
| `pnpm build` | Typecheck the workspace, then build `apps/web` |
| `pnpm typecheck` | Types only, across all packages (`pnpm -r typecheck`) |
| `pnpm test` | Unit tests (vitest) |
| `pnpm test:watch` | Vitest in watch mode |

### Typecheck before you finish

TypeScript is strict and the typecheck **must** pass. Per package:

```bash
cd packages/engine && npx tsc --noEmit   # engine changes
cd apps/web        && npx tsc --noEmit   # app changes
```

### Benchmarking

`scripts/bench-posters.ts` runs every mode and every post-FX effect over local
poster inputs, times each render, and writes every frame out for visual QA. It
runs headlessly on `@napi-rs/canvas` via vite-node:

```bash
npx vite-node scripts/bench-posters.ts
```

Its inputs live in `test-posters/` (local only, gitignored, never shipped). The
CPU timings are representative-to-pessimistic — in-browser, filter-backed effects
ride the GPU and come in faster — so treat an interactive browser spot-check as
the ground truth for feel.

## Code style

- **TypeScript strict.** No `any` escapes, no `// @ts-ignore` to get past a real
  type error.
- **Canvas 2D only.** No WebGL, no React, no UI framework. The web app is vanilla
  TS + Vite.
- **Dependency-light.** Don't add a dependency without a clear justification; a
  small hand-written implementation usually beats a package.
- **OFL fonts only.** Fonts must be Open Font License (JetBrains Mono for the
  grid, Inter for UI). This is a hard gate — the project is MIT and ships clean.
- **Comments explain constraints the code can't show** — the *why*, not a
  narration of the *what*. If the code already says it, don't restate it.
- **Never hardcode `charAspect`** — measure it via `measureText` in
  `packages/engine/src/grid.ts`.
- **Never `getImageData` at full resolution** — downscale to the grid first, in
  `packages/engine/src/sample.ts`. This is the framerate-critical path.
- **App imports the engine only via `@sick-af/engine/<subpath>`**, never by a
  relative path into `packages/engine`.

## Adding a render mode

A mode is any object satisfying the `ModeRenderer` contract in
`packages/engine/src/renderer.ts`. Implement **one** entry point:

- `renderCell(ctx, sample, grid, opts, col, row)` — per cell, for stateless
  modes.
- `renderGrid(ctx, sample, grid, opts)` — the whole grid in one call, for modes
  with cross-cell state. Set `animated: true` if the mode must repaint even on a
  still source.

Then register it:

1. Add the renderer to one of the family modules under
   `packages/engine/src/modes/` (or a new module), exported in that module's
   `Record<string, ModeRenderer>`.
2. Export the record from `packages/engine/src/index.ts` if it's a new module.
3. In `apps/web/src/main.ts`, spread the record into `ALL_MODES`. The startup
   guard expects an exact mode count — update it, and it will fail loudly if a
   module didn't load.
4. Add a test in `packages/engine/src/__tests__/modes.test.ts`. The synthetic
   fixtures (ramps, checkers, sweeps) expose renderer bugs that photos hide —
   prefer them over real images for correctness tests.

## Good first issues

Some deferred features are scaffolded but not yet wired into the UI — good
self-contained entry points:

- **Crop** — the crop modal exists (`apps/web/src/ui/crop-modal.ts`) and the
  sampler already accepts a transform; wire the topbar Crop action to it.
- **GIF / MP4 export** — the encoders are scaffolded in `apps/web/src/io/`
  (`export-gif.ts`, `export-video.ts`, with `gifenc` and `mp4-muxer` already in
  place); wire the topbar Export action to them.
- **UI panels for engine stages that already exist in the core but have no
  controls yet:** lights (`lights.ts`), mask (`mask.ts`), and per-kernel dither
  selection (`dither.ts`). Add sidebar sections that drive the existing options.

## Before opening a PR

- `pnpm typecheck` and `pnpm test` both pass.
- New behaviour has a test.
- No new dependency without a note explaining why nothing lighter works.
- No non-OFL font, and no bundled asset whose licence you can't point to.
