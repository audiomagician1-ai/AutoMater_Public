# 项目导入 v7.0 最终方案 — 多探针并行探索 + 结构化拼图

> **文档版本**: v2.0 (合并版)  
> **日期**: 2026-03-02  
> **来源**: 合并 PROJECT-IMPORT-V7-ITERATION-PLAN.md + PROJECT-IMPORT-V2-PROPOSAL.md，取长补短  
> **状态**: 设计定稿 (待实施)

---

## 1. 问题陈述

### 1.1 现状 (v6.0 project-importer.ts)

```
Step 1: 轻量静态收集 (~1s, 零 LLM)
  ├─ 目录树 (depth ≤ 4)
  ├─ 关键配置文件 (package.json, README, tsconfig 等, ≤20KB)
  ├─ Repo Map 符号索引 (正则提取, ≤100 文件)
  ├─ 入口文件前 200 行 (≤10KB)
  └─ 快速 LOC/文件统计
  → 拼出 ~5-15K tokens 的项目快照

Step 2: 单次 LLM 调用 (~10-30s)
  → ARCHITECTURE.md + 模块列表 + skeleton.json
```

### 1.2 为什么 v6.0 对大型项目不 work

用户能直接塞进模型上下文的小项目根本不需要导入功能。凡是需要导入的，**必然是超出单次上下文窗口的大型/复杂项目**。

| 问题 | 严重性 | 说明 |
|------|--------|------|
| **全局视角缺失** | 🔴 | 单次 LLM 仅看到 15K token 快照，1000+ 文件项目约等于盲猜 |
| **遗漏隐性依赖** | 🔴 | 正则 Repo Map 捕获符号但不理解语义；运行时依赖、DI、事件总线不可见 |
| **屎山盲区** | 🔴 | 不规范项目的实际结构与文件名/目录暗示的结构严重不符 |
| **模块摘要空壳** | 🔴 | `ModuleSummary.publicAPI/keyTypes/dependencies` 始终为空数组 |
| **Code Graph 未利用** | 🟡 | `code-graph.ts` 仅在 context-collector 中使用，导入阶段未参与 |
| **增量更新形同虚设** | 🟡 | `incrementalUpdate()` 只标记受影响模块 ID，不重新分析内容 |

**根本问题**: 真实项目（尤其是屎山）的复杂度藏在代码内部——隐式依赖、动态分发、约定大于配置、undocumented side effects。仅从目录树+配置文件+符号列表不可能理解这些。

### 1.3 设计前提

v7.0 **不设复杂度门槛**，不保留 v6.0 快速通道——导入即深度分析。v6.0 的 `collectProjectSnapshot()` 降级为 Phase 0 的静态信息收集子步骤，是探针调度的输入，不是终点。

---

## 2. 前沿研究综述 (2025-2026)

### 2.1 搜索是瓶颈，不是编码能力

