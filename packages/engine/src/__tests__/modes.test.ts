/**
 * Mode visual-correctness suite — W3.V3, Deliverable 3.
 *
 * `tsc --noEmit` proves the modes COMPILE. It says nothing about whether they
 * DRAW. A mode can typecheck perfectly and paint pure garbage — or nothing at
 * all. These assertions are the gate that catches that: every registered mode
 * is rendered on a real (headless) canvas and its pixels are interrogated.
 *
 * Nothing here is eyeballed. Each check is a numeric assertion against the
 * rendered buffer. The polyfill that lets the mode modules load under Node is
 * installed by scripts/vitest-setup.ts before this file imports them.
 */

import { describe, it, expect } from 'vitest';
import { renderMode, renderSample, readPixels } from '../../../../scripts/harness';
import type { ModeRenderer } from '../renderer';
import type { SampleResult } from '../sample';
import type { GridSpec } from '../grid';
import { luminance } from '../color';
import { glyphModes } from '../modes/glyph';
import { shapeModes } from '../modes/shape';
import { blockModes, legoMode } from '../modes/block';
import { voxelModes, voxelMode } from '../modes/voxel';
import { brailleModes, brailleGlyph, BRAILLE_DOT_BITS } from '../modes/braille';
import { discoModes } from '../modes/disco';

/** The full registered set. TEARDOWN §3.1 lists 15 style modes; `dither` has no
 * renderer, so this is 14 — see the "registry coverage" describe block. */
const REGISTRY: Record<string, ModeRenderer> = {
  ...glyphModes,
  ...shapeModes,
  ...blockModes,
  ...voxelModes,
  ...brailleModes,
  ...discoModes,
};

const MODE_KEYS = Object.keys(REGISTRY);

const W = 240;
const H = 160;
const ALPHA_MIN = 10; // ignore sub-threshold antialias fringe

interface Bbox { minX: number; minY: number; maxX: number; maxY: number; drawn: number }

function scan(px: Uint8ClampedArray, w: number, h: number): {
  bbox: Bbox;
  colors: Set<number>;
} {
  const bbox: Bbox = { minX: w, minY: h, maxX: -1, maxY: -1, drawn: 0 };
  const colors = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] <= ALPHA_MIN) continue;
      bbox.drawn++;
      if (x < bbox.minX) bbox.minX = x;
      if (y < bbox.minY) bbox.minY = y;
      if (x > bbox.maxX) bbox.maxX = x;
      if (y > bbox.maxY) bbox.maxY = y;
      colors.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    }
  }
  return { bbox, colors };
}

/** Mean Rec.709 luminance of drawn pixels in each of `n` vertical bands. Bands
 * with too few drawn pixels return null (skipped by the monotonicity check). */
function bandLuminance(px: Uint8ClampedArray, w: number, h: number, n: number): (number | null)[] {
  const sums = new Array<number>(n).fill(0);
  const counts = new Array<number>(n).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] <= ALPHA_MIN) continue;
      const b = Math.min(n - 1, Math.floor((x / w) * n));
      sums[b] += luminance(px[i], px[i + 1], px[i + 2]);
      counts[b]++;
    }
  }
  return sums.map((s, i) => (counts[i] >= 12 ? s / counts[i] : null));
}

