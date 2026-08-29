/**
 * Video export — T34. MP4 via WebCodecs, WebM fallback.
 *
 * The board's highest-risk item (TEARDOWN §4.6, §7 item 4): the reference's
 * JSON-LD advertises MP4 but its shipped UI ships only PNG/JPG, so MP4 is ours
 * on merit — and `VideoEncoder` has real browser-support gaps. Two rules follow
 * from that:
 *
 *   1. FEATURE-DETECT, never assume. `detectVideoSupport()` probes for the
 *      capability object itself (`'VideoEncoder' in window`), not a try/catch
 *      around a doomed call. The UI uses it to DISABLE the control up front with
 *      a real explanation rather than failing at click time.
 *   2. Degrading is not silent. If someone asks for MP4 and we can only make
 *      WebM, `VideoExportResult.degradedFrom` says so. Handing a `.webm` to
 *      someone who clicked "MP4" without telling them is a bug, not a fallback;
 *      the caller is contractually obliged to surface `degradedFrom`.
 *
 * Every frame is RE-RENDERED at the target size through the full pipeline (see
 * ./export-image and ./export-gif) — the visible canvas is never upscaled.
 */

import { solveGrid } from '@sick-af/engine/grid';
import { GridSampler, type SourceMedia } from '@sick-af/engine/sample';
import { applyTint } from '@sick-af/engine/tint';
import type { ModeRenderer, RenderOptions } from '@sick-af/engine/renderer';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export type VideoCodecFormat = 'mp4' | 'webm';

/** What the environment can actually produce, decided synchronously up front. */
export interface VideoCapability {
  /** WebCodecs MP4 path is present. Codec-config viability is confirmed later, async. */
  mp4: boolean;
  /** MediaRecorder WebM path is present with a supported mime. */
  webm: boolean;
  /** Best format available, or null when neither path exists. */
  preferred: VideoCodecFormat | null;
  /**
   * Human-readable status for the UI. Null when MP4 is fully available; otherwise
   * explains the degradation or the reason the control must be disabled.
   */
  note: string | null;
}

export interface VideoProgress {
  phase: 'encoding';
  completed: number;
  total: number;
}

export interface VideoExportConfig {
  /** Output pixel dimensions (already scaled; the 1x visible canvas is never upscaled). */
  width: number;
  height: number;
  frameCount: number;
  /** Playback frame rate; also sets per-frame timestamp spacing. */
  fps: number;
  /**
   * Draws frame `index` onto `ctx`, sized `width`×`height`. May be async so a
   * caller can seek a video source and await its `seeked` event between frames.
   * The caller owns animation state; this only renders the source's current form.
   */
  drawFrame: (ctx: CanvasRenderingContext2D, index: number) => void | Promise<void>;
  /** Desired container. Falls back per {@link detectVideoSupport}; degradation is reported, never hidden. */
  format?: VideoCodecFormat;
  /** Target bitrate in bits/sec. Defaults to a size-derived estimate. */
  bitrate?: number;
  onProgress?: (progress: VideoProgress) => void;
  signal?: AbortSignal;
}

export interface VideoExportResult {
  blob: Blob;
  /** The format ACTUALLY produced. */
  format: VideoCodecFormat;
  /**
   * Set when the requested format was unavailable and we degraded to `format`.
   * The UI MUST surface this — a silent swap is the bug this task guards against.
   */
  degradedFrom: VideoCodecFormat | null;
}

/* ------------------------------------------------------------------ */
/* Feature detection                                                   */
/* ------------------------------------------------------------------ */

/** Presence check for the WebCodecs encode path. Not a codec-viability check. */
function hasWebCodecsMp4(): boolean {
  return (
    typeof window !== 'undefined' &&
    'VideoEncoder' in window &&
    'VideoFrame' in window &&
    'EncodedVideoChunk' in window
  );
}

/** WebM fallback needs MediaRecorder and at least one webm mime it will accept. */
function webmMimeType(): string | null {
  if (
    typeof window === 'undefined' ||
    !('MediaRecorder' in window) ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return null;
  }
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

/**
 * Synchronous capability probe. The UI calls this to decide whether to enable the
 * video control and what to say when it can't. MP4 presence here means the API
 * exists; the specific avc config is confirmed later via `VideoEncoder.isConfigSupported`.
 */
export function detectVideoSupport(): VideoCapability {
  const mp4 = hasWebCodecsMp4();
  const webm = webmMimeType() !== null;

  let preferred: VideoCodecFormat | null = null;
  let note: string | null = null;

  if (mp4) {
    preferred = 'mp4';
  } else if (webm) {
    preferred = 'webm';
    note = 'MP4 export needs WebCodecs, which this browser lacks — exporting WebM instead.';
  } else {
    note = 'Video export needs WebCodecs or MediaRecorder; neither is available in this browser.';
  }

  return { mp4, webm, preferred, note };
}

/* ------------------------------------------------------------------ */
/* MP4 — WebCodecs VideoEncoder + mp4-muxer                            */
/* ------------------------------------------------------------------ */

// H.264 demands even dimensions; an odd width/height is rejected by encoders.
const toEven = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

// bits-per-pixel-per-frame heuristic, floored so tiny grids still look clean.
function defaultBitrate(width: number, height: number, fps: number): number {
  return Math.max(1_000_000, Math.round(width * height * fps * 0.1));
}

/**
 * Probes avc codec strings from most to least capable and returns the first the
 * encoder accepts for these dimensions. Returning null means the API is present
 * but no usable H.264 profile is — the caller then degrades to WebM.
 */
async function resolveAvcConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<VideoEncoderConfig | null> {
  const candidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'avc1.420028'];
  for (const codec of candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return support.config ?? config;
    } catch {
      // isConfigSupported can throw on a malformed descriptor; try the next.
    }
  }
  return null;
}

