# 测试架构文档

> AutoMater 引擎测试分层策略 v3.0 (2026-03-02)

## 总览

| 指标 | 当前值 | 短期目标 | 长期目标 |
|------|--------|----------|----------|
| 测试文件 | 35 | 40+ | 50+ |
| 测试用例 | 705 (687 pass, 50 skip) | 800+ | 1000+ |
| 语句覆盖率 | 27.0% | 35% | 50% |
| 已测模块 | 30/60+ | 40/60 | 50/60 |

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
| `code-graph.ts` | 470 | ✅ 已测 | 60% |
| `repo-map.ts` | 226 | ✅ 已测 | 89% |
| `memory-layers.ts` | 210 | ✅ 已测 | **100%** |
| `doc-manager.ts` | 408 | ✅ 已测 | 65% |

### Layer 3: DB 依赖模块

**特征**: 需要 `better-sqlite3`，通过 `__mocks__/db.ts` 提供 `:memory:` DB

| 模块 | 行数 | 状态 | 覆盖率 | 备注 |
|------|------|------|--------|------|
| `event-store.ts` | 378 | ✅ 已测 | 3% (DB skip) | 27 tests, 25 skip when native unavailable |
| `conversation-backup.ts` | 727 | ✅ 已测 | 0.6% (DB skip) | 29 tests, 25 skip when native unavailable |
| `agent-manager.ts` | 301 | ✅ 已测 | 56% | Registry ops + budget check |
| `context-collector.ts` | 749 | ✅ 已测 | 29% | Pure helpers tested |
| `mission.ts` | 328 | ⬜ 待测 | |

### Layer 4: LLM + 复杂依赖模块

| 模块 | 行数 | 状态 | 覆盖率 |
|------|------|------|--------|
| `llm-client.ts` | 575 | ✅ 已测 | 58% |
| `react-loop.ts` | 1029 | ✅ 已测 | 1.3% | Type exports + caches tested |
| `tool-executor.ts` | 1435 | ✅ 已测 | **46%** | 106 tests, all sync+async dispatch |
| `qa-loop.ts` | 372 | ⬜ 待测 | |
| `orchestrator.ts` | 640 | ⬜ 待测 | |

### Layer 5: 探针/外部工具模块

| 模块 | 行数 | 状态 | 覆盖率 |
|------|------|------|--------|
| `probes/base-probe.ts` | 446 | ✅ 已测 | **48%** | Pure file utilities tested |
| `probes/*.ts` (子探针) | ~500 | ⬜ 待测 | 需 mock LLM |
| `probe-types.ts` | 265 | ✅ 类型验证 | (type-only) |
| `skill-evolution.ts` | 866 | ✅ 已测 | 57% |
| `search-provider.ts` | 596 | ✅ 已测 | 12% |
| `mcp-client.ts` | 566 | ⬜ 待测 | |
| `browser-tools.ts` | 494 | ⬜ 待测 | |
| `docker-sandbox.ts` | 421 | ⬜ 待测 | |

### 其他支持模块

| 模块 | 行数 | 状态 | 覆盖率 |
|------|------|------|--------|
| `ui-bridge.ts` | 63 | ✅ 已测 | 90% |
| `web-tools.ts` | 200 | ✅ 已测 | 100% |
| `workspace-git.ts` | 100 | ✅ 已测 | 100% |
| `cross-project.ts` | 260 | ✅ 已测 | 84% |
| `sub-agent-framework.ts` | 586 | ✅ 部分测 | 9% |
| `git-provider.ts` | 564 | ⬜ 待测 | |

## Mock 架构

```
__mocks__/
├── electron.ts       # Electron API stub (app, ipcMain, BrowserWindow, dialog, shell)
└── db.ts             # better-sqlite3 :memory: mock (惰性初始化 + 优雅降级)
```

### vitest 别名配置 (`vitest.config.ts`)
```ts
alias: {
  electron: './__mocks__/electron.ts',
  '../db': './__mocks__/db.ts',
}
```

### Mock 策略分类

| 策略 | 使用场景 | 示例 |
|------|----------|------|
| **真实 FS + tmpDir** | Layer 2 文件操作 | file-writer, decision-log |
| **vi.mock('fs')** | 需要精确控制 FS 行为 | memory-layers |
| **vi.mock 模块** | 重量级依赖隔离 | tool-executor (mock 20+ 依赖) |
| **__mocks__/db.ts** | DB 操作 (in-memory SQLite) | event-store, conversation-backup |
| **describe.skip** | native 模块不可用时 | better-sqlite3 版本不匹配 |

## 命令

| 命令 | 用途 |
|------|------|
| `pnpm test` | 运行全部测试 |
| `pnpm test:watch` | 监听模式 |
| `pnpm test:coverage` | 带覆盖率报告 |
| `pnpm quality-gate` | tsc + vitest + coverage 全链路检查 |
| `pnpm quality-gate:quick` | 跳过 tsc 的快速检查 |

## 质量门禁

- **Coverage thresholds** (vitest.config.ts):
  - statements ≥ 26%, branches ≥ 25%, functions ≥ 31%, lines ≥ 26%
- 随测试覆盖增加逐步提高至 35% → 50%
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
8. 需要 SQLite 的测试使用 `describeDb = hasRealSqlite ? describe : describe.skip` 模式优雅降级
9. 重量级模块测试: 先 `vi.mock` 所有依赖, 再 import 被测模块 (参考 tool-executor.test.ts)
