# AgentForge 并行架构迭代构想报告

> 撰写日期: 2026-03-02
> 触发: 外部「进程-线程」架构映射讨论的批判性分析
> 适用对象: AgentForge (智械母机) v6.0+ 并行编排系统

---

## 零、报告定位

本报告对一段将操作系统「进程/线程」概念映射到多Agent平台架构的讨论进行**批判性分析**，识别其中可吸取的合理理念与需警惕的过度类比，然后结合AgentForge的**实际代码现状**和**已有设计决策**，提出具体的架构迭代构想。

**核心立场**：取其精华（隔离/分层/故障域思维），弃其过度工程化倾向（不盲目套用OS内核模型），一切以AgentForge的Electron桌面应用实际约束为准。

---

## 一、对原始讨论的批判性分析

### 1.1 讨论概述

原始讨论将操作系统的进程/线程二元模型映射到多Agent平台设计，核心主张是**「进程做隔离、线程做并行」**：

- **进程级**：核心Agent模块隔离、项目模块工作空间隔离、高危操作沙箱隔离
- **线程级**：单Feature内子任务并行（语法生成/注释/异常处理/测试）、代码审查多维度并行、UI事件响应
- **混合架构**：参照OS内核-进程-线程调度模型，搭建主控中枢+进程池+线程池

### 1.2 可吸取的合理理念 ✅

| # | 理念 | 合理性分析 | AgentForge现状对标 |
|---|------|-----------|-------------------|
| A1 | **故障域隔离** — 单Agent崩溃不影响其他Agent | 这是工程常识。Agent调用LLM时的超时/解析错误/API限流确实不应导致整个编排器崩溃 | ✅ 已有：`NonRetryableError` + Circuit Breaker + 每个Worker独立try-catch。❌ 不足：workerLoop异常仍在同一Node.js事件循环中，无真正的进程级隔离 |
| A2 | **上下文隔离** — 避免不同Agent的上下文互相污染 | 这是LLM Agent最关键的设计约束。Agent间共享过多上下文会导致指令冲突和角色越界 | ✅ 已有：每个Agent有独立的systemPrompt、独立的消息历史、独立的token统计。✅ ReAct循环内的消息压缩也是一种上下文隔离 |
| A3 | **成本分层管控** — 按Agent/模块精准统计token消耗 | 对10万行项目的成本可见性至关重要 | ✅ 已有：`updateAgentStats()`按Agent独立统计、`checkBudget()`全局预算防护、3层模型选择(strong/worker/fast)控制成本 |
| A4 | **项目模块化工作空间** — 大项目拆分为独立模块分别开发 | 解决上下文膨胀的正确方向。10万行代码不可能塞进单个上下文 | ⚠️ 部分实现：Feature两层索引(group_id)、分层摘要金字塔(project-importer)。❌ 不足：同项目内Feature共享同一工作空间目录 |
| A5 | **子任务并行** — 单Feature内低耦合子任务同时执行 | 理论上合理，可大幅提升单Feature开发速度 | ❌ 未实现：当前每个Feature的ReAct循环是完全串行的（plan→implement→test→fix） |
| A6 | **高危操作沙箱** — 代码执行、依赖安装在隔离环境运行 | 安全性基本要求 | ⚠️ 部分实现：`sandbox-executor.ts`有命令黑名单+环境隔离，但仍是子进程级而非容器级 |

### 1.3 需要警惕的过度类比 ⚠️

