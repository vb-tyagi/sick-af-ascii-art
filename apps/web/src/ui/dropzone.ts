/**
 * Drop zone + loading indicator — W7.T28.
 *
 * Both are preview-area overlays (TEARDOWN §1: #drop-zone and
 * #loading-indicator live inside #preview-area), so they ship together.
 *
 * The drop zone is the empty state shown before any source is loaded. The
 * ACTUAL drag/drop/paste decoding is owned by {@link SourceLoader} (W1.T3) —
 * this module never reads files. It only: (1) offers a click-to-browse
 * affordance that the app forwards to the file picker, and (2) mirrors the
 * native drag state as a CSS class for visual feedback. Reimplementing the
 * loader here would fork the one code path W1.T3 deliberately unified.
 *
 * The loading indicator is a spinner shown over the preview while a source
 * decodes, hidden on the loader's `load` / `error`.
 */

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

export interface DropZoneConfig {
  /** Fired on click / Enter — the app forwards this to the file picker. */
  onBrowse(): void;
  /** Optional demo gallery (CC0 images); rendered as a thumbnail strip. */
  demos?: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  /** Fired when a demo thumbnail is picked; the app loads that URL. */
  onPickDemo?(url: string): void;
}

export interface DropZone {
  readonly element: HTMLElement;
  show(): void;
  hide(): void;
  destroy(): void;
}

class DropZoneController implements DropZone {
  readonly element: HTMLElement;
  private readonly boundEnter = (e: DragEvent) => this.setDragging(e, true);
  private readonly boundLeave = () => this.element.classList.remove('is-dragging');
  private readonly boundDrop = () => this.element.classList.remove('is-dragging');

  constructor(config: DropZoneConfig) {
    this.element = el('div', 'saa-dropzone');
    this.element.setAttribute('role', 'button');
    this.element.tabIndex = 0;
    this.element.setAttribute('aria-label', 'Drop an image or video, or click to browse');

    const inner = el('div', 'saa-dz-inner');
    inner.append(el('div', 'saa-dz-mark', '⬗'));
    inner.append(el('div', 'saa-dz-title', 'Drop an image or video'));
    const hint = el('div', 'saa-dz-hint');
    hint.append(
      document.createTextNode('click to '),
      el('span', 'saa-dz-accent', 'browse'),
      document.createTextNode(' · or paste from clipboard'),
    );
    inner.append(hint);

    // Optional demo strip (CC0 gallery) — a fast way to see the engine work.
    if (config.demos?.length && config.onPickDemo) {
      const onPick = config.onPickDemo;
      const demos = el('div', 'saa-dz-demos');
      demos.append(el('div', 'saa-dz-demos-label', 'or try a demo'));
      const grid = el('div', 'saa-dz-demos-grid');
      for (const d of config.demos) {
        const b = el('button', 'saa-dz-demo');
        b.type = 'button';
        b.title = d.label;
        const img = el('img', 'saa-dz-demo-img');
        img.src = d.url;
        img.alt = d.label;
        img.loading = 'lazy';
        img.decoding = 'async';
        b.append(img, el('span', 'saa-dz-demo-cap', d.label));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          onPick(d.url);
        });
        grid.append(b);
      }
      demos.append(grid);
      inner.append(demos);
    }

    this.element.append(inner);

    this.element.addEventListener('click', config.onBrowse);
    this.element.addEventListener('keydown', (e: KeyboardEvent) => {
      // Only the drop zone itself opens the picker. Without this guard, Enter
      // on a focused demo thumbnail bubbles up here and the preventDefault()
      // below suppresses that button's own activation — leaving the gallery
      // unreachable by keyboard.
      if (e.target !== this.element) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        config.onBrowse();
      }
    });

    // Purely visual: highlight while a file is dragged over. The decode is
    // SourceLoader's job — dragover/drop still bubble to its dropTarget.
    this.element.addEventListener('dragenter', this.boundEnter);
    this.element.addEventListener('dragover', this.boundEnter);
    this.element.addEventListener('dragleave', this.boundLeave);
    this.element.addEventListener('drop', this.boundDrop);
  }

  private setDragging(e: DragEvent, on: boolean): void {
    e.preventDefault();
    this.element.classList.toggle('is-dragging', on);
  }

  show(): void {
    this.element.classList.remove('is-hidden');
  }

  hide(): void {
    this.element.classList.add('is-hidden');
  }

  destroy(): void {
    this.element.remove();
  }
}

/** Build the drop zone and mount it under `container` (the preview area). */
export function createDropZone(container: HTMLElement, config: DropZoneConfig): DropZone {
  const zone = new DropZoneController(config);
  container.appendChild(zone.element);
  return zone;
}

export interface LoadingIndicator {
  readonly element: HTMLElement;
  show(label?: string): void;
  hide(): void;
  destroy(): void;
}

class LoadingIndicatorController implements LoadingIndicator {
  readonly element: HTMLElement;
  private readonly label: HTMLElement;

  constructor() {
    this.element = el('div', 'saa-loading is-hidden');
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    const spinner = el('div', 'saa-loading-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    this.label = el('div', 'saa-loading-label', 'Decoding…');
    this.element.append(spinner, this.label);
  }

  show(label = 'Decoding…'): void {
    this.label.textContent = label;
    this.element.classList.remove('is-hidden');
  }

  hide(): void {
    this.element.classList.add('is-hidden');
  }

  destroy(): void {
    this.element.remove();
  }
}

/** Build the loading spinner and mount it under `container` (the preview area). */
export function createLoadingIndicator(container: HTMLElement): LoadingIndicator {
  const indicator = new LoadingIndicatorController();
  container.appendChild(indicator.element);
  return indicator;
}
