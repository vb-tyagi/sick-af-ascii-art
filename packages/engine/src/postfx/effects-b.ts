/**
 * Post-FX effects group B — T25. Bloom + chromatic family.
 *
 * Five effects across both stages of the seam (see chain.ts): bloom and its
 * glyph-stage twin character-bloom; chromatic and its glyph-stage twin
 * character-chromatic; and rgb-split. The chain owns isolation and compositing,
 * so these just transform whatever `ctx` they are handed — glyph layer for the
 * 'glyph'-stage entries, composited output for the 'frame'-stage ones.
 *
 * Two decisions the code can't show:
 *
 * 1. CHROMATIC ≠ RGB-SPLIT. Both separate the R/G/B channels and re-add them
 *    offset, but the displacement model is the whole distinction: chromatic
 *    scales the channels about the centre so the offset GROWS toward the edges
 *    (lens fringing / radial falloff); rgb-split translates them by a FIXED
 *    amount everywhere (uniform, no falloff). They share the channel-isolation
 *    plumbing but never the displacement — collapsing them would erase the one
 *    thing that tells them apart.
 *
 * 2. CHANNEL ISOLATION WITHOUT getImageData. A channel is pulled with a
 *    'multiply' fill (keeps one axis of colour) followed by a 'destination-in'
 *    re-draw of the source (restores the source's alpha, which the opaque fill
 *    would otherwise have flooded). Summing the three offset channels back with
 *    'lighter' reconstructs the image where they overlap and leaves coloured
 *    fringes where they don't.
 *
 * Every function restores globalCompositeOperation / globalAlpha / filter on any
 * surface it touches — a leaked state corrupts every later effect and frame.
 */

import type { PostEffect, ScratchLease } from './chain';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Threshold-bright → blur → add-back glow. `threshold` gates whether highlights
 * are isolated first (frame stage sees the whole tonal range, so it must; the
 * glyph layer is already glyphs-on-transparent, so a plain blur suffices).
 */
function applyBloom(
  ctx: CanvasRenderingContext2D,
  amount: number,
  scratch: ScratchLease,
  threshold: boolean,
  maxRadius: number,
): void {
  const strength = clamp01(amount / 100);
  if (strength <= 0) return;
  const radius = 1 + strength * maxRadius;

  const src = scratch();
  src.save();
  src.globalCompositeOperation = 'source-over';
  src.globalAlpha = 1;
  src.filter = threshold
    ? `brightness(1.15) contrast(2.4) blur(${radius}px)`
    : `blur(${radius}px)`;
  src.drawImage(ctx.canvas, 0, 0);
  src.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = strength;
  ctx.filter = 'none';
  ctx.drawImage(src.canvas, 0, 0);
  ctx.restore();
}

