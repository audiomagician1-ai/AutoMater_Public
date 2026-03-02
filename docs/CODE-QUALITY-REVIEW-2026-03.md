# 智械母机 AutoMater — 代码质量复盘报告

> 日期: 2026-03-02 | 版本: v12.0 (含 v7.0~v12.0 暂存功能)
> 审查范围: electron/ (主进程 + 引擎 43 模块 + IPC 11 模块) + src/ (前端 13 页面 + 组件)
> 代码量: ~16,500 行 TypeScript (engine 11,700 + ipc/preload/main 2,000 + frontend 2,800)

---

## 一、总体评价

AutoMater 从 v0.1 到 v12.0 经历了快速迭代，功能覆盖面令人印象深刻：42+ 工具、5 阶段编排流水线、ReAct 循环、3 层上下文记忆、MCP 动态加载、Playwright 浏览器自动化、Computer Use、工作流预设等。**架构拆分做得不错**（v2.5 的 God Object 拆分是关键转折点），模块间职责划分基本清晰。

然而，快速迭代积累了显著的技术债务。以下按严重程度分级列出。

---

## 二、🔴 P0 — 阻塞性问题（应立即修复）

### 2.1 零测试覆盖

**现状**: 项目没有任何单元测试或集成测试文件（搜索 `*.test.ts` / `*.spec.ts` 仅发现 node_modules 内的第三方测试）。`package.json` 中无 `vitest`/`jest` 依赖，无 `scripts.test` 配置。

**影响**:
- 每次重构/新增功能都是"蒙着眼走钢丝"
- 引擎层有大量 JSON 解析、状态转换、并发控制逻辑，全靠 `tsc --noEmit` 和手动运行验证
- v5.6 的 Circuit Breaker、NonRetryableError、并发防护等关键机制从未有自动化回归保证

**建议**: 优先为以下模块编写测试:
1. `output-parser.ts` — JSON 提取策略, schema 校验/修复
2. `guards.ts` — 5 个防护子系统的判定逻辑
3. `agent-manager.ts` — lockNextFeature 原子锁 + 依赖拓扑排序
4. `llm-client.ts` — NonRetryableError 分类 + 重试逻辑
5. `orchestrator.ts` — 工作流阶段条件化执行

### 2.2 `feature` 对象全程 `any` 类型贯穿流水线

**现状**: Feature 从 PM LLM 输出解析后以 `any[]` 类型存在，一路传递到 `phaseArchitect`、`phaseReqsAndTestSpecs`、`workerLoop`、`reactDeveloperLoop` 等函数。

```typescript
// orchestrator.ts:553
): Promise<any[] | null> {
  let features: any[] = [];

// orchestrator.ts:638
db.transaction((items: any[]) => {

// agent-manager.ts:231
export function lockNextFeature(projectId: string, workerId: string): any | null {

// react-loop.ts:152
feature: any, qaFeedback: string
```

**影响**:
- Feature 字段名不一致 (`acceptanceCriteria` vs `acceptance_criteria`, `dependsOn` vs `depends_on`) 需要在多处用 `||` 做双向兼容，极易遗漏
- 运行时字段缺失不报错，导致隐蔽的空值传播
- `feature._docContext`、`feature._conflictWarning`、`feature._tddTests` 等临时注入字段无类型声明

**建议**: 定义 `ParsedFeature` (LLM 输出归一化后) 和 `EnrichedFeature` (注入运行时上下文后) 两个接口，替代所有 `any`。

### 2.3 数据库迁移靠 try-catch 吞错误

**现状** (`db.ts`): 所有 ALTER TABLE 迁移用 `try { db.exec(sql); } catch { /* 列已存在 */ }` 模式。

```typescript
// db.ts:102-104
try {
  db.exec(`ALTER TABLE projects ADD COLUMN git_mode TEXT NOT NULL DEFAULT 'local'`);
} catch { /* 列已存在 */ }
```

这种模式在以下场景会静默失败:
- SQL 语法错误（如列类型写错）
- 磁盘空间不足导致写入失败
- 数据库锁冲突

**影响**: 迁移失败完全静默，用户可能运行在缺列的数据库上，触发运行时 500 类错误（与 M-20/M-31 经验教训高度一致）。

