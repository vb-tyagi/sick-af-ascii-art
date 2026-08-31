/**
 * Export popover — format, scale, and the resulting pixel size.
 *
 * Owns no rendering and no encoding: it collects a choice and hands it back.
 * The size readout is recomputed from a live `baseSize()` on every open and on
 * every scale change, because the 1x baseline is the canvas — which changes
 * with the window, the source's aspect ratio and any crop.
 */

import {
  EXPORT_SCALES,
  DEFAULT_EXPORT_SCALE,
  exportDimensions,
  type ExportFormat,
  type ExportScale,
} from '../io/export-image';

/** Still formats plus the animated ones. */
export type AnyExportFormat = ExportFormat | 'gif' | 'mp4';

/** Animated captures are real-time, so keep them short by default. */
export const ANIM_FRAMES = 48;
export const ANIM_FPS = 16;

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

export interface ExportPopoverConfig {
  /** The 1x output size, read fresh on each open. */
  baseSize(): { width: number; height: number };
  onExport(format: AnyExportFormat, scale: ExportScale): void | Promise<void>;
  /** Cancel a running animated export. */
  onCancel?(): void;
  /**
   * Why an animated format is unavailable or degraded, e.g. no WebCodecs. Shown
   * verbatim; returning null means "fully supported".
   */
  formatNote?(format: AnyExportFormat): string | null;
}

export interface ExportPopover {
  readonly element: HTMLElement;
  toggle(anchor?: HTMLElement | null): void;
  close(): void;
  /** Show progress for a running export; null returns the popover to idle. */
  setProgress(text: string | null): void;
  destroy(): void;
}

class ExportPopoverController implements ExportPopover {
  readonly element: HTMLElement;

  private readonly config: ExportPopoverConfig;
  private readonly dims: HTMLElement;
  private readonly note: HTMLElement;
  private readonly go: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly formatBtns: HTMLButtonElement[] = [];
  private readonly scaleBtns: HTMLButtonElement[] = [];

  private format: AnyExportFormat = 'png';
  private scale: ExportScale = DEFAULT_EXPORT_SCALE;
  private open = false;

  private readonly onDocPointerDown = (e: MouseEvent) => {
    if (!this.open) return;
    if (this.element.contains(e.target as Node)) return;
    this.close();
  };
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (this.open && e.key === 'Escape') this.close();
  };

  constructor(config: ExportPopoverConfig) {
    this.config = config;

    this.element = el('div', 'saa-export-pop is-hidden');
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Export options');

    this.element.appendChild(el('div', 'saa-export-title', 'Export'));

    // --- format ---
    this.element.appendChild(el('div', 'saa-export-label', 'Format'));
    const formats = el('div', 'saa-export-pills');
    for (const f of ['png', 'jpg', 'gif', 'mp4'] as const) {
      const b = el('button', 'saa-export-pill');
      b.type = 'button';
      b.textContent = f.toUpperCase();
      b.dataset.value = f;
      b.addEventListener('click', () => {
        this.format = f;
        this.syncActive();
        this.syncDims();
      });
      this.formatBtns.push(b);
      formats.appendChild(b);
    }
    this.element.appendChild(formats);

    // --- scale ---
    this.element.appendChild(el('div', 'saa-export-label', 'Resolution'));
    const scales = el('div', 'saa-export-pills');
    for (const s of EXPORT_SCALES) {
      const b = el('button', 'saa-export-pill');
      b.type = 'button';
      b.textContent = `${s}×`;
      b.dataset.value = String(s);
      b.addEventListener('click', () => {
        this.scale = s;
        this.syncActive();
        this.syncDims();
      });
      this.scaleBtns.push(b);
      scales.appendChild(b);
    }
    this.element.appendChild(scales);

    this.dims = el('div', 'saa-export-dims');
    this.element.appendChild(this.dims);

    this.note = el('div', 'saa-export-note');
    this.element.appendChild(this.note);

    this.go = el('button', 'saa-export-go');
    this.go.type = 'button';
    this.go.textContent = 'Export';
    this.go.addEventListener('click', () => {
      const animated = this.format === 'gif' || this.format === 'mp4';
      // Animated captures run for seconds and report progress in place, so the
      // popover stays open; stills finish immediately and it can close.
      if (!animated) this.close();
      void this.config.onExport(this.format, this.scale);
    });
    this.element.appendChild(this.go);

    this.cancel = el('button', 'saa-export-cancel is-hidden');
    this.cancel.type = 'button';
    this.cancel.textContent = 'Cancel';
    this.cancel.addEventListener('click', () => this.config.onCancel?.());
    this.element.appendChild(this.cancel);

    this.syncActive();
    document.addEventListener('pointerdown', this.onDocPointerDown);
    document.addEventListener('keydown', this.onKeyDown);
  }

  private syncActive(): void {
    for (const b of this.formatBtns) {
      b.classList.toggle('is-active', b.dataset.value === this.format);
    }
    for (const b of this.scaleBtns) {
      b.classList.toggle('is-active', b.dataset.value === String(this.scale));
    }
  }

  private syncDims(): void {
    const base = this.config.baseSize();
    const out = exportDimensions(base.width, base.height, this.scale);
    const animated = this.format === 'gif' || this.format === 'mp4';
    const seconds = (ANIM_FRAMES / ANIM_FPS).toFixed(1);
    this.dims.textContent = animated
      ? `${out.width} × ${out.height} px · ${seconds}s @ ${ANIM_FPS}fps`
      : `${out.width} × ${out.height} px`;

    const note = this.config.formatNote?.(this.format) ?? null;
    this.note.textContent = note ?? '';
    this.note.classList.toggle('is-hidden', !note);
  }

  setProgress(text: string | null): void {
    const busy = text !== null;
    this.go.disabled = busy;
    this.go.textContent = busy ? text : 'Export';
    this.cancel.classList.toggle('is-hidden', !busy);
    for (const b of [...this.formatBtns, ...this.scaleBtns]) b.disabled = busy;
    if (!busy) this.close();
  }

  toggle(anchor?: HTMLElement | null): void {
    if (this.open) {
      this.close();
      return;
    }
    this.syncDims();
    this.element.classList.remove('is-hidden');
    this.open = true;

    // Anchored under the button that opened it, clamped into the viewport.
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const w = this.element.offsetWidth || 210;
      this.element.style.top = `${Math.round(r.bottom + 8)}px`;
      this.element.style.left = `${Math.round(Math.min(r.right - w, window.innerWidth - w - 12))}px`;
    }
  }

  close(): void {
    this.element.classList.add('is-hidden');
    this.open = false;
  }

  destroy(): void {
    document.removeEventListener('pointerdown', this.onDocPointerDown);
    document.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }
}

export function createExportPopover(
  config: ExportPopoverConfig,
  container: HTMLElement = document.body,
): ExportPopover {
  const pop = new ExportPopoverController(config);
  container.appendChild(pop.element);
  return pop;
}
