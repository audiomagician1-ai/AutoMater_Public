# AgentForge 架构优化分析报告

> 撰写日期: 2026-03-01
> 参照标准: Anthropic Context Engineering (2025.09), Codified Context (arXiv 2602.20478, 2026.02), Factory Droids, Claude Code Task 模式

---

## 一、现状诊断：Planner 的定位矛盾

### 1.1 问题描述

- **DEFAULT_TEAM** (8人): `pm`, `architect`, `tech_lead`, `developer×3`, `qa`, `devops`
- **WorkflowPage UI** 中显示了一个 `Planner` 阶段（id='plan', agent='Planner'）
- **实际编排器** (`orchestrator.ts`) 的 7 阶段流水线中 **没有 Planner 阶段**：

```
Phase 1: PM 需求分析 → Feature 清单
Phase 2: PM 设计文档
Phase 3: Architect 技术架构
Phase 4: PM 子需求拆分 + QA 测试规格    ← UI 标为"Planner"
Phase 5: Developer 实现 (ReAct) + QA 审查
Phase 6: PM 验收审查
Phase 7: 汇总 + 用户验收
```

### 1.2 Planner 在代码中的实际位置

"Planner" 不是一个独立的 Agent 角色，而是嵌入在 **Developer 的 ReAct 循环内部** 的一个 `Step 1`：

```typescript
// react-loop.ts 第 214-251 行
// ── Step 1: 规划 ──
const planModel = resolveModel(selectModelTier({ type: 'planning' }).tier, settings);
// 使用 PLANNER_FEATURE_PROMPT，调用 worker 模型
plan = parsePlanFromLLM(planResult.content, feature.id, ...);
```

换言之：
- **每个 Feature 开始开发前**，Developer Agent 都会先做一次 planning LLM 调用
- 使用的是 `worker` 模型（弱模型），不是 strong 模型
- `planner.ts` 是一个纯工具模块（解析 Plan 步骤），不是 Agent 实例

### 1.3 另一个"Planner"：Phase 4

Phase 4 (`phaseReqsAndTestSpecs`) 实际上由 **PM** 执行子需求拆分 + **QA** 写测试规格。
这个阶段在 WorkflowPage 的 UI 中被标记为 "Planner → 任务拆分"，但执行者是 PM + QA，不是任何名为 Planner 的 Agent。

### 1.4 tech_lead 的幽灵

`tech_lead` 在 DEFAULT_TEAM 中被定义（有完整的 system_prompt），但在 orchestrator 中 **从未被调用**。

### 1.5 元Agent 与 PM 的职责边界 (v5.0 澄清)

**元Agent (MetaAgent) — 轻量常驻 + 按需深入**：
- 跨项目一站式交互入口，**默认轻量上下文**（~2K tokens：通用指令 + 项目列表元数据）
- 核心职责：需求接收与路由、跨项目状态查询、工作流调整
- **按需查询**：当用户需要了解某个项目的设计文档、技术架构、Feature 进度等细节时，元Agent **懒加载**对应项目的文档摘要返回给用户，确保用户对项目有充分掌控力
- 查询策略：不预加载全量设计文档，而是根据用户问题 on-demand 检索相关文档片段（类似 RAG），保持 token 高效

**PM Agent**：
- 项目专属角色，**加载完整项目上下文**（已有 Feature、设计文档、架构文档）
- 职责：需求分诊（新需求 vs 迭代变更）、Feature 拆分、子需求编写、验收审查
- `detectImplicitChanges`（续跑分诊）由 PM 执行（agent id: `pm-triage-*`）

**职责边界**：元Agent 是用户最直接的交互入口，既能路由需求给团队，也能按需查询任何项目的技术/设计细节。PM 负责深度分析和决策（分诊、拆分、验收），需要完整项目上下文。这个分层设计兼顾了 token 效率（元Agent 默认轻量）和用户掌控力（按需深入任意细节）。
`grep tech_lead electron/engine/` 返回 0 结果。这是另一个定义与实际脱节。

---

## 二、Token 投入产出比分析

### 2.1 当前流水线的 Token 消耗模型