| # | 原始主张 | 批判分析 |
|---|---------|---------|
| B1 | **每个核心Agent都应该是独立进程** | ❌ 过度工程化。在Electron桌面应用中，为PM/Architect/Dev/QA各起一个Node.js子进程，引入的IPC通信成本远大于收益。当前AgentForge的Agent是"逻辑角色"而非"系统进程"——它们是同一事件循环中的不同函数调用链，各自维护独立的上下文状态。这种"伪并行"在单机桌面应用中是最合理的。真正需要隔离的只有**代码执行沙箱**（已有sandbox-executor）。 |
| B2 | **参照OS内核模型搭建主控中枢** | ❌ 架构航天飞机。AgentForge的编排器(`orchestrator.ts`)已经是事实上的"调度内核"，不需要额外引入进程表、线程池、IPC消息队列等OS抽象层。这些概念在用户规模为数千（非数十万并发）的桌面应用中毫无必要。 |
| B3 | **注释生成子Agent、异常处理子Agent、接口文档子Agent** | ❌ 粒度过细。将代码生成拆分为5个子Agent并行执行，在实践中会导致：①合并冲突（5个Agent同时写同一个文件的不同部分）；②上下文碎片化（每个子Agent只看到部分需求）；③LLM调用次数暴增（5次API调用的总token可能超过1次完整生成）。2026年最佳实践是让单个Developer Agent在ReAct循环中一体化完成代码生成。 |
| B4 | **语法规范审查、安全漏洞审查、性能优化审查、业务逻辑审查并行** | ⚠️ 有限度合理。QA多维度并行审查在理论上可行，但AgentForge已有的`qa-loop.ts`设计（程序化检查+LLM审查+硬规则评分）比"起4个子Agent分别审查"更高效——一次LLM调用中包含多维度审查prompt，比4次独立调用节省75%的上下文重复token。 |
| B5 | **进程间IPC消息队列通信** | ❌ 不适用。AgentForge是单进程Electron应用（better-sqlite3同步API设计决策ADR-004明确了这一点）。Agent间通过SQLite表（features/agents/agent_logs）和内存Map（runningOrchestrators/hotJoinContexts）通信，比IPC消息队列简单10倍且无序列化开销。 |
| B6 | **资源分层管控：进程级分配全局资源，线程级仅能使用所属进程的资源** | ⚠️ 方向正确但映射过度。AgentForge已有`checkBudget()`全局预算防护和per-agent token统计，但不需要OS风格的"资源配额+调度策略"。LLM Agent的核心资源是token和API并发数，不是CPU/内存。 |

### 1.4 本质诊断

原始讨论的核心问题是**将基础设施层的OS概念直接映射到应用层的Agent编排**，忽略了两个关键差异：

1. **Agent ≠ 进程**。OS进程是系统调度的基本单位，拥有独立地址空间；Agent是逻辑角色，本质是prompt+工具+上下文状态。Agent的"隔离"不需要内存地址空间隔离，只需要**上下文隔离**（每个Agent有自己的消息历史和system prompt）。

2. **LLM调用 ≠ CPU计算**。线程并行的价值在于利用多CPU核心。但LLM Agent的瓶颈是API请求延迟和token成本，不是CPU。Agent"并行"的真正收益是**同时发出多个API请求**（I/O并行），而非"多线程利用多核"。

---

## 二、AgentForge 并行架构现状诊断

### 2.1 当前并行模型

```
orchestrator.ts: runOrchestrator()
│
├── Phase 1-3: 串行 (PM → Architect → Docs)
│   └── 合理：有严格的数据依赖关系
│
├── Phase 4: Worker 并行 ← 核心并行点
│   ├── Promise.all([workerLoop(dev-1), workerLoop(dev-2), ...])
│   ├── 每个 Worker 独立领取 Feature (SQLite原子锁)
│   ├── 热加入支持 (v9.0: 运行中动态添加Worker)
│   └── 文件冲突检测 (decision-log.ts: 声明式claim/release)
│
└── Phase 5: 串行收尾
```

**并行粒度**：Feature级。每个Worker处理整个Feature（plan → implement → test → fix → QA review），多个Worker并行处理不同Feature。

### 2.2 现有并行机制的优势

| 机制 | 代码位置 | 评价 |
|------|---------|------|
| SQLite原子锁定 | `lockNextFeature()` | ✅ 利用better-sqlite3同步API的天然原子性，无JS层竞态 |
| AbortController统一停止 | `registerOrchestrator()` | ✅ 所有Worker共享一个abort信号，一键停止 |
| 文件冲突声明式检测 | `decision-log.ts` | ⚠️ 尽力而为，无强制互斥 |
| Group亲和性调度 | `lockNextFeature()` | ✅ 同group的Feature倾向分配给同一Worker，减少上下文切换 |
| 热加入 | `HotJoinContext` | ✅ 支持运行中动态添加Developer Worker |
| 预算防护 | `checkBudget()` | ✅ 每个Worker每轮检查，超预算自动停止 |

### 2.3 当前并行的痛点

