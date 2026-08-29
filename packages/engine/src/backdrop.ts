/**
 * Backdrop layer — T19 (TEARDOWN §3.4).
 *
 * The fill drawn BEFORE mode dispatch; the ASCII glyph layer composites on top.
 * Four modes: a blurred copy of the source (default), solid black, the original
 * unblurred source, or genuinely nothing (transparent).
 *
 * The whole task is the cache. `ctx.filter = blur(Npx)` is GPU-accelerated but
 * still costs real time PER FRAME, so the blurred (or 'original') source is
 * rendered ONCE into an offscreen surface and only re-rendered when the input
 * that shaped it changes: the source frame, the effective blur, or the canvas
 * dimensions. A still image blurs once; a paused video blurs once; only a
 * playing video (whose caller signals each new frame via `markDirty`) pays the
 * blur per frame. Opacity is applied with `globalAlpha` at composite time, so
 * dragging the opacity slider never invalidates the cache.
 *
 * 'none' paints nothing at all — real transparency, not a black fill dressed up
 * as one. PNG export reads this alpha, so the distinction is load-bearing.
 */

import type { SourceMedia } from './sample';

export type BackdropMode = 'blur' | 'solid' | 'original' | 'none';

export interface BackdropOptions {
  mode: BackdropMode;
  /** Gaussian blur radius in CSS px, 0..60. Ignored unless mode is 'blur'. */
  blur: number;
  /** Layer opacity 0..100. Applied at composite time; never invalidates the cache. */
  opacity: number;
}

export const DEFAULT_BACKDROP: BackdropOptions = {
  mode: 'blur',
  blur: 8,
  opacity: 90,
};

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function sourceSize(src: SourceMedia): { w: number; h: number } {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
    return { w: src.videoWidth, h: src.videoHeight };
  }
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
    return { w: src.naturalWidth, h: src.naturalHeight };
  }
  return { w: (src as { width: number }).width, h: (src as { height: number }).height };
}

/**
 * Cover-fit the source over the destination, then inflate by `pad` on every
 * side. The inflation gives the blur real pixels to sample past the canvas edge
 * — without it the filter reads transparent beyond the border and fades the
 * frame's edges into the background.
 */
function coverRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  pad: number,
): { x: number; y: number; w: number; h: number } {
  const tw = dw + pad * 2;
  const th = dh + pad * 2;
  const scale = Math.max(tw / sw, th / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

export interface BackdropConfig {
  /**
   * Factory for the offscreen cache context. Defaults to an OffscreenCanvas /
   * DOM-canvas factory; the headless test harness injects a node-canvas one.
   */
  createContext?: (width: number, height: number) => CanvasRenderingContext2D;
}

function defaultCreateContext(width: number, height: number): CanvasRenderingContext2D {
  let ctx: CanvasRenderingContext2D | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    ctx = canvas.getContext('2d');
  }
  if (!ctx) throw new Error('backdrop: 2D context unavailable for cache surface');
  return ctx;
}

export class Backdrop {
  /**
   * Bumped every time the blurred cache is actually re-rendered. The perf
   * contract is observable through this: a still source paints many times but
   * only advances the generation once.
   */
  cacheGeneration = 0;

  private readonly factory: (w: number, h: number) => CanvasRenderingContext2D;
  private cache: CanvasRenderingContext2D | null = null;

  private frameDirty = true;
  private sigSource: SourceMedia | null = null;
  private sigBlur = -1;
  private sigW = 0;
  private sigH = 0;

  constructor(config: BackdropConfig = {}) {
    this.factory = config.createContext ?? defaultCreateContext;
  }

  /**
   * Signal that the source's pixels have changed (a new video frame). Forces the
   * blurred cache to rebuild on the next `paint`. Never call this for a still
   * source — that is what turns a once-per-image blur into a per-frame one.
   */
  markDirty(): void {
    this.frameDirty = true;
  }

  /**
   * Draw the backdrop into `ctx` filling (0,0)..(width,height). `ctx` is assumed
   * already cleared. `source` may be null (nothing source-derived can be drawn,
   * so 'blur'/'original' become no-ops). All context state touched here is saved
   * and restored — leaking filter/alpha would corrupt the glyph draw that follows.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    source: SourceMedia | null,
    width: number,
    height: number,
    opts: BackdropOptions,
  ): void {
    if (opts.mode === 'none' || width <= 0 || height <= 0) return;

    const alpha = clamp(opts.opacity, 0, 100) / 100;
    if (alpha <= 0) return;

    if (opts.mode === 'solid') {
      const prevAlpha = ctx.globalAlpha;
      const prevStyle = ctx.fillStyle;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = prevAlpha;
      ctx.fillStyle = prevStyle;
      return;
    }

    // 'blur' and 'original' are the same source-drawing path; 'original' is just
    // a zero-radius blur, which lets both share one cache.
    if (!source) return;
    const blur = opts.mode === 'original' ? 0 : clamp(opts.blur, 0, 60);

    const cache = this.ensureCache(source, blur, width, height);

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    ctx.drawImage(cache.canvas, 0, 0);
    ctx.globalAlpha = prevAlpha;
  }

  /** Return the cached surface, re-rendering it iff its shaping inputs changed. */
  private ensureCache(
    source: SourceMedia,
    blur: number,
    width: number,
    height: number,
  ): CanvasRenderingContext2D {
    const sizeChanged = this.sigW !== width || this.sigH !== height;
    if (!this.cache || sizeChanged) {
      this.cache = this.factory(width, height);
    } else {
      this.cache.canvas.width = width;
      this.cache.canvas.height = height;
    }

    const stale =
      this.frameDirty ||
      sizeChanged ||
      this.sigSource !== source ||
      this.sigBlur !== blur;

    if (!stale) return this.cache;

    const cache = this.cache;
    const { w: sw, h: sh } = sourceSize(source);
    cache.clearRect(0, 0, width, height);
    if (sw > 0 && sh > 0) {
      const rect = coverRect(sw, sh, width, height, blur);
      cache.filter = blur > 0 ? `blur(${blur}px)` : 'none';
      cache.drawImage(source, rect.x, rect.y, rect.w, rect.h);
      cache.filter = 'none';
    }

    this.sigSource = source;
    this.sigBlur = blur;
    this.sigW = width;
    this.sigH = height;
    this.frameDirty = false;
    this.cacheGeneration++;
    return cache;
  }
}
