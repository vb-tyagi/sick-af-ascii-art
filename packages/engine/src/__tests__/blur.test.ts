/**
 * Advanced blur suite — T20 (TEARDOWN §3.6).
 *
 * Pins the eight-option contract, the no-op guarantees (off / amount 0 leave the
 * frame and context state untouched), that a uniform blur softens a hard edge,
 * and that the graded tilt-shift keeps its centre band sharper than its edges —
 * the property that makes it a focal plane and not a flat blur.
 */

import { describe, it, expect } from 'vitest';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import {
  AdvancedBlur,
  DEFAULT_ADV_BLUR,
  ADV_BLUR_TYPES,
  type AdvBlurOptions,
} from '../blur';

const asDom = (ctx: SKRSContext2D): CanvasRenderingContext2D =>
  ctx as unknown as CanvasRenderingContext2D;

function ctxOf(w: number, h: number): CanvasRenderingContext2D {
  return asDom(createCanvas(w, h).getContext('2d'));
}

function makeBlur(): AdvancedBlur {
  return new AdvancedBlur({ createContext: (w, h) => ctxOf(w, h) });
}

/** A frame with a hard vertical edge: left half black, right half white. */
function vEdge(w: number, h: number): CanvasRenderingContext2D {
  const ctx = ctxOf(w, h);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w / 2, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w / 2, 0, w / 2, h);
  return ctx;
}

function lum(ctx: CanvasRenderingContext2D, x: number, y: number): number {
  return (ctx as unknown as SKRSContext2D).getImageData(x, y, 1, 1).data[0];
}

const opts = (over: Partial<AdvBlurOptions>): AdvBlurOptions => ({
  ...DEFAULT_ADV_BLUR,
  ...over,
});

describe('advanced blur — contract', () => {
  it('defaults to off at amount 35', () => {
    expect(DEFAULT_ADV_BLUR).toEqual({ type: 'off', amount: 35 });
  });

  it('exposes the eight §3.6 options, off first', () => {
    expect(ADV_BLUR_TYPES).toEqual([
      'off',
      'gaussian',
      'lens',
      'tilt-shift',
      'directional',
      'radial',
      'perspective',
      'progressive',
    ]);
  });
});

describe('advanced blur — no-ops', () => {
  it("'off' leaves the frame untouched", () => {
    const ab = makeBlur();
    const ctx = vEdge(40, 40);
    const before = lum(ctx, 5, 20);
    ab.apply(ctx, 40, 40, opts({ type: 'off', amount: 100 }));
    expect(lum(ctx, 5, 20)).toBe(before);
    expect(lum(ctx, 30, 20)).toBe(255);
  });

  it('amount 0 leaves the frame untouched', () => {
    const ab = makeBlur();
    const ctx = vEdge(40, 40);
    ab.apply(ctx, 40, 40, opts({ type: 'gaussian', amount: 0 }));
    expect(lum(ctx, 5, 20)).toBe(0);
    expect(lum(ctx, 30, 20)).toBe(255);
  });
});

describe('advanced blur — behaviour', () => {
  it('gaussian softens a hard edge into an intermediate tone', () => {
    const ab = makeBlur();
    const ctx = vEdge(40, 40);
    ab.apply(ctx, 40, 40, opts({ type: 'gaussian', amount: 80 }));
    const edge = lum(ctx, 20, 20);
    expect(edge).toBeGreaterThan(20);
    expect(edge).toBeLessThan(235);
  });

  it('directional motion blur softens the vertical edge', () => {
    const ab = makeBlur();
    const ctx = vEdge(40, 40);
    ab.apply(ctx, 40, 40, opts({ type: 'directional', amount: 90 }));
    const edge = lum(ctx, 20, 20);
    expect(edge).toBeGreaterThan(20);
    expect(edge).toBeLessThan(235);
  });

  it('tilt-shift keeps the centre band sharper than the top edge', () => {
    const ab = makeBlur();
    const ctx = vEdge(60, 60);
    ab.apply(ctx, 60, 60, opts({ type: 'tilt-shift', amount: 90 }));
    // At the vertical edge x=30, a sharper column reads closer to pure black/white
    // (far from mid-grey 128); a blurred one collapses toward it.
    const centre = Math.abs(lum(ctx, 30, 30) - 128);
    const top = Math.abs(lum(ctx, 30, 2) - 128);
    expect(centre).toBeGreaterThan(top);
  });

  it('restores context state (filter, alpha, composite)', () => {
    const ab = makeBlur();
    const ctx = vEdge(40, 40);
    ab.apply(ctx, 40, 40, opts({ type: 'radial', amount: 70 }));
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.filter).toBe('none');
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });
});
