/**
 * Post-FX chain — T23. THE CONTRACT.
 *
 * The tail of the pipeline (§4.1): the rendered glyph layer composites over the
 * backdrop, then a chain of screen-space effects runs over the result. W6.T24
 * (frame effects), T25 (character effects) and T26 (remaining effects) all
 * implement `PostEffect` entries against the seam defined here — so this file is
 * an interface first and an implementation second.
 *
 * Three load-bearing decisions the code alone cannot explain:
 *
 * 1. CANONICAL ORDER. Effects run in a FIXED order (`order` field), never in
 *    toggle order. Order is visual, not cosmetic: grain must land AFTER bloom —
 *    bloom AFTER grain would blur the noise into blobs; vignette runs LAST so no
 *    later effect re-lifts the darkened edge. The full ordering is pinned in
 *    CANONICAL below.
 *
 * 2. THE GLYPH SEAM. Character Bloom / Character Chromatic (stage 'glyph') must
 *    transform the glyph layer IN ISOLATION, before it composites over the
 *    backdrop — glow that reads the backdrop is wrong. So the chain, not the
 *    caller, owns the composite step: glyph-stage effects → composite → frame
 *    -stage effects. Everything else (stage 'frame') runs on the composited
 *    output.
 *
 * 3. PING-PONG, ALLOCATED ONCE. Effects that read the previous frame state
 *    (blur, warp, channel offset) borrow a scratch surface via the `scratch`
 *    lease. The two scratch canvases are allocated at construction and only
 *    ever RESIZED (on a dimension change), never reallocated per frame —
 *    per-frame allocation is the single biggest perf trap in this file.
 */

import { scanlines, crtCurvature, filmGrain, filmDust } from './effects-a';
import {
  bloom,
  characterBloom,
  chromatic,
  characterChromatic,
  rgbSplit,
} from './effects-b';
import { glitch, pixelate, halftone } from './effects-c';

/** The 13 effects of TEARDOWN §3.7, as a closed union for downstream type-safety. */
export type EffectId =
  | 'vignette'
  | 'scanlines'
  | 'crt-curvature'
  | 'chromatic'
  | 'bloom'
  | 'character-bloom'
  | 'character-chromatic'
  | 'film-grain'
  | 'glitch'
  | 'rgb-split'
  | 'pixelate'
  | 'halftone'
  | 'film-dust';

/**
 * Where an effect runs relative to the composite:
 * - 'glyph' — on the isolated glyph layer, BEFORE it composites over the backdrop.
 * - 'frame' — on the composited output, AFTER the glyph layer is down.
 */
export type PostFxStage = 'glyph' | 'frame';

/**
 * Borrow a chain-owned scratch context, sized to the current frame and cleared.
 * Two surfaces are available; consecutive calls round-robin between them, which
 * is the ping-pong primitive for a read-previous-state effect: snapshot
 * `ctx.canvas` into a lease, transform it, composite back onto `ctx`. Never
 * retain the returned context past the current `apply` call.
 */
export type ScratchLease = () => CanvasRenderingContext2D;

/**
 * One effect in the chain. `enabled` and `amount` are mutable — the UI layer
 * toggles/drives them directly. Everything else is fixed metadata. An effect
 * MUST be a genuine no-op while disabled: the chain never calls `apply` unless
 * `enabled` is true, and an effect at `amount` 0 (where its range allows) should
 * also do nothing.
 */
export interface PostEffect {
  readonly id: EffectId;
  readonly label: string;
  readonly stage: PostFxStage;
  /** Position in the canonical chain. Lower runs first. See CANONICAL. */
  readonly order: number;
  /** Inclusive [min, max] slider range, from TEARDOWN §3.7. */
  readonly range: readonly [min: number, max: number];
  /** Slider value applied when the effect is first switched on. */
  readonly default: number;
  enabled: boolean;
  amount: number;
  /**
   * Transform `ctx` in place. `width`/`height` are the working pixel dimensions
   * shared by the glyph layer, output, and all scratch surfaces. `amount` is the
   * live slider value (already within `range`). Use `scratch` for any read of
   * previous state. Effects with no cross-pixel read (vignette, scanlines,
   * grain) ignore `scratch` entirely.
   */
  apply(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    amount: number,
    scratch: ScratchLease,
  ): void;
}