/** One channel's placement in the reconstructed image. */
interface ChannelRect {
  color: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Pull `color`'s channel out of `srcCanvas` into `chan`, preserving source alpha. */
function isolateChannel(
  chan: CanvasRenderingContext2D,
  srcCanvas: CanvasImageSource,
  color: string,
  width: number,
  height: number,
): void {
  chan.save();
  chan.globalCompositeOperation = 'source-over';
  chan.globalAlpha = 1;
  chan.filter = 'none';
  chan.clearRect(0, 0, width, height);
  chan.drawImage(srcCanvas, 0, 0);
  chan.globalCompositeOperation = 'multiply';
  chan.fillStyle = color;
  chan.fillRect(0, 0, width, height);
  chan.globalCompositeOperation = 'destination-in';
  chan.drawImage(srcCanvas, 0, 0);
  chan.restore();
}

/**
 * Draw one channel at its displaced rect with the source edge CLAMPED.
 *
 * A plain drawImage at an offset leaves the vacated strip empty. Under the
 * caller's 'lighter' accumulation an empty strip contributes nothing, so the
 * frame border ends up missing whichever channels were displaced inward —
 * which is what produced the yellow/olive edge (R+G present, B absent).
 *
 * Clamping fixes it the way GPU samplers do: the outermost row/column is
 * extended to cover the gap. Each edge is one extra stretched 1px slice, so a
 * displaced channel costs at most four thin extra draws.
 */
function drawChannelClamped(
  dst: CanvasRenderingContext2D,
  chanCanvas: CanvasImageSource,
  width: number,
  height: number,
  r: ChannelRect,
): void {
  dst.drawImage(chanCanvas, r.dx, r.dy, r.dw, r.dh);

  // Gaps left uncovered by the displaced rect, per edge.
  const left = Math.ceil(Math.max(0, r.dx));
  const top = Math.ceil(Math.max(0, r.dy));
  const right = Math.ceil(Math.max(0, width - (r.dx + r.dw)));
  const bottom = Math.ceil(Math.max(0, height - (r.dy + r.dh)));

  if (left > 0) {
    dst.drawImage(chanCanvas, 0, 0, 1, height, 0, r.dy, left, r.dh);
  }
  if (right > 0) {
    dst.drawImage(chanCanvas, width - 1, 0, 1, height, r.dx + r.dw, r.dy, right, r.dh);
  }
  if (top > 0) {
    dst.drawImage(chanCanvas, 0, 0, width, 1, r.dx, 0, r.dw, top);
  }
  if (bottom > 0) {
    dst.drawImage(chanCanvas, 0, height - 1, width, 1, r.dx, r.dy + r.dh, r.dw, bottom);
  }

  // Corners: where two edges are both open, the diagonal pixel fills the square
  // they leave between them.
  if (left > 0 && top > 0) dst.drawImage(chanCanvas, 0, 0, 1, 1, 0, 0, left, top);
  if (right > 0 && top > 0) {
    dst.drawImage(chanCanvas, width - 1, 0, 1, 1, r.dx + r.dw, 0, right, top);
  }
  if (left > 0 && bottom > 0) {
    dst.drawImage(chanCanvas, 0, height - 1, 1, 1, 0, r.dy + r.dh, left, bottom);
  }
  if (right > 0 && bottom > 0) {
    dst.drawImage(
      chanCanvas, width - 1, height - 1, 1, 1,
      r.dx + r.dw, r.dy + r.dh, right, bottom,
    );
  }
}

/**
 * Split into R/G/B, re-add each at its own rect with 'lighter'. The rects encode
 * the displacement model — the caller decides radial vs uniform.
 */
function splitChannels(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scratch: ScratchLease,
  rects: readonly [ChannelRect, ChannelRect, ChannelRect],
): void {
  if (width <= 0 || height <= 0) return;

  // Reconstruct on a scratch accumulator, never directly onto `ctx`: the offset
  // 'lighter' draws leave the destination aliasing the scratch surface they were
  // drawn from (a copy-on-write snapshot that the ping-pong pair overwrites next
  // frame), which collapses the frame to a single channel. Assembling on `acc`
  // and blitting once with a full-size 'source-over' is the same pattern bloom /
  // pixelate use, and it materialises an independent result. `ctx` is untouched
  // until that blit, so channels isolate straight from `ctx.canvas`.
  const chan = scratch();
  const acc = scratch();

  // Accumulate onto a TRANSPARENT surface, not an opaque black fill. On the frame
  // stage the source is fully opaque, so 'lighter' alpha saturates to 255 at every
  // pixel and the result is byte-identical to a black base. On the GLYPH stage the
  // source is glyphs-on-transparent: a black fill would flood the layer opaque and
  // erase the backdrop behind it (the whole-frame-goes-black catastrophe). Summing
  // the three channels with 'lighter' instead reconstructs both colour AND the
  // union of the displaced coverages as alpha, so the glyph layer stays a layer.
  acc.save();
  acc.globalCompositeOperation = 'lighter';
  acc.globalAlpha = 1;
  acc.filter = 'none';
  for (const r of rects) {
    isolateChannel(chan, ctx.canvas, r.color, width, height);
    drawChannelClamped(acc, chan.canvas, width, height, r);
  }
  acc.restore();

  // 'copy' replaces `ctx` wholesale, including where `acc` is transparent — the
  // frame stage sees an identical opaque blit, the glyph stage gets the alpha the
  // reconstruction carries instead of compositing the fringe over the old glyph.
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.drawImage(acc.canvas, 0, 0);
  ctx.restore();
}

/**
 * Bloom (frame) — threshold the bright pixels, blur, add the glow back over the
 * composited frame.
 */
export const bloom: PostEffect['apply'] = (ctx, _width, _height, amount, scratch) => {
  applyBloom(ctx, amount, scratch, true, 8);
};

/**
 * Character Bloom (glyph) — the same glow, but on the isolated glyph layer, so it
 * reads only the glyphs and never the backdrop behind them.
 */
export const characterBloom: PostEffect['apply'] = (ctx, _width, _height, amount, scratch) => {
  applyBloom(ctx, amount, scratch, false, 6);
};

/**
 * Chromatic (frame) — RADIAL channel offset. Red expands, blue contracts about
 * the centre, so the fringe is zero at the centre and grows to `amount` px at the
 * edges — lens colour fringing.
 */
export const chromatic: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  const d = amount;
  if (d <= 0) return;
  splitChannels(ctx, width, height, scratch, [
    { color: '#ff0000', dx: -d, dy: -d, dw: width + 2 * d, dh: height + 2 * d },
    { color: '#00ff00', dx: 0, dy: 0, dw: width, dh: height },
    { color: '#0000ff', dx: d, dy: d, dw: Math.max(1, width - 2 * d), dh: Math.max(1, height - 2 * d) },
  ]);
};

/**
 * Character Chromatic (glyph) — the same radial fringing, applied to the glyph
 * layer before it composites, so glyph edges get the colour split.
 */
export const characterChromatic: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  chromatic(ctx, width, height, amount, scratch);
};

/**
 * RGB Split (frame) — UNIFORM channel offset. Red and blue translate a fixed
 * `amount` px in opposite directions everywhere, with NO radial falloff. That
 * absence is what separates it from Chromatic.
 */
export const rgbSplit: PostEffect['apply'] = (ctx, width, height, amount, scratch) => {
  const d = amount;
  if (d <= 0) return;
  splitChannels(ctx, width, height, scratch, [
    { color: '#ff0000', dx: d, dy: 0, dw: width, dh: height },
    { color: '#00ff00', dx: 0, dy: 0, dw: width, dh: height },
    { color: '#0000ff', dx: -d, dy: 0, dw: width, dh: height },
  ]);
};
