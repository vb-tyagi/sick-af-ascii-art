/**
 * Still-image export — encoding only.
 *
 * This module deliberately owns NO pipeline. An earlier version re-derived the
 * render stages here so it could rasterise at a larger size, and it fell out of
 * step with the renderer the moment the backdrop, lights, mask and post-FX
 * stages landed — it would have written files missing half the effects the user
 * could see. Scaling now lives on the renderer itself
 * (`Renderer.renderToCanvas`), which runs the one pipeline at an arbitrary
 * scale, and this module only encodes the canvas it is handed.
 */

export type ExportFormat = 'png' | 'jpg';
export type ExportScale = 1 | 2 | 3 | 4;

export const EXPORT_SCALES: readonly ExportScale[] = [1, 2, 3, 4];
/** 2x by default: crisp enough to post without a surprising file size. */
export const DEFAULT_EXPORT_SCALE: ExportScale = 2;

/** Output pixel dimensions for a baseline size and scale — feeds the readout. */
export function exportDimensions(
  width: number,
  height: number,
  scale: ExportScale,
): { width: number; height: number } {
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function extensionFor(format: ExportFormat): string {
  return format === 'jpg' ? 'jpg' : 'png';
}

function mimeFor(format: ExportFormat): string {
  return format === 'jpg' ? 'image/jpeg' : 'image/png';
}

/**
 * Encode a rendered canvas to a Blob.
 *
 * JPEG carries no alpha, so a transparent backdrop would decode as black. The
 * JPG path composites onto white first — gaps then read as page, which is what
 * "no background" means to someone looking at the picture.
 */
export function encodeCanvas(
  canvas: HTMLCanvasElement,
  format: ExportFormat,
  quality = 0.92,
): Promise<Blob> {
  let target = canvas;

  if (format === 'jpg') {
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const fctx = flat.getContext('2d');
    if (!fctx) throw new Error('2D context unavailable for JPEG flattening');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(canvas, 0, 0);
    target = flat;
  }

  return new Promise((resolve, reject) => {
    target.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas encoding failed'))),
      mimeFor(format),
      format === 'jpg' ? quality : undefined,
    );
  });
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking synchronously races the browser's read of the object URL and the
  // download silently fails on some engines; hand it back on a later tick.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
