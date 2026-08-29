/**
 * Toasts — W7.T28.
 *
 * Transient corner messages (TEARDOWN §1: #toast-container). One container
 * stacks any number of toasts; each auto-dismisses after a timeout and can be
 * dismissed early by click. The app's natural caller is SourceLoader's `error`
 * event — a failed decode becomes a toast — but nothing here is coupled to it.
 *
 * Timers are tracked so {@link Toaster.destroy} can clear them; leaving a
 * pending setTimeout that touches a removed node would throw on late fire.
 */

export type ToastKind = 'info' | 'success' | 'error';

const DEFAULT_DURATION_MS = 4000;

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

export interface Toaster {
  readonly element: HTMLElement;
  /** Show a toast. `durationMs <= 0` keeps it up until clicked. */
  show(message: string, kind?: ToastKind, durationMs?: number): void;
  info(message: string, durationMs?: number): void;
  success(message: string, durationMs?: number): void;
  error(message: string, durationMs?: number): void;
  destroy(): void;
}

const GLYPH: Record<ToastKind, string> = {
  info: 'ℹ',
  success: '✓',
  error: '✕',
};

class ToasterController implements Toaster {
  readonly element: HTMLElement;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.element = el('div', 'saa-toasts');
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', 'Notifications');
    this.element.setAttribute('aria-live', 'polite');
  }

  show(message: string, kind: ToastKind = 'info', durationMs = DEFAULT_DURATION_MS): void {
    const toast = el('div', `saa-toast saa-toast-${kind}`);
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.append(el('span', 'saa-toast-glyph', GLYPH[kind]));
    toast.append(el('span', 'saa-toast-msg', message));
    this.element.appendChild(toast);

    const dismiss = () => this.dismiss(toast, timer);
    toast.addEventListener('click', dismiss);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (durationMs > 0) {
      timer = setTimeout(dismiss, durationMs);
      this.timers.add(timer);
    }
  }

  info(message: string, durationMs?: number): void {
    this.show(message, 'info', durationMs);
  }

  success(message: string, durationMs?: number): void {
    this.show(message, 'success', durationMs);
  }

  error(message: string, durationMs?: number): void {
    this.show(message, 'error', durationMs);
  }

  private dismiss(toast: HTMLElement, timer?: ReturnType<typeof setTimeout>): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
    if (!toast.isConnected) return;
    // Let the leave transition play, then remove the node.
    toast.classList.add('is-leaving');
    const remove = setTimeout(() => {
      this.timers.delete(remove);
      toast.remove();
    }, 200);
    this.timers.add(remove);
  }

  destroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.element.remove();
  }
}

/** Build the toast container and mount it under `container` (defaults to body). */
export function createToaster(container: HTMLElement = document.body): Toaster {
  const toaster = new ToasterController();
  container.appendChild(toaster.element);
  return toaster;
}