| 痛点 | 严重度 | 详情 |
|------|--------|------|
| P1: 文件冲突无强制锁 | 🟡 中 | `predictAffectedFiles`基于启发式，实际文件操作无互斥锁。两个Worker同时`write_file`同一文件时后者覆盖前者 |
| P2: Feature内部完全串行 | 🟡 中 | 单Feature的ReAct循环内所有步骤串行执行，不能并行（如同时生成代码和测试骨架） |
| P3: Phase 1-3串行瓶颈 | 🟢 低 | PM/Architect阶段有严格数据依赖，串行是正确选择，但docs生成(Phase 3)的批次间可以并行 |
| P4: 无Worker间上下文共享 | 🟡 中 | Worker-2完成了一个共享工具函数，Worker-1不知道可以复用，可能重复实现 |
| P5: QA审查串行瓶颈 | 🟢 低 | 每个Feature的QA审查独占QA Agent，其他Feature等待 |

---

## 三、架构迭代构想

基于上述分析，提出以下**递增式**改进方案。严格遵循AgentForge的设计原则：单体Electron架构（ADR-003）、better-sqlite3同步API（ADR-004）、Token成本优先。

### 3.1 构想 A：文件级写锁 — 从声明式升级为强制锁 [推荐, Sprint 级]

**动机**：解决P1。当前`decision-log.ts`是"君子协定"——冲突只报告不阻止。

**设计**：

```typescript
// file-lock.ts — 进程内内存锁 (无需跨进程)
const fileLocks = new Map<string, { workerId: string; featureId: string; lockedAt: number }>();

export function acquireFileLock(
  filePath: string, workerId: string, featureId: string
): { acquired: boolean; holder?: string } {
  const normalized = path.resolve(filePath);
  const existing = fileLocks.get(normalized);
  if (existing && existing.workerId !== workerId) {
    return { acquired: false, holder: existing.workerId };
  }
  fileLocks.set(normalized, { workerId, featureId, lockedAt: Date.now() });
  return { acquired: true };
}

export function releaseFeatureLocks(workerId: string, featureId: string): void {
  for (const [path, lock] of fileLocks) {
    if (lock.workerId === workerId && lock.featureId === featureId) {
      fileLocks.delete(path);
    }
  }
}

// 超时自动释放 (防僵尸锁)
export function cleanExpiredLocks(maxAgeMs: number = 300_000): number { ... }
```

**集成点**：在`tool-executor.ts`的`write_file`/`edit_file`执行前调用`acquireFileLock()`，失败时返回工具错误让ReAct循环自动重试或跳过。

**Token成本**：零额外LLM调用。仅增加内存Map查询。

**风险**：死锁（两个Worker互等）→ 通过超时自动释放兜底。

### 3.2 构想 B：Phase 3 批次间并行 [推荐, Sprint 级]

**动机**：解决P3。当前`phaseReqsAndTestSpecs()`的批次间是串行的（for循环），但批次间无数据依赖。

**设计**：

```typescript
// 当前 (串行)
for (let bi = 0; bi < batches.length; bi++) {
  await generateReqs(batches[bi]);
  await generateTestSpecs(batches[bi]);
}

// 改进后 (批次间并行, 控制并发数)
const PARALLEL_BATCHES = Math.min(3, batches.length);
const batchQueue = [...batches.entries()];

async function processBatch(bi: number, batch: ParsedFeature[]) {
  await generateReqs(batch);
  await generateTestSpecs(batch);
}

// 使用Promise池控制并发
await promisePool(batchQueue, PARALLEL_BATCHES, ([bi, batch]) => processBatch(bi, batch));
```

**Token成本**：总token不变，但执行时间缩短 ~60%（3个批次同时调LLM API）。

**风险**：LLM API并发限流 → 通过`PARALLEL_BATCHES`参数控制，默认3。

### 3.3 构想 C：QA 并行审查池 [中期, 2 Sprint]

**动机**：解决P5。当前所有Worker共享一个QA Agent实例(qaId)，Feature审查排队。

**设计**：

```
当前:  Worker-1 ─→ [QA审查F001] ─→ Worker-2 ─→ [QA审查F002]  (串行)
改进:  Worker-1 ─→ [QA-1审查F001] ─┐
       Worker-2 ─→ [QA-2审查F002] ─┤  (并行)
       Worker-3 等待...             ┘
```

QA Agent不需要独立"进程"，只需要独立的消息历史和Agent ID。每个Worker在需要QA时spawn一个轻量QA实例：

