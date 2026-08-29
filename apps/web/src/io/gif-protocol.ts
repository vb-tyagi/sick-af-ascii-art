/**
 * Worker message protocol for GIF export (T33).
 *
 * Types only — this module carries no runtime code, so importing it into either
 * the main thread or the worker adds nothing to either bundle. It exists so both
 * sides share one definition of the wire format instead of drifting apart.
 */

/** Main thread → encoder worker. */
export type GifWorkerRequest =
  | {
      type: 'init';
      width: number;
      height: number;
      /** Palette ceiling per frame, 2..256. */
      maxColors: number;
      /** GIF loop count: -1 once, 0 forever, N repeats. */
      loop: number;
      /** Total frames the worker should expect — drives progress. */
      frameCount: number;
    }
  /** RGBA frame; `data` is a transferred ArrayBuffer of width*height*4 bytes. */
  | { type: 'frame'; index: number; delayMs: number; data: ArrayBuffer }
  | { type: 'finish' }
  | { type: 'cancel' };

/** Encoder worker → main thread. */
export type GifWorkerResponse =
  | { type: 'progress'; encoded: number; total: number }
  /** Final GIF; `data` is a transferred ArrayBuffer of the image/gif bytes. */
  | { type: 'done'; data: ArrayBuffer }
  | { type: 'error'; message: string };
