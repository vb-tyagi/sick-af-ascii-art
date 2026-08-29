import { describe, it, expect } from 'vitest';
import {
  luminance,
  srgbToLinear,
  linearToSrgb,
  applyColorPipeline,
  luminanceToChar,
  type ColorOptions,
  type RampOptions,
} from '../color';
import {
  bayerMatrix,
  bayerThresholds,
  nearestInPalette,
  toLinearPalette,
  dither,
  type RGBTuple,
  type DitherAlgorithm,
} from '../dither';

/* ------------------------------------------------------------------ */
/* 1. bayerMatrix — every integer 0..n^2-1 exactly once                */
/* ------------------------------------------------------------------ */

describe('bayerMatrix', () => {
  for (const size of [2, 4, 8] as const) {
    it(`size ${size} is a permutation of 0..${size * size - 1}`, () => {
      const m = bayerMatrix(size);
      expect(m.length).toBe(size);
      for (const row of m) expect(row.length).toBe(size);

      const flat = m.flat().sort((a, b) => a - b);
      const expected = Array.from({ length: size * size }, (_, i) => i);
      expect(flat).toEqual(expected);
    });
  }
});

/* ------------------------------------------------------------------ */
/* 2. bayerThresholds — strictly in (0,1), evenly spread               */
/* ------------------------------------------------------------------ */

describe('bayerThresholds', () => {
  for (const size of [2, 4, 8] as const) {
    it(`size ${size} values are strictly between 0 and 1`, () => {
      const t = bayerThresholds(size).flat();
      for (const v of t) {
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      }
    });

    it(`size ${size} values are evenly spread (equal spacing)`, () => {
      const sorted = bayerThresholds(size).flat().sort((a, b) => a - b);
      expect(sorted.length).toBe(size * size);
      const step = sorted[1] - sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBeCloseTo(step, 10);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* 3. luminance — white=1, black=0, green > red > blue                 */
/* ------------------------------------------------------------------ */

describe('luminance', () => {
  it('white returns 1', () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 10);
  });
  it('black returns 0', () => {
    expect(luminance(0, 0, 0)).toBeCloseTo(0, 10);
  });
  it('green weighs more than red weighs more than blue', () => {
    const green = luminance(0, 255, 0);
    const red = luminance(255, 0, 0);
    const blue = luminance(0, 0, 255);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

/* ------------------------------------------------------------------ */
/* 4. srgb <-> linear round-trip within 1/255                          */
/* ------------------------------------------------------------------ */

describe('srgb/linear round-trip', () => {
  for (const c of [0, 1, 64, 128, 192, 254, 255]) {
    it(`round-trips ${c} within 1 code value`, () => {
      const back = linearToSrgb(srgbToLinear(c));
      expect(Math.abs(back - c)).toBeLessThanOrEqual(1);
    });
  }
});

/* ------------------------------------------------------------------ */
/* 5. nearestInPalette                                                 */
/* ------------------------------------------------------------------ */

describe('nearestInPalette', () => {
  const paletteSrgb: RGBTuple[] = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
    [0, 128, 64],
  ];
  const linear = toLinearPalette(paletteSrgb);

  it('exact palette colours map to their own index', () => {
    paletteSrgb.forEach((c, i) => {
      expect(nearestInPalette(c[0], c[1], c[2], linear)).toBe(i);
    });
  });

  it('pure red against [black, white, red] picks red', () => {
    const bwr = toLinearPalette([
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
    ]);
    expect(nearestInPalette(255, 0, 0, bwr)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 6. luminanceToChar — PRIME SUSPECT                                  */
/* ------------------------------------------------------------------ */

describe('luminanceToChar', () => {
  const ramp = ' .:-=+*#%@'; // 10 unique chars, dark -> light
  const base: RampOptions = { ramp, invert: false, density: 0, coverage: 100 };

  it('density=0 sweep hits every ramp index at least once', () => {
    const seen = new Set<string>();
    const N = 2000;
    for (let i = 0; i <= N; i++) {
      seen.add(luminanceToChar(i / N, base));
    }
    for (const ch of ramp) {
      expect(seen.has(ch)).toBe(true);
    }
  });

  it('invert=true mirrors invert=false across the sweep', () => {
    const N = 100;
    for (let i = 0; i <= N; i++) {
      const l = i / N;
      const inverted = luminanceToChar(l, { ...base, invert: true });
      const mirrored = luminanceToChar(1 - l, { ...base, invert: false });
      expect(inverted).toBe(mirrored);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 7. applyColorPipeline                                               */
/* ------------------------------------------------------------------ */

describe('applyColorPipeline', () => {
  const makeData = (px: number[][]): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(px.length * 4);
    px.forEach(([r, g, b], i) => {
      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    });
    return d;
  };

  const sample = [
    [10, 200, 55],
    [128, 64, 192],
    [255, 0, 0],
    [33, 33, 240],
  ];

  it('contrast=0 (no brightness/sat/gray/filter) is identity within rounding', () => {
    const d = makeData(sample);
    const orig = Uint8ClampedArray.from(d);
    const opts: ColorOptions = {
      brightness: 0,
      contrast: 0,
      saturation: 100,
      grayscale: 0,
      filter: 'none',
    };
    applyColorPipeline(d, opts);
    for (let i = 0; i < d.length; i++) {
      expect(Math.abs(d[i] - orig[i])).toBeLessThanOrEqual(1);
    }
  });

  it('saturation=0 gives r===g===b', () => {
    const d = makeData(sample);
    const opts: ColorOptions = {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      grayscale: 0,
      filter: 'none',
    };
    applyColorPipeline(d, opts);
    for (let i = 0; i < d.length; i += 4) {
      expect(d[i]).toBe(d[i + 1]);
      expect(d[i + 1]).toBe(d[i + 2]);
    }
  });

  it('grayscale=100 gives r===g===b', () => {
    const d = makeData(sample);
    const opts: ColorOptions = {
      brightness: 0,
      contrast: 0,
      saturation: 100,
      grayscale: 100,
      filter: 'none',
    };
    applyColorPipeline(d, opts);
    for (let i = 0; i < d.length; i += 4) {
      expect(d[i]).toBe(d[i + 1]);
      expect(d[i + 1]).toBe(d[i + 2]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 8. dither with a 2-colour palette emits ONLY those two colours      */
/* ------------------------------------------------------------------ */

describe('dither 2-colour palette', () => {
  const palette: RGBTuple[] = [
    [0, 0, 0],
    [255, 255, 255],
  ];

  const algorithms: DitherAlgorithm[] = [
    'threshold',
    'bayer2',
    'bayer4',
    'bayer8',
    'floyd-steinberg',
    'atkinson',
    'burkes',
    'sierra',
    'sierra-lite',
    'stucki',
    'jarvis',
  ];

  const w = 16;
  const h = 16;

  const makeGradient = (): Uint8ClampedArray => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = Math.round((i / (w * h - 1)) * 255);
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    return d;
  };

  for (const algorithm of algorithms) {
    it(`${algorithm} emits only the two palette colours`, () => {
      const d = makeGradient();
      dither(d, { algorithm, palette, width: w, height: h });
      for (let i = 0; i < d.length; i += 4) {
        const isBlack = d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0;
        const isWhite = d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255;
        expect(isBlack || isWhite).toBe(true);
      }
    });
  }
});
