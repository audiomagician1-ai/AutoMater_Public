# Project Importer v2 — 探测式拼图理解方案

> 日期: 2026-03-02 | 状态: 提案（待决策）

---

## 一、问题陈述

### 当前实现（v6.0 project-importer.ts）

```
Step 1: 轻量静态收集 (~1s)
  ├─ 目录树 (depth≤4)
  ├─ 关键配置文件内容 (package.json/README/tsconfig等, ≤20KB)
  ├─ Repo Map 符号索引 (正则提取, ≤100文件)
  └─ 入口文件前 200 行 (≤10KB)
  → 拼出 ~5-15K tokens 的项目快照

Step 2: 单次 LLM 调用 (~10-30s)
  → ARCHITECTURE.md + 模块列表 + design.md
```

### 核心矛盾

| 优势 | 劣势 |
|------|------|
| ✅ 快（<30s 完成） | ❌ **浅** — 只看表面结构，不进入代码 |
| ✅ token 省（单次调用） | ❌ **脆弱** — 对不规范项目（屎山）几乎无效 |
| ✅ 实现简单 | ❌ **模块摘要是空壳** — publicAPI/keyTypes/dependencies 全为空 |
| | ❌ **增量更新形同虚设** — incrementalUpdate 只做模块ID匹配，不重新分析内容 |
| | ❌ 单次 LLM 调用的输出质量完全取决于快照质量 |

**根本问题**: 真实项目（尤其是屎山）的复杂度藏在代码内部 — 隐式依赖、动态分发、约定大于配置、undocumented side effects。仅从目录树+配置文件+符号列表是不可能理解这些的。

---

## 二、你的直觉 vs 2026 最新研究

### 你的想法

> "让 agent 多次（或并行）根据一定规则去探测局部结构，记录探索报告，最后拼图得到全貌。"

这个直觉高度吻合 2026 年三个前沿方向：

### 2.1 Agentic Search（Morph / Claude Code 实践）

Morph 的研究报告了一个关键数据：**编码 Agent 60%+ 的时间在搜索上下文**，而搜索质量——不是模型大小——决定 Agent 成败。

核心架构：
- **多轮推理**: search → read → reason → search again（3-4 轮收敛）
- **并行工具调用**: 每轮 4-12 个并行 grep/read，探索 8x 更多代码库
- **子 Agent 隔离**: 搜索 Agent 在独立 context window 运行，死胡同不会污染主 Agent
- **精确输出**: 返回 `(file, [start_line, end_line])` 而非整个文件

**Anthropic 的数据**: 多 Agent 架构比单 Agent Opus **提升 90%**，原因不是子 Agent 更聪明，而是主 Agent 的 context 保持干净。

### 2.2 CodeMap（JHU/SMU 2026 论文 — 学习代码审计师）

研究了代码审计师（每周要快速理解一个陌生项目的人）的策略：

**核心发现: 理解流 = 全局 → 结构 → 局部**
1. 先看项目概览（技术栈、架构）
2. 再看代码结构和业务逻辑（模块关系、数据流）
3. 最后看具体函数和变量

**关键洞察**:
- LLM 对话式交互对理解代码效率很低 — 用户 79% 时间在阅读 LLM 响应而非理解代码
- 动态信息提取 + 分层可视化 + 交互式探索 >> 静态一次性分析
- 新手开发者尤其受益于结构化导航（减少无目的探索）

### 2.3 RPG — Repository Planning Graph（Microsoft, ICLR 2026）

**最关键的发现**: 用自然语言描述仓库结构不可靠 — 模糊、不一致、长 horizon 退化。

RPG 引入**结构化图表示**:
- 节点: capabilities → files → functions → data types
- 边: dependency / data-flow / import 关系
- 三阶段: Proposal Planning → Implementation Planning → Graph-guided Generation

**数据**: ZeroRepo 生成的代码量是 Claude Code 的 3.9x，覆盖率 81.5%，测试准确率 69.7%。

---

## 三、方案设计：探测式拼图架构

### 3.1 设计原则

| 原则 | 来源 | 实现 |
|------|------|------|
| **探测优于全量扫描** | Agentic Search | 多个探测 Agent 并行探索局部 |
| **理解流对齐** | CodeMap | 全局→结构→局部三层递进 |
| **结构化中间表示** | RPG | 用图（而非纯文本）记录理解 |
| **子 Agent 隔离** | Claude Code/Anthropic | 每个探测 Agent 独立 context |
| **增量拼合** | 拼图比喻 | 多报告 merge → 全局视图 |

