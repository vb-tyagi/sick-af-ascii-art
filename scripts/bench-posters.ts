/**
 * Poster benchmark — real-world quality + performance pass.
 *
 * Runs every registered mode and every post-FX effect over the posters in
 * test-posters/ (LOCAL test inputs only — gitignored, never shipped), timing
 * each render and writing every frame to runs/posters/ for visual QA.
 *
 * Run:  npx vite-node scripts/bench-posters.ts
 *
 * Timing caveat, stated once and honestly: this is @napi-rs/canvas on CPU.
 * In-browser, filter-backed effects (bloom, backdrop blur) ride the GPU and
 * come in faster; error-diffusion dither is serial CPU in both worlds. Treat
 * these numbers as representative-to-pessimistic, and the browser spot-check
 * as the interactive ground truth.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import {
  installCanvasPolyfill,
  renderSample,
  defaultOptions,
  makePostFxChain,
  renderPostFx,
  type EffectSetting,
} from './harness';
import { solveGrid } from '@sick-af/engine/grid';
import type { SampleResult } from '@sick-af/engine/sample';
import type { ModeRenderer } from '@sick-af/engine/renderer';
import type { EffectId } from '@sick-af/engine/postfx/chain';

installCanvasPolyfill();

// Mode registries AFTER the polyfill (braille builds a sampler at module load).
const { glyphModes } = await import('@sick-af/engine/modes/glyph');
const { shapeModes } = await import('@sick-af/engine/modes/shape');
const { blockModes } = await import('@sick-af/engine/modes/block');
const { voxelModes } = await import('@sick-af/engine/modes/voxel');
const { brailleModes } = await import('@sick-af/engine/modes/braille');
const { discoModes } = await import('@sick-af/engine/modes/disco');
const { ditherModes } = await import('@sick-af/engine/modes/dither');

const MODES: Record<string, ModeRenderer> = {
  ...glyphModes,
  ...shapeModes,
  ...blockModes,
  ...voxelModes,
  ...brailleModes,
  ...discoModes,
  ...ditherModes,
};

// Default amounts from TEARDOWN §3.7 — the values each toggle wakes up with.
const EFFECTS: readonly { id: EffectId; amount: number }[] = [
  { id: 'vignette', amount: 50 },
  { id: 'scanlines', amount: 40 },
  { id: 'crt-curvature', amount: 30 },
  { id: 'chromatic', amount: 3 },
  { id: 'bloom', amount: 40 },
  { id: 'character-bloom', amount: 60 },
  { id: 'character-chromatic', amount: 3 },
  { id: 'film-grain', amount: 30 },
  { id: 'glitch', amount: 20 },
  { id: 'rgb-split', amount: 2 },
  { id: 'pixelate', amount: 4 },
  { id: 'halftone', amount: 4 },
  { id: 'film-dust', amount: 20 },
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POSTERS_DIR = resolve(ROOT, 'test-posters');
const OUT_DIR = resolve(ROOT, 'runs', 'posters');

// One output geometry for comparability across posters (portrait, ~default UI
// scale: fontSize 11 → ~109×98 cells).
const W = 720;
const H = 1080;

/** Draw a poster cover-fit onto a W×H canvas, then read grid-resolution cells. */
function samplePoster(img: Awaited<ReturnType<typeof loadImage>>, cols: number, rows: number): SampleResult {
  const buf = createCanvas(cols, rows);
  const bctx = buf.getContext('2d');
  const scale = Math.max(W / img.width, H / img.height);
  const sw = W / scale;
  const sh = H / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(img, sx, sy, sw, sh, 0, 0, cols, rows);
  return { data: bctx.getImageData(0, 0, cols, rows).data, cols, rows };
}

interface Timing { subject: string; poster: string; ms: number }

const timings: Timing[] = [];
await mkdir(OUT_DIR, { recursive: true });

const files = (await readdir(POSTERS_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (files.length === 0) throw new Error(`no posters found in ${POSTERS_DIR}`);

const gridProbe = createCanvas(W, H);
const grid = solveGrid(
  gridProbe.getContext('2d') as unknown as CanvasRenderingContext2D,
  W,
  H,
  defaultOptions().font,
);
console.log(`grid: ${grid.cols}×${grid.rows} cells at ${W}×${H}\n`);

let firstCharactersRender: Canvas | null = null;

for (const file of files) {
  const stem = file.replace(/\.[^.]+$/, '').slice(0, 8);
  const img = await loadImage(resolve(POSTERS_DIR, file));
  const sample = samplePoster(img, grid.cols, grid.rows);

  for (const [id, mode] of Object.entries(MODES)) {
    const t0 = performance.now();
    const res = renderSample(mode, sample, grid, W, H, { background: '#0a0a0c' });
    const ms = performance.now() - t0;
    timings.push({ subject: `mode:${id}`, poster: stem, ms });
    await writeFile(resolve(OUT_DIR, `${stem}-${id}.png`), await res.canvas.encode('png'));
    if (id === 'characters' && !firstCharactersRender) firstCharactersRender = res.canvas;
  }
}

// Post-FX timings: one representative glyph base (first poster, characters),
// each effect at its default amount, timed over the same frame.
if (firstCharactersRender) {
  const chain = makePostFxChain();
  for (const fx of EFFECTS) {
    const setting: EffectSetting[] = [{ id: fx.id, amount: fx.amount }];
    const t0 = performance.now();
    const out = renderPostFx(chain, firstCharactersRender, setting, W, H);
    const ms = performance.now() - t0;
    timings.push({ subject: `fx:${fx.id}`, poster: 'poster1', ms });
    await writeFile(resolve(OUT_DIR, `fx-${fx.id}.png`), await out.encode('png'));
  }
}

// Aggregate: mean/min/max per subject across posters.
const bySubject = new Map<string, number[]>();
for (const t of timings) {
  const arr = bySubject.get(t.subject) ?? [];
  arr.push(t.ms);
  bySubject.set(t.subject, arr);
}
const rows = [...bySubject.entries()]
  .map(([subject, arr]) => ({
    subject,
    mean: arr.reduce((a, b) => a + b, 0) / arr.length,
    min: Math.min(...arr),
    max: Math.max(...arr),
    n: arr.length,
  }))
  .sort((a, b) => b.mean - a.mean);

console.log('subject                       mean ms    min     max    n   60fps?');
for (const r of rows) {
  const fits = r.mean < 16.7 ? 'yes' : r.mean < 33.4 ? '30fps' : 'no';
  console.log(
    `${r.subject.padEnd(30)}${r.mean.toFixed(1).padStart(7)}${r.min.toFixed(1).padStart(8)}${r.max
      .toFixed(1)
      .padStart(8)}${String(r.n).padStart(5)}   ${fits}`,
  );
}

await writeFile(resolve(OUT_DIR, 'bench.json'), JSON.stringify({ grid, W, H, rows, timings }, null, 2));
console.log(`\n${files.length} posters × ${Object.keys(MODES).length} modes + ${EFFECTS.length} effects → ${OUT_DIR}`);