假设一个中等项目（wish ≈ 500 字，最终拆为 8 个 Feature）：

| Phase | 调用次数 | 模型层 | 单次 token (est.) | 小计 |
|-------|---------|--------|-------------------|------|
| P1: PM 需求分析 | 1 | strong | ~5K in + 4K out | 9K |
| P2: PM 设计文档 | 1 | strong | ~6K in + 8K out | 14K |
| P3: Architect 架构 | 1 | strong | ~8K in + 8K out | 16K |
| P4a: PM 子需求 (per-feat) | 8 | strong | ~4K in + 3K out | 56K |
| P4b: QA 测试规格 (per-feat) | 8 | strong | ~4K in + 3K out | 56K |
| P5-plan: Developer 规划 (per-feat) | 8 | worker | ~3K in + 1K out | 32K |
| P5-react: Developer ReAct (per-feat, ~10 iter avg) | 80 | worker/strong | ~8K in + 2K out | 800K |
| P5-qa: QA 审查 (per-feat) | 8+ | strong | ~6K in + 2K out | 64K |
| P6: PM 验收 (per-feat) | 8 | strong | ~5K in + 1.5K out | 52K |
| P7: 汇总 | 1 | - | minimal | ~2K |
| **Total** | | | | **~1,100K tokens** |

### 2.2 Token 浪费热点

1. **Phase 4 的 2N 串行调用**（N = feature 数）：每个 Feature 都独立调用 strong 模型生成子需求文档和测试规格，上下文高度重复（设计文档被反复注入）。8 个 Feature = 16 次 strong 模型调用，消耗 ~112K tokens。

2. **Developer planning 步骤冗余**：`react-loop.ts` 中 Step 1 planning 用 worker 模型生成 3-12 步的计划，但紧接着的 ReAct 循环中 Developer 又需要 `think` 来规划——两者高度重叠。

3. **Phase 2 设计文档 + Phase 3 架构文档分离**：PM 先写设计文档，然后 Architect 读设计文档再写架构文档。这两步可以合并或紧耦合（设计→架构是严格单向的，中间没有人工检查点）。

4. **tech_lead 定义但未使用**：定义白占 system_prompt 存储，但更关键的是——它暗示了一个"技术主管审查开发者产出"的步骤被跳过了。要么补上，要么删除定义。

---

## 三、2026 国际先进实践对标

### 3.1 Anthropic: Context Engineering（2025.09）

核心原则：**最小化高信号 token 集合**。

- ✅ AgentForge 已做到：`context-collector.ts` 有预算控制、`code-graph.ts` 做确定性依赖追踪
- ❌ 未做到：**compaction（上下文压缩）**——ReAct 循环接近上下文窗口时，应该 summarize 并 reinitiate，而非截断
- ❌ 未做到：**tool result trimming**——工具返回的大段代码未被按需压缩

### 3.2 Codified Context 论文（arXiv 2602.20478, 2026.02）

108,000 行 C# 项目的实践：

- **三层架构**：Hot Memory（constitution，始终加载）+ Domain Expert Agents（19 个专家）+ Cold Memory（34 个按需规格文档）
- **关键洞察**：单一 CLAUDE.md 不适合大项目，需要分层的 codified context 基础设施
- AgentForge 对标：已有 `AGENTS.md` + `ARCHITECTURE.md` + `repo-map`，但缺乏 **hot/cold memory 分层** 和 **domain-expert routing**

### 3.3 Claude Code Task 模式 / Factory Droids

2026 主流趋势：**用子 Agent 替代独立 planning 阶段**。

- Claude Code 的 `Task` 工具：主 Agent spawn 子 Agent 做只读研究，拿回结论后继续工作
- AgentForge 已有 `sub-agent.ts`（`runResearcher`），但仅在开发阶段可用
- **planning 不需要独立阶段**——现代实践是让 Developer Agent 在 ReAct 循环的第一次 `think` 中自行规划

### 3.4 OpenAI Codex / Devin: 扁平化趋势

