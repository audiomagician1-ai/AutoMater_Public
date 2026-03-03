# AutoMater Dev-Agent 伙伴 — Skill 迭代进化路线图

> **日期**: 2026-03-01  
> **定位**: 我（EchoAgent / Tim的开发助手）作为 AutoMater 的 dev-agent 伙伴，需要哪些 Skill 来高效辅助 AutoMater 项目的开发、调试、运维  
> **背景**: AutoMater 是一个 Agent 集群式软件开发桌面应用（Electron + React + TypeScript），当前处于 v0.9 → v1.0 跨越期

---

## 一、现有 Skill 盘点

### 1.1 已有 Skill（23 个）

| 分类 | Skill 名 | 与 AutoMater 的适配度 |
|---|---|---|
| 代码工程 | batch-feature-development | ✅ 批量 Feature 开发 |
| 代码工程 | code-hygiene-patrol | ✅ 代码卫生检查 |
| 代码工程 | ef-dev-cycle | ⚠️ EF(Entity Framework) 专用，不直接适用 |
| 代码工程 | fix-lifecycle | ✅ Bug 修复全生命周期 |
| 代码工程 | fix-quality-gate | ✅ 修复质量门禁 |
| 代码工程 | iterative-simplification | ✅ 迭代简化 |
| 部署运维 | deploy-consistency-check | ⚠️ 需要适配 Electron 打包场景 |
| 部署运维 | frontend-deploy-verify | ⚠️ Web 前端部署，AutoMater 是桌面端 |
| 部署运维 | safe-commit-deploy | ✅ 安全提交部署 |
| 部署运维 | supabase-full-deploy | ❌ Supabase 专用 |
| 分析调研 | competitive-analysis | ✅ 竞品分析（对标 Devin/OpenHands/Factory） |
| 分析调研 | technical-blog-analysis | ✅ 技术博客分析 |
| 调试排查 | cross-session-investigation | ✅ 跨会话追踪 |
| 调试排查 | remote-diagnosis | ⚠️ 远程诊断，需要适配 Electron 主进程 |
| 调试排查 | performance-profiling | ✅ 性能剖析 |
| 移动端 | android-build-workflow | ❌ Android 专用 |
| 移动端 | mobile-ui-audit | ❌ 移动端 UI 审计 |
| 方法论 | agent-swarm-methodology | ✅ Agent 集群方法论——核心适配！ |
| 方法论 | migration-safety | ✅ 迁移安全 |
| 数据 | production-readiness-audit | ✅ 生产就绪审计 |
| 数据 | github-issues-testing-workflow | ✅ GitHub Issue 测试工作流 |
| 记忆 | memo-sync-triple-layer | ✅ 三层记忆同步 |
| 记忆 | memory-system-audit | ✅ 记忆系统审计 |

### 1.2 适配度统计

- ✅ 直接适用: **14 个** (61%)
- ⚠️ 需要适配: **4 个** (17%)
- ❌ 不适用: **5 个** (22%)

---

## 二、缺失 Skill 分析 — 按当前 Bug 倒推

### 2.1 今天暴露的 3 个 Bug → 缺失的 3 个 Skill

| Bug | 根因 | 需要的 Skill |
|---|---|---|
| ① `gpt-5.3-codex` 不存在 | 无模型可用性预检 | **🆕 pre-flight-check** |
| ② 所有事件重复两倍 | orchestrator 被并发调用两次 | **🆕 concurrency-guard** |
| ③ 暂停→续跑死循环 | 未检查失败原因是否消解就重跑 | **🆕 circuit-breaker** |

---

## 三、需要新增的 Skill 清单（按优先级分层）

### 🔴 P0: 必须立刻补充（解决当前致命问题）

#### Skill #1: `electron-main-process-debug`
**定位**: Electron 主进程调试排查专用
**Why**: AutoMater 的核心逻辑（orchestrator, engine 40+ 模块）全部跑在 Electron 主进程。当前的 `remote-diagnosis` skill 面向 Web 服务器，不适用 Electron 架构。
**覆盖场景**:
- IPC 通信追踪（主进程 ↔ 渲染进程）
- 主进程 crash / unhandled rejection 排查
- SQLite 并发访问诊断（better-sqlite3 是同步的，但多个 orchestrator 实例并发写是灾难）
- BrowserWindow 生命周期问题
**核心检查清单**:
```
1. 复现路径: 用户操作 → IPC 调用 → 主进程函数 → 哪行出错
2. 进程隔离: 是主进程错误还是渲染进程错误？
3. 并发竞态: 同一个 projectId 是否有多个异步流在跑？
4. SQLite 状态: DB 中的 status/locked_by 是否与预期一致？
5. AbortController: 信号是否正确传播和清理？
```

