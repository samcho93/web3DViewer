import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: {
    // occt-import-js is CommonJS (needs pre-bundling); libredwg-web is ESM + wasm
    include: ['occt-import-js'],
    exclude: ['@mlightcad/libredwg-web'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173 },
});
