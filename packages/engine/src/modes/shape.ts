/**
 * Shape modes — T12.
 *
 * The shape family (§4.3): dots, lines, diagonal, cross, diamond. Each maps a
 * cell's Rec.709 luminance to a geometric primitive sized by that luminance and
 * filled with the sampled cell colour — glyph-free rendering.
 *
 * Perf is the whole task. Fills are grouped by packed colour and every cell in a
 * bucket is added to ONE path, then filled ONCE. Per-cell beginPath+fill is the
 * 60fps-vs-15fps difference on video, so the batch is non-negotiable here.
 *
 * invert and density are read off RampOptions exactly as luminanceToChar reads
 * them, so tone maps identically to the glyph family; coverage gates whether a
 * cell draws at all; charOpacity drives globalAlpha.
 */

import type { ModeRenderer, RenderOptions } from '../renderer';
import type { SampleResult } from '../sample';
import type { GridSpec } from '../grid';
import { luminance, type RampOptions } from '../color';

/** Shape-family controls layered on RenderOptions, threaded through untouched. */
interface ShapeOptions {
  /** 0..100. */
  charOpacity?: number;
}

interface ShapeRenderOptions extends RenderOptions {
  glyph?: ShapeOptions;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function hexColor(packed: number): string {
  return '#' + (packed & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Normalised ink amount for a cell, 0..1. Mirrors luminanceToChar's invert +
 * density transform so a shape's size tracks the same tonal band a glyph would.
 * Below the density cut the cell carries no ink and returns 0.
 */
function inkAmount(l: number, ramp: RampOptions): number {
  let v = ramp.invert ? 1 - l : l;
  const cut = ramp.density / 100;
  if (v < cut) return 0;
  return cut < 1 ? (v - cut) / (1 - cut) : v;
}

/**
 * Stable per-cell value in [0,1) for the coverage gate. Deterministic in
 * (col,row) so the gate never flickers frame to frame on video.
 */
function cellNoise(col: number, row: number): number {
  let h = (col * 374761393 + row * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return h / 4294967296;
}

interface Cell { cx: number; cy: number; a: number }

/** Adds one cell's primitive to the current path — no fill, no beginPath. */
type AddShape = (
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  cellW: number,
  cellH: number,
) => void;

function renderShapes(
  ctx: CanvasRenderingContext2D,
  sample: SampleResult,
  grid: GridSpec,
  opts: ShapeRenderOptions,
  addShape: AddShape,
): void {
  const { cellW, cellH } = grid;
  const { cols, rows, data } = sample;
  const ramp = opts.ramp;
  const coverage = ramp.coverage / 100;

  ctx.save();
  ctx.globalAlpha = clamp01((opts.glyph?.charOpacity ?? 100) / 100);

  // Bucket by packed colour so fillStyle is assigned once per distinct colour
  // and every cell of that colour fills in a single path.
  const buckets = new Map<number, Cell[]>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (coverage < 1 && cellNoise(col, row) >= coverage) continue;

      const i = (row * cols + col) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = inkAmount(luminance(r, g, b), ramp);
      // Zero ink draws nothing and reads identically to a skipped cell.
      if (a <= 0) continue;

      const key = (r << 16) | (g << 8) | b;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push({ cx: col * cellW + cellW / 2, cy: row * cellH + cellH / 2, a });
    }
  }

  for (const [key, cells] of buckets) {
    ctx.fillStyle = hexColor(key);
    ctx.beginPath();
    for (let k = 0; k < cells.length; k++) {
      addShape(ctx, cells[k], cellW, cellH);
    }
    ctx.fill();
  }

  ctx.restore();
}

// --- primitives -----------------------------------------------------------
// Each adds a closed subpath. Circles moveTo the arc start first so the batched
// path carries no stray connecting line between successive cells.

const addDot: AddShape = (ctx, { cx, cy, a }, cellW, cellH) => {
  const r = a * (Math.min(cellW, cellH) / 2);
  if (r <= 0) return;
  ctx.moveTo(cx + r, cy);
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
};

const addLine: AddShape = (ctx, { cx, cy, a }, cellW, cellH) => {
  const t = a * cellH;
  ctx.rect(cx - cellW / 2, cy - t / 2, cellW, t);
};

const addDiagonal: AddShape = (ctx, { cx, cy, a }, cellW, cellH) => {
  const t = a * Math.min(cellW, cellH);
  // Unit vector along the cell diagonal (bottom-left -> top-right) and its
  // perpendicular; the primitive is a rotated rectangle spanning the cell.
  const len = Math.hypot(cellW, cellH);
  const dx = cellW / len;
  const dy = -cellH / len;
  const hx = (dx * len) / 2;
  const hy = (dy * len) / 2;
  const px = (-dy * t) / 2;
  const py = (dx * t) / 2;
  ctx.moveTo(cx - hx + px, cy - hy + py);
  ctx.lineTo(cx + hx + px, cy + hy + py);
  ctx.lineTo(cx + hx - px, cy + hy - py);
  ctx.lineTo(cx - hx - px, cy - hy - py);
  ctx.closePath();
};

const addCross: AddShape = (ctx, { cx, cy, a }, cellW, cellH) => {
  const t = a * Math.min(cellW, cellH);
  ctx.rect(cx - cellW / 2, cy - t / 2, cellW, t);
  ctx.rect(cx - t / 2, cy - cellH / 2, t, cellH);
};

const addDiamond: AddShape = (ctx, { cx, cy, a }, cellW, cellH) => {
  const s = a * (Math.min(cellW, cellH) / 2);
  if (s <= 0) return;
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s, cy);
  ctx.lineTo(cx, cy + s);
  ctx.lineTo(cx - s, cy);
  ctx.closePath();
};

function shapeMode(addShape: AddShape): ModeRenderer {
  return {
    renderGrid(ctx, sample, grid, opts) {
      renderShapes(ctx, sample, grid, opts, addShape);
    },
  };
}

export const dotsMode: ModeRenderer = shapeMode(addDot);
export const linesMode: ModeRenderer = shapeMode(addLine);
export const diagonalMode: ModeRenderer = shapeMode(addDiagonal);
export const crossMode: ModeRenderer = shapeMode(addCross);
export const diamondMode: ModeRenderer = shapeMode(addDiamond);

/** Registry keys → renderers, for Renderer.registerMode wiring. */
export const shapeModes: Record<string, ModeRenderer> = {
  dots: dotsMode,
  lines: linesMode,
  diagonal: diagonalMode,
  cross: crossMode,
  diamond: diamondMode,
};
