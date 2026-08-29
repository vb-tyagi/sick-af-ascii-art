import { createCanvas, loadImage } from '@napi-rs/canvas';
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

async function encMeans(canvas: import('@napi-rs/canvas').Canvas) {
  const png = await canvas.encode('png');
  const img = await loadImage(png);
  const c = createCanvas(W, H); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, W, H).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return `R=${(r / n).toFixed(1)} G=${(g / n).toFixed(1)} B=${(b / n).toFixed(1)}`;
}

// Replicate render-postfx's loop order, encoding each. Watch when chromatic flips.
for (const e of chain.effects) {
  const [, max] = e.range;
  const levels: Array<[string, unknown[]]> = [
    ['off', []],
    ['default', [{ id: e.id }]],
    ['max', [{ id: e.id, amount: max }]],
  ];
  // Eager render ALL levels first (like render-postfx), THEN encode.
  const rendered = levels.map(([lvl, s]) => [lvl, renderPostFx(chain, glyph, s as never, W, H)] as const);
  for (const [level, canvas] of rendered) {
    if (e.id === 'chromatic' || e.id === 'rgb-split') {
      console.log(`${e.id} ${level.padEnd(8)} -> ${await encMeans(canvas)}`);
    } else {
      await canvas.encode('png');
    }
  }
}
