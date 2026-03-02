# AgentForge 代码质量复盘报告

> **审计日期**: 2026-03-02
> **审计方法**: 全量源码实测 (tsc/vitest/grep/手工审查)，不沿用旧结论
> **基线版本**: master @ `4919259` (含文档漂移修复后最新状态)
> **审计范围**: 146 个生产源文件, 50,451 LOC

---

## 0. 总评

| 维度 | 评分 | 说明 |
|------|------|------|
| **类型安全** | 7/10 | tsc --noEmit 零错误 ✅；但仍有 110 处 `any` |
| **测试** | 6/10 | 36 测试文件, 736 通过, 0 失败 ✅；但覆盖面集中在 engine/ 底层 |
| **安全** | 5/10 | secret-manager 有加密 ✅；但 projects.github_token 明文残留, 134 IPC 零校验 |
| **可维护性** | 5/10 | phases 拆分有效 ✅；但 8 个文件 >1000 LOC, 13 处空 catch |
| **前端健壮性** | 7/10 | 每个页面独立 ErrorBoundary ✅；setInterval 多数有 cleanup |
| **工程基建** | 6/10 | ESLint+Prettier+Quality Gate+Git Hook ✅；无 CI/CD 流水线 |
| **综合** | **6.0/10** | 相比上次审计(4.6/10)显著改善，主要得益于 tsc 全通过、测试体系建立、ErrorBoundary 全覆盖 |

---

## 1. P0 — 阻断级问题 (0 项)

### ✅ 已清零

| 原 P0 问题 | 当前状态 |
|-----------|---------|
| tsc --noEmit 72 错误 | ✅ **0 错误** |
| 仅 3 个测试文件 | ✅ **36 文件, 736 tests, 0 failed** |

**结论**: 上一次审计的两个 P0 已完全解决。当前无阻断级问题。

---

## 2. P1 — 严重问题 (4 项)

### P1-1: `any` 使用量仍然偏高 — 110 处 / 20 文件

| 文件 | `any` 数 | 严重度 | 说明 |
|------|---------|--------|------|
| meta-agent-daemon.ts | 13 | 🔴 高 | 新模块，类型从设计起就缺失 |
| project.ts (IPC) | 11 | 🔴 高 | IPC handler 参数全 any |
| mission.ts | 10 | 🟡 中 | DB 查询结果未类型化 |
| tool-executor.ts | 9 | 🟡 中 | 部分 tool handler 参数 any |
| conversation-backup.ts | 8 | 🟡 中 | 序列化/反序列化边界 |
| SessionManager.tsx | 7 | 🟡 中 | 前端组件 |
| meta-agent.ts (IPC) | 6 | 🟡 中 | IPC handler 参数 |
| mission-runner.ts | 6 | 🟡 中 | — |
| event-store.ts | 6 | 🟡 中 | — |
| sub-agent-framework.ts | 6 | 🟡 中 | — |
| 其余 10 文件 | 1-3 each | 🟢 低 | — |

**趋势**: 从上次 157 处降至 110 处 (↓30%)，但核心 IPC 层仍是重灾区。

**建议**: 优先为 `project.ts` 和 `meta-agent.ts` 的 IPC handler 定义参数接口。

### P1-2: 134 个 IPC Handler 零运行时输入校验

```
实测: ipcMain.handle() 调用 = 134 处
Zod/schema 校验代码 = 0 处
```

任何渲染进程可发送任意类型参数到主进程，主进程无防御。在 Electron 安全模型下，preload 隔离只防了直接 nodeIntegration，但 **不防恶意 renderer 代码通过 contextBridge 发送畸形参数**。

**风险**: 非法参数 → 主进程 crash / SQLite 损坏 / 意外行为。
**建议**: 在 IPC handler 入口统一加 `validateInput(schema, args)` 中间件。

### P1-3: `projects.github_token` 明文残留

`db.ts` 仍在核心建表语句中创建 `github_token TEXT` 列（第 349 行）。虽然 `secret-manager.ts` 已实现 AES-256-GCM 加密（31 处加密相关代码），迁移脚本 v10 也迁移旧 token 到 `project_secrets`，但 **旧列未删除，新项目仍可直接写入明文**。

**风险**: 开发者或 LLM Agent 可能直接写 `projects.github_token` 而非走 `secret-manager`。
**建议**: 在 `project:create` IPC 中移除 `githubToken` 参数入口；将 `projects.github_token` 列标记为 deprecated。

