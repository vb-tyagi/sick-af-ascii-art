/**
 * Post-FX effects group C — T26. The remaining three frame-stage effects of §3.7.
 *
 * All three run on the composited output (stage 'frame') and, like every other
 * effect, MUST leave globalCompositeOperation / globalAlpha / filter /
 * imageSmoothingEnabled as they found them — a leaked state corrupts every effect
 * ordered after it. save()/restore() carries all four.
 *
 * Two decisions the code can't show:
 *
 * 1. HALFTONE IS NOT THE DITHER ENGINE. dither.ts quantises each grid CELL before
 *    the glyphs are drawn; this is a screen-space dot screen laid over the FINAL
 *    composited frame — a post-process, sampled on a 45° rotated grid, dots sized
 *    by luminance. The two share nothing and must stay distinct.
 *
 * 2. NO FULL-RES getImageData. Halftone needs per-dot luminance, but reading the
 *    frame at full resolution is banned project-wide. It downscales the frame to a
 *    one-pixel-per-dot grid first (drawImage box-filter), then reads that small
 *    buffer — the same downscale-to-grid discipline the sampler uses.
 */

import type { PostEffect } from './chain';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Glitch — random horizontal slice displacement plus occasional channel
 * corruption, re-randomised EVERY frame so it shimmers. `amount` (0–100) scales
 * both the maximum slice shift and how often a band glitches. A full base copy is
 * laid down first so shifted bands never punch holes to transparency.
 */
export const glitch: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  const strength = clamp01(amount / 100);
  if (strength <= 0 || width <= 0 || height <= 0) return;

  const src = scratch();
  src.drawImage(ctx.canvas, 0, 0);
  const chan = scratch();

  const maxShift = width * 0.18 * strength;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.drawImage(src.canvas, 0, 0);

  for (let y = 0; y < height; ) {
    const bandH = 3 + ((Math.random() * 22) | 0);
    const h = Math.min(bandH, height - y);
    if (Math.random() < 0.35 + strength * 0.4) {
      const dx = (Math.random() * 2 - 1) * maxShift;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(src.canvas, 0, y, width, h, dx, y, width, h);

      // Occasional channel corruption: isolate the red channel of the band and
      // re-add it further offset with 'lighter', leaving a coloured fringe.
      if (Math.random() < strength * 0.5) {
        chan.save();
        chan.globalCompositeOperation = 'source-over';
        chan.globalAlpha = 1;
        chan.filter = 'none';
        chan.clearRect(0, 0, width, h);
        chan.drawImage(src.canvas, 0, y, width, h, 0, 0, width, h);
        chan.globalCompositeOperation = 'multiply';
        chan.fillStyle = '#ff0000';
        chan.fillRect(0, 0, width, h);
        chan.globalCompositeOperation = 'destination-in';
        chan.drawImage(src.canvas, 0, y, width, h, 0, 0, width, h);
        chan.restore();

        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.8;
        ctx.drawImage(chan.canvas, 0, 0, width, h, dx * 1.6, y, width, h);
      }
    }
    y += h;
  }

  ctx.restore();
};

/**
 * Pixelate — downscale then upscale with imageSmoothingEnabled=false so the
 * upsample is nearest-neighbour blocks. `amount` (2–30) is the block size; the
 * range starts at 2 because a block of 1 would be a no-op. Downscale keeps
 * smoothing ON so each block is the box-filter average of its source pixels.
 */
export const pixelate: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  const block = Math.max(2, Math.round(amount));
  if (width <= 0 || height <= 0) return;
  const sw = Math.max(1, Math.floor(width / block));
  const sh = Math.max(1, Math.floor(height / block));

  const src = scratch();
  src.save();
  src.imageSmoothingEnabled = true;
  src.globalCompositeOperation = 'source-over';
  src.globalAlpha = 1;
  src.filter = 'none';
  src.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, sw, sh);
  src.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(src.canvas, 0, 0, sw, sh, 0, 0, width, height);
  ctx.restore();
};

/**
 * Halftone — a dot screen over the composited frame. Dots sit on a grid rotated
 * to the classic 45° screen angle, each coloured by its cell and sized by that
 * cell's Rec.709 luminance (brighter → larger) against a black field. `amount`
 * (2–20) is the grid pitch in pixels.
 */
export const halftone: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  const pitch = Math.max(2, Math.round(amount));
  if (width <= 0 || height <= 0) return;

  const gw = Math.max(1, Math.ceil(width / pitch));
  const gh = Math.max(1, Math.ceil(height / pitch));

  // Downscale to one pixel per dot, then read that small buffer — never full res.
  const src = scratch();
  src.save();
  src.imageSmoothingEnabled = true;
  src.globalCompositeOperation = 'source-over';
  src.globalAlpha = 1;
  src.filter = 'none';
  src.drawImage(ctx.canvas, 0, 0, width, height, 0, 0, gw, gh);
  src.restore();
  const data = src.getImageData(0, 0, gw, gh).data;

  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.SQRT1_2; // cos 45°
  const sin = Math.SQRT1_2; // sin 45°
  // Rotated basis, one grid step apart.
  const e1x = cos * pitch;
  const e1y = sin * pitch;
  const e2x = -sin * pitch;
  const e2y = cos * pitch;
  const half = Math.ceil(Math.hypot(width, height) / pitch / 2) + 1;
  const maxR = pitch * 0.72;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  for (let i = -half; i <= half; i++) {
    for (let j = -half; j <= half; j++) {
      const px = cx + i * e1x + j * e2x;
      const py = cy + i * e1y + j * e2y;
      if (px < -pitch || px > width + pitch || py < -pitch || py > height + pitch) continue;

      let gx = Math.floor(px / pitch);
      let gy = Math.floor(py / pitch);
      if (gx < 0) gx = 0;
      else if (gx >= gw) gx = gw - 1;
      if (gy < 0) gy = 0;
      else if (gy >= gh) gy = gh - 1;

      const k = (gy * gw + gx) * 4;
      const r = data[k];
      const g = data[k + 1];
      const b = data[k + 2];
      const l = clamp01((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
      if (l <= 0) continue;

      const radius = maxR * Math.sqrt(l);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
};
