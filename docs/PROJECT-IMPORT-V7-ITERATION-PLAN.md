# 项目导入 v7.0 迭代计划 — 多探针并行探索 + 拼图组装

> **文档版本**: v1.0  
> **日期**: 2026-03-02  
> **作者**: Tim的开发助手  
> **状态**: 设计提案 (待评审)

---

## 1. 问题陈述

### 1.1 现状分析 (v6.0)

当前 `project-importer.ts` 采用 **2-step 快速理解** 方案：

```
Step 1: 轻量收集 (~1s, 零 LLM)
  ├─ 目录树 (depth ≤ 4)
  ├─ 关键配置文件 (package.json, README, tsconfig 等)
  ├─ Repo Map 符号索引 (100 文件, 正则提取签名)
  ├─ 入口文件前 200 行
  └─ 快速 LOC/文件统计

Step 2: 单次 LLM 调用 (~10-30s)
  ├─ 将 ~5-15K token 项目快照发给 strong 模型
  └─ 生成: ARCHITECTURE.md + 模块列表 + skeleton.json
```

**优势**: 秒级完成，成本极低 (单次 LLM 调用)  
**局限**:

| 问题 | 严重性 | 说明 |
|------|--------|------|
| **全局视角缺失** | 🔴 高 | 单次 LLM 仅看到 15K token 快照，对 1000+ 文件项目缺乏深度理解 |
| **遗漏隐性依赖** | 🔴 高 | 正则 Repo Map 捕获符号但不理解语义；运行时依赖、DI、事件总线等不可见 |
| **屎山盲区** | 🔴 高 | 不规范项目的实际结构与文件名/目录暗示的结构严重不符 |
| **模块摘要空壳** | 🟡 中 | `ModuleSummary.publicAPI/keyTypes` 始终为空数组 — LLM 只输出一句话职责 |
| **Code Graph 未利用** | 🟡 中 | `code-graph.ts` 仅在 context-collector 中使用，导入阶段未参与 |
| **无增量探索** | 🟡 中 | 导入后的 `incrementalUpdate` 实际是空壳 — 只标记受影响模块，不重新分析 |

### 1.2 用户洞察

> *"LLM 的一大优势就是从单个文件入手，扯出相关的各种模块根系...是否有可能让 agent 多次(或多个并行)根据一定规则去探测局部结构，然后将探索分析报告记录在导入期间的文档中，最后通过类似拼图的形式，得到复杂已有项目的全貌。"*

这与 2025-2026 年学术界和工业界的最前沿趋势高度一致。

---

## 2. 国际前沿工程实践综述 (2025-2026)

### 2.1 核心研究发现

#### 📊 搜索是瓶颈，不是编码能力