### P1-4: 29 处 `execSync` 阻塞主进程

| 模块 | execSync 数 | 严重度 |
|------|------------|--------|
| computer-use.ts | 6 | 🟡 Windows GUI 交互，短命令 |
| sandbox-executor.ts | 3 | 🟡 核心沙箱，含超时设置 |
| tool-executor.ts | 3 | 🟡 glob/list_files 用 PowerShell |
| workspace-git.ts | 3 | 🟡 git init/status/zip |
| deploy-phase.ts | 2 | 🔴 npm install/build 可能 >30s |
| docs-phase.ts | 3 | 🟡 git diff |
| system-monitor.ts | 2 | 🟡 性能采集 |
| sub-agent.ts | 2 | 🟡 — |
| skill-loader.ts | 2 | 🟡 — |
| shared.ts | 1 | — |
| docker-sandbox.ts | 2 | — |

**影响**: Electron 主进程单线程，execSync 期间 UI 完全冻结。对 `deploy-phase.ts` 中的 npm install/build 尤其严重（可能冻结数分钟）。

**建议**: 高耗时操作（deploy-phase, skill-loader）迁移到 `execAsync` + Worker Thread。

---

## 3. P2 — 中度问题 (5 项)

### P2-1: 8 个文件超 1000 LOC

| 文件 | LOC | 角色 | 建议 |
|------|-----|------|------|
| tool-registry.ts | 1811 | 工具定义 | 按类别拆分 (file-tools, git-tools, browser-tools...) |
| tool-executor.ts | 1690 | 工具执行 | 按 action 类别拆分 |
| project-importer.ts | 1101 | 项目导入 | 已有 probes/ 拆分，主文件仍大 |
| project.ts (IPC) | 1100 | IPC 处理 | 按命名空间拆分 |
| react-loop.ts | 1028 | ReAct 循环 | 提取 context 组装/result 处理 |
| MetaAgentSettings.tsx | 963 | 前端组件 | 拆分子组件 |
| context-collector.ts | 926 | 上下文收集 | Hot/Warm/Cold 各自独立 |
| api.d.ts | 896 | 类型定义 | (可接受，纯类型) |

**总计**: 50,451 LOC / 146 文件 = 平均 345 LOC/文件。中位数合理，但头部文件过大。

### P2-2: 13 处空 catch 块

| 文件 | 空 catch 数 |
|------|-----------|
| InteractiveGraph.tsx | 4 |
| ProjectsPage.tsx | 4 |
| TeamPage.tsx | 2 |
| App.tsx | 1 |
| logger.ts | 1 |
| (合计) | **13** |

**所有空 catch 均在前端**。InteractiveGraph 的 4 处是 dagre 布局兜底，ProjectsPage 是 IPC 调用兜底。

**影响**: 错误静默吞没 → 调试困难。
**建议**: 至少加 `console.warn` 或上报到结构化日志。

### P2-3: 事件监听器泄漏风险

```
事件注册 (addEventListener / ipcMain.on / emitter.on): 20 处
事件清理 (removeListener / .off): 4 处
比例: 20:4 = 5:1
```

**前端 setInterval 情况**: 14 处 `setInterval`，大多数已有 `clearInterval` cleanup，但需逐一确认。

### P2-4: SQL 构造异味 (非注入但需规范化)

发现 2 处直接字符串插值到 SQL：
```
project.ts:636: `UPDATE projects SET status = '${status}'...`
project.ts:965: `UPDATE projects SET status = '${status}'...`
```

经验证 `status` 是硬编码 `'paused'|'error'`，**非用户输入**，无实际注入风险。但违反 "always use placeholders" 原则。

另有多处动态拼接 `WHERE` 条件 (`event-store.ts:245`, `project.ts:543/547`, `change-manager.ts:177`)，均使用 `?` 占位符 + `Array.join(' AND ')`，安全但可读性差。

### P2-5: 13 处 `require()` 破坏 ESM 模块图

| 文件 | require() 数 | 用途 |
|------|-------------|------|
| deploy-phase.ts | 2 | 延迟加载 cloudflare/supabase |
| code-graph.ts | 1 | — |
| db.ts | 1 | 迁移时加载 secret-manager |
| project.ts | 1 | — |
| secret-manager.ts | 2 | crypto 动态导入 |
| cloudflare-tools.ts | 1 | — |
| supabase-tools.ts | 1 | — |
| tool-executor.ts | 1 | — |
| tool-registry.ts | 2 | — |

