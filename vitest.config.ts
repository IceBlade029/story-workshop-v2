import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/main/__tests__/**/*.test.ts', 'src/renderer/__tests__/**/*.test.{ts,tsx}'],
    allowExternal: true,
  },
});
