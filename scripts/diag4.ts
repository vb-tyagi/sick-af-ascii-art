import {
  installCanvasPolyfill,
  makePostFxChain,
  baseGlyphLayer,
  renderPostFx,
  readCanvas,
} from './harness';

installCanvasPolyfill();
const W = 480, H = 360;
const chain = makePostFxChain();
const glyph = baseGlyphLayer(W, H);

function means(d: Uint8ClampedArray) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return `R=${(r / n).toFixed(1)} G=${(g / n).toFixed(1)} B=${(b / n).toFixed(1)}`;
}

// Render default, THEN render max (overwrites scratch), THEN read default via getImageData.
const def = renderPostFx(chain, glyph, [{ id: 'chromatic', amount: 3 }], W, H);
const mx = renderPostFx(chain, glyph, [{ id: 'chromatic', amount: 20 }], W, H);
console.log('default read AFTER max render (getImageData):', means(readCanvas(def)));
console.log('max read:', means(readCanvas(mx)));
