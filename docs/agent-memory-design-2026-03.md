# Agent 工作记忆设计方案

> AutoMater v19.0 — 2026-03-02
> 目标：解决长任务执行时上下文压缩导致过程结论丢失的问题

---

## 一、问题诊断

### 1.1 当前压缩机制

AutoMater 的 react-loop 有三层压缩：

| 层级 | 触发条件 | 行为 | 信息损失 |
|------|----------|------|----------|
| **compressToolOutputs** | warning/critical/overflow | 截断旧工具输出到 500/200/100 字符 | **高** — 文件内容、搜索结果、测试输出被截断 |
| **compressMessageHistorySmart** | messages.length > 20-30 或 overflow | 用 LLM 摘要替换中间消息 | **高** — 关键决策、架构选型、Bug 修复细节可能丢失 |
| **compressMessageHistorySimple** | Smart 失败时兜底 | 截断旧 tool 内容到 200 字符 | **中高** — 保留结构但丢失细节 |

### 1.2 具体丢失场景

1. **建筑决策蒸发**：Agent 在第 5 轮决定使用 React Router v6，到第 25 轮压缩后，第 35 轮可能重新安装 v5
2. **Bug 修复循环**：Agent 在第 10 轮修了一个 null check，压缩后第 30 轮又写出同样的 bug
3. **文件状态失忆**：Agent 已经写了 `utils/auth.ts`，压缩后不知道，重新创建或覆盖
4. **Todo 列表丢失**：`todo_write` 存在内存中（`Map<string, TodoItem[]>`），但工具调用结果被压缩后 Agent 忘记自己有 todo，不再调 `todo_read`
5. **PM 分析断裂**：PM 读了多个外部文件的内容，压缩后只剩摘要，无法产出完整 Feature JSON

### 1.3 核心矛盾

- Agent 的**工具输出**（file 内容、搜索结果）占上下文的 ~84%（JetBrains 论文数据）
- 但 Agent 的**决策记录**（我做了什么、为什么这么做）只占 ~5%
- 当前压缩**无差别截断一切**，没有区分"可丢弃的工具输出"和"不可丢弃的决策记录"

---

## 二、业界最佳实践调研

### 2.1 Anthropic — Context Engineering for AI Agents (Sep 2025)

**核心观点**：

1. **Compaction（压缩）**：保留架构决策、未解决 bug、实现细节，丢弃冗余工具输出。Claude Code 压缩时保留最近 5 个访问过的文件
2. **Structured Note-Taking（结构化笔记）**：Agent 定期将笔记写入上下文窗口外的持久存储，重置后读回
3. **Sub-Agent 架构**：将长任务拆分给子代理，每个子代理在独立窗口中工作，父代理只接收结论
4. **Tool Result Clearing**：最安全的轻量压缩 — 清除旧的工具调用原始结果（因为已经处理过了）

> "The art of compaction lies in the selection of what to keep versus what to discard"

### 2.2 Anthropic — Effective Harnesses for Long-Running Agents (Nov 2025)

**核心发现**：

1. **claude-progress.txt**：每个 Agent 会话结束时写一个进度文件，下次启动读取
2. **Feature List File**：结构化 JSON 跟踪所有 Feature 的完成状态
3. **Git History**：用 `git log` + `git diff` 快速恢复上下文
4. **Incremental Progress**：每次只做一个 Feature，做完提交，保证干净状态
5. **Init → Work → Checkpoint 循环**：每个 session 开始时读进度 → 做一步 → 写 checkpoint

**Agent 失败模式表**：

| 问题 | 解决方案 |
|------|----------|
| 过早宣布完成 | Feature List 文件强制逐项验证 |
| 留下 bug/未文档化进度 | 每轮结束写 git commit + progress |
| 未充分测试就标记完成 | 启动时先跑基础测试确认无回归 |

### 2.3 JetBrains Research — Observation Masking vs LLM Summarization (Dec 2025, NeurIPS)

**关键发现**：