### 3.2 三阶段流程

```
┌────────────────────────────────────────────────────────────────┐
│  Phase 0: 骨架扫描 (零 LLM, <2s)                              │
│  ├─ 目录树 + 技术栈检测 + 文件统计                              │
│  ├─ Code Graph (import/export 依赖图)                          │
│  ├─ Repo Map (符号索引)                                        │
│  └─ 入口文件识别                                               │
│  → 产出: skeleton.json + exploration-plan.json                 │
└──────────────────────────┬─────────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  Phase 1: 并行探测 (N 个探测 Agent, 每个 1-3 轮 LLM 调用)      │
│                                                                │
│  Probe 策略 (由 Phase 0 的 exploration-plan 驱动):              │
│  ├─ 入口追踪探测: 从入口文件出发, 沿 import 链深入 3-5 跳       │
│  ├─ 模块纵深探测: 选 LOC 最大的 N 个模块, 读核心文件           │
│  ├─ API 边界探测: 找 route/handler/export 定义, 理解对外接口    │
│  ├─ 数据模型探测: 找 schema/model/type 定义, 理解数据结构       │
│  ├─ 配置/基础设施探测: 找 config/middleware/plugin 模式         │
│  └─ 异常模式探测: 找 workaround/hack/TODO/deprecated 标记      │
│                                                                │
│  每个探测 Agent:                                                │
│    1. 接收明确的探测任务 + 相关文件路径种子                      │
│    2. 用工具 (read_file/grep/list_files) 探索 (1-3 轮)         │
│    3. 输出结构化 ProbeReport:                                   │
│       { probeType, filesExamined, findings[], dependencies[],   │
│         patterns[], issues[], confidence }                      │
│    4. 报告写入 .automater/analysis/probes/                      │
│                                                                │
│  并行控制: 最多 workerCount 个同时运行                          │
│  Token 预算: 每个探测 ≤ 8K input + 2K output                   │
└──────────────────────────┬─────────────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────┐
│  Phase 2: 拼图合成 (单次 Strong 模型, 全局视图)                 │
│                                                                │
│  输入:                                                          │
│  ├─ skeleton.json (Phase 0)                                     │
│  ├─ 所有 ProbeReport (Phase 1, 拼接后 ~15-25K tokens)          │
│  └─ Code Graph 摘要                                            │
│                                                                │
│  输出:                                                          │
│  ├─ ARCHITECTURE.md (有血有肉, 非模板化)                        │
│  ├─ module-graph.json (RPG 风格结构化图)                        │
│  │   { nodes: [{id, type, path, responsibility, publicAPI,      │
│  │             keyTypes, patterns, issues}],                    │
│  │     edges: [{source, target, type: import|dataflow|event}] } │
│  ├─ design.md (产品/业务逻辑文档)                               │
│  └─ known-issues.md (屎山检测报告: 技术债/hack/风险点)          │
│                                                                │
│  关键: 合成模型看到的是 N 个不同视角的一手观察,                  │
│        而非从目录树猜测的表面描述                                 │
└────────────────────────────────────────────────────────────────┘
```

### 3.3 探测策略详解

#### 策略 1: 入口追踪（Entry Trace）

```
种子: Phase 0 识别的入口文件 (main.ts, App.tsx, server.ts)
方法:
  1. 读入口文件全文
  2. 沿 Code Graph 的 import 边, 深度优先遍历 3-5 跳
  3. 每个跳转读目标文件的前 100 行 (签名+注释+export)
  4. 记录: 启动流程, 初始化顺序, 核心依赖链
目的: 理解 "系统是怎么跑起来的"
```

#### 策略 2: 模块纵深（Module Deep Dive）

```
种子: Phase 0 检测到的 top-N 模块 (按 LOC 排序)
方法:
  1. 读模块根目录的 index.ts 或最大文件
  2. grep 导出的公开 API (export function/class/const)
  3. 读 1-2 个核心实现文件的关键函数
  4. 记录: 模块职责, 公开接口, 关键数据结构, 依赖关系
目的: 理解 "每个模块做什么, 怎么用"
```

#### 策略 3: API 边界（API Boundary）