2026 年趋势是**减少预规划，增加自适应**：
- 不做大量 upfront 文档生成
- 用 **streaming spec** 代替 waterfall spec（边做边细化规格）
- 用 **checkpoint+rollback** 代替严格的 gate

---

## 四、优化方案：7 阶段 → 5 阶段扁平化

### 4.1 新流水线设计

```
Phase 1: PM 分析 + 架构设计（合并 P1+P2+P3）
  ├─ 1a: PM 需求分析 → Feature 清单（strong 模型）
  └─ 1b: Architect 架构设计（strong 模型，注入 Feature 清单）
  （移除独立的 PM 设计文档步骤，架构文档包含设计信息）

Phase 2: 文档生成（合并 P4a+P4b，批量化）
  ├─ 批量子需求：一次 LLM 调用处理多个 Feature（4-6个一组）
  └─ 批量测试规格：同上
  （从 2N 次调用降为 ~4 次调用）

Phase 3: Developer 实现 + QA 审查（原 P5，移除独立 planning）
  ├─ Developer ReAct 循环（think 步骤内置 planning，不再单独调用）
  └─ QA 审查

Phase 4: PM 验收（原 P6，批量化）
  └─ 一次调用验收多个 Feature（分组）

Phase 5: 汇总 + 用户验收（原 P7）
```

### 4.2 Token 节约估算

| 优化项 | 原消耗 | 新消耗 | 节约 |
|--------|--------|--------|------|
| 合并 P2 设计文档到 P3 | 14K | 0K | 14K |
| 批量化 Phase 4 (8→2 calls) | 112K | ~40K | 72K |
| 移除 Developer planning 步骤 | 32K | 0K | 32K |
| 批量化 PM 验收 (8→3 calls) | 52K | ~20K | 32K |
| **合计** | | | **~150K (13.6%)** |

### 4.3 具体代码变更清单

| 变更 | 文件 | 内容 |
|------|------|------|
| 1. 删除 `phasePMDesignDoc` | `orchestrator.ts` | 整个函数移除，设计信息合并到架构文档 prompt |
| 2. 修改 `phaseArchitect` | `orchestrator.ts` | 扩展 prompt 包含设计文档职责 |
| 3. 批量化 `phaseReqsAndTestSpecs` | `orchestrator.ts` | 分组处理，4-6 Feature 一组 |
| 4. 删除 react-loop planning step | `react-loop.ts` | 移除 Step 1 独立 planning 调用，依赖 ReAct think |
| 5. 批量化 `phasePMAcceptance` | `orchestrator.ts` | 分组处理 |
| 6. 删除 tech_lead 或启用它 | `project.ts` | 从 DEFAULT_TEAM 移除（推荐），或在 QA 后加入审查 |
| 7. 更新 WorkflowPage | `WorkflowPage.tsx` | 移除 Planner 节点，更新为 5 阶段 |
| 8. 更新 prompts | `prompts.ts` | 合并/优化相关 prompt |

### 4.4 关于 tech_lead 的决策建议

**推荐：移除 tech_lead，其职责分散到其他角色**。

理由：
- 2026 实践表明，最佳 token ROI 来自 **减少中间审查层**，而非增加
- tech_lead 的 "代码审查" 职责与 QA 重叠
- tech_lead 的 "任务拆解" 职责与 PM 的 Phase 4 重叠
- 实际工程中，LLM 作为 tech_lead 审查其他 LLM 的代码，ROI 很低——不如强化 QA 的程序化检查

---

## 五、大型已有项目导入/分析方案

### 5.1 核心挑战

1. **上下文窗口限制**：10 万行代码 ≈ 200K+ tokens，远超任何模型的有效上下文
2. **代码图谱构建**：需要理解 import/export、继承、调用链
3. **文档自动生成**：需要从代码反推出设计文档、架构文档
4. **增量处理**：不能一次读完，需要分批处理

### 5.2 分层渐进式分析架构

