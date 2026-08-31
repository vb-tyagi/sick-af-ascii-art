/**
 * Canvas host — T2.
 *
 * Owns the output canvas, its DPR-aware sizing, the resize observer, and the
 * dirty-flag frame loop that every mode renders through.
 *
 * The load-bearing decision here is the frame policy: a still image at rest
 * must schedule NO frames at all. We do not run a permanent rAF that ticks and
 * no-ops — the loop is armed only while there is work (a pending markDirty or a
 * playing video) and disarms itself the instant there isn't. That is what keeps
 * a paused editor off the CPU and off the battery.
 */

import { solveGrid, type GridOptions, type GridSpec } from './grid';
import { GridSampler, type SampleResult, type SourceMedia, type SamplerTransform } from './sample';
import type { ColorOptions, RampOptions } from './color';
import { applyTint, DEFAULT_TINT, type TintOptions } from './tint';
import { Backdrop, type BackdropOptions } from './backdrop';
import { AdvancedBlur, type AdvBlurOptions } from './blur';
import { applyLights, type LightsOptions } from './lights';
import { applyMaskClip, type MaskState } from './mask';
import { PostFxChain } from './postfx/chain';

/**
 * Advanced blur is authored in preview-resolution magnitudes (MAX_RADIUS 24px
 * etc.), but it applies to the sampler's grid buffer, which is one pixel per
 * CELL. A quarter of the authored magnitude spans a similar fraction of the
 * image at cell scale: amount 100 ≈ a 6-cell radius, the default 35 ≈ 2 cells.
 */
const GRID_BLUR_AMOUNT_SCALE = 0.25;

/**
 * Options threaded to every mode. Composed from the sibling engine modules so
 * a mode reads one object rather than a spread of loose params. W3 mode workers
 * extend their reads from here; the canvas host never interprets these beyond
 * `mode`, `font`, and `transform`.
 */
export interface RenderOptions {
  /** Registry key selecting the active ModeRenderer. */
  mode: string;
  font: GridOptions;
  color: ColorOptions;
  ramp: RampOptions;
  /** Full-canvas tint. Grades the finished frame, after composite + post-FX. */
  tint?: TintOptions;
  transform?: SamplerTransform;
  /** Fill drawn behind the grid each frame. null leaves the canvas transparent. */
  background?: string | null;
  /** Default glyph/shape colour when a mode does not colour per cell. */
  foreground?: string;
  /** Photographic layer behind the glyphs (blurred source etc., TEARDOWN §3.4). */
  backdrop?: BackdropOptions;
  /** Source-stage blur, applied to the grid buffer before sampling (§3.6). */
  advBlur?: AdvBlurOptions;
  /** Point lights; raise cell luminance BEFORE glyph selection (§3.8). */
  lights?: LightsOptions;
  /** User-drawn region restricting the glyph layer (§3.8). */
  mask?: MaskState;
}

/**
 * The contract every W3 mode is built against.
 *
 * A mode implements exactly one of the two entry points. `renderGrid` owns the
 * whole grid in one call — the right shape for error-diffusion dither and any
 * mode with cross-cell state. `renderCell` is invoked once per cell (col/row
 * appended to the shared four params) for stateless per-cell modes. Set
 * `animated` when the mode must repaint continuously even on a still source.
 */
export interface ModeRenderer {
  animated?: boolean;
  renderGrid?(
    ctx: CanvasRenderingContext2D,
    sample: SampleResult,
    grid: GridSpec,
    opts: RenderOptions,
  ): void;
  renderCell?(
    ctx: CanvasRenderingContext2D,
    sample: SampleResult,
    grid: GridSpec,
    opts: RenderOptions,
    col: number,
    row: number,
  ): void;
}

export interface RendererConfig {
  container: HTMLElement;
  /** Existing output canvas to adopt. One is created and appended otherwise. */
  canvas?: HTMLCanvasElement;
  /** Upper bound on devicePixelRatio backing. Above ~2 the grid costs more than it shows. */
  maxDpr?: number;
  /**
   * The post-FX chain to composite and effect through. Pass the app's shared
   * instance so UI toggles reach the render; one is constructed privately
   * otherwise so a bare Renderer still composites correctly.
   */
  postfx?: PostFxChain;
}

