# AgentForge 代码质量全面复盘报告

> 审查日期: 2026-03-02 | 审查版本: v6.0 (CLAUDE.md) / v12.1 (代码质量 Sprint)
> 代码库规模: **86 个 TS/TSX 文件, 31,288 行代码**
> 审查范围: electron/ (引擎+IPC) + src/ (前端) 全量扫描

---

## 一、执行摘要

AgentForge 在短时间内从 v0.1 迭代到 v6.0，功能覆盖面极广（5 阶段流水线、42+ 工具、6 种 Agent 角色、13 个 UI 页面、MCP 协议等），作为一个单人/小团队项目堪称激进。v12.1 代码质量 Sprint 已修复了一批关键问题（DB 迁移重构、orchestrator any 清零、71 个测试通过），但整体仍存在 **结构性技术债**。

### 健康度评分（满分 10）

| 维度 | 分数 | 说明 |
|------|------|------|
| **类型安全** | 5/10 | 389 处 `any` 残留，25+ 处 `catch(err: any)` |
| **测试覆盖** | 2/10 | 3 个测试文件 / 41 个引擎模块 = 7.3% 覆盖率 |
| **模块化** | 5/10 | orchestrator.ts 1599 行，OverviewPage.tsx 1340 行 |
| **错误处理** | 6/10 | 有 NonRetryableError + Circuit Breaker，但大量 catch 吞错误 |
| **安全性** | 6/10 | 沙箱黑名单+路径遍历防护，但 IPC 无输入验证 |
| **可维护性** | 4/10 | 9 处 require() 残留，大量魔数，文档和代码版本号不一致 |
| **构建/CI** | 3/10 | 无 CI 管线，仅手动 tsc + vitest |

**综合评分: 4.4/10** — 功能完整但工程质量需要系统性提升。

---

## 二、关键问题清单（按严重度排序）

### 🔴 P0 — 阻塞性/高风险

#### 2.1 测试覆盖率极低（2/10）

**现状**: 41 个引擎模块中仅 3 个有单元测试（`guards.test.ts`, `llm-client.test.ts`, `output-parser.test.ts`），测试行数 594 行，被测代码 17,402 行。

| 模块 | 行数 | 有测试 | 风险等级 |
|------|------|--------|----------|
| orchestrator.ts | 1599 | ❌ | 🔴 极高 — 整个流水线编排 |
| react-loop.ts | 860 | ❌ | 🔴 极高 — Agent 核心循环 |
| tool-executor.ts | 773 | ❌ | 🔴 高 — 42 个工具执行分发 |
| tool-registry.ts | 793 | ❌ | 🔴 高 — 工具定义+权限 |
| context-collector.ts | 1060 | ❌ | 🔴 高 — 上下文工程核心 |
| change-manager.ts | 498 | ❌ | 🟡 中 — 需求变更级联 |
| sandbox-executor.ts | 465 | ❌ | 🔴 高 — 安全边界 |

**影响**: 无法确信重构不会引入回归，每次改动都是在走钢丝。
**建议**: 按风险优先级为 top-5 模块补充集成测试，目标覆盖率先到 40%。

---

#### 2.2 `any` 类型泛滥（389 处）

**现状**: 全项目 389 处 `any`，分布集中在引擎层和前端类型定义。

**Top-10 any 热点文件**:

| 文件 | any 数量 | 说明 |
|------|----------|------|
| react-loop.ts | 26 | 工具调用/消息体 |
| ipc/project.ts | 22 | DB 查询结果 |
| api.d.ts | 19 | 全局类型声明 |
| conversation-backup.ts | 18 | 消息序列化 |
| tool-executor.ts | 18 | 工具参数/返回值 |
| mcp-client.ts | 17 | MCP 协议数据 |
| App.tsx | 15 | IPC 事件回调 |
| skill-loader.ts | 15 | 技能配置解析 |
| mission-runner.ts | 14 | 任务数据流转 |
| llm-client.ts | 14 | API 响应解析 |

