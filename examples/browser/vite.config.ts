import { defineConfig } from 'vite';

// Cross-origin isolation is required for SharedArrayBuffer (and therefore the
// engine) in the browser. Without these headers `create()` throws — there is no
// serial fallback.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