```
种子: grep 'router\.|app\.(get|post|put)|@(Get|Post|Controller)|export.*handler'
方法:
  1. 从路由/handler 定义出发
  2. 读请求参数 + 响应格式
  3. 追踪到 service/model 层
  4. 记录: API 端点清单, 数据流向, 认证/中间件链
目的: 理解 "系统对外提供什么能力"
```

#### 策略 4: 数据模型（Data Model）

```
种子: grep 'interface|type|schema|model|entity|Table|Column'
方法:
  1. 收集所有类型/schema 定义
  2. 识别核心实体和它们的关系
  3. 找数据库迁移文件或 ORM 定义
  4. 记录: 核心实体, 字段, 关系, 校验规则
目的: 理解 "系统操作什么数据"
```

#### 策略 5: 异常模式（Smell Detection）

```
种子: grep 'TODO|FIXME|HACK|XXX|deprecated|workaround|TEMP|UNSAFE'
     + 检测: 超大文件(>1000行), 深嵌套(>5层), God Class, 循环依赖
方法:
  1. 收集标记点及其上下文 (±10行)
  2. 分析模式: 是 known issue 还是 active tech debt
  3. 记录: 位置, 严重度, 上下文, 可能的影响范围
目的: 理解 "哪里是雷区, 改动时要小心"
```

### 3.4 与现有系统的集成

```
importProject() — Phase 0 + Phase 1 + Phase 2 (新流程)
     ↓
orchestrator.ts Phase 1 (PM 分析)
  └─ 注入 ARCHITECTURE.md + module-graph.json + known-issues.md 作为上下文
     ↓
orchestrator.ts Phase 4 (Developer 实现)
  └─ context-collector.ts 使用 module-graph.json 做精准上下文收集
     (替代当前基于目录分组的粗粒度模块匹配)
```

---

## 四、客观风险评估

### 4.1 方案的优势

| # | 优势 | 量化预期 |
|---|------|----------|
| 1 | **深度**: Agent 真正读代码而非猜结构 | 模块摘要从空壳→有 publicAPI/keyTypes |
| 2 | **鲁棒性**: 多探针 + 多视角, 对屎山更耐受 | 不规范项目的理解质量 ↑ |
| 3 | **并行**: N 个探测同时跑 | Phase 1 耗时 ≈ 单探测耗时 (受 LLM 并发限制) |
| 4 | **精准上下文**: module-graph.json 供后续 Developer 使用 | 减少 Developer 的盲目搜索 |
| 5 | **屎山检测**: 主动发现技术债 | 避免在雷区盲目修改 |

### 4.2 方案的风险与缓解

| 风险 | 严重度 | 缓解措施 |
|------|--------|----------|
| **Token 成本显著增加** | 🟡 中 | 当前: 1 次 LLM (~10K in + 4K out ≈ $0.05)。新方案: 6-10 次探测 (~$0.30-0.80)。但这是一次性投入, 且 strong model 的理解质量直接决定后续所有 Feature 的开发效率 |
| **探测 Agent 理解偏差** | 🟡 中 | 每个探测只负责局部, 偏差在 Phase 2 拼合时被交叉验证。另外: ProbeReport 有 confidence 字段, 低置信度的发现可被降权 |
| **总耗时增加** | 🟢 低 | 从 <30s 增加到 2-5 分钟。但大型项目导入是低频操作, 且质量收益远大于时间成本 |
| **并行 LLM 调用受限** | 🟡 中 | 受 API rate limit 约束。fallback: 串行执行, 或按重要度分批 |
| **过度探测**: 项目很小时浪费 | 🟢 低 | Phase 0 根据文件数/LOC 动态决定探测数量。<50 文件 → 退化为 v6.0 单次调用 |
| **ProbeReport 格式不一致** | 🟡 中 | 使用 output-parser + JSON Schema 强制结构化输出 |

### 4.3 关键不确定性（需要验证）

1. **探测覆盖率 vs 成本的平衡点**: 6 个探测够不够？还是需要 10+？→ 需在 2-3 个真实项目上实验
2. **Phase 2 的拼合质量**: 多个 ProbeReport 拼成 ~20K tokens 输入, 模型能否有效综合？→ 需要 prompt 工程
3. **对不同技术栈的适应性**: 探测策略硬编码了 TS/JS 的模式 (grep router/handler), 其他语言需要不同 pattern → 需要策略可配置化

