/**
 * Vitest setup — runs before any test module imports.
 *
 * braille.ts builds a GridSampler at module load, which needs an
 * OffscreenCanvas. Installing the node-canvas polyfill here (before the test
 * files' static imports of the mode registries) lets those imports succeed.
 */
import { installCanvasPolyfill } from './harness';

installCanvasPolyfill();
