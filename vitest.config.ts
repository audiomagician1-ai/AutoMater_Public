import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'dist-electron', 'release'],
    alias: {
      // Mock heavy native/Electron modules
      electron: new URL('./__mocks__/electron.ts', import.meta.url).pathname,
      '../db': new URL('./__mocks__/db.ts', import.meta.url).pathname,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['electron/engine/**/*.ts'],
      exclude: [
        'electron/engine/**/*.test.ts',
        'electron/engine/__tests__/**',
        'electron/engine/types.ts',       // pure type defs
      ],
      thresholds: {
        statements: 24,   // 2026-03-02: 24.7% actual → 门槛 24%
        branches: 21,     // 21.3% actual
        functions: 32,    // 32.7% actual
        lines: 24,        // 24.6% actual
      },
    },
  },
});