function countMismatch(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/* ================================================================== */
/* Registry coverage — documents the missing `dither` mode as a finding */
/* ================================================================== */

describe('registry coverage', () => {
  it('exposes the 14 modes that have renderers', () => {
    expect(MODE_KEYS.sort()).toEqual(
      [
        '3d', 'block-chars', 'braille', 'characters', 'cross', 'diamond',
        'disco', 'diagonal', 'dots', 'lego', 'lines', 'mixed', 'mosaic', 'pixel',
      ].sort(),
    );
  });

  // FINDING (W3.V3): TEARDOWN §3.1 lists 15 style modes including `dither`, but
  // no renderer is registered under that key. Selecting it in the UI would
  // dispatch to nothing. Reported, not fixed — a renderer is a separate task.
  it('has NO renderer for the spec-listed `dither` mode', () => {
    expect(REGISTRY['dither']).toBeUndefined();
  });
});

/* ================================================================== */
/* Per-mode: NOT BLANK · MONOTONIC · IN-BOUNDS                          */
/* ================================================================== */

describe('every mode renders the grayscale ramp correctly', () => {
  for (const key of MODE_KEYS) {
    const mode = REGISTRY[key];

    it(`${key}: is NOT blank (>1 distinct drawn colour)`, () => {
      const res = renderMode(mode, 'ramp-linear', W, H);
      const { bbox, colors } = scan(readPixels(res), W, H);
      expect(bbox.drawn).toBeGreaterThan(0);
      expect(colors.size).toBeGreaterThan(1);
    });

    it(`${key}: tone is MONOTONIC across the ramp (dark→light)`, () => {
      const res = renderMode(mode, 'ramp-linear', W, H);
      const means = bandLuminance(readPixels(res), W, H, 4).filter(
        (v): v is number => v !== null,
      );
      // The ink of every mode is coloured by the source cell, so drawn-pixel
      // luminance must rise from the dark end of the ramp to the light end.
      expect(means.length).toBeGreaterThanOrEqual(2);
      expect(means[means.length - 1]).toBeGreaterThan(means[0] + 0.05);
      // ...and it must not lurch backwards (a broken luminance→ink map would).
      for (let i = 1; i < means.length; i++) {
        expect(means[i]).toBeGreaterThanOrEqual(means[i - 1] - 0.06);
      }
    });

    it(`${key}: draws IN-BOUNDS of the grid rect`, () => {
      const res = renderMode(mode, 'ramp-linear', W, H);
      const { bbox } = scan(readPixels(res), W, H);
      const gx = res.grid.cols * res.grid.cellW;
      const gy = res.grid.rows * res.grid.cellH;
      expect(bbox.minX).toBeGreaterThanOrEqual(-2);
      expect(bbox.minY).toBeGreaterThanOrEqual(-2);
      expect(bbox.maxX).toBeLessThanOrEqual(gx + 3);
      expect(bbox.maxY).toBeLessThanOrEqual(gy + 3);
    });
  }
});

/* ================================================================== */
/* Per-mode: DETERMINISTIC (animated modes excluded)                    */
/* ================================================================== */

describe('non-animated modes are deterministic', () => {
  for (const key of MODE_KEYS) {
    const mode = REGISTRY[key];
    if (mode.animated) continue; // disco sweeps on performance.now()

    it(`${key}: identical input → byte-identical output`, () => {
      const a = readPixels(renderMode(mode, 'ramp-linear', W, H));
      const b = readPixels(renderMode(mode, 'ramp-linear', W, H));
      expect(countMismatch(a, b)).toBe(0);
    });
  }

  it('disco is flagged animated (and so excluded above)', () => {
    expect(discoModes['disco'].animated).toBe(true);
  });
});

/* ================================================================== */
/* High-risk: voxel painter's order                                     */
/* ================================================================== */

describe('voxel painter order (nearer cube overdraws farther)', () => {
  it('the front cube is not occluded by the back cube', () => {
    // 2×1 grid. cell(1,0) has greater depth (col+row) so it is drawn LAST and
    // must overdraw cell(0,0). Both are near-equal luminance (near-equal height)
    // but opposite hue, so the winner of the overlap is identifiable per pixel.
    const data = new Uint8ClampedArray(2 * 1 * 4);
    data.set([255, 180, 180, 255], 0); // (0,0) back  — red-dominant
    data.set([180, 180, 255, 255], 4); // (1,0) front — blue-dominant
    const sample: SampleResult = { data, cols: 2, rows: 1 };
    const grid: GridSpec = { cols: 2, rows: 1, cellW: 40, cellH: 40, charAspect: 1 };

    const px = readPixels(renderSample(voxelMode, sample, grid, 220, 220));
    let red = 0;
    let blue = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] <= ALPHA_MIN) continue;
      if (px[i] > px[i + 2] + 8) red++;
      else if (px[i + 2] > px[i] + 8) blue++;
    }
    expect(red).toBeGreaterThan(0);
    expect(blue).toBeGreaterThan(0);
    // Front (blue) is never occluded; back (red) loses its overlapped corner.
    // If the paint order were reversed, red would dominate instead.
    expect(blue).toBeGreaterThan(red);
  });
});

/* ================================================================== */
/* High-risk: braille historical bit layout                             */
/* ================================================================== */

describe('braille dot→bit layout is the historical (non-sequential) one', () => {
  it('column 0 bits are 0x01,0x02,0x04,0x40 (NOT 0x08 for row 3)', () => {
    expect(BRAILLE_DOT_BITS[0]).toEqual([0x01, 0x02, 0x04, 0x40]);
  });

  it('column 1 bits are 0x08,0x10,0x20,0x80', () => {
    expect(BRAILLE_DOT_BITS[1]).toEqual([0x08, 0x10, 0x20, 0x80]);
  });

  it('empty mask → U+2800, full mask → U+28FF', () => {
    expect(brailleGlyph(0)).toBe('⠀');
    expect(brailleGlyph(0xff)).toBe('⣿');
  });

  it('a known dot pattern maps to a known code point', () => {
    // Top-left dot (col0,row0 = 0x01) + bottom-right dot (col1,row3 = 0x80).
    const mask = BRAILLE_DOT_BITS[0][0] | BRAILLE_DOT_BITS[1][3];
    expect(mask).toBe(0x81);
    expect(brailleGlyph(mask)).toBe(String.fromCharCode(0x2800 + 0x81));
  });

  it('rejects a plausible sequential mapping', () => {
    // A naive column-major sequential fill would put 0x08 at (col0,row3); the
    // historical layout puts 0x40 there. Guard against the tempting-but-wrong one.
    expect(BRAILLE_DOT_BITS[0][3]).not.toBe(0x08);
    expect(BRAILLE_DOT_BITS[0][3]).toBe(0x40);
  });
});

/* ================================================================== */
/* High-risk: lego bevel (a flat circle reads as a dot, not a LEGO knob) */
/* ================================================================== */

describe('lego stud has a bevel', () => {
  it('a mid-grey cell yields both a lighter face and a darker bevel', () => {
    const data = new Uint8ClampedArray(4);
    data.set([128, 128, 128, 255], 0);
    const sample: SampleResult = { data, cols: 1, rows: 1 };
    const grid: GridSpec = { cols: 1, rows: 1, cellW: 120, cellH: 120, charAspect: 1 };

    const px = readPixels(renderSample(legoMode, sample, grid, 120, 120));
    let min = 255;
    let max = 0;
    let base = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] <= ALPHA_MIN) continue;
      const v = px[i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (v >= 126 && v <= 130) base++;
    }
    expect(base).toBeGreaterThan(0);       // the flat cell colour is present
    expect(max).toBeGreaterThan(138);      // raised stud face (lightened)
    // The bevel is the load-bearing bit: darker than the base. A flat circle
    // (highlight only) never drops below the base colour and would fail here.
    expect(min).toBeLessThan(122);
  });
});
