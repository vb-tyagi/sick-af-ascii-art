import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PostFxChain } from '@sick-af/engine/postfx/chain';
import { initialState } from '../sidebar';
import {
  RECIPE_FORMAT_VERSION,
  RECIPE_PRESETS,
  applyRecipe,
  captureRecipe,
  deserialiseRecipe,
  findPreset,
  readRecipeFromHash,
  recipeShareUrl,
  serialiseRecipe,
} from '../recipes';

const makeChain = () =>
  new PostFxChain({
    createContext: (w, h) =>
      createCanvas(Math.max(1, w), Math.max(1, h)).getContext('2d') as unknown as CanvasRenderingContext2D,
  });

describe('recipe serialisation', () => {
  it('round-trips full state + post-fx through base64url', () => {
    const state = initialState();
    state.mode = 'dither';
    state.fontSize = 17;
    state.customChars = 'áé@#. ';
    state.tint = { color: '#123456', opacity: 42, blend: 'screen' };

    const chain = makeChain();
    chain.effects.find((e) => e.id === 'bloom')!.enabled = true;
    chain.effects.find((e) => e.id === 'bloom')!.amount = 63;

    const encoded = serialiseRecipe(captureRecipe(state, chain));
    const decoded = deserialiseRecipe(encoded)!;

    expect(decoded).not.toBeNull();
    expect(decoded.state.mode).toBe('dither');
    expect(decoded.state.fontSize).toBe(17);
    expect(decoded.state.customChars).toBe('áé@#. ');
    expect(decoded.state.tint).toEqual({ color: '#123456', opacity: 42, blend: 'screen' });
    expect(decoded.postfx).toEqual([{ id: 'bloom', amount: 63 }]);
  });

  it('applies a decoded recipe authoritatively, resetting the chain', () => {
    const chain = makeChain();
    // Pre-dirty the chain with an effect the recipe does NOT carry.
    chain.effects.find((e) => e.id === 'vignette')!.enabled = true;

    const source = initialState();
    source.brightness = 40;
    const srcChain = makeChain();
    srcChain.effects.find((e) => e.id === 'glitch')!.enabled = true;
    srcChain.effects.find((e) => e.id === 'glitch')!.amount = 22;

    const recipe = deserialiseRecipe(serialiseRecipe(captureRecipe(source, srcChain)))!;
    const target = initialState();
    applyRecipe(target, chain, recipe);

    expect(target.brightness).toBe(40);
    expect(chain.effects.find((e) => e.id === 'vignette')!.enabled).toBe(false);
    expect(chain.effects.find((e) => e.id === 'glitch')!.enabled).toBe(true);
    expect(chain.effects.find((e) => e.id === 'glitch')!.amount).toBe(22);
  });

  it('rejects a version mismatch instead of half-applying', () => {
    const state = initialState();
    const chain = makeChain();
    const encoded = serialiseRecipe(captureRecipe(state, chain));
    const raw = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    raw.v = RECIPE_FORMAT_VERSION + 1;
    const bumped = btoa(JSON.stringify(raw))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(deserialiseRecipe(bumped)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(deserialiseRecipe('not!valid!base64!!!')).toBeNull();
    expect(deserialiseRecipe('')).toBeNull();
  });

  it('reads a recipe out of a hash string', () => {
    const state = initialState();
    state.contrast = 33;
    const chain = makeChain();
    const url = recipeShareUrl(captureRecipe(state, chain), 'https://example.test/app');
    const hash = url.slice(url.indexOf('#'));
    const decoded = readRecipeFromHash(hash)!;
    expect(decoded.state.contrast).toBe(33);
  });
});

describe('curated presets', () => {
  it('ships at least six presets with unique ids', () => {
    expect(RECIPE_PRESETS.length).toBeGreaterThanOrEqual(6);
    const ids = new Set(RECIPE_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(RECIPE_PRESETS.length);
  });

  it('avoids the reference preset names', () => {
    const reserved = ['matrix', 'noir', 'vaporwave', 'bonsai', 'memento', 'cumulus'];
    for (const p of RECIPE_PRESETS) {
      expect(reserved).not.toContain(p.name.toLowerCase());
    }
  });

  it('builds applicable recipes', () => {
    const chain = makeChain();
    const target = initialState();
    const recipe = findPreset('neon-circuit')!.build();
    applyRecipe(target, chain, recipe);
    expect(target.filter).toBe('cyber');
    expect(chain.effects.find((e) => e.id === 'bloom')!.enabled).toBe(true);
  });
});