**建议**: 
1. 引入 schema_version 表 + 顺序迁移脚本
2. 至少在 catch 中检查错误消息是否包含 "duplicate column" / "already exists"，其他错误应抛出

---

## 三、🟠 P1 — 严重质量问题（应尽快修复）

### 3.1 大量 `any` 类型 (193 处)

engine 目录有 **193 处** `: any` 类型标注。虽然 types.ts 定义了 `AppSettings`、`ProjectRow`、`FeatureRow` 等类型，但大量函数参数和中间变量仍然使用 `any`。

**重灾区**:
| 文件 | `any` 数量 | 关键问题 |
|------|-----------|---------|
| orchestrator.ts | 20+ | features 数组, transaction callback |
| llm-client.ts | 10+ | `settings: any` 在 callLLM/callLLMWithTools 签名中 |
| tool-executor.ts | 15+ | formatTree, catch blocks |
| output-parser.ts | 12+ | validateAndRepair 核心函数 |
| agent-manager.ts | 8+ | checkBudget, lockNextFeature |

**特别注意**: `callLLM(settings: any, ...)` — 这是被所有引擎模块调用的核心函数，`settings` 参数却是 `any`，意味着传错结构体编译器不会报错。

### 3.2 orchestrator.ts 膨胀至 1818 行

v2.5 将 orchestrator 拆至 315 行，但后续迭代 (v5.0~v12.0) 又将其膨胀至 **1818 行**。新增的 `phaseIncrementalDocSync`、`phaseDevOpsBuild`、`phasePMAcceptance`、热加入上下文管理、工作流预设解析等全部堆积在同一文件。

**建议拆分**:
- `workflow-resolver.ts` — 工作流预设解析 + `hasStage()`
- `hot-join.ts` — HotJoinContext + EventEmitter 监听
- `phases/` 目录 — 每个 phase 一个文件 (pm-analysis, architect, docs-gen, devops-build, pm-acceptance, finalize)
- `helpers.ts` — safeJsonParse, ensureAgentsMd, splitBatchOutput

### 3.3 内联 `require()` 打破 ESM 模块依赖图

**现状**: 15 处使用运行时 `require()` 延迟加载模块:

```typescript
// orchestrator.ts:1439
const { execSync } = require('child_process');

// react-loop.ts:266
const { buildSkillContext } = require('./skill-evolution') as typeof import('./skill-evolution');

// tool-registry.ts:777
const { mcpManager } = require('./mcp-client') as typeof import('./mcp-client');
```

**影响**:
- 破坏 Tree-shaking 和静态分析
- `require()` 在 ESM 上下文中可能不可用（未来 Electron 升级风险）
- 模块循环依赖隐患 — 用 require 绕开的通常就是循环引用

**建议**: 用 `await import()` 动态导入替代，或重构消除循环依赖。

### 3.4 context-collector.ts 1060 行 — 第二大文件

仅次于 orchestrator，处理 Hot/Warm/Cold 三层上下文、Code Graph 集成、文件树扫描等，过于庞大。建议按上下文层级拆分。

### 3.5 API Key / Token 明文存储在 SQLite

`github_token`、`apiKey` 直接以明文 TEXT 存储在 `projects` 表和 `settings` 表。虽然是本地桌面应用，但 SQLite 文件可被任何有文件访问权限的进程/工具读取。

**建议**: 使用 Electron 的 `safeStorage` API 加密敏感字段，或至少加密存储到 keychain。

---

## 四、🟡 P2 — 中等质量问题

### 4.1 错误处理不一致

引擎层的 catch 块行为不统一:

| 模式 | 出现次数 | 问题 |
|------|---------|------|
| `catch { /* 注释 */ }` | 30+ | 完全吞掉错误，无任何日志 |
| `catch (err: any)` | 60+ | 仅使用 `err.message`，丢失堆栈 |
| `sendToUI + addLog + 继续执行` | 大部分 phase | 正确但缺少结构化错误类型 |
| `throw` 传播 | 少数 | 只有 NonRetryableError 被显式分类 |

**建议**: 
1. 定义统一的 `EngineError` 类层次 (NetworkError, ParseError, ConfigError, ToolError)
2. 用 logger 记录完整错误堆栈 (已有 `createLogger` 但未在所有 catch 中使用)
3. 永远不要使用空 catch — 至少 `log.debug()`

