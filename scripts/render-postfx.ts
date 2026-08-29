/**
 * Headless visual proof for the post-FX chain — W6.V6, Deliverable 1.
 *
 * `tsc --noEmit` proves the 13 effects COMPILE; postfx.test.ts proves they DRAW
 * with power. This script is the third leg: for a human to LOOK. It renders the
 * SAME base frame (characters mode over the ramp fixture, composited over the
 * mid-grey backdrop) through each effect three ways — OFF, ON at default amount,
 * ON at max amount — and writes one PNG per (effect, level) to runs/visual/.
 *
 * Run:  npx vite-node scripts/render-postfx.ts
 * (vite-node resolves the engine's extensionless TS imports; plain node cannot.)
 *
 * W3's lesson: a wrong render satisfies not-blank/monotonic/in-bounds. Only the
 * PNGs caught the real defect. These images are that instrument for post-FX.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installCanvasPolyfill,
  makePostFxChain,
  baseGlyphLayer,
  renderPostFx,
} from './harness';
import type { EffectId } from '@sick-af/engine/postfx/chain';

installCanvasPolyfill();

const W = 480;
const H = 360;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../runs/visual');
await mkdir(outDir, { recursive: true });

const chain = makePostFxChain();
const glyph = baseGlyphLayer(W, H);

// OFF baseline shares one file per run, but write it per-effect too so each
// effect's triptych is self-contained when browsing the folder.
let count = 0;
for (const e of chain.effects) {
  const id: EffectId = e.id;
  const [, max] = e.range;
  const levels: Array<[string, ReturnType<typeof renderPostFx>]> = [
    ['off', renderPostFx(chain, glyph, [], W, H)],
    ['default', renderPostFx(chain, glyph, [{ id }], W, H)],
    ['max', renderPostFx(chain, glyph, [{ id, amount: max }], W, H)],
  ];
  for (const [level, canvas] of levels) {
    const png = await canvas.encode('png');
    await writeFile(resolve(outDir, `fx-${id}-${level}.png`), png);
    count++;
  }
}

console.log(
  `Rendered ${count} PNGs (${chain.effects.length} effects x 3 levels) -> ${outDir}`,
);
