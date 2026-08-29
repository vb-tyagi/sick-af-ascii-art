/**
 * Glyph modes — T10.
 *
 * The glyph family (§4.3): characters, block-chars, mixed. Each maps a cell's
 * Rec.709 luminance to a ramp glyph and draws it with fillText, coloured from
 * the sampled cell RGB. These are the hot path, so the whole grid renders in
 * one `renderGrid` pass rather than per-cell: ctx.font is set exactly once, and
 * fills are grouped by colour so fillStyle churn — which dominates cost — is
 * paid per distinct colour, not per cell.
 *
 * Ramp ordering follows color.ts: DARK -> LIGHT, index 0 densest. invert and
 * density are already RampOptions concerns handled by luminanceToChar, so this
 * module never reimplements them.
 */

import type { ModeRenderer, RenderOptions } from '../renderer';
import type { SampleResult } from '../sample';
import type { GridSpec } from '../grid';
import { luminance, luminanceToChar, type RampOptions } from '../color';

/** charPreset ramps, DARK -> LIGHT. `detailed` is our own ordering. */
export const CHARACTER_RAMPS = {
  standard: '@#S08Xx+=-;:. ',
  detailed:
    '@MWNBHKRDGFAQ#$8&%*ohakbdpqwmZO0CJUYXzcvunxrjft/|(){}[]1?-_+~<>i!lI;:,"^\'. ',
  minimal: '@+:. ',
} as const;

export type CharPreset = keyof typeof CHARACTER_RAMPS;

/** Unicode block elements, full block (densest) -> space. */
export const BLOCK_RAMP = '█▓▒░ ';

export type GlyphBlendMode =
  | 'source-over' | 'overlay' | 'color-dodge' | 'screen' | 'lighter';

/**
 * Glyph-family controls layered on top of RenderOptions. The renderer threads
 * these through untouched; a mode reads them off `opts.glyph`.
 */
export interface GlyphOptions {
  charPreset?: CharPreset;
  /** 0..100. */
  charOpacity?: number;
  blendMode?: GlyphBlendMode;
  dotGrid?: boolean;
  randomChars?: boolean;
  /** Draw every glyph in opts.foreground instead of the sampled cell colour. */
  mono?: boolean;
}

