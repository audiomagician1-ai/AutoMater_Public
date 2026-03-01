# AutoMater v0.9.0 — 全面复盘 + 业界对标差距分析

> 2026-03-01 · 基于 Devin/Cognition, OpenHands/CodeAct, Factory Droids, Claude Code, SWE-agent, Aider, Cursor Agent, Windsurf Cascade 等最前沿架构对标

---

## 一、当前架构复盘

### 1.1 做对了什么

| 维度 | AutoMater 现状 | 评价 |
|---|---|---|
| **4 阶段流水线** | PM → Architect → Developer → QA | ✅ 合理，与 Factory Missions 类似 |
| **ReAct 工具循环** (v0.9) | 25 轮上限，11 工具，思考→行动→观察 | ✅ 与 Claude Code / OpenHands CodeAct 一致 |
| **双协议 function-calling** | 同时支持 OpenAI tools + Anthropic tool_use | ✅ 差异化优势 |
| **预算防护** | 每轮检查，8 模型定价表 | ✅ 实用 |
| **Git 自动化** | 每个 feature 过 QA 后自动 commit | ✅ 与 Factory / Devin 一致 |
| **QA 审查循环** | 最多 3 轮 dev→QA 迭代 | ✅ 闭环 |
| **Planner** (v0.9) | 开发前制定 3-8 步计划 | ✅ 与 Claude Code TODO 模式一致 |
| **兼容模式** | 仍支持旧 <<<FILE>>> 输出 | ✅ 鲁棒性 |

### 1.2 架构级缺陷（按严重度排序）

#### 🔴 P0: 上下文工程（Context Engineering）严重不足

**Cognition (Devin) 的核心观点**: "Context engineering 是 #1 job"。Agent 的每个 action 都必须看到所有相关决策的上下文，否则出现 conflicting decisions。

**AutoMater 问题:**
- Developer ReAct 循环初始只注入一次上下文 (`collectDeveloperContext`)，之后依赖 LLM 自行通过工具获取
- 没有 **Repository Map**（Aider 的核心武器：AST 解析 → 函数签名/class 结构索引，不烧 token）
- 没有 **语义搜索**（当前只有关键词匹配 + findstr grep）
- 没有 **上下文压缩 Summarizer**（Cognition 推荐的"长对话 → 专用模型压缩历史"模式，我们只有简单截断）
- 并行 Worker 之间**完全没有上下文共享**（Worker A 写了接口，Worker B 不知道 → Cognition 说的"conflicting implicit decisions"）

**Factory 的 Context Stack 方案：**
1. Language-aware code graph（AST + call graph + import graph）
2. Multi-hop graph traversal（不是向量检索，而是沿着 import/call 链走）
3. 分层：Task → Tools → Developer Persona → Code → Semantic Structure → Historical Context → Collaborative Context

#### 🔴 P0: 没有 Sandbox（代码执行隔离）

**OpenHands 的核心**：Docker sandbox + REST API 执行，Agent 在沙箱里跑代码、跑测试、看报错。
**SWE-agent 的核心**：Agent-Computer Interface (ACI) — 让 Agent 在一个真实终端里操作。
**Claude Code**：直接有 bash 工具，用户机器上执行。

**AutoMater 问题:**
- `run_command` 直接 `execSync` 在用户主机上，30 秒超时，无隔离
- 不能跑长时间进程（dev server, docker build）
- 没有 PTY（交互式命令不支持）
- 没有进程隔离 → 安全风险

#### 🟠 P1: 记忆系统缺失

**Factory 的 3 层记忆架构：**
1. **Personal Memory** (`~/.factory/memories.md`) — 跟用户走，跨项目
   - 偏好（coding style, commit message convention, 语言）
   - 工具链（常用命令、环境变量）
2. **Project Memory** (`.factory/memories.md`) — 跟项目走
   - 架构决策记录（ADR）
   - 踩过的坑、特殊处理
3. **Rules & Conventions** (`.factory/rules/`) — 编码规范、review 标准

**Claude Code 的做法：** `CLAUDE.md` 文件 — 单文件项目脑，包含项目规范、常见命令、注意事项。每次对话自动读取。