```
┌──────────────────────────────────────────────────┐
│              Phase 0: 零成本静态扫描               │
│  (无 LLM 调用, 纯本地计算)                         │
│                                                    │
│  ├─ code-graph.ts: 构建文件级依赖图               │
│  ├─ repo-map.ts: 提取符号表 (函数/类/接口)         │
│  ├─ 统计信息: LOC, 文件类型分布, 目录结构           │
│  └─ 检测: package.json/Cargo.toml/go.mod → 技术栈 │
│                                                    │
│  产出: skeleton.json (项目骨架，~2000 tokens)       │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│        Phase 1: 分层摘要 (Bottom-Up Summarize)    │
│  (LLM 调用, worker 模型, 按模块分批)               │
│                                                    │
│  策略: 叶子模块 → 中间模块 → 顶层                   │
│                                                    │
│  对每个模块 (按 code-graph 的强连通分量分组):       │
│  ├─ 读取模块内所有文件 (≤10K tokens/批)            │
│  ├─ LLM 生成模块摘要:                              │
│  │   - 职责描述 (1-2 句)                           │
│  │   - 公开 API 列表                                │
│  │   - 依赖关系                                     │
│  │   - 关键数据结构                                  │
│  └─ 存储: .agentforge/analysis/module_summaries/   │
│                                                    │
│  产出: 每模块一个 summary.md (~500 tokens/模块)     │
│  总量控制: 强模型仅用于 top-level 架构推断          │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│        Phase 2: 架构图合成 (Top-Down Synthesize)  │
│  (强模型, 单次调用)                                 │
│                                                    │
│  输入: skeleton.json + 所有模块摘要 (~8K tokens)    │
│  输出:                                              │
│  ├─ ARCHITECTURE.md (系统级架构文档)                │
│  ├─ architecture-diagram.mermaid (可视化)           │
│  └─ module-dependency-graph.json (机器可读)         │
│                                                    │
│  关键: 此时 LLM 看到的是 *摘要的摘要*，而非源码     │
│  Token 成本: ~12K in + ~8K out = ~20K              │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│      Phase 3: 文档框架填充 (Auto-Populate)         │
│  (worker 模型, 批量调用)                            │
│                                                    │
│  对每个识别出的功能模块:                             │
│  ├─ 生成 设计文档 (总览级 / 系统级 / 功能级)       │
│  ├─ 生成 子需求文档 (从代码反推需求)                │
│  └─ 生成 测试规格 (从已有测试推断 + 补充)          │
│                                                    │
│  自动归类到 DocsPage 的 5 级文档树:                 │
│  ├─ 总览设计文档                                    │
│  ├─ 系统级设计文档                                  │
│  ├─ 功能级设计文档                                  │
│  ├─ 子需求文档                                      │
│  └─ 测试规格                                        │
└────────────────────┬─────────────────────────────┘
                     ▼
┌──────────────────────────────────────────────────┐
│      Phase 4: 持续更新 (Living Documents)          │
│                                                    │
│  当用户修改代码后:                                   │
│  ├─ 检测变更的文件 (git diff)                       │
│  ├─ 通过 code-graph 找到受影响的模块                │
│  ├─ 仅重新生成受影响模块的摘要                       │
│  └─ 增量更新架构文档                                │
│                                                    │
│  Token 成本: 仅为变更量的 ~5%                       │
└──────────────────────────────────────────────────┘
```

### 5.3 上下文受限的关键技术

#### 5.3.1 分治 + 摘要金字塔 (Summarize Pyramid)

```
源代码 (200K+ tokens)
    ↓ 分治摘要 (worker 模型, 每批 ≤10K tokens)
模块摘要集 (~15K tokens)
    ↓ 合成 (strong 模型, 单次调用)
架构文档 (~5K tokens)
```

关键约束：每层压缩比 ≥ 10:1，确保顶层调用不超过模型有效上下文。

#### 5.3.2 Code Graph 引导的读取策略

不随机/全量读取代码，而是按依赖图遍历：

1. 从入口文件 (main, index, App) 开始
2. BFS 遍历 import 链，每层控制深度
3. 优先读取：export 多的模块（hub 节点）、被依赖多的文件
4. 跳过：测试文件、配置文件、generated code

这复用了 AgentForge 已有的 `code-graph.ts` 和 `repo-map.ts`。

