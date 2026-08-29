/**
 * Animated GIF export — T33.
 *
 * The reference's JSON-LD advertises GIF export but its shipped UI only offers
 * PNG/JPG (TEARDOWN §7 item 4); this is ours on merit. It captures N frames from
 * an animated or video source, then quantises and encodes them to a 256-colour
 * GIF in a Web Worker (see ./gif-encoder.worker). Rendering stays on the main
 * thread — it needs the DOM canvas and loaded fonts — but the quantiser and LZW
 * compressor, which are what actually lock the UI, run off-thread. Frames stream
 * to the worker as they are captured, so capture and encode overlap and the
 * worker never waits on the full set.
 *
 * Encoding reports progress and can be cancelled mid-run.
 */

import { solveGrid } from '@sick-af/engine/grid';
import { GridSampler, type SourceMedia } from '@sick-af/engine/sample';
import { applyTint } from '@sick-af/engine/tint';
import type { ModeRenderer, RenderOptions } from '@sick-af/engine/renderer';
import type { GifWorkerRequest, GifWorkerResponse } from './gif-protocol';

/** Two-phase progress: capturing on the main thread, then encoding off it. */
export interface GifProgress {
  phase: 'capturing' | 'encoding';
  completed: number;
  total: number;
}

export interface GifExportConfig {
  /** Number of frames to capture and encode. */
  frameCount: number;
  /** Per-frame delay in milliseconds (≈ 1000 / fps). */
  frameDelayMs: number;
  /** Output pixel dimensions. */
  width: number;
  height: number;
  /** Palette ceiling per frame, clamped to 2..256. Default 256. */
  maxColors?: number;
  /** GIF loop count: -1 once, 0 forever (default), N repeats. */
  loop?: number;
  /**
   * Produces frame `index` as an RGBA buffer of `width * height * 4` bytes. May
   * be async so callers can seek a video and await its `seeked` event. The
   * returned buffer is transferred to the worker, so it must not be reused after
   * the call resolves.
   */
  captureFrame: (index: number) => Uint8ClampedArray | Promise<Uint8ClampedArray>;
  onProgress?: (progress: GifProgress) => void;
}

/** A running export: await `result`, or `cancel()` to abort it. */
export interface GifExportHandle {
  /** Resolves with the GIF blob, or rejects with an AbortError if cancelled. */
  result: Promise<Blob>;
  cancel(): void;
}

function spawnWorker(): Worker {
  return new Worker(new URL('./gif-encoder.worker.ts', import.meta.url), {
    type: 'module',
  });
}

export function exportGif(config: GifExportConfig): GifExportHandle {
  const {
    frameCount,
    frameDelayMs,
    width,
    height,
    maxColors = 256,
    loop = 0,
    captureFrame,
    onProgress,
  } = config;

  const worker = spawnWorker();
  let cancelled = false;
  let settle!: (blob: Blob) => void;
  let fail!: (err: unknown) => void;

  const result = new Promise<Blob>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const post = (message: GifWorkerRequest, transfer?: Transferable[]) => {
    worker.postMessage(message, transfer ?? []);
  };

  worker.onmessage = (event: MessageEvent<GifWorkerResponse>) => {
    const msg = event.data;
    if (msg.type === 'progress') {
      onProgress?.({ phase: 'encoding', completed: msg.encoded, total: msg.total });
    } else if (msg.type === 'done') {
      settle(new Blob([msg.data], { type: 'image/gif' }));
      worker.terminate();
    } else if (msg.type === 'error') {
      fail(new Error(`GIF encode failed: ${msg.message}`));
      worker.terminate();
    }
  };

  worker.onerror = (event) => {
    fail(new Error(event.message || 'GIF encoder worker crashed'));
    worker.terminate();
  };

  post({ type: 'init', width, height, maxColors, loop, frameCount });

  // Capture loop. Runs on the main thread but streams each frame to the worker
  // immediately and yields a macrotask between frames so the page can repaint
  // its progress UI instead of freezing through the capture.
  (async () => {
    try {
      for (let i = 0; i < frameCount; i++) {
        if (cancelled) return;
        const frame = await captureFrame(i);
        if (cancelled) return;
        onProgress?.({ phase: 'capturing', completed: i + 1, total: frameCount });
        // getImageData always backs its data with a real (non-shared) ArrayBuffer.
        const buffer = frame.buffer as ArrayBuffer;
        post({ type: 'frame', index: i, delayMs: frameDelayMs, data: buffer }, [buffer]);
        await new Promise((r) => setTimeout(r, 0));
      }
      if (!cancelled) post({ type: 'finish' });
    } catch (err) {
      if (!cancelled) {
        fail(err);
        worker.terminate();
      }
    }
  })();

  return {
    result,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      post({ type: 'cancel' });
      worker.terminate();
      fail(new DOMException('GIF export cancelled', 'AbortError'));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Frame capture helper                                                */
/* ------------------------------------------------------------------ */

export interface GifFrameConfig {
  source: SourceMedia;
  /** Resolved renderer for `options.mode`; the caller owns mode dispatch. */
  mode: ModeRenderer;
  options: RenderOptions;
}

/**
 * Builds a reusable frame grabber that renders the current state of `source`
 * through the full ASCII pipeline and returns its RGBA. The canvas and sampler
 * are allocated once and reused across frames — per sample.ts, allocating them
 * per frame is a guaranteed GC stall on the video path.
 *
 * The grabber renders whatever the source currently shows; the caller advances
 * the animation (e.g. seeking a video) between calls. GIF frames are opaque, so
 * a white base is laid down before the optional background.
 */
export function createGridFrameCapturer(
  config: GifFrameConfig,
  width: number,
  height: number,
): () => Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context unavailable for GIF capture canvas');

  const sampler = new GridSampler();
  const { source, mode, options } = config;

  return function capture(): Uint8ClampedArray {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    if (options.background) {
      ctx.fillStyle = options.background;
      ctx.fillRect(0, 0, width, height);
    }

    const grid = solveGrid(ctx, width, height, options.font);
    const sample = sampler.sample(source, grid, options.transform);

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
      applyTint(ctx, width, height, options.tint);
    }

    return ctx.getImageData(0, 0, width, height).data;
  };
}
