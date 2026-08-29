/**
 * Mask layer suite — T21.
 *
 * Pins the two contracts the task rides on: an off (or empty) mask is a genuine
 * no-op that clips nothing and touches no state, and an on mask with area clips
 * the glyph draw to the region so pixels outside are left untouched.
 */

import { describe, it, expect } from 'vitest';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import {
  EMPTY_MASK,
  hasRegion,
  applyMaskClip,
  type MaskState,
} from '../mask';

const asDom = (ctx: SKRSContext2D): CanvasRenderingContext2D =>
  ctx as unknown as CanvasRenderingContext2D;

function ctxOf(w: number, h: number): CanvasRenderingContext2D {
  return asDom(createCanvas(w, h).getContext('2d'));
}

function pixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
): [number, number, number, number] {
  const d = (ctx as unknown as SKRSContext2D).getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

/** A square region covering the top-left quadrant of a 40×40 canvas. */
const square = (): MaskState => ({
  enabled: true,
  shapes: [{ points: [
    { x: 2, y: 2 },
    { x: 18, y: 2 },
    { x: 18, y: 18 },
    { x: 2, y: 18 },
  ] }],
});

describe('mask — defaults & region gate', () => {
  it('EMPTY_MASK is off with no shapes', () => {
    expect(EMPTY_MASK).toEqual({ enabled: false, shapes: [] });
  });

  it('has no region when disabled, even with a valid shape', () => {
    expect(hasRegion({ ...square(), enabled: false })).toBe(false);
  });

  it('has no region when shapes enclose no area (< 3 points)', () => {
    expect(hasRegion({ enabled: true, shapes: [{ points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }] })).toBe(false);
  });

  it('has a region when enabled with an enclosing shape', () => {
    expect(hasRegion(square())).toBe(true);
  });
});

describe('mask — clip application', () => {
  it('off mask is a no-op: returns false and clips nothing', () => {
    const ctx = ctxOf(40, 40);
    const applied = applyMaskClip(ctx, { ...square(), enabled: false });
    expect(applied).toBe(false);

    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 40, 40);
    // A pixel far outside the (ignored) square is still painted.
    expect(pixel(ctx, 30, 30)).toEqual([255, 0, 0, 255]);
  });

  it('on mask clips the fill to the region', () => {
    const ctx = ctxOf(40, 40);
    ctx.save();
    const applied = applyMaskClip(ctx, square());
    expect(applied).toBe(true);

    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 40, 40);
    ctx.restore();

    // Inside the square: painted. Outside: untouched (transparent).
    expect(pixel(ctx, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(pixel(ctx, 30, 30)).toEqual([0, 0, 0, 0]);
  });

  it('restore lifts the clip so later draws are unrestricted', () => {
    const ctx = ctxOf(40, 40);
    ctx.save();
    applyMaskClip(ctx, square());
    ctx.restore();

    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 40, 40);
    expect(pixel(ctx, 30, 30)).toEqual([0, 255, 0, 255]);
  });

  it('unions multiple shapes into one clip region', () => {
    const ctx = ctxOf(40, 40);
    const mask: MaskState = {
      enabled: true,
      shapes: [
        { points: [{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 12 }, { x: 2, y: 12 }] },
        { points: [{ x: 26, y: 26 }, { x: 36, y: 26 }, { x: 36, y: 36 }, { x: 26, y: 36 }] },
      ],
    };
    ctx.save();
    applyMaskClip(ctx, mask);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 0, 40, 40);
    ctx.restore();

    expect(pixel(ctx, 6, 6)).toEqual([0, 0, 255, 255]);   // in shape 1
    expect(pixel(ctx, 31, 31)).toEqual([0, 0, 255, 255]); // in shape 2
    expect(pixel(ctx, 20, 20)).toEqual([0, 0, 0, 0]);     // between them
  });
});
