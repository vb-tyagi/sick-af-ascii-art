/**
 * Headless render harness — W3.V3.
 *
 * Drives a mode through the exact pipeline the real Renderer uses (solve grid ->
 * downscale-to-grid sample -> mode dispatch), but on a @napi-rs/canvas surface
 * so it runs under Node with no browser. Shared by the PNG dump script and the
 * assertion tests so both exercise the identical path.
 *
 * The sampler here mirrors src/engine/sample.ts: draw the source into a
 * cols x rows canvas with smoothing on (a real box filter) and read that back,
 * never getImageData at full resolution.
 */

import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { solveGrid, type GridSpec, type GridOptions } from '@sick-af/engine/grid';
import type { ModeRenderer, RenderOptions } from '@sick-af/engine/renderer';
import type { SampleResult } from '@sick-af/engine/sample';
import { drawFixture, type FixtureName } from '@sick-af/engine/fixtures/generate';
import { charactersMode } from '@sick-af/engine/modes/glyph';
import { PostFxChain, type EffectId } from '@sick-af/engine/postfx/chain';

/**
 * braille.ts constructs a GridSampler at module load, which reaches for
 * OffscreenCanvas/document. Install a node-backed OffscreenCanvas BEFORE any
 * mode module is (dynamically) imported so that construction succeeds.
 */
export function installCanvasPolyfill(): void {
  const g = globalThis as unknown as { OffscreenCanvas?: unknown };
  if (g.OffscreenCanvas) return;
  g.OffscreenCanvas = class {
    constructor(w = 1, h = 1) {
      return createCanvas(w, h) as unknown as object;
    }
  };
}

/** node canvas contexts are structurally compatible with the DOM 2D type. */
const asDomCtx = (ctx: SKRSContext2D): CanvasRenderingContext2D =>
  ctx as unknown as CanvasRenderingContext2D;

const FONT: GridOptions = {
  // Headless uses generic monospace; JetBrains Mono (OFL) is a browser asset and
  // is not registered here. grid.ts measures the aspect either way, so geometry
  // stays honest — this only affects which glyph outlines rasterise.
  fontSize: 12,
  fontFamily: 'monospace',
  lineHeight: 1,
};

/** Neutral options; density 0 / coverage 100 so tone maps across the full ramp. */
export function defaultOptions(patch: Partial<RenderOptions> = {}): RenderOptions {
  return {
    mode: '',
    font: FONT,
    color: { brightness: 0, contrast: 0, saturation: 100, grayscale: 0, filter: 'none' },
    ramp: { ramp: '@#S08Xx+=-;:. ', invert: false, density: 0, coverage: 100 },
    background: null,
    foreground: '#ffffff',
    ...patch,
  };
}

/** Downscale-to-grid sample of a source canvas — the framerate-critical path. */
function sampleToGrid(source: Canvas, grid: GridSpec): SampleResult {
  const c = createCanvas(grid.cols, grid.rows);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, grid.cols, grid.rows);
  const data = ctx.getImageData(0, 0, grid.cols, grid.rows).data;
  return { data: data as unknown as Uint8ClampedArray, cols: grid.cols, rows: grid.rows };
}

export interface RenderResult {
  canvas: Canvas;
  ctx: SKRSContext2D;
  grid: GridSpec;
  width: number;
  height: number;
}

/** Render one mode over one fixture. Returns the output canvas + geometry. */
export function renderMode(
  mode: ModeRenderer,
  fixture: FixtureName,
  width: number,
  height: number,
  patch: Partial<RenderOptions> = {},
): RenderResult {
  const out = createCanvas(width, height);
  const octx = out.getContext('2d');

  const src = createCanvas(width, height);
  drawFixture(fixture, asDomCtx(src.getContext('2d')), width, height);

  const grid = solveGrid(asDomCtx(octx), width, height, FONT);
  const sample = sampleToGrid(src, grid);
  const opts = defaultOptions(patch);

  octx.clearRect(0, 0, width, height);
  if (opts.background) {
    octx.fillStyle = opts.background;
    octx.fillRect(0, 0, width, height);
  }

  if (mode.renderGrid) {
    mode.renderGrid(asDomCtx(octx), sample, grid, opts);
  } else if (mode.renderCell) {
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        mode.renderCell(asDomCtx(octx), sample, grid, opts, col, row);
      }
    }
  }

  return { canvas: out, ctx: octx, grid, width, height };
}

/**
 * Render directly from a caller-supplied grid sample (bypasses the fixture
 * sampler). Used by the targeted geometry tests that need to hand a mode an
 * exact, hand-built cell buffer.
 */
export function renderSample(
  mode: ModeRenderer,
  sample: SampleResult,
  grid: GridSpec,
  width: number,
  height: number,
  patch: Partial<RenderOptions> = {},
): RenderResult {
  const out = createCanvas(width, height);
  const octx = out.getContext('2d');
  const opts = defaultOptions(patch);

  octx.clearRect(0, 0, width, height);
  if (opts.background) {
    octx.fillStyle = opts.background;
    octx.fillRect(0, 0, width, height);
  }
  if (mode.renderGrid) mode.renderGrid(asDomCtx(octx), sample, grid, opts);
  return { canvas: out, ctx: octx, grid, width, height };
}

