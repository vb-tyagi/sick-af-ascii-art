import {
  installCanvasPolyfill,
  makePostFxChain,
  baseGlyphLayer,
  renderPostFx,
  readCanvas,
} from './harness';
import type { EffectId } from '@sick-af/engine/postfx/chain';

installCanvasPolyfill();
const W = 480, H = 360;
const chain = makePostFxChain();
const glyph = baseGlyphLayer(W, H);

function means(d: Uint8ClampedArray) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return `R=${(r / n).toFixed(1)} G=${(g / n).toFixed(1)} B=${(b / n).toFixed(1)}`;
}

// For each effect: render default, then render a DIFFERENT effect (bloom max) to
// churn the shared scratch, then read the default output. If stable, no leak.
for (const id of ['bloom', 'pixelate', 'glitch', 'crt-curvature'] as EffectId[]) {
  const e = chain.get(id);
  const def = renderPostFx(chain, glyph, [{ id, amount: e.default }], W, H);
  const before = means(readCanvas(def));
  renderPostFx(chain, glyph, [{ id: 'chromatic', amount: 20 }], W, H);
  renderPostFx(chain, glyph, [{ id: 'rgb-split', amount: 20 }], W, H);
  const after = means(readCanvas(def));
  console.log(`${id.padEnd(14)} before=${before}  after=${after}  ${before === after ? 'STABLE' : 'LEAK'}`);
}
