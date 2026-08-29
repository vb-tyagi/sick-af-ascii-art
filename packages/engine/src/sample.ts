/**
 * Grid sampler — T5.
 *
 * The critical performance rule for this whole app: downscale to grid
 * resolution FIRST, then read pixels. A 4K frame is ~8.3M pixels; a 200x120
 * grid is 24k. Reading full-res and averaging in JS is ~350x more work per
 * frame and will not hold framerate on video.
 *
 * drawImage() into a smaller canvas hands that averaging to the GPU/compositor
 * for free, and with imageSmoothing enabled it is a genuine box filter — which
 * is exactly the per-cell mean we want.
 */

import type { GridSpec } from './grid';

export interface SampleResult {
  data: Uint8ClampedArray;
  cols: number;
  rows: number;
}

export type SourceMedia =
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | ImageBitmap;

export interface SamplerTransform {
  /** Source-space crop rect. Defaults to the full frame. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Quarter turns, clockwise. */
  rotate?: 0 | 90 | 180 | 270;
}

function sourceSize(src: SourceMedia): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) {
    return { w: src.videoWidth, h: src.videoHeight };
  }
  if (src instanceof HTMLImageElement) {
    return { w: src.naturalWidth, h: src.naturalHeight };
  }
  return { w: src.width, h: src.height };
}

/**
 * Reusable offscreen sampler. Hold one per renderer — allocating a canvas per
 * frame is a guaranteed GC stall on the video path.
 */
export class GridSampler {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor() {
    const useOffscreen = typeof OffscreenCanvas !== 'undefined';
    this.canvas = useOffscreen
      ? new OffscreenCanvas(1, 1)
      : document.createElement('canvas');

    // willReadFrequently is load-bearing here: without it, browsers keep the
    // canvas GPU-backed and every getImageData forces a readback stall.
    const ctx = (this.canvas as HTMLCanvasElement).getContext('2d', {
      willReadFrequently: true,
    });
    if (!ctx) throw new Error('2D context unavailable for sampler');
    this.ctx = ctx as CanvasRenderingContext2D;
  }

  sample(
    src: SourceMedia,
    grid: GridSpec,
    transform: SamplerTransform = {},
    /**
     * Optional hook run on the grid-resolution buffer after the source is
     * drawn but before pixels are read. This is the "source frame before the
     * ASCII sample" stage (TEARDOWN §3.6) — advanced blur applies here so it
     * shapes which cells land as sharp glyphs. The buffer is one pixel per
     * CELL, so any radius the hook applies is measured in cells.
     */
    preRead?: (ctx: CanvasRenderingContext2D, cols: number, rows: number) => void,
  ): SampleResult {
    const { cols, rows } = grid;
    const { rotate = 0 } = transform;
    const size = sourceSize(src);

    if (size.w === 0 || size.h === 0) {
      // Video not yet decoded a frame; return a neutral buffer rather than throw.
      return { data: new Uint8ClampedArray(cols * rows * 4), cols, rows };
    }

    const crop = transform.crop ?? { x: 0, y: 0, w: size.w, h: size.h };
    const swap = rotate === 90 || rotate === 270;

    if (this.canvas.width !== cols || this.canvas.height !== rows) {
      this.canvas.width = cols;
      this.canvas.height = rows;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, cols, rows);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    if (rotate !== 0) {
      ctx.translate(cols / 2, rows / 2);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(swap ? -rows / 2 : -cols / 2, swap ? -cols / 2 : -rows / 2);
    }

    const destW = swap ? rows : cols;
    const destH = swap ? cols : rows;

    ctx.drawImage(
      src as CanvasImageSource,
      crop.x, crop.y, crop.w, crop.h,
      0, 0, destW, destH,
    );
    ctx.restore();

    if (preRead) preRead(ctx as CanvasRenderingContext2D, cols, rows);

    return { data: ctx.getImageData(0, 0, cols, rows).data, cols, rows };
  }

  /** Cell accessor. Grid buffers are row-major RGBA. */
  static cellAt(
    r: SampleResult,
    col: number,
    row: number,
  ): { r: number; g: number; b: number; a: number } {
    const i = (row * r.cols + col) * 4;
    return { r: r.data[i], g: r.data[i + 1], b: r.data[i + 2], a: r.data[i + 3] };
  }
}
