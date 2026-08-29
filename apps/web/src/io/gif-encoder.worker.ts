/**
 * GIF encoder worker (T33).
 *
 * The whole reason this file exists off the main thread: gifenc's colour
 * quantiser (PnnQuant) plus the LZW compressor are the expensive steps, and run
 * synchronously. Doing them on the UI thread locks the page solid for the length
 * of the encode — seconds for a multi-frame GIF. Here each frame is quantised,
 * indexed, and written the instant it arrives, so the main thread only ever
 * pays for rendering + a structured-clone transfer.
 *
 * Frames are quantised per-frame (local colour table) rather than against one
 * global palette: our sources are dithered/animated and colours shift between
 * frames, so a shared palette would band. gifenc has no dithering, so a fresh
 * 256-colour table per frame is the honest choice for quality.
 */

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { GifWorkerRequest, GifWorkerResponse } from './gif-protocol';

// `self` is typed as a Window under the DOM lib; narrow it to just the worker
// surface we use rather than pulling in the conflicting webworker lib.
const worker = self as unknown as {
  postMessage(message: GifWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<GifWorkerRequest>) => void) | null;
  close(): void;
};

let gif: ReturnType<typeof GIFEncoder> | null = null;
let width = 0;
let height = 0;
let maxColors = 256;
let loop = 0;
let total = 0;
let encoded = 0;
let cancelled = false;

function encodeFrame(index: number, delayMs: number, buffer: ArrayBuffer): void {
  if (cancelled || !gif) return;

  const rgba = new Uint8ClampedArray(buffer);
  const palette = quantize(rgba, maxColors);
  const indexed = applyPalette(rgba, palette);

  // repeat only takes effect on the first frame's write; delay is per-frame.
  gif.writeFrame(indexed, width, height, {
    palette,
    delay: delayMs,
    repeat: index === 0 ? loop : undefined,
  });

  encoded += 1;
  worker.postMessage({ type: 'progress', encoded, total });
}

function finish(): void {
  if (cancelled || !gif) return;
  gif.finish();
  const bytes = gif.bytes();
  // Copy out of the shared internal buffer so the transfer owns clean bytes.
  const out = bytes.slice().buffer;
  worker.postMessage({ type: 'done', data: out }, [out]);
  gif = null;
}

worker.onmessage = (event: MessageEvent<GifWorkerRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
        width = msg.width;
        height = msg.height;
        maxColors = Math.max(2, Math.min(256, Math.floor(msg.maxColors)));
        loop = msg.loop;
        total = msg.frameCount;
        encoded = 0;
        cancelled = false;
        gif = GIFEncoder();
        break;
      case 'frame':
        encodeFrame(msg.index, msg.delayMs, msg.data);
        break;
      case 'finish':
        finish();
        break;
      case 'cancel':
        cancelled = true;
        gif = null;
        worker.close();
        break;
    }
  } catch (err) {
    worker.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
