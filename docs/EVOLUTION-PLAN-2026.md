# AgentForge 架构演进计划 — 基于 CrewAI 深度调研
> 基线: v24.0 (2026-03-03) | 作者: 架构审计
>
> 原则: **拒绝冗余，只改有痛感的地方**

---

## 一、苛刻审视：当前架构的真实状态

### 1.1 工作流系统 — "名为DAG，实为线性"

**表面**：`workflow_presets` 表存储 `WorkflowStage[]`，用户可以在 UI 中拖拽排列阶段，看起来很灵活。

**真相**：`orchestrator.ts` L310-621 的执行逻辑是 **硬编码的 if/else 瀑布**：

```
L324: if (hasStage(workflowStages, 'pm_analysis'))     → phasePMAnalysis()
L334: if (hasStage(workflowStages, 'architect'))        → phaseArchitect()
L340: if (hasStage(workflowStages, 'docs_gen'))         → phaseReqsAndTestSpecs()
L344: else if (hasStage(workflowStages, 'pm_triage'))   → phasePMAnalysis() (同一函数!)
      ─── 进入 workerLoop (Dev+QA 循环) ───
L596: if (hasStage(workflowStages, 'pm_acceptance'))    → phasePMAcceptance()
L604: if (hasStage(workflowStages, 'incremental_doc_sync')) → phaseIncrementalDocSync()
L612: if (hasStage(workflowStages, 'devops_build'))     → phaseDeployPipeline()
L620: if (hasStage(workflowStages, 'finalize'))         → phaseFinalize()
```

`hasStage()` 本质上只是一个 **"是否跳过"的开关**。无论用户在 UI 里把 `qa_review` 放在 `architect` 前面，执行顺序不会改变。`WorkflowEditor` 给用户的是一个假的自由度。

**致命缺陷**：
1. **无法循环**：Dev→QA 的重试循环硬编码在 `worker-phase.ts:156`（`maxQARetries=3`），不可配置。QA 失败 3 次后强制标 `failed`，没有任何路径能回退到 PM 或 Architect 重新评估。
2. **阶段无返回值标准**：每个 Phase 函数返回值不一致 — `phasePMAnalysis` 返回 `FeatureRow[]`，`phaseArchitect` 返回 `void`，`phaseDeployPipeline` 返回 `void`。后续阶段不可能引用前序阶段的结论。
3. **不可配置的并行度**：`workerCount` 是全局设置，无法按阶段定义"PM分析用1个worker，开发用4个"。

### 1.2 记忆系统 — 已够用，但有一个盲区

**好的部分**：
- `memory-layers.ts`: Hot/Warm/Cold 三层分级，设计合理
- `memory-system.ts`: Global/Project/Role 三级记忆，覆盖完整
- `experience-harvester.ts`: QA fail→fix 自动提取经验
- `scratchpad.ts`: Agent 级 TODO 和进度记录

**盲区**："错题集"只写不查。`recordLessonLearned()` 写入 `project-memory.md`（append 模式），但 `collectDeveloperContext()` 的记忆注入只读 Hot/Warm 层（主要是架构文档和骨架），**不主动检索历史 QA 失败原因**。Agent 在犯同一类错误时，记忆中并没有相关的负面约束。

### 1.3 Agent 配置 — 已有雏形但未完成

**已有**：`team_members` 表已支持 `system_prompt`、`model`、`mcp_servers`、`skills`。`getTeamPrompt()` 在 `agent-manager.ts:117` 实现了"DB 覆盖 → 内置 fallback"的分层逻辑。

**缺失**：
- `prompts.ts` 有 540+ 行硬编码的 Prompt 模板，但 `team_members.system_prompt` 只能整体覆盖，不能追加片段
- 无法在 UI 中"预览" Agent 的最终组合 Prompt（team_members 自定义 + 内置基座 + category guidance + context discipline）
- `allowed_tools` 绑定不在 `team_members`，而是在 `tool-registry.ts` 通过 `AgentPermissions` 硬编码

