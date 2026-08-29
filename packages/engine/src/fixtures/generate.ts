/**
 * Synthetic fixture generator — W3.V3.
 *
 * A photograph is the wrong instrument for proving a dither/ASCII renderer:
 * pleasant detail hides banding, aspect skew, and diffusion artifacts. Each
 * fixture below isolates ONE failure mode so a broken render cannot pass by
 * looking "roughly right".
 *
 * Every fixture is pure Canvas 2D and fully deterministic — same size in, same
 * pixels out — so it doubles as a golden input for byte-equal determinism
 * checks. Zero licensing surface: nothing here is sampled from any external
 * asset.
 *
 * The draw functions are typed against the DOM CanvasRenderingContext2D; the
 * headless harness (scripts/render-modes.ts) and the mode tests pass a
 * structurally-compatible node canvas context cast to this type.
 */

export type FixtureName =
  | 'ramp-linear'
  | 'gradient-radial'
  | 'gradient-linear'
  | 'checker-1px'
  | 'plates-rgbwk'
  | 'noise-hifreq';

export interface Fixture {
  name: FixtureName;
  /** The one defect this fixture is built to expose. */
  catches: string;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

/** Deterministic PRNG so the noise fixture is byte-stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE_SEED = 0x9e3779b9;

export const FIXTURES: Record<FixtureName, Fixture> = {
  'ramp-linear': {
    name: 'ramp-linear',
    catches:
      'Ramp index off-by-one, density-rescale error, banding. The canonical ' +
      'monotonicity input: luminance rises smoothly 0->255 left to right, so a ' +
      'correct render is strictly ordered dark->light with no repeats or gaps.',
    draw: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#000000');
      g.addColorStop(1, '#ffffff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  },

  'gradient-radial': {
    name: 'gradient-radial',
    catches:
      'Error-diffusion "worms" and Bayer bias magnitude. A smooth radial ' +
      'falloff is the classic worst case for Floyd-Steinberg artifacting.',
    draw: (ctx, w, h) => {
      const g = ctx.createRadialGradient(
        w / 2, h / 2, 0,
        w / 2, h / 2, Math.max(w, h) / 2,
      );
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#000000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  },

  'gradient-linear': {
    name: 'gradient-linear',
    catches:
      'Diagonal tonal continuity + grid-axis bias. A gradient off the pixel ' +
      'axes catches sampler misalignment that a purely horizontal ramp hides.',
    draw: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.5, '#808080');
      g.addColorStop(1, '#ffffff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  },

  'checker-1px': {
    name: 'checker-1px',
    catches:
      'Sampler aliasing. At grid resolution a 1px checker MUST average to flat ' +
      'mid-grey. If it shimmers or shows structure, downscale-to-grid is broken.',
    draw: (ctx, w, h) => {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = (x + y) % 2 === 0 ? 255 : 0;
          const i = (y * w + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  },

  'plates-rgbwk': {
    name: 'plates-rgbwk',
    catches:
      'Palette quantisation in linear vs sRGB space, and per-channel colour ' +
      'handling. Pure R/G/B/W/K plates are where linear and gamma matching ' +
      'diverge most, and where a channel swap is instantly visible.',
    draw: (ctx, w, h) => {
      const plates = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000'];
      const cw = w / plates.length;
      plates.forEach((c, i) => {
        ctx.fillStyle = c;
        // +1 overlap kills sub-pixel seams between plates.
        ctx.fillRect(Math.floor(i * cw), 0, Math.ceil(cw) + 1, h);
      });
    },
  },

  'noise-hifreq': {
    name: 'noise-hifreq',
    catches:
      'Aliasing under downscale-to-grid. Per-pixel white noise is the hardest ' +
      'possible box-filter input; a correct sampler averages it toward mid-grey ' +
      'rather than passing through structured garbage.',
    draw: (ctx, w, h) => {
      const rand = mulberry32(NOISE_SEED);
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const v = (rand() * 256) | 0;
        const j = i * 4;
        img.data[j] = img.data[j + 1] = img.data[j + 2] = v;
        img.data[j + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
  },
};

export const ALL_FIXTURES = Object.keys(FIXTURES) as FixtureName[];

/** Draw a fixture onto an existing context. */
export function drawFixture(
  name: FixtureName,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  FIXTURES[name].draw(ctx, w, h);
}