export interface Rgba { r: number; g: number; b: number; a: number }

/** Full-canvas RGBA read for pixel assertions. */
export function readPixels(res: RenderResult): Uint8ClampedArray {
  return res.ctx.getImageData(0, 0, res.width, res.height)
    .data as unknown as Uint8ClampedArray;
}

/* ================================================================== */
/* Post-FX headless harness — W6.V6                                    */
/*                                                                      */
/* The PostFxChain runs on offscreen 2D contexts; here they are        */
/* @napi-rs/canvas contexts injected through the chain's `createContext`*/
/* hook so the whole tail of the pipeline runs under Node.              */
/* ================================================================== */

/** Backdrop the chain composites the glyph layer over (matches render-modes). */
export const POSTFX_BACKDROP = '#808080';

/** node-canvas factory for the chain's scratch/offscreen surfaces. */
export function nodeCreateContext(width: number, height: number): CanvasRenderingContext2D {
  const c = createCanvas(Math.max(1, width), Math.max(1, height));
  return asDomCtx(c.getContext('2d'));
}

/** A chain whose offscreen surfaces are node canvases. */
export function makePostFxChain(): PostFxChain {
  return new PostFxChain({ createContext: nodeCreateContext });
}

/**
 * The ONE base frame every post-FX proof shares: characters mode over the
 * ramp fixture, drawn on a transparent surface (no backdrop) so it can serve
 * as the isolated glyph layer the chain composites.
 */
export function baseGlyphLayer(width: number, height: number): Canvas {
  return renderMode(charactersMode, 'ramp-linear', width, height).canvas;
}

/**
 * Base glyph layer with glyphs confined to the left `fraction` of the width,
 * leaving a genuine transparent backdrop band on the right. The full ramp fills
 * every column with ink, so isolation tests (does a glyph-stage effect leave the
 * backdrop alone?) need a frame that actually HAS backdrop far from any glyph.
 */
export function baseGlyphLayerPartial(
  width: number,
  height: number,
  fraction = 0.6,
): Canvas {
  const glyphW = Math.max(1, Math.round(width * fraction));
  const inked = renderMode(charactersMode, 'ramp-linear', glyphW, height).canvas;
  const out = createCanvas(width, height);
  out.getContext('2d').drawImage(inked, 0, 0);
  return out;
}

/**
 * A fully-opaque horizontal grayscale ramp: R=G=B at every pixel, dark left to
 * bright right. A neutral, continuous-tone source the sparse text fixture is not.
 * Two properties the amount-monotonicity and neutrality guards rely on: a
 * displacement effect's divergence from OFF grows monotonically with the offset
 * (continuous tone has no stroke re-overlap or edge-clamp border that saturates
 * or reverses whole-frame SAD the way sparse glyphs on a flat backdrop do), and
 * any per-channel mean drift in the output is a colour cast the effect itself
 * introduced, never a property of the source.
 */
export function neutralRampLayer(width: number, height: number): Canvas {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  const denom = Math.max(1, width - 1);
  for (let x = 0; x < width; x++) {
    const v = Math.round((255 * x) / denom);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x, 0, 1, height);
  }
  return c;
}

/** Composite the glyph layer over the backdrop with NO effects — the clean base. */
export function compositeBase(
  glyph: Canvas,
  width: number,
  height: number,
  backdrop: string | null = POSTFX_BACKDROP,
): Canvas {
  const out = createCanvas(width, height);
  const ctx = out.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (backdrop) {
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(glyph, 0, 0);
  return out;
}

export interface EffectSetting {
  id: EffectId;
  /** Slider value; omit to use the effect's default. */
  amount?: number;
}

/**
 * Run the chain over a fresh copy of the base glyph layer with exactly the
 * given effects enabled (everything else forced off at its default amount).
 * A fresh glyph + output canvas each call, but the SAME chain instance across
 * calls — so any leaked scratch/module state surfaces on the next render.
 */
export function renderPostFx(
  chain: PostFxChain,
  glyph: Canvas,
  settings: readonly EffectSetting[],
  width: number,
  height: number,
  backdrop: string | null = POSTFX_BACKDROP,
): Canvas {
  for (const e of chain.effects) {
    e.enabled = false;
    e.amount = e.default;
  }
  for (const s of settings) {
    const e = chain.get(s.id);
    e.enabled = true;
    if (s.amount !== undefined) e.amount = s.amount;
  }

  const g = createCanvas(width, height);
  g.getContext('2d').drawImage(glyph, 0, 0);
  const out = createCanvas(width, height);
  chain.render({
    glyph: asDomCtx(g.getContext('2d')),
    backdrop,
    output: asDomCtx(out.getContext('2d')),
    width,
    height,
  });
  return out;
}

/** Full-canvas RGBA read of a bare canvas. */
export function readCanvas(canvas: Canvas): Uint8ClampedArray {
  return canvas
    .getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height)
    .data as unknown as Uint8ClampedArray;
}