**影响**: 破坏 tree-shaking、阻碍静态分析、导致循环依赖隐蔽化。

---

## 4. P3 — 轻度问题 (3 项)

### P3-1: `package.json` 版本号过时

```
package.json: "version": "6.0.0"
CLAUDE.md: v13.0
```

### P3-2: 依赖分类不当

- `playwright-core` 在 `dependencies` (应该在 `devDependencies`，除非 Agent 运行时确实需要 → 需要，保留正确)
- `@types/dagre` 在 `devDependencies` ✅ (已修正)

### P3-3: 无 CI/CD 流水线

`.github/` 下只有 Issue 模板，无 GitHub Actions workflow。构建验证仅依赖本地 git hook (quality-gate.js)。

---

## 5. 改善趋势对比

| 指标 | 上次审计 | 本次审计 | 变化 |
|------|---------|---------|------|
| tsc 错误 | 72 | **0** | ✅ **-100%** |
| 测试文件 | 3 | **36** | ✅ **+1100%** |
| 测试用例 | ~50 | **736** (0 fail) | ✅ **+1372%** |
| `any` 使用量 | 157 | **110** | ↓ 30% |
| 空 catch 块 | ~5 (引擎内) | **13** (全在前端) | ↑ (前端新增被计入) |
| ErrorBoundary | 0 页面 | **所有 15 页面** | ✅ **全覆盖** |
| 最大文件 LOC | orchestrator 1818 | tool-registry 1811 | → (orchestrator 已拆为 696) |
| IPC handler 数 | 108 | **134** | ↑ (功能增长) |
| IPC 输入校验 | 0 | **0** | → (未改善) |
| 生产代码量 | ~34,764 | **50,451** | ↑ 45% |

---

## 6. 治理优先级建议

### Sprint A: 类型安全 (3-5 天)

| 任务 | 影响 | 工作量 |
|------|------|--------|
| IPC handler 参数接口化 (project.ts 11 any → 0) | P1 | 大 |
| meta-agent-daemon.ts 全面类型化 (13 any → 0) | P1 | 中 |
| IPC 输入校验中间件 (Zod schema + validateInput) | P1 | 大 |

### Sprint B: 安全加固 (2-3 天)

| 任务 | 影响 | 工作量 |
|------|------|--------|
| 移除 `projects.github_token` 直接写入路径 | P1 | 小 |
| project.ts:636/965 改为参数化 SQL | P2 | 小 |
| deploy-phase.ts execSync → execAsync | P1 | 中 |

### Sprint C: 可维护性 (3-5 天)

| 任务 | 影响 | 工作量 |
|------|------|--------|
| tool-registry.ts 拆分 (1811 → 多文件) | P2 | 大 |
| tool-executor.ts 拆分 (1690 → 多文件) | P2 | 大 |
| 13 处空 catch → 结构化日志 | P2 | 小 |
| require() → dynamic import() | P2 | 中 |

### Sprint D: 工程化 (2-3 天)

| 任务 | 影响 | 工作量 |
|------|------|--------|
| GitHub Actions CI (tsc + vitest + lint) | P3 | 中 |
| package.json version 更新到 13.0.0 | P3 | 小 |
| setInterval 全量 cleanup 审查 | P2 | 小 |

---

## 7. 附录: 数据采集命令清单

所有数据均通过以下命令实测获取 (可复现):

```bash
# 类型检查
npx tsc --noEmit 2>&1 | Select-String "error TS" | Measure-Object

# 测试
npx vitest run

# any 统计
Select-String -Pattern ": any\b|as any\b|\<any\>" -Recurse electron/,src/ | Measure-Object

# SQL 注入扫描
Select-String -Pattern "status = '\$\{" -Recurse electron/

# execSync 统计
Select-String -Pattern "execSync\b" -Recurse electron/ (排除 __tests__)

# IPC handler 数量
Select-String -Pattern "ipcMain\.handle\(" -Recurse electron/ipc/

# 空 catch
Select-String -Pattern "catch\s*(\(\w*\))?\s*\{\s*\}" -Recurse electron/,src/
```
