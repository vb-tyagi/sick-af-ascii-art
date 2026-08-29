/**
 * Recipes — W7.T30 (TEARDOWN §3.8).
 *
 * A recipe is the FULL option surface captured as one portable value: the whole
 * sidebar state plus the post-FX chain (which lives outside `SidebarState`, in
 * the shared `PostFxChain`). It round-trips through a compact JSON envelope →
 * base64url → the URL hash, so a look is shareable as a plain link and restored
 * on boot.
 *
 * Two decisions the code cannot show on its own:
 *
 * 1. THE FORMAT IS VERSIONED, and the version is the first thing checked on
 *    decode. The option shape WILL change; an unversioned link would silently
 *    deserialise into a mismatched shape and corrupt the studio the first time a
 *    field moves. A version bump instead retires old links cleanly (decode
 *    returns null → boot ignores it) rather than half-applying them.
 *
 * 2. UNKNOWN/MISSING FIELDS FALL BACK TO DEFAULTS, not to failure. Within a
 *    single format version the decoded state is merged onto `initialState()`, so
 *    a link that predates an *additive* field still loads — only a version bump
 *    (breaking change) rejects. Post-FX stores only ENABLED effects; apply first
 *    resets the whole chain to defaults, so a recipe fully determines the chain
 *    regardless of what was toggled before it loaded.
 */

import { initialState, CHAR_PRESETS, type SidebarState } from './sidebar';
import type { PostFxChain, EffectId } from '@sick-af/engine/postfx/chain';

/**
 * Serialised-format version. BUMP THIS whenever the shape of `SidebarState` or
 * the post-FX contract changes in a way that would misread an old link. Old
 * links then decode to null instead of applying against the wrong shape.
 */
export const RECIPE_FORMAT_VERSION = 1;

/** Hash parameter that carries the encoded recipe, e.g. `#r=<base64url>`. */
const HASH_KEY = 'r';

/** One captured post-FX entry. Only enabled effects are ever stored. */
export interface RecipePostFx {
  id: EffectId;
  amount: number;
}

/** The full, portable snapshot: sidebar state + the enabled post-FX entries. */
export interface RecipeState {
  version: number;
  state: SidebarState;
  postfx: RecipePostFx[];
}

// --- deep copy ------------------------------------------------------------

/** Deep-copy the nested option groups so a recipe never aliases live state. */
function cloneState(s: SidebarState): SidebarState {
  return {
    ...s,
    backdrop: { ...s.backdrop },
    tint: { ...s.tint },
    lights: {
      enabled: s.lights.enabled,
      bloom: s.lights.bloom,
      lights: s.lights.lights.map((l) => ({ ...l })),
    },
  };
}

// --- capture / apply ------------------------------------------------------

/** Snapshot the live sidebar state and post-FX chain into a portable recipe. */
export function captureRecipe(state: SidebarState, postfx: PostFxChain): RecipeState {
  return {
    version: RECIPE_FORMAT_VERSION,
    state: cloneState(state),
    postfx: postfx.effects
      .filter((e) => e.enabled)
      .map((e) => ({ id: e.id, amount: e.amount })),
  };
}

/**
 * Apply a recipe onto a live sidebar state object (mutated in place, keeping its
 * identity so the sidebar keeps rendering the same reference) and the shared
 * post-FX chain. The chain is fully reset first, so the recipe is authoritative.
 */
export function applyRecipe(
  target: SidebarState,
  postfx: PostFxChain,
  recipe: RecipeState,
): void {
  Object.assign(target, cloneState(recipe.state));

  for (const effect of postfx.effects) {
    effect.enabled = false;
    effect.amount = effect.default;
  }
  const byId = new Map(recipe.postfx.map((e) => [e.id, e]));
  for (const effect of postfx.effects) {
    const entry = byId.get(effect.id);
    if (entry) {
      effect.enabled = true;
      effect.amount = entry.amount;
    }
  }
}

// --- base64url ------------------------------------------------------------

/** UTF-8 → base64url. `btoa` is byte-oriented, so encode to bytes first. */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → UTF-8. Throws on malformed input; callers guard with try/catch. */
function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// --- serialise / deserialise ---------------------------------------------

