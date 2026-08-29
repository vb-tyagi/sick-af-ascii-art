/**
 * Point lights with per-character glow — T22.
 *
 * OUR design. The reference only advertises the feature ("Point lights with
 * per-character glow"); the model here is ours, built on standard softened
 * inverse-square falloff.
 *
 * The whole point: a light does not merely tint. It MULTIPLIES the cell colour
 * AND, by brightening it, raises the cell's Rec.709 luminance — and luminance is
 * what selects the glyph downstream. So this runs BEFORE luminance is computed,
 * mutating the same grid RGBA buffer the glyph modes read, exactly like
 * applyColorPipeline. One buffer feeds both the fill colour and the glyph
 * choice, so the coupling is automatic: brighter cell → lighter glyph. That
 * character change IS the per-character glow.
 *
 * Coordinates are NORMALISED 0..1 over the grid, not pixels, so lights keep
 * their position and reach across a resize.
 */

import { luminance } from './color';

export interface PointLight {
  /** Centre in normalised 0..1 grid space. */
  x: number;
  y: number;
  /** Falloff radius in normalised units (distance at which contribution ≈ half). */
  radius: number;
  /** CSS hex, the light's colour. */
  color: string;
  /** Brightness scalar; 0 contributes nothing. */
  intensity: number;
}

export interface LightsOptions {
  /** Defaults OFF; off is a genuine no-op. */
  enabled: boolean;
  lights: PointLight[];
  /** 0..1 additive bloom folded on top of the multiplicative gain. 0 disables it. */
  bloom: number;
}

export const DEFAULT_LIGHTS: LightsOptions = {
  enabled: false,
  lights: [],
  bloom: 0,
};

interface RGB01 { r: number; g: number; b: number }

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Parse #rgb / #rrggbb to 0..1 channels; unparseable input falls back to white. */
function parseHex(hex: string): RGB01 {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 1, g: 1, b: 1 };
  const n = parseInt(h, 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}

interface PreparedLight extends RGB01 {
  x: number;
  y: number;
  invR2: number;
  intensity: number;
}

/**
 * Softened inverse-square falloff. Pure 1/dist² diverges at the light centre;
 * the +1 keeps it finite there (contribution = intensity at dist 0) and is not
 * optional. `invR2` is 1/radius², precomputed so the per-cell loop avoids a
 * divide.
 */
function contribution(light: PreparedLight, u: number, v: number): number {
  const dx = u - light.x;
  const dy = v - light.y;
  const d2 = dx * dx + dy * dy;
  return light.intensity / (1 + d2 * light.invR2);
}

/**
 * Accumulate the per-channel colour gain at a normalised point from all lights.
 * Each channel is weighted by the light's own colour, so a red light reddens as
 * it brightens. Exported for tests and for any caller that wants the raw field.
 */
export function lightGainAt(
  lights: PointLight[],
  u: number,
  v: number,
): RGB01 {
  const gain: RGB01 = { r: 0, g: 0, b: 0 };
  for (const l of lights) {
    if (l.intensity <= 0 || l.radius <= 0) continue;
    const prepared: PreparedLight = {
      x: l.x,
      y: l.y,
      invR2: 1 / (l.radius * l.radius),
      intensity: l.intensity,
      ...parseHex(l.color),
    };
    const c = contribution(prepared, u, v);
    gain.r += c * prepared.r;
    gain.g += c * prepared.g;
    gain.b += c * prepared.b;
  }
  return gain;
}

/**
 * Mutates the grid RGBA buffer in place. Each cell's colour is multiplied by
 * (1 + gain) — lit cells brighten and take on the light's hue, unlit cells are
 * untouched (gain → 0). Optional bloom adds a further scaled term on top for a
 * softer halo. Run this before luminanceToChar so the raised luminance reaches
 * the glyph picker.
 *
 * Off (disabled, no lights, or every light dark) issues no writes at all.
 */
export function applyLights(
  data: Uint8ClampedArray,
  cols: number,
  rows: number,
  opts: LightsOptions,
): void {
  if (!opts.enabled) return;
  const active = opts.lights.filter((l) => l.intensity > 0 && l.radius > 0);
  if (active.length === 0) return;

  const bloom = opts.bloom > 0 ? opts.bloom : 0;

  for (let row = 0; row < rows; row++) {
    // Cell-centre sampling: (index + 0.5) / count maps the grid onto 0..1.
    const v = (row + 0.5) / rows;
    for (let col = 0; col < cols; col++) {
      const u = (col + 0.5) / cols;
      const g = lightGainAt(active, u, v);
      if (g.r === 0 && g.g === 0 && g.b === 0) continue;

      const i = (row * cols + col) * 4;
      // Multiplicative core: colour * (1 + gain). Additive bloom is layered on
      // as a flat colour term scaled by the same gain, so it only appears where
      // there is light.
      data[i] = clamp255(data[i] * (1 + g.r) + bloom * g.r * 255);
      data[i + 1] = clamp255(data[i + 1] * (1 + g.g) + bloom * g.g * 255);
      data[i + 2] = clamp255(data[i + 2] * (1 + g.b) + bloom * g.b * 255);
    }
  }
}

/**
 * Convenience readout of the effective luminance a light field produces for a
 * given base cell — the quantity that, downstream, selects the glyph. Purely
 * derived from applyLights' formula; handy for tests that assert the glyph
 * actually shifts.
 */
export function litLuminance(
  base: { r: number; g: number; b: number },
  cols: number,
  rows: number,
  col: number,
  row: number,
  opts: LightsOptions,
): number {
  const px = new Uint8ClampedArray(cols * rows * 4);
  const i = (row * cols + col) * 4;
  px[i] = base.r;
  px[i + 1] = base.g;
  px[i + 2] = base.b;
  applyLights(px, cols, rows, opts);
  return luminance(px[i], px[i + 1], px[i + 2]);
}