### 4.2 DevOps 阶段使用 `execSync` 阻塞主进程

```typescript
// orchestrator.ts:1576
const output = execSync(step.cmd, {
  cwd: workspacePath,
  encoding: 'utf-8',
  timeout: 120_000,
  maxBuffer: 1024 * 1024,
});
```

`execSync` 在 Electron 主进程中会**冻结整个 UI**（包括 IPC 通信）。构建验证可能耗时数分钟。

**建议**: 使用 `child_process.exec()` 或 `sandbox-executor.ts`（项目已有的沙箱执行器），异步执行并流式推送进度。

### 4.3 前端页面过大

| 页面 | 行数 | 问题 |
|------|------|------|
| OverviewPage.tsx | 1340 | SVG DAG + Agent 头像 + 进度仪表盘 + 动效，应拆子组件 |
| SettingsPage.tsx | 888 | Provider + Model + MCP + Pricing + Worker 全在一个文件 |
| TeamPage.tsx | 886 | 团队列表 + 编辑 + LLM配置 + MCP配置 全在一个文件 |
| WorkflowPage.tsx | 726 | 预设管理 + SVG预览 + 编辑器 + Mission启动 |

**建议**: 500 行以上的页面应拆分为子组件目录。

### 4.4 Zustand Store 单一巨大 Store

`app-store.ts` 包含导航、日志、流式、Feature 状态、Agent 状态、通知、验收面板、元 Agent 面板/对话等所有状态，任何一个状态变更都会触发所有 subscriber 的 selector 计算。

**建议**: 使用 Zustand 的 `create()` 拆分为多个独立 Store (navigation, logs, agents, meta-agent)，或至少使用 `shallow` 比较优化 re-render。

### 4.5 前端 `console.log/error` 残留

发现 18 处前端组件直接使用 `console.log` / `console.error`（如 OutputPage 的 rollback、DocsPage 的 rollback、MetaAgentSettings 的多处错误处理）。

**建议**: 引入前端 logger 工具（开发模式显示，生产模式静默），或至少改为用户可见的 toast 通知。

### 4.6 `@types/dagre` 在 dependencies 而非 devDependencies

```json
"dependencies": {
  "@types/dagre": "^0.7.54",
```

`@types/*` 包只在编译时使用，不应打包进生产构建。

---

## 五、🔵 P3 — 改善建议

### 5.1 缺少 ESLint / Prettier 配置

项目没有 `.eslintrc` 或 `.prettierrc`。虽然 tsc strict 模式开启，但代码风格一致性完全依赖开发者自觉。DevOps 阶段检查目标项目的 ESLint 配置，但 AutoMater 自身没有。

### 5.2 模块间依赖关系复杂

引擎层 43 个模块形成了复杂的导入网络:
- `orchestrator.ts` 直接 import 了 **19 个引擎模块**
- `react-loop.ts` import 了 **15 个模块**
- 多处使用 `require()` 绕开循环依赖

建议绘制模块依赖图，识别核心环路并通过接口/事件解耦。

### 5.3 Magic Numbers 散布

```typescript
const MAX_ITERATIONS = 25;           // react-loop.ts — 为什么是 25?
const BATCH_DOC_SIZE = 5;            // orchestrator.ts
const BATCH_ACCEPT_SIZE = 4;         // orchestrator.ts
const PHASE3_TIMEOUT_MS = 300_000;   // orchestrator.ts
```

应集中到 `config/constants.ts` 并添加注释说明取值依据。

### 5.4 Token 估算精度

```typescript
// react-loop.ts:121
function estimateMsgTokens(content: any): number {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return Math.ceil(text.length / 1.5);
}
```

这个 1:1.5 的字符-token 比率对中文内容严重不准确（中文约 1:0.5~0.7）。可能导致上下文窗口管理错误，尤其对中文用户的需求描述。

建议引入 `tiktoken` 或至少区分中英文比例。

### 5.5 preload.ts 参数全部 `any`

所有 IPC 调用的参数在 preload 层完全无类型校验：

```typescript
save: (settings: any) => ipcRenderer.invoke('settings:save', settings),
add: (projectId: string, member: any) => ipcRenderer.invoke('team:add', projectId, member),
```

渲染进程传入错误结构的数据不会被拦截，直到主进程运行时才可能报错。

