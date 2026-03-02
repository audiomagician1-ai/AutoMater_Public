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
        statements: 26,   // 2026-03-02: 27.1% actual → Layer 6 (tool-executor, react-loop, probes)
        branches: 25,     // 26.4% actual
        functions: 31,    // 31.6% actual (codebase grew: probes/ + phases/ expanded)
        lines: 26,        // 27.2% actual
      },
    },
  },
});