### 1.4 上下文传递 — 隐式且脆弱

**问题**：Phase 之间的数据传递完全依赖 **DB 状态 + 文件系统**。
- PM 分析结果 → 写入 `features` 表 → Architect 从表中读
- Architect 设计 → 写入 `ARCHITECTURE.md` → Developer 从文件读
- QA 反馈 → 作为变量传入 `reactDeveloperLoop(qaFeedback)` → 只在 Dev-QA 循环内存活

没有标准化的"阶段输出"概念。如果想做"架构设计完了，PM 验证一下架构是否满足需求"这种回路，不改代码做不到。

---

## 二、增强方案 — 只改有痛感的地方

### 增强 1: 真正的 DAG 工作流引擎 [v25.0] — 核心

**痛点**：用户说的"像现在这样一条线"

**方案**：在不重写 orchestrator 的前提下，升级工作流配置结构和执行引擎。

#### 1a. 数据结构

```typescript
// electron/engine/types.ts — 新增

/** 阶段转移条件 */
interface WorkflowTransition {
  /** 目标阶段 ID */
  target: WorkflowStageId;
  /** 触发条件 (简单表达式，引擎解析) */
  condition: 'success' | 'failure' | 'always' | string;
  /** 条件为 failure 时最大重试次数 (防止死循环) */
  maxRetries?: number;
}

/** 增强的工作流阶段 — 向后兼容 */
interface WorkflowStage {
  id: WorkflowStageId;
  label: string;
  icon: string;
  color: string;
  skippable?: boolean;
  // ── 以下为 v25.0 新增 ──
  /** 转移规则。如果为空，走默认: 成功→数组中下一个阶段，失败→终止 */
  transitions?: WorkflowTransition[];
  /** 该阶段使用的 worker 数。不设则用全局 workerCount */
  workerCount?: number;
  /** 最大重试次数 (覆盖全局 maxQARetries) */
  maxRetries?: number;
}
```

#### 1b. 执行引擎

```typescript
// orchestrator.ts 核心改造思路（伪代码）

// 将 Phase 函数注册为名字 → 执行器映射
const PHASE_EXECUTORS: Record<WorkflowStageId, PhaseExecutor> = {
  pm_analysis:  { exec: phasePMAnalysis,  returns: 'features' },
  architect:    { exec: phaseArchitect,   returns: 'void' },
  docs_gen:     { exec: phaseReqsAndTestSpecs, returns: 'void' },
  dev_implement:{ exec: workerLoop,       returns: 'features_status' },
  qa_review:    { exec: /* 内嵌在 workerLoop 中 */, returns: 'verdict' },
  pm_acceptance:{ exec: phasePMAcceptance, returns: 'verdict' },
  // ... 其他阶段
};

// 状态机驱动的主循环
let currentStage = stages[0];
const stageResults = new Map<string, PhaseResult>();
const retryCounters = new Map<string, number>();

while (currentStage && !signal.aborted) {
  const result = await executeStage(currentStage, stageResults);
  stageResults.set(currentStage.id, result);

  // 解析下一阶段
  const next = resolveNextStage(currentStage, result, stages, retryCounters);
  if (next === null) break; // 正常结束或不可恢复错误
  currentStage = next;
}
```

#### 1c. 内置工作流预设升级

```
完整开发 (v25):
  PM分析 ──success──→ 架构设计 ──success──→ 文档生成 ──success──→ 开发实现
                                                                      │
                                                              ┌──failure(≤3)──┐
                                                              ↓               │
                                                          QA审查 ────────────┘
                                                              │
                                                        success↓
                                                          PM验收 ──failure──→ 开发实现(rework)
                                                              │
                                                        success↓
                                                          DevOps构建 → 交付

快速迭代 (v25):
  PM分诊 → 开发实现 ⇄(failure≤3) QA审查 → 交付

质量加固 (v25):
  静态分析 → QA审查 ──failure──→ 生成修复补丁 → QA审查(重验) → 报告输出
```

