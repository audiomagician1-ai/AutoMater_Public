# AgentForge 跨项目工程洞察 — 三系统参悟报告

> **日期**: 2026-03-02
> **对标项目**: `agent-memory` (跨会话记忆系统) / `agent-swarm` (多Agent编排方法论) / `Actant` (Agent平台框架)
> **目的**: 从三个不同定位的系统中提炼可借鉴的工程思路，研判 AgentForge 的改进方向

---

## 一、三系统定位对比

| 维度 | agent-memory | agent-swarm | Actant | **AgentForge** |
|------|-------------|-------------|--------|---------------|
| **核心定位** | LLM Agent 的跨会话持久记忆 | 多Agent并行开发编排方法论 | Agent 生命周期管理平台 | AI 驱动的全栈开发团队 |
| **运行形态** | 文件系统 (JSON/MD) | 脚本+Prompt模板 | CLI Daemon + Monorepo | Electron 桌面应用 |
| **成熟度** | Philosophy ✅ Production | Philosophy ✅ / Runtime 🧪 | v0.2.6, 1027 tests | v5.1+, 817 tests |
| **Agent数量** | 1 (EchoAgent自身) | N (并行Worker) | N (多后端异构Agent) | N (PM/Architect/Dev/QA) |
| **记忆机制** | 4层分离 (cold→hot) | 文件系统 + CLAUDE.md | 4层进化 (Session→Template) | DB (SQLite) + .automater/ |

---

## 二、核心设计理念提炼

### 2.1 agent-memory: "上下文是缓存，文件是持久存储"

**最重要的三个洞察**:

1. **写保护机制** — 对话中途禁止写正式记忆，只写暂存区(scratchpad)，shutdown时审核合并
   - *AgentForge 对照*: 我们的 `react-loop.ts` 中 Developer Agent 可以直接写文件，无暂存/审核层。虽然场景不同（开发 vs 自我记忆），但"先暂存后合并"的模式可应用于 Agent 的经验积累

2. **分层经验体系** — Principles (≤10, 元认知) → Patterns (≤15, 领域模式) → Archived Instances (不限, 历史)
   - *AgentForge 对照*: 我们的 `memory-system.ts` 有 global/project/role 三层，但缺乏**容量限制**和**淘汰机制**。agent-memory 的 FIFO + 使用频率淘汰值得借鉴

3. **硬约束优于软约束** — "禁止..."格式 >> "建议..."格式。LLM 的 eager execution 倾向会跳过软约束
   - *AgentForge 对照*: 我们的 prompt 中大量使用"请注意..."、"建议..."式表述 → 应改为禁止/必须格式

**关键机制**:
- `session_scratchpad.json` — 宁可多存再去重，不漏存
- `conclusion_buffer.json` — 每次实质性问答后记录结论（FIFO 5条）
- `task_checkpoint.json` — 3+步骤任务的工作现场快照（覆盖式）
- 压缩恢复: `[CONTEXT COMPACTED]` → 重执行 Boot → HARD STOP 等用户确认

### 2.2 agent-swarm: "LLM 是记忆力为零但技能满点的轮班工人"

**最重要的三个洞察**:

1. **两层功能清单** — 索引层(feature_list.json, 调度用) + 详情层(features/{cat}/FXXX.json, 实现用)
   - *AgentForge 对照*: 我们的 features 表是单层的，PM 分析的 features 包含所有字段（title/description/acceptance_criteria/depends_on）。当 feature 数量 >50 时，传入 LLM 的 token 开销会很大。**应引入摘要层/索引层**

2. **Evaluator-Optimizer 模式** — Worker 自报完成 → Evaluator 独立验证 → 验证失败时生成诊断式 retry prompt
   - *AgentForge 对照*: 我们的 QA 角色(`qa-loop.ts`)做的是类似的事，但**缺少诊断式 retry prompt**。QA 失败后 Developer 重试时只知道"失败了"，不知道具体哪里失败、怎么修。应注入 QA 报告到 retry 上下文

3. **CLAUDE.md 5层结构 + Session Plan** — 每次会话开始时读取项目大脑，填写本次 Session Plan；结束时更新结果
   - *AgentForge 对照*: 我们的 Agent 没有"Session Plan"概念。每个 Developer Agent 启动后直接进入 React 循环，没有先规划再执行的步骤。agent-swarm 的 Session Planning（确定scope→估算复杂度→决定容量→列出需加载文件→判断是否分离）是非常精炼的实践