### 5.6 `settings: any` 参数在 callLLM 函数签名中未使用 AppSettings 类型

`callLLM` 和 `callLLMWithTools` 是整个引擎的基础函数，但参数声明为 `settings: any`：

```typescript
export async function callLLM(
  settings: any, model: string, ...
```

这导致所有调用方传错 settings 结构时编译器不报错。应改为 `settings: AppSettings`。

### 5.7 Hot-Join EventEmitter 无界增长防护

```typescript
const orchestratorBus = new EventEmitter();
orchestratorBus.setMaxListeners(20);
```

虽然设了 maxListeners=20，但没有机制在项目结束后清理 listener（`unregisterHotJoinContext` 只删除了 context，listener 是全局注册一次的）。长期运行 + 频繁开关项目不会泄漏 listener，但如果未来改为每项目注册，需注意。

### 5.8 前端没有 Error Boundary

没有发现 React Error Boundary 组件。任何组件的运行时错误会导致**整个应用白屏**。

---

## 六、安全相关

| 项目 | 状态 | 风险等级 |
|------|------|---------|
| contextIsolation: true | ✅ | — |
| nodeIntegration: false | ✅ | — |
| API Key 明文存储 | ⚠️ | 中 (本地应用) |
| GitHub Token 明文存储 | ⚠️ | 中 |
| Sandbox 命令黑名单 (非 Docker) | ⚠️ | 中 |
| IPC 无输入验证 | ⚠️ | 低 (本地应用) |
| CSP 配置 | ❌ 未设置 | 低 |

---

## 七、构建与工程化

| 项目 | 状态 |
|------|------|
| TypeScript strict | ✅ |
| tsc --noEmit | ✅ (CI 验证) |
| ESLint | ❌ 未配置 |
| Prettier | ❌ 未配置 |
| 单元测试 | ❌ 零覆盖 |
| E2E 测试 | ❌ 未配置 |
| CI/CD | ❌ 未配置 (本地手动 build) |
| 依赖审计 (npm audit) | ❓ 未见执行 |
| Git hooks (husky/lint-staged) | ❌ 未配置 |
| Source maps | ✅ (Vite 默认) |
| Bundle 分析 | ❌ 未配置 |

---

## 八、优先修复路线图

### Sprint A: 基础质量门禁 (1~2 天)
- [ ] 配置 ESLint + Prettier
- [ ] 安装 vitest，为 output-parser + guards 编写首批测试
- [ ] 修复 callLLM 签名 `settings: any` → `AppSettings`
- [ ] 修复 `@types/dagre` 移至 devDependencies

### Sprint B: 类型安全 (2~3 天)
- [ ] 定义 `ParsedFeature` / `EnrichedFeature` 接口，替代流水线中的 `any`
- [ ] 为 `lockNextFeature` 返回强类型
- [ ] preload.ts 参数类型化（至少关键路径）

### Sprint C: 架构健康 (3~5 天)
- [ ] orchestrator.ts 拆分至 <500 行
- [ ] context-collector.ts 按层级拆分
- [ ] `require()` 改为 `import()` 或重构消除循环依赖
- [ ] DevOps `execSync` 改为异步执行

### Sprint D: 工程化完善 (持续)
- [ ] DB 迁移系统重构 (schema_version + 有序脚本)
- [ ] 前端 Error Boundary
- [ ] API Key/Token 加密存储
- [ ] 前端大页面拆分子组件
- [ ] Zustand Store 拆分

---

## 九、总结

**优势**:
- 模块化拆分意识强（v2.5 拆分、v2.6 审计是关键决策）
- 程序化防护思维成熟（guards.ts 5 子系统、NonRetryableError 分类、Circuit Breaker）
- 文档驱动开发理念贯穿（AGENTS.md 自动生成、doc-manager 版本管理）
- TypeScript strict 模式开启

**核心短板**:
- **零测试 + 大量 any = 修改即冒险**，这是当前最大的结构性风险
- 快速迭代导致核心文件再次膨胀（orchestrator 1818 行）
- 工程化基建缺失（无 lint、无 CI、无 hooks）

**一句话**: 功能能力远超工程基建。当前阶段应暂停功能开发，用 1~2 周投入到类型安全 + 测试覆盖 + 代码拆分上，这笔投资会在后续每次迭代中持续产出回报。