/** The wire envelope: short keys, enabled-only post-FX as [id, amount] tuples. */
interface Envelope {
  v: number;
  s: SidebarState;
  fx: Array<[EffectId, number]>;
}

/** Serialise a recipe to a compact base64url string for a URL hash. */
export function serialiseRecipe(recipe: RecipeState): string {
  const envelope: Envelope = {
    v: recipe.version,
    s: recipe.state,
    fx: recipe.postfx.map((e) => [e.id, e.amount]),
  };
  return toBase64Url(JSON.stringify(envelope));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Merge a decoded, possibly-partial state onto the current defaults. */
function coerceState(raw: unknown): SidebarState {
  const base = initialState();
  if (!isRecord(raw)) return base;
  const backdrop = isRecord(raw.backdrop) ? raw.backdrop : {};
  const tint = isRecord(raw.tint) ? raw.tint : {};
  const lights = isRecord(raw.lights) ? raw.lights : {};
  return {
    ...base,
    ...(raw as Partial<SidebarState>),
    backdrop: { ...base.backdrop, ...backdrop },
    tint: { ...base.tint, ...tint },
    lights: {
      ...base.lights,
      ...lights,
      lights: Array.isArray(lights.lights)
        ? (lights.lights as SidebarState['lights']['lights'])
        : base.lights.lights,
    },
  };
}

/** Decode a post-FX tuple list, dropping anything malformed. */
function coercePostFx(raw: unknown): RecipePostFx[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipePostFx[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
      out.push({ id: entry[0] as EffectId, amount: entry[1] });
    }
  }
  return out;
}

/**
 * Decode a base64url recipe. Returns null — never throws — for malformed input
 * or a version mismatch, so a stale or corrupt link is simply ignored on boot.
 */
export function deserialiseRecipe(encoded: string): RecipeState | null {
  let json: string;
  try {
    json = fromBase64Url(encoded);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== RECIPE_FORMAT_VERSION) return null;
  return {
    version: RECIPE_FORMAT_VERSION,
    state: coerceState(raw.s),
    postfx: coercePostFx(raw.fx),
  };
}

// --- URL hash + sharing ---------------------------------------------------

const currentHash = (): string =>
  typeof location !== 'undefined' ? location.hash : '';

/** Read and decode the recipe embedded in a URL hash (defaults to the live one). */
export function readRecipeFromHash(hash: string = currentHash()): RecipeState | null {
  const query = hash.startsWith('#') ? hash.slice(1) : hash;
  const encoded = new URLSearchParams(query).get(HASH_KEY);
  return encoded ? deserialiseRecipe(encoded) : null;
}

/** Write a recipe into the live URL hash, preserving any other hash params. */
export function writeRecipeToHash(recipe: RecipeState): void {
  if (typeof location === 'undefined') return;
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  params.set(HASH_KEY, serialiseRecipe(recipe));
  location.hash = params.toString();
}

/** A full shareable URL for a recipe. `base` overrides the current page origin. */
export function recipeShareUrl(recipe: RecipeState, base?: string): string {
  const origin =
    base ??
    (typeof location !== 'undefined' ? location.origin + location.pathname : '');
  const params = new URLSearchParams();
  params.set(HASH_KEY, serialiseRecipe(recipe));
  return `${origin}#${params.toString()}`;
}

/** Boot hook: if the URL carries a recipe, apply it. Returns what was applied. */
export function loadRecipeFromHashOnBoot(
  target: SidebarState,
  postfx: PostFxChain,
): RecipeState | null {
  const recipe = readRecipeFromHash();
  if (recipe) applyRecipe(target, postfx, recipe);
  return recipe;
}

// --- curated presets ------------------------------------------------------

/**
 * A named starting point. Our own design and naming — deliberately NOT the
 * reference's set. `build` returns a complete, self-contained recipe.
 */
export interface RecipePreset {
  id: string;
  name: string;
  blurb: string;
  build(): RecipeState;
}

