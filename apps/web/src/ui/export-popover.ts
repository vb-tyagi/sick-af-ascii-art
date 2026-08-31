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
  onExport(format: ExportFormat, scale: ExportScale): void | Promise<void>;
}

export interface ExportPopover {
  readonly element: HTMLElement;
  toggle(anchor?: HTMLElement | null): void;
  close(): void;
  destroy(): void;
}

class ExportPopoverController implements ExportPopover {
  readonly element: HTMLElement;

  private readonly config: ExportPopoverConfig;
  private readonly dims: HTMLElement;
  private readonly formatBtns: HTMLButtonElement[] = [];
  private readonly scaleBtns: HTMLButtonElement[] = [];

  private format: ExportFormat = 'png';
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
    for (const f of ['png', 'jpg'] as const) {
      const b = el('button', 'saa-export-pill');
      b.type = 'button';
      b.textContent = f.toUpperCase();
      b.dataset.value = f;
      b.addEventListener('click', () => {
        this.format = f;
        this.syncActive();
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

    const go = el('button', 'saa-export-go');
    go.type = 'button';
    go.textContent = 'Export';
    go.addEventListener('click', () => {
      this.close();
      void this.config.onExport(this.format, this.scale);
    });
    this.element.appendChild(go);

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
    this.dims.textContent = `${out.width} × ${out.height} px`;
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
