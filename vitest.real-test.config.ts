/**
 * vitest config 专门用于运行真实环境集成测试
 *
 * 用法: npx vitest run --config vitest.real-test.config.ts
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    include: ['scripts/real-evolution-test.ts'],
    testTimeout: 600_000, // 10 min per test
    hookTimeout: 120_000,
    alias: {
      electron: path.resolve(__dirname, '__mocks__/electron.ts'),
      '../db': path.resolve(__dirname, '__mocks__/db.ts'),
    },
  },
});
