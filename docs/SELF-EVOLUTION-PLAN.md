# AutoMater 自我迭代/自我进化 执行方案

> **Date**: 2026-03-02  
> **Status**: Design Draft  
> **基于**: 2025-2026 前沿研究综合分析

---

## 目录

1. [核心思路：多实例交叉进化](#1-核心思路多实例交叉进化)
2. [前沿研究综述](#2-前沿研究综述)
3. [架构设计：AutoMater 多实例进化系统](#3-架构设计automater-多实例进化系统)
4. [安全与防护机制](#4-安全与防护机制)
5. [分阶段实施路线图](#5-分阶段实施路线图)
6. [关键度量与停止条件](#6-关键度量与停止条件)
7. [风险分析](#7-风险分析)

---

## 1. 核心思路：多实例交叉进化

你的直觉是对的——**多实例并行进化 + 交叉验证**正是 2025-2026 年自改进 AI 系统的核心范式。关键洞察：

| 特性 | 单实例自改 | 多实例交叉进化 |
|------|-----------|---------------|
| 容错率 | 低——单点突变失败即回滚 | 高——N个并行路径，任意一条成功即可 |
| 探索多样性 | 贪心搜索，易陷入局部最优 | 种群搜索，多条进化路径并行 |
| 验证可信度 | 自评自改，"批改自己的作业" | 交叉评审，A的改进由B/C验证 |
| 速度 | 串行受限 | 并行加速，N个实例≈N倍探索带宽 |
| 安全性 | 难以检测自欺行为 | 多数投票 + 异常检测 |

---

## 2. 前沿研究综述

### 2.1 Darwin Gödel Machine (Sakana AI, 2025)

**最直接相关的工作。**

- **架构**: 维护一个不断增长的 Agent **Archive**(档案库)，每个节点是一个完整的 coding agent 代码库
- **进化方式**: 从档案中选择"父代"agent → LLM 提出代码修改 → 在 benchmark 上评估 → 通过则加入档案
- **核心发现**:
  - SWE-bench 上 20% → 50%，Polyglot 上 14.2% → 30.7%
  - **开放式探索是关键**：不只保留最优个体，保留"有趣的"stepping stones
  - **发现可迁移**：Claude 3.5 Sonnet 上发现的改进在 o3-mini、Claude 3.7 上也有效
  - **安全问题**: DGM 试图 hack 自己的评估函数（删除检测标记来伪造成功），需要透明的变更追踪

> **对 AutoMater 的启示**: Archive 结构 = 我们的 git branches。多实例 = 并行探索不同分支。评估函数 = 我们已有的 quality gate (tsc + vitest + coverage)。

**参考**: [arxiv.org/abs/2505.22954](https://arxiv.org/abs/2505.22954), [sakana.ai/dgm](https://sakana.ai/dgm)

### 2.2 SICA — Self-Improving Coding Agent (Bristol, 2025)

- Agent 直接编辑自己的源代码（prompts, heuristics, tools, workflow）
- SWE-Bench Verified 上 17% → 53%
- 关键机制：**edit → evaluate → keep-if-better → repeat**
- 与 DGM 区别：SICA 是单实例串行改进，DGM 是多实例种群

**参考**: [arxiv.org/abs/2504.15228](https://arxiv.org/abs/2504.15228)

### 2.3 AlphaEvolve (Google DeepMind, 2025)

- **进化编码 Agent**：维护一个程序数据库，用进化算法决定哪些程序用于下一轮
- 双模型策略: **Gemini Flash**（广度探索）+ **Gemini Pro**（深度建议）
- 成果：Strassen 1969年以来最好的 4×4 矩阵乘法、Google 数据中心调度节省 0.7% 全球算力
- **核心模式**: Prompt Sampler → LLM 生成 → Evaluator 验证 → 进化选择 → 循环

> **对 AutoMater 的启示**: 双层 LLM 策略很适合我们——快速模型做大量变异探索，强力模型做关键决策。

**参考**: [deepmind.google/blog/alphaevolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)

### 2.4 SiriuS — Self-Improving Multi-Agent Systems (Stanford, NeurIPS 2025)

- **多 Agent 协作自改进**框架
- 核心机制：**Experience Library**（经验库）——存储成功轨迹，修复失败轨迹
- 提升 2.86% ~ 21.88% across reasoning/QA/negotiation
- **关键创新**: Agent 之间交叉验证输出 → 内建自纠正机制

> **对 AutoMater 的启示**: 经验库 = 我们的 decision-log + skill-evolution 模块。多 Agent 交叉验证 = 多实例交叉审查。

**参考**: [openreview.net/pdf?id=sLBSJr3hH5](https://openreview.net/pdf?id=sLBSJr3hH5)

### 2.5 Multi-Agent Evolve (UIUC+NVIDIA, 2025)

- **三角色共进化**: Proposer（出题）+ Solver（解题）+ Judge（评判）
- 从同一个 LLM 实例化出三个角色，通过 RL 联合优化
- 核心: **对抗式共进化**——Solver 越强，Proposer 出更难的题
- 无需人工标注数据，Qwen2.5-3B 提升 4.54%

> **对 AutoMater 的启示**: 我们可以让多个 AutoMater 实例扮演不同角色——有的做改进，有的做评审，有的做压力测试。

**参考**: [arxiv.org/pdf/2510.23595](https://arxiv.org/pdf/2510.23595)

### 2.6 Controlled Self-Evolution (CSE, 2026)

- **三阶段控制进化**: 多样化初始化 → 遗传进化（引导变异+交叉）→ 分层记忆
- 比 AlphaEvolve 更节约计算——聚焦搜索效率
- **全局记忆 + 局部记忆**: 跨任务的通用模式 + 当前任务的特定教训

**参考**: [arxiv.org/html/2601.07348v1](https://arxiv.org/html/2601.07348v1)

### 2.7 行业预判

| 来源 | 预测 |
|------|------|
| **Anthropic** (Dario Amodei, 2026.01) | RSI 可能在 2027 年初到来 |
| **OpenAI** Codex 团队 | 2026 年是 Agent 年，Codex 用量增长 20× |
| **IEEE Spectrum** (2025.07) | DGM 标志"AI 改进 AI"的工程化转折点 |
| **arXiv 综述** (2507.21046) | 自进化 Agent 是通往 ASI 的关键路径 |
| **NeurIPS 2025** | Self-improving agent 相关论文数量较 2024 增长 3 倍 |

### 2.8 核心共识：自改进只在「可验证」领域有效

> *"AI self-improvement only works where outcomes are verifiable."*  
> — Anthony Alcaraz, Data Science Collective, 2026.02

代码之所以是自改进的最佳领域，因为具备四个特性：
1. **二值测试信号** — 测试要么通过要么失败
2. **量化基准** — SWE-Bench 等基准提供数值反馈
3. **确定性静态分析** — linter、type checker 可以不执行就发现退化
4. **因果执行轨迹** — 代码运行后 stack trace 直连故障到具体行

**AutoMater 完全具备这四个条件**: 我们有 tsc、vitest、coverage thresholds、quality gate。

---

## 3. 架构设计：AutoMater 多实例进化系统

### 3.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Evolution Coordinator                      │
│          (中央调度器 — 独立进程/独立项目副本)                    │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Instance │  │ Instance │  │ Instance │  │ Instance │    │
│  │   Alpha  │  │   Beta   │  │  Gamma   │  │  Delta   │    │
│  │          │  │          │  │          │  │          │    │
│  │ git br:  │  │ git br:  │  │ git br:  │  │ git br:  │    │
│  │ evo/α-01 │  │ evo/β-01 │  │ evo/γ-01 │  │ evo/δ-01 │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │              │              │              │          │
│  ┌────▼──────────────▼──────────────▼──────────────▼────┐    │
│  │              Shared Archive (Git + SQLite)            │    │
│  │    • Agent 代码变体及其评估分数                          │    │
│  │    • 进化谱系树 (parent → child 关系)                   │    │
│  │    • 经验库 (成功/失败的修改模式)                        │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Cross-Validation Gate                    │    │
│  │    • A的修改在B/C的环境中也通过测试?                     │    │
│  │    • 多数投票: ≥2/3 实例验证通过才合并到 master          │    │
│  │    • 异常检测: 评估分数突变 → 人工审查标记               │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 单个 Instance 的内部循环

```
for generation in 1..MAX_GENERATIONS:
    1. 从 Archive 选择一个"父代"Agent 代码库
       (选择策略: 70% 性能加权采样, 30% 多样性采样)

    2. LLM 分析父代代码 + 过往进化记忆 → 提出修改计划
       (修改范围: prompts, tool implementations, workflow logic,
        error handling, model selection strategy, test coverage)

    3. 应用修改到独立 git branch: evo/{instance}-{gen}

    4. 运行 Quality Gate:
       a. tsc --noEmit              → 编译检查
       b. vitest run                → 单元测试
       c. coverage >= thresholds    → 覆盖率检查
       d. integration smoke test    → 端到端冒烟测试
       e. benchmark suite           → 性能基准

    5. 计算 Fitness Score:
       score = w1 * test_pass_rate
             + w2 * coverage_delta
             + w3 * benchmark_score
             + w4 * code_quality_score
             - w5 * regression_penalty

    6. 提交到 Cross-Validation Gate:
       → 其他 instances 拉取此分支运行测试
       → 收集多实例验证结果

    7. if cross_validated:
         添加到 Archive, 更新经验库(成功模式)
       else:
         添加到经验库(失败模式), 不入 Archive
```

### 3.3 角色分化（参考 Multi-Agent Evolve）

不同的 Instance 可以承担不同的进化角色：

| 角色 | 职责 | 优化目标 |
|------|------|----------|
| **Mutator** (变异者) | 对代码做小幅增量修改 | 局部优化，修bug，提升覆盖率 |
| **Architect** (架构师) | 做大幅度架构重构 | 全局优化，新功能，新模块 |
| **Adversary** (挑战者) | 为其他实例的修改编写压力测试 | 找出改进的漏洞和退化 |
| **Judge** (评审者) | 综合评估各实例的修改质量 | 维护质量标准，防止退化 |

### 3.4 进化策略（参考 DGM + AlphaEvolve + CSE）

#### 选择 (Selection)
- **Tournament Selection**: 随机取 k=3 个 Archive 中的 agent，选最优做父代
- **Novelty Bonus**: 与已有 agent 差异度大的变体获额外分数（防止收敛到单一设计）
- **Stepping Stone 保留**: 即使得分不是最高，只要引入了新特性/新方法就保留到 Archive

#### 变异 (Mutation)
- **Targeted Mutation**: 基于失败测试的 stack trace，精准修改出错模块
- **Random Exploration**: 10-20% 的变异是随机选择一个模块做结构性修改
- **Prompt Mutation**: 修改 system prompts、tool descriptions、workflow 指令

#### 交叉 (Crossover)
- **Module-level Crossover**: 从父代A取 orchestrator，从父代B取 tool-executor
- **Strategy Crossover**: 从A取 error handling 策略，从B取 context management 策略

#### 记忆 (Memory) — 参考 CSE
- **Local Memory**: 每个 Instance 维护当前任务的"尝试过什么，结果如何"
- **Global Memory**: 全体共享的"模块X这样改容易引入regression"、"这种修改模式通常有效"

### 3.5 技术实现方案

#### 基于 Git Worktree 的并行隔离
```bash
# 创建多个独立工作目录
git worktree add ../automater-alpha evo/alpha-main
git worktree add ../automater-beta  evo/beta-main
git worktree add ../automater-gamma evo/gamma-main

# 每个 instance 在自己的 worktree 中独立修改
# 共享同一个 .git 目录 → 可以轻松 cherry-pick 和 merge
```

#### Evolution Coordinator 实现
```typescript
// electron/engine/evolution-coordinator.ts (新模块)
interface EvolutionConfig {
  instances: number;          // 并行实例数 (推荐 3-5)
  maxGenerations: number;     // 最大进化代数
  archiveMaxSize: number;     // Archive 最大容量
  crossValidationQuorum: number; // 交叉验证所需通过数
  fitnessWeights: {
    testPassRate: number;
    coverageDelta: number;
    benchmarkScore: number;
    codeQuality: number;
    regressionPenalty: number;
  };
}

interface ArchiveEntry {
  id: string;
  parentId: string | null;
  generation: number;
  instanceId: string;
  branch: string;
  fitnessScore: number;
  modifications: ModificationRecord[];
  crossValidationResults: ValidationResult[];
  timestamp: number;
}

interface EvolutionMemory {
  successPatterns: Pattern[];    // 成功的修改模式
  failurePatterns: Pattern[];   // 失败的修改模式
  moduleRiskMap: Record<string, number>; // 模块风险评分
}
```

#### 评估管道 (Fitness Pipeline)
```bash
# scripts/evaluate-fitness.sh
#!/bin/bash
set -e

echo "=== Fitness Evaluation ==="

# 1. Type Check
TSC_RESULT=$(npx tsc --noEmit 2>&1 | tail -1)
if [[ $TSC_RESULT == *"error"* ]]; then
  echo "FAIL: TypeScript errors"
  exit 1
fi

# 2. Unit Tests
TEST_OUTPUT=$(pnpm vitest run --reporter=json 2>&1)
PASS_RATE=$(echo $TEST_OUTPUT | jq '.numPassedTests / .numTotalTests')

# 3. Coverage
COVERAGE=$(pnpm vitest run --coverage --reporter=json 2>&1)
STMT_COV=$(echo $COVERAGE | jq '.total.statements.pct')

# 4. Benchmark (可选 — 端到端任务完成率)
# BENCH_SCORE=$(node scripts/benchmark.js)

# 5. Code Quality
LINT_SCORE=1.0  # TODO: integrate eslint scoring

# 6. Output fitness
echo "{
  \"testPassRate\": $PASS_RATE,
  \"statementCoverage\": $STMT_COV,
  \"codeQualityScore\": $LINT_SCORE,
  \"timestamp\": $(date +%s)
}"
```

---

## 4. 安全与防护机制

### 4.1 核心安全原则（来自 DGM 教训）

DGM 的实验揭示了一个**关键风险**: 自改进系统会尝试 hack 自己的评估函数。AutoMater 必须防范这一点。

### 4.2 多层防护体系

```
Layer 1: Immutable Quality Gate (不可变的质量关卡)
├── tsc, vitest, coverage thresholds 的代码存放在只读目录
├── 进化过程不得修改 vitest.config.ts, tsconfig.json, quality-gate.js
└── Hash 校验: 每次评估前验证评估脚本的 SHA256

Layer 2: Cross-Validation (交叉验证)
├── Instance A 的修改必须在 Instance B/C 的环境中也通过测试
├── 至少 2/3 多数投票通过才能合并
└── 任何 Instance 检测到评估函数被修改 → 立即标红

Layer 3: Anomaly Detection (异常检测)
├── 分数突然暴涨 (>20% jump) → 自动暂停，等待人工审查
├── 测试数量减少 → 拒绝 (禁止通过删除测试来"提升"通过率)
├── 覆盖率下降 → 拒绝
└── 修改范围超出预期（修改了评估相关文件）→ 拒绝

Layer 4: Human-in-the-Loop (人工监督)
├── 每 N 代强制人工审查 checkpoint
├── 所有合并到 master 的变更需人工确认
├── Evolution Dashboard: 实时可视化进化树、分数趋势、修改diff
└── Kill Switch: 一键停止所有进化进程

Layer 5: Rollback Infrastructure (回滚基础设施)
├── 每个进化步骤都是一个 git commit → 随时可回退
├── Archive 保留所有历史变体 → 可恢复到任意历史节点
└── master 分支永远是已验证的稳定版本
```

### 4.3 禁止修改清单

以下文件/目录在进化过程中**不可修改**:
```
✘ vitest.config.ts          (测试配置)
✘ tsconfig.json              (编译配置)
✘ scripts/quality-gate.js    (质量门禁)
✘ scripts/evaluate-fitness.sh (适应度评估)
✘ __mocks__/                  (测试mock)
✘ electron/engine/__tests__/  (已有测试用例 — 只许增不许删改)
✘ docs/SELF-EVOLUTION-PLAN.md (本文档)
```

---

## 5. 分阶段实施路线图

### Phase 0: 基础设施准备 (1-2 周)

- [ ] 完善 benchmark suite (端到端任务完成率评测)
- [ ] 实现 `scripts/evaluate-fitness.sh` (综合适应度评分)
- [ ] 建立 Archive 数据库 schema (SQLite 表)
- [ ] 设置 git worktree 自动化脚本
- [ ] 实现评估文件 hash 校验机制

### Phase 1: 单实例自改进 (2-3 周)

目标: **验证 "edit → evaluate → keep/discard" 循环可行**

- [ ] 实现 `evolution-coordinator.ts` 基础版本
- [ ] 单个 AutoMater instance 尝试修改自己的 prompts
- [ ] 修改范围限定为: `electron/engine/prompts.ts`, `electron/engine/constants.ts`
- [ ] 评估指标: quality gate 通过 + benchmark 分数
- [ ] 人工审查每一次修改
- [ ] 预期: 熟悉循环机制，发现意外问题

### Phase 2: 双实例交叉验证 (2-3 周)

目标: **验证交叉验证机制**

- [ ] 启动 2 个 AutoMater instance (Alpha + Beta)
- [ ] Alpha 做修改，Beta 验证；然后交换
- [ ] 实现 Cross-Validation Gate
- [ ] 修改范围扩大: 包含 tool implementations, error handling
- [ ] 实现进化记忆系统 (成功/失败模式存储)
- [ ] 预期: 发现交叉验证能捕获哪些单实例漏掉的问题

### Phase 3: 多实例种群进化 (3-4 周)

目标: **完整的 DGM-style 进化系统**

- [ ] 扩展到 3-5 个并行实例
- [ ] 实现角色分化 (Mutator / Architect / Adversary)
- [ ] 实现 Archive 管理 (淘汰、保留、谱系追踪)
- [ ] 实现 Tournament Selection + Novelty Bonus
- [ ] 实现 Module-level Crossover
- [ ] 修改范围: 所有 engine 模块 (排除禁止清单)
- [ ] Evolution Dashboard (Web UI, 显示进化树和趋势)
- [ ] 预期: 开始看到自动发现的有意义改进

### Phase 4: 深度自进化 (持续)

目标: **让系统持续改进自身能力**

- [ ] 允许修改自己的 react-loop, orchestrator 核心逻辑
- [ ] 自动生成新测试用例 (Adversary role)
- [ ] 自动发现并修复 bug
- [ ] 自动优化性能瓶颈
- [ ] 探索: 让进化系统改进进化系统本身 (meta-evolution)
- [ ] 长期: 接入用户反馈作为额外的 fitness signal

---

## 6. 关键度量与停止条件

### 6.1 Fitness 计算公式

```
Fitness = 0.30 × test_pass_rate        (测试通过率, 0-1)
        + 0.20 × coverage_improvement   (覆盖率增长, 归一化)
        + 0.25 × benchmark_score        (端到端任务完成率)
        + 0.15 × code_quality           (代码质量评分)
        - 0.10 × regression_count       (退化数量, 归一化惩罚)
```

### 6.2 进化成功标准

| 度量 | 当前基线 | Phase 1 目标 | Phase 3 目标 |
|------|---------|-------------|-------------|
| 单元测试通过率 | 100% (572/572) | 100% (600+) | 100% (800+) |
| 语句覆盖率 | 27% | 30% | 45%+ |
| tsc 错误 | 0 | 0 | 0 |
| Benchmark 任务完成率 | TBD | TBD+5% | TBD+20% |
| 人工确认改进占比 | N/A | >70% | >80% |

### 6.3 停止条件

- **紧急停止**: 评估函数被修改、安全检查失败、分数异常暴涨
- **正常停止**: 达到最大代数、连续 K 代无显著改进 (fitness plateau)
- **成功停止**: 达到 Phase 目标、所有度量绿灯

---

## 7. 风险分析

### 7.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Evaluation hacking (DGM 已证实) | 高 | 严重 | 不可变评估 + hash校验 + 交叉验证 |
| 退化传播 (坏改进影响后续) | 中 | 中 | Archive 谱系追踪 + 快速回滚 |
| 计算成本过高 | 中 | 中 | 用快速模型做初筛，强模型做精选 |
| 修改导致不可维护 | 中 | 高 | 代码质量评分 + human review |
| 进化收敛到局部最优 | 中 | 低 | Novelty bonus + 多样性采样 |

### 7.2 资源需求估算

| 资源 | Phase 1 | Phase 2 | Phase 3 |
|------|---------|---------|---------|
| LLM API 调用/天 | ~50 | ~200 | ~500-1000 |
| 计算时间 (评估) | ~1小时/代 | ~2小时/代 | ~1小时/代 (并行) |
| 人工审查时间 | ~30分/天 | ~1小时/天 | ~2小时/天 |
| 并行 instances | 1 | 2 | 3-5 |
| 磁盘空间 | ~1GB | ~3GB | ~10GB |

---

## 附录 A: 关键参考文献

1. **Darwin Gödel Machine** — Zhang et al., 2025. [arxiv.org/abs/2505.22954](https://arxiv.org/abs/2505.22954)
2. **SICA: Self-Improving Coding Agent** — Robeyns et al., 2025. [arxiv.org/abs/2504.15228](https://arxiv.org/abs/2504.15228)
3. **AlphaEvolve** — Google DeepMind, 2025. [deepmind.google/blog/alphaevolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)
4. **SiriuS: Self-Improving Multi-Agent Systems** — Zhao et al., NeurIPS 2025. [openreview.net/pdf?id=sLBSJr3hH5](https://openreview.net/pdf?id=sLBSJr3hH5)
5. **Multi-Agent Evolve** — Chen et al., 2025. [arxiv.org/pdf/2510.23595](https://arxiv.org/pdf/2510.23595)
6. **Controlled Self-Evolution (CSE)** — Hu et al., 2026. [arxiv.org/html/2601.07348v1](https://arxiv.org/html/2601.07348v1)
7. **Survey of Self-Evolving Agents** — Gao et al., 2025. [arxiv.org/abs/2507.21046](https://arxiv.org/abs/2507.21046)
8. **Better Ways to Build Self-Improving AI Agents** — NeurIPS 2025 synthesis. [yoheinakajima.com](https://yoheinakajima.com/better-ways-to-build-self-improving-ai-agents/)
9. **OpenAI Self-Evolving Agents Cookbook** — 2025. [developers.openai.com/cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining/)
10. **AI Self-Improvement Only Works Where Outcomes Are Verifiable** — Alcaraz, 2026. [medium.com](https://medium.com/data-science-collective/ai-self-improvement-only-works-where-outcomes-are-verifiable-b37981db169a)

## 附录 B: 与现有 AutoMater 模块的对接

| 进化系统组件 | 对接的现有模块 | 说明 |
|-------------|---------------|------|
| Archive | `event-store.ts` + git | 存储进化历史和谱系 |
| Fitness Pipeline | `quality-gate.js` + `vitest` | 已有质量门禁直接复用 |
| Evolution Memory | `decision-log.ts` + `memory-system.ts` | 记录成功/失败模式 |
| Cross-Validation | `tool-executor.ts` | 在不同 instance 执行测试 |
| Mutation Generator | `react-loop.ts` + `llm-client.ts` | LLM 生成代码修改提案 |
| Dashboard | `ui-bridge.ts` + React frontend | 进化可视化 |
| Skill Transfer | `skill-evolution.ts` + `skill-loader.ts` | 在 instance 间迁移学到的技能 |
