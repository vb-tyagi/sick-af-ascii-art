/**
 * Voxel mode — T14 (registry key `3d`, labelled Voxel; §3.1, §4.3).
 *
 * Each cell becomes an isometric cube whose height is driven by Rec.709
 * luminance. Three faces are visible — top, left, right — flat-shaded from one
 * fixed light at 100% / 65% / 40% of the cell colour. Those ratios are what make
 * a stack of cubes read as 3D; equal-shaded faces collapse into flat hexagons.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 *  1. Painter's order. Cubes are drawn strictly back-to-front so nearer cubes
 *     overdraw farther ones. We walk anti-diagonals of ascending depth
 *     (col + row); cubes on one diagonal never overlap, and any cube that could
 *     occlude another has strictly greater depth, so this order is exact for
 *     arbitrary heights. Because order is fixed, faces cannot be colour-batched
 *     the way the flat modes batch — correctness wins over the fillStyle churn.
 *
 *  2. Cubes overflow their cell bounds upward. The layout is fit to the whole
 *     canvas with `maxHeight` of vertical headroom reserved above the grid, so
 *     the tallest possible cube lands inside the canvas instead of clipping at
 *     the top edge.
 */

import type { ModeRenderer } from '../renderer';
import type { SampleResult } from '../sample';
import type { GridSpec } from '../grid';
import { luminance } from '../color';

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;
/** Tallest cube, in projected grid units (2*SIN30 == 1 unit per cube layer). */
const HEIGHT_UNITS = 3;
/** Face brightness relative to the cell colour; the 3D read lives in these. */
const LEFT_SHADE = 0.65;
const RIGHT_SHADE = 0.4;
/** Keep the fitted projection a hair inside the canvas. */
const FIT_MARGIN = 0.98;

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Cell colour scaled by a single flat-shading factor, as a hex string. */
function shade(r: number, g: number, b: number, f: number): string {
  const nr = clampByte(r * f);
  const ng = clampByte(g * f);
  const nb = clampByte(b * f);
  return '#' + ((nr << 16) | (ng << 8) | nb).toString(16).padStart(6, '0');
}

function hexColor(r: number, g: number, b: number): string {
  return '#' + ((clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b)).toString(16).padStart(6, '0');
}

export const voxelMode: ModeRenderer = {
  renderGrid(ctx, sample: SampleResult, grid: GridSpec) {
    const { cols, rows, data } = sample;
    if (cols === 0 || rows === 0) return;

    // Lay out inside the grid's nominal box (CSS px, so DPR-agnostic — the
    // renderer already scaled the context). Isometric never fills a rectangle
    // edge to edge; the footprint is a centred diamond within this box.
    const W = grid.cols * grid.cellW;
    const H = grid.rows * grid.cellH;
    if (W <= 0 || H <= 0) return;

    // Solve the grid-unit scale `u` so the whole isometric footprint plus the
    // reserved cube headroom fits the canvas. Half-diamond extents per unit are
    // (COS30, SIN30); total footprint spans (cols+rows) units on each axis.
    const span = cols + rows;
    const uW = W / (span * COS30);
    const uH = H / (span * SIN30 + HEIGHT_UNITS);
    const u = Math.min(uW, uH) * FIT_MARGIN;
    if (u <= 0) return;

    const hw = COS30 * u;
    const hh = SIN30 * u;
    const maxHeight = HEIGHT_UNITS * u;

    // Centre the footprint. Leftmost pixel sits `rows` half-widths left of the
    // (0,0) footprint centre; topmost sits a full maxHeight + one diamond above.
    const contentW = span * COS30 * u;
    const contentH = span * SIN30 * u + maxHeight;
    const originX = (W - contentW) / 2 + rows * hw;
    const originY = (H - contentH) / 2 + maxHeight + hh;

    // Anti-diagonal sweep: depth d = col + row, ascending == back-to-front.
    const maxD = cols - 1 + (rows - 1);
    for (let d = 0; d <= maxD; d++) {
      const colStart = Math.max(0, d - (rows - 1));
      const colEnd = Math.min(cols - 1, d);
      for (let col = colStart; col <= colEnd; col++) {
        const row = d - col;

        const i = (row * cols + col) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        const gCx = originX + (col - row) * hw;
        const groundCy = originY + (col + row) * hh;
        const colH = luminance(r, g, b) * maxHeight;
        const tY = groundCy - colH;

        // Left wall.
        if (colH > 0) {
          ctx.fillStyle = shade(r, g, b, LEFT_SHADE);
          ctx.beginPath();
          ctx.moveTo(gCx - hw, tY);
          ctx.lineTo(gCx, tY + hh);
          ctx.lineTo(gCx, tY + hh + colH);
          ctx.lineTo(gCx - hw, tY + colH);
          ctx.closePath();
          ctx.fill();

          // Right wall.
          ctx.fillStyle = shade(r, g, b, RIGHT_SHADE);
          ctx.beginPath();
          ctx.moveTo(gCx + hw, tY);
          ctx.lineTo(gCx, tY + hh);
          ctx.lineTo(gCx, tY + hh + colH);
          ctx.lineTo(gCx + hw, tY + colH);
          ctx.closePath();
          ctx.fill();
        }

        // Top face, drawn last so it caps the walls cleanly.
        ctx.fillStyle = hexColor(r, g, b);
        ctx.beginPath();
        ctx.moveTo(gCx, tY - hh);
        ctx.lineTo(gCx + hw, tY);
        ctx.lineTo(gCx, tY + hh);
        ctx.lineTo(gCx - hw, tY);
        ctx.closePath();
        ctx.fill();
      }
    }
  },
};

/** Registry key → renderer, for Renderer.registerMode wiring. */
export const voxelModes: Record<string, ModeRenderer> = {
  '3d': voxelMode,
};