```typescript
// workerLoop 内
const localQaId = `qa-${workerId}-${Date.now().toString(36)}`;
spawnAgent(projectId, localQaId, 'qa', win);
const qaResult = await runQAReview(settings, signal, feature, filesWritten, workspacePath, projectId, localQaId);
// QA完成后不需要保留实例
```

**Token成本**：每个QA实例独立调LLM，总token不变（因为审查的Feature数不变）。但消除了排队等待时间。

**风险**：QA实例数爆炸 → 通过设置上限（最多3个并发QA）。

### 3.4 构想 D：Worker间成果广播 [中期, 2 Sprint]

**动机**：解决P4。Worker-2创建了`utils/helpers.ts`，Worker-1不知道可以import。

**设计**：利用已有的`decision-log.ts`扩展，添加"成果广播"机制：

```typescript
// decision-log.ts 扩展
interface WorkerBroadcast {
  workerId: string;
  featureId: string;
  type: 'file_created' | 'function_exported' | 'module_added';
  detail: string;  // 如 "utils/helpers.ts: export function formatDate()"
  timestamp: number;
}

const broadcasts: WorkerBroadcast[] = [];

export function broadcastAchievement(b: WorkerBroadcast): void { ... }
export function getRecentBroadcasts(sinceMs?: number): WorkerBroadcast[] { ... }
```

在Worker开始新Feature时，将近期广播注入到Developer的上下文中：

```typescript
// workerLoop 内, 在 reactDeveloperLoop 之前
const recentWork = getRecentBroadcasts(600_000); // 最近10分钟
if (recentWork.length > 0) {
  feature._teamContext = `其他开发者最近的工作成果:\n${
    recentWork.map(b => `- ${b.workerId}: ${b.detail}`).join('\n')
  }\n可以直接import使用这些模块。`;
}
```

**Token成本**：每个Feature额外~200 tokens的上下文注入。换取避免重复实现（节省大量ReAct循环token）。

### 3.5 构想 E：Feature内子任务并行（谨慎，长期）[探索性]

**动机**：解决P2。将单Feature的ReAct循环内部进行有限并行。

**⚠️ 这是原始讨论中最诱人但最危险的想法。** 不建议按原始讨论的"5个子Agent并行"方案，而是做有限度的**两阶段并行**：

```
Stage 1 (串行): Developer ReAct → 完成主体代码
Stage 2 (并行): 
  ├── QA 审查 (读已完成代码)
  ├── 单测骨架生成 (读已完成代码)  
  └── 文档注释补全 (读已完成代码)
```

关键约束：Stage 2的所有任务都是**只读+追加**，不修改Stage 1产出的主体代码。

```typescript
// workerLoop 内, Developer完成后
const [qaResult, testResult, docResult] = await Promise.all([
  runQAReview(settings, signal, feature, filesWritten, workspacePath, projectId),
  generateTestSkeleton(settings, signal, feature, workspacePath, projectId),  // 已有
  generateDocComments(settings, signal, feature, filesWritten, workspacePath),  // 新增
]);
```

**Token成本**：3次并行LLM调用，但总token约等于串行（因为审查的代码量相同）。执行时间缩短~50%。

**风险**：
- 单测骨架可能与QA审查发现的问题冲突 → 如果QA不通过，丢弃单测和文档注释
- API并发限流 → 可降级为串行

**暂不推荐立即实施**，理由：AgentForge当前的TDD模式（QA先生成测试骨架→Developer围绕测试编码）与此冲突。需要更多实际数据验证收益。

### 3.6 构想 F：项目模块工作空间隔离（长期）[方向性]

**动机**：对应A4。解决10万行项目的上下文膨胀根本问题。

这是原始讨论中**最有价值的长期理念**，但实施方式完全不同于"OS进程级工作空间"：

**AgentForge适配设计**：

```
大项目工作空间/
├── ARCHITECTURE.md          # 全局架构文档 (Hot Memory)
├── module-a/                # 模块A — Worker-1的"视野"
│   ├── .automater/
│   │   └── module-context.md  # 模块级上下文 (~2K tokens)
│   ├── src/
│   └── tests/
├── module-b/                # 模块B — Worker-2的"视野"
│   ├── .automater/
│   │   └── module-context.md
│   └── ...
└── shared/                  # 共享模块 — 所有Worker可读
    ├── types/
    └── utils/
```

每个Worker在ReAct循环中，`context-collector.ts`只收集**当前模块+共享模块**的代码上下文，而非全项目。这实现了**逻辑隔离而非物理隔离**——不需要OS进程级的地址空间隔离，只需要上下文收集策略的调整。

