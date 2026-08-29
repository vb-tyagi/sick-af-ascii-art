/**
 * Block modes — T13.
 *
 * The block family (§4.3): pixel, mosaic, lego. Unlike the shape family these
 * are not luminance-driven — every cell fills solid with its own sampled colour,
 * so the output reads as a colour downscale of the source rather than tonal ink.
 *
 * pixel:  flat fillRect per cell, the whole grid painted edge to edge.
 * mosaic: the same rects inset by a 1px grout gap; the gap shows the backdrop the
 *         renderer already painted, so grout needs no explicit fill.
 * lego:   a pixel cell plus a raised stud — a lightened circle at centre with a
 *         darker lower-right bevel arc. The bevel is load-bearing: a flat circle
 *         reads as a dot, the arc is what makes it read as a moulded LEGO knob.
 *
 * Perf: rects are bucketed by packed colour so fillStyle is assigned once per
 * distinct colour and a whole colour's cells fill in one run.
 */

import type { ModeRenderer } from '../renderer';
import type { SampleResult } from '../sample';
import type { GridSpec } from '../grid';

/** Grout gap (CSS px) between mosaic cells; the backdrop shows through it. */
const MOSAIC_GAP = 1;
/** Stud radius as a fraction of cell width. */
const STUD_RADIUS = 0.3;
/** Lighten fraction for the stud face relative to the cell colour. */
const STUD_LIGHTEN = 0.15;
/** Darken fraction for the stud's lower-right bevel arc. */
const STUD_BEVEL_DARKEN = 0.25;

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function hexColor(packed: number): string {
  return '#' + (packed & 0xffffff).toString(16).padStart(6, '0');
}

/** Lerp a packed RGB toward white (amt>0) or black (amt<0), returning a hex string. */
function shade(r: number, g: number, b: number, amt: number): string {
  const target = amt >= 0 ? 255 : 0;
  const t = Math.abs(amt);
  const nr = clampByte(r + (target - r) * t);
  const ng = clampByte(g + (target - g) * t);
  const nb = clampByte(b + (target - b) * t);
  return '#' + ((nr << 16) | (ng << 8) | nb).toString(16).padStart(6, '0');
}

interface Cell { x: number; y: number; r: number; g: number; b: number }

/**
 * Bucket every cell by its packed colour. Shared by all three block modes; each
 * mode then decides how to paint a bucket.
 */
function bucketCells(sample: SampleResult, grid: GridSpec): Map<number, Cell[]> {
  const { cellW, cellH } = grid;
  const { cols, rows, data } = sample;
  const buckets = new Map<number, Cell[]>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = (r << 16) | (g << 8) | b;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push({ x: col * cellW, y: row * cellH, r, g, b });
    }
  }
  return buckets;
}

/**
 * pixel / mosaic share the rect pass; `inset` trims each rect symmetrically so a
 * positive inset opens a grout gap that reveals the backdrop.
 */
function renderRects(
  ctx: CanvasRenderingContext2D,
  sample: SampleResult,
  grid: GridSpec,
  inset: number,
): void {
  const w = grid.cellW - inset * 2;
  const h = grid.cellH - inset * 2;
  if (w <= 0 || h <= 0) return;

  const buckets = bucketCells(sample, grid);
  for (const [key, cells] of buckets) {
    ctx.fillStyle = hexColor(key);
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      ctx.fillRect(c.x + inset, c.y + inset, w, h);
    }
  }
}

export const pixelMode: ModeRenderer = {
  renderGrid(ctx, sample, grid) {
    renderRects(ctx, sample, grid, 0);
  },
};

export const mosaicMode: ModeRenderer = {
  renderGrid(ctx, sample, grid) {
    renderRects(ctx, sample, grid, MOSAIC_GAP / 2);
  },
};

export const legoMode: ModeRenderer = {
  renderGrid(ctx, sample, grid) {
    const { cellW, cellH } = grid;
    const radius = STUD_RADIUS * cellW;
    if (radius <= 0) {
      renderRects(ctx, sample, grid, 0);
      return;
    }

    const buckets = bucketCells(sample, grid);

    // Base cells first, batched by colour.
    for (const [key, cells] of buckets) {
      ctx.fillStyle = hexColor(key);
      for (let k = 0; k < cells.length; k++) {
        ctx.fillRect(cells[k].x, cells[k].y, cellW, cellH);
      }
    }

    // Studs second, still batched: every cell of a bucket shares the same stud
    // face and bevel colour, so each is set once and stroked/filled in a run.
    ctx.save();
    ctx.lineWidth = Math.max(1, radius * 0.35);
    for (const [, cells] of buckets) {
      const { r, g, b } = cells[0];
      const face = shade(r, g, b, STUD_LIGHTEN);
      const bevel = shade(r, g, b, -STUD_BEVEL_DARKEN);

      ctx.fillStyle = face;
      ctx.beginPath();
      for (let k = 0; k < cells.length; k++) {
        const cx = cells[k].x + cellW / 2;
        const cy = cells[k].y + cellH / 2;
        ctx.moveTo(cx + radius, cy);
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      }
      ctx.fill();

      // Lower-right quarter arc, inset slightly, as the moulded bevel highlight.
      ctx.strokeStyle = bevel;
      ctx.beginPath();
      for (let k = 0; k < cells.length; k++) {
        const cx = cells[k].x + cellW / 2;
        const cy = cells[k].y + cellH / 2;
        const br = radius * 0.8;
        ctx.moveTo(cx + Math.cos(0.15) * br, cy + Math.sin(0.15) * br);
        ctx.arc(cx, cy, br, 0.15, Math.PI / 2 - 0.05);
      }
      ctx.stroke();
    }
    ctx.restore();
  },
};

/** Registry keys → renderers, for Renderer.registerMode wiring. */
export const blockModes: Record<string, ModeRenderer> = {
  pixel: pixelMode,
  mosaic: mosaicMode,
  lego: legoMode,
};
