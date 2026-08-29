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

function means(data: Uint8ClampedArray) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return { r: r / n, g: g / n, b: b / n };
}

function sad(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n++;
  }
  return sum / n;
}

for (const id of ['chromatic', 'rgb-split'] as EffectId[]) {
  const e = chain.get(id);
  const [, max] = e.range;
  const off = readCanvas(renderPostFx(chain, glyph, [], W, H));
  const def = readCanvas(renderPostFx(chain, glyph, [{ id, amount: e.default }], W, H));
  const mx = readCanvas(renderPostFx(chain, glyph, [{ id, amount: max }], W, H));
  const m = means(def);
  console.log(`${id} default means R=${m.r.toFixed(1)} G=${m.g.toFixed(1)} B=${m.b.toFixed(1)}`);
  console.log(`${id} SAD off->default=${sad(off, def).toFixed(1)}  off->max=${sad(off, mx).toFixed(1)}`);
}