---

## 五、实施路径

### Phase A: 最小可验证（3-5h）

**目标**: 验证"多探测 → 拼合"比"单次快照 → LLM"的理解质量是否显著提升。

**范围**:
- [ ] 在现有 `importProject()` 基础上, 添加 Phase 1 探测（串行, 3 个策略: 入口追踪 + 模块纵深 + 数据模型）
- [ ] ProbeReport 写入 `.automater/analysis/probes/`
- [ ] Phase 2 修改 prompt, 注入 ProbeReport
- [ ] 在 AgentForge 自身 + 一个外部项目上测试, 对比 v6.0 和 v2 的 ARCHITECTURE.md 质量

**验证标准**:
- ARCHITECTURE.md 包含的具体函数名/类型名数量 ↑ 50%+
- 模块摘要的 publicAPI 字段非空率 > 80%
- 人工判断: 对关键数据流的描述是否正确

### Phase B: 并行化 + 完整策略（4-6h）

**范围**:
- [ ] 复用 workerLoop 并行模式, 多探测 Agent 同时执行
- [ ] 添加剩余 3 个策略 (API 边界 + 异常模式 + 配置/基础设施)
- [ ] 动态探测数量: 小项目退化为 v6.0, 大项目多探测
- [ ] ProbeReport JSON Schema + output-parser 验证

### Phase C: 结构化图输出 + 下游集成（4-6h）

**范围**:
- [ ] Phase 2 输出 `module-graph.json` (RPG 风格)
- [ ] context-collector.ts 使用 module-graph 做精准文件选择
- [ ] orchestrator 注入 known-issues.md 到 Developer 上下文
- [ ] UI: 导入结果页面展示模块图 + 探测覆盖率

### Phase D: 增量探测（2-4h）

**范围**:
- [ ] `incrementalProbe()`: 基于 git diff, 只对变更文件所在模块重新探测
- [ ] 与 Phase 4c (增量文档同步) 集成
- [ ] 探测结果缓存 + 过期策略

---

## 六、与竞品的差异化定位

| 能力 | Cursor (Merkle Tree 索引) | Claude Code (Agentic grep) | AgentForge v6.0 | **AgentForge v2 (本方案)** |
|------|--------------------------|---------------------------|------------------|--------------------------|
| 索引方式 | 嵌入向量 + Merkle Tree | 运行时 grep (无预索引) | 静态快照 + 单次 LLM | 多探针 Agent + 结构化图 |
| 对屎山的理解 | 中 (依赖嵌入质量) | 高 (Agent 自主探索) | 低 (只看表面) | **高 (多视角深入)** |
| 理解深度 | 符号级 | 文件级 (搜到就读) | 目录级 | **模块/函数级** |
| 中间表示 | 嵌入向量 (不可读) | 无 (in-context) | skeleton.json (空壳) | **module-graph.json (结构化图)** |
| 供后续 Agent 使用 | 自动 (IDE 内置) | 每次重新搜索 | 注入 ARCHITECTURE.md | **精准上下文注入 (图引导)** |

---

## 七、决策要点

1. **是否立即实施?** — 建议先做 Phase A (最小验证), 用 3-5h 确认方向正确
2. **Token 成本是否可接受?** — 导入是一次性操作, $0.50-1.00 的投入换来整个项目开发周期的理解质量提升, ROI 极高
3. **优先级 vs 代码质量修复?** — 可以与质量修复并行。导入器改进是功能增强, 质量修复是卫生工作, 不冲突

---

*文档由 Tim 的开发助手基于当前实现分析 + 2026 前沿调研生成。所有引用的论文和工具数据均来自公开来源。*

### 引用
- [Morph — Agentic Search](https://www.morphllm.com/agentic-search): Agent 60%+ 时间在搜索, 并行工具调用提升效率
- [CodeMap (arXiv:2504.04553)](https://arxiv.org/abs/2504.04553): 代码审计师理解流 = 全局→结构→局部, 动态信息提取 >> 静态分析
- [RPG/ZeroRepo (arXiv:2509.16198, ICLR 2026)](https://arxiv.org/abs/2509.16198): 结构化图表示优于自然语言规划, 3.9x 代码生成量
- [Anthropic — Multi-agent architecture](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): 子 Agent 隔离, 90% 性能提升