**关键**：Dev→QA 的循环不再硬编码在 `worker-phase.ts` 中，而是通过 `transitions` 配置。用户可以自己定义"QA不过→回退到哪个阶段"以及"最多重试几次"。

#### 1d. 可视化

保持现有的列表视图为默认视图（简单场景足够），新增"图形视图"选项卡：
- 使用项目已有的 `dagre` 依赖做布局（`@types/dagre` 在 `devDependencies` 中）
- 阶段作为节点，`transitions` 作为边，`failure` 边用红色虚线

### 增强 2: 阶段结果标准化 [v25.0] — 增强1的前置

**痛点**：Phase 之间信息不传递

```typescript
// electron/engine/types.ts — 新增

/** 每个阶段的标准化输出 */
interface PhaseResult {
  stageId: WorkflowStageId;
  status: 'success' | 'failure' | 'partial';
  /** 结论摘要 (200字内)，供后续阶段的 Prompt 引用 */
  summary: string;
  /** 结构化产物 (可选) */
  artifacts?: {
    featureIds?: string[];
    filesCreated?: string[];
    testResults?: { passed: number; failed: number };
    reviewScore?: number;
  };
  /** 耗时 & 成本 */
  durationMs: number;
  costUsd: number;
}
```

每个 Phase 函数统一返回 `PhaseResult`。orchestrator 将所有前序 `PhaseResult.summary` 拼接为 `## 前序阶段摘要` 注入后续 Prompt。这解决了长链路的"信息衰减"问题。

### 增强 3: 错题集主动检索 [v25.0] — 低成本高回报

**痛点**：经验写了但不读

**方案**：在 `collectDeveloperContext()` 中增加一个 `Lesson Recall` 段：

```typescript
// context-collector.ts 中 collectDeveloperContext() 末尾追加

// 错题集检索 — 从 project-memory.md 中查找与当前 Feature 相关的历史失败经验
const lessons = searchProjectMemoryForLessons(workspacePath, feature);
if (lessons) {
  addSection({
    id: 'lesson-recall',
    label: '⚠️ 历史教训 (必须避免重蹈覆辙)',
    text: lessons,
    priority: 95, // 仅次于任务描述
  });
}
```

实现 `searchProjectMemoryForLessons()`：读取 `project-memory.md`，用 feature 的 `title + description` 做简单关键词匹配（不需要 embedding，因为经验条目本身就包含 featureId 和错误描述）。

### 增强 4: Prompt 组合可视化 [v26.0] — 改善调试体验

**痛点**：用户在 TeamPage 自定义了 `system_prompt`，但不知道最终 Agent 收到的完整 Prompt 是什么样的

**方案**：在 Settings/Team 页面增加 "Prompt 预览" 按钮，调用新 IPC `agent:preview-prompt`，返回完整的 system prompt 组装结果：

```
[基座 Prompt: prompts.ts 中的 DEVELOPER_REACT_PROMPT]
[用户自定义覆盖: team_members.system_prompt]
[Category Guidance: getCategoryGuidance()]
[Context Discipline: withContextDiscipline()]
---
总 token 估算: ~1,200
```

---

## 三、被否决的特性（及理由）

