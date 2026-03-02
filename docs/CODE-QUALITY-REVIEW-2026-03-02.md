# AgentForge 代码质量复盘报告

> **审查日期**: 2026-03-02  
> **审查范围**: 全量源码 (107 个生产文件, 34,764 行)  
> **技术栈**: Electron 33 + React 19 + TypeScript 5.7 + Vite 6 + Zustand 5 + better-sqlite3 + Tailwind 3  
> **审查视角**: 研发专家级，覆盖架构、类型安全、安全、性能、可维护性、测试

---

## 一、项目概貌

| 维度 | 数据 |
|------|------|
| **引擎层** (`electron/engine/`) | 48 模块 + 8 phase 文件, 共 19,286 行 |
| **IPC 层** (`electron/ipc/`) | 11 handlers, 共 2,355 行 |
| **Electron 根** (`db.ts`, `main.ts`, `preload.ts`) | 716 行 |
| **前端 Pages** (`src/pages/`) | 14 页面 + overview 子目录, 共 8,951 行 |
| **前端 Components** (`src/components/`) | 12 组件, 共 2,351 行 |
| **Store + Types** | 877 行 |
| **测试文件** | 3 个, 599 行, 71 用例 |
| **TypeScript 严格模式** | ✅ `"strict": true` |
| **tsc 编译结果** | ❌ **72 errors** (7 个文件) |
| **vitest 结果** | ✅ 71/71 passed |

---

## 二、综合评分

| 维度 | 评分 (1-10) | 说明 |
|------|:-----------:|------|
| 架构设计 | 6.5 | phases/ 拆分合理; 但 react-loop/tool-executor/tool-registry 仍过大; 引擎耦合度高 |
| 类型安全 | 4.0 | types.ts 体系完善, 但 72 tsc errors 未修, 157 处 any, IPC 层无验证 |
| 错误处理 | 5.5 | EngineError 层次+NonRetryableError+Guards 体系好; 但 100+ catch 静默吞错 |
| 安全性 | 3.5 | API Key 明文 SQLite, IPC 零验证, SQL 字符串拼接, execSync 阻塞 |
| 测试覆盖 | 2.0 | 3/48 模块有测试 (6.25%), 0 前端测试, 0 IPC 测试, 0 集成测试 |
| 可维护性 | 5.0 | ESLint+Prettier 已配; 但大文件多, require() 打破模块图, 循环依赖潜在风险 |
| 性能 | 5.5 | 前端: Map clone 频繁无 memo, 轮询 5s; 后端: execSync 阻塞主进程 |
| 工程化 | 4.5 | vitest 配置好; 无 CI/CD, 无 git hooks, ESLint 未实际运行, 0 自动化守护 |
| **综合加权** | **4.6 / 10** | |

---

## 三、P0 — 阻塞级问题 (必须立即修复)

### P0-1. TypeScript 编译失败: 72 个 error

**现状**: `tsc --noEmit` 产出 72 个错误, 分布在 7 个文件:

| 文件 | 错误数 | 主要类型 |
|------|:------:|---------|
| `llm-client.ts` | 13 | `TS2322` 类型不匹配, `TS2339` 属性不存在, `TS2488` 缺少 iterator |
| `ui-bridge.ts` | 5 | `TS2339` 属性不存在 — 参数类型为 `{}` 缺少属性 |
| `tool-registry.ts` | 4 | `OpenAIFunctionTool[]` ↔ `Record<string, unknown>[]` 不兼容 |
| `sub-agent.ts` | 4 | `FileNode` 与 `FileTreeNode` 类型不一致, `"dir"` vs `"directory"` |
| `react-loop.ts` | 3 | `OpenAIFunctionTool[]` 传参类型不匹配 |
| `meta-agent.ts` | 3 | `string | undefined` 不能赋给 `string` |
| `tool-executor.ts` | 2 | `FileNode` / `FileTreeNode` 类型不兼容 |
| `conversation-backup.ts` | 1 | 类型赋值不匹配 |

**根因**: v12.1 引入 `types.ts` 强类型后, 部分消费方未适配新类型; `FileNode`(file-writer) 和 `FileTreeNode`(types.ts) 是同语义不同定义 (`type: 'dir'` vs `type: 'directory'`).

**影响**: 虽 Vite dev 模式不检查类型, 但 CI 构建会失败; 隐藏运行时类型错误.

**修复建议**: 统一 `FileNode`/`FileTreeNode` 为单一类型; `callLLMWithTools` 参数改为 `LLMToolDef[]`; 为 `ui-bridge` 函数参数定义接口; `meta-agent` 加 nullish coalescing.