**特别严重**: 25+ 处 `catch(err: any)` 绕过了 TypeScript 的错误类型检查（应用 `catch(err: unknown)`）。

**影响**: 类型系统形同虚设，运行时类型错误无法在编译期捕获。
**建议**: 批量将 `catch(err: any)` 改为 `catch(err: unknown)` + 类型窄化，为 IPC/tool 层建立 Zod schema 验证。

---

#### 2.3 IPC 层无输入验证

**现状**: `electron/ipc/project.ts`（883 行）等 IPC handler 直接从 `ipcRenderer.invoke` 接收参数后传入数据库查询，无 schema 验证。

```typescript
// 典型模式 — 前端传什么就用什么
ipcMain.handle('project:create', async (_e, name, options) => {
  // 直接使用 name, options 无验证
  db.prepare("INSERT INTO projects ...").run(name, ...);
});
```

**影响**: 虽然是桌面应用、前后端同源，但任何 renderer 侧的注入（XSS→IPC）都可直接操作数据库。
**建议**: 引入轻量 schema 验证（Zod/superstruct）对所有 IPC 入参做白名单校验。

---

### 🟡 P1 — 显著技术债

#### 2.4 God Object 残留

| 文件 | 行数 | 职责数 | 建议 |
|------|------|--------|------|
| orchestrator.ts | 1599 | 7+ Phase 函数 + worker 循环 + 热加入 + 经验提取 + 工具函数 | 拆分为 `phases/` 目录 |
| OverviewPage.tsx | 1340 | SVG DAG + Agent 头像 + 进度面板 + 统计 | 拆分子组件 |
| context-collector.ts | 1060 | Hot/Warm/Cold 三层 + 压缩 + 裁剪 | 按层拆分 |
| SettingsPage.tsx | 888 | LLM/MCP/模型/成员 配置 | 拆分 Tab 组件 |
| ipc/project.ts | 883 | 20+ IPC handler | 按功能分组 |

v12.1 将 orchestrator 从 1852 行减到 1599 行，但距离目标（500 行入口 + 独立 phase 模块）仍有差距。

**建议**: orchestrator.ts 拆为 `phases/{pm,architect,docs,worker,acceptance,devops,finalize}.ts` + 入口编排器。

---

#### 2.5 `execSync` 阻塞主进程（30+ 处）

**现状**: Electron 主进程中有 30+ 处 `execSync` 调用，分布在：

| 文件 | execSync 数量 | 场景 |
|------|--------------|------|
| git-provider.ts | 13 | Git 操作 |
| computer-use.ts | 5 | 桌面控制 |
| sandbox-executor.ts | 1 | 命令执行 |
| tool-executor.ts | 2 | 搜索命令 |
| orchestrator.ts | 2 | git diff |
| 其他 | 7+ | 版本检查、技能加载等 |

**影响**: `execSync` 在 Electron 主进程中执行会阻塞所有 IPC 响应和 UI 交互。如果 git 操作卡住（网络/大仓库），整个应用无响应。
**建议**: 将 git-provider.ts 和 tool-executor.ts 中的 execSync 逐步替换为 `execAsync`（已有 promisify 的 exec）。

---

#### 2.6 require() 残留（9 处）

```
tool-executor.ts:  4 处 (skillEvolution, getDb)
tool-registry.ts:  2 处 (mcpManager, skillManager)
system-monitor.ts: 1 处 (MODEL_PRICING)
```

所有 require() 都带有 eslint-disable 注释，属于刻意绕过。部分是为了解决循环依赖（tool-executor → skill-evolution → tool-executor），但正确做法是重构依赖关系或使用依赖注入。

**建议**: 引入 DI container 或 lazy import pattern 解决循环依赖，消除所有 require()。

---

#### 2.7 前端类型安全缺口

**`src/types/api.d.ts`（605 行）**: 大量接口使用 `any[]` 或可选字段未加 `| undefined`，是前端 any 的源头。

