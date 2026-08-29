/**
 * Crop & Rotate modal — W7.T29.
 *
 * Emits a {@link SamplerTransform} (source-space crop rect + clockwise quarter
 * turns) — the transform GridSampler.sample() already consumes (W1.T5). The
 * modal invents no parallel path and bakes nothing into the renderer: it hands
 * the transform to the app via `onApply`, and the app feeds it to the sampler.
 *
 * Two load-bearing facts the code cannot show on its own:
 *
 * 1. THE PREVIEW MIRRORS THE SAMPLER. `paint()` replicates sample.ts's exact
 *    translate/rotate/translate + drawImage pipeline (crop = full frame), so the
 *    rotated image the user sees IS what rotate=N produces downstream. Because
 *    of that, a crop rectangle drawn in this DISPLAY space maps to the one
 *    source-space rect whose sampled output equals that rectangle — the whole
 *    reason we can select in the convenient axis-aligned rotated frame and still
 *    return a source-space crop. {@link dispToSrc} inverts only the 90° rotate.
 *
 * 2. CROP IS SOURCE-SPACE, ROTATE IS APPLIED AFTER. Matching the sampler: the
 *    returned `crop` indexes the un-rotated source; `rotate` spins the whole
 *    result. The ratio the user picks is therefore the aspect of the DISPLAYED
 *    (post-rotate) rect, so a 90° turn swaps which source axis it constrains.
 */

import type { SamplerTransform, SourceMedia } from '@sick-af/engine/sample';

type Quarter = 0 | 90 | 270; // internal accumulation folds 180 into two turns
type Rotate = 0 | 90 | 180 | 270;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RatioOption {
  id: string;
  label: string;
  /** width / height in displayed space, or null for free-form. */
  value: number | null;
}

/** TEARDOWN §3.8: free (default), then the fixed ratios in reference order. */
const RATIOS: ReadonlyArray<RatioOption> = [
  { id: 'free', label: 'Free', value: null },
  { id: '1:1', label: '1:1', value: 1 },
  { id: '4:5', label: '4:5', value: 4 / 5 },
  { id: '3:4', label: '3:4', value: 3 / 4 },
  { id: '9:16', label: '9:16', value: 9 / 16 },
  { id: '16:9', label: '16:9', value: 16 / 9 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '3:2', label: '3:2', value: 3 / 2 },
];

const STAGE_MAX_W = 620;
const STAGE_MAX_H = 460;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function sourceSize(src: SourceMedia): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: src.width, h: src.height };
}

/**
 * Display-space normalized point → source-space normalized point, inverting a
 * clockwise rotation by `rotate` (the same convention sample.ts's ctx.rotate
 * uses). Corners of an axis-aligned display rect map to corners of an
 * axis-aligned source rect, so mapping two opposite corners is sufficient.
 */
function dispToSrc(u: number, v: number, rotate: Rotate): { p: number; q: number } {
  switch (rotate) {
    case 90:
      return { p: v, q: 1 - u };
    case 180:
      return { p: 1 - u, q: 1 - v };
    case 270:
      return { p: 1 - v, q: u };
    default:
      return { p: u, q: v };
  }
}

/** Source-space normalized point → display-space normalized point (forward). */
function srcToDisp(p: number, q: number, rotate: Rotate): { u: number; v: number } {
  switch (rotate) {
    case 90:
      return { u: 1 - q, v: p };
    case 180:
      return { u: 1 - p, v: 1 - q };
    case 270:
      return { u: q, v: 1 - p };
    default:
      return { u: p, v: q };
  }
}

export interface CropModalConfig {
  /** Fired on Apply with the transform to hand straight to GridSampler.sample. */
  onApply(transform: SamplerTransform): void;
  /** Fired on Cancel / Escape / backdrop click. */
  onCancel?(): void;
}

export interface CropModal {
  readonly element: HTMLElement;
  /** Open over `source`, optionally seeded from an existing transform. */
  open(source: SourceMedia, initial?: SamplerTransform): void;
  close(): void;
  destroy(): void;
}

class CropModalController implements CropModal {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dimsReadout: HTMLElement;
  private readonly rotReadout: HTMLElement;
  private readonly ratioButtons: HTMLButtonElement[] = [];

  private source: SourceMedia | null = null;
  private sw = 0;
  private sh = 0;
  private rotate: Rotate = 0;
  private ratioIndex = 0;
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  // css-pixel geometry of the current stage, recomputed on open/rotate
  private scale = 1;
  private cssW = 0;
  private cssH = 0;

  // active drag, in display-pixel space
  private drag: { pointerId: number; offX: number; offY: number } | null = null;