**Cognition (Devin/Windsurf)** 发现 coding agent 在首轮 **>60% 的时间花在搜索**，不是编码。传统的串行 grep+read 需要 10-20 轮才能积累足够上下文。([Cognition Blog, 2025](https://cognition.ai/blog/swe-grep))

**关键推论**: 导入阶段的质量直接决定后续所有 agent 工作的效率。投入更多智能在"理解"阶段，可以在"开发"阶段成倍节省。

#### 📊 Context Rot — 更多上下文让模型更差

Stanford 的 Lost-in-the-Middle 研究和 Chroma 的 18 模型实验均证明：**LLM 性能随上下文长度增加呈非均匀退化**。给 agent 500 行"可能相关"的结果，不如给 50 行精准结果。([MorphLLM Research Compilation, 2026](https://www.morphllm.com/blog/code-search-bottleneck))

**关键推论**: 导入不是"读越多越好"，而是要**精准探测**、**紧凑记录**。

#### 📊 图引导搜索：定位准确率 92.7%

**LocAgent (ACL 2025)** 将代码库解析为有向异构图 (文件→类→函数)，LLM agent 沿图结构导航定位。文件级定位准确率 **92.7%**，下游修复率提升 12%。([LocAgent, Chen et al., 2025](https://aclanthology.org/2025.acl-long.426/))

**关键推论**: 我们已有 `code-graph.ts` 的文件级 import 图，可以扩展为更细粒度的异构图来引导探索。

#### 📊 分层知识基础设施

**Codified Context (arXiv 2026)** 在 108,000 行 C# 项目上实践了 **hot-memory constitution + 19 domain-expert agents + 34 on-demand specification documents** 的分层体系。283 个开发 session 的定量评估显示此架构有效防止跨 session 失败。([Vasilopoulos, 2026](https://arxiv.org/html/2602.20478v1))

**关键推论**: 导入产出不应是单一 ARCHITECTURE.md，而应是**分层的结构化知识库**。

#### 📊 单 Agent → 协调 Agent 团队

**Anthropic 2026 Agentic Coding Trends Report** 的 Trend 2 预测：单 agent 正在演化为协调的 agent 团队。多 agent 各司其职，通过共享 artifact 协作。([Anthropic, 2026](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf))

#### 📊 搜索优化 > 模型升级

**SWE-Search (ICLR 2025)** 用蒙特卡洛树搜索策略改善 agent 搜索路径，不换模型获得 **23% 相对提升**。**Agentless** 用分层定位策略 (文件→类→函数→编辑位置) 以 $0.70/issue 达到 SWE-Bench Lite 32%。([SWE-Search, Antoniades et al.; Agentless, Xia et al.](https://arxiv.org/abs/2410.20285))

### 2.2 与用户想法的映射

| 用户直觉 | 对应 SOTA | 验证程度 |
|----------|----------|---------|
| 从单个文件入手，扯出根系 | LocAgent 图引导遍历 + Code Graph multi-hop | ✅ 学术验证 |
| 多次/并行探测局部结构 | SWE-grep 并行检索子 agent / Multi-agent 协调 | ✅ 工业验证 |
| 探索报告记录在文档中 | Codified Context 分层知识基础设施 | ✅ 学术+工业验证 |
| 拼图组装全貌 | Hierarchical summarization + Graph merge | ✅ 理论成熟 |

**结论**: 用户的直觉完全成立，且恰好踏在 2025-2026 年技术浪潮的节点上。

---

## 3. 客观风险评估

在肯定方向正确的同时，必须诚实面对挑战：

### 3.1 ⚠️ 已知风险

| 风险 | 级别 | 缓解策略 |
|------|------|---------|
| **LLM 成本膨胀** | 🔴 | 多探针 = 多次 LLM 调用。1000 文件项目可能需要 20-50 次调用。需要 smart 调度 + 分层模型 (探针用 fast，综合用 strong) |
| **时间膨胀** | 🟡 | 从 30s 变为 2-5 min。但可以渐进式呈现中间结果，用户体验不一定变差 |
| **并行一致性** | 🟡 | 多 agent 并行探索可能对同一模块给出矛盾描述。需要冲突检测+仲裁机制 |
| **探针冗余** | 🟡 | 多探针可能重复探索同一区域。需要全局协调器避免浪费 |
| **规范项目冗余探索** | 🟡 | 目录结构清晰的项目，部分探针可能发现不到额外信息。通过早停机制缓解 |
| **GraphDB 依赖** | 🟢 | LocAgent 使用 Neo4j，但我们可以用内存图避免外部依赖 |

### 3.2 设计前提：导入 = 大型复杂项目

用户能直接塞进主流模型上下文的小项目，根本不需要导入功能。
凡是需要用到 AutoMater 项目导入的，**必然是超出单次上下文窗口的大型项目**。
因此 v7.0 **不设复杂度门槛**，不保留 v6.0 快速通道分支——导入即深度分析。

v6.0 的 `collectProjectSnapshot()` 仍然作为 Phase 0 的静态信息收集基础保留，
但不再作为独立的"够用"路径存在。它是 Phase 1 探针调度的输入，不是终点。

---

## 4. 架构设计：Probe-Map-Fuse 三阶段流水线

### 4.1 总体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Project Import v7.0                            │
│                   "Probe → Map → Fuse" Pipeline                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐   ┌──────────────────────┐   ┌────────────────┐  │
│  │  Phase 0     │   │    Phase 1           │   │   Phase 2      │  │
│  │  Quick Scan  │──▶│    Multi-Probe       │──▶│   Fuse & Doc   │  │
│  │  (v6.0快照)   │   │    Exploration       │   │   Generation   │  │
│  │  ~1-2s       │   │    ~30s-3min         │   │   ~10-30s      │  │
│  └──────────────┘   └──────────────────────┘   └────────────────┘  │
│        │                      │                        │            │
│        ▼                      ▼                        ▼            │
│  ┌──────────┐    ┌────────────────────┐    ┌──────────────────────┐│
│  │skeleton  │    │ probe-reports/     │    │ .automater/          ││
│  │.json     │    │  ├─ entry-*.md     │    │  ├─ ARCHITECTURE.md  ││
│  │code-graph│    │  ├─ module-*.md    │    │  ├─ MODULE-MAP.md    ││
│  │repo-map  │    │  ├─ pattern-*.md   │    │  ├─ DEPENDENCY-DAG.md││
│  └──────────┘    │  └─ boundary-*.md  │    │  ├─ TECH-DEBT.md    ││
│                  └────────────────────┘    │  └─ skeleton.json    ││
│                                            └──────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Phase 0: Quick Scan (保留 v6.0, 增强)

**耗时**: ~1-2s | **LLM 调用**: 0 | **产出**: skeleton.json + CodeGraph + RepoMap

现有 v6.0 的 `collectProjectSnapshot()` 保持不变，增加：

1. **CodeGraph 构建** — 调用现有 `buildCodeGraph()` (已有, 仅需在导入阶段启用)
2. **项目特征画像** — 基于 fileCount, edgeCount, 语言分布等生成特征向量，用于**调整探针数量和策略** (不是判断是否探索)
3. **种子文件推断** — 利用 `inferSeedFiles()` + Hub 文件检测确定探针入口

```typescript
interface ScanResult {
  snapshot: ProjectSnapshot;       // v6.0 现有
  graph: CodeGraph;                // 新增: 文件级 import 图
  repoMap: string;                 // 现有
  projectProfile: ProjectProfile;   // 新增: 项目特征画像 (驱动探针策略)
  seedFiles: SeedFile[];           // 新增: 探针入口候选
  estimatedProbeCount: number;     // 新增: 预估需要多少探针
}

interface SeedFile {
  file: string;
  reason: 'entry' | 'hub' | 'config' | 'keyword';
  score: number;  // 入口优先级
  importCount: number;
  importedByCount: number;
}
```

**项目特征画像** (驱动探针数量 / 并行度 / token 预算分配):
```typescript
interface ProjectProfile {
  scale: 'medium' | 'large' | 'massive';   // <500 / 500-2000 / >2000 files
  graphDensity: number;                     // edgeCount / fileCount
  languageCount: number;                    // 多语言项目需要更多探针
  hasCircularDeps: boolean;                 // 循环依赖需要特殊处理
  nestingDepth: number;                     // 目录嵌套深度
  readmeQuality: 'good' | 'poor' | 'none'; // 影响 Fuse 阶段可信度
  estimatedProbeCount: number;              // 根据 scale+density 自动计算
}
```

**探针数量映射** (不是门槛，是调节旋钮):
- `medium` (200-500 files): ~8-12 探针
- `large` (500-2000 files): ~15-25 探针
- `massive` (>2000 files): ~25-40 探针，启用分批探索

### 4.3 Phase 1: Multi-Probe Exploration (核心创新)

**耗时**: ~30s-3min (并行) | **LLM 调用**: 5-30 次 (fast 模型) | **产出**: probe-reports/*.md

#### 4.3.1 探针类型

设计 4 类互补的探针 (Probe)，各自从不同角度切入：

```
┌────────────────────────────────────────────────────────────┐
│                    Probe Orchestrator                       │
│              (全局调度, 避免重复, 合并发现)                    │
├────────┬────────────┬─────────────┬────────────────────────┤
│ Entry  │  Module    │  Pattern    │  Boundary              │
│ Probe  │  Probe     │  Probe      │  Probe                 │
│        │            │             │                        │
│ 从入口  │ 从目录     │ 从反模式    │ 从 API/DB/             │
│ 文件沿  │ 聚类中心   │ /设计模式   │ 配置边界               │
│ import  │ 向内展开   │ 特征搜索    │ 向内追溯               │
│ 图展开  │            │             │                        │
└────────┴────────────┴─────────────┴────────────────────────┘
```

**① Entry Probe (入口探针)**  
- **策略**: 从 `seedFiles` 出发，沿 CodeGraph `traverseGraph()` 做 3-hop BFS
- **LLM 任务**: 读取入口文件 + 1-hop 依赖，分析调用链和数据流
- **产出**: `entry-{name}.md` — 入口点的执行路径图、关键调用链、初始化序列

```typescript
interface EntryProbeConfig {
  seedFile: string;           // 入口文件路径
  graphHops: number;          // BFS 跳数 (默认 3)
  maxFilesToRead: number;     // 最多读取文件数 (默认 8)
  tokenBudget: number;        // 单次 LLM 预算 (默认 4K)
}
```

**② Module Probe (模块探针)**  
- **策略**: 对 CodeGraph 做社区检测 (基于 Louvain 或简单的连通分量)，每个社区选一个中心文件展开
- **LLM 任务**: 读取模块核心文件 + 接口文件，分析模块职责、公共 API、内部设计
- **产出**: `module-{id}.md` — 模块摘要、公共 API 列表、关键类型、依赖关系

```typescript
interface ModuleProbeConfig {
  moduleId: string;
  rootPath: string;
  coreFiles: string[];        // 社区检测选出的核心文件 (≤5)
  interfaceFiles: string[];   // 模块边界文件 (index.ts, types.ts 等)
  tokenBudget: number;
}
```

**③ Pattern Probe (模式探针)**  
- **策略**: 通过 grep 正则搜索特定代码模式，确认项目使用的架构模式和反模式
- **检测目标**:
  - 设计模式: DI 容器、事件总线、观察者、中间件链、状态机
  - 反模式: God class (>800 行单文件)、循环依赖、空 catch、硬编码配置
  - 框架约定: React hooks、Express middleware、Electron IPC
- **LLM 任务**: 将 grep 结果 + 文件片段交给 LLM 判断模式语义
- **产出**: `pattern-{type}.md` — 检测到的模式/反模式清单 + 技术债评估

```typescript
interface PatternProbeConfig {
  patterns: PatternRule[];    // 预定义 grep 规则
  maxMatchesPerPattern: number;
  tokenBudget: number;
}

interface PatternRule {
  id: string;
  name: string;
  grep: string;          // ripgrep 正则
  fileFilter: string;    // e.g. '*.ts'
  category: 'design-pattern' | 'anti-pattern' | 'framework-convention';
  severity?: 'info' | 'warning' | 'critical';
}
```

**④ Boundary Probe (边界探针)**  
- **策略**: 从外部边界 (API routes、DB schema、config 文件、.env) 向内追溯
- **LLM 任务**: 读取 API 定义 / DB migration / config，推断系统对外接口和数据模型
- **产出**: `boundary-{type}.md` — API 端点列表、数据模型、外部依赖、环境配置

```typescript
interface BoundaryProbeConfig {
  type: 'api' | 'database' | 'config' | 'external-service';
  targetFiles: string[];     // 边界文件列表
  tokenBudget: number;
}
```

#### 4.3.2 Probe Orchestrator (探针调度器)

```typescript
interface ProbeOrchestrator {
  /** 基于 Phase 0 结果规划探针 */
  planProbes(scan: ScanResult): ProbeConfig[];
  
  /** 并行执行探针 (带限流 + 进度回调) */
  executeProbes(
    configs: ProbeConfig[],
    options: {
      concurrency: number;        // 并行度 (默认 3)
      modelTier: 'fast' | 'worker' | 'strong';
      signal?: AbortSignal;
      onProgress?: (probeId: string, status: string, progress: number) => void;
    }
  ): Promise<ProbeReport[]>;
  
  /** 去重 + 冲突检测 */
  deduplicateFindings(reports: ProbeReport[]): ProbeReport[];
}

interface ProbeReport {
  probeId: string;
  type: 'entry' | 'module' | 'pattern' | 'boundary';
  markdown: string;            // 完整探索报告
  discoveredEntities: Entity[];  // 结构化发现
  filesRead: string[];         // 实际读取的文件
  tokensUsed: number;
  durationMs: number;
  confidence: number;          // 0-1 自评置信度
}

interface Entity {
  type: 'module' | 'api-endpoint' | 'data-model' | 'pattern' | 'anti-pattern' | 'dependency';
  id: string;
  name: string;
  description: string;
  files: string[];
  relationships: Array<{ target: string; type: string }>;
}
```

#### 4.3.3 探针调度策略

```
1. 从 Phase 0 的 seedFiles 生成 Entry Probe 配置 (2-5 个)
2. 从 CodeGraph 社区检测生成 Module Probe 配置 (3-10 个)
3. 从预定义规则集生成 Pattern Probe 配置 (固定 1 个, 内含多条规则)
4. 从配置文件/路由文件检测生成 Boundary Probe 配置 (1-3 个)
5. 按 concurrency 限制并行发起 LLM 调用
6. 收集所有 ProbeReport, 去重后进入 Phase 2
```

**并行度控制**: 默认 3 并发。受限于 API rate limit 和成本控制。
**早停机制**: 当 85% 的代码文件已被至少一个探针覆盖时，停止追加探针。

### 4.4 Phase 2: Fuse & Document Generation (拼图组装)

**耗时**: ~10-30s | **LLM 调用**: 1-2 次 (strong 模型) | **产出**: 分层文档集

将所有 Probe Report 拼合为全局理解：

```typescript
interface FuseInput {
  scan: ScanResult;              // Phase 0
  probeReports: ProbeReport[];   // Phase 1
  existingDocs?: string;         // 可选: 项目已有的 README/docs
}

interface FuseOutput {
  /** 系统架构文档 — 基于多探针交叉验证的全貌 */
  architectureMd: string;
  /** 模块地图 — 每个模块的职责、API、依赖关系 */
  moduleMapMd: string;
  /** 依赖 DAG — 可视化模块间依赖 (Mermaid) */
  dependencyDagMd: string;
  /** 技术债报告 — 反模式、复杂度热点、改进建议 */
  techDebtMd: string;
  /** 增强的 skeleton.json — 填充了实际的 publicAPI, keyTypes */
  enrichedSkeleton: ProjectSkeleton;
  /** 统计 */
  stats: {
    totalProbes: number;
    totalFilesRead: number;
    totalTokensUsed: number;
    totalDurationMs: number;
    coveragePercent: number;      // 被探针覆盖的文件百分比
  };
}
```

**Fuse 策略** (LLM prompt 设计):

```
你是项目架构分析师。以下是多个独立探针从不同角度对同一项目的分析报告。

## 项目快照 (全局)
{Phase 0 snapshot 摘要}

## 探针报告
{所有 ProbeReport.markdown, 按类型分组}

请综合所有探针报告，生成以下文档:
1. ARCHITECTURE.md — 系统架构全貌 (交叉验证，消除矛盾)
2. MODULE-MAP.md — 模块职责地图 (合并/去重不同探针对同一模块的描述)
3. DEPENDENCY-DAG.md — Mermaid 依赖图
4. TECH-DEBT.md — 技术债清单

当探针报告存在矛盾时，请标注 [⚠️ 交叉验证失败] 并给出最可能的解释。
```

### 4.5 渐进式 UI 呈现

用户不需要等待所有探针完成。架构应支持流式进度：

```
[Phase 0] ████████████ 100% — 快照完成: 342 文件, 28K LOC, TypeScript+React
[Phase 1] ██████░░░░░░  50% — 探针进行中...
  ✅ entry-main       — 发现: Electron 主进程 → IPC → React 渲染层
  ✅ entry-app        — 发现: React Router → 13 页面 → Zustand 状态管理
  🔄 module-engine    — 探索中: orchestrator.ts (1823行) 依赖分析...
  ⏳ module-ipc       — 排队中
  ✅ pattern-scan     — 发现: 3 设计模式, 5 反模式, 2 框架约定
  ⏳ boundary-api     — 排队中
[Phase 2] ░░░░░░░░░░░░   0% — 等待探针完成...
```

---

## 5. 成本与性能预算

### 5.1 模型分层策略

| 阶段 | 模型层 | 原因 |
|------|--------|------|
| Phase 0 | 无 LLM | 纯静态分析 |
| Phase 1 探针 | **fast 模型** (GPT-4o-mini / Claude Haiku / Gemini Flash) | 单文件/少量文件理解，不需要顶级推理 |
| Phase 2 融合 | **strong 模型** (Claude Sonnet / GPT-4o) | 综合推理、交叉验证、文档生成 |

### 5.2 预估成本 (典型大型项目)

导入功能的使用场景本身就是大型复杂项目，v6.0 的 15K token 快照对这类项目约等于盲猜。
成本对比无意义——问题不是"贵不贵"，而是"v6.0 对大型项目根本不 work"。

| 项目规模 | 探针数 | 时间 | Token (输入) | Token (输出) | 预估费用 | 覆盖率 |
|---------|--------|------|-------------|-------------|---------|--------|
| 500 文件 | ~10 | ~1-2 min | ~60K | ~25K | ~$0.10-0.20 | ~60% |
| 1000 文件 | ~20 | ~2-4 min | ~120K | ~40K | ~$0.20-0.40 | ~65% |
| 3000+ 文件 | ~35 | ~4-8 min | ~250K | ~80K | ~$0.50-1.00 | ~50-60% |

对比参考：一个资深开发者手动阅读 1000 文件项目建立架构认知，需要 1-3 天。
$0.30 + 3 分钟获得 65% 覆盖率的结构化文档，ROI 极高。

### 5.3 成本控制机制

1. **预算上限**: 用户可设置导入预算 (默认 $1.00)，达到上限自动停止探针、直接进入 Phase 2
3. **探针缓存**: Probe Report 持久化到 `.automater/probe-reports/`，二次导入可跳过已探索区域
4. **分层模型**: 探针用 fast 模型 (约 strong 模型 1/10 价格)

---

## 6. 实施路线图

### Phase A: 基础设施准备 (1-2 天)

- [ ] **A1**: 提取 `probe-orchestrator.ts` 模块 — ProbeOrchestrator 接口 + 调度逻辑
- [ ] **A2**: 提取 `probe-types.ts` — 所有探针相关类型定义
- [ ] **A3**: 增强 `code-graph.ts` — 添加社区检测算法 (`detectCommunities()`)
- [ ] **A4**: 增加项目特征画像函数 (`buildProjectProfile()`) 到 project-importer.ts — 驱动探针策略选择

### Phase B: 探针实现 (2-3 天)

- [ ] **B1**: 实现 `EntryProbe` — 基于 CodeGraph BFS 的入口探索
- [ ] **B2**: 实现 `ModuleProbe` — 基于社区检测的模块深度分析
- [ ] **B3**: 实现 `PatternProbe` — grep 规则集 + LLM 语义判断
- [ ] **B4**: 实现 `BoundaryProbe` — API/DB/Config 边界追溯
- [ ] **B5**: 实现 `ProbeOrchestrator.planProbes()` — 自动规划探针组合

### Phase C: 融合与文档 (1-2 天)

- [ ] **C1**: 实现 Phase 2 Fuse 逻辑 — 多报告综合 + 冲突检测
- [ ] **C2**: 设计 Fuse prompt 模板 — 交叉验证 + 分层文档生成
- [ ] **C3**: 输出 MODULE-MAP.md, DEPENDENCY-DAG.md (Mermaid), TECH-DEBT.md
- [ ] **C4**: 丰富 skeleton.json — 填充 publicAPI, keyTypes, 实际依赖关系

### Phase D: 集成与 UI (1-2 天)

- [ ] **D1**: 重写 `importProject()` 主入口 — 统一走 Phase 0 → 1 → 2 流水线
- [ ] **D2**: IPC 层增加渐进式进度事件 (`project:import-probe-progress`)
- [ ] **D3**: 前端导入 UI 展示探针实时进度 (可选: 探索可视化)
- [ ] **D4**: 集成测试 — 用 AgentForge 自身作为测试项目

### Phase E: 优化迭代 (持续)

- [ ] **E1**: 效果评估 — 在 3+ 真实项目上测量导入质量 + 后续 agent 开发效率
- [ ] **E2**: 探针缓存 + 增量更新 — 文件变更时只重新探测受影响区域
- [ ] **E3**: 用户反馈闭环 — 导入后用户可标注"理解错误"，反馈到探针策略

---

## 7. 与现有系统的衔接

### 7.1 向后兼容

| 现有模块 | 变化 | 说明 |
|---------|------|------|
| `project-importer.ts` | **重写** | v6.0 快照收集降级为 Phase 0 子步骤，新增 Phase 1 多探针 + Phase 2 融合 |
| `code-graph.ts` | **增强** | 新增 `detectCommunities()`, `getHubFiles()` |
| `repo-map.ts` | **不变** | Phase 0 继续使用 |
| `context-collector.ts` | **增强** | 利用 v7.0 产出的 MODULE-MAP.md 替代简单的 warm-memory |
| `llm-client.ts` | **不变** | 探针通过现有 `callLLM()` 调用 |
| IPC `project:import` | **增强** | 新增 `project:import-probe-progress` 事件 |

### 7.2 产出物复用

v7.0 的产出物直接提升后续所有 agent 的工作效率：

```
ARCHITECTURE.md     → Hot Memory (全局架构认知)
MODULE-MAP.md       → Warm Memory (模块索引，替代简单 repo-map)
probe-reports/*.md  → Cold Memory (按需加载模块详情)
DEPENDENCY-DAG.md   → 视觉化依赖 + 影响分析
TECH-DEBT.md        → PM 分析时的优先级参考
enriched skeleton   → orchestrator 调度优化
```

---

## 8. 设计决策记录

### 8.1 为什么不用 Vector Embedding / RAG？

1. **DeepMind 已证明 embedding 对代码有数学上限** — 512 维向量在 500K 文档时准确率显著退化
2. **Code Graph 的确定性远超相似度搜索** — import A → B 是事实，不是概率
3. **无需外部依赖** — 不需要向量数据库，降低部署复杂度
4. **Cognition 的实践证明图遍历 + LLM 判断优于纯 RAG**

### 8.2 为什么探针用 fast 模型而非 strong 模型？

1. **单文件理解不需要顶级推理** — fast 模型理解单个 TypeScript 文件绰绰有余
2. **成本差 ~10x** — 20 个 fast 探针 ≈ 2 个 strong 探针的价格
3. **融合阶段再用 strong** — 综合推理和交叉验证才需要最强模型
4. **学术验证** — LocAgent 用 Qwen-2.5-Coder-32B (非最大模型) 达到 92.7% 准确率

### 8.3 为什么选择 Markdown 报告而非结构化 JSON？

1. **LLM 生成 Markdown 的稳定性 >> JSON** — 减少解析失败
2. **人类可读** — 用户可以直接打开查看每个探针的分析
3. **渐进式** — 部分报告完成即可呈现，不需要完整 JSON schema
4. **结构化数据嵌入** — 通过约定格式 (YAML front-matter 或 code block) 嵌入结构化实体

---

## 9. 成功指标

| 指标 | 目标 | 测量方式 |
|------|------|---------|
| **覆盖率** | >60% 代码文件被至少一个探针理解 | `filesRead / totalFiles` |
| **架构准确度** | 人工评估 >80% 模块描述正确 | 抽样审查 |
| **后续开发效率** | Developer agent 首次成功率提升 >20% | A/B 对照 |
| **理解深度** | MODULE-MAP 包含 publicAPI + keyTypes (非空) | 自动检查 |
| **成本可控** | 单次导入 <$1.00 (默认预算) | API 费用追踪 |
| **时间可控** | 含深度探索 <8min | 端到端计时 |

---

## 10. 参考文献

1. **LocAgent**: Chen et al., "Graph-Guided LLM Agents for Code Localization", ACL 2025. https://aclanthology.org/2025.acl-long.426/
2. **CodexGraph**: "Bridging Large Language Models and Code Repositories via Code Graph Databases", NAACL 2025. https://arxiv.org/abs/2408.03910
3. **Codified Context**: Vasilopoulos, "Infrastructure for AI Agents in a Complex Codebase", arXiv 2026. https://arxiv.org/abs/2602.20478
4. **SWE-grep**: Cognition, "RL for Multi-Turn, Fast Context Retrieval", 2025. https://cognition.ai/blog/swe-grep
5. **Search Bottleneck Compilation**: MorphLLM, "Coding Agents Are Bottlenecked by Search", 2026. https://www.morphllm.com/blog/code-search-bottleneck
6. **Anthropic Agentic Coding Trends**: "2026 Agentic Coding Trends Report". https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf
7. **SWE-Search**: Antoniades et al., "Multi-Agent Software Engineering with MCTS", ICLR 2025. https://arxiv.org/abs/2410.20285
8. **Agentless**: Xia et al., "Demystifying LLM-based Software Engineering", 2024. https://arxiv.org/abs/2407.01489
9. **Aider Repo Map**: "Building a better repository map with tree-sitter", 2023. https://aider.chat/2023/10/22/repomap.html
10. **Lost-in-the-Middle**: Liu et al., "Lost in the Middle: How Language Models Use Long Contexts", TACL 2024. https://arxiv.org/abs/2307.03172
11. **Context Rot**: Chroma Research, "Context Rot across 18 LLMs", 2025. https://research.trychroma.com/context-rot

---

## 附录 A: 探针 Prompt 模板 (草案)

### Entry Probe Prompt

```
你是代码架构分析师。请分析以下入口文件及其直接依赖，梳理执行路径。

## 入口文件
{entryFile 完整内容}

## 直接依赖文件
{1-hop import 文件内容, 每个截取前 100 行}

请输出:
1. **初始化序列**: 程序启动时的执行顺序
2. **关键调用链**: 从入口到核心逻辑的调用路径
3. **数据流**: 关键数据从哪里来、流向哪里
4. **发现**: 值得注意的设计决策或潜在问题
```

### Module Probe Prompt

```
你是代码架构分析师。请深度分析以下模块。

## 模块路径: {rootPath}
## 核心文件
{core files 内容}

## 接口文件 (index.ts / types.ts)
{interface files 内容}

请输出:
1. **模块职责**: 一句话 + 详细描述
2. **公共 API**: 导出的函数/类/类型列表 (含参数签名)
3. **关键类型**: 核心数据结构定义
4. **内部设计**: 模块内部的组织方式和关键算法
5. **依赖**: 依赖了哪些外部模块，被谁依赖
6. **技术债**: 需要改进的地方
```

### Pattern Probe Prompt

```
你是代码质量分析师。以下是从项目中 grep 到的代码模式匹配结果。

## 匹配结果
{grep 结果, 按 pattern 分组}

请分析:
1. **设计模式**: 项目使用了哪些设计模式？是否正确使用？
2. **反模式**: 发现哪些反模式？严重程度如何？
3. **框架约定**: 是否遵循了框架最佳实践？
4. **整体代码质量评估**: 1-10 分
```

---

## 附录 B: 与 Aider / Cursor / Claude Code 的对比

| 特性 | Aider | Cursor | Claude Code | **AgentForge v7.0** |
|------|-------|--------|-------------|---------------------|
| 代码索引 | tree-sitter repo-map | 向量 embedding | CLAUDE.md 手动 | **Code Graph + 多探针** |
| 持久记忆 | repo-map (会话内) | .cursorrules | CLAUDE.md | **分层: Hot/Warm/Cold + probe-reports** |
| 增量更新 | git diff 触发 | 实时索引 | 手动 | **CodeGraph 增量 + 探针缓存** |
| 深度理解 | 浅 (符号级) | 中 (embedding) | 人工配置 | **深 (LLM 多角度分析)** |
| 成本 | 低 (无 LLM 索引) | 中 (embedding) | 零 | **中 (~$0.15-0.40)** |
| 大型屎山 | 较弱 | 中等 | 依赖人工 | **专门优化** |

---

*文档结束。等待评审后进入实施阶段。*
