/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  rules: {
    // ── TypeScript 质量 ──
    '@typescript-eslint/no-explicit-any': 'warn',          // 逐步消灭 any
    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    }],
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/no-non-null-assertion': 'warn',

    // ── 错误处理 ──
    'no-empty': ['error', { allowEmptyCatch: false }],     // 禁止空 catch

    // ── React Hooks ──
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',

    // ── 通用 ──
    'no-console': ['warn', { allow: ['warn', 'error'] }],  // 清理 console.log
    'prefer-const': 'warn',
    'no-var': 'error',
  },
  ignorePatterns: [
    'dist/', 'dist-electron/', 'release/', 'node_modules/',
    '*.js', '*.cjs', '*.mjs',  // 只检查 TS/TSX
    '!.eslintrc.cjs',
  ],
  settings: {
    react: { version: 'detect' },
  },
};