#### Skill #2: `pre-flight-check`
**定位**: 项目启动前的环境/配置预检
**Why**: 当前 `runOrchestrator` 只检查 `apiKey` 非空就启动，不验证模型是否可用、workspace 是否可写、依赖是否安装。一旦有问题，15 个 worker 同时报错。
**覆盖场景**:
- LLM 模型可用性验证（试发一条最简请求）
- Workspace 路径可写性检查
- 必要配置完整性（strongModel / workerModel 非空且格式合理）
- 预算余额检查
- 已有 Feature 状态一致性检查（有无僵尸锁、状态矛盾）
**输出**: `PreflightResult { ok: boolean; issues: string[]; autoFixed: string[] }`

#### Skill #3: `concurrency-guard`
**定位**: 防止同一逻辑被并发重复执行
**Why**: `runOrchestrator` 没有防重入锁。用户双击"启动"、meta-agent 自动触发 + 用户手动触发，都会导致两个编排流并行跑，产生双倍日志、双倍 API 费用、互相干扰的状态更新。
**核心模式**:
```typescript
// registerOrchestrator 应该检查是否已存在
if (runningOrchestrators.has(projectId)) {
  log.warn('Orchestrator already running, abort duplicate');
  return; // 或者先 stop 旧的再启动新的
}
```
**扩展**: debounce IPC 调用、mutex 锁 SQLite 写入、前端按钮防抖

#### Skill #4: `circuit-breaker`
**定位**: 失败熔断 + 智能重试策略
**Why**: F001 用不可用的模型报错 → 3次重试都失败 → 标记 failed → 项目暂停 → 立刻又续跑 → 同样的模型 → 同样报错 → 无限循环。没有任何机制记住"上次为什么失败"。
**核心设计**:
```
1. 错误分类: 
   - 可重试错误（网络超时、速率限制）→ 指数退避
   - 不可重试错误（模型不存在、API Key 无效）→ 立即熔断
   - 部分可重试（token 超限）→ 降级到更小的 context
2. 熔断状态:
   - CLOSED → 正常通过
   - OPEN → 拒绝请求，直接返回上次错误
   - HALF-OPEN → 允许一次试探请求
3. 项目级熔断:
   - 记录每个 Feature 的最后失败原因 + 时间
   - 续跑时检查: 如果失败原因未变（同样的模型、同样的配置），不重复尝试
```

---

### 🟠 P1: 近期应补充（提升开发效率）

#### Skill #5: `orchestrator-state-machine`  
**定位**: 理解和调试 AutoMater 5 阶段流水线的状态机
**Why**: 当前 orchestrator 的状态流转（initializing → developing → paused → ...) 分散在 1162 行代码中，没有统一的状态机定义。调试时需要理解每个 phase 的入口条件、退出条件、异常处理。
**覆盖内容**:
- 5 阶段流水线的完整状态图
- 每个 Phase 的前置条件 / 后置保证
- isResume=true 时的分诊逻辑流
- Feature 状态机: todo → in_progress → reviewing → qa_passed → passed/failed
- Worker 竞争锁: lockNextFeature 的原子性
**价值**: 快速定位"项目卡在哪个阶段、为什么"

#### Skill #6: `llm-api-compatibility`
**定位**: 多 LLM Provider 兼容性问题排查
**Why**: AutoMater 支持 OpenAI + Anthropic 双协议，但用户可能配 Azure OpenAI、本地 Ollama、各种国产模型。每种的错误格式、限制不同。今天的 `gpt-5.3-codex` 就是 Azure OpenAI 端点返回的特殊错误格式。
**覆盖内容**:
- OpenAI vs Azure OpenAI vs Anthropic 的 API 差异清单
- 常见错误码及对应处理策略
- 模型名称规范化（`gpt-4o` vs `gpt-4o-2024-08-06` vs Azure deployment name）
- Token 限制查表
- Function-calling 格式差异

#### Skill #7: `react-loop-debug`
**定位**: ReAct (Reason-Act) 循环的专用调试
**Why**: AutoMater 的核心执行引擎是 ReAct 循环（react-loop.ts 800+ 行），Developer / PM 都通过它工作。当 Agent 行为异常（无限循环、选错工具、输出解析失败），需要专门的调试流程。
**覆盖内容**:
- ReAct 迭代日志分析（每轮的 think → tool_call → result → 下一步）
- 终止条件检查（task_complete 被调用? error_loop 计数器? max iterations?）
- 上下文窗口分析（消息累积到多大？是否触发截断？）
- Tool call 失败模式（工具不存在、参数格式错、权限不足）
- 成本分析（每轮的 token 消耗、总成本）

