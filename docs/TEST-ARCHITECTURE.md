# 测试架构文档

> AutoMater 引擎测试分层策略 v2.0 (2026-03-02)

## 总览

| 指标 | 当前值 | 短期目标 | 长期目标 |
|------|--------|----------|----------|
| 测试文件 | 20 | 25+ | 35+ |
| 测试用例 | 383 | 450+ | 600+ |
| 语句覆盖率 | 18.0% | 25% | 50% |
| 已测模块 | 20/55+ | 25/55 | 40/55 |

## 分层测试策略

### Layer 1: 纯逻辑模块 (无外部依赖)

**特征**: 无 Electron/DB/FS 依赖，可直接 import 测试

| 模块 | 行数 | 状态 | 覆盖率 |
|------|------|------|--------|
| `constants.ts` | 88 | ✅ 已测 | 100% |
| `logger.ts` | 192 | ✅ 已测 | 91% |
| `model-selector.ts` | 182 | ✅ 已测 | 95% |
| `output-parser.ts` | 393 | ✅ 已测 | 82% |
| `guards.ts` | 607 | ✅ 已测 | 85% |
| `prompts.ts` | 648 | ✅ 已测 | 100% |
| `context-compaction.ts` | 245 | ✅ 已测 | **100%** |
| `react-resilience.ts` | 281 | ✅ 已测 | **100%** |
| `planner.ts` | 164 | ✅ 已测 | **100%** |
| `tool-registry.ts` | 1164 | ✅ 已测 | **97%** |

### Layer 2: FS/文件依赖模块

**特征**: 需要 `fs` 操作，使用 `os.tmpdir()` 或 vi.mock('fs')

| 模块 | 行数 | 状态 | 覆盖率 |
|------|------|------|--------|
| `file-writer.ts` | 152 | ✅ 已测 | 97% |
| `decision-log.ts` | 355 | ✅ 已测 | 95% |
| `file-lock.ts` | 152 | ✅ 已测 | 100% |
| `extended-tools.ts` | 141 | ✅ 已测 | 93% |
| `memory-system.ts` | 287 | ✅ 已测 | 86% |
| `code-graph.ts` | 470 | ✅ 已测 | 84% |
| `repo-map.ts` | 226 | ✅ 已测 | 89% |
| `memory-layers.ts` | 210 | ✅ 已测 | **100%** |
| `doc-manager.ts` | 408 | ⬜ 待测 | - |
| `git-provider.ts` | 279 | ⬜ 待测 | - |

### Layer 3: DB 依赖模块

**特征**: 需要 `better-sqlite3`，通过 `__mocks__/db.ts` 提供 `:memory:` DB

| 模块 | 行数 | 状态 | 备注 |
|------|------|------|------|
| `event-store.ts` | 378 | ⚠️ stub 测试 | native 不可用时 skip (15%) |
| `agent-manager.ts` | 301 | ⬜ 待测 | |
| `context-collector.ts` | 749 | ⬜ 待测 | |
| `conversation-backup.ts` | 712 | ⬜ 待测 | 需 Electron app mock |
| `mission.ts` | 328 | ⬜ 待测 | |

### Layer 4: LLM + DB 模块

| 模块 | 行数 | 状态 |
|------|------|------|
| `llm-client.ts` | 575 | ✅ 部分测 (8%) |
| `react-loop.ts` | 967 | ⬜ 待测 |
| `qa-loop.ts` | 372 | ⬜ 待测 |
| `orchestrator.ts` | 631 | ⬜ 待测 |

### Layer 5: 复杂外部依赖 (MCP/Playwright/Docker)

| 模块 | 行数 | 状态 |
|------|------|------|
| `mcp-client.ts` | 566 | ⬜ 待测 |
| `browser-tools.ts` | 494 | ⬜ 待测 |
| `docker-sandbox.ts` | 396 | ⬜ 待测 |
| `tool-executor.ts` | 1180 | ⬜ 待测 |
| `skill-evolution.ts` | 866 | ⬜ 待测 |

## Mock 架构

```
__mocks__/
├── electron.ts       # Electron API stub (app, ipcMain, BrowserWindow, dialog)
└── db.ts             # better-sqlite3 :memory: mock (惰性初始化 + 优雅降级)
```

### vitest 别名配置 (`vitest.config.ts`)
```ts
alias: {
  electron: './__mocks__/electron.ts',
  '../db': './__mocks__/db.ts',
}
```

### FS mock 策略
- **方式 A** (Layer 2 大多数): 使用真实文件系统 + `os.tmpdir()` 临时目录
- **方式 B** (memory-layers 等): 使用 `vi.mock('fs')` 模块级 mock + 闭包状态

```ts
// 方式 A
beforeEach(() => { tmpDir = fs.mkdtempSync(...); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

// 方式 B (memory-layers.test.ts 范例)
const mockFiles: Record<string, string> = {};
vi.mock('fs', () => ({
  default: { existsSync: (p) => p in mockFiles, ... }
}));
```

## 命令

| 命令 | 用途 |
|------|------|
| `pnpm test` | 运行全部测试 |
| `pnpm test:watch` | 监听模式 |
| `pnpm test:coverage` | 带覆盖率报告 |
| `pnpm quality-gate` | tsc + vitest + coverage 全链路检查 |
| `pnpm quality-gate:quick` | 跳过 tsc 的快速检查 |

## 质量门禁

- **Coverage thresholds** (vitest.config.ts): statements ≥ 17%, branches ≥ 16%, functions ≥ 19%, lines ≥ 17%
- 随测试覆盖增加逐步提高至 25% → 50%
- HTML 覆盖率报告: `./coverage/index.html`
- JSON 摘要: `./coverage/coverage-summary.json`
- **Pre-commit hook**: 自动运行 tsc + vitest (`scripts/install-hooks.js`)

## 增加新测试的规范

1. 测试文件放在 `electron/engine/__tests__/` 目录
2. 命名: `<module-name>.test.ts`
3. 使用 `describe/test` 嵌套结构，按功能分组
4. 每个 `describe` 块对应一个被测函数
5. 边界值和异常路径必须测试
6. 涉及 FS 的测试使用 temp dir + cleanup 或 vi.mock
7. 涉及 DB 的测试从 `'../db'` import (自动走 mock)
8. 需要 SQLite 的测试使用 `describe.skipIf(!sqliteAvailable)` 模式优雅降级