/** rVFC is not in every lib.dom; model just the slice we call. */
interface VideoFrameCallbackHost {
  requestVideoFrameCallback(cb: () => void): number;
  cancelVideoFrameCallback(handle: number): void;
}

function supportsVfc(src: SourceMedia | null): src is HTMLVideoElement & VideoFrameCallbackHost {
  return src instanceof HTMLVideoElement && 'requestVideoFrameCallback' in src;
}

/**
 * (Re)size an offscreen layer to the given backing store, creating it on first
 * use. Returns the same context when the size is unchanged — resizing a canvas
 * clears it, so gratuitous assignment would erase the layer between frames.
 */
function resizeLayer(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  if (ctx && ctx.canvas.width === width && ctx.canvas.height === height) return ctx;
  if (!ctx) {
    const canvas = document.createElement('canvas');
    const created = canvas.getContext('2d');
    if (!created) throw new Error('2D context unavailable for render layer');
    ctx = created;
  }
  ctx.canvas.width = Math.max(1, width);
  ctx.canvas.height = Math.max(1, height);
  return ctx;
}

const DEFAULT_OPTIONS: RenderOptions = {
  mode: 'characters',
  font: { fontSize: 11, fontFamily: '"JetBrains Mono", monospace', lineHeight: 1 },
  color: { brightness: 0, contrast: 0, saturation: 100, grayscale: 0, filter: 'none' },
  ramp: { ramp: '@#S08Xx+=-;:. ', invert: false, density: 30, coverage: 85 },
  tint: DEFAULT_TINT,
  background: null,
  foreground: '#ffffff',
};

export class Renderer {
  readonly canvas: HTMLCanvasElement;

  private readonly container: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sampler = new GridSampler();
  private readonly registry = new Map<string, ModeRenderer>();
  private readonly maxDpr: number;
  private readonly ownsCanvas: boolean;

  private readonly postfx: PostFxChain;
  private readonly backdrop = new Backdrop();
  private readonly advBlur = new AdvancedBlur();
  /** Glyph layer: device-pixel backing, scale(dpr) transform for CSS-unit drawing. */
  private glyphCtx: CanvasRenderingContext2D | null = null;
  /** Backdrop layer: device-pixel backing, identity transform. */
  private backdropCtx: CanvasRenderingContext2D | null = null;

  private opts: RenderOptions = DEFAULT_OPTIONS;
  private source: SourceMedia | null = null;
  private grid: GridSpec | null = null;

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;

  private running = false;
  private dirty = false;
  private frameScheduled = false;
  private rafHandle = 0;
  private vfcHandle = 0;
  private vfcSource: (HTMLVideoElement & VideoFrameCallbackHost) | null = null;

  private readonly resizeObserver: ResizeObserver;
  private readonly onVideoResume = () => this.markDirty();

