/**
 * Point-lights suite — T22.
 *
 * The feature is per-CHARACTER glow, not a tint. These tests pin the two claims
 * that matter: (1) off is a genuine no-op, and (2) a light raises a cell's
 * effective luminance enough to move it to a lighter glyph — i.e. it changes the
 * CHARACTER, not merely the colour.
 */

import { describe, it, expect } from 'vitest';
import {
  applyLights,
  lightGainAt,
  litLuminance,
  DEFAULT_LIGHTS,
  type LightsOptions,
  type PointLight,
} from '../lights';
import { luminanceToChar, type RampOptions } from '../color';

const RAMP: RampOptions = {
  ramp: '@#S08Xx+=-;:. ',
  invert: false,
  density: 0,
  coverage: 100,
};

function grid(cols: number, rows: number, r: number, g: number, b: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(cols * rows * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
  return d;
}

const whiteLight = (x: number, y: number): PointLight => ({
  x,
  y,
  radius: 0.3,
  color: '#ffffff',
  intensity: 2,
});

describe('applyLights — off is a no-op', () => {
  it('disabled leaves the buffer byte-for-byte unchanged', () => {
    const a = grid(8, 8, 40, 40, 40);
    const b = grid(8, 8, 40, 40, 40);
    applyLights(a, 8, 8, { ...DEFAULT_LIGHTS });
    expect([...a]).toEqual([...b]);
  });

  it('enabled but with no lights is also unchanged', () => {
    const a = grid(8, 8, 40, 40, 40);
    const b = grid(8, 8, 40, 40, 40);
    applyLights(a, 8, 8, { enabled: true, lights: [], bloom: 0 });
    expect([...a]).toEqual([...b]);
  });

  it('a zero-intensity light contributes nothing', () => {
    const a = grid(8, 8, 40, 40, 40);
    const b = grid(8, 8, 40, 40, 40);
    applyLights(a, 8, 8, {
      enabled: true,
      lights: [{ ...whiteLight(0.5, 0.5), intensity: 0 }],
      bloom: 0,
    });
    expect([...a]).toEqual([...b]);
  });
});

describe('applyLights — per-character coupling', () => {
  const opts: LightsOptions = {
    enabled: true,
    lights: [whiteLight(0.5, 0.5)],
    bloom: 0,
  };

  it('raises luminance at the light centre vs. the dark corner', () => {
    const centre = litLuminance({ r: 40, g: 40, b: 40 }, 8, 8, 4, 4, opts);
    const corner = litLuminance({ r: 40, g: 40, b: 40 }, 8, 8, 0, 0, opts);
    expect(centre).toBeGreaterThan(corner);
  });

  it('the raised luminance selects a lighter glyph — the glow IS the character', () => {
    const dark = 40;
    const baseChar = luminanceToChar(litLuminance({ r: dark, g: dark, b: dark }, 8, 8, 0, 0, {
      ...opts,
      lights: [],
      enabled: false,
    }), RAMP);
    const litChar = luminanceToChar(
      litLuminance({ r: dark, g: dark, b: dark }, 8, 8, 4, 4, opts),
      RAMP,
    );
    const baseIdx = RAMP.ramp.indexOf(baseChar);
    const litIdx = RAMP.ramp.indexOf(litChar);
    // Ramp is dark→light: a lighter cell maps to a higher index.
    expect(litIdx).toBeGreaterThan(baseIdx);
  });

  it('a coloured light tints toward its own hue', () => {
    const red = grid(4, 4, 30, 30, 30);
    applyLights(red, 4, 4, {
      enabled: true,
      lights: [{ x: 0.5, y: 0.5, radius: 0.4, color: '#ff0000', intensity: 3 }],
      bloom: 0,
    });
    const i = (1 * 4 + 1) * 4; // a lit central cell
    expect(red[i]).toBeGreaterThan(red[i + 1]);
    expect(red[i]).toBeGreaterThan(red[i + 2]);
  });
});

describe('lightGainAt — softened falloff', () => {
  it('is finite at the exact light centre (the +1 term)', () => {
    const g = lightGainAt([whiteLight(0.5, 0.5)], 0.5, 0.5);
    expect(Number.isFinite(g.r)).toBe(true);
    // contribution = intensity / (1 + 0) = intensity at dist 0.
    expect(g.r).toBeCloseTo(2, 5);
  });

  it('decreases monotonically with distance from the light', () => {
    const lights = [whiteLight(0.5, 0.5)];
    const near = lightGainAt(lights, 0.5, 0.5).r;
    const mid = lightGainAt(lights, 0.7, 0.5).r;
    const far = lightGainAt(lights, 0.95, 0.5).r;
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });
});

describe('applyLights — bloom', () => {
  it('bloom brightens lit cells further than the multiplicative core alone', () => {
    const withoutBloom = grid(4, 4, 20, 20, 20);
    const withBloom = grid(4, 4, 20, 20, 20);
    const base = { enabled: true, lights: [whiteLight(0.5, 0.5)] };
    applyLights(withoutBloom, 4, 4, { ...base, bloom: 0 });
    applyLights(withBloom, 4, 4, { ...base, bloom: 0.5 });
    const i = (1 * 4 + 1) * 4;
    expect(withBloom[i]).toBeGreaterThan(withoutBloom[i]);
  });
});