  private readonly onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    }
  };

  constructor(private readonly config: CropModalConfig) {
    this.element = el('div', 'saa-crop-overlay is-hidden');
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Crop and rotate');

    const panel = el('div', 'saa-crop-panel');

    const header = el('div', 'saa-crop-header');
    header.append(el('h2', 'saa-crop-title', 'Crop & Rotate'));
    const closeBtn = el('button', 'saa-crop-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => this.cancel());
    header.append(closeBtn);

    const stage = el('div', 'saa-crop-stage');
    this.canvas = el('canvas', 'saa-crop-canvas');
    this.canvas.setAttribute('aria-label', 'Crop preview — drag to reposition');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for crop preview');
    this.ctx = ctx;
    stage.append(this.canvas);

    const controls = el('div', 'saa-crop-controls');

    const ratioRow = el('div', 'saa-crop-ratios');
    ratioRow.setAttribute('role', 'radiogroup');
    ratioRow.setAttribute('aria-label', 'Aspect ratio');
    RATIOS.forEach((ratio, i) => {
      const pill = el('button', 'saa-crop-pill', ratio.label);
      pill.type = 'button';
      pill.setAttribute('role', 'radio');
      pill.addEventListener('click', () => this.selectRatio(i));
      this.ratioButtons.push(pill);
      ratioRow.append(pill);
    });

    const rotRow = el('div', 'saa-crop-rotate');
    const ccw = el('button', 'saa-crop-rot', '⟲');
    ccw.type = 'button';
    ccw.setAttribute('aria-label', 'Rotate counter-clockwise');
    ccw.addEventListener('click', () => this.rotateBy(270));
    const cw = el('button', 'saa-crop-rot', '⟳');
    cw.type = 'button';
    cw.setAttribute('aria-label', 'Rotate clockwise');
    cw.addEventListener('click', () => this.rotateBy(90));
    this.rotReadout = el('span', 'saa-crop-rotval', '0°');
    this.dimsReadout = el('span', 'saa-crop-dims', '');
    rotRow.append(ccw, cw, this.rotReadout, this.dimsReadout);

    controls.append(ratioRow, rotRow);

    const footer = el('div', 'saa-crop-footer');
    const cancel = el('button', 'saa-crop-btn saa-crop-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.cancel());
    const apply = el('button', 'saa-crop-btn saa-crop-apply', 'Apply');
    apply.type = 'button';
    apply.addEventListener('click', () => this.apply());
    footer.append(cancel, apply);

    panel.append(header, stage, controls, footer);
    this.element.append(panel);

    // Backdrop click (outside the panel) cancels; clicks on the panel don't.
    this.element.addEventListener('pointerdown', (e) => {
      if (e.target === this.element) this.cancel();
    });

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
  }

  // --- displayed (post-rotate) frame dimensions in source pixels ---
  private get swap(): boolean {
    return this.rotate === 90 || this.rotate === 270;
  }
  private get dispW(): number {
    return this.swap ? this.sh : this.sw;
  }
  private get dispH(): number {
    return this.swap ? this.sw : this.sh;
  }

  open(source: SourceMedia, initial?: SamplerTransform): void {
    const size = sourceSize(source);
    if (size.w === 0 || size.h === 0) return;

    this.source = source;
    this.sw = size.w;
    this.sh = size.h;
    this.rotate = initial?.rotate ?? 0;
    this.ratioIndex = 0;

    this.layoutStage();

    if (initial?.crop) {
      this.rect = this.srcCropToRect(initial.crop);
    } else {
      this.rect = this.fitRatio(RATIOS[this.ratioIndex]!.value);
    }

    this.syncRatioButtons();
    this.element.classList.remove('is-hidden');
    document.addEventListener('keydown', this.onKeydown);
    this.render();
  }

  close(): void {
    this.element.classList.add('is-hidden');
    this.drag = null;
    document.removeEventListener('keydown', this.onKeydown);
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeydown);
    this.element.remove();
  }

  // --- geometry ------------------------------------------------------------

  private layoutStage(): void {
    this.scale = Math.min(STAGE_MAX_W / this.dispW, STAGE_MAX_H / this.dispH);
    this.cssW = this.dispW * this.scale;
    this.cssH = this.dispH * this.scale;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
  }

  /** Largest rect of the given ratio, centred in the displayed frame. */
  private fitRatio(ratio: number | null): Rect {
    const { dispW, dispH } = this;
    if (ratio === null) return { x: 0, y: 0, w: dispW, h: dispH };
    let w = dispW;
    let h = w / ratio;
    if (h > dispH) {
      h = dispH;
      w = h * ratio;
    }
    return { x: (dispW - w) / 2, y: (dispH - h) / 2, w, h };
  }

  private srcCropToRect(crop: NonNullable<SamplerTransform['crop']>): Rect {
    const c0 = srcToDisp(crop.x / this.sw, crop.y / this.sh, this.rotate);
    const c1 = srcToDisp((crop.x + crop.w) / this.sw, (crop.y + crop.h) / this.sh, this.rotate);
    const x0 = Math.min(c0.u, c1.u) * this.dispW;
    const y0 = Math.min(c0.v, c1.v) * this.dispH;
    return {
      x: x0,
      y: y0,
      w: Math.abs(c1.u - c0.u) * this.dispW,
      h: Math.abs(c1.v - c0.v) * this.dispH,
    };
  }

  private rectToSrcCrop(): NonNullable<SamplerTransform['crop']> {
    const { rect, dispW, dispH, sw, sh, rotate } = this;
    const a = dispToSrc(rect.x / dispW, rect.y / dispH, rotate);
    const b = dispToSrc((rect.x + rect.w) / dispW, (rect.y + rect.h) / dispH, rotate);
    const x0 = Math.min(a.p, b.p) * sw;
    const y0 = Math.min(a.q, b.q) * sh;
    return {
      x: x0,
      y: y0,
      w: Math.abs(b.p - a.p) * sw,
      h: Math.abs(b.q - a.q) * sh,
    };
  }

  // --- interaction ---------------------------------------------------------

  private selectRatio(index: number): void {
    this.ratioIndex = index;
    this.rect = this.fitRatio(RATIOS[index]!.value);
    this.syncRatioButtons();
    this.render();
  }

  private syncRatioButtons(): void {
    this.ratioButtons.forEach((btn, i) => {
      const on = i === this.ratioIndex;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', String(on));
    });
  }

  private rotateBy(delta: Quarter): void {
    this.rotate = (((this.rotate + delta) % 360) as Rotate);
    this.layoutStage();
    // The displayed frame swapped axes; re-fit the current ratio to it.
    this.rect = this.fitRatio(RATIOS[this.ratioIndex]!.value);
    this.render();
  }

  private eventToDisplay(e: PointerEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - bounds.left) / this.scale,
      y: (e.clientY - bounds.top) / this.scale,
    };
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    const p = this.eventToDisplay(e);
    const { rect } = this;
    if (p.x < rect.x || p.x > rect.x + rect.w || p.y < rect.y || p.y > rect.y + rect.h) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { pointerId: e.pointerId, offX: p.x - rect.x, offY: p.y - rect.y };
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    const p = this.eventToDisplay(e);
    const maxX = this.dispW - this.rect.w;
    const maxY = this.dispH - this.rect.h;
    this.rect.x = Math.max(0, Math.min(maxX, p.x - this.drag.offX));
    this.rect.y = Math.max(0, Math.min(maxY, p.y - this.drag.offY));
    this.render();
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
  };

  private cancel(): void {
    this.close();
    this.config.onCancel?.();
  }

  private apply(): void {
    const full = this.rect.x === 0 && this.rect.y === 0 && this.rect.w === this.dispW && this.rect.h === this.dispH;
    const transform: SamplerTransform = {};
    if (!full) transform.crop = this.rectToSrcCrop();
    if (this.rotate !== 0) transform.rotate = this.rotate;
    this.close();
    this.config.onApply(transform);
  }

  // --- rendering -----------------------------------------------------------

  /** Full source into the stage, mirroring sample.ts's transform exactly. */
  private paintSource(): void {
    if (!this.source) return;
    const { ctx, cssW, cssH } = this;
    const drawW = this.swap ? cssH : cssW;
    const drawH = this.swap ? cssW : cssH;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(cssW / 2, cssH / 2);
    ctx.rotate((this.rotate * Math.PI) / 180);
    ctx.translate(-drawW / 2, -drawH / 2);
    ctx.drawImage(this.source as CanvasImageSource, 0, 0, this.sw, this.sh, 0, 0, drawW, drawH);
    ctx.restore();
  }

  private render(): void {
    if (!this.source) return;
    const { ctx, cssW, cssH, scale } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    this.paintSource();

    // Dim the whole stage, then re-reveal the crop region at full brightness.
    ctx.fillStyle = 'rgba(8, 10, 14, 0.62)';
    ctx.fillRect(0, 0, cssW, cssH);

    const rx = this.rect.x * scale;
    const ry = this.rect.y * scale;
    const rw = this.rect.w * scale;
    const rh = this.rect.h * scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    this.paintSource();
    ctx.restore();

    // Rule-of-thirds guides + border.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(rx + (rw * i) / 3, ry);
      ctx.lineTo(rx + (rw * i) / 3, ry + rh);
      ctx.moveTo(rx, ry + (rh * i) / 3);
      ctx.lineTo(rx + rw, ry + (rh * i) / 3);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    this.updateReadout();
  }

  private updateReadout(): void {
    const crop = this.rectToSrcCrop();
    this.dimsReadout.textContent = `${Math.round(crop.w)} × ${Math.round(crop.h)} px`;
    this.rotReadout.textContent = `${this.rotate}°`;
  }
}

/** Build the crop modal and mount it under `container` (defaults to body). */
export function createCropModal(
  config: CropModalConfig,
  container: HTMLElement = document.body,
): CropModal {
  const modal = new CropModalController(config);
  container.appendChild(modal.element);
  return modal;
}
