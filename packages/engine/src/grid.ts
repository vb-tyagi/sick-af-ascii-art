/**
 * Grid solver — T4.
 *
 * Monospace glyphs are never square. Assuming they are is the single most
 * common reason ASCII renderers look subtly stretched, so the cell aspect is
 * measured from the actual loaded font rather than assumed.
 */

export interface GridSpec {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  charAspect: number;
}

export interface GridOptions {
  fontSize: number;
  fontFamily: string;
  /** Multiplier on fontSize for row height. 1.0 packs rows tight. */
  lineHeight?: number;
}

const aspectCache = new Map<string, number>();

/**
 * Advance width / font size for the given family, measured once per family.
 *
 * Uses 'M' at a large size: the ratio is scale-invariant, and a large sample
 * keeps sub-pixel rounding from skewing it.
 */
export function measureCharAspect(
  ctx: CanvasRenderingContext2D,
  fontFamily: string,
): number {
  const cached = aspectCache.get(fontFamily);
  if (cached !== undefined) return cached;

  const probeSize = 100;
  const prevFont = ctx.font;
  ctx.font = `${probeSize}px ${fontFamily}`;
  const aspect = ctx.measureText('M').width / probeSize;
  ctx.font = prevFont;

  // A failed font load falls back to a proportional default and yields a
  // nonsense ratio; clamp to the plausible monospace band rather than
  // rendering a visibly broken grid.
  const safe = aspect > 0.3 && aspect < 1.2 ? aspect : 0.6;
  aspectCache.set(fontFamily, safe);
  return safe;
}

export function solveGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opts: GridOptions,
): GridSpec {
  const { fontSize, fontFamily, lineHeight = 1 } = opts;
  const charAspect = measureCharAspect(ctx, fontFamily);

  const cellW = fontSize * charAspect;
  const cellH = fontSize * lineHeight;

  return {
    cols: Math.max(1, Math.floor(width / cellW)),
    rows: Math.max(1, Math.floor(height / cellH)),
    cellW,
    cellH,
    charAspect,
  };
}

export function clearAspectCache(): void {
  aspectCache.clear();
}
