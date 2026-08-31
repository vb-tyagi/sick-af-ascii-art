/**
 * Control sidebar — W7.T27.
 *
 * The whole control surface (TEARDOWN §3) as one panel: ten collapsible
 * sections of range/select/toggle/text/swatch/pill controls, wired to the live
 * engine. This is OUR design identity — the reference dictates WHICH controls
 * exist and their exact defaults, nothing about how they look or group.
 *
 * Two load-bearing decisions the code cannot show on its own:
 *
 * 1. ONE RENDER PER FRAME. Every control writes into `state` and calls
 *    `schedule()`; the actual `renderer.setOptions()`/`markDirty()` runs once on
 *    the next rAF, no matter how many input events a slider drag fired. A drag
 *    emitting 200 events/sec must still cost exactly one render per frame.
 *
 * 2. THE ENGINE SEAM. Not every control maps onto `RenderOptions`. Font/colour/
 *    ramp/tint go straight to `renderer.setOptions()`. Post-FX toggles mutate
 *    the shared `PostFxChain` in place. Everything else (backdrop, blur, lights,
 *    mask, animation, the character toggles) has no renderer field yet — the
 *    full `state` is handed to `onChange` so the app layer consumes it. The
 *    sidebar owns the controls, not the interpretation.
 */

import type { Renderer } from '@sick-af/engine/renderer';
import type { PostFxChain } from '@sick-af/engine/postfx/chain';
import type { ColorFilter } from '@sick-af/engine/color';
import { DEFAULT_TINT, type TintOptions, type BlendMode } from '@sick-af/engine/tint';
import { DEFAULT_BACKDROP, type BackdropOptions, type BackdropMode } from '@sick-af/engine/backdrop';
import { DEFAULT_LIGHTS, type LightsOptions } from '@sick-af/engine/lights';
import { PALETTES } from '@sick-af/engine/palettes';
import type { DitherAlgorithm, RGBTuple } from '@sick-af/engine/dither';
import type { DitherRenderOptions } from '@sick-af/engine/modes/dither';

/** Concrete family handed to the grid solver — must be a real measurable font, not a CSS var. */
const FONT_FAMILY = '"JetBrains Mono", monospace';

/** The 15 style modes (TEARDOWN §3.1). Registry key + human label. */
const STYLE_MODES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'characters', label: 'Characters' },
  { id: 'dither', label: 'Dither' },
  { id: 'block-chars', label: 'Blocks' },
  { id: 'dots', label: 'Dots' },
  { id: 'mixed', label: 'Mixed' },
  { id: 'pixel', label: 'Pixel' },
  { id: 'mosaic', label: 'Mosaic' },
  { id: 'lego', label: 'Lego' },
  { id: 'cross', label: 'Cross' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'lines', label: 'Lines' },
  { id: 'diagonal', label: 'Diagonal' },
  { id: 'braille', label: 'Braille' },
  { id: '3d', label: 'Voxel' },
  { id: 'disco', label: 'Disco' },
  // Animated modes — self-driving (animated: true), so they need no toggle.
  { id: 'matrix', label: 'Matrix' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'wave', label: 'Wave' },
  { id: 'typewriter', label: 'Typewriter' },
];

type CharPreset = 'standard' | 'detailed' | 'minimal';

/** Preset ramps behind the Character Set select. Dark→light order, our choice of glyphs. */
export const CHAR_PRESETS: Record<CharPreset, string> = {
  standard: '@#S08Xx+=-;:. ',
  detailed: '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`. ',
  minimal: '@:. ',
};

/** Per-character composite mode (TEARDOWN §3.2). Distinct from the tint blend list. */
type CharBlend = 'source-over' | 'overlay' | 'color-dodge' | 'screen' | 'lighter';
const CHAR_BLENDS: readonly CharBlend[] = ['source-over', 'overlay', 'color-dodge', 'screen', 'lighter'];