1. **Observation Masking**（隐藏旧观测，保留推理+动作）比 **LLM Summarization**（摘要一切）**更高效且等效精度**
2. Observation tokens 占 Agent 单轮的 ~84%
3. 保留推理链和动作记录、只压缩工具输出 → 成本降 50%+ 且不损失性能
4. **混合方案最优**：Observation Masking + 关键节点 LLM Summary

### 2.4 OpenAI Agents SDK — Session Memory (Sep 2025)

**两种策略**：

1. **Context Trimming**：保留最近 N 轮，直接丢弃旧轮。简单但会丢长距离依赖
2. **Context Summarization**：定期生成结构化摘要注入历史。保留长期记忆但有失真风险

**核心洞察**：**两种策略应该组合使用** — 近期保持 Trimming 的精确度，远期用 Summary 保留骨架

### 2.5 OpenHands — Context Condensation

**分层架构**：
1. **RecentEventsCondenser**：保留最近 N 条事件原文
2. **LLMSummarizingCondenser**：用 LLM 摘要旧事件
3. **AmortizedForgettingCondenser**：渐进式遗忘，越旧的事件越可能被丢弃
4. 所有压缩结果存为 `CondensationEvent`，可追溯

---

## 三、设计方案：Agent Scratchpad + Observation Masking 混合架构

### 3.1 核心思路

```
┌─────────────────────────────────────────────────────┐
│                  Agent Context Window                 │
│                                                       │
│  [System Prompt]                                      │
│  [Scratchpad — 始终注入，不被压缩]  ← 新增核心       │
│    ├── 任务目标 & 当前进度                             │
│    ├── 关键决策记录                                    │
│    ├── 已创建/修改的文件清单                           │
│    ├── 已知问题 & 待办事项                             │
│    └── 上次压缩时的状态快照                            │
│  [最近 N 轮完整消息]                                  │
│  [旧轮次 — Observation Masking]                       │
│    ├── 保留: Agent 思考 + 工具调用名称+参数            │
│    └── 隐藏: 工具输出原文 → 替换为摘要占位符          │
└─────────────────────────────────────────────────────┘
```

### 3.2 Scratchpad 设计

**存储位置**：内存中的 `Map<string, AgentScratchpad>`（与 todoWrite 同级），压缩时不会被清除

**数据结构**：

```typescript
interface AgentScratchpad {
  /** 当前任务目标 (来自 feature 描述) */
  objective: string;
  /** 当前进度摘要 (Agent 每 5 轮自动更新) */
  progressSummary: string;
  /** 关键决策 (Agent 主动记录，最多 20 条) */
  decisions: Array<{
    iteration: number;
    decision: string;
  }>;
  /** 已创建/修改的文件列表 (自动从 write_file/edit_file 收集) */
  filesChanged: string[];
  /** 发现的问题/待修复 (Agent 主动记录) */
  issues: string[];
  /** 上次更新的迭代轮次 */
  lastUpdatedAt: number;
}
```

**注入时机**：每次调用 LLM 前，将 Scratchpad 渲染为文本插入到 system prompt 末尾（或作为第一条 user 消息）

**更新机制**：

| 触发 | 行为 |
|------|------|
| Agent 调用 `write_file`/`edit_file` | 自动追加 `filesChanged` |
| Agent 调用 `todo_write` | 自动同步到 Scratchpad 的 issues 字段 |
| **每 5 轮迭代** | 自动要求 Agent 调用 `scratchpad_update` 工具更新 progressSummary |
| **压缩发生前** | 自动生成一次快照作为压缩后的 anchor |
| Agent 主动调用 `scratchpad_note` | 添加关键决策记录 |

### 3.3 Observation Masking 改进

**替代当前的暴力截断**：

```
旧方案: tool 输出 "文件内容..." 3000字 → 截断到 200字 + "... [已压缩]"
新方案: tool 输出 → 替换为结构化摘要:
  "[read_file] src/App.tsx (350行, TypeScript React 组件, 包含路由配置和主布局)"
  "[run_command] npm test → 12 passed, 0 failed, 覆盖率 87%"
  "[code_search] 'useState' → 找到 15 处匹配, 主要在 pages/ 和 components/"
```