**`app-store.ts`**:
- `StoreAgentReactState.toolCalls` 类型为 `any[]`
- `Map` 类型的 state 在每次更新时创建新 Map 实例（Zustand immutability 要求），但无 selector memo 化，可能导致不必要的重渲染

**建议**: 用 Zod 从后端类型反向生成 `api.d.ts`，消除手动维护的同步风险。

---

### 🟢 P2 — 改进建议

#### 2.8 版本号混乱

| 来源 | 版本号 |
|------|--------|
| CLAUDE.md | v6.0 |
| package.json | 0.1.0 |
| 暂存区 | v12.1 |
| key_features | v0.1~v5.1 |

`package.json` 版本始终停在 `0.1.0`，与 CLAUDE.md 的 v6.0 和代码中的 v12.x 注释完全脱节。

**建议**: 统一使用语义化版本，`package.json` 与 CLAUDE.md 对齐。

---

#### 2.9 魔数散布

| 魔数 | 出现位置 | 含义 |
|------|----------|------|
| 16384 | orchestrator.ts 6 处, llm-client.ts 3 处 | maxTokens |
| 25 | guards.ts, constants.ts | ReAct 最大迭代 |
| 3000 | context-collector.ts, worker sleep | 裁剪/等待 |
| 50000 | orchestrator.ts 3 处 | 对话备份截断长度 |
| 500 | app-store.ts, 多处 | 缓存上限 |
| 120_000 | orchestrator.ts | exec 超时 |

虽然 `constants.ts` 已集中部分常量，但 orchestrator.ts 中仍硬编码了大量数值。

**建议**: 将所有阈值移入 `constants.ts` 并导出，或纳入 AppSettings 使其可配置。

---

#### 2.10 console.log 残留

```
ipc/project.ts:      8 处
project-importer.ts: 7 处
其他:                3 处
```

ESLint 规则已设 `no-console: warn`，但未强制执行。项目已有 `createLogger()` 封装。

**建议**: 将所有 console.log 替换为 `log.debug/info`，CI 中将 warn 升级为 error。

---

#### 2.11 错误处理一致性

**好的模式（已有）**:
- `NonRetryableError` 分类 + Circuit Breaker
- `catch(err: unknown)` + `instanceof Error` 类型窄化（orchestrator.ts 中已采用）

**坏的模式（仍存在）**:
- `browser-tools.ts`: 9 处 `catch(err: any)` + `err.message` 直接访问
- `change-manager.ts`: 6 处同样模式
- 多处 `.catch(() => {})` 静默吞掉 Promise rejection（browser-tools.ts 清理代码）

**建议**: 建立错误处理公约 — 所有 catch 必须用 `unknown` + 统一的 `toErrorMessage(err)` helper。

---

#### 2.12 缺少 ErrorBoundary 细粒度保护

v12.1 已在 `App.tsx` 添加了全局 ErrorBoundary，但 13 个页面（含 1340 行的 OverviewPage）没有局部 ErrorBoundary。单个页面崩溃会导致整个应用白屏。

**建议**: 为每个 Page 组件包裹独立 ErrorBoundary，渲染故障时显示该页面的 fallback 而非全局崩溃。

---

## 三、架构级观察

### 3.1 单体 vs 模块化的临界点

当前 engine/ 目录有 **44 个文件、17,402 行**，已超过单体可维护上限。文件间依赖关系复杂：

```
orchestrator.ts → imports 20+ 模块
react-loop.ts   → imports 15+ 模块
tool-executor.ts → imports 10+ 模块 (含 4 个 require)
```

但 ADR-003 明确选择单体架构。当前阶段可行，但后续增长需要：
1. **引擎层按职责分目录**（phases/, tools/, llm/, memory/）
2. **barrel export** 减少跨模块直接引用
3. **接口抽象**（IToolExecutor, ILLMClient）便于测试 mock

### 3.2 Electron 主进程负载