**Cognition (Devin/Windsurf)** 发现 coding agent 首轮 **>60% 的时间花在搜索**。传统串行 grep+read 需要 10-20 轮才积累足够上下文。Morph 的并行工具调用使探索效率提升 **8x**。([Cognition, 2025](https://cognition.ai/blog/swe-grep); [Morph, 2026](https://www.morphllm.com/agentic-search))

→ **导入阶段的质量直接决定后续所有 agent 的效率。**

### 2.2 Context Rot — 更多上下文让模型更差

Stanford Lost-in-the-Middle + Chroma 18 模型实验：LLM 性能随上下文长度增加呈非均匀退化。给 500 行"可能相关"不如 50 行精准。注意力机制是二次方复杂度——10K token 跟踪 1 亿关系，100K 是 100 亿。([Liu et al., TACL 2024](https://arxiv.org/abs/2307.03172); [Chroma, 2025](https://research.trychroma.com/context-rot))

→ **导入不是"读越多越好"，而是精准探测、紧凑记录。**

### 2.3 图引导搜索

**LocAgent (ACL 2025)**: 代码库→有向异构图 (文件→类→函数)，LLM 沿图结构导航。文件级定位 **92.7%**，下游修复率 +12%。**CodexGraph (NAACL 2025)**: 代码图数据库接口，支持 multi-hop 结构化查询。([Chen et al., 2025](https://aclanthology.org/2025.acl-long.426/); [CodexGraph, 2025](https://arxiv.org/abs/2408.03910))

→ **我们已有 `code-graph.ts` 的文件级 import 图，可扩展为更细粒度异构图。**

### 2.4 理解流 = 全局→结构→局部

**CodeMap (arXiv 2504.04553)**: 研究了代码审计师（每周快速理解一个陌生项目的人）的策略。核心发现：先看项目概览（技术栈、架构），再看代码结构和业务逻辑（模块关系、数据流），最后看具体函数。LLM 对话式交互效率低——用户 79% 时间在阅读 LLM 响应而非理解代码。动态信息提取 + 分层可视化 >> 静态一次性分析。([CodeMap, 2024](https://arxiv.org/abs/2504.04553))

→ **三阶段 Phase 0→1→2 正好对齐这个认知流。**

### 2.5 结构化图 >> 自然语言描述

**RPG / ZeroRepo (ICLR 2026, Microsoft)**: 用自然语言描述仓库结构不可靠——模糊、不一致、长 horizon 退化。引入结构化图（capabilities→files→functions→data types），生成代码量是 Claude Code 的 **3.9x**，覆盖率 81.5%。([RPG, arXiv:2509.16198](https://arxiv.org/abs/2509.16198))

→ **Phase 2 的核心产出应是 module-graph.json (结构化图)，而非仅 Markdown 文档。**

### 2.6 分层知识基础设施 + 多 Agent 协调

**Codified Context (arXiv 2026)**: 108K 行 C# 项目实践 hot-memory + 19 domain-expert agents + 34 on-demand spec documents。283 sessions 定量评估有效。**Anthropic 2026 Trends Report** Trend 2: 单 agent→协调 agent 团队。子 Agent 隔离使主 Agent context 保持干净，**性能提升 90%**。([Vasilopoulos, 2026](https://arxiv.org/abs/2602.20478); [Anthropic, 2026](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf))

### 2.7 搜索优化 > 模型升级

**SWE-Search (ICLR 2025)**: MCTS 搜索策略，不换模型获得 **23% 相对提升**。**Agentless**: 分层定位 (文件→类→函数→编辑位置)，$0.70/issue 达 SWE-Bench Lite 32%。([SWE-Search](https://arxiv.org/abs/2410.20285); [Agentless](https://arxiv.org/abs/2407.01489))

---

## 3. 架构设计：Probe → Map → Fuse

### 3.1 设计原则

| 原则 | 来源 | 实现 |
|------|------|------|
| **探测优于全量扫描** | Agentic Search / SWE-grep | 多探针并行，每个在独立 context 中工作 |
| **理解流对齐** | CodeMap | Phase 0 (全局) → Phase 1 (结构) → Phase 2 (综合) |
| **结构化中间表示** | RPG / LocAgent | module-graph.json (图) 而非纯文本 |
| **子 Agent 隔离** | Anthropic multi-agent | 每个探针独立 context，脏数据不污染融合阶段 |
| **精准胜过全量** | Context Rot 研究 | 探针读关键文件片段，不做全文件 dump |

### 3.2 总体架构

```
┌────────────────────────────────────────────────────────────────┐
│  Phase 0: 骨架扫描 (零 LLM, ~1-2s)                            │
│  ├─ 目录树 + 技术栈检测 + 文件统计 (v6.0 collectSnapshot)     │
│  ├─ Code Graph 构建 (import/export 依赖图)                    │
│  ├─ Repo Map (符号索引)                                       │
│  ├─ 项目特征画像 (ProjectProfile)                              │
│  └─ 种子文件推断 + 入口文件识别                                 │
│  → 产出: skeleton.json + code-graph + exploration-plan        │
└──────────────────────────┬─────────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  Phase 1: 并行探测 (N 个探针, 每个 1-3 轮 LLM, fast 模型)     │
│                                                                │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┬────┐│
│  │  Entry   │ Module   │   API    │  Data    │ Config   │Smell││
│  │  Trace   │ Deep     │ Boundary │  Model   │ Infra    │Detect│
│  │          │ Dive     │          │          │          │    ││
│  │ 从入口沿 │ 从模块   │ 从路由/  │ 从 type/ │ 从配置/  │ grep││
│  │ import   │ 中心向   │ handler  │ schema/  │ middleware│ TODO││
│  │ 图展开   │ 内展开   │ 追踪     │ ORM 追踪 │ plugin   │ HACK││
│  └──────────┴──────────┴──────────┴──────────┴──────────┴────┘│
│                                                                │
│  每个探针:                                                      │
│    1. 接收明确任务 + 文件路径种子                                 │
│    2. 用工具 (read_file/grep) 自主探索 1-3 轮                   │
│    3. 输出结构化 ProbeReport (JSON + 可读 Markdown)             │
│    4. 写入 .automater/analysis/probes/                          │
│                                                                │
│  并行控制: ≤ workerCount 并发 | Token: ≤8K in + 2K out per probe│
└──────────────────────────┬─────────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  Phase 2: 拼图合成 (strong 模型, 1-2 次调用)                    │
│                                                                │
│  输入: skeleton + 所有 ProbeReport + Code Graph 摘要            │
│                                                                │
│  输出:                                                          │
│  ├─ ARCHITECTURE.md (有血有肉, 基于多视角交叉验证)              │
│  ├─ module-graph.json (RPG 风格结构化图)                        │
│  │   { nodes: [{id, type, path, responsibility, publicAPI,      │
│  │             keyTypes, patterns, issues}],                    │
│  │     edges: [{source, target, type: import|dataflow|event}] } │
│  ├─ known-issues.md (技术债/hack/风险点)                        │
│  └─ enriched skeleton.json                                      │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 Phase 0: 骨架扫描

**耗时**: ~1-2s | **LLM**: 0 | **产出**: skeleton.json + CodeGraph + exploration-plan

保留 v6.0 `collectProjectSnapshot()`，增加：

```typescript
interface ScanResult {
  snapshot: ProjectSnapshot;       // v6.0 现有
  graph: CodeGraph;                // 文件级 import 图
  repoMap: string;                 // 符号索引
  profile: ProjectProfile;         // 项目特征画像
  seedFiles: SeedFile[];           // 探针入口候选
  explorationPlan: ExplorationPlan; // 探针组合计划
}

/** 项目特征画像 — 驱动探针策略，不是门槛 */
interface ProjectProfile {
  scale: 'medium' | 'large' | 'massive';   // <500 / 500-2000 / >2000 files
  graphDensity: number;                     // edgeCount / fileCount
  languageCount: number;
  hasCircularDeps: boolean;
  nestingDepth: number;
  readmeQuality: 'good' | 'poor' | 'none';
}

interface SeedFile {
  file: string;
  reason: 'entry' | 'hub' | 'config' | 'largest';
  importCount: number;
  importedByCount: number;
}

/** 探针组合计划 — Phase 0 产出，Phase 1 消费 */
interface ExplorationPlan {
  probes: ProbeConfig[];
  estimatedTotalTokens: number;
  estimatedDurationMs: number;
}
```

**探针数量由 profile 自动调节**:
- `medium` (200-500 files): ~8-12 探针
- `large` (500-2000 files): ~15-25 探针
- `massive` (>2000 files): ~25-40 探针，启用分批探索

### 3.4 Phase 1: 六类探针

#### ① Entry Trace (入口追踪)

```
种子: Phase 0 识别的入口文件 (main.ts, App.tsx, server.ts)
方法:
  1. 读入口文件全文
  2. 沿 Code Graph 的 import 边, 深度优先 3-5 跳
  3. 每跳读目标文件的前 100 行 (签名+注释+export)
  4. 记录: 启动流程, 初始化顺序, 核心依赖链
目的: 理解"系统是怎么跑起来的"
```

#### ② Module Deep Dive (模块纵深)

```
种子: Code Graph 社区检测选出的模块中心 / LOC 最大的 N 个模块
方法:
  1. 读模块 index.ts 或最大文件
  2. grep 导出的公开 API (export function/class/const)
  3. 读 1-2 个核心实现文件的关键函数
  4. 记录: 模块职责, 公开接口, 关键数据结构, 依赖关系
目的: 理解"每个模块做什么, 怎么用"
```

#### ③ API Boundary (API 边界)

```
种子: grep 'router\.|app\.(get|post|put)|@(Get|Post|Controller)|ipcMain\.handle|export.*handler'
方法:
  1. 从路由/handler 定义出发
  2. 读请求参数 + 响应格式
  3. 追踪到 service/model 层
  4. 记录: API 端点清单, 数据流向, 认证/中间件链
目的: 理解"系统对外提供什么能力"
```

#### ④ Data Model (数据模型)

```
种子: grep 'interface|type|schema|model|entity|Table|Column|@Entity|CREATE TABLE'
方法:
  1. 收集所有类型/schema 定义
  2. 识别核心实体和关系
  3. 找 DB migration 或 ORM 定义
  4. 记录: 核心实体, 字段, 关系, 校验规则
目的: 理解"系统操作什么数据"
```

#### ⑤ Config & Infrastructure (配置/基础设施)

```
种子: config/, middleware/, plugin/, .env, docker-compose, CI 配置
方法:
  1. 读配置文件理解环境结构
  2. 找中间件/插件注册点
  3. 分析构建流程和部署配置
  4. 记录: 环境依赖, 中间件链, 构建管道, 外部服务依赖
目的: 理解"系统怎么部署和配置"
```

#### ⑥ Smell Detection (异常模式)

```
种子: grep 'TODO|FIXME|HACK|XXX|deprecated|workaround|TEMP|UNSAFE'
     + 检测: 超大文件(>1000行), 深嵌套(>5层), God class, 循环依赖
方法:
  1. 收集标记点及上下文 (±10行)
  2. 分析: known issue vs active tech debt
  3. 记录: 位置, 严重度, 上下文, 影响范围
目的: 理解"哪里是雷区, 改动时要小心"
```

### 3.5 探针执行模型

每个探针不是单轮 LLM 调用，而是 **1-3 轮的 search→read→reason→search 循环**：

```typescript
interface ProbeConfig {
  id: string;
  type: 'entry' | 'module' | 'api-boundary' | 'data-model' | 'config-infra' | 'smell';
  seeds: string[];             // 起始文件/grep 模式
  graphHops?: number;          // BFS 跳数 (Entry/Module 用)
  maxFilesToRead: number;      // 单探针最多读取文件数
  maxRounds: number;           // 最大探索轮数 (1-3)
  tokenBudget: number;         // 8K input + 2K output
}

interface ProbeReport {
  probeId: string;
  type: string;
  /** 结构化发现 — 喂给 module-graph.json 构建 */
  findings: Finding[];
  /** 可读报告 — 人类审阅用 */
  markdown: string;
  /** 探针实际读取的文件 */
  filesExamined: string[];
  /** 发现的依赖关系 */
  dependencies: Array<{ source: string; target: string; type: string }>;
  /** 发现的问题 */
  issues: Array<{ location: string; severity: string; description: string }>;
  /** 自评置信度 */
  confidence: number;          // 0-1
  /** 消耗统计 */
  tokensUsed: number;
  durationMs: number;
  rounds: number;              // 实际执行了几轮
}

interface Finding {
  type: 'module' | 'api-endpoint' | 'data-model' | 'pattern' | 'anti-pattern' | 'dependency' | 'config';
  id: string;
  name: string;
  description: string;
  files: string[];
  publicAPI?: string[];        // Module Probe 填充
  keyTypes?: string[];         // Data Model Probe 填充
  relationships: Array<{ target: string; type: string }>;
}
```

### 3.6 Probe Orchestrator (调度器)

```typescript
interface ProbeOrchestrator {
  /** Phase 0 结果 → 探针组合计划 */
  planProbes(scan: ScanResult): ExplorationPlan;

  /** 并行执行，带限流+进度+预算控制 */
  executeProbes(
    plan: ExplorationPlan,
    options: {
      concurrency: number;             // 默认 = settings.workerCount 或 3
      signal?: AbortSignal;
      budgetUsd?: number;              // 默认 $1.00
      onProbeComplete?: (report: ProbeReport) => void;
      onProgress?: (probeId: string, status: string, progress: number) => void;
    }
  ): Promise<ProbeReport[]>;

  /** 去重 + 冲突检测 + 置信度加权 */
  mergeFindings(reports: ProbeReport[]): MergedFindings;
}

interface MergedFindings {
  findings: Finding[];
  conflicts: Array<{ findingA: string; findingB: string; resolution: string }>;
  coveragePercent: number;     // filesExamined / totalFiles
}
```

**调度策略**:
1. Phase 0 的 `explorationPlan` 按优先级排序探针 (Entry > Module > API > DataModel > Config > Smell)
2. 按 concurrency 限制并行发起
3. 预算到达上限 → 停止排队中的探针，已完成的报告直接进 Phase 2
4. 每个探针完成后立即通过 `onProbeComplete` 回调通知 UI

### 3.7 Phase 2: 拼图合成

**LLM**: 1-2 次 strong 模型调用 | **产出**: 结构化图 + 文档集

```typescript
interface FuseOutput {
  /** RPG 风格结构化模块图 — 核心产出，供后续所有 Agent 使用 */
  moduleGraph: ModuleGraph;
  /** 系统架构文档 — 基于多视角交叉验证的全貌 */
  architectureMd: string;
  /** 技术债/屎山报告 */
  knownIssuesMd: string;
  /** 增强的 skeleton.json — publicAPI/keyTypes 已填充 */
  enrichedSkeleton: ProjectSkeleton;
  /** 统计 */
  stats: ImportStats;
}

/** RPG 风格的模块图 — 可直接序列化为 JSON */
interface ModuleGraph {
  nodes: ModuleGraphNode[];
  edges: ModuleGraphEdge[];
}

interface ModuleGraphNode {
  id: string;
  type: 'module' | 'entry-point' | 'api-layer' | 'data-layer' | 'config' | 'utility';
  path: string;
  responsibility: string;
  publicAPI: string[];
  keyTypes: string[];
  patterns: string[];          // 使用的设计模式
  issues: string[];            // 该模块的技术债
  fileCount: number;
  loc: number;
}

interface ModuleGraphEdge {
  source: string;
  target: string;
  type: 'import' | 'dataflow' | 'event' | 'config' | 'ipc';
  weight: number;              // 关系强度 (import 次数等)
}

interface ImportStats {
  totalProbes: number;
  totalFilesRead: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  totalDurationMs: number;
  coveragePercent: number;
}
```

**Fuse Prompt 策略**:

```
你是项目架构分析师。以下是多个独立探针从不同角度对同一项目的分析报告。

## 项目骨架 (Phase 0)
{skeleton 摘要: 技术栈, 文件数, 代码行数, Code Graph 统计}

## 探针报告 (Phase 1, 按类型分组)
### 入口追踪
{entry probe reports}
### 模块纵深
{module probe reports}
### API 边界
{api boundary probe reports}
### 数据模型
{data model probe reports}
### 配置/基础设施
{config probe reports}
### 异常模式
{smell probe reports}

请综合所有报告，生成:

1. ```json module-graph``` — 结构化模块图 (节点含 id/type/path/responsibility/publicAPI/keyTypes/issues，
   边含 source/target/type)
2. ```architecture``` — ARCHITECTURE.md 内容 (有血有肉，引用具体函数名/类型名)
3. ```known-issues``` — 技术债清单 (位置+严重度+建议)

当探针报告存在矛盾时，标注 [⚠️ 交叉验证冲突] 并给出最可能的解释。
优先信任高置信度探针的发现。
```

### 3.8 渐进式 UI

```
[Phase 0] ████████████ 100% — 骨架完成: 342 文件, 28K LOC, TS+React, 12 模块
[Phase 1] ██████░░░░░░  50% — 探针进行中 (6/12)...
  ✅ entry-main       → Electron 主进程 → IPC → React 渲染层
  ✅ entry-app        → React Router → 13 页面 → Zustand 状态管理
  ✅ api-boundary     → 47 个 IPC handler, 认证: session-based
  🔄 module-engine    → 探索中: orchestrator.ts (1823行)...
  ⏳ data-model       → 排队中
  ⏳ smell-detect     → 排队中
  💰 已消耗: $0.12 / $1.00
[Phase 2] ░░░░░░░░░░░░   0% — 等待探针完成...
```

---

## 4. 与现有系统的集成

### 4.1 下游 Agent 消费路径

```
importProject() — Phase 0 + Phase 1 + Phase 2
     ↓ 产出:
  module-graph.json  ─────→  context-collector.ts (精准模块选择，替代 keyword 匹配)
  ARCHITECTURE.md    ─────→  Hot Memory (全局架构认知)
  probe-reports/*.md ─────→  Cold Memory (按需加载模块详情)
  known-issues.md    ─────→  PM 分析时的优先级参考 + Developer 的雷区标注
  enriched skeleton  ─────→  orchestrator 调度优化
     ↓
orchestrator Phase 1 (PM 分析)
  └─ 注入 ARCHITECTURE.md + module-graph + known-issues 作为上下文
orchestrator Phase 4 (Developer 实现)
  └─ context-collector 使用 module-graph.json 做图引导的上下文收集
     (替代当前基于目录分组的粗粒度模块匹配)
```

### 4.2 模块影响清单

| 现有模块 | 变化 | 说明 |
|---------|------|------|
| `project-importer.ts` | **重写** | v6.0 快照降级为 Phase 0 子步骤，新增 Phase 1+2 |
| `code-graph.ts` | **增强** | 新增 `detectCommunities()`, `getHubFiles()` |
| `context-collector.ts` | **增强** | 利用 module-graph.json 做图引导的精准文件选择 |
| `repo-map.ts` | 不变 | Phase 0 继续使用 |
| `llm-client.ts` | 不变 | 探针通过现有 `callLLM()` 调用 |
| IPC `project:import` | **增强** | 新增探针级进度事件 |

---

## 5. 成本

### 5.1 模型分层

| 阶段 | 模型 | 原因 |
|------|------|------|
| Phase 0 | 无 LLM | 纯静态分析 |
| Phase 1 | **fast** (Haiku / Flash / 4o-mini) | 单文件理解不需顶级推理，成本 ~1/10 |
| Phase 2 | **strong** (Sonnet / 4o) | 综合推理 + 交叉验证 |

### 5.2 预估

| 项目规模 | 探针数 | 时间 | Token (in) | Token (out) | 费用 | 覆盖率 |
|---------|--------|------|-----------|------------|------|--------|
| 500 文件 | ~10 | ~1-2 min | ~60K | ~25K | ~$0.10-0.20 | ~60% |
| 1000 文件 | ~20 | ~2-4 min | ~120K | ~40K | ~$0.20-0.40 | ~65% |
| 3000+ 文件 | ~35 | ~4-8 min | ~250K | ~80K | ~$0.50-1.00 | ~50-60% |

对比：资深开发者手动建立 1000 文件项目的架构认知需 1-3 天。$0.30 + 3 分钟 = 极高 ROI。

### 5.3 控制机制

1. **预算上限**: 用户可设置 (默认 $1.00)，到达后停止排队探针直接 Fuse
2. **探针缓存**: ProbeReport 持久化，二次导入可跳过已探索区域
3. **分层模型**: 探针用 fast (1/10 价格)
4. **早停**: 覆盖率达 85% 自动停止追加探针

---

## 6. 风险

| 风险 | 级别 | 缓解 |
|------|------|------|
| **LLM 成本** | 🟡 | 分层模型 + 预算上限 + fast 探针 |
| **时间** | 🟡 | 渐进式 UI + 并行执行 |
| **探针矛盾** | 🟡 | Phase 2 交叉验证 + confidence 加权 |
| **探针冗余** | 🟡 | Code Graph 引导种子分配，避免重叠覆盖 |
| **技术栈适配** | 🟡 | grep pattern 按语言可配置 (Phase A 先支持 TS/JS/Python) |
| **ProbeReport 格式** | 🟡 | JSON Schema 强制 + output-parser 验证 + Markdown fallback |

### 关键不确定性 (需验证)

1. 探针轮数：1 轮够不够，还是 2-3 轮才能挖到有价值信息？
2. Phase 2 拼合质量：20K token 的多报告输入，strong 模型能否有效综合？
3. module-graph.json 的实际可用性：context-collector 用它做选择比 keyword 好多少？

→ **Phase A 的最小验证需要回答这三个问题。**

---

## 7. 设计决策记录

### 7.1 为什么不用 Vector Embedding / RAG？

1. DeepMind 证明 embedding 对代码有数学上限 (512 维 @ 500K 文档退化)
2. Code Graph 的确定性远超相似度搜索——import A→B 是事实
3. 无外部依赖 (不需向量数据库)
4. Cognition 实践证明 agentic search (图遍历+LLM) >> RAG

### 7.2 为什么结构化图 + Markdown 双轨输出？

1. **module-graph.json** (RPG 论文): 机器可消费，供 context-collector / orchestrator 使用
2. **ARCHITECTURE.md + known-issues.md**: 人类可读，供用户审阅和 Hot Memory
3. 单出 Markdown 不够精准 (RPG 的核心发现)；单出 JSON 不够可读

### 7.3 为什么探针是多轮而非单轮？

屎山的真实复杂度需要追踪——入口文件 import 了 A，A 用了反射加载 B，B 的行为取决于配置文件 C。单轮只能看到第一跳。1-3 轮的 search→read→reason→search 才能扯出根系。

### 7.4 为什么 6 类探针而非 4 类？

v7 原方案将 Data Model 和 API 合并在 Boundary Probe 里。但 v2 方案正确指出它们职责不同：
- **API Boundary**: "系统对外提供什么能力" (路由/handler)
- **Data Model**: "系统操作什么数据" (schema/type/ORM)

混在一起会让探针 prompt 过于模糊，分开后每个探针目标更明确，LLM 输出质量更高。

---

## 8. 实施路径

### Phase A: 最小验证 (3-5h) — **先验证方向**

- [ ] **A1**: 在现有 `importProject()` 基础上添加串行探测 (3 个策略: Entry + Module + Data Model)
- [ ] **A2**: ProbeReport 写入 `.automater/analysis/probes/`
- [ ] **A3**: Phase 2 修改 prompt 注入 ProbeReport
- [ ] **A4**: 在 AgentForge 自身 + 一个外部项目上对比 v6.0 vs v7.0 的 ARCHITECTURE.md

**验证标准**:
- ARCHITECTURE.md 包含的具体函数名/类型名数量 ↑ 50%+
- 模块摘要的 publicAPI 字段非空率 > 80%
- 人工判断: 关键数据流描述是否正确

### Phase B: 并行 + 完整策略 (4-6h)

- [ ] **B1**: 提取 `probe-orchestrator.ts` + `probe-types.ts`
- [ ] **B2**: 并行执行 (复用 workerLoop 模式)
- [ ] **B3**: 添加 API Boundary + Config/Infra + Smell 三个探针
- [ ] **B4**: 增强 `code-graph.ts` — `detectCommunities()` + `getHubFiles()`
- [ ] **B5**: `buildProjectProfile()` 驱动探针数量
- [ ] **B6**: ProbeReport JSON Schema + output-parser 验证

### Phase C: 结构化图 + 下游集成 (4-6h)

- [ ] **C1**: Phase 2 输出 `module-graph.json` (RPG 风格)
- [ ] **C2**: `context-collector.ts` 使用 module-graph 做图引导的文件选择
- [ ] **C3**: orchestrator 注入 known-issues.md 到 Developer 上下文
- [ ] **C4**: 丰富 skeleton.json — publicAPI, keyTypes, 实际依赖关系
- [ ] **C5**: UI: 导入结果页展示模块图 + 探测覆盖率

### Phase D: 增量探测 + 缓存 (2-4h)

- [ ] **D1**: `incrementalProbe()`: 基于 git diff 只对变更文件所在模块重新探测
- [ ] **D2**: 探测缓存 + 过期策略
- [ ] **D3**: 与 orchestrator Phase 4c (增量文档同步) 集成
- [ ] **D4**: 用户反馈闭环 — 导入后可标注"理解错误"

---

## 9. 成功指标

| 指标 | 目标 | 测量方式 |
|------|------|---------|
| **覆盖率** | >60% 文件被探针触及 | `filesExamined / totalFiles` |
| **publicAPI 填充率** | >80% 模块有非空 publicAPI | 自动检查 module-graph |
| **架构准确度** | >80% 模块描述正确 | 人工抽样审查 |
| **后续 Agent 效率** | Developer 首次成功率 ↑20%+ | 实际项目 A/B |
| **成本** | <$1.00 (1000 文件项目) | API 费用追踪 |
| **时间** | <8min (含全部探针) | 端到端计时 |
| **关键数据流** | ARCHITECTURE.md 正确描述 3+ 条主要数据流 | 人工验证 |

---

## 10. 参考文献

1. **LocAgent**: Chen et al., "Graph-Guided LLM Agents for Code Localization", ACL 2025. https://aclanthology.org/2025.acl-long.426/
2. **CodexGraph**: "Bridging LLMs and Code Repositories via Code Graph Databases", NAACL 2025. https://arxiv.org/abs/2408.03910
3. **RPG / ZeroRepo**: Microsoft, "Repository Planning Graph", ICLR 2026. https://arxiv.org/abs/2509.16198
4. **CodeMap**: JHU/SMU, "Learning Code Auditor's Understanding Flow", arXiv 2024. https://arxiv.org/abs/2504.04553
5. **Codified Context**: Vasilopoulos, "Infrastructure for AI Agents in a Complex Codebase", arXiv 2026. https://arxiv.org/abs/2602.20478
6. **SWE-grep**: Cognition, "RL for Multi-Turn Fast Context Retrieval", 2025. https://cognition.ai/blog/swe-grep
7. **Morph Agentic Search**: "Coding Agents Are Bottlenecked by Search", 2026. https://www.morphllm.com/blog/code-search-bottleneck
8. **Anthropic Agentic Coding Trends**: "2026 Agentic Coding Trends Report". https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf
9. **SWE-Search**: Antoniades et al., ICLR 2025. https://arxiv.org/abs/2410.20285
10. **Agentless**: Xia et al., 2024. https://arxiv.org/abs/2407.01489
11. **Aider Repo Map**: "Building a better repository map with tree-sitter", 2023. https://aider.chat/2023/10/22/repomap.html
12. **Lost-in-the-Middle**: Liu et al., TACL 2024. https://arxiv.org/abs/2307.03172
13. **Context Rot**: Chroma Research, 2025. https://research.trychroma.com/context-rot

---

## 附录: 与竞品对比

| 能力 | Cursor | Claude Code | Aider | **AutoMater v7.0** |
|------|--------|-------------|-------|---------------------|
| 索引方式 | 向量 embedding + Merkle Tree | 运行时 agentic grep | tree-sitter repo-map | **Code Graph + 多探针 Agent** |
| 对屎山理解 | 中 (依赖 embedding 质量) | 高 (Agent 自主探索) | 弱 (符号级) | **高 (6 类探针多视角)** |
| 中间表示 | 向量 (不可读) | 无 (in-context) | repo-map (符号级) | **module-graph.json (结构化图)** |
| 供后续 Agent | 自动 (IDE 内置) | 每次重新搜索 | repo-map 注入 | **图引导精准上下文注入** |
| 持久记忆 | .cursorrules | CLAUDE.md | 无 | **Hot/Warm/Cold + probe-reports** |
| 增量更新 | 实时索引 | 手动 | git diff 触发 | **CodeGraph 增量 + 探针缓存** |
| 屎山检测 | 无 | 需人工 prompt | 无 | **Smell Probe 自动检测** |

---

*文档定稿。前置工作: Phase A 最小验证 (3-5h)，验证通过后进入 Phase B-D 全量实施。*