export interface GlyphRenderOptions extends RenderOptions {
  glyph?: GlyphOptions;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function hexColor(packed: number): string {
  return '#' + (packed & 0xffffff).toString(16).padStart(6, '0');
}

/** Effective character ramp: charPreset overrides the base ramp string. */
export function resolveCharRamp(opts: GlyphRenderOptions): RampOptions {
  const preset = opts.glyph?.charPreset;
  if (preset && preset in CHARACTER_RAMPS) {
    return { ...opts.ramp, ramp: CHARACTER_RAMPS[preset] };
  }
  return opts.ramp;
}

/**
 * randomChars picks from the ramp BAND adjacent to the luminance-mapped glyph,
 * never uniformly — a uniform pick destroys the tonal read. The image still
 * resolves because every substitution stays within one ramp step of the target.
 */
function pickGlyph(l: number, ramp: RampOptions, randomize: boolean): string {
  const base = luminanceToChar(l, ramp);
  if (!randomize) return base;
  const idx = ramp.ramp.indexOf(base);
  if (idx < 0) return base;
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(ramp.ramp.length - 1, idx + 1);
  return ramp.ramp[lo + Math.floor(Math.random() * (hi - lo + 1))];
}

function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  grid: GridSpec,
  opts: GlyphRenderOptions,
): void {
  const { cols, rows, cellW, cellH } = grid;
  const radius = Math.max(0.5, Math.min(cellW, cellH) * 0.06);
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = opts.foreground ?? '#ffffff';
  for (let row = 0; row < rows; row++) {
    const cy = row * cellH + cellH / 2;
    for (let col = 0; col < cols; col++) {
      ctx.beginPath();
      ctx.arc(col * cellW + cellW / 2, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

interface Draw { char: string; x: number; y: number }

type RampFor = (col: number, row: number) => RampOptions;

/**
 * Per-cell colour override, returning a packed 0xRRGGBB. When supplied it
 * replaces the sampled cell RGB as both the bucket key and the fill, letting a
 * mode recolour the grid (e.g. disco) without touching layout. `l` is the cell
 * luminance so a colour can still track the source tone.
 */
export type ColorFor = (col: number, row: number, l: number) => number;

export function renderGlyphs(
  ctx: CanvasRenderingContext2D,
  sample: SampleResult,
  grid: GridSpec,
  opts: GlyphRenderOptions,
  rampFor: RampFor,
  colorFor?: ColorFor,
): void {
  const g = opts.glyph ?? {};
  const { cellW, cellH } = grid;
  const { cols, rows, data } = sample;

  ctx.save();
  // One font per frame — never per cell (see module header, perf gate).
  ctx.font = `${opts.font.fontSize}px ${opts.font.fontFamily}`;
  // textBaseline='top' + textAlign='left' + integer-free (col*cellW) placement.
  // textAlign='center' drifts on non-integer cell widths, so it is never used.
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.globalAlpha = clamp01((g.charOpacity ?? 100) / 100);
  ctx.globalCompositeOperation = g.blendMode ?? 'source-over';

  const mono = g.mono === true;
  const randomize = g.randomChars === true;

  // Bucket by packed colour so fillStyle is assigned once per distinct colour.
  const buckets = new Map<number, Draw[]>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      const r = data[i];
      const gc = data[i + 1];
      const b = data[i + 2];
      const l = luminance(r, gc, b);
      const char = pickGlyph(l, rampFor(col, row), randomize);
      // Space carries no ink — skipping it saves a fillText and reads identically.
      if (char === ' ' || char === '') continue;

      const key = mono
        ? -1
        : colorFor
          ? colorFor(col, row, l) & 0xffffff
          : (r << 16) | (gc << 8) | b;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push({ char, x: col * cellW, y: row * cellH });
    }
  }

  for (const [key, ops] of buckets) {
    ctx.fillStyle = mono ? (opts.foreground ?? '#ffffff') : hexColor(key);
    for (let k = 0; k < ops.length; k++) {
      ctx.fillText(ops[k].char, ops[k].x, ops[k].y);
    }
  }

  if (g.dotGrid) drawDotGrid(ctx, grid, opts);
  ctx.restore();
}

export const charactersMode: ModeRenderer = {
  renderGrid(ctx, sample, grid, opts) {
    const o: GlyphRenderOptions = opts;
    const ramp = resolveCharRamp(o);
    renderGlyphs(ctx, sample, grid, o, () => ramp);
  },
};

export const blockCharsMode: ModeRenderer = {
  renderGrid(ctx, sample, grid, opts) {
    const o: GlyphRenderOptions = opts;
    const ramp: RampOptions = { ...o.ramp, ramp: BLOCK_RAMP };
    renderGlyphs(ctx, sample, grid, o, () => ramp);
  },
};

export const mixedMode: ModeRenderer = {
  renderGrid(ctx, sample, grid, opts) {
    const o: GlyphRenderOptions = opts;
    const charRamp = resolveCharRamp(o);
    const blockRamp: RampOptions = { ...o.ramp, ramp: BLOCK_RAMP };
    // Interleave the two families across the grid in a checkerboard.
    renderGlyphs(ctx, sample, grid, o, (col, row) =>
      (col + row) % 2 === 0 ? blockRamp : charRamp,
    );
  },
};

/** Registry keys → renderers, for Renderer.registerMode wiring. */
export const glyphModes: Record<string, ModeRenderer> = {
  characters: charactersMode,
  'block-chars': blockCharsMode,
  mixed: mixedMode,
};
