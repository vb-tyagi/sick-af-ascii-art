/**
 * Backdrop layer suite — T19.
 *
 * Pins the four modes and the perf contract the task is really about: the blur
 * is cached and only re-rendered when the source frame, blur, or dimensions
 * change (observed via `cacheGeneration`), while opacity changes never do. Also
 * asserts 'none' leaves genuine transparency — the property PNG export rides on.
 */

import { describe, it, expect } from 'vitest';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { Backdrop, DEFAULT_BACKDROP, type BackdropOptions } from '../backdrop';

const asDom = (ctx: SKRSContext2D): CanvasRenderingContext2D =>
  ctx as unknown as CanvasRenderingContext2D;

function ctxOf(w: number, h: number): CanvasRenderingContext2D {
  return asDom(createCanvas(w, h).getContext('2d'));
}

function makeBackdrop(): Backdrop {
  return new Backdrop({ createContext: (w, h) => ctxOf(w, h) });
}

/** A solid-colour source usable in place of an image/video element. */
function source(w: number, h: number, color: string): CanvasRenderingContext2D['canvas'] {
  const c = ctxOf(w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, h);
  return c.canvas as unknown as CanvasRenderingContext2D['canvas'];
}

function pixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
): [number, number, number, number] {
  const d = (ctx as unknown as SKRSContext2D).getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

const opts = (over: Partial<BackdropOptions>): BackdropOptions => ({
  ...DEFAULT_BACKDROP,
  ...over,
});

describe('backdrop — defaults', () => {
  it('defaults to blurred at 8px / 90% opacity', () => {
    expect(DEFAULT_BACKDROP).toEqual({ mode: 'blur', blur: 8, opacity: 90 });
  });
});

describe('backdrop — modes', () => {
  it("'none' paints nothing — output stays transparent", () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    bd.paint(out, source(20, 20, '#ffffff') as never, 20, 20, opts({ mode: 'none' }));
    expect(pixel(out, 10, 10)).toEqual([0, 0, 0, 0]);
    expect(bd.cacheGeneration).toBe(0);
  });

  it("'solid' fills black at the layer opacity, no source needed", () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    bd.paint(out, null, 20, 20, opts({ mode: 'solid', opacity: 100 }));
    expect(pixel(out, 10, 10)).toEqual([0, 0, 0, 255]);
  });

  it("'solid' at 50% opacity is half-alpha black", () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    bd.paint(out, null, 20, 20, opts({ mode: 'solid', opacity: 50 }));
    const [r, g, b, a] = pixel(out, 10, 10);
    expect([r, g, b]).toEqual([0, 0, 0]);
    expect(a).toBeGreaterThan(120);
    expect(a).toBeLessThan(135);
  });

  it("'original' draws the source full-bleed and opaque at 100%", () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    bd.paint(out, source(20, 20, '#ff0000') as never, 20, 20, opts({ mode: 'original', opacity: 100 }));
    expect(pixel(out, 10, 10)).toEqual([255, 0, 0, 255]);
  });

  it("'blur'/'original' are a no-op when the source is null", () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    bd.paint(out, null, 20, 20, opts({ mode: 'blur' }));
    expect(pixel(out, 10, 10)).toEqual([0, 0, 0, 0]);
    expect(bd.cacheGeneration).toBe(0);
  });
});

describe('backdrop — cache contract', () => {
  it('a still source blurs once across many paints', () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    const src = source(20, 20, '#00ff00') as never;
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    expect(bd.cacheGeneration).toBe(1);
  });

  it('opacity changes never invalidate the cache', () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    const src = source(20, 20, '#00ff00') as never;
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6, opacity: 90 }));
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6, opacity: 20 }));
    expect(bd.cacheGeneration).toBe(1);
  });

  it('a blur change rebuilds the cache', () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    const src = source(20, 20, '#00ff00') as never;
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 12 }));
    expect(bd.cacheGeneration).toBe(2);
  });

  it('a new source rebuilds the cache', () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    bd.paint(out, source(20, 20, '#00ff00') as never, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.paint(out, source(20, 20, '#0000ff') as never, 20, 20, opts({ mode: 'blur', blur: 6 }));
    expect(bd.cacheGeneration).toBe(2);
  });

  it('markDirty forces exactly one rebuild — the video-frame path', () => {
    const bd = makeBackdrop();
    const out = ctxOf(20, 20);
    const src = source(20, 20, '#00ff00') as never;
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.markDirty();
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.paint(out, src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    expect(bd.cacheGeneration).toBe(2);
  });

  it('a dimension change rebuilds the cache', () => {
    const bd = makeBackdrop();
    const src = source(20, 20, '#00ff00') as never;
    bd.paint(ctxOf(20, 20), src, 20, 20, opts({ mode: 'blur', blur: 6 }));
    bd.paint(ctxOf(40, 30), src, 40, 30, opts({ mode: 'blur', blur: 6 }));
    expect(bd.cacheGeneration).toBe(2);
  });
});
