/**
 * Disco mode — T15 (a DESIGN task, not replication).
 *
 * The reference lists `disco` with a sparkle marker but its behaviour was never
 * confirmed; this is OUR take. It reuses the glyph renderer's text layout and
 * colour bucketing wholesale (renderGlyphs) and only overrides the per-cell
 * colour: the character each cell draws still comes from source luminance, so
 * the picture keeps reading — disco recolours it, it does not scramble it.
 *
 * The colour is an animated rainbow. HUE is a function of grid position plus a
 * time offset, giving a diagonal band of colour that sweeps across the grid.
 * SATURATION and LIGHTNESS are driven by the cell's luminance, so bright parts
 * of the source stay bright and dark parts stay dark — the shimmer rides on top
 * of the image instead of erasing it.
 *
 * Inherently animated: `animated = true` keeps the renderer's frame loop alive
 * even on a still source (see Renderer.needsFrame).
 */

import type { ModeRenderer } from '../renderer';
import { renderGlyphs, resolveCharRamp } from './glyph';

/** Degrees of hue added per grid cell along the sweep diagonal. */
const HUE_PER_CELL = 6;
/** Degrees of hue per second — the sweep speed. */
const HUE_PER_SECOND = 90;

/**
 * HSL → packed 0xRRGGBB. h in degrees (any range), s/l in 0..1. Standard
 * piecewise conversion; kept local so disco carries no dependency on a colour
 * lib the rest of the engine does not use.
 */
function hslToPacked(h: number, s: number, l: number): number {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }

  const to255 = (v: number): number => Math.round((v + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

export const discoMode: ModeRenderer = {
  animated: true,
  renderGrid(ctx, sample, grid, opts) {
    const ramp = resolveCharRamp(opts);
    // Seconds — the frame loop repaints continuously, so this advances the sweep.
    const t = performance.now() / 1000;
    const phase = t * HUE_PER_SECOND;

    renderGlyphs(ctx, sample, grid, opts, () => ramp, (col, row, l) => {
      const hue = (col + row) * HUE_PER_CELL + phase;
      // Luminance shapes tone: mid-lit cells are the most saturated, and
      // lightness tracks the source so the image still resolves under the wash.
      const sat = 0.55 + 0.45 * (1 - Math.abs(l - 0.5) * 2);
      const light = 0.25 + 0.55 * l;
      return hslToPacked(hue, sat, light);
    });
  },
};

/** Registry key → renderer, for Renderer.registerMode wiring. */
export const discoModes: Record<string, ModeRenderer> = {
  disco: discoMode,
};
