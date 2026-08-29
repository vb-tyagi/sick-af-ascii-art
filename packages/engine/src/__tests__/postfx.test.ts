/**
 * Post-FX visual-power suite — W6.V6, Deliverable 2.
 *
 * W3's four render-mode assertions (not-blank, monotonic, in-bounds,
 * deterministic) all passed while a real defect shipped: a wrong render
 * satisfies every one of them. Their power is near zero. This suite is built so
 * every assertion can FAIL on a plausible-looking bug — a silently no-op effect,
 * an `amount` that is wired but ignored, a leaked composite op, a faked glyph
 * isolation. A green run here MEANS something; a red run is the point.
 *
 * The chain runs on @napi-rs/canvas offscreen surfaces injected through its
 * `createContext` hook (see scripts/harness). The polyfill that lets the effect
 * modules load under Node is installed by scripts/vitest-setup.ts.
 *
 * Random-per-frame effects (film-grain, film-dust, glitch) re-randomise each
 * render, so the byte-equality checks (no-op, order, state-leak) are phrased so
 * the compared frames have that effect OFF, and the magnitude checks (fires,
 * monotonic) use aggregate deltas that dominate the per-frame noise.
 */

import { describe, it, expect } from 'vitest';
import {
  makePostFxChain,
  baseGlyphLayer,
  baseGlyphLayerPartial,
  neutralRampLayer,
  compositeBase,
  renderPostFx,
  readCanvas,
  POSTFX_BACKDROP,
  type EffectSetting,
} from '../../../../scripts/harness';
import type { EffectId } from '../postfx/chain';

const W = 240;
const H = 160;

/** All 13 effects with their default and max (range upper-bound) amounts. */
const ALL: readonly EffectId[] = [
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

/**
 * Effects that re-randomise every frame (film-grain offset, film-dust specks,
 * glitch slices). Single-frame deltas swing wildly, so magnitude checks average
 * over K renders and byte-equality checks are only made against frames where the
 * random effect is OFF.
 */
const RANDOM: ReadonlySet<EffectId> = new Set(['film-grain', 'film-dust', 'glitch']);

/** Count of differing bytes between two equal-length RGBA buffers. */
function mismatch(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** Sum of absolute per-byte differences — a magnitude of change, not just a count. */
function sad(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s;
}

/** Per-channel means (R, G, B) over an RGBA buffer — ignores alpha. */
function channelMeans(a: Uint8ClampedArray): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const px = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    r += a[i];
    g += a[i + 1];
    b += a[i + 2];
  }
  return { r: r / px, g: g / px, b: b / px };
}

/** The chain metadata for one effect (default amount, [min,max] range). */
function meta(id: EffectId): { def: number; min: number; max: number } {
  const e = makePostFxChain().get(id);
  return { def: e.default, min: e.range[0], max: e.range[1] };
}

/** Mean SAD of `settings` against `off` over K renders — smooths per-frame noise. */
function meanSad(
  off: Uint8ClampedArray,
  settings: readonly EffectSetting[],
  k: number,
): number {
  const glyph = baseGlyphLayer(W, H);
  const chain = makePostFxChain();
  let s = 0;
  for (let i = 0; i < k; i++) s += sad(off, readCanvas(renderPostFx(chain, glyph, settings, W, H)));
  return s / k;
}

/* ================================================================== */
/* 1. NO-OP PROOF                                                       */
/*    All effects off must be BYTE-IDENTICAL to the hand-composited     */
/*    base frame — no needless copies, no state the chain forgot to     */
/*    clear. `similar` would let a broken 1-byte drift through; this    */
/*    does not.                                                         */
/* ================================================================== */

describe('no-op proof: chain with nothing enabled == clean composite', () => {
  it('all effects OFF is byte-identical to the base frame', () => {
    const glyph = baseGlyphLayer(W, H);
    const chain = makePostFxChain();
    const got = readCanvas(renderPostFx(chain, glyph, [], W, H));
    const base = readCanvas(compositeBase(glyph, W, H));
    expect(mismatch(got, base)).toBe(0);
  });
});

/* ================================================================== */
/* 2. EFFECT ACTUALLY FIRES                                             */
/*    ON at default must differ from OFF by a MEANINGFUL pixel delta.   */
/*    A silently no-op effect is the likeliest failure and passes tsc.  */
/* ================================================================== */

