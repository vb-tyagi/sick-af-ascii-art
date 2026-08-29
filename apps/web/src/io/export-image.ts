/**
 * Raster export — T32.
 *
 * Exports the current render as a PNG or JPG at 1x-4x. The load-bearing rule is
 * that higher scales RE-RENDER the whole pipeline against larger dimensions —
 * they never upscale the visible bitmap. At 4x the grid is solved against 4x the
 * area, so it genuinely has ~4x the cells and every glyph is drawn crisp at its
 * native font size. Upscaling a small bitmap would blur exactly the hard edges
 * that make ASCII legible, defeating the point of the format.
 */

import { solveGrid } from '@sick-af/engine/grid';
import { GridSampler, type SourceMedia } from '@sick-af/engine/sample';
import { applyTint } from '@sick-af/engine/tint';
import type { ModeRenderer, RenderOptions } from '@sick-af/engine/renderer';

export type ExportFormat = 'png' | 'jpg';
export type ExportScale = 1 | 2 | 3 | 4;

/** Selectable resolution pills; 2x is the default. */
export const EXPORT_SCALES: readonly ExportScale[] = [1, 2, 3, 4];
export const DEFAULT_EXPORT_SCALE: ExportScale = 2;

export interface ExportConfig {
  source: SourceMedia;
  /** The resolved renderer for `options.mode`; the caller owns mode dispatch. */
  mode: ModeRenderer;
  options: RenderOptions;
  /** Logical (CSS-pixel) size of the visible canvas — the 1x baseline. */
  width: number;
  height: number;
  format: ExportFormat;
  scale: ExportScale;
  /** JPEG quality 0..1. Ignored for PNG. */
  quality?: number;
}

/** Output pixel dimensions for a given baseline and scale — feeds the live readout. */
export function exportDimensions(
  width: number,
  height: number,
  scale: ExportScale,
): { width: number; height: number } {
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function mimeFor(format: ExportFormat): string {
  return format === 'jpg' ? 'image/jpeg' : 'image/png';
}

/**
 * Runs the full render pipeline into `ctx` at the target pixel size. This mirrors
 * Renderer's private frame: background fill, grid solve, sample, mode dispatch,
 * tint. The identity transform means the mode draws directly in target pixels —
 * a larger canvas yields more cells, not stretched ones.
 */
function renderPipeline(
  ctx: CanvasRenderingContext2D,
  config: ExportConfig,
  w: number,
  h: number,
  opaqueBase: boolean,
): void {
  const { source, mode, options } = config;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // JPEG has no alpha; without an opaque base every transparent cell decodes to
  // black. Lay white down first so gaps read as page, not void.
  if (opaqueBase) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, w, h);
  }

  const grid = solveGrid(ctx, w, h, options.font);
  const sample = new GridSampler().sample(source, grid, options.transform);

  if (mode.renderGrid) {
    mode.renderGrid(ctx, sample, grid, options);
  } else if (mode.renderCell) {
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        mode.renderCell(ctx, sample, grid, options, col, row);
      }
    }
  }

  if (options.tint) {
    applyTint(ctx, w, h, options.tint);
  }
}

/** Re-renders the pipeline at the target scale and encodes it to a Blob. */
export function exportImage(config: ExportConfig): Promise<Blob> {
  const { width, height } = exportDimensions(config.width, config.height, config.scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable for export canvas');

  renderPipeline(ctx, config, width, height, config.format === 'jpg');

  const mime = mimeFor(config.format);
  const quality = config.format === 'jpg' ? (config.quality ?? 0.92) : undefined;

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`Failed to encode ${config.format} export`));
      },
      mime,
      quality,
    );
  });
}