/** The 8 colour filters (TEARDOWN §3.5). */
const COLOR_FILTERS: ReadonlyArray<{ value: ColorFilter; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'bw', label: 'B&W' },
  { value: 'sepia', label: 'Sepia' },
  { value: 'warm', label: 'Warm' },
  { value: 'cool', label: 'Cool' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'fade', label: 'Fade' },
  { value: 'cyber', label: 'Cyber' },
];

/** The 11 tint blend modes (TEARDOWN §3.5). */
const TINT_BLENDS: readonly BlendMode[] = [
  'multiply', 'overlay', 'screen', 'color', 'hue', 'saturation',
  'luminosity', 'soft-light', 'hard-light', 'color-burn', 'color-dodge',
];

/** The 4 backdrop modes (TEARDOWN §3.4). */
const BACKDROP_MODES: ReadonlyArray<{ value: BackdropMode; label: string }> = [
  { value: 'blur', label: 'Blur' },
  { value: 'solid', label: 'Solid' },
  { value: 'original', label: 'Original' },
  { value: 'none', label: 'None' },
];

/** The 8 advanced-blur types (TEARDOWN §3.6). */
type AdvBlurType =
  | 'off' | 'gaussian' | 'lens' | 'tilt-shift'
  | 'directional' | 'radial' | 'perspective' | 'progressive';
const ADV_BLUR_TYPES: readonly AdvBlurType[] = [
  'off', 'gaussian', 'lens', 'tilt-shift', 'directional', 'radial', 'perspective', 'progressive',
];

/**
 * The full control model. Defaults are wired verbatim from TEARDOWN §3 — the
 * single source of truth every default in this file traces back to.
 */
export interface SidebarState {
  mode: string;
  // Characters
  fontSize: number;
  charPreset: CharPreset;
  customChars: string;
  charBlend: CharBlend;
  charOpacity: number;
  invertMapping: boolean;
  dotGridOverlay: boolean;
  randomizeChars: boolean;
  // Intensity
  coverage: number;
  edgeEmphasis: number;
  density: number;
  brightness: number;
  contrast: number;
  // Backdrop
  backdrop: BackdropOptions;
  // Colour
  filter: ColorFilter;
  tint: TintOptions;
  saturation: number;
  grayscale: number;
  // Blur
  advBlurType: AdvBlurType;
  advBlurAmount: number;
  // Dither (only meaningful while mode === 'dither')
  ditherAlgorithm: DitherAlgorithm;
  /** Registry key from PALETTES, or 'grey4'. Resolved to colours on flush. */
  ditherPalette: string;
  // Lights
  lights: LightsOptions;
  // Mask
  maskEnabled: boolean;
}

export function initialState(): SidebarState {
  return {
    mode: 'characters',
    fontSize: 11,
    charPreset: 'standard',
    customChars: CHAR_PRESETS.standard,
    charBlend: 'source-over',
    charOpacity: 100,
    invertMapping: false,
    dotGridOverlay: false,
    randomizeChars: false,
    coverage: 85,
    edgeEmphasis: 0,
    density: 30,
    brightness: 0,
    contrast: 100,
    backdrop: { ...DEFAULT_BACKDROP },
    filter: 'none',
    tint: { ...DEFAULT_TINT },
    saturation: 100,
    grayscale: 0,
    advBlurType: 'off',
    advBlurAmount: 35,
    ditherAlgorithm: 'floyd-steinberg',
    ditherPalette: 'mono',
    lights: { ...DEFAULT_LIGHTS },
    maskEnabled: false,
  };
}

/**
 * Every kernel the engine ships, ordered error-diffusion first (best tonal
 * fidelity on stills) then the ordered/Bayer family (stateless, so cheap enough
 * for video), then the plain threshold.
 */
