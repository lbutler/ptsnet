import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ptsnet',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'ptsnet.js' : 'ptsnet.cjs'),
    },
    sourcemap: true,
    rollupOptions: {
      // Keep epanet-js external so the WASM engine isn't bundled; worker_threads
      // is a Node builtin used only on the parallel path.
      external: ['epanet-js', 'node:worker_threads'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
