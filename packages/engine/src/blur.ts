/**
 * Advanced blur — T20 (TEARDOWN §3.6).
 *
 * The §3.6 "Blur" stage: eight options — off (default) plus seven blur styles —
 * applied to the frame in place. It sits between Colour (§3.5) and Post-Processing
 * (§3.7) in the pipeline, so it runs on the source frame BEFORE the ASCII sample,
 * shaping which regions land as sharp glyphs and which dissolve into flat tone.
 * `amount` is one 0..100 slider (default 35); every style maps it to its own
 * magnitude (radius, motion span, or zoom expansion).
 *
 * Two families, two techniques:
 *
 * 1. UNIFORM / GRADED (gaussian, lens, tilt-shift, perspective, progressive) use
 *    the GPU `ctx.filter = blur(Npx)` pass. Graded variants blend a sharp
 *    snapshot back over the blurred base through a gradient alpha mask — Canvas 2D
 *    has no per-pixel-radius blur, so a two-level sharp↔blurred crossfade is the
 *    honest approximation of a focal plane. tilt-shift keeps a centred band sharp;
 *    perspective keeps the near edge (bottom) sharp with a quadratic depth
 *    falloff; progressive is a straight linear ramp.
 *
 * 2. ACCUMULATED (directional, radial) average many offset/scaled copies of a
 *    snapshot. Copy i is drawn at alpha 1/(i+1): source-over compositing then
 *    weights every copy equally, i.e. a running mean — the standard cheap motion/
 *    zoom blur. directional slides copies along the horizontal axis; radial scales
 *    them about the centre (a zoom blur radiating from the middle).
 *
 * The two scratch surfaces are allocated ONCE and only resized, never reallocated
 * per frame — the same per-frame-allocation trap the backdrop and post-FX chain
 * avoid. `off` and `amount <= 0` are genuine no-ops: `ctx` is not touched, so a
 * disabled stage costs nothing and leaks no context state.
 */

export type AdvBlurType =
  | 'off'
  | 'gaussian'
  | 'lens'
  | 'tilt-shift'
  | 'directional'
  | 'radial'
  | 'perspective'
  | 'progressive';

export interface AdvBlurOptions {
  type: AdvBlurType;
  /** Strength 0..100. Zero (or 'off') is a no-op. */
  amount: number;
}

export const DEFAULT_ADV_BLUR: AdvBlurOptions = {
  type: 'off',
  amount: 35,
};

/** The eight options of §3.6, in UI order, for the control layer to enumerate. */
export const ADV_BLUR_TYPES: readonly AdvBlurType[] = [
  'off',
  'gaussian',
  'lens',
  'tilt-shift',
  'directional',
  'radial',
  'perspective',
  'progressive',
];

/** Blur radius in CSS px at amount 100. Graded/uniform styles scale from this. */
const MAX_RADIUS = 24;
/** Total motion span in px at amount 100 for directional blur. */
const MAX_SHIFT = 40;
/** Fractional zoom expansion at amount 100 for radial blur. */
const MAX_ZOOM = 0.4;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Copies averaged in an accumulated (directional/radial) pass. */
function sampleCount(amount: number): number {
  return Math.round(2 + (clamp(amount, 0, 100) / 100) * 10);
}

export interface AdvancedBlurConfig {
  /**
   * Factory for the offscreen scratch context. Defaults to an OffscreenCanvas /
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
  if (!ctx) throw new Error('blur: 2D context unavailable for scratch surface');
  return ctx;
}

export class AdvancedBlur {
  private readonly factory: (w: number, h: number) => CanvasRenderingContext2D;
  private readonly pair: readonly [CanvasRenderingContext2D, CanvasRenderingContext2D];
  private scratchW = 0;
  private scratchH = 0;

  constructor(config: AdvancedBlurConfig = {}) {
    this.factory = config.createContext ?? defaultCreateContext;
    // Allocate the scratch pair ONCE; resized on demand, never reallocated.
    this.pair = [this.factory(1, 1), this.factory(1, 1)];
  }

  /**
   * Blur `ctx` in place across (0,0)..(width,height) per `opts`. All context
   * state touched (filter, globalAlpha, globalCompositeOperation) is saved and
   * restored, so the caller's subsequent draws see a clean context. A no-op when
   * the type is 'off', the amount is non-positive, or the frame is empty.
   */
  apply(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    opts: AdvBlurOptions,
  ): void {
    if (opts.type === 'off' || width <= 0 || height <= 0) return;
    const amount = clamp(opts.amount, 0, 100);
    if (amount <= 0) return;

    this.ensureScratch(width, height);
    const radius = (amount / 100) * MAX_RADIUS;

    switch (opts.type) {
      case 'gaussian':
        this.uniform(ctx, width, height, radius);
        break;
      case 'lens':
        this.lens(ctx, width, height, radius);
        break;
      case 'tilt-shift':
        this.graded(ctx, width, height, radius, tiltShiftMask);
        break;
      case 'perspective':
        this.graded(ctx, width, height, radius, perspectiveMask);
        break;
      case 'progressive':
        this.graded(ctx, width, height, radius, progressiveMask);
        break;
      case 'directional':
        this.directional(ctx, width, height, amount);
        break;
      case 'radial':
        this.radial(ctx, width, height, amount);
        break;
    }
  }