所有 Agent 引擎逻辑（LLM 调用、文件操作、Git、沙箱执行）都在 Electron 主进程运行。随着并行 Worker 增加，主进程 CPU/内存压力增大，可能影响 UI 响应。

**长期建议**: 将 engine 逻辑移至 worker_thread 或独立 Node.js 子进程。

### 3.3 数据库 schema 管理良好

v12.1 引入的 `schema_version` + `safeAddColumn` + 有序迁移脚本是正确方向。9 个迁移脚本覆盖了从 v1 到 v9 的演进。这是本次审查中的 **亮点**。

---

## 四、好的实践（值得保留和推广）

| 实践 | 位置 | 说明 |
|------|------|------|
| ✅ NonRetryableError 错误分类 | llm-client.ts | 区分可重试/不可重试，避免死循环 |
| ✅ Circuit Breaker | orchestrator.ts L327-367 | 续跑时检查不可重试错误 |
| ✅ 预检门控 (Pre-flight) | orchestrator.ts L242-261 | 启动前验证模型可用性 |
| ✅ AbortController 全链路 | orchestrator + react-loop | 可中断的长流程 |
| ✅ 程序化 Guards | guards.ts | 5 个子系统的硬约束 |
| ✅ 结构化日志 | logger.ts + createLogger | 模块级 namespace |
| ✅ DB 迁移系统 | db.ts | schema_version + 有序迁移 |
| ✅ Feature-Session 关联 | conversation-backup.ts | 可追溯的开发历史 |
| ✅ 类型定义集中 | types.ts | 消除跨模块 as any |

---

## 五、优先行动计划

### 立即（本周）

| # | 行动 | 预估工时 | 收益 |
|---|------|----------|------|
| 1 | `catch(err: any)` → `catch(err: unknown)` 全量替换（25+ 处） | 1h | 类型安全基线 |
| 2 | 提取 `toErrorMessage()` helper 统一错误字符串化 | 0.5h | 消除重复代码 |
| 3 | console.log → createLogger 替换（18 处） | 0.5h | 日志一致性 |

### 短期（1-2 周）

| # | 行动 | 预估工时 | 收益 |
|---|------|----------|------|
| 4 | orchestrator.ts 拆分为 phases/ 目录 | 4h | 可维护性质变 |
| 5 | 为 react-loop.ts 和 tool-executor.ts 补充集成测试 | 6h | 核心循环的回归防护 |
| 6 | OverviewPage.tsx 拆分子组件 | 3h | 前端可维护性 |
| 7 | package.json version 对齐到 6.0.0 | 0.1h | 版本一致性 |

### 中期（1 个月）

| # | 行动 | 预估工时 | 收益 |
|---|------|----------|------|
| 8 | git-provider.ts execSync → async | 3h | 主进程不阻塞 |
| 9 | IPC 入参 Zod 验证 | 4h | 安全边界 |
| 10 | api.d.ts 重构（消除 any，与后端类型对齐） | 4h | 前端类型安全 |
| 11 | 引擎层 require() 消除（DI / lazy import） | 3h | ESM 一致性 |
| 12 | 页面级 ErrorBoundary | 2h | 容错能力 |

---

## 六、量化基线（用于后续对比）

| 指标 | 当前值 | 目标值（3 个月） |
|------|--------|------------------|
| 总代码行数 | 31,288 | - |
| any 使用数 | 389 | < 50 |
| catch(err: any) | 25+ | 0 |
| 测试文件数 | 3 | 15+ |
| 测试覆盖率(引擎) | 7.3% | 40%+ |
| 最大单文件行数 | 1,599 (orchestrator) | < 500 |
| execSync 主进程 | 30+ | < 5 |
| require() | 9 | 0 |
| console.log | 18 | 0 |
| God Object (>800行) | 5 个文件 | 0 |

---

*报告由 Tim 的开发助手自动生成，基于对 AgentForge 代码库的全量静态扫描和人工审查。*
