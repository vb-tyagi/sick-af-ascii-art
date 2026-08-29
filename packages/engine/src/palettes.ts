/**
 * Palette registry — W4.T18b.
 *
 * Sixteen historically grounded palettes for the dither engine, each an
 * RGBTuple[] in sRGB 0..255. Documented hardware colour sets are public
 * engineering facts (the fixed RGB output of a given chip is measurable, not
 * authored); where independent measurements disagree the `note` records which
 * source these values follow. None of this is taken from the reference site —
 * its own "16 palettes" were never extracted and are not reproduced here.
 *
 * The dither engine matches in linear space (see ./dither), so ordering within
 * a palette is irrelevant; only the set of colours matters.
 */

import type { RGBTuple } from './dither';
import { luminance } from './color';

export interface Palette {
  /** Stable slug used as the registry key. */
  key: string;
  /** Human-readable name. */
  name: string;
  /** sRGB 0..255. */
  colors: RGBTuple[];
  /** One line of provenance. */
  note: string;
}

export const PALETTES: Palette[] = [
  {
    key: 'mono',
    name: '1-bit Mono',
    colors: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    note: 'Pure black/white — the canonical 1-bit dither target.',
  },
  {
    key: 'gameboy',
    name: 'Game Boy',
    colors: [
      [15, 56, 15],
      [48, 98, 48],
      [139, 172, 15],
      [155, 188, 15],
    ],
    note: 'DMG-01 4-shade green LCD, the widely cited reference values.',
  },
  {
    key: 'cga4',
    name: 'CGA Mode 4',
    colors: [
      [0, 0, 0],
      [85, 255, 255],
      [255, 85, 255],
      [255, 255, 255],
    ],
    note: 'CGA 320x200 palette 1 high-intensity: black/cyan/magenta/white.',
  },
  {
    key: 'ega',
    name: 'EGA 16',
    colors: [
      [0, 0, 0],
      [0, 0, 170],
      [0, 170, 0],
      [0, 170, 170],
      [170, 0, 0],
      [170, 0, 170],
      [170, 85, 0],
      [170, 170, 170],
      [85, 85, 85],
      [85, 85, 255],
      [85, 255, 85],
      [85, 255, 255],
      [255, 85, 85],
      [255, 85, 255],
      [255, 255, 85],
      [255, 255, 255],
    ],
    note: 'IBM EGA default 16 from the 2-bit-per-channel IRGB DAC levels.',
  },
  {
    key: 'c64',
    name: 'Commodore 64',
    colors: [
      [0, 0, 0],
      [255, 255, 255],
      [136, 0, 0],
      [170, 255, 238],
      [204, 68, 204],
      [0, 204, 85],
      [0, 0, 170],
      [238, 238, 119],
      [221, 136, 85],
      [102, 68, 0],
      [255, 119, 119],
      [51, 51, 51],
      [119, 119, 119],
      [170, 255, 102],
      [0, 136, 255],
      [187, 187, 187],
    ],
    note: 'VIC-II 16-colour set, Pepto (2001) measurement.',
  },
  {
    key: 'nes',
    name: 'NES (sampled)',
    colors: [
      [0, 0, 0],
      [124, 124, 124],
      [188, 188, 188],
      [252, 252, 252],
      [0, 0, 252],
      [0, 120, 248],
      [60, 188, 252],
      [216, 0, 204],
      [228, 0, 88],
      [248, 56, 0],
      [248, 152, 56],
      [252, 224, 168],
      [0, 168, 68],
      [88, 216, 84],
      [104, 68, 252],
      [172, 124, 0],
    ],
    note: '16 sampled from the 2C02 master palette (Nestopia RGB approximation).',
  },
  {
    key: 'zxspectrum',
    name: 'ZX Spectrum',
    colors: [
      [0, 0, 0],
      [0, 0, 215],
      [215, 0, 0],
      [215, 0, 215],
      [0, 215, 0],
      [0, 215, 215],
      [215, 215, 0],
      [215, 215, 215],
      [0, 0, 255],
      [255, 0, 0],
      [255, 0, 255],
      [0, 255, 0],
      [0, 255, 255],
      [255, 255, 0],
      [255, 255, 255],
    ],
    note: '8 normal + 7 bright (bright black omitted as a duplicate) = 15.',
  },
  {
    key: 'appleii',
    name: 'Apple II LoRes',
    colors: [
      [0, 0, 0],
      [114, 38, 64],
      [64, 51, 127],
      [228, 52, 254],
      [14, 89, 64],
      [128, 128, 128],
      [27, 154, 254],
      [191, 179, 255],
      [64, 76, 0],
      [228, 101, 1],
      [128, 128, 128],
      [241, 166, 191],
      [27, 203, 1],
      [191, 204, 128],
      [141, 217, 191],
      [255, 255, 255],
    ],
    note: 'Apple II 16-colour LoRes, one common NTSC-derived RGB mapping.',
  },
  {
    key: 'teletext',
    name: 'Teletext 8',
    colors: [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 0],
      [0, 0, 255],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
    ],
    note: 'CCIR/BBC Teletext: the 8 fully-saturated RGB on/off combinations.',
  },
  {
    key: 'macpaint',
    name: 'MacPaint',
    colors: [
      [255, 255, 255],
      [0, 0, 0],
      [128, 128, 128],
    ],
    note: 'Original Mac was 1-bit; the mid grey stands in for its 50% dither pattern.',
  },
  {
    key: 'workbench',
    name: 'Amiga Workbench',
    colors: [
      [0, 85, 170],
      [255, 255, 255],
      [0, 0, 0],
      [255, 136, 0],
    ],
    note: 'Workbench 1.x default 4-colour: blue desktop, white, black, orange.',
  },
  {
    key: 'pico8',
    name: 'PICO-8',
    colors: [
      [0, 0, 0],
      [29, 43, 83],
      [126, 37, 83],
      [0, 135, 81],
      [171, 82, 54],
      [95, 87, 79],
      [194, 195, 199],
      [255, 241, 232],
      [255, 0, 77],
      [255, 163, 0],
      [255, 236, 39],
      [0, 228, 54],
      [41, 173, 255],
      [131, 118, 156],
      [255, 119, 168],
      [255, 204, 170],
    ],
    note: 'PICO-8 fantasy-console 16-colour system palette (exact spec values).',
  },
  {
    key: 'gruvbox',
    name: 'Gruvbox Dark',
    colors: [
      [29, 32, 33],
      [40, 40, 40],
      [204, 36, 29],
      [152, 151, 26],
      [215, 153, 33],
      [69, 133, 136],
      [177, 98, 134],
      [104, 157, 106],
      [168, 153, 132],
      [235, 219, 178],
      [251, 73, 52],
      [184, 187, 38],
      [250, 189, 47],
      [131, 165, 152],
      [211, 134, 155],
      [142, 192, 124],
    ],
    note: 'Gruvbox dark by Pavel Pertsev — bg/fg plus normal and bright accents.',
  },
  {
    key: 'solarized',
    name: 'Solarized',
    colors: [
      [0, 43, 54],
      [7, 54, 66],
      [88, 110, 117],
      [101, 123, 131],
      [131, 148, 150],
      [147, 161, 161],
      [238, 232, 213],
      [253, 246, 227],
      [181, 137, 0],
      [203, 75, 22],
      [220, 50, 47],
      [211, 54, 130],
      [108, 113, 196],
      [38, 139, 210],
      [42, 161, 152],
      [133, 153, 0],
    ],
    note: 'Solarized by Ethan Schoonover — the 8 base tones plus 8 accents.',
  },
  {
    key: 'amber',
    name: 'Amber Terminal',
    colors: [
      [0, 0, 0],
      [40, 26, 0],
      [122, 74, 0],
      [255, 176, 0],
    ],
    note: 'P3-style amber CRT phosphor ramp (#ffb000) over black.',
  },
  {
    key: 'green-phosphor',
    name: 'Green Phosphor',
    colors: [
      [0, 0, 0],
      [0, 26, 0],
      [0, 102, 20],
      [51, 255, 51],
    ],
    note: 'P1-style green CRT phosphor ramp over black.',
  },
];

