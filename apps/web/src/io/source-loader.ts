/**
 * Source loader — T3.
 *
 * Turns a user-supplied image or video into a decoded, dimension-known
 * element the engine can sample. Three entry paths feed one code path:
 * a file input, drag-and-drop onto the preview area, and clipboard paste.
 */

export type SourceKind = 'image' | 'video';

export interface SourceLoadEvent {
  kind: SourceKind;
  element: HTMLImageElement | HTMLVideoElement;
  width: number;
  height: number;
}

export interface SourceErrorEvent {
  file: File | null;
  message: string;
}

type SourceEventMap = {
  load: SourceLoadEvent;
  error: SourceErrorEvent;
};

type Listener<E> = (event: E) => void;

export interface SourceLoaderOptions {
  /**
   * Element that accepts drag-and-drop. Typically the preview area.
   * Drop handling stays off until this is provided.
   */
  dropTarget?: HTMLElement;
  /** Listen for document-level clipboard paste. Defaults to true. */
  listenForPaste?: boolean;
}

export class SourceLoader {
  private readonly listeners: {
    [K in keyof SourceEventMap]: Set<Listener<SourceEventMap[K]>>;
  } = { load: new Set(), error: new Set() };

  // Held so the previous source's blob URL can be revoked on replace;
  // leaving it live leaks the decoded asset for the tab's lifetime.
  private currentUrl: string | null = null;
  private dropTarget: HTMLElement | null = null;
  private readonly boundDrop = (e: DragEvent) => this.onDrop(e);
  private readonly boundDragOver = (e: DragEvent) => e.preventDefault();
  private readonly boundPaste = (e: ClipboardEvent) => this.onPaste(e);
  private pasteBound = false;

  constructor(opts: SourceLoaderOptions = {}) {
    if (opts.dropTarget) this.attachDropTarget(opts.dropTarget);
    if (opts.listenForPaste !== false) this.attachPaste();
  }

  on<K extends keyof SourceEventMap>(
    type: K,
    listener: Listener<SourceEventMap[K]>,
  ): void {
    this.listeners[type].add(listener);
  }

  off<K extends keyof SourceEventMap>(
    type: K,
    listener: Listener<SourceEventMap[K]>,
  ): void {
    this.listeners[type].delete(listener);
  }

  /** Wire a file `<input type="file">`'s change event to the loader. */
  bindFileInput(input: HTMLInputElement): void {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.loadFile(file);
    });
  }

  attachDropTarget(target: HTMLElement): void {
    this.detachDropTarget();
    this.dropTarget = target;
    target.addEventListener('dragover', this.boundDragOver);
    target.addEventListener('drop', this.boundDrop);
  }

  detachDropTarget(): void {
    if (!this.dropTarget) return;
    this.dropTarget.removeEventListener('dragover', this.boundDragOver);
    this.dropTarget.removeEventListener('drop', this.boundDrop);
    this.dropTarget = null;
  }

  private attachPaste(): void {
    if (this.pasteBound) return;
    document.addEventListener('paste', this.boundPaste);
    this.pasteBound = true;
  }

  /** Decode a File and emit 'load' on success, 'error' on rejection. */
  async loadFile(file: File): Promise<void> {
    if (file.type.startsWith('image/')) {
      await this.loadImage(file);
    } else if (file.type.startsWith('video/')) {
      await this.loadVideo(file);
    } else {
      this.emitError(
        file,
        `Unsupported file type "${file.type || 'unknown'}". Drop an image or video.`,
      );
    }
  }

  private async loadImage(file: File): Promise<void> {
    const url = this.swapUrl(file);
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
      });
    } catch {
      this.emitError(file, `Could not decode image "${file.name}".`);
      return;
    }
    this.emit('load', {
      kind: 'image',
      element: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  }

  private async loadVideo(file: File): Promise<void> {
    const url = this.swapUrl(file);
    const video = document.createElement('video');
    // muted is REQUIRED — browsers block autoplay of sound-bearing video.
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('decode failed'));
        video.src = url;
      });
    } catch {
      this.emitError(file, `Could not decode video "${file.name}".`);
      return;
    }
    // Autoplay can still be rejected; the engine drives frames either way.
    void video.play().catch(() => {});
    this.emit('load', {
      kind: 'video',
      element: video,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void this.loadFile(file);
  }

  private onPaste(e: ClipboardEvent): void {
    const file = e.clipboardData?.files?.[0];
    if (file) void this.loadFile(file);
  }

  private swapUrl(file: File): string {
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = URL.createObjectURL(file);
    return this.currentUrl;
  }

  private emit<K extends keyof SourceEventMap>(
    type: K,
    event: SourceEventMap[K],
  ): void {
    for (const listener of this.listeners[type]) listener(event);
  }

  private emitError(file: File | null, message: string): void {
    this.emit('error', { file, message });
  }

  /** Release listeners and the live object URL. */
  dispose(): void {
    this.detachDropTarget();
    if (this.pasteBound) {
      document.removeEventListener('paste', this.boundPaste);
      this.pasteBound = false;
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.listeners.load.clear();
    this.listeners.error.clear();
  }
}
