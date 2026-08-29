/**
 * Animated ASCII presets — T31 (a DESIGN task, not replication).
 *
 * The reference exposes an "Animated ASCII" toggle but never confirmed what its
 * presets do (TEARDOWN §3.8, marked UNVERIFIED). These are OURS: four modes that
 * animate a STILL source — no video required. Each keeps the picture readable by
 * sourcing every glyph from the cell's Rec.709 luminance (via the shared
 * luminanceToChar map) and layering motion on top; motion never erases the image.
 *
 * All four set `animated = true`. That is load-bearing: it makes Renderer.needsFrame
 * keep the rAF loop alive on a still image, which DEFEATS the dirty-flag idle
 * optimisation on purpose — a still source must keep repainting for these to move.
 * Only these modes opt in; every other still-image mode stays idle at rest.
 *
 * Motion is a pure function of performance.now(), so there is no per-mode state to
 * reset and the presets are frame-rate independent (time in seconds, not frames).
 */

import type { ModeRenderer } from './renderer';
import type { SampleResult } from './sample';
import type { GridSpec } from './grid';
import { luminance, luminanceToChar, type RampOptions } from './color';
import { resolveCharRamp, type GlyphRenderOptions } from './modes/glyph';

const TWO_PI = Math.PI * 2;

/** matrix: rows of fading trail behind each column's falling head. */
const MATRIX_TAIL = 8;
/** matrix: how many grid rows the head falls per second. */
const MATRIX_FALL_ROWS_PER_SEC = 14;
/** matrix: source cells dimmer than this grow no rain (gated by luminance). */
const MATRIX_GATE = 0.06;

/** shimmer: radians per second the ±1 ramp oscillation advances. */
const SHIMMER_SPEED = 6;

/** wave: peak vertical displacement, in cell heights. */
const WAVE_AMP_CELLS = 0.6;
/** wave: radians of phase added per column — the wavelength along the grid. */
const WAVE_FREQ = 0.5;
/** wave: radians per second the crest travels. */
const WAVE_SPEED = 3;

/** typewriter: cells revealed per second in reading order. */
const TYPE_CELLS_PER_SEC = 90;
/** typewriter: cells of blank hold after the last reveal before looping. */
const TYPE_PAUSE_CELLS = 60;

/**
 * Deterministic value noise in 0..1 from an integer cell coordinate. Kept local
 * (integer hash, no Math.random) so a cell's phase is stable across frames — the
 * animation reads as coherent motion, not per-frame static.
 */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function packedToHex(packed: number): string {
  return '#' + (packed & 0xffffff).toString(16).padStart(6, '0');
}

/** Ramp index backing a luminance, so a preset can nudge the glyph ±1 while
 * still respecting invert/density (which luminanceToChar already applied). */
function rampIndex(l: number, ramp: RampOptions): number {
  const idx = ramp.ramp.indexOf(luminanceToChar(l, ramp));
  return idx < 0 ? 0 : idx;
}

interface CellPaint {
  char: string;
  /** Packed 0xRRGGBB, or a negative value to fall back to opts.foreground. */
  color: number;
  dx?: number;
  dy?: number;
}

type CellVisitor = (
  col: number,
  row: number,
  l: number,
  r: number,
  g: number,
  b: number,
) => CellPaint | null;

/**
 * Shared per-cell paint loop for the animated presets. Sets ctx.font once, walks
 * the grid, and lets `visit` decide each cell's glyph, colour, and pixel offset
 * (return null to skip the cell entirely). Spaces carry no ink and are dropped.
 * Unlike renderGlyphs this does not colour-bucket: animated colours are per-cell
 * and mostly distinct, so a bucket map would only add overhead here.
 */
