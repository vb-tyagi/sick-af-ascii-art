/**
 * Dither mode — T16 (the 15th style mode of TEARDOWN §3.1).
 *
 * This is the ModeRenderer that WIRES UP the dither engine (../dither); it owns
 * no kernels of its own. The engine is already correct and unit-tested — this
 * module only feeds it the downscaled grid buffer and paints the quantised
 * result as one filled rect per cell. It is a BLOCK-family paint (solid cells),
 * not a glyph paint.
 *
 * Palette registry seam: W4.T18b ships src/engine/palettes.ts. Until it lands
 * this module carries a minimal internal default (1-bit mono + a 4-tone grey);
 * a caller overrides via opts.dither.palette, and the registry can later supply
 * that list without any change here.
 *
 * Perf: dithering runs over the GRID buffer (cols×rows), never full resolution,
 * so even the serial error-diffusion kernels touch only a few thousand cells —
 * cheap enough to stay video-safe. `animated` is false: the output is a pure
 * function of the sampled grid, so a still source must never repaint. For the
 * case the brief flags — a live video under an error-diffusion algorithm — we
 * expose an explicit fallback SEAM (opts.dither.videoActive) that swaps to
 * ordered Bayer rather than capping the frame rate, keeping every frame stateless.
 */

import type { ModeRenderer, RenderOptions } from '../renderer';
import type { SampleResult } from '../sample';
import type { GridSpec } from '../grid';
import { dither, isErrorDiffusion, type DitherAlgorithm, type RGBTuple } from '../dither';
import { PALETTES } from '../palettes';

/** 1-bit black/white — the classic dither target. */
export const PALETTE_MONO: readonly RGBTuple[] = [
  [0, 0, 0],
  [255, 255, 255],
];

/** 4-tone grey ramp; error diffusion resolves smooth tone across four levels. */
export const PALETTE_GREY4: readonly RGBTuple[] = [
  [0, 0, 0],
  [85, 85, 85],
  [170, 170, 170],
  [255, 255, 255],
];

/**
 * Named palettes the mode understands by default. The W4.T18b registry
 * (../palettes) supplies the 16 retro sets; grey4 stays as a pure-tone default
 * for smooth error-diffusion tests. A caller still overrides via opts.dither.palette.
 */
export const DEFAULT_DITHER_PALETTES: Record<string, readonly RGBTuple[]> = {
  grey4: PALETTE_GREY4,
  ...Object.fromEntries(PALETTES.map((p) => [p.key, p.colors])),
};

/** Ordered Bayer size used when falling back off an error-diffusion kernel. */
const VIDEO_FALLBACK: DitherAlgorithm = 'bayer4';

/**
 * Dither controls layered on RenderOptions. The renderer threads these through
 * untouched; the mode reads them off opts.dither.
 */
export interface DitherModeOptions {
  /** Any engine algorithm. Default floyd-steinberg. */
  algorithm?: DitherAlgorithm;
  /** sRGB 0..255 palette. Default PALETTE_MONO. */
  palette?: readonly RGBTuple[];
  /**
   * Set by the host when the source is a playing video. With an error-diffusion
   * algorithm this forces the ordered Bayer fallback so each frame stays
   * stateless; ignored for algorithms that are already stateless.
   */
  videoActive?: boolean;
}

export interface DitherRenderOptions extends RenderOptions {
  dither?: DitherModeOptions;
}

function hexColor(r: number, g: number, b: number): string {
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function resolveAlgorithm(o: DitherModeOptions): DitherAlgorithm {
  const algorithm = o.algorithm ?? 'floyd-steinberg';
  if (o.videoActive && isErrorDiffusion(algorithm)) return VIDEO_FALLBACK;
  return algorithm;
}

export const ditherMode: ModeRenderer = {
  animated: false,
  renderGrid(ctx: CanvasRenderingContext2D, sample: SampleResult, grid: GridSpec, opts: RenderOptions) {
    const o = (opts as DitherRenderOptions).dither ?? {};
    const { cols, rows, data } = sample;
    const { cellW, cellH } = grid;

    // Copy so the engine's in-place mutation never touches the sampler's buffer.
    const buf = new Uint8ClampedArray(data);
    dither(buf, {
      algorithm: resolveAlgorithm(o),
      palette: o.palette ?? PALETTE_MONO,
      width: cols,
      height: rows,
    });

    // Bucket by quantised colour so fillStyle is assigned once per palette entry.
    const buckets = new Map<number, Array<[number, number]>>();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = (row * cols + col) * 4;
        const key = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        arr.push([col * cellW, row * cellH]);
      }
    }

    for (const [key, cells] of buckets) {
      ctx.fillStyle = hexColor((key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff);
      for (let k = 0; k < cells.length; k++) {
        ctx.fillRect(cells[k][0], cells[k][1], cellW, cellH);
      }
    }
  },
};

/** Registry keys → renderers, for Renderer.registerMode wiring. */
export const ditherModes: Record<string, ModeRenderer> = {
  dither: ditherMode,
};