const DITHER_ALGORITHMS: ReadonlyArray<{ value: DitherAlgorithm; label: string }> = [
  { value: 'floyd-steinberg', label: 'Floyd–Steinberg' },
  { value: 'atkinson', label: 'Atkinson' },
  { value: 'burkes', label: 'Burkes' },
  { value: 'sierra', label: 'Sierra' },
  { value: 'sierra-lite', label: 'Sierra Lite' },
  { value: 'stucki', label: 'Stucki' },
  { value: 'jarvis', label: 'Jarvis–Judice–Ninke' },
  { value: 'bayer2', label: 'Bayer 2×2 (ordered)' },
  { value: 'bayer4', label: 'Bayer 4×4 (ordered)' },
  { value: 'bayer8', label: 'Bayer 8×8 (ordered)' },
  { value: 'threshold', label: 'Threshold (1-bit)' },
];

/** Palette key → sRGB colours; falls back to the first registry entry. */
function resolvePalette(key: string): readonly RGBTuple[] {
  return (PALETTES.find((p) => p.key === key) ?? PALETTES[0]).colors;
}

export interface SidebarConfig {
  renderer: Renderer;
  postfx: PostFxChain;
  /**
   * Fired (coalesced to one call per frame) with a fresh snapshot after each
   * change. The app wires the state that has no `RenderOptions` field yet —
   * backdrop, blur, lights, mask, animation, the character toggles.
   */
  onChange?: (state: Readonly<SidebarState>) => void;
  /**
   * Curated looks, injected rather than imported: `recipes.ts` already imports
   * this module, so importing it back would close a cycle. The app owns that
   * dependency and hands the list down.
   */
  presets?: ReadonlyArray<{ id: string; name: string; blurb: string }>;
  onPickPreset?(id: string): void;
  /** Copy a share link encoding the whole current look. */
  onCopyShareLink?(): void;
}

type Formatter = (v: number) => string;
const asInt: Formatter = (v) => String(Math.round(v));
const asPct: Formatter = (v) => `${Math.round(v)}%`;
const asPx: Formatter = (v) => `${Math.round(v)}px`;
const asSigned: Formatter = (v) => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Public handle returned by {@link createSidebar}. */
export interface Sidebar {
  readonly element: HTMLElement;
  getState(): Readonly<SidebarState>;
  /**
   * Replace the whole control state and rebuild the controls to match. Applying
   * a recipe mutates state wholesale, and every control renders its value at
   * build time — without a rebuild the canvas would update while the sidebar
   * kept showing the old numbers.
   */
  setState(next: SidebarState): void;
  destroy(): void;
}

class SidebarController implements Sidebar {
  readonly element: HTMLElement;

  private readonly renderer: Renderer;
  private readonly postfx: PostFxChain;
  private readonly onChange?: (s: Readonly<SidebarState>) => void;
  private readonly presets: ReadonlyArray<{ id: string; name: string; blurb: string }>;
  private readonly onPickPreset?: (id: string) => void;
  private readonly onCopyShareLink?: () => void;
  private readonly state = initialState();

  private frameHandle = 0;
  private fontDirty = true;
  private disposed = false;
  /** Held so the section can be hidden unless the dither mode is selected. */
  private ditherRoot?: HTMLDetailsElement;

  constructor(config: SidebarConfig) {
    this.renderer = config.renderer;
    this.postfx = config.postfx;
    this.onChange = config.onChange;
    this.presets = config.presets ?? [];
    this.onPickPreset = config.onPickPreset;
    this.onCopyShareLink = config.onCopyShareLink;

    this.element = el('aside', 'saa-sidebar');
    this.element.setAttribute('aria-label', 'SICK AF ASCII ART controls');
    this.build();
    // Push the defaults into the engine once, synchronously, so first paint matches.
    this.flush();
  }

  getState(): Readonly<SidebarState> {
    return this.state;
  }

  setState(next: SidebarState): void {
    Object.assign(this.state, next);
    // The grid solve keys off the font, which a recipe can change.
    this.fontDirty = true;
    this.element.replaceChildren();
    this.build();
    this.schedule();
  }

  destroy(): void {
    this.disposed = true;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.element.remove();
  }

  // --- scheduling ---------------------------------------------------------

