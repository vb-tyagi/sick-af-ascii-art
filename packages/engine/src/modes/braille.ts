/**
 * Braille mode — T11.
 *
 * Each Unicode braille glyph (U+2800 + an 8-bit mask) packs a 2-wide x 4-tall
 * dot matrix — 8 sub-pixels per cell, the highest resolution-per-cell of any
 * mode. So braille cannot read the standard grid buffer: it needs its own
 * sample at (cols*2) x (rows*4). The renderer only hands modes the grid-res
 * buffer, so this mode owns a private GridSampler and takes the source via
 * setSource() at wiring time; the transform is read off RenderOptions.
 *
 * The 1-bit per-sub-pixel decision is Floyd–Steinberg (from dither.ts) against
 * a black/white palette — the classic braille pairing, far better than a hard
 * threshold because the diffused error preserves tone the dot grid can't hold.
 */

import type { ModeRenderer, RenderOptions } from '../renderer';
import { GridSampler, type SampleResult, type SourceMedia, type SamplerTransform } from '../sample';
import type { GridSpec } from '../grid';
import { dither, type RGBTuple } from '../dither';

const BRAILLE_BASE = 0x2800;

/**
 * Historical dot-to-bit layout — NOT sequential. Indexed [col][row], col in
 * 0..1, row in 0..3. This exact mapping is what makes the glyphs legible.
 *   0x01 row0col0  0x08 row0col1
 *   0x02 row1col0  0x10 row1col1
 *   0x04 row2col0  0x20 row2col1
 *   0x40 row3col0  0x80 row3col1
 */
export const BRAILLE_DOT_BITS: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/** U+2800 + mask. Mask 0 yields U+2800 (blank braille). */
export function brailleGlyph(mask: number): string {
  return String.fromCharCode(BRAILLE_BASE | (mask & 0xff));
}

/** Two-level palette for the 1-bit dot decision. */
const BILEVEL: RGBTuple[] = [[0, 0, 0], [255, 255, 255]];

function hexColor(packed: number): string {
  return '#' + (packed & 0xffffff).toString(16).padStart(6, '0');
}

interface Draw { glyph: string; x: number; y: number }

export class BrailleMode implements ModeRenderer {
  private readonly sampler = new GridSampler();
  private source: SourceMedia | null = null;

  /** Wire the source at registration time — the renderer never passes it. */
  setSource(source: SourceMedia | null): void {
    this.source = source;
  }

  renderGrid(
    ctx: CanvasRenderingContext2D,
    sample: SampleResult,
    grid: GridSpec,
    opts: RenderOptions,
  ): void {
    const subCols = grid.cols * 2;
    const subRows = grid.rows * 4;
    if (subCols === 0 || subRows === 0) return;

    const sub = this.subSample(sample, grid, subCols, subRows, opts.transform);

    // Floyd–Steinberg snaps every sub-pixel to pure black or white in place.
    dither(sub, {
      algorithm: 'floyd-steinberg',
      palette: BILEVEL,
      width: subCols,
      height: subRows,
    });

    const invert = opts.ramp.invert;

    ctx.save();
    ctx.font = `${opts.font.fontSize}px ${opts.font.fontFamily}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // Bucket by packed cell colour so fillStyle is set once per distinct colour.
    const buckets = new Map<number, Draw[]>();

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        let mask = 0;
        for (let dc = 0; dc < 2; dc++) {
          const sx = col * 2 + dc;
          for (let dr = 0; dr < 4; dr++) {
            const sy = row * 4 + dr;
            const bright = sub[(sy * subCols + sx) * 4] >= 128;
            // Lit dots track brightness by default; invert flips the ink.
            if (bright !== invert) mask |= BRAILLE_DOT_BITS[dc][dr];
          }
        }
        if (mask === 0) continue;

        const ci = (row * sample.cols + col) * 4;
        const key =
          (sample.data[ci] << 16) | (sample.data[ci + 1] << 8) | sample.data[ci + 2];
        let arr = buckets.get(key);
        if (!arr) {
          arr = [];
          buckets.set(key, arr);
        }
        arr.push({ glyph: brailleGlyph(mask), x: col * grid.cellW, y: row * grid.cellH });
      }
    }

    for (const [key, ops] of buckets) {
      ctx.fillStyle = hexColor(key);
      for (let k = 0; k < ops.length; k++) {
        ctx.fillText(ops[k].glyph, ops[k].x, ops[k].y);
      }
    }

    ctx.restore();
  }

  /**
   * The finer buffer braille needs. With a source we resample it at 2x4 (a real
   * box-filter downscale). Without one — registered but not yet wired — we
   * nearest-neighbour-expand the grid sample so the mode still renders.
   */
  private subSample(
    sample: SampleResult,
    grid: GridSpec,
    subCols: number,
    subRows: number,
    transform: SamplerTransform | undefined,
  ): Uint8ClampedArray {
    if (this.source) {
      const subGrid: GridSpec = {
        cols: subCols,
        rows: subRows,
        cellW: grid.cellW / 2,
        cellH: grid.cellH / 4,
        charAspect: grid.charAspect,
      };
      // getImageData().data is a fresh buffer, so dither() mutating it is safe.
      return this.sampler.sample(this.source, subGrid, transform).data;
    }

    const out = new Uint8ClampedArray(subCols * subRows * 4);
    for (let sy = 0; sy < subRows; sy++) {
      const srcRow = Math.min(sample.rows - 1, sy >> 2);
      for (let sx = 0; sx < subCols; sx++) {
        const srcCol = Math.min(sample.cols - 1, sx >> 1);
        const si = (srcRow * sample.cols + srcCol) * 4;
        const di = (sy * subCols + sx) * 4;
        out[di] = sample.data[si];
        out[di + 1] = sample.data[si + 1];
        out[di + 2] = sample.data[si + 2];
        out[di + 3] = sample.data[si + 3];
      }
    }
    return out;
  }
}

export const brailleMode = new BrailleMode();

/** Registry keys → renderers, for Renderer.registerMode wiring. */
export const brailleModes: Record<string, ModeRenderer> = {
  braille: brailleMode,
};