#### Skill #8: `multi-agent-coordination`
**定位**: 多 Worker 并行协调问题排查
**Why**: AutoMater 支持 1-15 个并行 dev worker。今天的日志显示 15 个 worker 全部同时"下班了"——说明没有真正的任务分发。Worker 间的文件冲突、决策日志、feature 锁定都需要系统化的调试方法。
**覆盖内容**:
- Feature 锁定竞争诊断
- Decision log 冲突检测
- Worker 负载均衡分析
- 并行写同一文件的防护检查
- Worker 空转（no feature → sleep → retry）的效率分析

---

### 🟡 P2: 中期补充（支撑 v1.0+ 演进）

#### Skill #9: `typescript-monorepo-refactor`
**定位**: TypeScript 单体向 Monorepo 迁移
**Why**: CLAUDE.md 里已经规划了 monorepo 结构 (`apps/desktop`, `packages/{shared,llm,core,sandbox}`)，当前是扁平结构。迁移过程中的 tsconfig paths、package 依赖、构建顺序都需要专门处理。

#### Skill #10: `electron-build-pipeline`
**定位**: Electron 应用打包、签名、分发
**Why**: AutoMater 最终需要打包给用户使用。Electron 的 electron-builder / electron-forge 配置、跨平台签名、auto-update 都是坑点密集区。

#### Skill #11: `agent-prompt-engineering`
**定位**: Agent System Prompt 迭代优化
**Why**: AutoMater 中 PM / Architect / Developer / QA 四种角色各有 system prompt，prompt 质量直接决定输出质量。需要系统化的 prompt A/B 测试、质量度量、迭代方法。
**覆盖内容**:
- Prompt 结构化模板（角色定义 → 能力声明 → 输出格式 → 约束条件）
- JSON 输出稳定性技巧（schema 注入、few-shot example、retry parse）
- System reminder 注入策略（Claude Code 模式：每个 tool result 后注入提醒）
- 角色人格一致性（PM 不要写代码、Developer 不要做产品决策）

#### Skill #12: `doc-driven-development`
**定位**: 文档驱动开发（AutoMater 的核心工作流）
**Why**: AutoMater 的 5 阶段流水线是文档驱动的：需求文档 → 设计文档 → 架构文档 → 子需求文档 → 测试规格文档 → 代码。文档质量和一致性是整个系统的关键。
**覆盖内容**:
- 文档链路完整性检查（每个 Feature 都有需求文档 + 测试规格？）
- 文档变更级联更新（需求变了 → 设计要跟着变 → 测试规格也要变）
- doc-manager.ts 的工作机制（版本化存储、读写、一致性检查）

---

## 四、Skill 依赖关系图

```
                    ┌─────────────────┐
                    │  pre-flight-    │
                    │  check (#2)     │
                    └───────┬─────────┘
                            │
     ┌──────────────────────┼──────────────────────┐
     │                      │                      │
     ▼                      ▼                      ▼
┌──────────┐     ┌──────────────────┐     ┌────────────────┐
│concurrency│     │ llm-api-         │     │ circuit-       │
│guard (#3) │     │ compatibility(#6)│     │ breaker (#4)   │
└──────┬───┘     └────────┬─────────┘     └────────┬───────┘
       │                  │                        │
       ▼                  ▼                        ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐
│orchestrator- │  │ react-loop-  │  │ multi-agent-           │
│state-machine │  │ debug (#7)   │  │ coordination (#8)      │
│(#5)          │  └──────┬───────┘  └────────────────────────┘
└──────────────┘         │
                         ▼
              ┌──────────────────┐
              │ electron-main-   │
              │ process-debug(#1)│ ← 底层基础，所有调试都依赖
              └──────────────────┘
```

---

## 五、实施计划

### Sprint 1（立即）— 解决当前 3 个 Bug ✅ 完成 2026-03-01

| 任务 | 对应 Skill | 代码修改 | 状态 |
|---|---|---|---|
| 添加模型预检 | #2 pre-flight-check | `orchestrator.ts L95-113`: `validateModel()` 逐个验证 strongModel/workerModel/fastModel | ✅ |
| 防止重复启动 | #3 concurrency-guard | `orchestrator.ts L72-80` + `agent-manager.ts L26-41` + `OverviewPage.tsx` UI 防抖 | ✅ |
| 模型错误分类 | #4 circuit-breaker | `llm-client.ts`: `NonRetryableError` class + `throwOnHttpError()` 统一分类 | ✅ |
| 失败原因记录 | #4 circuit-breaker | `db.ts` v5.6 migration + `orchestrator.ts L161-201` circuit breaker + `react-loop.ts` 两处 break | ✅ |