**与现有架构的兼容性**：
- 利用已有的`group_id`两层索引：每个group对应一个模块
- 利用已有的`context-collector.ts`的预算控制：添加模块过滤规则
- 利用已有的`project-importer.ts`的模块划分：Phase 0已能识别模块边界

**Token节省估算**：10万行项目，10个模块，每个模块~1万行。Worker上下文从~200K tokens降至~20K tokens（10倍），直接降低90%的单次输入token成本。

---

## 四、优先级排序与实施建议

| 优先级 | 构想 | 预期收益 | 实施成本 | 依赖 |
|--------|------|---------|---------|------|
| P0 | A: 文件级写锁 | 消除Worker文件覆盖bug | 1天 | 无 |
| P0 | B: Phase 3批次间并行 | 文档生成提速60% | 0.5天 | 无 |
| P1 | C: QA并行审查池 | 消除QA串行瓶颈 | 2天 | 无 |
| P1 | D: Worker间成果广播 | 减少重复实现 | 1天 | 无 |
| P2 | E: Feature内子任务并行 | 单Feature提速50% | 3天 | 需评估与TDD模式的兼容性 |
| P3 | F: 模块工作空间隔离 | 10万行项目可行性 | 1-2 Sprint | 依赖project-importer的模块划分 |

### 实施原则

1. **增量引入，逐步验证**。每个构想独立commit，不耦合。
2. **零额外进程**。所有改进在Electron主进程的Node.js事件循环内完成，通过Promise并行实现I/O并行，不引入子进程/Worker Thread。
3. **向后兼容**。单Worker模式（workerCount=1）下行为不变。
4. **成本中性或降低**。并行优化的目标是减少等待时间，不增加总token消耗。
5. **可观测性优先**。每个并行改进都必须在UI日志中清晰可见（哪些任务在并行执行，是否有锁等待）。

---

## 五、对原始讨论的总结性评价

### 5.1 值得吸收的思维框架

| 理念 | 转化为AgentForge语言 |
|------|---------------------|
| "进程做隔离" | **Agent角色隔离**：每个Agent维护独立的上下文/消息历史/成本统计，通过SQLite表而非共享内存通信 |
| "线程做并行" | **Promise.all做并行**：同进程内多个async函数并行执行（Worker并行、批次并行、QA并行），共享Node.js事件循环 |
| "故障分级兜底" | **Error分级处理**：`NonRetryableError`→停止Worker，普通错误→重试，QA失败→重做Feature |
| "资源分层管控" | **Token分层预算**：全局`dailyBudgetUsd` + per-Agent统计 + 3层模型选择(strong/worker/fast) |
| "通信机制适配" | **SQLite做持久通信，内存Map做临时通信**：features表做任务队列，runningOrchestrators做运行注册表 |

### 5.2 不应采纳的建议

| 原始建议 | 拒绝理由 |
|---------|---------|
| 为每个Agent起独立进程 | 违反ADR-003(单体架构)和ADR-004(同步SQLite)。IPC开销远大于收益 |
| 搭建OS风格的内核+进程表+线程池 | 架构航天飞机。桌面应用不需要这种复杂度 |
| 5个子Agent并行生成代码的不同方面 | 粒度过细，合并成本极高，LLM调用次数暴增 |
| 进程间IPC消息队列 | Electron+better-sqlite3已是最优通信方案 |
| 守护进程+全平台故障自愈 | 桌面应用用Electron的app.on('render-process-gone')即可，不需要守护进程 |

### 5.3 一句话总结

> **AgentForge的"并行"本质是I/O并行（多个LLM API请求同时进行），而非CPU并行（多核利用）。正确的架构不是模仿OS内核，而是用Promise.all + SQLite原子操作 + 内存Map，在单进程内实现最大化的异步并发。**

---

## 六、与已有架构文档的关系

- 本报告是 `docs/architecture-optimization-analysis.md` (v5优化) 的**并行维度补充**
- 构想A-D可纳入下一个Sprint的技术改进
- 构想E-F属于中长期方向，建议记入`CLAUDE.md`的"已知差距"或"长期方向"
- 所有构想需在黑盒测试体系(`BLACKBOX_TEST_PLAN.md`)中补充对应的测试场景

---

*报告完毕。如需对任何构想进行详细技术设计，请指定。*