### P0-2. 测试覆盖率极低: 6.25% 模块覆盖

| 维度 | 现状 | 目标 |
|------|------|------|
| 引擎模块覆盖 | 3/48 (6.25%) | ≥60% |
| 前端组件测试 | 0/26 | ≥30% |
| IPC 层测试 | 0/11 | ≥50% |
| 集成测试 | 0 | ≥3 场景 |
| E2E 测试 | 0 | ≥1 冒烟套件 |

**有测试的模块**: `output-parser` (17 TC), `guards` (42 TC), `llm-client` (12 TC) — 全是纯逻辑模块, 易于单测.

**零测试的关键路径**: `orchestrator`, `react-loop`, `tool-executor`, `context-collector`, `db.ts`, `preload.ts`, 全部 IPC handler.

### P0-3. IPC 层零输入验证

**现状**: 108 个 `ipcMain.handle()` 注册, **无一处对渲染进程传入参数做运行时校验**.

```typescript
// electron/ipc/events.ts — 典型模式
ipcMain.handle('events:query', async (_e, projectId: string, options?: any) => {
  // TypeScript 类型注解仅编译时有效
  // 运行时 projectId 可以是 undefined/number/object, 直接拼入 SQL
```

TypeScript 类型注解在 IPC boundary 无运行时效力 — `ipcRenderer.invoke` 可传任意值.

**风险**: 
- 恶意插件/XSS 注入可传入畸形参数, 导致 SQL 异常或逻辑错误
- `Record<string, unknown>` 参数 (`team:add`, `wish:update`, `mcp:add-server` 等) 完全无结构校验

**修复建议**: 引入轻量 schema 验证 (如 `zod`) 在每个 handler 入口处校验.

---

## 四、P1 — 严重问题 (版本发布前修复)

### P1-1. any 类型: 157 处 (36 个文件)

**分布 Top-10**:

| 文件 | any 数量 | 典型位置 |
|------|:-------:|---------|
| `api.d.ts` | 17 | 前端全局类型声明, 多个接口字段为 `any` |
| `project.ts` (IPC) | 16 | handler 参数、DB query 结果 |
| `meta-agent.ts` | 11 | LLM 响应解析、memory 操作 |
| `tool-executor.ts` | 11 | `call.arguments` 解构 |
| `mission.ts` | 10 | DB 行映射 |
| `SessionManager.tsx` | 9 | IPC 返回值 |
| `TimelinePage.tsx` | 8 | 事件数据结构 |
| `conversation-backup.ts` | 8 | 消息格式 |
| `llm.ts` (IPC) | 7 | API 响应 |
| `mission-runner.ts` | 6 | LLM 输出解析 |

**亮点**: `orchestrator.ts` 已做到 0 any (v12.1 成果); `types.ts` 定义了 628 行强类型.

### P1-2. 安全隐患: API Key 明文存储

```sql
-- settings 表
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
-- 存储: { "apiKey": "sk-xxxx", "baseUrl": "https://...", ... }

-- projects 表
github_token TEXT  -- 明文 GitHub PAT

-- team_members 表
llm_config TEXT    -- JSON 含 apiKey 字段
```

**影响**: 
- SQLite 文件可被任何能读取 `%APPDATA%` 的进程访问
- 无加密、无 keychain 集成
- 日志中也可能泄露 (仅做了部分脱敏)

### P1-3. SQL 注入风险: 字符串拼接

发现 7 处 SQL 字符串拼接:

```typescript
// project.ts:629 — 状态值直接插入 SQL
db.prepare(`UPDATE projects SET status = '${status}', ...`).run(projectId);

// change-manager.ts:177 — IN 子句占位符拼接 (此处安全, 因 placeholders 来自程序逻辑)
db.prepare(`... WHERE id IN (${placeholders}) ...`)

// project.ts:332, 405 — 动态 SET 子句 (字段名来自代码, 非用户输入, 低风险)
db.prepare(`UPDATE wishes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
```

**高风险**: `project.ts:629` 和 `project.ts:958` 的 `status` 变量直接拼入 SQL. 虽然当前 `status` 来自程序内部枚举, 但若未来重构传入用户输入则直接构成注入.

**修复建议**: 全部改用参数化 `?` 占位符.

### P1-4. execSync 阻塞 Electron 主进程

发现 **15+ 处 `execSync` 调用**分布于 9 个文件:

| 文件 | 调用数 | 影响 |
|------|:------:|------|
| `computer-use.ts` | 5 | 截屏/鼠标操作阻塞主进程 |
| `tool-executor.ts` | 3 | `glob_files`, `search_files` 命令阻塞 |
| `sandbox-executor.ts` | 1 | 同步沙箱执行 |
| `skill-loader.ts` | 1 | Skill 目录扫描 |
| `sub-agent.ts` | 1 | grep 搜索 |
| `workspace-git.ts` | 3 | git 操作 |
| `docker-sandbox.ts` | 1 | docker info 检测 |
| `system-monitor.ts` | 1 | nvidia-smi 检测 |

**影响**: 主进程阻塞 = UI 冻结. `tool-executor.ts` 的 `search_files` 给了 20s timeout, 意味着最坏情况 UI 卡死 20 秒.

### P1-5. require() 延迟导入打破 ESM 模块图

**10 处 `require()` 调用** (8 文件):

| 文件 | 行号 | 被 require 模块 | 用途 |
|------|:----:|----------------|------|
| `tool-executor.ts` | 429 | `../db` | 避免循环依赖 |
| `tool-executor.ts` | 562, 570 | `./sub-agent-framework` | 避免循环依赖 |
| `tool-executor.ts` | 973, 1007, 1038, 1068 | `./skill-evolution` | 4次重复 require |
| `tool-registry.ts` | 1035 | `./mcp-client` | 延迟加载 |
| `tool-registry.ts` | 1055 | `./skill-loader` | 延迟加载 |
| `system-monitor.ts` | 287 | `./llm-client` | 避免循环依赖 |

**影响**: 
- 破坏 Vite 的 tree-shaking 和 code-splitting
- `tool-executor.ts` 重复 require `skill-evolution` 4 次 — 应提取为模块级变量
- 根因是**循环依赖**: `tool-executor ↔ db`, `tool-executor ↔ sub-agent-framework`

### P1-6. EventListener 泄漏风险

**12 处 `.on()` / `addListener()` 注册, 仅 2 处有 `removeListener`/`.off()`**.

| 文件 | on() 注册 | off() 清理 | 泄漏风险 |
|------|:---------:|:---------:|:-------:|
| `mcp-client.ts` | 5 | 0 | ⚠️ 高 — MCP 子进程 stdout/stderr/close |
| `orchestrator.ts` | 3 | 0 | ⚠️ 中 — EventEmitter 注册 |
| `sandbox-executor.ts` | 2 | 0 | ⚠️ 中 — spawn 进程事件 |
| `browser-tools.ts` | 2 | 2 | ✅ 已清理 |

**影响**: 长时间运行的 orchestrator 会话中, 每次重启 MCP 连接会累积 listener, 最终触发 Node.js `MaxListenersExceededWarning`.

---

## 五、P2 — 中等问题 (近期迭代修复)

### P2-1. 大文件 / God Object

| 文件 | 行数 | 建议 |
|------|:----:|------|
| `OverviewPage.tsx` | 1,457 | 拆分: 已有 overview/ 子目录但主文件仍膨胀; 统计面板/操作按钮/进度条应提取 |
| `context-collector.ts` | 1,061 | 拆分: Hot/Warm/Cold 三层逻辑+baseline+light 各自独立模块 |
| `tool-registry.ts` | 1,044 | 拆分: 42 个工具定义应按类别分组到子文件 |
| `tool-executor.ts` | 977 | 拆分: 980 行 switch-case, 可按工具类别拆分 (file-ops, shell, git, browser, mcp) |
| `SettingsPage.tsx` | 888 | 拆分: MCP/Team/Skill/Workflow 设置各自组件 |
| `project.ts` (IPC) | 885 | 拆分: 108 handlers 混在一个文件 |
| `react-loop.ts` | 865 | 单文件包含: 主循环+消息压缩+context build+skill inject — 建议拆 3 个模块 |
| `TeamPage.tsx` | 751 | 拆分: 成员编辑弹窗+LLM配置面板 |
| `WorkflowPage.tsx` | 727 | 尚可接受 |

### P2-2. 100+ 处 catch 静默吞错

分析 `electron/` 全部 catch 块:

| 类型 | 数量 | 典型文件 |
|------|:----:|---------|
| **空 catch `{}`** | 5 | `change-manager`, `cross-project`, `logger`, `model-selector`, `project.ts` |
| **catch → return 默认值** | ~30 | `agent-manager`(4), `context-collector`(8), `memory-system`(3), `git-provider`(8) |
| **catch → log.warn/debug 后忽略** | ~40 | `mcp-client`, `react-loop`, `git-provider`, `skill-evolution` |
| **catch → 有意义的 fallback** | ~25 | `sandbox-executor`, `output-parser`, `qa-loop` |

**高风险吞错**:
- `context-collector.ts`: 8 处 catch 返回空字符串/空对象 — 上下文收集失败时 Developer 拿不到关键上下文, 但无任何告警
- `agent-manager.ts`: 4 处 catch 返回 null/fallback — 团队配置读取失败静默降级
- `git-provider.ts`: 8 处 catch → log 后不抛 — git 操作失败但编排流程继续

### P2-3. 前端性能: 轮询 + Map clone

1. **5 秒硬轮询**: `OverviewPage.tsx` 每 5 秒 `setInterval(load, 5000)` 重新拉取全量数据
2. **Map 克隆**: Zustand store 中每次状态更新都 `new Map(state.xxx)` 克隆整个 Map — 频繁的 agent 状态更新会触发大量不必要的 React 重渲染
3. **零 React.memo**: 26 个组件/页面中**没有一个使用 `React.memo`** 或等效的渲染优化
4. **useMemo 不足**: `ProjectsPage.tsx` (508 行, 18 useState, 0 useMemo), `TeamPage.tsx` (751 行, 23 useState, 1 useMemo)

### P2-4. 前端 console.* 残留

19 处 `console.*` 调用 (7 个文件), 其中 `MetaAgentSettings.tsx` 8 处, `SessionManager.tsx` 6 处. 无结构化错误上报.

### P2-5. Zustand Store 单体

`app-store.ts` (309 行) 包含 **16 个状态域** 在一个 flat store 中:
- 导航状态 (insideProject, globalPage, projectPage)
- 日志 (logs, activeStreams)
- Feature/Agent 状态 (featureStatuses, agentStatuses)
- 上下文 (contextSnapshots, agentReactStates)
- 通知 (pendingNotifications)
- 验收面板 (showAcceptancePanel)
- Agent 工作流 (agentWorkMessages)
- MetaAgent (metaAgentPanelOpen, metaAgentSettingsOpen, metaAgentMessages)

**影响**: 任意 `agentStatus` 更新触发所有订阅 `useAppStore()` 的组件重渲染.

### P2-6. 无 CI/CD 流水线

- 无 `.github/workflows/` 目录
- 无 git hooks (`husky`, `lint-staged` 等)
- ESLint/Prettier 配置存在但从未在提交流程中强制执行
- `tsc --noEmit` 72 errors = 任何 CI 类型检查都会失败

---

## 六、P3 — 低优先级 / 建议改进

### P3-1. 依赖管理

- `playwright-core` 在 `dependencies` — 仅 browser-tools 功能使用, 应移至 `optionalDependencies` 或做条件加载
- `dagre` 在 `dependencies` — 仅前端 OverviewPage 图形可视化使用
- `package.json` 缺少 `"type": "module"` — vitest 运行时会触发 Node.js `MODULE_TYPELESS_PACKAGE_JSON` 警告

### P3-2. Token 估算精度

`context-collector.ts` 使用 `text.length / 1.5` 估算 token 数 — 对纯英文偏高 (~30%), 对 CJK 偏低 (~50%). 建议使用 `tiktoken` 或 `gpt-tokenizer` 精确计算.

### P3-3. 类型重复定义

- `OverviewPage.tsx` 中重复定义了 `Feature`, `STATUS_COLOR`, `CATEGORY_BADGE` 等, 与 `overview/types.ts` 中的定义冲突
- `FileNode` (file-writer.ts, `type: 'dir'`) 和 `FileTreeNode` (types.ts, `type: 'directory'`) 语义相同但类型不兼容
- `ToolCallMessage` (llm-client.ts) 和 `LLMMessage` (types.ts) 部分重叠

### P3-4. 日志系统不完善

- 后端 `createLogger()` 基于 `console.log` — 无日志级别过滤、无日志文件轮转
- 前端 19 处 `console.*` 无收集 — 无法在生产环境诊断用户问题
- 建议: 后端接入 `electron-log`; 前端添加 `window.onerror` / `unhandledrejection` 收集

---

## 七、亮点 (做得好的部分)

| 亮点 | 说明 |
|------|------|
| **Guards 程序化硬约束** | 607 行, 5 大子系统 (ToolCallGuard, ReactGuard, QAGuard, PipelineGate, BudgetController) — 用算法替代 prompt 软约束 |
| **EngineError 层次结构** | `NetworkError`, `ParseError`, `ConfigError`, `ToolError` 继承链完整 |
| **NonRetryableError** | LLM 层区分可重试/不可重试错误, react-loop 据此决策 |
| **types.ts 强类型体系** | 628 行, 覆盖 DB row / Feature pipeline / LLM message / MCP / Workflow 等全链路类型 |
| **DB 迁移系统** | `schema_version` 表 + `safeAddColumn` + 有序迁移脚本, 替代了旧的 try-catch 吞错模式 |
| **orchestrator phases/ 拆分** | 从 1884 行拆到 546 行 + 8 个 phase 文件, 职责清晰 |
| **ErrorBoundary 防白屏** | 每个页面独立 ErrorBoundary + key reset |
| **assertSafePath** | tool-executor 对所有文件操作做路径安全检查, 禁止目录穿越 |
| **ESLint + Prettier 配置** | 规则合理 (warn any, 禁空 catch, no-console) |

---

## 八、量化基线 (供追踪改进)

```
┌─────────────────────────────────┬──────────┐
│ 指标                            │ 当前值    │
├─────────────────────────────────┼──────────┤
│ 生产代码文件数                    │ 107      │
│ 生产代码总行数                    │ 34,764   │
│ tsc 编译错误数                   │ 72       │
│ any 类型注解数 (: any / as any)  │ 157      │
│ require() 延迟导入数             │ 10       │
│ execSync 调用数                  │ 15+      │
│ 空 catch 块数                    │ 5        │
│ 静默吞错 catch 数                │ ~100     │
│ console.* 前端残留               │ 19       │
│ SQL 字符串拼接数                  │ 7        │
│ EventListener 无 off() 配对      │ 10       │
│ 测试文件数 / 总模块数             │ 3 / 48   │
│ 测试用例总数                      │ 71       │
│ 600+ 行大文件 (engine)           │ 6        │
│ 600+ 行大文件 (frontend)         │ 6        │
│ IPC handler 总数                 │ 108      │
│ IPC handler 有入参验证            │ 0        │
└─────────────────────────────────┴──────────┘
```

---

## 九、修复优先级路线图

### Sprint 1: 类型安全 + 编译通过 (预计 2-3 天)

1. **修复 72 个 tsc errors** — 统一 `FileNode`/`FileTreeNode`, 对齐 `OpenAIFunctionTool` 类型, 修复 `ui-bridge` 参数类型
2. **SQL 注入修复** — 7 处字符串拼接改为参数化 `?`
3. **require() → dynamic import()** — 10 处 require 改为 `await import()` 或模块重组消除循环依赖

### Sprint 2: 安全 + 稳定性 (预计 3-4 天)

4. **IPC 入参验证** — 引入 `zod`, 为 108 个 handler 添加 schema (可分批, 先覆盖写操作)
5. **API Key 加密** — 使用 `electron safeStorage` 加密 settings 表的 apiKey/github_token
6. **execSync → async** — 高优: `tool-executor.ts` 和 `computer-use.ts` 改异步, 防止 UI 卡死
7. **EventListener 清理** — `mcp-client`, `orchestrator`, `sandbox-executor` 添加 off() 配对

### Sprint 3: 测试 + 工程化 (预计 3-4 天)

8. **测试扩充** — 目标: `context-collector`, `tool-executor`, `db.ts`, `agent-manager`, `change-manager` 各 10+ TC
9. **CI 流水线** — GitHub Actions: `tsc --noEmit` → `eslint` → `vitest run` → `electron-builder`
10. **Git hooks** — `husky` + `lint-staged`: 提交时自动 lint + typecheck 变更文件

### Sprint 4: 架构 + 性能 (预计 4-5 天)

11. **大文件拆分** — `tool-registry.ts` (按工具类别), `tool-executor.ts` (按工具类别), `react-loop.ts` (主循环/压缩/注入)
12. **Zustand 分片** — `app-store.ts` 拆为 `navigation-store`, `log-store`, `agent-store`, `meta-agent-store`
13. **前端性能** — 轮询 → SSE/IPC push; Map clone → `immer` 或 `subscribeWithSelector`; 关键组件加 `React.memo`
14. **catch 审计** — 100 处 catch 逐一分类: 需上报的加日志+metrics, 需 fallback 的明确记录

---

## 十、结论

AgentForge 在**架构演进方向上是正确的** — phases 拆分、Guards 硬约束、EngineError 层次、types.ts 强类型体系都体现了成熟的工程思维。但当前**代码质量基线偏低** (4.6/10), 主要短板集中在:

1. **72 个 tsc errors = 类型系统形同虚设** — 最紧急
2. **IPC 零验证 + SQL 拼接 + 明文 Key = 安全三连击** — 最危险
3. **6.25% 模块测试覆盖 = 每次修改都是盲改** — 最持久的技术债

建议**严格按 Sprint 1 → 2 → 3 → 4 顺序执行**, 每个 Sprint 完成后做 `tsc --noEmit` + `vitest run` 回归验证, 确保不引入新问题。
