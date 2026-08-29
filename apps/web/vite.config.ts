import { defineConfig } from 'vite';

// Port 7272 is the project-standard dev port (unique on this machine, per the
// dev-server-ports rule). base is applied only for the production build so the
// GitHub Pages URL (/sick-af-ascii-art/) resolves assets correctly, while local
// dev stays at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sick-af-ascii-art/' : '/',
  server: { port: 7272, strictPort: true },
  preview: { port: 7272, strictPort: true },
  build: { target: 'es2022' },
}));
