/**
 * Post-FX chain contract suite — T23.
 *
 * The chain is the seam three later workers build on, so these assertions pin
 * the contract rather than any one effect: the canonical order and stage split,
 * the composite (backdrop + glyph → output), the genuine no-op when everything
 * is off, and the ping-pong pair being allocated once and never per frame. The
 * one implemented effect (vignette) is checked end-to-end on real pixels.
 */

import { describe, it, expect } from 'vitest';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { PostFxChain, type EffectId, type PostFxComposite } from '../chain';

const ID_ORDER: EffectId[] = [
  'character-bloom',
  'character-chromatic',
  'pixelate',
  'halftone',
  'bloom',
  'chromatic',
  'rgb-split',
  'glitch',
  'scanlines',
  'crt-curvature',
  'film-grain',
  'film-dust',
  'vignette',
];

const asDom = (ctx: SKRSContext2D): CanvasRenderingContext2D =>
  ctx as unknown as CanvasRenderingContext2D;

function ctxOf(w: number, h: number): CanvasRenderingContext2D {
  return asDom(createCanvas(w, h).getContext('2d'));
}

function makeChain(): PostFxChain {
  return new PostFxChain({ createContext: (w, h) => ctxOf(w, h) });
}

/** A frame whose glyph layer is a solid white fill over a black backdrop. */
function whiteOnBlack(w: number, h: number): PostFxComposite {
  const glyph = ctxOf(w, h);
  glyph.fillStyle = '#ffffff';
  glyph.fillRect(0, 0, w, h);
  return { glyph, backdrop: '#000000', output: ctxOf(w, h), width: w, height: h };
}

function pixel(ctx: CanvasRenderingContext2D, x: number, y: number): [number, number, number, number] {
  const d = (ctx as unknown as SKRSContext2D).getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

describe('post-fx chain — registry', () => {
  it('exposes all 13 effects in canonical order', () => {
    const chain = makeChain();
    expect(chain.effects.map((e) => e.id)).toEqual(ID_ORDER);
  });

  it('orders are strictly ascending and glyph-stage runs before frame-stage', () => {
    const chain = makeChain();
    const orders = chain.effects.map((e) => e.order);
    for (let i = 1; i < orders.length; i++) expect(orders[i]).toBeGreaterThan(orders[i - 1]);
    const lastGlyph = Math.max(
      ...chain.effects.filter((e) => e.stage === 'glyph').map((e) => e.order),
    );
    const firstFrame = Math.min(
      ...chain.effects.filter((e) => e.stage === 'frame').map((e) => e.order),
    );
    expect(lastGlyph).toBeLessThan(firstFrame);
  });

  it('all default off, amount seeded to default', () => {
    const chain = makeChain();
    for (const e of chain.effects) {
      expect(e.enabled).toBe(false);
      expect(e.amount).toBe(e.default);
    }
    expect(chain.hasWork()).toBe(false);
    expect(chain.needsGlyphLayer()).toBe(false);
  });

  it('character effects are the glyph-stage seam', () => {
    const chain = makeChain();
    const glyphStage = chain.effects.filter((e) => e.stage === 'glyph').map((e) => e.id);
    expect(glyphStage).toEqual(['character-bloom', 'character-chromatic']);
  });
});

describe('post-fx chain — composite', () => {
  it('with everything off, composites glyph over backdrop verbatim', () => {
    const chain = makeChain();
    const frame = whiteOnBlack(16, 16);
    // Punch a transparent hole so the backdrop shows through.
    frame.glyph.clearRect(0, 0, 8, 16);
    chain.render(frame);
    expect(pixel(frame.output, 12, 8)).toEqual([255, 255, 255, 255]); // glyph half
    expect(pixel(frame.output, 2, 8)).toEqual([0, 0, 0, 255]); // backdrop half
  });

  it('needsGlyphLayer flips only for a glyph-stage effect', () => {
    const chain = makeChain();
    chain.get('vignette').enabled = true;
    expect(chain.hasWork()).toBe(true);
    expect(chain.needsGlyphLayer()).toBe(false);
    chain.get('character-bloom').enabled = true;
    expect(chain.needsGlyphLayer()).toBe(true);
  });
});

describe('post-fx chain — vignette', () => {
  it('darkens the corners while leaving the centre lit', () => {
    const chain = makeChain();
    const vig = chain.get('vignette');
    vig.enabled = true;
    vig.amount = 100;
    const frame = whiteOnBlack(64, 64);
    chain.render(frame);
    const centre = pixel(frame.output, 32, 32)[0];
    const corner = pixel(frame.output, 1, 1)[0];
    expect(centre).toBe(255);
    expect(corner).toBeLessThan(centre);
  });

  it('amount 0 is inert even when enabled', () => {
    const chain = makeChain();
    const vig = chain.get('vignette');
    vig.enabled = true;
    vig.amount = 0;
    const frame = whiteOnBlack(32, 32);
    chain.render(frame);
    expect(pixel(frame.output, 1, 1)).toEqual([255, 255, 255, 255]);
  });
});

describe('post-fx chain — ping-pong allocation', () => {
  it('reuses the same scratch pair across resizes (never reallocated)', () => {
    const created: Array<{ w: number; h: number }> = [];
    const chain = new PostFxChain({
      createContext: (w, h) => {
        created.push({ w, h });
        return ctxOf(w, h);
      },
    });
    // Two scratch contexts built at construction, none since.
    expect(created).toHaveLength(2);
    const vig = chain.get('vignette');
    vig.enabled = true;
    chain.render(whiteOnBlack(40, 40));
    chain.render(whiteOnBlack(80, 80));
    expect(created).toHaveLength(2);
  });
});