  constructor(config: RendererConfig) {
    this.container = config.container;
    this.maxDpr = config.maxDpr ?? 2;
    this.postfx = config.postfx ?? new PostFxChain();

    if (config.canvas) {
      this.canvas = config.canvas;
      this.ownsCanvas = false;
    } else {
      this.canvas = document.createElement('canvas');
      this.container.appendChild(this.canvas);
      this.ownsCanvas = true;
    }

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for output canvas');
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  /** Register a mode under its dispatch key. Later registration overrides. */
  registerMode(name: string, mode: ModeRenderer): void {
    this.registry.set(name, mode);
    this.markDirty();
  }

  setSource(source: SourceMedia | null): void {
    if (this.source === source) return;
    this.detachVideoListeners();
    this.source = source;
    this.attachVideoListeners();
    // A new source usually has a different aspect ratio, and the canvas is
    // fitted to it (see resize) — re-fit before the next frame or the incoming
    // image is drawn into the outgoing one's box.
    this.resize();
    this.markDirty();
  }

  setOptions(patch: Partial<RenderOptions>): void {
    const fontChanged =
      patch.font !== undefined && patch.font !== this.opts.font;
    const transformChanged =
      patch.transform !== undefined && patch.transform !== this.opts.transform;
    this.opts = { ...this.opts, ...patch };
    if (fontChanged) this.solve();
    // A crop or rotation changes the effective aspect ratio the canvas is
    // fitted to; resize() re-solves the grid itself.
    if (transformChanged) this.resize();
    this.markDirty();
  }

  /**
   * Render the current frame into a fresh offscreen canvas at `scale`x the
   * on-screen size, through the SAME pipeline the preview uses.
   *
   * The grid is deliberately reused rather than re-solved: the export is the
   * picture the user tuned, at higher resolution — not a finer grid with more,
   * smaller glyphs, which would be a different composition. Scaling therefore
   * enlarges each glyph instead of adding cells, and the result stays crisp
   * because everything is re-rasterised at the target size rather than the
   * bitmap being stretched.
   */
  renderToCanvas(scale = 1): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(this.cssW * scale));
    out.height = Math.max(1, Math.round(this.cssH * scale));

    const octx = out.getContext('2d');
    if (!octx) throw new Error('2D context unavailable for export canvas');
    if (!this.grid) return out;