**AutoMater 问题:**
- 有 `ARCHITECTURE.md` 但只在初始化时由 Architect 生成一次，之后不更新
- 没有 per-agent 记忆（QA 上一轮发现的通用问题，Dev 的编码偏好）
- 没有 project-level 经验积累（"这个项目用 Prisma 不用 TypeORM"、"路由文件在 src/routes/"）
- 没有 cross-project 经验迁移（"TypeScript 项目一般需要先 tsconfig.json"）

#### 🟠 P1: 并行 Worker 之间缺乏协调

**Cognition 的建议**：要么串行（简单安全），要么并行但每个 agent 看到所有其他 agent 的决策。

**AutoMater 问题:**
- 多个 dev worker 并行，但只通过 SQLite 的 `lockNextFeature` 做任务锁定
- Worker A 不知道 Worker B 正在创建什么文件、定义什么接口
- 没有共享的"进行中决策板"
- 可能产出互相冲突的代码（比如两个 worker 都创建了 `src/utils/helpers.ts`）

#### 🟠 P1: ACI（Agent-Computer Interface）设计粗糙

**SWE-agent 论文的核心发现**：ACI 的设计比 LLM 本身更影响性能。好的 ACI:
- 输出精简（不返回巨大文件 dump）
- 支持 scroll/navigate（不需要一次读完大文件）
- 搜索返回带上下文的行号
- 编辑是 diff-based（不需要重写整个文件）

**Claude Code 的 14 工具**：bash, glob, grep, ls, Read, Edit（str_replace based!）, Write, TodoWrite, Task（子agent）, WebFetch, exit_plan_mode, NotebookRead, NotebookEdit, MultiEdit

**AutoMater 问题:**
- `write_file` 只支持全文覆盖（不支持局部编辑/patch）→ 大文件改一行也要重写全部
- `read_file` 没有行号、没有分页
- `search_files` 用 findstr（Windows）质量差，不返回上下文行
- 没有 glob 工具
- 没有 diff/patch 工具
- 没有子 agent 能力（Claude Code 的 Task 工具）

#### 🟡 P2: 模型选择不灵活

**Cursor 2.0**：Agent 可以按任务选择最佳模型（强模型用于架构，弱模型用于格式化）。
**Factory**：根据任务复杂度动态选模型。

**AutoMater 问题:**
- 只有 `strongModel`（PM/Architect/QA）和 `workerModel`（Developer）两个固定槽
- Planner 本来可以用弱模型（便宜），但目前用 workerModel
- 没有按任务复杂度动态降级/升级

#### 🟡 P2: 验证能力弱

**OpenHands**: 执行测试 → 看报错 → 修复 → 再测试，循环到通过
**Factory Droids**: TDD 模式 — 先写测试，再写实现，测试驱动

**AutoMater 问题:**
- QA 是纯 LLM 文本审查（"看代码给分数"），不执行任何测试
- Developer 可以用 `run_command` 但没有引导他先跑测试
- 没有 lint/type-check 集成

#### 🟡 P2: 缺乏可观测性

**Factory**: Sentry 集成，错误追踪自动注入上下文
**Claude Code**: 详细的 API 日志可 proxy 捕获

**AutoMater 问题:**
- 只有 text log + SQLite agent_logs
- 没有结构化的 tool call 追踪（时间、耗时、token、成本 per tool call）
- 没有 replay 能力（不能重放某次 ReAct 循环调试）

---

## 二、业界最佳实践总结

### 2.1 Cognition / Devin — "Don't Build Multi-Agents"

**核心主张**: 单线程串行 agent + 高质量上下文压缩 > 并行多 agent。

**关键设计:**
- 单 agent 串行执行，避免 conflicting implicit decisions
- 专用 summarizer 模型压缩长历史（可以 fine-tune 小模型做这件事）
- 所有 action 的结果对后续 action 完全可见
- 极端强调 context engineering > prompt engineering

**AutoMater 启示:** 
并行 dev worker 是一个 tradeoff。如果要保留，必须加入"共享决策板"（shared decision log）让每个 worker 看到其他人的关键决策。

### 2.2 OpenHands / CodeAct 2.1

**核心架构:** Event-driven + Docker sandbox + Python execution
- Agent 通过 **执行 Python 代码** 作为主要行动方式（不是 JSON tool call）
- Docker sandbox 提供完整 Linux 环境
- Event stream 架构：所有操作都是 Event，可 replay/audit
- SWE-bench Verified 53% resolve rate

