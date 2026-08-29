/**
 * Mask layer — T21 (TEARDOWN §3.8).
 *
 * A user-drawn region that restricts the ASCII glyph layer to a shape: inside
 * the shape the mode renders as normal, everything outside stays as whatever was
 * drawn before the glyphs (the backdrop). Two capture tools feed one geometry
 * model — freehand strokes and click-to-place polygons — because both reduce to
 * the same thing: an ordered list of boundary points enclosing an area. The mask
 * is a *union* of any number of such shapes.
 *
 * CLIP vs destination-in — we clip. The render order is backdrop first, glyphs
 * second, both onto the SAME output canvas. `ctx.clip()` is set BEFORE the glyph
 * pass, so the mode's per-cell draws are discarded outside the region for free
 * and the already-painted backdrop underneath is never touched. The alternative,
 * `globalCompositeOperation = 'destination-in'`, composites against pixels
 * already on the surface — it would punch a hole through the backdrop too, so it
 * only works if the glyph layer is first rendered to its own offscreen canvas
 * and then composited in. That is a second full-size surface and a second draw
 * of the whole grid for no gain. Clip is strictly cheaper here.
 *
 * The enabled flag is load-bearing: an off mask is a genuine no-op — no path is
 * traced, no clip is set, no context state is touched — so a disabled mask costs
 * exactly nothing and can never distort the unmasked image.
 */

export interface Point {
  x: number;
  y: number;
}

/** One enclosed boundary. Fewer than 3 points encloses no area and is ignored. */
export interface MaskShape {
  points: Point[];
}

/** The two ways the overlay captures a shape; identical once committed. */
export type MaskTool = 'freehand' | 'polygon';

export interface MaskState {
  enabled: boolean;
  /** Committed shapes. The clip region is their union. */
  shapes: MaskShape[];
}

export const EMPTY_MASK: MaskState = { enabled: false, shapes: [] };

/** A shape contributes to the clip only if it encloses real area. */
function encloses(shape: MaskShape): boolean {
  return shape.points.length >= 3;
}

/**
 * True when the mask would actually restrict drawing: it is enabled AND at least
 * one shape encloses area. This is the single gate every consumer checks — if it
 * is false the mask must behave as if it were not there at all.
 */
export function hasRegion(mask: MaskState): boolean {
  return mask.enabled && mask.shapes.some(encloses);
}

/**
 * Trace every enclosing shape as a closed sub-path into `ctx`'s current path.
 * Does not fill, stroke, or clip — only builds geometry, so the caller decides
 * what to do with it (clip for the engine, fill for the overlay preview). Shapes
 * are wound in their captured order; non-overlapping shapes union under the
 * default non-zero rule.
 */
