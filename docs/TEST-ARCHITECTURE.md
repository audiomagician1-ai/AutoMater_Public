# 测试架构文档

> AutoMater 引擎测试分层策略 v1.0 (2026-03-02)

## 总览

| 指标 | 当前值 | 短期目标 | 长期目标 |
|------|--------|----------|----------|
| 测试文件 | 8 | 15+ | 30+ |
| 测试用例 | 159 | 300+ | 500+ |
| 语句覆盖率 | 8.6% | 25% | 50% |
| 已测模块 | 7/50 | 15/50 | 35/50 |

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

### Layer 2: FS/文件依赖模块

**特征**: 需要 `fs` 操作，使用 `os.tmpdir()` 创建临时目录

| 模块 | 行数 | 状态 | 覆盖率 |
|------|------|------|--------|
| `file-writer.ts` | 152 | ✅ 已测 | 97% |
| `decision-log.ts` | 355 | ✅ 已测 | 95% |
| `file-lock.ts` | 152 | ⬜ 待测 | - |
| `doc-manager.ts` | 408 | ⬜ 待测 | - |
| `code-graph.ts` | 470 | ⬜ 待测 | - |
| `git-provider.ts` | 279 | ⬜ 待测 | - |
| `memory-system.ts` | 287 | ⬜ 待测 | - |

### Layer 3: DB 依赖模块

**特征**: 需要 `better-sqlite3`，通过 `__mocks__/db.ts` 提供 `:memory:` DB

| 模块 | 行数 | 状态 |
|------|------|------|
| `event-store.ts` | 378 | ⬜ 待测 |
| `agent-manager.ts` | 301 | ⬜ 待测 |
| `context-collector.ts` | 1162 | ⬜ 待测 |
| `conversation-backup.ts` | 712 | ⬜ 待测 |
| `mission.ts` | 328 | ⬜ 待测 |

### Layer 4: LLM + DB 模块

**特征**: 需要 mock LLM API 响应

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
| `tool-registry.ts` | 1154 | ⬜ 待测 |
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
不 mock `fs` 模块，使用真实文件系统 + `os.tmpdir()` 临时目录：
```ts
beforeEach(() => { tmpDir = fs.mkdtempSync(...); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });
```

## 命令

| 命令 | 用途 |
|------|------|
| `pnpm test` | 运行全部测试 |
| `pnpm test:watch` | 监听模式 |
| `pnpm test:coverage` | 带覆盖率报告 |

## 质量门禁

- **Coverage thresholds** (vitest.config.ts): statements/branches/functions/lines ≥ 8% (起步值)
- 随测试覆盖增加逐步提高至 25% → 50%
- HTML 覆盖率报告: `./coverage/index.html`
- JSON 摘要: `./coverage/coverage-summary.json`

## 增加新测试的规范

1. 测试文件放在 `electron/engine/__tests__/` 目录
2. 命名: `<module-name>.test.ts`
3. 使用 `describe/test` 嵌套结构，按功能分组
4. 每个 `describe` 块对应一个被测函数
5. 边界值和异常路径必须测试
6. 涉及 FS 的测试使用 temp dir + cleanup
7. 涉及 DB 的测试从 `'../db'` import (自动走 mock)