/**
 * The three surfaces + geometry the chain needs each frame. All share one
 * untransformed pixel space (no DPR transform on any of them): the caller is
 * responsible for handing over surfaces of matching `width`/`height`.
 */
export interface PostFxComposite {
  /** Glyph/shape layer on a transparent background. Mutated by glyph-stage effects. */
  glyph: CanvasRenderingContext2D;
  /**
   * Backdrop behind the glyph layer: a CSS fill colour, a pre-painted image
   * layer (e.g. the Backdrop module's blurred-source canvas), or null for
   * transparent. The image form was added when the renderer integration
   * arrived — T23 predates T19, and a fill string cannot express a
   * photographic backdrop.
   */
  backdrop: string | CanvasImageSource | null;
  /** Destination for the final composited + post-processed frame. */
  output: CanvasRenderingContext2D;
  width: number;
  height: number;
}

export interface PostFxChainConfig {
  /**
   * Factory for an offscreen 2D context of the given size. Defaults to an
   * OffscreenCanvas/DOM-canvas factory; the headless test harness injects a
   * node-canvas one.
   */
  createContext?: (width: number, height: number) => CanvasRenderingContext2D;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

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
  if (!ctx) throw new Error('postfx: 2D context unavailable for scratch surface');
  return ctx;
}

/**
 * Vignette — the one effect implemented end-to-end, proving the frame-stage
 * path. A radial darkening from centre to corner; `amount` scales the corner
 * opacity. No previous-state read, so `scratch` is untouched.
 */