| CrewAI 特性 | 是否引入 | 理由 |
|---|---|---|
| **Manager Agent (Hierarchical Process)** | ❌ | orchestrator 的规则驱动调度比 LLM 驱动更稳定、更便宜。在代码工程场景中，让 LLM 决定"接下来交给谁"会导致不确定性和浪费。 |
| **Native Delegation (allow_delegation)** | ❌ | 已有 `spawn_researcher` 等显式子Agent工具。自动委托在开放域有用，但在代码生成场景容易造成"Agent 甩锅" — 让别人去查资料而自己不写代码。 |
| **Crew Training (HITL Feedback Loop)** | ❌ | `experience-harvester.ts` 已实现自动从 QA fail→fix 中提取经验。CrewAI 的 Training 需要人工逐条反馈，与我们"全自动"的定位矛盾。 |
| **Flow @start/@listen 装饰器** | ❌ | 我们用 JSON 配置定义工作流，比代码级装饰器更利于 GUI 编辑和序列化存储。增强 `WorkflowStage.transitions` 即可实现等效能力。 |
| **YAML 配置分离** | ⚠️ 延后 | `team_members` 表已提供 DB 级配置覆盖。YAML 导入/导出可作为 v27.0 的增量功能，但不是 v25 的优先项。 |
| **Entity Memory** | ❌ | 我们的 Hot Memory (`skeleton.json`) 已包含项目实体信息（模块名、技术栈、入口文件）。专门的 Entity Memory 在代码场景中价值有限。 |
| **Pydantic 输出约束** | ⚠️ 部分采纳 | PM 阶段已使用 JSON Schema 约束输出（`prompts.ts` 中的 PM_SYSTEM_PROMPT 有严格格式要求）。其他阶段可在 Phase 输出标准化时逐步引入。 |
| **A2A Protocol** | ❌ | 我们是桌面端单机应用，不需要跨网络 Agent 互操作。 |
| **Knowledge (RAG)** | ❌ | Hot/Warm/Cold 分层 + 文件系统直接读取对代码项目更高效。PDF/CSV 等非代码知识源不在我们的核心场景内。 |

---

## 四、实施优先级

| 优先级 | 增强项 | 版本 | 工作量 | 预期收益 |
|---|---|---|---|---|
| **P0** | 增强 1: DAG 工作流引擎 | v25.0 | 3-5天 | 解决"一条线"核心痛点。用户可配置 QA→Dev 回退循环、PM 验收失败→重新开发。 |
| **P0** | 增强 2: 阶段结果标准化 | v25.0 | 1-2天 | 增强 1 的前置依赖。统一 PhaseResult，打通阶段间信息传递。 |
| **P1** | 增强 3: 错题集主动检索 | v25.0 | 0.5天 | 低成本高回报。减少 Agent 犯重复错误。 |
| **P2** | 增强 4: Prompt 组合预览 | v26.0 | 1天 | 改善调试体验，帮助用户理解 Agent 行为。 |

---

## 五、附录: 当前系统的强项（不要改的地方）

为了避免过度工程化，以下子系统经审视认为**设计合理，应保持现状**：

1. **Hot/Warm/Cold 记忆分层** (`memory-layers.ts`): 比 CrewAI 的通用 RAG 更适合代码项目。Skeleton → 模块摘要 → 详细源码的三级缓存设计精确。
2. **ReAct 终止控制器** (`guards.ts`): 11 种终止条件 (max_iterations/tokens/cost/time/idle/error/repeat/semantic_loop/aborted/budget/task_complete) 的程序化检查，比 CrewAI 依赖 `max_iter` 一个参数更精细。
3. **Experience Harvester** (`experience-harvester.ts` + `scratchpad.ts`): QA fail→fix 自动经验提取 + post-feature 收割 + 项目记忆自治压缩，这套系统比 CrewAI 的 Training 更自动化。
4. **File Conflict Detection** (`worker-phase.ts:79-90`): 多 Worker 并行时的文件锁定 + 冲突警告，这是 CrewAI 不具备的工程细节。
5. **Budget Tracker** (`guards.ts` + `agent-manager.ts:checkBudget`): 多层预算控制（全局日预算 + 项目预算 + 单Feature 成本预警），比 CrewAI 的无预算控制更适合生产环境。
6. **团队成员配置** (`team_members` 表): system_prompt/model/mcp_servers/skills/max_iterations 已可按角色+实例配置，这比 CrewAI 的 YAML 配置实际上更灵活（因为可通过 GUI 实时修改）。