/** Build a full recipe from partial state overrides + enabled post-FX entries. */
function preset(
  overrides: Partial<SidebarState>,
  postfx: RecipePostFx[] = [],
): RecipeState {
  const base = initialState();
  return {
    version: RECIPE_FORMAT_VERSION,
    state: {
      ...base,
      ...overrides,
      backdrop: { ...base.backdrop, ...(overrides.backdrop ?? {}) },
      tint: { ...base.tint, ...(overrides.tint ?? {}) },
      lights: { ...base.lights, ...(overrides.lights ?? {}) },
    },
    postfx,
  };
}

/**
 * Eight curated looks, all OUR design and naming. Order is presentation order.
 */
export const RECIPE_PRESETS: readonly RecipePreset[] = [
  {
    id: 'onyx-ink',
    name: 'Onyx Ink',
    blurb: 'Stark monochrome pen-and-ink at high contrast.',
    build: () =>
      preset({
        mode: 'characters',
        charPreset: 'detailed',
        customChars: CHAR_PRESETS.detailed,
        filter: 'bw',
        contrast: 45,
        density: 55,
        coverage: 92,
        fontSize: 10,
      }),
  },
  {
    id: 'neon-circuit',
    name: 'Neon Circuit',
    blurb: 'Cyber-cyan glyphs bleeding light on black.',
    build: () =>
      preset(
        {
          mode: 'characters',
          filter: 'cyber',
          saturation: 150,
          contrast: 30,
          tint: { color: '#00e5ff', opacity: 35, blend: 'screen' },
          backdrop: { mode: 'solid', blur: 0, opacity: 100 },
        },
        [
          { id: 'bloom', amount: 60 },
          { id: 'chromatic', amount: 25 },
        ],
      ),
  },
  {
    id: 'sunbleach',
    name: 'Sunbleach',
    blurb: 'Faded warm print left too long in the window.',
    build: () =>
      preset({
        mode: 'characters',
        filter: 'fade',
        brightness: 15,
        contrast: -10,
        saturation: 70,
        tint: { color: '#ffb26b', opacity: 22, blend: 'soft-light' },
      }),
  },
  {
    id: 'frostbyte',
    name: 'Frostbyte',
    blurb: 'Cold blue dither, crisp and clinical.',
    build: () =>
      preset({
        mode: 'dither',
        filter: 'cool',
        saturation: 120,
        contrast: 20,
        density: 45,
        tint: { color: '#7fb2ff', opacity: 18, blend: 'multiply' },
      }),
  },
  {
    id: 'emberfall',
    name: 'Emberfall',
    blurb: 'Sepia embers under a coat of grain.',
    build: () =>
      preset(
        {
          mode: 'characters',
          filter: 'sepia',
          brightness: 5,
          contrast: 25,
          tint: { color: '#c9591f', opacity: 20, blend: 'overlay' },
        },
        [
          { id: 'film-grain', amount: 40 },
          { id: 'vignette', amount: 55 },
        ],
      ),
  },
  {
    id: 'halcyon-drift',
    name: 'Halcyon Drift',
    blurb: 'Soft, dreamlike bloom over a blurred field.',
    build: () =>
      preset(
        {
          mode: 'dots',
          filter: 'vintage',
          saturation: 110,
          brightness: 10,
          backdrop: { mode: 'blur', blur: 24, opacity: 85 },
        },
        [{ id: 'bloom', amount: 45 }],
      ),
  },
  {
    id: 'riotgrid',
    name: 'Riotgrid',
    blurb: 'Blocky, glitch-shredded, unapologetically loud.',
    build: () =>
      preset(
        {
          mode: 'block-chars',
          filter: 'none',
          saturation: 160,
          contrast: 35,
          fontSize: 14,
        },
        [
          { id: 'glitch', amount: 50 },
          { id: 'rgb-split', amount: 30 },
        ],
      ),
  },
  {
    id: 'graphite-still',
    name: 'Graphite Still',
    blurb: 'Quiet pencil grey, minimal ramp, plenty of air.',
    build: () =>
      preset({
        mode: 'characters',
        charPreset: 'minimal',
        customChars: CHAR_PRESETS.minimal,
        filter: 'bw',
        brightness: 20,
        contrast: -5,
        density: 20,
        coverage: 70,
      }),
  },
];

/** Look a preset up by id. */
export function findPreset(id: string): RecipePreset | undefined {
  return RECIPE_PRESETS.find((p) => p.id === id);
}
