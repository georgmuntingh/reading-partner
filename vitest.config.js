import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globals: false,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
  },
});