function paintCells(
  ctx: CanvasRenderingContext2D,
  sample: SampleResult,
  grid: GridSpec,
  opts: GlyphRenderOptions,
  visit: CellVisitor,
): void {
  const { cols, rows, data } = sample;
  const { cellW, cellH } = grid;
  const fg = opts.foreground ?? '#ffffff';

  ctx.save();
  ctx.font = `${opts.font.fontSize}px ${opts.font.fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = luminance(r, g, b);

      const p = visit(col, row, l, r, g, b);
      if (!p || p.char === ' ' || p.char === '') continue;

      ctx.fillStyle = p.color < 0 ? fg : packedToHex(p.color);
      ctx.fillText(p.char, col * cellW + (p.dx ?? 0), row * cellH + (p.dy ?? 0));
    }
  }
  ctx.restore();
}

/**
 * Matrix rain — a bright head falls down each column trailing a fading green tail.
 * Columns are desynchronised by a per-column hash phase. Gated by luminance: dark
 * source cells grow no rain and the trail's intensity tracks the cell tone, so the
 * cascade concentrates in the lit regions of the picture.
 */
export const matrixRainMode: ModeRenderer = {
  animated: true,
  renderGrid(ctx, sample, grid, opts) {
    const ramp = resolveCharRamp(opts);
    const t = performance.now() / 1000;
    const span = sample.rows + MATRIX_TAIL;

    paintCells(ctx, sample, grid, opts, (col, row, l) => {
      if (l < MATRIX_GATE) return null;
      const head = (t * MATRIX_FALL_ROWS_PER_SEC + hash2(col, 1) * span) % span;
      const dist = head - row;
      if (dist < 0 || dist > MATRIX_TAIL) return null;

      const trail = 1 - dist / MATRIX_TAIL;
      const intensity = trail * l;
      const tip = dist < 1 ? trail : 0; // whiten only the leading cell
      const g = Math.round(80 + 175 * intensity);
      const w = Math.round(210 * tip);
      return { char: luminanceToChar(l, ramp), color: (w << 16) | (g << 8) | w };
    });
  },
};

/**
 * Shimmer — every glyph's ramp index oscillates by ±1 around its luminance value,
 * each cell on its own hashed phase. The picture holds because no cell strays more
 * than one ramp step; the surface just breathes. Colour stays the sampled cell RGB.
 */
export const shimmerMode: ModeRenderer = {
  animated: true,
  renderGrid(ctx, sample, grid, opts) {
    const ramp = resolveCharRamp(opts);
    const t = performance.now() / 1000;
    const last = ramp.ramp.length - 1;

    paintCells(ctx, sample, grid, opts, (col, row, l, r, g, b) => {
      const offset = Math.round(Math.sin(hash2(col, row) * TWO_PI + t * SHIMMER_SPEED));
      const idx = clampInt(rampIndex(l, ramp) + offset, 0, last);
      return { char: ramp.ramp[idx], color: (r << 16) | (g << 8) | b };
    });
  },
};

/**
 * Wave — a sine crest travels along the columns, displacing each cell vertically.
 * Glyph and colour are the unmodified luminance mapping; only the draw position
 * moves, so the image ripples as a sheet rather than dissolving.
 */
export const waveMode: ModeRenderer = {
  animated: true,
  renderGrid(ctx, sample, grid, opts) {
    const ramp = resolveCharRamp(opts);
    const t = performance.now() / 1000;
    const amp = grid.cellH * WAVE_AMP_CELLS;

    paintCells(ctx, sample, grid, opts, (col, _row, l, r, g, b) => {
      const dy = amp * Math.sin(col * WAVE_FREQ + t * WAVE_SPEED);
      return { char: luminanceToChar(l, ramp), color: (r << 16) | (g << 8) | b, dy };
    });
  },
};

/**
 * Typewriter — cells reveal in reading order (row-major) behind a caret that
 * advances at a fixed rate, then holds blank and loops. Revealed cells keep their
 * sampled colour; the caret cell flashes white to mark the write head.
 */
export const typewriterMode: ModeRenderer = {
  animated: true,
  renderGrid(ctx, sample, grid, opts) {
    const ramp = resolveCharRamp(opts);
    const t = performance.now() / 1000;
    const total = sample.cols * sample.rows;
    const cursor = (t * TYPE_CELLS_PER_SEC) % (total + TYPE_PAUSE_CELLS);

    paintCells(ctx, sample, grid, opts, (col, row, l, r, g, b) => {
      const index = row * sample.cols + col;
      if (index > cursor) return null;
      const caret = cursor - index < 1;
      return {
        char: luminanceToChar(l, ramp),
        color: caret ? 0xffffff : (r << 16) | (g << 8) | b,
      };
    });
  },
};

/** Registry keys → renderers, for Renderer.registerMode wiring. */
export const animatedModes: Record<string, ModeRenderer> = {
  matrix: matrixRainMode,
  shimmer: shimmerMode,
  wave: waveMode,
  typewriter: typewriterMode,
};
