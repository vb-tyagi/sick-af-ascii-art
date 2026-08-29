/**
 * Post-FX effects group A — T24. Frame-stage tube/film effects.
 *
 * The vignette effect stays in chain.ts (proof-of-interface, run LAST by design);
 * the other four frame-stage effects of §3.7 live here and are wired into the
 * canonical chain by chain.ts. Each function matches `PostEffect['apply']` and
 * MUST leave globalCompositeOperation / globalAlpha / transform as it found them —
 * a leaked state corrupts every effect ordered after it.
 *
 * Grain is the one perf trap: re-randomising every pixel each frame tanks video
 * fps, but a static tile reads as a fixed texture. The resolution is one noise
 * tile rendered ONCE, then sampled from a fresh random offset each frame — cheap,
 * and the drifting offset animates like real grain.
 */

import type { PostEffect } from './chain';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Side of the pre-rendered noise tile. Larger than any offset we sample from it. */
const NOISE_TILE = 256;

/** Allocate an offscreen 2D context, or null when neither canvas host exists. */
function makeCanvasCtx(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    return c.getContext('2d') as unknown as CanvasRenderingContext2D | null;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c.getContext('2d');
  }
  return null;
}

/** The grain tile, rendered once and reused for the life of the module. */
let noiseTile: CanvasRenderingContext2D | null = null;
let noiseTried = false;

function grainTile(): CanvasRenderingContext2D | null {
  if (noiseTried) return noiseTile;
  noiseTried = true;
  const ctx = makeCanvasCtx(NOISE_TILE, NOISE_TILE);
  if (!ctx) return null;
  const img = ctx.createImageData(NOISE_TILE, NOISE_TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (Math.random() * 256) | 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseTile = ctx;
  return ctx;
}

/**
 * Scan Lines — horizontal dark lines every few pixels; amount drives opacity.
 * A CRT raster: 1px darkening on a fixed period so curvature (ordered after) can
 * bend the lines along with the image.
 */
export const scanlines: PostEffect['apply'] = (ctx, width, height, amount) => {
  const strength = clamp01(amount / 100);
  if (strength <= 0) return;
  const period = 3;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = `rgba(0,0,0,${strength * 0.6})`;
  for (let y = 0; y < height; y += period) {
    ctx.fillRect(0, y, width, 1);
  }
  ctx.restore();
};

/**
 * CRT Curvature — barrel distortion, cheaply. Snapshot the frame, then redraw it
 * as horizontal strips whose x-scale shrinks quadratically toward top and bottom,
 * so the image bulges out of a virtual tube. `amount` scales the maximum inset.
 */
export const crtCurvature: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  const k = clamp01(amount / 100) * 0.18;
  if (k <= 0) return;
  const src = scratch();
  src.drawImage(ctx.canvas, 0, 0);
  const cy = height / 2;
  const stripH = 2;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  for (let y = 0; y < height; y += stripH) {
    const h = Math.min(stripH, height - y);
    const ny = (y + h / 2 - cy) / cy;
    const scale = 1 - k * ny * ny;
    const dw = width * scale;
    const dx = (width - dw) / 2;
    ctx.drawImage(src.canvas, 0, y, width, h, dx, y, dw, h);
  }
  ctx.restore();
};

/**
 * Film Grain — per-pixel luminance noise via one pre-rendered tile sampled from a
 * fresh random offset each frame. 'overlay' keeps mid-grey neutral so only the
 * deviations lift/drop tone; amount drives the blend strength.
 */
export const filmGrain: PostEffect['apply'] = (ctx, width, height, amount) => {
  const strength = clamp01(amount / 100);
  if (strength <= 0) return;
  const tile = grainTile();
  if (!tile) return;
  const pat = ctx.createPattern(tile.canvas, 'repeat');
  if (!pat) return;
  const ox = (Math.random() * NOISE_TILE) | 0;
  const oy = (Math.random() * NOISE_TILE) | 0;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.12 + strength * 0.55;
  ctx.fillStyle = pat;
  ctx.translate(-ox, -oy);
  ctx.fillRect(ox, oy, width, height);
  ctx.restore();
};

/**
 * Film Dust — sparse specks and vertical scratches, redrawn from scratch every
 * frame so they flicker like real print damage. `amount` drives speck density
 * and scratch count.
 */
export const filmDust: PostEffect['apply'] = (ctx, width, height, amount) => {
  const strength = clamp01(amount / 100);
  if (strength <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  const speckCount = Math.round((strength * width * height) / 4000);
  for (let i = 0; i < speckCount; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    ctx.globalAlpha = 0.3 + Math.random() * 0.5;
    ctx.fillStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
    const r = Math.random() < 0.85 ? 0.5 : 1.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const scratchCount = Math.round(strength * 3);
  for (let i = 0; i < scratchCount; i++) {
    if (Math.random() < 0.4) continue;
    const x = Math.random() * width;
    const y0 = Math.random() * height;
    const len = height * (0.2 + Math.random() * 0.6);
    ctx.globalAlpha = 0.15 + Math.random() * 0.25;
    ctx.strokeStyle = Math.random() < 0.5 ? '#ffffff' : '#000000';
    ctx.lineWidth = Math.random() < 0.7 ? 0.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x + (Math.random() - 0.5) * 4, y0 + len);
    ctx.stroke();
  }

  ctx.restore();
};