describe('every effect actually fires at its default amount', () => {
  // 1000 differing bytes = ~250 pixels; far above antialias jitter, far below
  // "a whole frame changed". A truly inert effect scores 0 and fails here.
  const MIN_CHANGED = 1000;

  // film-dust is legitimately sparse and highly variable at default (probe:
  // 15–582 changed bytes across runs — ~2 specks on this frame), so it cannot
  // meet the dense-effect bar. See the dedicated check below. FINDING (reported
  // separately): film-dust's default amount is barely perceptible.
  for (const id of ALL) {
    if (id === 'film-dust') continue;
    it(`${id}: ON@default differs from OFF`, () => {
      const glyph = baseGlyphLayer(W, H);
      const chain = makePostFxChain();
      const off = readCanvas(renderPostFx(chain, glyph, [], W, H));
      const on = readCanvas(renderPostFx(chain, glyph, [{ id }], W, H));
      expect(mismatch(off, on)).toBeGreaterThan(MIN_CHANGED);
    });
  }

  it('film-dust: fires (mean over runs is well above zero, i.e. not a no-op)', () => {
    // Averaged so the random speck count can't fluke the check to zero; the bar
    // still fails hard on a true no-op (which scores exactly 0 every run).
    const glyph = baseGlyphLayer(W, H);
    const chain = makePostFxChain();
    const off = readCanvas(renderPostFx(chain, glyph, [], W, H));
    let total = 0;
    const K = 6;
    for (let i = 0; i < K; i++) {
      total += mismatch(off, readCanvas(renderPostFx(chain, glyph, [{ id: 'film-dust' }], W, H)));
    }
    expect(total / K).toBeGreaterThan(20);
  });
});

/* ================================================================== */
/* 3. AMOUNT IS MONOTONIC                                               */
/*    Max must diverge from OFF strictly MORE than default does.        */
/*    Catches an `amount` that is wired into the signature but ignored  */
/*    in the body — the effect would fire (passes #2) yet respond       */
/*    identically at every slider value.                               */
/* ================================================================== */