  private ensureScratch(width: number, height: number): void {
    if (this.scratchW === width && this.scratchH === height) return;
    for (const s of this.pair) {
      s.canvas.width = width;
      s.canvas.height = height;
    }
    this.scratchW = width;
    this.scratchH = height;
  }

  /** Scratch A, resized to the frame and cleared — the blurred base surface. */
  private surfA(w: number, h: number): CanvasRenderingContext2D {
    const s = this.pair[0];
    s.clearRect(0, 0, w, h);
    return s;
  }

  /** Scratch B, resized to the frame and cleared — the sharp snapshot surface. */
  private surfB(w: number, h: number): CanvasRenderingContext2D {
    const s = this.pair[1];
    s.clearRect(0, 0, w, h);
    return s;
  }

  /** Whole-frame gaussian blur. */
  private uniform(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    const a = this.surfA(w, h);
    a.save();
    a.filter = `blur(${radius}px)`;
    a.drawImage(ctx.canvas, 0, 0);
    a.restore();
    ctx.save();
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(a.canvas, 0, 0);
    ctx.restore();
  }

  /**
   * Lens blur — a gaussian base plus a wider, brighter overlay blended with
   * 'lighten' so highlights bleed outward like out-of-focus bokeh. Canvas 2D has
   * no disc kernel; this fakes the highlight blooming a real aperture produces.
   */
  private lens(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    this.uniform(ctx, w, h, radius);
    const a = this.surfA(w, h);
    a.save();
    a.filter = `blur(${radius * 1.7}px)`;
    a.drawImage(ctx.canvas, 0, 0);
    a.restore();
    ctx.save();
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'lighten';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(a.canvas, 0, 0);
    ctx.restore();
  }

  /**
   * Graded blur: blurred everywhere, then a sharp snapshot painted back through a
   * vertical gradient alpha mask (`mask` fills alpha 1 where sharpness is kept).
   * The crossfade between one sharp and one blurred level reads as a focal plane.
   */
  private graded(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
    mask: (g: CanvasGradient) => void,
  ): void {
    const sharp = this.surfB(w, h);
    sharp.drawImage(ctx.canvas, 0, 0);

    const blurred = this.surfA(w, h);
    blurred.save();
    blurred.filter = `blur(${radius}px)`;
    blurred.drawImage(ctx.canvas, 0, 0);
    blurred.restore();

    // Punch the sharp snapshot down to the in-focus region only.
    const grad = sharp.createLinearGradient(0, 0, 0, h);
    mask(grad);
    sharp.save();
    sharp.globalCompositeOperation = 'destination-in';
    sharp.fillStyle = grad;
    sharp.fillRect(0, 0, w, h);
    sharp.restore();

    ctx.save();
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(blurred.canvas, 0, 0);
    ctx.drawImage(sharp.canvas, 0, 0);
    ctx.restore();
  }

  /** Horizontal motion blur: the mean of copies slid along x, centred on 0. */
  private directional(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    amount: number,
  ): void {
    const snap = this.surfB(w, h);
    snap.drawImage(ctx.canvas, 0, 0);
    const n = sampleCount(amount);
    const span = (amount / 100) * MAX_SHIFT;

    ctx.save();
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const dx = (t - 0.5) * span;
      ctx.globalAlpha = 1 / (i + 1);
      ctx.drawImage(snap.canvas, dx, 0);
    }
    ctx.restore();
  }

  /** Zoom blur: the mean of copies scaled about the centre from 1 outward. */
  private radial(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    amount: number,
  ): void {
    const snap = this.surfB(w, h);
    snap.drawImage(ctx.canvas, 0, 0);
    const n = sampleCount(amount);
    const maxScale = 1 + (amount / 100) * MAX_ZOOM;

    ctx.save();
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      const s = 1 + (maxScale - 1) * t;
      const dw = w * s;
      const dh = h * s;
      ctx.globalAlpha = 1 / (i + 1);
      ctx.drawImage(snap.canvas, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    ctx.restore();
  }
}

/** Feather half-width, in normalized frame height, for the graded masks. */
const FEATHER = 0.18;

/** Sharp central band, blur toward top and bottom — the miniature-faking look. */
function tiltShiftMask(g: CanvasGradient): void {
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.5 - FEATHER, 'rgba(0,0,0,0)');
  g.addColorStop(0.5, 'rgba(0,0,0,1)');
  g.addColorStop(0.5 + FEATHER, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
}

/** Sharp near edge (bottom), blur rising toward the top with a quadratic falloff. */
function perspectiveMask(g: CanvasGradient): void {
  // Sampled quadratically so the far field softens faster than the near field.
  for (let i = 0; i <= 4; i++) {
    const t = i / 4; // 0 = top (far), 1 = bottom (near)
    const alpha = t * t; // sharpness kept ∝ nearness²
    g.addColorStop(t, `rgba(0,0,0,${alpha})`);
  }
}

/** Straight linear ramp: sharp at the top, blur increasing to the bottom. */
function progressiveMask(g: CanvasGradient): void {
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
}
