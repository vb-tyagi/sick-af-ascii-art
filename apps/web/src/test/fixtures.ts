/**
 * Synthetic test fixtures.
 *
 * These exist because photographs are a poor instrument for verifying a
 * dither/ASCII renderer — they hide banding, aspect skew, and diffusion
 * artifacts behind pleasant detail. Each fixture below isolates one failure
 * mode and makes it impossible to miss.
 *
 * Zero licensing surface: everything is generated.
 */

export type FixtureName =
  | 'ramp-linear'
  | 'ramp-steps'
  | 'gradient-radial'
  | 'checker-1px'
  | 'checker-grid'
  | 'contrast-plates'
  | 'primaries'
  | 'frequency-sweep';

export interface Fixture {
  name: FixtureName;
  /** The specific defect this fixture is designed to expose. */
  catches: string;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

export const FIXTURES: Record<FixtureName, Fixture> = {
  'ramp-linear': {
    name: 'ramp-linear',
    catches:
      'Ramp index off-by-one, density-rescale errors, banding. A correct ' +
      'render shows every ramp glyph exactly once, evenly spaced, no repeats ' +
      'at either end.',
    draw: (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#000');
      g.addColorStop(1, '#fff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  },

  'ramp-steps': {
    name: 'ramp-steps',
    catches:
      'Quantisation boundaries. 16 hard steps — each should map to a stable ' +
      'glyph with no dithering noise inside a step.',
    draw: (ctx, w, h) => {
      const n = 16;
      for (let i = 0; i < n; i++) {
        const v = Math.round((i / (n - 1)) * 255);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect((i * w) / n, 0, w / n + 1, h);
      }
    },
  },

  'gradient-radial': {
    name: 'gradient-radial',
    catches:
      'Error-diffusion "worms" and Bayer bias magnitude. Smooth radial falloff ' +
      'is the classic worst case for Floyd-Steinberg artifacting.',
    draw: (ctx, w, h) => {
      const g = ctx.createRadialGradient(
        w / 2, h / 2, 0,
        w / 2, h / 2, Math.max(w, h) / 2,
      );
      g.addColorStop(0, '#fff');
      g.addColorStop(1, '#000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    },
  },

  'checker-1px': {
    name: 'checker-1px',
    catches:
      'Sampler aliasing. At grid resolution this MUST average to flat mid-grey. ' +
      'If it shimmers or shows structure, downscale-to-grid is broken.',
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

  'checker-grid': {
    name: 'checker-grid',
    catches:
      'Character cell aspect ratio. Squares must render as squares. If they ' +
      'read as rectangles, charAspect measurement is wrong — the #1 ASCII bug.',
    draw: (ctx, w, h) => {
      const cell = 32;
      for (let y = 0; y < h; y += cell) {
        for (let x = 0; x < w; x += cell) {
          ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? '#fff' : '#000';
          ctx.fillRect(x, y, cell, cell);
        }
      }
    },
  },

  'contrast-plates': {
    name: 'contrast-plates',
    catches: 'Coverage gating and edge emphasis. Hard edges, no midtones.',
    draw: (ctx, w, h) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, Math.PI * 2);
      ctx.fill();
    },
  },

  primaries: {
    name: 'primaries',
    catches:
      'Palette quantisation in linear vs sRGB space. Saturated primaries are ' +
      'where the two diverge most visibly.',
    draw: (ctx, w, h) => {
      const cols = ['#f00', '#0f0', '#00f', '#fff', '#000', '#ff0', '#0ff', '#f0f'];
      const cw = w / cols.length;
      cols.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(i * cw, 0, cw + 1, h);
      });
    },
  },

  'frequency-sweep': {
    name: 'frequency-sweep',
    catches:
      'Aliasing under downscale. Stripe frequency rises left→right; the point ' +
      'where it turns to mush is the effective resolution limit.',
    draw: (ctx, w, h) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      for (let x = 0; x < w; x++) {
        // Frequency ramps quadratically so the useful band is wide.
        const freq = 0.5 + (x / w) * (x / w) * 40;
        if (Math.sin((x / w) * freq * Math.PI * 2 * 10) > 0) {
          ctx.fillRect(x, 0, 1, h);
        }
      }
    },
  },
};

export function renderFixture(
  name: FixtureName,
  w = 800,
  h = 600,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  FIXTURES[name].draw(ctx, w, h);
  return c;
}

export const ALL_FIXTURES = Object.keys(FIXTURES) as FixtureName[];
