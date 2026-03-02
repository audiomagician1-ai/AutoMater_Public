import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', 'dist-electron', 'release'],
    alias: {
      // Mock heavy native/Electron modules
      electron: path.resolve(__dirname, '__mocks__/electron.ts'),
      '../db': path.resolve(__dirname, '__mocks__/db.ts'),
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
      // NOTE: vitest v4 + v8 coverage 在 Windows/Node24 下统计为 0% (已知 bug #9457)
      // 阈值暂时禁用,等上游修复后重新启用。CI 中仅运行 vitest run (不含 --coverage)。
      // thresholds: { statements: 27, branches: 26, functions: 31, lines: 27 },
    },
  },
});