async function encodeMp4(
  config: VideoExportConfig,
  encoderConfig: VideoEncoderConfig,
): Promise<Blob> {
  const { frameCount, fps, drawFrame, onProgress, signal } = config;
  const width = encoderConfig.width;
  const height = encoderConfig.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable for MP4 export canvas');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encoderError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encoderError = err;
    },
  });
  encoder.configure(encoderConfig);

  const frameDurationUs = 1_000_000 / fps;
  const keyframeInterval = Math.max(1, Math.round(fps)); // ~1s GOP

  try {
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) throw new DOMException('Video export cancelled', 'AbortError');
      if (encoderError) throw encoderError;

      await drawFrame(ctx, i);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * frameDurationUs),
        duration: Math.round(frameDurationUs),
      });
      encoder.encode(frame, { keyFrame: i % keyframeInterval === 0 });
      frame.close();

      onProgress?.({ phase: 'encoding', completed: i + 1, total: frameCount });

      // Relieve encoder backpressure so a slow encode can't balloon memory.
      while (encoder.encodeQueueSize > 8 && !encoderError) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (encoderError) throw encoderError;
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }

  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

/* ------------------------------------------------------------------ */
/* WebM — MediaRecorder over a canvas capture stream                   */
/* ------------------------------------------------------------------ */

async function encodeWebm(config: VideoExportConfig, mime: string): Promise<Blob> {
  const { width, height, frameCount, fps, drawFrame, onProgress, bitrate, signal } = config;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable for WebM export canvas');

  // captureStream(0) yields frames only on requestFrame(), so we control timing
  // and MediaRecorder records exactly the frames we push, spaced by the delay.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: bitrate ?? defaultBitrate(width, height, fps),
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error('MediaRecorder failed during WebM export'));
  });

  const frameDelayMs = 1000 / fps;
  recorder.start();
  try {
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) throw new DOMException('Video export cancelled', 'AbortError');
      await drawFrame(ctx, i);
      track.requestFrame();
      onProgress?.({ phase: 'encoding', completed: i + 1, total: frameCount });
      await new Promise((r) => setTimeout(r, frameDelayMs));
    }
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    track.stop();
  }

  await stopped;
  return new Blob(chunks, { type: mime.split(';')[0] });
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Encodes the animation to video, honouring `config.format` when possible and
 * reporting any degradation through the result. Rejects only when NO path can
 * produce a file — a truthful failure beats a broken or mislabelled export.
 */
export async function exportVideo(config: VideoExportConfig): Promise<VideoExportResult> {
  const support = detectVideoSupport();
  if (!support.preferred) {
    throw new Error('Video export is not supported in this browser.');
  }

  const requested = config.format ?? support.preferred;

  const tryMp4 = async (): Promise<Blob | null> => {
    if (!support.mp4) return null;
    const width = toEven(config.width);
    const height = toEven(config.height);
    const bitrate = config.bitrate ?? defaultBitrate(width, height, config.fps);
    const avc = await resolveAvcConfig(width, height, config.fps, bitrate);
    if (!avc) return null; // API present, no usable H.264 profile — degrade.
    return encodeMp4(config, avc);
  };

  const tryWebm = async (): Promise<Blob | null> => {
    const mime = webmMimeType();
    if (!mime) return null;
    return encodeWebm(config, mime);
  };

  if (requested === 'mp4') {
    const mp4 = await tryMp4();
    if (mp4) return { blob: mp4, format: 'mp4', degradedFrom: null };
    const webm = await tryWebm();
    if (webm) return { blob: webm, format: 'webm', degradedFrom: 'mp4' };
    throw new Error('Video export is not supported in this browser.');
  }

  const webm = await tryWebm();
  if (webm) return { blob: webm, format: 'webm', degradedFrom: null };
  const mp4 = await tryMp4();
  if (mp4) return { blob: mp4, format: 'mp4', degradedFrom: 'webm' };
  throw new Error('Video export is not supported in this browser.');
}

/* ------------------------------------------------------------------ */
/* Frame renderer helper                                               */
/* ------------------------------------------------------------------ */

export interface VideoFrameConfig {
  source: SourceMedia;
  /** Resolved renderer for `options.mode`; the caller owns mode dispatch. */
  mode: ModeRenderer;
  options: RenderOptions;
}

/**
 * Builds a `drawFrame` that renders the source's current state through the full
 * ASCII pipeline directly at the ctx's pixel size — solving the grid against the
 * target dimensions gives genuinely more cells, never a stretched bitmap. The
 * sampler is allocated once (per sample.ts, per-frame allocation stalls the video
 * path). Frames are opaque, so a white base underlies the optional background.
 * The caller advances the animation (e.g. seeking a video) between calls.
 */
export function createGridVideoDrawFrame(
  config: VideoFrameConfig,
): (ctx: CanvasRenderingContext2D, index: number) => void {
  const sampler = new GridSampler();
  const { source, mode, options } = config;

  return function draw(ctx: CanvasRenderingContext2D): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;

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
  };
}