const vignette: PostEffect = {
  id: 'vignette',
  label: 'Vignette',
  stage: 'frame',
  order: 130,
  range: [0, 100],
  default: 50,
  enabled: false,
  amount: 50,
  apply(ctx, width, height, amount) {
    const strength = clamp01(amount / 100);
    if (strength <= 0) return;
    const cx = width / 2;
    const cy = height / 2;
    const outer = Math.hypot(cx, cy);
    const grad = ctx.createRadialGradient(cx, cy, outer * 0.4, cx, cy, outer);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};

/**
 * Placeholder for an effect W6.T24/T25/T26 will implement. Passes through: the
 * chain skips disabled effects, and every effect defaults off, so an unbuilt
 * entry is inert until its worker lands the real `apply`.
 */
const passThrough: PostEffect['apply'] = () => {};

function stub(
  id: EffectId,
  label: string,
  stage: PostFxStage,
  order: number,
  range: readonly [number, number],
  def: number,
  apply: PostEffect['apply'] = passThrough,
): PostEffect {
  return {
    id,
    label,
    stage,
    order,
    range,
    default: def,
    enabled: false,
    amount: def,
    apply,
  };
}

/**
 * The canonical chain, in run order. Glyph-stage effects carry the lowest orders
 * because they act first in the pipeline (before the composite); frame-stage
 * effects follow. Rationale for the frame ordering: pixelate/halftone reshape
 * the base tone first; bloom then chromatic/rgb-split colour the light bleed;
 * glitch displaces the coloured slices; scanlines + curvature build the CRT
 * tube; grain and dust sit over the tube (grain AFTER bloom, never before);
 * vignette frames the finished image last.
 */
const CANONICAL: readonly PostEffect[] = [
  stub('character-bloom', 'Character Bloom', 'glyph', 10, [0, 100], 60, characterBloom),
  stub('character-chromatic', 'Character Chromatic', 'glyph', 20, [1, 20], 3, characterChromatic),
  stub('pixelate', 'Pixelate', 'frame', 30, [2, 30], 4, pixelate),
  stub('halftone', 'Halftone', 'frame', 40, [2, 20], 4, halftone),
  stub('bloom', 'Bloom', 'frame', 50, [0, 100], 40, bloom),
  stub('chromatic', 'Chromatic', 'frame', 60, [1, 20], 3, chromatic),
  stub('rgb-split', 'RGB Split', 'frame', 70, [1, 20], 2, rgbSplit),
  stub('glitch', 'Glitch', 'frame', 80, [0, 100], 20, glitch),
  stub('scanlines', 'Scan Lines', 'frame', 90, [0, 100], 40, scanlines),
  stub('crt-curvature', 'CRT Curvature', 'frame', 100, [0, 100], 30, crtCurvature),
  stub('film-grain', 'Film Grain', 'frame', 110, [0, 100], 30, filmGrain),
  stub('film-dust', 'Film Dust', 'frame', 120, [0, 100], 20, filmDust),
  vignette,
];

export class PostFxChain {
  /** All effects, in canonical run order. Mutate `.enabled`/`.amount` on entries. */
  readonly effects: readonly PostEffect[];

  private readonly byId: Map<EffectId, PostEffect>;
  private readonly factory: (w: number, h: number) => CanvasRenderingContext2D;
  private readonly pair: readonly [CanvasRenderingContext2D, CanvasRenderingContext2D];

  private scratchW = 0;
  private scratchH = 0;
  private leaseIndex = 0;
  private frameW = 0;
  private frameH = 0;

  private readonly lease: ScratchLease = () => {
    const ctx = this.pair[this.leaseIndex % 2];
    this.leaseIndex++;
    ctx.clearRect(0, 0, this.frameW, this.frameH);
    return ctx;
  };

  constructor(config: PostFxChainConfig = {}) {
    this.factory = config.createContext ?? defaultCreateContext;
    this.effects = CANONICAL.map((e) => ({ ...e }));
    this.byId = new Map(this.effects.map((e) => [e.id, e]));
    // Allocate the ping-pong pair ONCE. Resized on demand, never reallocated.
    this.pair = [this.factory(1, 1), this.factory(1, 1)];
  }

  get(id: EffectId): PostEffect {
    const e = this.byId.get(id);
    if (!e) throw new Error(`postfx: unknown effect '${id}'`);
    return e;
  }

  /** True iff any effect is enabled. When false, integrators skip render() entirely. */
  hasWork(): boolean {
    return this.effects.some((e) => e.enabled);
  }

  /**
   * True iff a glyph-stage effect is enabled. The renderer uses this to decide
   * whether to draw glyphs to a separate layer (needed) or straight to output.
   */
  needsGlyphLayer(): boolean {
    return this.effects.some((e) => e.enabled && e.stage === 'glyph');
  }

  /** Return every effect to its default amount and switch it off. */
  reset(): void {
    for (const e of this.effects) {
      e.enabled = false;
      e.amount = e.default;
    }
  }

  /**
   * Run the chain: glyph-stage effects on the isolated glyph layer, then
   * composite glyph over backdrop into output, then frame-stage effects on the
   * output. With everything off this is a single composite and zero effect
   * copies — the scratch pair is never touched.
   */
  render(frame: PostFxComposite): void {
    const { glyph, backdrop, output, width, height } = frame;
    this.frameW = width;
    this.frameH = height;
    this.leaseIndex = 0;

    let glyphWork = false;
    let frameWork = false;
    for (const e of this.effects) {
      if (!e.enabled) continue;
      if (e.stage === 'glyph') glyphWork = true;
      else frameWork = true;
    }
    if (glyphWork || frameWork) this.ensureScratch(width, height);

    if (glyphWork) {
      for (const e of this.effects) {
        if (e.enabled && e.stage === 'glyph') {
          e.apply(glyph, width, height, e.amount, this.lease);
        }
      }
    }

    output.clearRect(0, 0, width, height);
    if (typeof backdrop === 'string') {
      output.fillStyle = backdrop;
      output.fillRect(0, 0, width, height);
    } else if (backdrop) {
      output.drawImage(backdrop, 0, 0, width, height);
    }
    output.drawImage(glyph.canvas, 0, 0);

    if (frameWork) {
      for (const e of this.effects) {
        if (e.enabled && e.stage === 'frame') {
          e.apply(output, width, height, e.amount, this.lease);
        }
      }
    }
  }

  private ensureScratch(width: number, height: number): void {
    if (this.scratchW === width && this.scratchH === height) return;
    for (const ctx of this.pair) {
      ctx.canvas.width = width;
      ctx.canvas.height = height;
    }
    this.scratchW = width;
    this.scratchH = height;
  }
}
