import { createCanvas, loadImage } from '@napi-rs/canvas';
const img = await loadImage('runs/visual/fx-chromatic-default.png');
const W = img.width, H = img.height;
const c = createCanvas(W, H); const x = c.getContext('2d'); x.drawImage(img, 0, 0);
const px = x.getImageData(0, 0, W, H).data;
let greenish = 0, grey = 0, n = px.length / 4;
for (let i = 0; i < px.length; i += 4) {
  const r = px[i], g = px[i+1], b = px[i+2];
  if (g > r + 25 && g > b + 25) greenish++;
  else if (Math.abs(r-g) < 20 && Math.abs(g-b) < 20) grey++;
}
console.log('DISK png:', W, 'x', H, 'greenish', greenish, 'grey', grey, 'of', n);
for (const col of [50, 240, 400, 475]) {
  const idx = (180 * W + col) * 4;
  console.log(`(${col},180)`, px[idx], px[idx+1], px[idx+2], px[idx+3]);
}