**修改文件**: `llm-client.ts`, `orchestrator.ts`, `agent-manager.ts`, `react-loop.ts`, `db.ts`, `OverviewPage.tsx`

### Sprint 2（本周）— Skill 文档化 ✅ 完成 2026-03-02

将 #1~#4 整理为正式 Skill 文档存入 `d:\echoagent\agent-memory\skills\`：
- ✅ `electron-main-process-debug.md` (S-028) — IPC追踪+并发竞态+SQLite诊断+日志分析checklist
- ✅ `pre-flight-check.md` (S-029) — validateModel+workspace检查+预检时机+通用规则
- ✅ `concurrency-guard.md` (S-030) — 三层防护模型(UI debounce → IPC guard → 注册表替换)
- ✅ `circuit-breaker.md` (S-031) — 三级错误分类+四层实现+DB schema+通用checklist

### Sprint 3（进行中）— P1 Skill 补充 ✅ 完成 2026-03-02

- ✅ #5 orchestrator-state-machine (S-032): 完整 Project/Feature 状态图 + 5 Phase 详细流 + Resume 分诊 + 调试 Checklist
- ✅ #6 llm-api-compatibility (S-033): OpenAI/Anthropic/Azure/Ollama 差异矩阵 + 错误码策略 + Tool-calling 格式转换
- ✅ #7 react-loop-debug (S-034): 两种 ReAct 循环 + 终止条件 + 逐轮分析 + 上下文窗口 + 高频故障模式
- ✅ #8 multi-agent-coordination (S-035): Feature 原子锁 + decision-log 冲突检测 + 僵尸锁清理 + 并行效率指标

### Sprint 4（v1.0 前）— P2 Skill ✅ 完成 2026-03-02

- ✅ #9 typescript-monorepo-refactor (S-036): 渐进 4 步迁移策略 + pnpm workspace + 依赖规则 + 风险矩阵
- ✅ #10 electron-build-pipeline (S-037): 打包全流程 + better-sqlite3 asar + 签名 + 体积优化 + auto-update
- ✅ #11 agent-prompt-engineering (S-038): 6 层 prompt 结构 + JSON 稳定性多重防线 + Tool Nudge + A/B 测试
- ✅ #12 doc-driven-development (S-039): 文档链路 + doc-manager API + changelog + 一致性检查 + 质量指标

---

## 🎯 路线图完成总结

| Sprint | 阶段 | Skill 数 | 完成日期 |
|---|---|---|---|
| Sprint 1 | P0 代码修复 | — (6 文件修改) | 2026-03-01 |
| Sprint 2 | P0 Skill 文档化 | 4 (S-028~S-031) | 2026-03-02 |
| Sprint 3 | P1 Skill 补充 | 4 (S-032~S-035) | 2026-03-02 |
| Sprint 4 | P2 Skill 补充 | 4 (S-036~S-039) | 2026-03-02 |
| **合计** | | **12 新 Skill** | |

**技能库**: 23 → 35 个（+12），AutoMater 直接适用 22 → 26 个

---

## 六、与现有设计文档的关系

| 设计文档 | 与本路线图的关系 |
|---|---|
| `REVIEW-v0.9.md` | 差距分析 → 本文档将每个差距映射到具体 Skill |
| `TOOL-EXPANSION-PLAN.md` | 工具扩展计划 → 每个 Tier 的工具落地都需要对应 Skill 支撑 |
| `DESIGN.md` | 系统设计 → Skill #5 (orchestrator state machine) 是其执行指南 |
| `AutoMater.md` | 项目脑 → 每个 Sprint 完成后 ADR 更新 |

---

## 七、关键认知

### 7.1 为什么 dev-agent 伙伴需要专门的 Skill

AutoMater 不是普通的 Web 项目。它的特殊性：

1. **自指性 (Self-referential)**: 我在帮助开发一个 Agent 系统，同时我自己就是一个 Agent。理解 Agent 的行为模式既是领域知识也是自我反思。
2. **状态爆炸**: 5 个 Phase × 15 个 Feature × 15 个 Worker × 多种 Agent 角色 = 状态组合爆炸。没有系统化的状态理解就无法调试。
3. **LLM 不确定性**: 每次 LLM 调用的输出都不同。Bug 可能是确定性的（代码错误）也可能是概率性的（LLM 输出解析失败）。
4. **并发 + 异步**: Electron 主进程单线程 + Promise 并发 + SQLite 同步写 = 微妙的竞态条件。

### 7.2 优先级原则

**先止血（P0）→ 再固化（P1）→ 后演进（P2）**

当前 AutoMater 的问题不是缺少高级功能，而是基础的鲁棒性不足。一个不能稳定完成单次运行的系统，加再多工具也没用。