/** Registry keyed by slug for O(1) lookup from the UI/mode layer. */
export const PALETTE_BY_KEY: Record<string, Palette> = Object.fromEntries(
  PALETTES.map((p) => [p.key, p]),
);

export function getPalette(key: string): Palette | undefined {
  return PALETTE_BY_KEY[key];
}

/* ------------------------------------------------------------------ */
/* Chroma modes                                                        */
/* ------------------------------------------------------------------ */

/**
 * How colour is quantised before the dither kernel runs:
 *  - mono:    collapse to Rec.709 luminance, dither against a grey ramp.
 *  - rgb:     dither each channel independently against its own ramp.
 *  - palette: quantise to the currently selected named palette.
 */
export type ChromaMode = 'mono' | 'rgb' | 'palette';

export const CHROMA_MODES: Record<ChromaMode, string> = {
  mono: 'Luminance only, dithered to a grey ramp.',
  rgb: 'Per-channel independent dither.',
  palette: 'Quantise to the selected palette.',
};

/** Grey ramp with `levels` evenly spaced tones, black→white. `levels >= 2`. */
export function greyRamp(levels: number): RGBTuple[] {
  const n = Math.max(2, Math.floor(levels));
  return Array.from({ length: n }, (_, i) => {
    const v = Math.round((i / (n - 1)) * 255);
    return [v, v, v] as RGBTuple;
  });
}

/**
 * Palette resolved for a given chroma mode. `mono` and `rgb` both reduce to a
 * shared grey ramp (per-channel dithering against a grey ramp is what produces
 * independent RGB quantisation); `palette` passes the selection through.
 */
export function resolveChromaPalette(
  mode: ChromaMode,
  selected: ReadonlyArray<RGBTuple>,
  levels = 4,
): RGBTuple[] {
  if (mode === 'palette') return selected.map((c) => [...c] as RGBTuple);
  return greyRamp(levels);
}

/** Collapse an RGBA grid buffer to luminance in place (for `mono`). */
export function toLuminance(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.round(luminance(data[i], data[i + 1], data[i + 2]) * 255);
    data[i] = l;
    data[i + 1] = l;
    data[i + 2] = l;
  }
}