describe('amount drives the effect (max diverges more than default)', () => {
  for (const id of ALL) {
    const { def, max } = meta(id);
    // Only meaningful when max is actually a larger setting than default.
    if (max <= def) continue;

    // FINDING: halftone's `amount` is the screen PITCH, not an intensity. A
    // coarser pitch does NOT diverge from the source monotonically (probe:
    // SAD@max 3.96M < SAD@default 4.08M), so the diverge-from-off model is the
    // wrong power test for it. Its amount IS wired (default vs max differ by
    // ~98k bytes) — verified in its own test below — so this is not a no-op; it
    // is a semantics mismatch the CEO's monotonic assertion cannot express.
    if (id === 'halftone') continue;

    // FINDING: rgb-split's `amount` is a DISPLACEMENT, not an intensity. SAD
    // versus OFF saturates once the offset exceeds the stroke width of the
    // content (~2px on this fixture): the strokes are then fully displaced and
    // moving the copies farther apart adds nothing (probe: SAD@max 12.09 <
    // SAD@default 13.91). The diverge-from-off model is the wrong power test
    // for displacement effects — the CEO borrowed it from the intensity
    // family. Replaced by the strictly stronger channel-translation equality
    // test below, which asserts the actual transform per pixel.
    if (id === 'rgb-split') continue;

    // Random effects need averaging or a lucky/unlucky frame pairing flips the
    // inequality; deterministic effects are unaffected by K.
    const k = RANDOM.has(id) ? 5 : 1;

    it(`${id}: meanSAD(off,max) > meanSAD(off,default)`, () => {
      const glyph = baseGlyphLayer(W, H);
      const chain = makePostFxChain();
      const off = readCanvas(renderPostFx(chain, glyph, [], W, H));
      expect(meanSad(off, [{ id, amount: max }], k)).toBeGreaterThan(
        meanSad(off, [{ id, amount: def }], k),
      );
    });
  }

  it('rgb-split: channels translate by exactly ±amount (stronger than monotonic SAD)', () => {
    const glyph = baseGlyphLayer(W, H);
    const chain = makePostFxChain();
    const d = meta('rgb-split').max; // 20 — the end the old metric misread
    const off = readCanvas(renderPostFx(chain, glyph, [], W, H));
    const on = readCanvas(
      renderPostFx(chain, glyph, [{ id: 'rgb-split', amount: d }], W, H),
    );

    // The defining property of a uniform channel split: R is the input's R
    // translated +d px, B is the input's B translated -d px, G is untouched.
    // Interior pixels only — the d-wide border is the edge clamp's modelled
    // approximation, asserted visually, not here. This equality would have
    // caught the original neon-green bug (R/B were destroyed outright) and
    // catches a dead `amount` (d=0 would make all three checks trivial, and
    // d is asserted > 0 first).
    expect(d).toBeGreaterThan(0);
    let worst = 0;
    for (let y = 0; y < H; y++) {
      for (let x = d; x < W - d; x++) {
        const i = (y * W + x) * 4;
        const errR = Math.abs(on[i] - off[(y * W + (x - d)) * 4]);
        const errG = Math.abs(on[i + 1] - off[i + 1]);
        const errB = Math.abs(on[i + 2] - off[(y * W + (x + d)) * 4 + 2]);
        worst = Math.max(worst, errR, errG, errB);
      }
    }
    // Each output channel takes exactly one draw through the multiply +
    // 'lighter' reconstruction, so rounding can cost at most ~1 per stage.
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('halftone: amount is WIRED (default and max renders differ substantially)', () => {
    const glyph = baseGlyphLayer(W, H);
    const chain = makePostFxChain();
    const { def, max } = meta('halftone');
    const atDef = readCanvas(renderPostFx(chain, glyph, [{ id: 'halftone', amount: def }], W, H));
    const atMax = readCanvas(renderPostFx(chain, glyph, [{ id: 'halftone', amount: max }], W, H));
    // Not a no-op-across-slider bug — the pitch genuinely reshapes the screen.
    expect(mismatch(atDef, atMax)).toBeGreaterThan(1000);
  });
});

/* ================================================================== */
/* 4. ORDER IS FIXED                                                    */
/*    Enabling A then B must equal enabling B then A: the canonical     */
/*    run order must not depend on toggle order. Two deterministic      */
/*    frame-stage effects that visibly interact (bloom lifts light,     */
/*    scanlines darken over it).                                        */
/* ================================================================== */

describe('canonical order is independent of toggle order', () => {
  it('enable bloom→scanlines == enable scanlines→bloom (byte-identical)', () => {
    const glyph = baseGlyphLayer(W, H);
    const chain = makePostFxChain();
    const ab = readCanvas(
      renderPostFx(chain, glyph, [{ id: 'bloom' }, { id: 'scanlines' }], W, H),
    );
    const ba = readCanvas(
      renderPostFx(chain, glyph, [{ id: 'scanlines' }, { id: 'bloom' }], W, H),
    );
    expect(mismatch(ab, ba)).toBe(0);
  });

  it('a glyph-stage + a frame-stage effect also commute in toggle order', () => {
    const glyph = baseGlyphLayer(W, H);
    const chain = makePostFxChain();
    const ab = readCanvas(
      renderPostFx(chain, glyph, [{ id: 'character-bloom' }, { id: 'vignette' }], W, H),
    );
    const ba = readCanvas(
      renderPostFx(chain, glyph, [{ id: 'vignette' }, { id: 'character-bloom' }], W, H),
    );
    expect(mismatch(ab, ba)).toBe(0);
  });
});

/* ================================================================== */
/* 5. STATE DOES NOT LEAK                                               */
/*    Render frame 1 with an effect ON, then frame 2 with it OFF on the */
/*    SAME chain instance. Frame 2 must equal the clean base. Catches a */
/*    globalCompositeOperation / filter / scratch surface an effect     */
/*    forgot to restore, which would bleed into the next frame.         */
/* ================================================================== */

describe('no state leaks into the next frame', () => {
  for (const id of ALL) {
    it(`${id}: ON then OFF returns byte-identical to the clean base`, () => {
      const glyph = baseGlyphLayer(W, H);
      const chain = makePostFxChain();
      const base = readCanvas(compositeBase(glyph, W, H));
      // Frame 1: effect on (max amount, to maximise any dirty state left behind).
      renderPostFx(chain, glyph, [{ id, amount: meta(id).max }], W, H);
      // Frame 2: everything off, same chain.
      const clean = readCanvas(renderPostFx(chain, glyph, [], W, H));
      expect(mismatch(clean, base)).toBe(0);
    });
  }
});

/* ================================================================== */
/* 6. GLYPH STAGE IS REAL                                               */
/*    character-bloom runs on the ISOLATED glyph layer before the       */
/*    composite. It must change pixels on/around the glyphs but leave   */
/*    backdrop-only pixels (far from any glyph) exactly as the base.    */
/*    If it bleeds into the far backdrop, the isolation is broken/faked.*/
/* ================================================================== */

describe('character-bloom transforms glyphs without touching the far backdrop', () => {
  // Radius beyond which a default character-bloom blur cannot reach a glyph.
  // Default amount 60 → blur radius ~4.6px; 24px is a wide safety margin.
  const FAR = 24;

  /** Boolean mask: true where a pixel is within `r` (Chebyshev) of glyph ink. */
  function nearGlyphMask(glyphPx: Uint8ClampedArray, w: number, h: number, r: number): Uint8Array {
    const ink = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) if (glyphPx[p * 4 + 3] > 10) ink[p] = 1;
    // Two-pass square dilation (horizontal then vertical) of the ink mask.
    const horiz = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let dx = -r; dx <= r && !hit; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && ink[y * w + xx]) hit = 1;
        }
        horiz[y * w + x] = hit;
      }
    }
    const near = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let dy = -r; dy <= r && !hit; dy++) {
          const yy = y + dy;
          if (yy >= 0 && yy < h && horiz[yy * w + x]) hit = 1;
        }
        near[y * w + x] = hit;
      }
    }
    return near;
  }

  it('changes glyph-region pixels but leaves far-backdrop pixels untouched', () => {
    // The full ramp inks every column (rightmost ink at x=221/240), leaving NO
    // backdrop far from a glyph — so the isolation claim would be untestable.
    // Confine glyphs to the left 60% to open a genuine far-backdrop band.
    const glyph = baseGlyphLayerPartial(W, H, 0.6);
    const chain = makePostFxChain();
    const glyphPx = readCanvas(glyph);
    const near = nearGlyphMask(glyphPx, W, H, FAR);

    const base = readCanvas(compositeBase(glyph, W, H));
    const bloomed = readCanvas(renderPostFx(chain, glyph, [{ id: 'character-bloom' }], W, H));

    // There must BE a far-backdrop region to test — else the assertion is empty.
    let farPixels = 0;
    let farChanged = 0;
    let nearChanged = 0;
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      const changed =
        base[i] !== bloomed[i] ||
        base[i + 1] !== bloomed[i + 1] ||
        base[i + 2] !== bloomed[i + 2] ||
        base[i + 3] !== bloomed[i + 3];
      if (near[p]) {
        if (changed) nearChanged++;
      } else {
        farPixels++;
        if (changed) farChanged++;
      }
    }

    expect(farPixels).toBeGreaterThan(0);   // a real backdrop region exists
    expect(nearChanged).toBeGreaterThan(0); // the glow actually fired on glyphs
    expect(farChanged).toBe(0);             // and never reached the far backdrop
  });
});