**关键机制**:
- `RFC 系统` — Worker 发现 feature 定义问题 → 创建 RFC → Orchestrator 审批/自动处理 → 结构化反馈通道
- `Feature Group` — 同质 features 批量锁定 → 共享上下文 → 一次性实现
- `CostTracker` — 持久化的 per-feature/per-agent/per-date 成本追踪 + 异常检测
- `HumanGate` — 文件级 HITL 审批门（不依赖 UI，文件创建即审批请求）

### 2.3 Actant: "把 Agent 当 Docker Container 管理"

**最重要的三个洞察**:

1. **Documentation-First 开发模式** — "文档、契约、接口、配置是项目的主要产出，代码是对它们的实现"
   - 强制流程: 需求→文档/规范→接口/类型→实现→测试→审查
   - 规范即真相: 代码与规范冲突时，修正代码不修正规范
   - *AgentForge 对照*: 我们的开发流程是 PM → Architect → Developer 流水线，但 Architect 生成的是设计文档而非**规范**（specification）。Actant 的 `spec/` 目录结构 (三层: Specification → Implementation Guidelines → Thinking Guides) 是更成熟的知识管理

2. **耐久测试规范 (Endurance Testing)** — 不是"跑得久的测试"，而是"反复走同一流程 N 次后是否正确"
   - 覆盖矩阵: 场景维度 × 验证不变量
   - `INV-DISK`: 磁盘状态与内存状态一致
   - `INV-CLEAN`: 已销毁资源无残留
   - `INV-COUNT`: 缓存计数准确
   - *AgentForge 对照*: 我们只有单元测试和 guards 测试，完全缺乏**不变量验证**和**状态一致性测试**。Agent 多轮循环后的状态漂移是真实风险

3. **四层记忆进化** — Session → Instance Memory → Shared Memory → Template Evolution
   - 基因-表观遗传类比: Template(基因)不变，Memory(表观遗传)在运行中积累
   - ContextBroker 替代 ContextMaterializer: 物化产物 = Template ∪ Memory
   - *AgentForge 对照*: 我们的 `context-collector.ts` 是纯函数式的 —— 每次收集上下文时没有"历史经验"参与。应引入 Memory Layer 让 Agent 积累跨 feature 的经验

**关键机制**:
- `.trellis/` 工程框架 — scripts/, spec/, workspace/, tasks/, issues/ 完整的工程脚手架
- `GitNexus MCP` — 代码知识图谱 (2091符号, 5354关系, 144执行流)，修改前必须 impact 分析
- `ComponentTypeHandler 注册模式` — 可扩展的组件类型系统
- `VersionedComponent` — 所有组件的公共信封: 版本号 + 来源追踪 + Breaking Change 检测
- `Heartbeat/Cron/Hook` 三种输入源 — 不只是用户触发，Agent 可以自主调度

---

## 三、AgentForge 差距矩阵

| # | 差距领域 | 参照系统 | 当前状态 | 影响 | 借鉴建议 |
|---|---------|---------|---------|------|---------|
| G1 | **Agent 记忆/经验积累** | memory + Actant | 无跨 feature 记忆 | Developer 重复犯错 | 引入 Instance Memory Layer |
| G2 | **上下文分层** | memory (L0/L1/L2) + Actant | 全量传入 | Token 浪费 | 三级上下文: 索引→摘要→详情 |
| G3 | **Session Planning** | swarm (worker-solo.md) | Agent 无规划直接干 | 上下文溢出/中断丢失 | 每轮 ReAct 前执行 Session Plan |
| G4 | **诊断式重试** | swarm (Evaluator) | QA 失败→盲目重试 | 重试成功率低 | 注入 QA 报告到 retry prompt |
| G5 | **Feature 摘要层** | swarm (两层清单) | 单层 features 表 | PM 上下文膨胀 | DB 加 summary 字段 |
| G6 | **耐久/不变量测试** | Actant (endurance) | 只有单元测试 | 状态漂移未检测 | 添加 Agent 循环不变量验证 |
| G7 | **硬约束 Prompt** | memory (P-07/L-016) | 大量软性表述 | Agent 不遵守指令 | 改为"禁止/必须"格式 |
| G8 | **文档驱动开发** | Actant (spec/) | 设计文档散落 | 知识不成体系 | 建立 spec/ 目录体系 |
| G9 | **工作现场快照** | memory (checkpoint) | 无中断恢复 | Agent 中断后上下文丢失 | 每步完成写 checkpoint |
| G10 | **成本追踪粒度** | swarm (CostTracker) | 仅 per-agent 统计 | 无法定位高成本 feature | 添加 per-feature 成本追踪 |

---

## 四、优先级研判与实施建议

### Sprint 1: 立即可做 (无架构变更, 1-2h)

