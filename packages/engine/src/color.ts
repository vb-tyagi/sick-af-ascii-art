/**
 * Colour pipeline — T6, T7, T9.
 *
 * Operates on the already-downscaled grid buffer, so this runs over cols*rows
 * pixels rather than full source resolution.
 */

export type ColorFilter =
  | 'none' | 'bw' | 'sepia' | 'warm' | 'cool' | 'vintage' | 'fade' | 'cyber';

export interface ColorOptions {
  /** -100..100, matching the reference control range. */
  brightness: number;
  /** -100..100. */
  contrast: number;
  /** 0..200, where 100 is unchanged. */
  saturation: number;
  /** 0..100. */
  grayscale: number;
  filter: ColorFilter;
}

export interface RGB { r: number; g: number; b: number }

/** Rec.709 relative luminance. Expects 0..255, returns 0..1. */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** sRGB transfer functions — required for any correct-in-linear-space work. */
export function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp255(Math.round(v * 255));
}

const FILTER_MATRIX: Record<Exclude<ColorFilter, 'none' | 'bw'>, number[]> = {
  // Row-major 3x3, applied to [r,g,b].
  sepia:   [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131],
  warm:    [1.10, 0.02, 0.00, 0.00, 1.00, 0.00, 0.00, 0.02, 0.88],
  cool:    [0.88, 0.00, 0.05, 0.00, 1.00, 0.02, 0.05, 0.02, 1.12],
  vintage: [0.62, 0.32, 0.06, 0.16, 0.70, 0.14, 0.12, 0.22, 0.56],
  fade:    [0.86, 0.10, 0.08, 0.08, 0.86, 0.10, 0.10, 0.10, 0.84],
  cyber:   [0.72, 0.00, 0.28, 0.10, 0.86, 0.30, 0.30, 0.10, 1.16],
};

function applyMatrix(px: RGB, m: number[]): RGB {
  const { r, g, b } = px;
  return {
    r: clamp255(r * m[0] + g * m[1] + b * m[2]),
    g: clamp255(r * m[3] + g * m[4] + b * m[5]),
    b: clamp255(r * m[6] + g * m[7] + b * m[8]),
  };
}

function applyFilter(px: RGB, filter: ColorFilter): RGB {
  if (filter === 'none') return px;
  if (filter === 'bw') {
    const l = luminance(px.r, px.g, px.b) * 255;
    return { r: l, g: l, b: l };
  }
  return applyMatrix(px, FILTER_MATRIX[filter]);
}

/**
 * Mutates `data` (RGBA, grid-sized) in place.
 *
 * Order is deliberate: brightness/contrast are tonal and run first, then the
 * filter matrix recolours, then saturation and grayscale trim the result.
 * Reordering changes the look — filters applied post-desaturation are no-ops.
 */
export function applyColorPipeline(
  data: Uint8ClampedArray,
  opts: ColorOptions,
): void {
  const bright = (opts.brightness / 100) * 255;
  // Standard contrast factor; maps -100..100 onto a smooth 0..~4 multiplier.
  const c = Math.max(-100, Math.min(100, opts.contrast));
  const contrastF = (259 * (c + 255)) / (255 * (259 - c));
  const sat = opts.saturation / 100;
  const gray = opts.grayscale / 100;
  const hasFilter = opts.filter !== 'none';

  for (let i = 0; i < data.length; i += 4) {
    let px: RGB = {
      r: clamp255(contrastF * (data[i] - 128) + 128 + bright),
      g: clamp255(contrastF * (data[i + 1] - 128) + 128 + bright),
      b: clamp255(contrastF * (data[i + 2] - 128) + 128 + bright),
    };

    if (hasFilter) px = applyFilter(px, opts.filter);

    if (sat !== 1) {
      const l = luminance(px.r, px.g, px.b) * 255;
      px = {
        r: clamp255(l + (px.r - l) * sat),
        g: clamp255(l + (px.g - l) * sat),
        b: clamp255(l + (px.b - l) * sat),
      };
    }

    if (gray > 0) {
      const l = luminance(px.r, px.g, px.b) * 255;
      px = {
        r: px.r + (l - px.r) * gray,
        g: px.g + (l - px.g) * gray,
        b: px.b + (l - px.b) * gray,
      };
    }

    data[i] = px.r;
    data[i + 1] = px.g;
    data[i + 2] = px.b;
  }
}

export interface RampOptions {
  ramp: string;
  invert: boolean;
  /** 0..100 — luminance below this maps to the empty end of the ramp. */
  density: number;
  /** 0..100 — probability-ish gate on whether a cell draws at all. */
  coverage: number;
}

/** Maps 0..1 luminance to a ramp index. Ramp is ordered dark→light. */
export function luminanceToChar(l: number, opts: RampOptions): string {
  const { ramp, invert, density } = opts;
  let v = invert ? 1 - l : l;

  const cut = density / 100;
  if (v < cut) return ramp[0];
  // Rescale the surviving band across the full ramp so density doesn't just
  // clip detail — it redistributes it.
  v = cut < 1 ? (v - cut) / (1 - cut) : v;

  const idx = Math.round(v * (ramp.length - 1));
  return ramp[Math.max(0, Math.min(ramp.length - 1, idx))];
}