/* ================================================================== */
/* Sanity: the backdrop is opaque, so the composite has full coverage   */
/* (a transparent frame would make several deltas above meaningless).   */
/* ================================================================== */

describe('base composite is fully opaque over the backdrop', () => {
  it('every pixel of the clean base has alpha 255', () => {
    const glyph = baseGlyphLayer(W, H);
    const base = readCanvas(compositeBase(glyph, W, H, POSTFX_BACKDROP));
    let transparent = 0;
    for (let p = 0; p < W * H; p++) if (base[p * 4 + 3] < 255) transparent++;
    expect(transparent).toBe(0);
  });
});

/* ================================================================== */
/* 7. THE CHANNEL FAMILY, ON CONTINUOUS TONE (W8.PF)                    */
/*                                                                      */
/* The three channel-offset effects — chromatic, rgb-split,            */
/* character-chromatic — are tested here on a neutral grayscale ramp   */
/* rather than the sparse text fixture. On text, a UNIFORM displacement */
/* saturates: once the offset exceeds the stroke width the copies fully */
/* separate, and the d-wide edge-clamp border (which matches the flat   */
/* backdrop, so it barely diverges) grows with the offset — so          */
/* whole-frame SAD can PEAK mid-range and fall at max (this is the      */
/* reading that made rgb-split look "capped"). On continuous tone there */
/* is no stroke to re-overlap and no flat border to swamp the frame:    */
/* divergence tracks the offset honestly, which is the property these   */
/* assertions are meant to prove. The ramp doubles as the neutrality    */
/* source — R=G=B everywhere in, so any channel drift out is a cast.    */
/* ================================================================== */