export function traceMask(
  ctx: CanvasRenderingContext2D,
  mask: MaskState,
): void {
  for (const shape of mask.shapes) {
    if (!encloses(shape)) continue;
    const [first, ...rest] = shape.points;
    ctx.moveTo(first.x, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.closePath();
  }
}

/**
 * Clip `ctx` to the mask region. Returns whether a clip was actually applied so
 * a caller can skip its own save/restore when nothing happened.
 *
 * CONTRACT: clipping cannot be undone without the canvas save stack, so the
 * caller MUST `ctx.save()` before and `ctx.restore()` after the masked draw.
 * When `hasRegion` is false this is a no-op and returns false — no path is begun
 * and no state is touched, preserving the "off is nothing" guarantee.
 */
export function applyMaskClip(
  ctx: CanvasRenderingContext2D,
  mask: MaskState,
): boolean {
  if (!hasRegion(mask)) return false;
  ctx.beginPath();
  traceMask(ctx, mask);
  ctx.clip();
  return true;
}

// --- overlay -------------------------------------------------------------

export interface MaskOverlayConfig {
  /** Transparent canvas stacked over the output, sized in CSS px by the caller. */
  canvas: HTMLCanvasElement;
  tool?: MaskTool;
  /** Fired with the committed state whenever shapes change or a stroke closes. */
  onChange?: (mask: MaskState) => void;
  /** Upper bound on devicePixelRatio backing, matching the renderer. */
  maxDpr?: number;
}

/** Distance in CSS px within which a polygon click snaps shut onto its start. */
const POLYGON_CLOSE_RADIUS = 12;
/** Minimum travel between freehand samples — dedupes jittery pointermove spam. */
const FREEHAND_MIN_STEP = 2;

/**
 * Drives a transparent overlay canvas: captures freehand or polygon input, keeps
 * a live preview (region clear, everything outside dimmed), and emits the
 * committed `MaskState`. The overlay is inert while disabled — it ignores pointer
 * input and clears itself, so toggling the mask off leaves nothing on screen and
 * nothing listening.
 *
 * Geometry is stored in CSS pixels to match the renderer's CSS-px drawing space
 * (the renderer pre-scales its context by DPR), so the emitted clip path lines up
 * with the glyphs 1:1 without any per-consumer rescaling.
 */
export class MaskOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly maxDpr: number;
  private readonly onChange?: (mask: MaskState) => void;

  private tool: MaskTool;
  private enabled = false;

  private shapes: MaskShape[] = [];
  /** In-progress freehand stroke or polygon vertices; null when idle. */
  private draft: Point[] | null = null;
  private drawingFreehand = false;

  private cssW = 0;
  private cssH = 0;

  private readonly onPointerDown = (e: PointerEvent) => this.pointerDown(e);
  private readonly onPointerMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onPointerUp = (e: PointerEvent) => this.pointerUp(e);

  constructor(config: MaskOverlayConfig) {
    this.canvas = config.canvas;
    this.maxDpr = config.maxDpr ?? 2;
    this.onChange = config.onChange;
    this.tool = config.tool ?? 'freehand';

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('mask: 2D context unavailable for overlay canvas');
    this.ctx = ctx;

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.syncInteractivity();
  }

  /** Snapshot of the current committed mask. */
  get state(): MaskState {
    return { enabled: this.enabled, shapes: this.shapes.map((s) => ({ points: [...s.points] })) };
  }

  setTool(tool: MaskTool): void {
    if (tool === this.tool) return;
    this.tool = tool;
    this.cancelDraft();
  }

  /**
   * Turn the mask on or off. Off cancels any in-progress draw, clears the preview
   * and stops intercepting pointer input, but keeps committed shapes so toggling
   * back on restores them.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelDraft();
    this.syncInteractivity();
    this.paint();
    this.emit();
  }

  /** Match the backing store to a CSS size; call on container resize. */
  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(this.maxDpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paint();
  }

  /** Drop all shapes and any in-progress draw. */
  clear(): void {
    this.shapes = [];
    this.draft = null;
    this.drawingFreehand = false;
    this.paint();
    this.emit();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
  }

  // --- input ---------------------------------------------------------------

  private pointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    const p = this.toCanvas(e);
    if (this.tool === 'freehand') {
      this.drawingFreehand = true;
      this.draft = [p];
      this.canvas.setPointerCapture?.(e.pointerId);
    } else {
      this.polygonClick(p);
    }
    this.paint();
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.enabled) return;
    const p = this.toCanvas(e);
    if (this.tool === 'freehand') {
      if (!this.drawingFreehand || !this.draft) return;
      const last = this.draft[this.draft.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < FREEHAND_MIN_STEP) return;
      this.draft.push(p);
      this.paint();
    } else if (this.draft) {
      // Live rubber-band segment from the last placed vertex to the cursor.
      this.paint(p);
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.enabled) return;
    if (this.tool === 'freehand' && this.drawingFreehand) {
      this.drawingFreehand = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      this.commitDraft();
    }
  }

  private polygonClick(p: Point): void {
    if (!this.draft) {
      this.draft = [p];
      return;
    }
    const start = this.draft[0];
    if (this.draft.length >= 3 && Math.hypot(p.x - start.x, p.y - start.y) <= POLYGON_CLOSE_RADIUS) {
      this.commitDraft();
      return;
    }
    this.draft.push(p);
  }

  private commitDraft(): void {
    const draft = this.draft;
    this.draft = null;
    if (draft && draft.length >= 3) {
      this.shapes.push({ points: draft });
      this.emit();
    }
    this.paint();
  }

  private cancelDraft(): void {
    this.draft = null;
    this.drawingFreehand = false;
    this.paint();
  }

  // --- rendering -----------------------------------------------------------

  /** Map a pointer event to CSS-px canvas coordinates. */
  private toCanvas(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** `cursor` draws the polygon rubber-band tail when placing vertices. */
  private paint(cursor?: Point): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.enabled || this.cssW === 0 || this.cssH === 0) return;

    const regions = this.previewShapes(cursor);
    const hasArea = regions.some((s) => s.points.length >= 3);

    // Dim everything, then cut the region back out so inside reads as "kept".
    if (hasArea) {
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      for (const s of regions) {
        if (s.points.length < 3) continue;
        const [first, ...rest] = s.points;
        ctx.moveTo(first.x, first.y);
        for (const q of rest) ctx.lineTo(q.x, q.y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.restore();
    }

    // Outline every region and the open draft so the boundary stays visible.
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    for (const s of regions) {
      if (s.points.length < 2) continue;
      const [first, ...rest] = s.points;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (const q of rest) ctx.lineTo(q.x, q.y);
      if (s.points.length >= 3) ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Committed shapes plus the live draft (with the cursor tail appended). */
  private previewShapes(cursor?: Point): MaskShape[] {
    const out: MaskShape[] = this.shapes.map((s) => ({ points: s.points }));
    if (this.draft) {
      const points = cursor && !this.drawingFreehand ? [...this.draft, cursor] : this.draft;
      out.push({ points });
    }
    return out;
  }

  private syncInteractivity(): void {
    this.canvas.style.pointerEvents = this.enabled ? 'auto' : 'none';
    this.canvas.style.touchAction = this.enabled ? 'none' : '';
  }

  private emit(): void {
    this.onChange?.(this.state);
  }
}
