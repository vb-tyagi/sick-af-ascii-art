import { createCanvas, loadImage } from '@napi-rs/canvas';
const D = 'runs/visual';
async function stat(f) {
  const i = await loadImage(`${D}/${f}`);
  const c = createCanvas(i.width, i.height); const x = c.getContext('2d');
  x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, i.width, i.height).data;
  let r = 0, g = 0, b = 0, a = 0, n = 0, a0 = 0;
  for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; a += d[k + 3]; n++; if (d[k + 3] < 255) a0++; }
  console.log(f.padEnd(28) + `R=${(r / n).toFixed(1)} G=${(g / n).toFixed(1)} B=${(b / n).toFixed(1)} A=${(a / n).toFixed(1)} nonopaque%=${(100 * a0 / n).toFixed(1)}`);
}
for (const f of ['fx-chromatic-off.png', 'fx-chromatic-default.png', 'fx-chromatic-max.png', 'fx-rgb-split-default.png']) await stat(f);