**AutoMater 启示:**
Sandbox 是必须的。至少包一个 Docker 或 Windows Sandbox。

### 2.3 Claude Code

**核心架构**: 极简单 agent loop + 14 个精心设计的工具
- `while(tool_use)` 循环，无 tool call 时停止
- **TodoWrite** 作为计划工具（与我们的 Planner 类似但更轻量）
- **str_replace based Edit**（不全文覆盖！）
- **Task 子 agent** — 用于只读查询（不写代码），继承有限上下文
- **System reminders** 注入到每条 tool result 中（"记得按 TODO 执行"）
- 没有数据库、没有复杂记忆，靠 `CLAUDE.md` 文件

**AutoMater 启示:**
1. Edit 工具必须改为 str_replace（diff-based），不能全文覆盖
2. System reminders 注入 tool results — 低成本高收益
3. CLAUDE.md 模式值得参考

### 2.4 Aider

**核心架构**: Repository Map + AST-powered context
- 用 tree-sitter 解析 AST → 提取所有函数签名/class/import
- **repo-map** 是全局结构摘要，永远在 context 中
- 动态选择相关文件（基于关键词 + 依赖分析 + 最近编辑）
- 输出格式: search/replace blocks（非全文）

**AutoMater 启示:**
Repository Map 是成本效益最高的上下文增强。应该在 ARCHITECTURE.md 之外，自动生成并维护一份 repo-map。

### 2.5 Factory Droids / Missions

**核心架构**: Multi-day autonomous + 3-layer memory + code graph
- **Missions**: 多日自主执行，orchestrator 拆分子任务
- **3-layer memory**: Personal → Project → Rules
- **Code graph**: Language-aware AST + import graph + call graph，替代 naive vector search
- **AGENTS.md**: 项目级 agent 指令文件
- **Hooks**: 自动触发记忆捕获（"remember this" hook）

**AutoMater 启示:**
Memory system 是 Factory 的核心差异化。3-layer 结构（个人 → 项目 → 规则）值得直接采用。

### 2.6 SWE-agent

**核心发现**: ACI 设计比 LLM 选择更重要。
- 精心设计的 file viewer（带行号、可翻页）
- 搜索结果带上下文（前后各 3 行）
- `edit` 命令是基于行号的替换（不是全文覆盖）
- Lint 和 test 自动执行

---

## 三、AutoMater v1.0+ 路线图建议

### 3.1 Phase A: 基础设施补齐（必做）

| 编号 | 改进项 | 对标 | 优先级 | 预估 |
|---|---|---|---|---|
| A1 | **str_replace Edit 工具** — 替代全文 write_file，支持按行号/内容匹配替换 | Claude Code, SWE-agent, Aider | P0 | 1 版本 |
| A2 | **Repository Map** — tree-sitter 或轻量 AST 解析，自动生成函数签名/class/export 索引 | Aider | P0 | 1 版本 |
| A3 | **Sandbox 执行** — Docker/子进程沙箱，支持 npm install/test/build 安全执行 | OpenHands | P0 | 1-2 版本 |
| A4 | **Worker 间共享决策日志** — 每个 worker 的关键决策（创建了什么文件、定义了什么接口）写入共享 log，其他 worker 每轮读取 | Cognition | P1 | 1 版本 |

### 3.2 Phase B: 记忆与经验系统

| 编号 | 改进项 | 对标 | 优先级 | 预估 |
|---|---|---|---|---|
| B1 | **3-layer Memory** — Global memory (用户偏好) + Project memory (架构决策/踩坑记录) + Agent memory (per-role 经验) | Factory | P1 | 1 版本 |
| B2 | **自动经验提取** — 每次 QA fail→fix 成功后，自动提取 "lesson learned" 写入 project memory | Factory hooks | P1 | 1 版本 |
| B3 | **AGENTS.md 规范** — 每个项目根目录一个 AGENTS.md，包含编码规范、常用命令、特殊注意事项，Agent 每轮自动读取 | Factory, Claude Code | P1 | 0.5 版本 |
| B4 | **Cross-project 经验迁移** — "TypeScript 项目常见初始化步骤"、"React 项目结构模板" 等通用经验池 | 创新 | P2 | 1-2 版本 |

