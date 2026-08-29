/**
 * Top bar — W7.T28.
 *
 * OUR wordmark plus the four global actions (TEARDOWN §1 DOM skeleton:
 * Upload · Crop · Export · menu). The reference dictates WHICH actions exist,
 * nothing about the mark, wording, grouping, or look — those are ours.
 *
 * The bar owns no state beyond enablement: Crop and Export are meaningless
 * until a source is loaded, so they start disabled and the app flips them on
 * via {@link Topbar.setSourceLoaded}. Every click is forwarded to the caller —
 * this module never opens a modal or touches a file input itself.
 */

export interface TopbarActions {
  /** Upload button — the app wires this to the file picker / source loader. */
  onUpload(): void;
  /** Crop button — opens the crop modal. Disabled until a source is loaded. */
  onCrop(): void;
  /** Export button — opens the export modal. Disabled until a source is loaded. */
  onExport(): void;
  /** Overflow menu (about / feedback / presets). */
  onMenu(): void;
}

export interface Topbar {
  readonly element: HTMLElement;
  /** Enable/disable the source-dependent actions (Crop, Export). */
  setSourceLoaded(loaded: boolean): void;
  destroy(): void;
}

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

function button(
  className: string,
  label: string,
  onClick: () => void,
  glyph?: string,
): HTMLButtonElement {
  const btn = el('button', className);
  btn.type = 'button';
  if (glyph) btn.append(el('span', 'saa-tb-glyph', glyph));
  btn.append(el('span', 'saa-tb-btn-label', label));
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', onClick);
  return btn;
}

class TopbarController implements Topbar {
  readonly element: HTMLElement;
  private readonly sourceButtons: HTMLButtonElement[] = [];

  constructor(actions: TopbarActions) {
    this.element = el('header', 'saa-topbar');
    this.element.setAttribute('role', 'banner');

    // --- left: wordmark (ours) ---
    const left = el('div', 'saa-tb-left');
    const mark = el('span', 'saa-tb-mark');
    // A tiny 2x2 half-block mark — the character grid the app is built on.
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '▛▜';
    const word = el('span', 'saa-tb-word');
    word.append(
      el('span', 'saa-tb-word-name', 'SICK AF ASCII ART'),
      el('span', 'saa-tb-cursor', '_'),
    );
    left.append(mark, word);

    // --- center: primary source actions ---
    const center = el('div', 'saa-tb-center');
    const upload = button('saa-tb-btn saa-tb-primary', 'Upload', actions.onUpload, '↑');
    const crop = button('saa-tb-btn', 'Crop', actions.onCrop, '⌗');
    this.sourceButtons.push(crop);
    center.append(upload, crop);

    // --- right: export + overflow ---
    const right = el('div', 'saa-tb-right');
    const exportBtn = button('saa-tb-btn', 'Export', actions.onExport, '⇓');
    this.sourceButtons.push(exportBtn);
    const menu = el('button', 'saa-tb-btn saa-tb-icon');
    menu.type = 'button';
    menu.setAttribute('aria-label', 'Menu');
    menu.append(el('span', 'saa-tb-glyph', '⋯'));
    menu.addEventListener('click', actions.onMenu);
    right.append(exportBtn, menu);

    this.element.append(left, center, right);
    this.setSourceLoaded(false);
  }

  setSourceLoaded(loaded: boolean): void {
    for (const btn of this.sourceButtons) {
      btn.disabled = !loaded;
      btn.setAttribute('aria-disabled', String(!loaded));
    }
  }

  destroy(): void {
    this.element.remove();
  }
}

/** Build the top bar and mount it under `container`. */
export function createTopbar(container: HTMLElement, actions: TopbarActions): Topbar {
  const bar = new TopbarController(actions);
  container.appendChild(bar.element);
  return bar;
}
