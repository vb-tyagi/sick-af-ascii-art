import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs';
const D='runs/visual';
async function px(f){const i=await loadImage(`${D}/${f}`);const c=createCanvas(i.width,i.height);const x=c.getContext('2d');x.drawImage(i,0,0);return x.getImageData(0,0,i.width,i.height).data;}
async function delta(a,b){
  const A=await px(a),B=await px(b);
  let sum=0,max=0,n=0;
  for(let i=0;i<A.length;i+=4){
    const d=Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2]);
    sum+=d; if(d>max)max=d; if(d>0)n++;
  }
  return {mean:(sum/(A.length/4)), max, pct:((n/(A.length/4))*100)};
}
const fx=fs.readdirSync(D).filter(f=>f.startsWith('fx-')&&f.endsWith('-off.png')).map(f=>f.replace(/^fx-/,'').replace(/-off\.png$/,''));
console.log('effect'.padEnd(22)+'off->default'.padEnd(28)+'off->max');
for(const e of fx){
  const d=await delta(`fx-${e}-off.png`,`fx-${e}-default.png`);
  const m=await delta(`fx-${e}-off.png`,`fx-${e}-max.png`);
  const f=o=>`mean=${o.mean.toFixed(3)} px%=${o.pct.toFixed(1)}`;
  let flag='';
  if(m.mean<0.5) flag='  <<< INVISIBLE AT MAX';
  else if(m.mean<=d.mean) flag='  <<< NOT MONOTONIC';
  console.log(e.padEnd(22)+f(d).padEnd(28)+f(m)+flag);
}