    // Layers of their own: reusing the live ones would clobber the on-screen
    // frame mid-export.
    const glyph = resizeLayer(null, out.width, out.height);
    const backdrop = resizeLayer(null, out.width, out.height);
    this.paint(octx, glyph, backdrop, this.grid, scale, out.width, out.height);
    return out;
  }

  /** Logical (CSS-pixel) size of the output canvas — the 1x export baseline. */
  get logicalSize(): { width: number; height: number } {
    return { width: this.cssW, height: this.cssH };
  }

  /** Request one repaint on the next frame. Cheap to call repeatedly. */
  markDirty(): void {
    this.dirty = true;
    this.pump();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.markDirty();
  }

  stop(): void {
    this.running = false;
    this.cancelScheduledFrame();
  }

  destroy(): void {
    this.stop();
    this.detachVideoListeners();
    this.resizeObserver.disconnect();
    this.source = null;
    if (this.ownsCanvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }

  // --- sizing -------------------------------------------------------------

  /**
   * Source aspect (width / height), or null when there is no source or its
   * intrinsic size is not known yet (a video before metadata, say). Guarded by
   * `typeof` checks because the engine also runs headless under node-canvas,
   * where the DOM constructors do not exist.
   */
  private sourceAspect(): number | null {
    const s = this.source;
    if (!s) return null;

    let sw = 0;
    let sh = 0;
    if (typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement) {
      sw = s.videoWidth;
      sh = s.videoHeight;
    } else if (typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement) {
      sw = s.naturalWidth || s.width;
      sh = s.naturalHeight || s.height;
    } else {
      sw = (s as { width?: number }).width ?? 0;
      sh = (s as { height?: number }).height ?? 0;
    }

    // A crop replaces the effective frame, and a quarter-turn swaps its axes.
    // Without this a square crop of a portrait would still be fitted to the
    // portrait's ratio and render letterboxed inside its own crop.
    const t = this.opts.transform;
    if (t?.crop && t.crop.w > 0 && t.crop.h > 0) {
      sw = t.crop.w;
      sh = t.crop.h;
    }
    if (t?.rotate === 90 || t?.rotate === 270) {
      const swap = sw;
      sw = sh;
      sh = swap;
    }

    return sw > 0 && sh > 0 ? sw / sh : null;
  }

  private resize(): void {
    const availW = this.container.clientWidth;
    const availH = this.container.clientHeight;
    if (availW === 0 || availH === 0) return;

    // Fit the canvas to the source's aspect ratio inside the available area
    // instead of filling it. Filling stretches every source whose ratio differs
    // from the preview pane — a 2:3 portrait photo in a landscape pane comes
    // out visibly squashed. With no source there is nothing to fit, so the
    // canvas takes the whole area.
    const aspect = this.sourceAspect();
    let w = availW;
    let h = availH;
    if (aspect !== null) {
      if (availW / availH > aspect) w = Math.max(1, Math.round(availH * aspect));
      else h = Math.max(1, Math.round(availW / aspect));
    }
    if (w === 0 || h === 0) return;

    // Clamp: beyond 2x the extra glyphs cost real CPU for no visible gain.
    const dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1);
    const backingW = Math.round(w * dpr);
    const backingH = Math.round(h * dpr);

    if (
      this.cssW === w &&
      this.cssH === h &&
      this.canvas.width === backingW &&
      this.canvas.height === backingH
    ) {
      return;
    }

    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;

    this.canvas.width = backingW;
    this.canvas.height = backingH;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    // Reset then scale so all mode drawing works in CSS pixels, DPR-agnostic.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The glyph and backdrop layers mirror the output's device-pixel backing.
    // Composite happens in untransformed pixel space (the chain's contract),
    // so both layers are plain canvases sized to the backing store.
    this.glyphCtx = resizeLayer(this.glyphCtx, backingW, backingH);
    this.backdropCtx = resizeLayer(this.backdropCtx, backingW, backingH);

    this.solve();
    this.markDirty();
  }

  private solve(): void {
    if (this.cssW === 0 || this.cssH === 0) return;
    this.grid = solveGrid(this.ctx, this.cssW, this.cssH, this.opts.font);
  }

  // --- frame loop ---------------------------------------------------------

  private isVideoPlaying(): boolean {
    const s = this.source;
    return (
      s instanceof HTMLVideoElement &&
      !s.paused &&
      !s.ended &&
      s.readyState >= 2 /* HAVE_CURRENT_DATA */
    );
  }

  private needsFrame(): boolean {
    if (this.dirty || this.isVideoPlaying()) return true;
    const mode = this.registry.get(this.opts.mode);
    return mode?.animated === true;
  }

  /** Arm a single frame iff there is work and one is not already pending. */
  private pump(): void {
    if (!this.running || this.frameScheduled) return;
    if (!this.needsFrame()) return;

    this.frameScheduled = true;
    const src = this.source;
    if (supportsVfc(src)) {
      this.vfcSource = src;
      this.vfcHandle = src.requestVideoFrameCallback(() => {
        this.frameScheduled = false;
        this.vfcSource = null;
        this.onFrame();
      });
    } else {
      this.rafHandle = window.requestAnimationFrame(() => {
        this.frameScheduled = false;
        this.onFrame();
      });
    }
  }

  private onFrame(): void {
    if (!this.running) return;
    this.render();
    this.dirty = false;
    // Re-arm only if the video/animation still demands frames; otherwise idle.
    this.pump();
  }

  private cancelScheduledFrame(): void {
    if (!this.frameScheduled) return;
    if (this.vfcSource) {
      this.vfcSource.cancelVideoFrameCallback(this.vfcHandle);
      this.vfcSource = null;
    } else {
      window.cancelAnimationFrame(this.rafHandle);
    }
    this.frameScheduled = false;
  }

  private render(): void {
    const grid = this.grid;
    const glyph = this.glyphCtx;
    if (!grid || !glyph) return;
    this.paint(this.ctx, glyph, this.backdropCtx, grid, this.dpr, this.canvas.width, this.canvas.height);
  }

  /**
   * The one pipeline. `render()` runs it against the on-screen canvas at the
   * device pixel ratio; `renderToCanvas()` runs it against an offscreen canvas
   * at an export scale. There is deliberately no second implementation: an
   * export path that re-derives these stages drifts out of step with the
   * preview the moment either changes, and then the file no longer matches what
   * the user tuned.
   *
   * `scale` plays exactly the role dpr plays on screen — the grid is unchanged,
   * so the composition is identical and only the resolution rises.
   */
  private paint(
    ctx: CanvasRenderingContext2D,
    glyph: CanvasRenderingContext2D,
    backdropCtx: CanvasRenderingContext2D | null,
    grid: GridSpec,
    dpr: number,
    dw: number,
    dh: number,
  ): void {
    const mode = this.source ? this.registry.get(this.opts.mode) : undefined;

    if (!this.source || !mode) {
      // Nothing to composite — keep the pre-integration behaviour.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, dw, dh);
      if (this.opts.background) {
        ctx.fillStyle = this.opts.background;
        ctx.fillRect(0, 0, dw, dh);
      }
      ctx.restore();
      return;
    }

    // 1. Sample at grid resolution. Advanced blur runs on the grid buffer
    //    before the pixel read — the §3.6 source stage, shaping glyph choice.
    const blur = this.opts.advBlur;
    const preRead =
      blur && blur.type !== 'off' && blur.amount > 0
        ? (bctx: CanvasRenderingContext2D, cols: number, rows: number) =>
            this.advBlur.apply(bctx, cols, rows, {
              type: blur.type,
              amount: blur.amount * GRID_BLUR_AMOUNT_SCALE,
            })
        : undefined;
    const sample = this.sampler.sample(this.source, grid, this.opts.transform, preRead);

    // 2. Lights raise cell RGB — and therefore luminance — BEFORE the mode
    //    maps luminance to a glyph. Light changes WHICH characters appear.
    if (this.opts.lights) {
      applyLights(sample.data, sample.cols, sample.rows, this.opts.lights);
    }

    // 3. Mode renders onto the isolated, transparent glyph layer (CSS units
    //    under scale(dpr)), optionally clipped to the user's mask region.
    glyph.save();
    glyph.setTransform(dpr, 0, 0, dpr, 0, 0);
    glyph.clearRect(0, 0, this.cssW, this.cssH);
    if (this.opts.mask?.enabled) applyMaskClip(glyph, this.opts.mask);
    if (mode.renderGrid) {
      mode.renderGrid(glyph, sample, grid, this.opts);
    } else if (mode.renderCell) {
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          mode.renderCell(glyph, sample, grid, this.opts, col, row);
        }
      }
    }
    glyph.restore();

    // 4. Backdrop: the photographic layer, painted at device resolution. Its
    //    cache makes this free for a still source at rest.
    let backdropSrc: string | CanvasImageSource | null = this.opts.background ?? null;
    const bopts = this.opts.backdrop;
    if (bopts && bopts.mode !== 'none' && backdropCtx) {
      const b = backdropCtx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, dw, dh);
      this.backdrop.paint(b, this.source, dw, dh, bopts);
      backdropSrc = b.canvas;
    }

    // 5. The chain owns isolation and compositing: glyph-stage effects on the
    //    glyph layer, composite over the backdrop, frame-stage effects on the
    //    result. Untransformed pixel space per its contract.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.postfx.render({ glyph, backdrop: backdropSrc, output: ctx, width: dw, height: dh });

    // 6. Tint grades the finished frame.
    if (this.opts.tint) {
      applyTint(ctx, dw, dh, this.opts.tint);
    }
    ctx.restore();
  }

  // --- video wiring -------------------------------------------------------

  private attachVideoListeners(): void {
    const s = this.source;
    if (!(s instanceof HTMLVideoElement)) return;
    s.addEventListener('play', this.onVideoResume);
    s.addEventListener('playing', this.onVideoResume);
    s.addEventListener('seeked', this.onVideoResume);
    s.addEventListener('loadeddata', this.onVideoResume);
  }

  private detachVideoListeners(): void {
    const s = this.source;
    if (!(s instanceof HTMLVideoElement)) return;
    s.removeEventListener('play', this.onVideoResume);
    s.removeEventListener('playing', this.onVideoResume);
    s.removeEventListener('seeked', this.onVideoResume);
    s.removeEventListener('loadeddata', this.onVideoResume);
  }
}