| 编号 | 改动 | 对应差距 | 文件 | 工作量 |
|------|------|---------|------|--------|
| S1-1 | **Prompt 硬约束化** | G7 | `react-loop.ts` prompt 模板 | 30min |
| S1-2 | **QA 诊断注入** | G4 | `react-loop.ts` L286 retry 逻辑 | 30min |
| S1-3 | **Feature summary 字段** | G5 | `types.ts` + DB migration | 20min |

### Sprint 2: 近期改进 (小幅架构, 3-5h)

| 编号 | 改动 | 对应差距 | 文件 | 工作量 |
|------|------|---------|------|--------|
| S2-1 | **Agent 工作现场快照** | G9 | 新增 `checkpoint.ts` | 1.5h |
| S2-2 | **Per-feature 成本追踪** | G10 | `llm-client.ts` + `event-store.ts` | 1h |
| S2-3 | **Agent 循环不变量测试** | G6 | 新增 `__tests__/invariants.test.ts` | 2h |

### Sprint 3: 中期架构 (需设计文档, 5-10h)

| 编号 | 改动 | 对应差距 | 说明 | 工作量 |
|------|------|---------|------|--------|
| S3-1 | **Instance Memory Layer** | G1 | Agent 跨 feature 经验积累 | 5h |
| S3-2 | **三级上下文系统** | G2 | L0 索引 / L1 摘要 / L2 详情 | 3h |
| S3-3 | **Session Planning 阶段** | G3 | ReAct 循环前执行规划 | 2h |

### 不建议照搬的设计

| 设计 | 来源 | 不适用原因 |
|------|------|-----------|
| 文件级 HITL 审批门 | swarm | AgentForge 有 UI，应直接在 UI 中做 |
| CLAUDE.md 模板 | swarm | AgentForge 用 DB + .automater/ 替代 |
| ACP 协议 | Actant | AgentForge 是单机 Electron，不需要 Agent 间通信协议 |
| Component Source 系统 | Actant | AgentForge 不是平台，不需要组件市场 |
| Monorepo 包分离 | Actant | AgentForge 规模未到需要 monorepo 的阈段 |

---

## 五、最深层的认知收获

### 5.1 "记忆力为零但技能满点的轮班工人"

agent-swarm 的这个比喻是理解 LLM Agent 系统设计的钥匙。它意味着:
- **所有状态必须外化到文件系统/DB** — 不能依赖 context 记忆
- **每次启动都是全新的** — 必须有高效的 bootstrap 机制
- **技能通过 prompt/tools 注入** — 不是通过"学习"

AgentForge 已经在 DB 层做得不错（features 表、agents 表、agent_logs），但**缺少 Agent 认知层面的状态外化**。Developer Agent 在处理 Feature A 时积累的项目理解，在处理 Feature B 时完全丢失。

### 5.2 "规范 > 实现"

Actant 的 Documentation-First 不是形式主义。其核心逻辑是:
1. LLM Agent 写代码时，**prompt 就是规范**
2. 如果规范本身有缺陷，Agent 产出的代码必然有缺陷
3. 因此投入时间改进 prompt/spec 的 ROI >> 投入时间改进代码

对 AgentForge 的启示: 我们应该把 `react-loop.ts` 中的 prompt 模板视为**第一等公民**——投入与代码同等甚至更多的精力来维护和优化它们。

### 5.3 "上下文工程是 Job #1"

三个系统都在不同层面解决同一个问题: **如何在有限的 context window 中放入最高信息密度的内容**。

- agent-memory: boot 序列 ≤2000 tokens，按需加载技能全文
- agent-swarm: 两层清单，Worker 只读自己的 feature 详情
- Actant: L0/L1/L2 三级上下文，先给 Agent 索引再按需加载

AgentForge 的 `context-collector.ts` + `code-graph.ts` 已经是很好的基础设施。v7.0 的 `module-graph.json` 更是引入了结构化的项目理解。但我们缺少的是**跨 Agent 轮次的上下文传递策略** — 每个 Agent 每次都从零收集上下文，没有利用前一个 Agent（或前一轮自己）已经建立的理解。

---

## 六、总结

三个系统虽然定位不同，但在以下方面高度一致:
1. **文件系统是最可靠的跨会话记忆**
2. **硬约束 >> 软约束**
3. **上下文是最稀缺的资源，必须精打细算**
4. **测试/验证必须独立于 Agent 自我评估**
5. **结构化 > 自由文本**

AgentForge 已经具备了扎实的基础（DB、CodeGraph、ModuleGraph、Probe System），最大的差距在于**Agent 认知状态的外化与积累**（G1/G2/G3/G9），这正是三个参照系统最核心的设计关注点。
