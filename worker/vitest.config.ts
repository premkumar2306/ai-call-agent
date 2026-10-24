import { defineConfig } from 'vitest/config';

// Unit tests for pure logic (signatures, parsing, validation). They run in
// Node, so modules that import `cloudflare:workers` get a stub.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    alias: { 'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname },
  },
});