/** The channel-offset family: two frame-stage, one glyph-stage. */
const CHANNEL_FX: readonly EffectId[] = ['chromatic', 'rgb-split', 'character-chromatic'];

describe('channel-offset amount is monotonic on continuous tone', () => {
  for (const id of CHANNEL_FX) {
    const { def, max } = meta(id);
    it(`${id}: meanSAD(off,max) > meanSAD(off,default) on a grayscale ramp`, () => {
      const ramp = neutralRampLayer(W, H);
      const chain = makePostFxChain();
      const off = readCanvas(renderPostFx(chain, ramp, [], W, H));
      const atDef = sad(off, readCanvas(renderPostFx(chain, ramp, [{ id, amount: def }], W, H)));
      const atMax = sad(off, readCanvas(renderPostFx(chain, ramp, [{ id, amount: max }], W, H)));
      // A dead, capped, or backwards `amount` fails here: on continuous tone a
      // larger offset can only move more tone across the frame, so atMax must
      // strictly exceed atDef. (Deterministic effects — k=1 is exact.)
      expect(atMax).toBeGreaterThan(atDef);
    });
  }
});

describe('channel-offset effects introduce no colour cast (neutrality guard)', () => {
  // Slack over the ramp's own 127.5 mid-grey. rgb-split's opposed ±d translation
  // biases R and B by a couple of levels at its default offset (the edge-clamp
  // border is asymmetric on a gradient); chromatic / character-chromatic scale
  // symmetrically about centre and stay ~0. A DROPPED or DOMINANT channel — the
  // old "whole frame neon green" failure — lands 60-127 levels off mid-grey, far
  // outside this band, so the guard fails hard on exactly that catastrophe.
  const TOL = 8;

  for (const id of CHANNEL_FX) {
    const { def } = meta(id);
    it(`${id}: per-channel means stay within ${TOL} of each other on a grayscale ramp`, () => {
      const ramp = neutralRampLayer(W, H);
      const chain = makePostFxChain();
      const m = channelMeans(readCanvas(renderPostFx(chain, ramp, [{ id, amount: def }], W, H)));
      expect(Math.abs(m.r - m.g)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(m.g - m.b)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(m.r - m.b)).toBeLessThanOrEqual(TOL);
    });
  }
});

/* ================================================================== */
/* 8. CHARACTER-CHROMATIC STAYS ON THE GLYPH LAYER                      */
/*                                                                      */
/* The bug this pins: character-chromatic ran the channel split with an */
/* opaque black accumulator, flooding the isolated glyph layer opaque   */
/* so the composite dropped the backdrop entirely — the whole frame     */
/* went black (means ~13 instead of ~125). That catastrophe passed both */
/* the "fires" and the text-monotonic checks (a black frame differs     */
/* enormously from OFF), so only a backdrop-preservation assertion      */
/* catches it. Confine glyphs to the left 60% and require the far-right */
/* backdrop band to be byte-identical to the untouched base.            */
/* ================================================================== */

describe('character-chromatic transforms glyphs without obliterating the backdrop', () => {
  it('leaves the far-backdrop band byte-identical to the base', () => {
    const glyph = baseGlyphLayerPartial(W, H, 0.6);
    const chain = makePostFxChain();
    const base = readCanvas(compositeBase(glyph, W, H));
    const on = readCanvas(
      renderPostFx(chain, glyph, [{ id: 'character-chromatic' }], W, H),
    );

    // Glyph ink ends near x=0.6*W; the default offset is <=3px. A band starting
    // 24px past that is unreachable by the effect but IS overwritten (to black)
    // by the opaque-accumulator bug — so it discriminates the fix from the bug.
    const farFrom = Math.round(W * 0.6) + 24;
    let farPixels = 0;
    let farChanged = 0;
    let nearChanged = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const changed =
          base[i] !== on[i] ||
          base[i + 1] !== on[i + 1] ||
          base[i + 2] !== on[i + 2] ||
          base[i + 3] !== on[i + 3];
        if (x >= farFrom) {
          farPixels++;
          if (changed) farChanged++;
        } else if (changed) {
          nearChanged++;
        }
      }
    }

    expect(farPixels).toBeGreaterThan(0); // a real far-backdrop band exists
    expect(nearChanged).toBeGreaterThan(0); // the fringe actually fired on glyphs
    expect(farChanged).toBe(0); // and never reached the far backdrop
  });
});
