import { defineConfig } from 'vite';

// Cross-origin isolation is required for SharedArrayBuffer (and therefore the
// parallel engine) in the browser. Without these headers the demo still works,
// but `create({ parallel })` transparently falls back to the serial engine.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