#### 5.3.3 Hot/Cold Memory 分层（对标 Codified Context 论文）

| 层级 | 内容 | 大小 | 加载时机 |
|------|------|------|----------|
| Hot | skeleton.json + ARCHITECTURE.md 摘要 | ~3K tokens | 始终 |
| Warm | 模块摘要索引 (title + 1句描述) | ~2K tokens | 始终 |
| Cold | 单模块详细摘要 + 源码片段 | ~5K/模块 | 按需（当 Feature 涉及该模块时） |

#### 5.3.4 增量分析（避免重复消耗）

- 首次分析：全量扫描，产出缓存在 `.agentforge/analysis/` 目录
- 后续：仅分析 git diff 涉及的文件，增量更新摘要
- 缓存失效策略：文件 hash 对比，仅变更文件重新摘要

### 5.4 Token 成本估算

以 100K 行项目（~200 个文件, ~30 个模块）为例：

| 阶段 | Token 消耗 | 模型 |
|------|-----------|------|
| Phase 0 静态扫描 | 0 | 无 |
| Phase 1 模块摘要 (30 模块) | ~120K | worker |
| Phase 2 架构合成 | ~20K | strong |
| Phase 3 文档填充 (30 模块) | ~180K | worker |
| **Total** | **~320K tokens** | |

对比直接读取全部源码 (200K+ tokens × 至少 2 次调用): 节约 ~60%。

### 5.5 实现路径

需要新增的代码模块：

| 模块 | 文件 | 功能 |
|------|------|------|
| ProjectImporter | `electron/engine/project-importer.ts` | 主入口，协调 4 个 Phase |
| StaticAnalyzer | `electron/engine/static-analyzer.ts` | Phase 0: 零成本扫描 |
| ModuleSummarizer | `electron/engine/module-summarizer.ts` | Phase 1: 分治摘要 |
| ArchSynthesizer | (扩展 `orchestrator.ts`) | Phase 2: 架构合成 |
| DocPopulator | (扩展 `doc-manager.ts`) | Phase 3: 文档填充 |
| IncrementalUpdater | (扩展 `change-manager.ts`) | Phase 4: 增量更新 |

UI 入口：在 ProjectsPage 创建项目时增加 "导入已有项目" 选项。

---

## 六、总结与优先级排序

### 立即可做（低风险高收益）

1. **删除 tech_lead**（或标记为 reserved）—— 消除定义与实际的脱节
2. **移除 Developer planning 独立调用** —— 依赖 ReAct 的 think 步骤即可
3. **更新 WorkflowPage** —— 移除 Planner 节点，匹配实际流水线

### 短期优化（中等工作量）

4. **合并 Phase 2 到 Phase 3** —— PM 设计文档纳入 Architect 阶段
5. **批量化 Phase 4** —— 多 Feature 一组调用
6. **批量化 Phase 6** —— PM 批量验收

### 中期特性（较大工作量）

7. **实现 Project Importer** —— 大型项目分析导入
8. **Hot/Cold Memory 分层** —— 提升上下文工程质量
9. **Compaction (上下文压缩)** —— ReAct 循环中的智能摘要

### Token 节约总览

| 层面 | 预期节约 |
|------|---------|
| 流水线扁平化 | ~13-15% |
| 批量化 | ~10-12% |
| 上下文工程优化 | ~5-8% |
| **综合** | **~25-30%** |

---

## 参考来源

1. [Anthropic - Effective Context Engineering for AI Agents (2025.09)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
2. [Codified Context: Infrastructure for AI Agents in a Complex Codebase (arXiv 2602.20478, 2026.02)](https://arxiv.org/html/2602.20478)
3. [Faros AI - Best AI Coding Agents 2026](https://www.faros.ai/blog/best-ai-coding-agents-2026)
4. [Morphic Research - Code Search Bottleneck](https://www.morphllm.com/blog/code-search-bottleneck)
5. AgentForge 源码分析: `orchestrator.ts`, `react-loop.ts`, `planner.ts`, `model-selector.ts`, `context-collector.ts`, `code-graph.ts`
