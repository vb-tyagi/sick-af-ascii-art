import { createCanvas } from '@napi-rs/canvas';
import {
  installCanvasPolyfill,
  makePostFxChain,
  baseGlyphLayer,
  renderPostFx,
} from './harness';

installCanvasPolyfill();
const W = 480, H = 360;
const chain = makePostFxChain();
const glyph = baseGlyphLayer(W, H);

async function roundtrip(canvas: import('@napi-rs/canvas').Canvas, label: string) {
  const png = await canvas.encode('png');
  const { loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(png);
  const c = createCanvas(W, H); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, W, H).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  console.log(`${label} PNG-roundtrip R=${(r / n).toFixed(1)} G=${(g / n).toFixed(1)} B=${(b / n).toFixed(1)}`);
}

const def = renderPostFx(chain, glyph, [{ id: 'chromatic', amount: 3 }], W, H);
await roundtrip(def, 'chromatic default');
