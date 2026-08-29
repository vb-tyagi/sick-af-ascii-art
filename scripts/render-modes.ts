/**
 * Headless visual proof — W3.V3, Deliverable 2.
 *
 * Renders every registered mode against every fixture and writes a PNG per
 * (mode, fixture) to runs/visual/. `tsc --noEmit` proves the modes COMPILE;
 * these PNGs are the only artifact that proves they DRAW.
 *
 * Run:  npx vite-node scripts/render-modes.ts
 * (vite-node resolves the engine's extensionless TS imports; plain node cannot.)
 *
 * The spec (TEARDOWN §3.1) lists 15 style modes; all 15 are now registered in
 * src/engine/modes/* (`dither` closed the last gap in T16). This script renders
 * every one against every fixture.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCanvasPolyfill, renderMode } from './harness';
import { ALL_FIXTURES } from '@sick-af/engine/fixtures/generate';
import type { ModeRenderer } from '@sick-af/engine/renderer';

installCanvasPolyfill();

// Import mode registries AFTER the polyfill so braille's module-level sampler
// can construct.
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

const W = 480;
const H = 360;
// Mid-grey backdrop so BOTH dark ink (glyphs on the ramp's dark end) and light
// ink are visible in one image; block/voxel modes overpaint it entirely.
const BG = '#808080';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../runs/visual');
await mkdir(outDir, { recursive: true });

let count = 0;
for (const [name, mode] of Object.entries(MODES)) {
  for (const fixture of ALL_FIXTURES) {
    const { canvas } = renderMode(mode, fixture, W, H, { background: BG });
    const png = await canvas.encode('png');
    const safe = name.replace(/[^a-z0-9]+/gi, '-');
    await writeFile(resolve(outDir, `${safe}-${fixture}.png`), png);
    count++;
  }
}

console.log(
  `Rendered ${count} PNGs (${Object.keys(MODES).length} modes x ${ALL_FIXTURES.length} fixtures) -> ${outDir}`,
);