#### B1 详细设计：3-layer Memory

```
记忆层次                    存储位置                     读取时机                    写入时机
──────────────────────────────────────────────────────────────────────────────────────
Global Memory              %APPDATA%/AutoMater/         所有项目所有 agent          用户手动 + 
(用户偏好/coding style)    global-memory.md              session 初始化时            设置页面

Project Memory             {workspace}/.AutoMater/      该项目所有 agent            Architect 初始化 +
(架构决策/踩坑/约定)       project-memory.md             每个 feature 开始时         QA fail 后自动提取 +
                                                                                     用户手动

Agent Role Memory          {workspace}/.AutoMater/      对应角色 agent              每次 feature 完成后
(per-role 经验)            memories/{role}.md             session 初始化时            自动积累
  - pm.md                  "这个项目倾向小粒度 feature"
  - developer.md           "用 path.join 不要拼接字符串"
  - qa.md                  "这个项目 import 路径常出错"
```

每个角色需要的上下文不同:
- **PM**: 用户偏好 + 项目历史 feature 列表 + 之前被拒绝的方案
- **Architect**: 技术栈偏好 + 已有架构文档 + 同类项目模板
- **Developer**: ARCHITECTURE.md + repo-map + 依赖文件 + 编码规范 + 当前 feature 计划 + 共享决策日志
- **QA**: 验收标准 + 实现代码 + 已知通用问题模式 + lint/test 结果

### 3.3 Phase C: 高级特性

| 编号 | 改进项 | 对标 | 优先级 | 预估 |
|---|---|---|---|---|
| C1 | **Summarizer 模型** — 专用小模型/prompt 压缩长对话历史，替代暴力截断 | Cognition | P1 | 1 版本 |
| C2 | **Code Graph** — import/call graph 分析，替代关键词匹配查找相关文件 | Factory | P2 | 2 版本 |
| C3 | **TDD 模式** — Developer 先写测试，再写实现，QA 直接跑测试而非纯文本审查 | Factory, OpenHands | P1 | 1 版本 |
| C4 | **Sub-agent 能力** — Developer 可以 spawn 只读子 agent 做调研/查询，不写代码 | Claude Code Task | P2 | 1 版本 |
| C5 | **Dynamic Model Selection** — 按任务复杂度自动选模型（简单格式化 → mini，复杂架构 → strong） | Cursor 2.0 | P2 | 0.5 版本 |
| C6 | **Event Stream + Replay** — 所有操作记录为可重放事件流，支持调试和审计 | OpenHands | P2 | 2 版本 |

### 3.4 建议执行顺序

```
v1.0:  A1 (str_replace edit) + A2 (repo map) + B3 (AGENTS.md)
v1.1:  A3 (sandbox) + B1 (3-layer memory) + B2 (auto lessons)
v1.2:  A4 (shared decision log) + C1 (summarizer) + C3 (TDD mode)
v1.3:  C2 (code graph) + C4 (sub-agent) + C5 (dynamic model)
v2.0:  C6 (event stream) + B4 (cross-project) + Multi-day missions
```

---

## 四、重要观点总结

### 4.1 Cognition 的警告：不要轻易并行

> "Actions carry implicit decisions, and conflicting decisions carry bad results."

我们的并行 dev worker 是一把双刃剑。保留它的前提是必须解决上下文共享问题。否则不如串行。

### 4.2 Anthropic 的观点：Context Engineering > Prompt Engineering

> "找到最小的、高信噪比的 token 集合，最大化期望输出的概率。"

我们目前的上下文注入太粗糙（一次性 dump），应该变成持续精炼。

### 4.3 Claude Code 的极简哲学

14 个精心设计的工具 + 简单 while loop > 复杂多 agent 架构。str_replace edit、TodoWrite、system reminders 三个设计是性价比最高的改进。

### 4.4 记忆系统的核心设计原则

Factory 的经验：
- 记忆是 **markdown 文件**，不是数据库 — agent 自己可以读写
- 记忆分 **个人/项目/角色** 三层 — 每种 agent 看不同子集
- 记忆需要 **维护** — 过期信息会误导 agent，需要定期清理
- 自动捕获 > 手动记录 — hooks / 自动提取 "lessons learned"