  /** Coalesce any number of same-frame changes into a single render. */
  private schedule(): void {
    if (this.disposed || this.frameHandle) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0;
      this.flush();
    });
  }

  private flush(): void {
    const s = this.state;
    // Typed as the dither-mode superset so `dither` threads through without an
    // engine-side change: DitherRenderOptions extends RenderOptions, and the
    // dither mode reads opts.dither. Other modes ignore the field.
    const patch: Partial<DitherRenderOptions> = {
      mode: s.mode,
      dither: {
        algorithm: s.ditherAlgorithm,
        palette: resolvePalette(s.ditherPalette),
      },
      color: {
        brightness: s.brightness,
        contrast: s.contrast,
        saturation: s.saturation,
        grayscale: s.grayscale,
        filter: s.filter,
      },
      ramp: {
        ramp: s.customChars,
        invert: s.invertMapping,
        density: s.density,
        coverage: s.coverage,
      },
      tint: { ...s.tint },
      backdrop: { ...s.backdrop },
      advBlur: { type: s.advBlurType, amount: s.advBlurAmount },
      lights: s.lights,
    };
    // Only re-solve the grid when the font actually changed — that solve is the
    // expensive part, so folding it into every colour tweak would be wasteful.
    if (this.fontDirty) {
      patch.font = { fontSize: s.fontSize, fontFamily: FONT_FAMILY, lineHeight: 1 };
      this.fontDirty = false;
    }
    this.renderer.setOptions(patch);
    this.renderer.markDirty();
    this.onChange?.(s);
  }

  // --- DOM assembly -------------------------------------------------------

  private build(): void {
    const header = el('header', 'saa-head');
    header.append(el('h1', 'saa-title', 'SICK AF ASCII ART'));
    this.element.appendChild(header);

    const recipes = this.recipesSection();
    if (recipes) this.element.appendChild(recipes);
    this.element.appendChild(this.styleSection());
    this.element.appendChild(this.ditherSection());
    this.element.appendChild(this.charactersSection());
    this.element.appendChild(this.intensitySection());
    this.element.appendChild(this.backdropSection());
    this.element.appendChild(this.colorSection());
    this.element.appendChild(this.blurSection());
    this.element.appendChild(this.lightsSection());
    this.element.appendChild(this.maskSection());
    this.element.appendChild(this.postSection());
  }

  private section(title: string, open: boolean): { root: HTMLDetailsElement; body: HTMLDivElement } {
    const root = el('details', 'saa-section');
    root.open = open;
    const summary = el('summary', 'saa-section-head');
    summary.append(el('span', 'saa-section-title', title), el('span', 'saa-chev'));
    const body = el('div', 'saa-section-body');
    root.append(summary, body);
    return { root, body };
  }

  // --- control primitives -------------------------------------------------

  private range(
    body: HTMLElement,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    fmt: Formatter,
    onInput: (v: number) => void,
  ): void {
    const field = el('div', 'saa-field');
    const head = el('div', 'saa-field-head');
    const out = el('output', 'saa-readout', fmt(value));
    head.append(el('label', 'saa-label', label), out);
    const input = el('input', 'saa-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onInput(v);
      this.schedule();
    });
    field.append(head, input);
    body.appendChild(field);
  }

  private toggle(body: HTMLElement, label: string, value: boolean, onChange: (b: boolean) => void): void {
    const field = el('label', 'saa-field saa-toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.className = 'saa-switch';
    input.checked = value;
    input.addEventListener('change', () => {
      onChange(input.checked);
      this.schedule();
    });
    field.append(el('span', 'saa-label', label), input);
    body.appendChild(field);
  }

  private select<T extends string>(
    body: HTMLElement,
    label: string,
    value: T,
    options: ReadonlyArray<{ value: T; label: string }>,
    onChange: (v: T) => void,
  ): void {
    const field = el('div', 'saa-field');
    field.appendChild(el('label', 'saa-label', label));
    const sel = el('select', 'saa-select');
    for (const opt of options) {
      const o = el('option', undefined, opt.label);
      o.value = opt.value;
      if (opt.value === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      onChange(sel.value as T);
      this.schedule();
    });
    field.appendChild(sel);
    body.appendChild(field);
  }

  private text(body: HTMLElement, label: string, value: string, onChange: (v: string) => void): void {
    const field = el('div', 'saa-field');
    field.appendChild(el('label', 'saa-label', label));
    const input = el('input', 'saa-text');
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    input.addEventListener('input', () => {
      onChange(input.value);
      this.schedule();
    });
    field.appendChild(input);
    body.appendChild(field);
  }

  private swatch(
    body: HTMLElement,
    label: string,
    value: string,
    onChange: (hex: string) => void,
  ): void {
    const field = el('div', 'saa-field saa-swatch');
    field.appendChild(el('label', 'saa-label', label));
    const wrap = el('div', 'saa-swatch-wrap');
    const input = el('input', 'saa-color');
    input.type = 'color';
    input.value = value;
    const hex = el('span', 'saa-readout', value);
    input.addEventListener('input', () => {
      hex.textContent = input.value;
      onChange(input.value);
      this.schedule();
    });
    wrap.append(input, hex);
    field.appendChild(wrap);
    body.appendChild(field);
  }

  private pills<T extends string>(
    body: HTMLElement,
    value: T,
    options: ReadonlyArray<{ value: T; label: string }>,
    onChange: (v: T) => void,
  ): void {
    const group = el('div', 'saa-pills');
    group.setAttribute('role', 'radiogroup');
    let current = value;
    for (const opt of options) {
      const pill = el('button', 'saa-pill', opt.label);
      pill.type = 'button';
      pill.dataset.value = opt.value;
      pill.setAttribute('role', 'radio');
      const sync = (active: boolean) => {
        pill.classList.toggle('is-active', active);
        pill.setAttribute('aria-checked', String(active));
      };
      sync(opt.value === current);
      pill.addEventListener('click', () => {
        if (current === opt.value) return;
        current = opt.value;
        for (const child of Array.from(group.children)) {
          const on = (child as HTMLElement).dataset.value === opt.value;
          child.classList.toggle('is-active', on);
          child.setAttribute('aria-checked', String(on));
        }
        onChange(opt.value);
        this.schedule();
      });
      group.appendChild(pill);
    }
    body.appendChild(group);
  }

  // --- sections -----------------------------------------------------------

  /**
   * Curated looks + a share link. Rendered only when the app injects presets,
   * so the sidebar keeps working standalone (and in tests) without them.
   */
  private recipesSection(): HTMLElement | null {
    if (this.presets.length === 0 && !this.onCopyShareLink) return null;
    const { root, body } = this.section('Recipes', true);

    if (this.presets.length > 0) {
      const grid = el('div', 'saa-recipes');
      for (const p of this.presets) {
        const b = el('button', 'saa-recipe');
        b.type = 'button';
        b.title = p.blurb;
        b.append(el('span', 'saa-recipe-name', p.name));
        b.addEventListener('click', () => this.onPickPreset?.(p.id));
        grid.appendChild(b);
      }
      body.appendChild(grid);
    }

    if (this.onCopyShareLink) {
      const share = el('button', 'saa-share');
      share.type = 'button';
      share.append(el('span', undefined, 'Copy share link'));
      share.addEventListener('click', () => this.onCopyShareLink?.());
      body.appendChild(share);
    }

    return root;
  }

  private styleSection(): HTMLElement {
    const { root, body } = this.section('Style', true);
    this.pills(
      body,
      this.state.mode,
      STYLE_MODES.map((m) => ({ value: m.id, label: m.label })),
      (v) => {
        this.state.mode = v;
        this.syncDitherVisibility();
      },
    );
    return root;
  }

  /**
   * Dither controls. The engine ships eleven kernels and sixteen palettes; none
   * of it was reachable before this section existed. Shown only for the dither
   * mode — these options do nothing for the other fourteen, and a control that
   * silently no-ops is worse than one that is absent.
   */
  private ditherSection(): HTMLElement {
    const { root, body } = this.section('Dither', true);
    this.ditherRoot = root;

    this.select<DitherAlgorithm>(
      body,
      'Algorithm',
      this.state.ditherAlgorithm,
      DITHER_ALGORITHMS,
      (v) => {
        this.state.ditherAlgorithm = v;
      },
    );
    this.select(
      body,
      'Palette',
      this.state.ditherPalette,
      PALETTES.map((p) => ({ value: p.key, label: p.name })),
      (v) => {
        this.state.ditherPalette = v;
      },
    );

    this.syncDitherVisibility();
    return root;
  }

  private syncDitherVisibility(): void {
    if (this.ditherRoot) this.ditherRoot.hidden = this.state.mode !== 'dither';
  }

  private charactersSection(): HTMLElement {
    const { root, body } = this.section('Characters', true);
    this.range(body, 'Font Size', this.state.fontSize, 3, 80, 1, asInt, (v) => {
      this.state.fontSize = v;
      this.fontDirty = true;
    });
    this.select<CharPreset>(
      body,
      'Character Set',
      this.state.charPreset,
      [
        { value: 'standard', label: 'Standard' },
        { value: 'detailed', label: 'Detailed' },
        { value: 'minimal', label: 'Minimal' },
      ],
      (v) => {
        this.state.charPreset = v;
        this.state.customChars = CHAR_PRESETS[v];
        this.customCharsInput.value = CHAR_PRESETS[v];
      },
    );
    this.text(body, 'Chars', this.state.customChars, (v) => {
      this.state.customChars = v;
    });
    // Keep a handle so the preset select can reflect its ramp back into the field.
    this.customCharsInput = body.querySelector<HTMLInputElement>('.saa-text')!;
    this.select<CharBlend>(
      body,
      'Blend Mode',
      this.state.charBlend,
      CHAR_BLENDS.map((b) => ({ value: b, label: b })),
      (v) => {
        this.state.charBlend = v;
      },
    );
    this.range(body, 'Char Opacity', this.state.charOpacity, 0, 100, 1, asPct, (v) => {
      this.state.charOpacity = v;
    });
    this.toggle(body, 'Invert Mapping', this.state.invertMapping, (b) => {
      this.state.invertMapping = b;
    });
    this.toggle(body, 'Dot Grid Overlay', this.state.dotGridOverlay, (b) => {
      this.state.dotGridOverlay = b;
    });
    this.toggle(body, 'Randomize Characters', this.state.randomizeChars, (b) => {
      this.state.randomizeChars = b;
    });
    return root;
  }

  private intensitySection(): HTMLElement {
    const { root, body } = this.section('Intensity', true);
    this.range(body, 'Coverage', this.state.coverage, 0, 100, 1, asPct, (v) => {
      this.state.coverage = v;
    });
    this.range(body, 'Edge Emphasis', this.state.edgeEmphasis, 0, 100, 1, asPct, (v) => {
      this.state.edgeEmphasis = v;
    });
    this.range(body, 'Density', this.state.density, 0, 100, 1, asPct, (v) => {
      this.state.density = v;
    });
    this.range(body, 'Brightness', this.state.brightness, -100, 100, 1, asSigned, (v) => {
      this.state.brightness = v;
    });
    this.range(body, 'Contrast', this.state.contrast, -100, 100, 1, asSigned, (v) => {
      this.state.contrast = v;
    });
    return root;
  }

  private backdropSection(): HTMLElement {
    const { root, body } = this.section('Backdrop', false);
    this.select<BackdropMode>(
      body,
      'Mode',
      this.state.backdrop.mode,
      BACKDROP_MODES,
      (v) => {
        this.state.backdrop.mode = v;
      },
    );
    this.range(body, 'Blur', this.state.backdrop.blur, 0, 60, 1, asPx, (v) => {
      this.state.backdrop.blur = v;
    });
    this.range(body, 'Opacity', this.state.backdrop.opacity, 0, 100, 1, asPct, (v) => {
      this.state.backdrop.opacity = v;
    });
    return root;
  }

  private colorSection(): HTMLElement {
    const { root, body } = this.section('Color', false);
    this.pills<ColorFilter>(body, this.state.filter, COLOR_FILTERS, (v) => {
      this.state.filter = v;
    });
    this.swatch(body, 'Tint', this.state.tint.color, (hex) => {
      this.state.tint.color = hex;
    });
    this.range(body, 'Tint Opacity', this.state.tint.opacity, 0, 100, 1, asPct, (v) => {
      this.state.tint.opacity = v;
    });
    this.select<BlendMode>(
      body,
      'Blend',
      this.state.tint.blend,
      TINT_BLENDS.map((b) => ({ value: b, label: b })),
      (v) => {
        this.state.tint.blend = v;
      },
    );
    this.range(body, 'Saturation', this.state.saturation, 0, 200, 1, asPct, (v) => {
      this.state.saturation = v;
    });
    this.range(body, 'Grayscale', this.state.grayscale, 0, 100, 1, asPct, (v) => {
      this.state.grayscale = v;
    });
    return root;
  }

  private blurSection(): HTMLElement {
    const { root, body } = this.section('Blur', false);
    this.select<AdvBlurType>(
      body,
      'Type',
      this.state.advBlurType,
      ADV_BLUR_TYPES.map((t) => ({ value: t, label: t })),
      (v) => {
        this.state.advBlurType = v;
      },
    );
    this.range(body, 'Amount', this.state.advBlurAmount, 0, 100, 1, asInt, (v) => {
      this.state.advBlurAmount = v;
    });
    return root;
  }

  private lightsSection(): HTMLElement {
    const { root, body } = this.section('Lights', false);
    this.toggle(body, 'Point Lights', this.state.lights.enabled, (b) => {
      this.state.lights.enabled = b;
    });
    this.range(body, 'Glow', this.state.lights.bloom * 100, 0, 100, 1, asPct, (v) => {
      this.state.lights.bloom = v / 100;
    });
    return root;
  }

  private maskSection(): HTMLElement {
    const { root, body } = this.section('Mask', false);
    this.toggle(body, 'Restrict to Shape', this.state.maskEnabled, (b) => {
      this.state.maskEnabled = b;
    });
    return root;
  }

  private postSection(): HTMLElement {
    const { root, body } = this.section('Post-Processing', false);
    for (const effect of this.postfx.effects) {
      const field = el('div', 'saa-field saa-fx');
      const head = el('div', 'saa-field-head');
      const sw = el('input');
      sw.type = 'checkbox';
      sw.className = 'saa-switch';
      sw.checked = effect.enabled;
      head.append(el('label', 'saa-label', effect.label), sw);

      const [min, max] = effect.range;
      const out = el('output', 'saa-readout', asInt(effect.amount));
      const slider = el('input', 'saa-range');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '1';
      slider.value = String(effect.amount);
      slider.disabled = !effect.enabled;

      sw.addEventListener('change', () => {
        effect.enabled = sw.checked;
        slider.disabled = !sw.checked;
        field.classList.toggle('is-on', sw.checked);
        this.schedule();
      });
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        effect.amount = v;
        out.textContent = asInt(v);
        this.schedule();
      });

      field.classList.toggle('is-on', effect.enabled);
      field.append(head, out, slider);
      body.appendChild(field);
    }
    return root;
  }

  // Set once inside charactersSection(); the preset select writes the ramp back here.
  private customCharsInput!: HTMLInputElement;
}

/** Build the sidebar, mount it under `container`, and sync defaults into the engine. */
export function createSidebar(container: HTMLElement, config: SidebarConfig): Sidebar {
  const sidebar = new SidebarController(config);
  container.appendChild(sidebar.element);
  return sidebar;
}
