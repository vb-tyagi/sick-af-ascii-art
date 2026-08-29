/**
 * Dither engine — T16, T17, T18.
 *
 * Two families with very different runtime characteristics:
 *
 *  - Ordered (Bayer): stateless per-pixel threshold. Cheap, parallelisable,
 *    safe to run per-frame on video.
 *  - Error-diffusion: serial, order-dependent — each pixel's error feeds its
 *    neighbours, so it cannot be parallelised and is materially slower.
 *    Gate it behind a frame cap or restrict it to stills.
 *
 * All published algorithms, implemented from their kernels.
 */

import { srgbToLinear, linearToSrgb } from './color';

export type DitherAlgorithm =
  | 'bayer2' | 'bayer4' | 'bayer8'
  | 'floyd-steinberg' | 'atkinson' | 'burkes'
  | 'sierra' | 'sierra-lite' | 'stucki' | 'jarvis'
  | 'threshold';

export type RGBTuple = [number, number, number];

/* ------------------------------------------------------------------ */
/* Ordered / Bayer                                                     */
/* ------------------------------------------------------------------ */

/**
 * Recursive Bayer construction:
 *   M(2n) = [ 4*M(n)+0  4*M(n)+2 ]
 *           [ 4*M(n)+3  4*M(n)+1 ]
 * Generated rather than transcribed so any power-of-two size is available.
 */
export function bayerMatrix(size: 2 | 4 | 8): number[][] {
  let m: number[][] = [[0, 2], [3, 1]];
  while (m.length < size) {
    const n = m.length;
    const next: number[][] = Array.from({ length: n * 2 }, () =>
      new Array(n * 2).fill(0),
    );
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next;
  }
  return m;
}

/** Normalised 0..1 threshold map, cached per size. */
const thresholdCache = new Map<number, number[][]>();

export function bayerThresholds(size: 2 | 4 | 8): number[][] {
  const hit = thresholdCache.get(size);
  if (hit) return hit;
  const m = bayerMatrix(size);
  const denom = size * size;
  const norm = m.map((row) => row.map((v) => (v + 0.5) / denom));
  thresholdCache.set(size, norm);
  return norm;
}

/* ------------------------------------------------------------------ */
/* Error-diffusion kernels                                             */
/* ------------------------------------------------------------------ */

/** [dx, dy, weight]. Weights are pre-divided by each kernel's divisor. */
type Kernel = ReadonlyArray<readonly [number, number, number]>;

const K = (entries: ReadonlyArray<readonly [number, number, number]>, div: number): Kernel =>
  entries.map(([dx, dy, w]) => [dx, dy, w / div] as const);

const KERNELS: Record<string, Kernel> = {
  'floyd-steinberg': K([[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]], 16),

  // Atkinson deliberately distributes only 6/8 of the error. The missing
  // quarter is the point: it lifts contrast and gives the classic crisp,
  // slightly blown-out Mac look.
  atkinson: K([[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]], 8),

  burkes: K(
    [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]],
    32,
  ),
  sierra: K(
    [[1, 0, 5], [2, 0, 3],
     [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
     [-1, 2, 2], [0, 2, 3], [1, 2, 2]],
    32,
  ),
  'sierra-lite': K([[1, 0, 2], [-1, 1, 1], [0, 1, 1]], 4),
  stucki: K(
    [[1, 0, 8], [2, 0, 4],
     [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
     [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]],
    42,
  ),
  jarvis: K(
    [[1, 0, 7], [2, 0, 5],
     [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
     [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]],
    48,
  ),
};

export const isErrorDiffusion = (a: DitherAlgorithm): boolean => a in KERNELS;

/* ------------------------------------------------------------------ */
/* Palette quantisation                                                */
/* ------------------------------------------------------------------ */

/**
 * Nearest palette entry by squared distance in LINEAR RGB.
 *
 * Matching in gamma-encoded sRGB weights dark tones wrongly and makes
 * diffused error accumulate visibly in shadows — hence the linearisation.
 */
export function nearestInPalette(
  r: number, g: number, b: number,
  paletteLinear: ReadonlyArray<RGBTuple>,
): number {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < paletteLinear.length; i++) {
    const p = paletteLinear[i];
    const dr = lr - p[0], dg = lg - p[1], db = lb - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export function toLinearPalette(srgb: ReadonlyArray<RGBTuple>): RGBTuple[] {
  return srgb.map(([r, g, b]) => [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]);
}

export function paletteToSrgb(paletteLinear: ReadonlyArray<RGBTuple>): RGBTuple[] {
  return paletteLinear.map(([r, g, b]) => [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)]);
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export interface DitherOptions {
  algorithm: DitherAlgorithm;
  /** sRGB 0..255 palette. Quantisation happens in linear space internally. */
  palette: ReadonlyArray<RGBTuple>;
  width: number;
  height: number;
}

/**
 * Dithers `data` (RGBA) in place against `palette`.
 *
 * Error is accumulated in a separate Float32 buffer rather than back into the
 * Uint8ClampedArray — clamping the running error at each step would destroy
 * exactly the sub-quantum information diffusion depends on.
 */
export function dither(data: Uint8ClampedArray, opts: DitherOptions): void {
  const { algorithm, width: w, height: h } = opts;
  const linear = toLinearPalette(opts.palette);
  const srgbPal = paletteToSrgb(linear);

  if (algorithm === 'threshold' || algorithm.startsWith('bayer')) {
    const size = algorithm === 'bayer2' ? 2 : algorithm === 'bayer8' ? 8 : 4;
    const thr = algorithm === 'threshold' ? null : bayerThresholds(size as 2 | 4 | 8);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // Bias the sample by the ordered threshold, then snap to palette.
        const bias = thr ? (thr[y % size][x % size] - 0.5) * 255 : 0;
        const idx = nearestInPalette(
          data[i] + bias, data[i + 1] + bias, data[i + 2] + bias, linear,
        );
        const p = srgbPal[idx];
        data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2];
      }
    }
    return;
  }

  const kernel = KERNELS[algorithm];
  if (!kernel) return;

  const err = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const e = (y * w + x) * 3;

      const r = data[i] + err[e];
      const g = data[i + 1] + err[e + 1];
      const b = data[i + 2] + err[e + 2];

      const idx = nearestInPalette(r, g, b, linear);
      const p = srgbPal[idx];
      data[i] = p[0]; data[i + 1] = p[1]; data[i + 2] = p[2];

      const dr = r - p[0], dg = g - p[1], db = b - p[2];

      for (const [dx, dy, wt] of kernel) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const ne = (ny * w + nx) * 3;
        err[ne] += dr * wt;
        err[ne + 1] += dg * wt;
        err[ne + 2] += db * wt;
      }
    }
  }
}
