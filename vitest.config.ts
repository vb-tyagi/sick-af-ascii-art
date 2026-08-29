import { defineConfig } from 'vitest/config';

// Standalone Vitest config — deliberately NOT merged from vite.config.ts, whose
// 9090/strictPort server settings are irrelevant to the test runner. The setup
// file installs the node-canvas polyfill the mode-render tests need.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./scripts/vitest-setup.ts'],
  },
});
