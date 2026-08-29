/**
 * @sick-af/engine — public API barrel.
 *
 * The rendering core: pure, dependency-free, Canvas2D-context-driven. Works in
 * the browser and under Node (@napi-rs/canvas), which is how the bench scripts
 * exercise it. The web app imports subpaths (`@sick-af/engine/renderer`, …);
 * this barrel is the convenience surface for external consumers.
 */
export * from './renderer';
export * from './grid';
export * from './sample';
export * from './color';
export * from './dither';
export * from './palettes';
export * from './tint';
export * from './backdrop';
export * from './blur';
export * from './mask';
export * from './lights';
export * from './animate';
export * from './postfx/chain';

export { glyphModes } from './modes/glyph';
export { ditherModes } from './modes/dither';
export { shapeModes } from './modes/shape';
export { blockModes } from './modes/block';
export { voxelModes } from './modes/voxel';
export { brailleModes } from './modes/braille';
export { discoModes } from './modes/disco';
