/**
 * Tint layer — T8.
 *
 * A single full-canvas fill blended over the rendered grid. All eleven modes
 * are native canvas compositing operations, so there is no manual blend math:
 * we set globalCompositeOperation, fill once, and restore.
 */

/** The eleven blend modes exposed by the Colour section, all native GCO values. */
export type BlendMode =
  | 'multiply'
  | 'overlay'
  | 'screen'
  | 'color'
  | 'hue'
  | 'saturation'
  | 'luminosity'
  | 'soft-light'
  | 'hard-light'
  | 'color-burn'
  | 'color-dodge';

export interface TintOptions {
  /** Tint colour as CSS hex. */
  color: string;
  /** 0..100. 0 disables the layer entirely. */
  opacity: number;
  blend: BlendMode;
}

export const DEFAULT_TINT: TintOptions = {
  color: '#ff0000',
  opacity: 0,
  blend: 'multiply',
};

/**
 * Composites the tint over the whole canvas in place.
 *
 * opacity 0 is a genuine no-op — no fill is issued. The previous composite op,
 * alpha, and fill style are always restored; leaking any of them corrupts every
 * later draw on this context.
 */
export function applyTint(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: TintOptions,
): void {
  if (opts.opacity <= 0) return;

  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  const prevStyle = ctx.fillStyle;

  ctx.globalCompositeOperation = opts.blend;
  ctx.globalAlpha = Math.min(100, opts.opacity) / 100;
  ctx.fillStyle = opts.color;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = prevOp;
  ctx.globalAlpha = prevAlpha;
  ctx.fillStyle = prevStyle;
}
