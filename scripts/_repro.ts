import { installCanvasPolyfill, makePostFxChain, baseGlyphLayer, renderPostFx, readCanvas } from './harness';
installCanvasPolyfill();
const W = 480, H = 360;
const chain = makePostFxChain();
const glyph = baseGlyphLayer(W, H);
function px180(px: Uint8ClampedArray, col: number) {
  const i = (180 * W + col) * 4; return `${px[i]},${px[i+1]},${px[i+2]},${px[i+3]}`;
}
// mirror render-postfx exactly
for (const e of chain.effects) {
  const id = e.id;
  const [, max] = e.range;
  const levels: Array<[string, number | undefined]> = [['off', -1], ['default', undefined], ['max', max]];
  for (const [level, amt] of levels) {
    const settings = level === 'off' ? [] : [{ id, amount: amt }];
    const c = renderPostFx(chain, glyph, settings as any, W, H);
    if (id === 'chromatic' || id === 'rgb-split') {
      console.log(`${id}-${level} (240,180)=`, px180(readCanvas(c), 240));
    }
  }
}