**保留的信息**：
- Agent 的思考文本（`msg.content` where `role === 'assistant'`）
- 工具调用名称和参数（`tool_calls` 数组）
- 工具结果的**结构化摘要**（而非原文）

**丢弃的信息**：
- 工具输出原文（文件内容、命令输出、搜索结果）

### 3.4 新增工具

| 工具 | 描述 | 何时使用 |
|------|------|----------|
| `scratchpad_update` | 更新工作记忆（进度摘要、关键决策、问题列表） | 每完成一个子步骤 / 压缩前自动触发 |
| `scratchpad_read` | 读取当前工作记忆 | 压缩后自动注入 / Agent 主动查看 |

注意：**不新增工具**，而是将 Scratchpad 作为**自动机制**集成到 react-loop 中：
1. 自动收集文件变更
2. 定期（每 N 轮）提示 Agent 用 `todo_write` 更新进度
3. 压缩时自动生成 scratchpad 快照并注入到压缩后的上下文

### 3.5 压缩流程（改进后）

```
1. 检测到需要压缩 (token budget > threshold)
   │
2. 生成 Scratchpad 快照
   │  - 收集当前 todo_read 结果
   │  - 收集 filesChanged 列表
   │  - 用 LLM 生成 progressSummary (如果最近 5 轮没更新过)
   │
3. Observation Masking
   │  - 旧轮次的工具输出 → 替换为结构化单行摘要
   │  - 保留 Agent 思考和工具调用签名
   │
4. 如果还不够 → LLM Summarization
   │  - 对 masked 后的旧消息做 LLM 摘要
   │  - 生成的摘要作为 user 消息注入
   │
5. 注入 Scratchpad 作为锚点
   │  - 在摘要消息之后、最近消息之前
   │  - 格式: "## 工作记忆快照 (第 N 轮)\n..."
   │
6. sanitizeToolPairs() 清理孤立消息
```

---

## 四、实施计划

### Phase 1: Scratchpad 核心（本次实现）

1. `extended-tools.ts` 新增 `AgentScratchpad` 接口和 `scratchpadUpdate`/`scratchpadRead`/`scratchpadSnapshot` 函数
2. `react-loop.ts` 的 `reactDeveloperLoop` 和 `reactAgentLoop` 中：
   - 自动收集 `filesChanged`
   - 压缩前调用 `scratchpadSnapshot` 生成快照
   - 压缩后将快照注入为 system 消息的一部分
3. `compressMessageHistorySmart` 改进：先 Observation Mask 再 LLM Summarize

### Phase 2: Observation Masking（本次实现）

1. `tool-result-summarizer.ts` 增强：为每种工具类型生成结构化单行摘要
2. `compressToolOutputs` 重写：使用 Observation Masking 替代暴力截断

### Phase 3: 自动进度提醒（后续）

1. 每 N 轮自动注入 "请用 todo_write 更新你的进度" 提示
2. Agent 如果连续 3 轮不更新 todo → 系统自动从最近轮次提取更新

---

## 五、预期效果

| 指标 | 当前 | 改进后 |
|------|------|--------|
| 关键决策存活率 | ~30% (压缩后) | ~95% (Scratchpad 锚定) |
| 文件变更追踪 | 0% (全靠记忆) | 100% (自动收集) |
| Bug 修复循环率 | 高 | 低 (决策记录防重复) |
| 压缩后恢复时间 | 3-5 轮摸索 | 0 轮 (直接读 Scratchpad) |
| Token 成本 | 基准 | -30~50% (Observation Masking) |

---

## 参考文献

1. [Anthropic — Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (Sep 2025)
2. [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (Nov 2025)
3. [Anthropic — Automatic Context Compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)
4. [JetBrains Research — The Complexity Trap: Simple Observation Masking vs LLM Summarization](https://arxiv.org/pdf/2508.21433) (NeurIPS 2025)
5. [OpenAI — Context Engineering with Session Memory](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory/)
6. [OpenHands — Context Condensation for More Efficient AI Agents](https://openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents)
