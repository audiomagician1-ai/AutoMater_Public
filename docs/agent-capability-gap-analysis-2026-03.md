# Agent 能力差距分析：AutoMater vs EchoAgent

> 版本: v1.0 | 日期: 2026-03-02 | 审查视角: 从 EchoAgent（成熟 agentic 系统）第一视角，严格审视 AutoMater 中 Agent 的工作能力缺陷

---

## 0. 审查范围与方法论

**审查对象**: AutoMater v15.0 的 Agent 引擎层（`electron/engine/` 75+ 模块），涵盖 ReAct 循环、提示工程、上下文管理、工具链、记忆系统、子 Agent 框架。

**对标基准**: EchoAgent 的实际工作模式——跨会话持久记忆、多 Agent 编排、子 Agent 结果压缩、自适应上下文工程、技能系统、结构化推理。

**评判标准**: 不看代码量或架构复杂度，只看「Agent 能否在真实任务中可靠地完成工作」。

**严重程度定义**:
- 🔴 **致命 (Critical)** — 直接导致 Agent 无法完成任务或产出质量严重不可靠
- 🟡 **严重 (Major)** — 显著降低 Agent 效率或产出质量，用户频繁遇到
- 🟢 **改进 (Minor)** — 有更好的做法，当前方式不是最优但不阻断工作

---

## 1. 🔴 推理深度与自我纠错能力

### 1.1 缺乏结构化反思机制

**现状**: `think` 工具只是一个 echo 函数（输入什么返回什么），Developer Prompt 虽然提到 "思考→行动→观察→验证"，但没有任何强制机制确保 Agent 真正执行了反思。

**EchoAgent 对照**: EchoAgent 在每个关键决策点会执行显式的 Plan → Act → Observe → Adapt 循环，并且在工具执行结果与预期不符时，会强制进入 "这个结果说明什么？我的假设是否错误？" 的反思路径。

**差距表现**:
- Agent 经常连续调 3-5 次 `edit_file` 失败（old_string 不匹配），不会停下来反思 "也许我应该先 read_file 看看最新内容"
- `iteration-learning.ts` 虽然提取了 failure pattern，但只是被动注入 lesson——Agent 没有主动的"停下来想想为什么反复失败"的触发机制
- 没有 "验证步骤强制执行" 的 guard——Agent 可以跳过阶段 3（验证）直接 `task_complete`

**建议**:
- 引入 "mandatory verification gate"：在 `task_complete` 被调用前，guard 检查是否至少执行过一次 `run_command`/`run_test`/`run_lint`，否则拦截并注入 "你还没有验证代码能否运行，请先执行验证"
- `think` 工具改为带结构的 `reflect`：要求输出 `{observation, hypothesis, next_action, confidence}` 格式

### 1.2 缺乏全局任务进度感知

**现状**: Agent 通过 `todo_write`/`todo_read` 手动管理任务清单。但这完全依赖 Agent 自觉——如果 Agent 忘记更新 todo，就丢失了进度感知。

**EchoAgent 对照**: EchoAgent 有 checkpoint 机制——每完成一个实质性步骤自动写入 `task_checkpoint.json`，即使上下文被压缩，恢复后也能精确知道 "我做到哪了，下一步是什么"。

**差距表现**:
- 上下文压缩后，Agent 经常重复做已经完成的工作（因为压缩摘要丢失了精确的进度信息）
- 没有 "阶段完成确认" 的 harness 检查——Agent 说自己完成了阶段 2，但 harness 不验证

**建议**:
- scratchpad 的 `progress` 字段应由 harness 在每次有文件写入时自动更新（不依赖 Agent 主动调用）
- 在 `compressMessageHistorySmart` 生成摘要时，强制将 todo 清单和最新 progress 作为摘要的必含内容

---

## 2. 🔴 上下文工程的关键缺陷

### 2.1 初始上下文构建不充分

**现状**: `collectDeveloperContext` 收集项目结构、架构文档、技能匹配等信息后一次性塞入第一条 user message。但这个上下文是静态的——在 50 轮迭代过程中，Agent 对项目的理解不会随工作深入而演进。

**EchoAgent 对照**: EchoAgent 的上下文是分层渐进式的：先加载 hot memory（~3K tokens 的项目骨架），工作过程中按需加载 warm/cold memory（具体模块详情），且每次压缩后重新评估哪些上下文仍然相关。

**差距表现**:
- Agent 在第 1 轮拿到的项目上下文可能有 5000+ tokens，但其中 80% 与当前 feature 无关
- hot/warm/cold 三层记忆虽然在 `memory-layers.ts` 中实现了，但没有被 ReAct 循环动态使用——只在初始 context 构建时调用一次
- 没有 "上下文相关性衰减" 机制：第 1 轮读的文件 A 的内容，到第 30 轮仍然原封不动占着上下文

**建议**:
- 实现动态上下文刷新：每 10 轮迭代，重新评估当前 feature 的相关文件，替换不再相关的上下文
- cold memory 应按需注入——当 Agent 调用 `read_file` 读取某模块时，自动将该模块的 cold memory 摘要注入上下文

### 2.2 Prompt 缺乏任务上下文自适应

**现状**: `DEVELOPER_REACT_PROMPT` 是固定的 ~3000 字符通用 prompt，无论 Agent 在做前端组件还是后端 API，看到的系统指令完全一样。工具列表部分手动列举了 30+ 个工具的一句话描述，占用约 1500 tokens。

**EchoAgent 对照**: EchoAgent 的 system prompt 是动态组装的——会根据当前任务类型注入不同的指导策略和相关技能，且工具描述由 LLM function-calling schema 自动提供，不需要在 prompt 中重复列举。

**差距表现**:
- Prompt 中的工具列表与 `tool-definitions.ts` 中的 JSON schema 重复——Agent 通过 function-calling 已经看到了工具描述，system prompt 中再列一遍浪费 ~1500 tokens
- 所有角色的 prompt 都没有根据 feature 类型动态调整——一个 "添加按钮" 的 UI feature 和 "设计数据库 schema" 的 feature 看到同一份指令
- `adaptive-tool-selector.ts` 已经实现了工具裁剪逻辑，但没有在 ReAct 循环中被调用

**建议**:
- 从 `DEVELOPER_REACT_PROMPT` 中删除手动工具列表（Agent 通过 function schema 已经有了）
- 在 system prompt 中根据 feature 的 category（infrastructure/core/ui/api/testing）注入特定指导
- 激活 `adaptive-tool-selector.ts`——在每轮迭代时动态裁剪工具列表

---

## 3. 🔴 错误处理与恢复策略

### 3.1 Agent 陷入死循环的场景未覆盖

**现状**: `guards.ts` 有 `maxIdleIterations`（连续无副作用的轮次上限）和 `maxIterations`（总轮次上限），`iteration-learning.ts` 有失败模式匹配。但存在几个未覆盖的死循环场景。

**EchoAgent 对照**: EchoAgent 不会陷入 "同一个方法反复尝试" 的循环，因为每次工具失败后的 recovery hint 会携带具体的替代方案建议，且连续 2 次同类失败后会自动升级策略（比如从 `edit_file` 切换到 `write_file` 重写整个文件）。

**差距表现**:
- Agent 反复尝试 `edit_file` 但 `old_string` 总是匹配不上 → `iteration-learning` 会注入 "先 read_file 再 edit" 的教训，但不会强制 Agent 真的这么做
- Agent 在网络搜索场景中可能反复搜同一个 query → `recentCallSignatures` 检测重复签名但 `maxIdleIterations=50` 太大了
- Agent 遇到 `run_command` 超时后不知道该怎么办——没有 "命令超时恢复策略" 的指导

**建议**:
- 引入 "工具调用策略升级"：同一工具连续失败 2 次后，harness 自动注入替代方案（不只是 lesson，而是强制性的指令）
- `maxIdleIterations` 降回合理值（PM/Architect=20，Developer=10），同时将 `scratchpad_write` 加入有副作用的工具集
- 对 `run_command` 超时场景，注入 "上一个命令超时了(>60s)，建议: (1) 加 timeout 参数 (2) 拆成更小的命令 (3) 检查是否有交互式 prompt 阻塞"

### 3.2 LLM 输出格式错误恢复不足

**现状**: PM 阶段的 JSON 解析有 4 种策略（`pm-phase.ts`），QA 阶段有类似的解析。但 Developer 阶段依赖 function-calling 的 `tool_calls` 结构——如果 LLM 返回了纯文本而非 tool_call，代码回退到 `<<<FILE>>>` 模式。

**EchoAgent 对照**: EchoAgent 在每次 LLM 调用失败后都有显式的 "格式修复重试"——重新发送一条 user message 说 "你的输出格式不正确，请按要求输出"，而不是直接放弃。

**差距表现**:
- Developer loop 在 LLM 不返回 `tool_calls` 时直接 `break` 退出循环（line ~381-402），只尝试了 `<<<FILE>>>` 模式，没有尝试 "请使用工具调用" 的修复消息
- 这意味着模型稍有不稳定（比如偶尔返回纯文本思考），Agent 就提前终止了

**建议**:
- 在 "无 tool_calls" 分支中，不要立即 break，而是注入一条 user message: "你需要使用工具来完成任务，请调用合适的工具。如果任务已完成，请调用 task_complete。" 然后继续循环
- 设置 "纯文本回复容忍次数"（默认 2），超过后才 break

---

## 4. 🟡 多 Agent 协作的信息传递效率

### 4.1 Phase 间信息损失

**现状**: PM → Architect → Developer 的信息通过数据库中间表传递（`features` 表 + `docs` 表），但 Developer 拿到的是独立的 feature 描述，缺乏全局上下文。

**EchoAgent 对照**: EchoAgent 的多 Agent 编排中，每个 Agent 在完成工作后会生成一份结构化的 "交接摘要"，下一个 Agent 不是看原始产出，而是看精炼后的关键决策和约束。

**差距表现**:
- Developer 只看到自己负责的 feature 的 `title + description + acceptance_criteria`，看不到 PM 为什么这样拆分的推理过程
- Architect 写的 `ARCHITECTURE.md` 被全文塞入 context，但 Developer 可能只需要其中某个模块的部分
- QA 反馈 (`qaFeedback`) 是纯文本，没有结构化的 "问题→位置→建议修复" 格式

**建议**:
- 在 PM→Architect 交接时生成 `decision_summary.json`：记录每个 feature 为什么存在、依赖关系的理由
- 在 Architect→Developer 交接时，按 feature 裁剪架构文档——每个 developer 只看到与自己 feature 相关的架构部分
- QA 反馈结构化为 `{file, line, issue_type, description, suggested_fix}[]`

### 4.2 并行 Worker 间缺乏实时信息共享

**现状**: `decision-log.ts` 实现了文件级声明（claim/release），`shared-decisions` 在 `memory-system.ts` 中可以追加共享决策。但这些机制是被动的——Worker A 不知道 Worker B 正在做什么，除非 Worker B 显式写入。

**EchoAgent 对照**: EchoAgent 的并行任务管理中，每个子 Agent 完成的工作会实时广播给其他子 Agent 的 scratchpad，确保后续决策基于最新的项目状态。

**差距表现**:
- Worker A 修改了 `types.ts` 新增了一个 interface，Worker B 同时在另一个文件中 import 旧的 interface → build 报错
- 没有 "实时 workspace 变更通知" 机制——Worker 只在开始时读一次项目状态

**建议**:
- 在每个 Worker 的 ReAct 循环中，每 5 轮注入一次 "其他 Worker 的最新变更摘要"（从 decision-log 和 scratchpad 汇总）
- 对 `types.ts` / `package.json` / `tsconfig.json` 等全局文件的修改，实现跨 Worker 即时通知

---

## 5. 🟡 知识获取与外部信息处理

### 5.1 网页搜索结果利用效率低

**现状**: `web_search` 返回摘要，`fetch_url` 返回网页全文（截断到 15000 字符），`deep_research` 做多轮搜索+综合。但这些原始结果直接塞入上下文，没有针对当前任务做相关性过滤。

**EchoAgent 对照**: EchoAgent 使用 WebResearch 子 Agent 进行搜索——搜索结果不会直接进入主 Agent 的上下文，而是由子 Agent 读取、理解、提取关键信息后，只返回与当前任务相关的精华摘要。

**差距表现**:
- Agent 搜索 "React useEffect cleanup" 拿到 8 条搜索结果（~3000 字符），然后 `fetch_url` 抓取某个页面（~15000 字符）→ 一次搜索就占了 18000 字符的上下文
- `tool-result-summarizer.ts` 虽然对 `web_search` 结果做了摘要，但只是按字符数截断，没有按相关性筛选
- `deep_research` 的综合报告质量好但成本高（多次 LLM 调用）

**建议**:
- 将搜索任务默认委托给 `spawn_researcher` 子 Agent（当前只是可选），子 Agent 在内部消化搜索结果后只返回 ≤2000 字符的精华
- `fetch_url` 的结果在返回给 Agent 前，先用 `tool-result-summarizer` 做基于查询的相关性摘要（而非简单截断）

### 5.2 缺乏结构化知识提取

**现状**: Agent 读取文件后拿到原始文本，读取文档后拿到 Markdown。没有中间层将这些原始信息转化为结构化知识。

**EchoAgent 对照**: EchoAgent 在读取代码文件时会自动提取结构信息（exports, imports, function signatures, classes），读取文档时会提取关键定义和约束。

**差距表现**:
- Agent 用 `read_file` 读一个 300 行的文件，占用 ~200 tokens per line ≈ 8000 tokens，但其中可能只有 10 行 import 和 3 个函数签名是真正需要的
- `code_graph_query` 和 `repo_map` 提供了结构视图，但 Agent 不一定会用它们——通常直接 `read_file` 全文
- 没有 "智能代码骨架" 功能：给 Agent 看一个文件的签名+类型+注释骨架（不含函数体），减少 80% 的 token

**建议**:
- 实现 `read_file_skeleton` 工具：返回文件的 imports + exports + function/class signatures + JSDoc，折叠函数体为 `{...}`
- 对 >200 行的文件，`read_file` 默认返回骨架视图 + "使用 offset/limit 查看具体区域" 的提示

---

## 6. 🟡 持久化记忆与经验学习

### 6.1 跨 Session 学习能力缺失

**现状**: `memory-system.ts` 提供了 Global/Project/Role 三层记忆，`skill-evolution.ts` 实现了技能习得。但这些都需要 Agent 主动调用 `memory_append` 或 `skill_acquire`——实际使用中 Agent 几乎不会主动记忆。

**EchoAgent 对照**: EchoAgent 有完整的自动暂存 → 审核合并 → 持久化流程。每次 Agent 犯错被纠正、每次完成重要产出、每次发现可复用流程，都会自动写入暂存区，会话结束时审核合并到正式记忆。

**差距表现**:
- `memory_append` 在整个代码中只被 Agent 通过 tool call 使用——如果 Agent 不调用，什么都不会记住
- 技能系统(`skill-evolution.ts`)实现完整但几乎不被触发——没有 harness 层的自动技能提取
- 项目经验（如 "这个项目用 pnpm 而不是 npm"、"这个项目的 TypeScript strict 模式需要显式类型"）不会自动积累

**建议**:
- 实现 harness 层自动经验提取：
  - 当 QA reject → 自动将 rejection 原因写入项目记忆（"这个项目需要注意 XXX"）
  - 当 `run_command` 失败后 Agent 修复了 → 自动将错误+修复方式写入技能库
  - 当 feature 完成 → 自动提取 "用了什么技术方案" 写入项目记忆
- `scratchpad` 已实现的自动收集是正确方向，但应扩展到 session 级别的经验沉淀

### 6.2 技能系统未闭环

**现状**: `skill-evolution.ts` 有 acquire/search/improve/record_usage 四个工具。`buildSkillContext` 在 ReAct 循环开始时做了技能匹配注入。但技能的"学习"路径不完整。

**差距表现**:
- 技能只能由 Agent 通过 `skill_acquire` 主动学习，没有从成功 task 中自动提取技能的流程
- 技能匹配是一次性的（只在 ReAct 开始时注入），后续不会根据 Agent 遇到的问题动态匹配新技能
- 没有技能的有效性验证——Agent 按技能指导做了但失败了，技能不会被标记为 "可能过时"

**建议**:
- 在每个 feature 成功完成后，harness 自动分析 Agent 的工具调用序列，提取可复用的 pattern 作为技能候选
- 技能匹配从一次性改为周期性——每 10 轮迭代重新匹配，因为 Agent 在后期可能遇到了开始时没预料到的问题

---

## 7. 🟡 工具使用的策略性

### 7.1 缺乏工具调用策略指导

**现状**: Prompt 中有 "阶段 1/2/3" 的工作流建议，但这是建议而非强制。`adaptive-tool-selector.ts` 已实现但未激活。

**EchoAgent 对照**: EchoAgent 的工具选择是策略性的——在 "理解" 阶段自动限制只能用读取工具，在 "实现" 阶段开放写入工具，在 "验证" 阶段限制只能用测试工具。

**差距表现**:
- Agent 可能在第 1 轮就开始写代码（跳过理解阶段）——prompt 说了 "先了解再实现" 但没有强制
- Agent 在验证阶段可能跳过 `run_test` 直接 `task_complete`——没有 guard 检查
- 工具列表始终是全量的 40+ 个，增加了选择噪声

**建议**:
- 实现 "阶段感知工具过滤"：前 3 轮只提供读取/规划工具，中间轮次开放写入工具，最后 3 轮强制包含验证工具
- 在 `task_complete` 的 guard 中检查：是否至少写过 1 个文件 AND 执行过 1 次验证命令

### 7.2 文件编辑策略缺乏层次

**现状**: Agent 通过 `write_file`（创建/覆盖）和 `edit_file`（精确替换）操作文件。`batch_edit` 支持多次替换。

**EchoAgent 对照**: EchoAgent 在修改文件前会先评估修改范围——如果改动 >50% 的行，使用 write_file 重写更高效；如果改动 <10% 的行，使用 edit_file 精确修改。并且在 edit_file 失败时会自动降级为 "先读完整文件 → 手工合并 → write_file"。

**差距表现**:
- Agent 经常对大文件用 `edit_file` 但 `old_string` 匹配失败（因为文件在其他操作中被修改了），反复重试浪费 3-5 轮
- 没有 "编辑策略建议"——harness 不会根据文件大小和改动范围建议用哪个工具
- `batch_edit` 虽然减少了轮次但仍然依赖精确匹配，失败时没有 fallback

**建议**:
- 在 `edit_file` 连续失败 2 次后，harness 自动注入: "edit_file 匹配失败，建议: (1) 用 read_file 获取文件最新内容 (2) 如果改动较大，考虑用 write_file 重写整个文件"
- 在 `edit_file` 的 guard 中，如果 `old_string` >500 字符，建议拆成多个小编辑或使用 `batch_edit`

---

## 8. 🟢 运维与可观测性

### 8.1 Agent 执行过程的可追溯性不足

**现状**: `conversation-backup.ts` 备份完整对话历史，`event-store.ts` 记录结构化事件，`runtime-telemetry.ts` 收集遥测数据。日志通过 `ui-bridge.ts` 推送到前端。

**差距表现**:
- 对话备份是事后完整备份，但没有 "关键决策时刻" 的高亮标记——事后 debug 时要翻完整对话
- Agent 为什么做了某个决策（比如为什么选了这个文件而不是那个）没有结构化记录
- scratchpad 的 `decisions` 字段是正确方向，但只有 Agent 主动写入时才有

**建议**:
- 在 harness 层对 "产生副作用的工具调用"（write_file, edit_file, run_command）自动记录 `{why: Agent 上一条思考内容, what: 工具调用详情, result: 结果摘要}`
- 事件流中增加 "决策点" 事件类型，方便 UI 层做执行回放

### 8.2 成本控制粒度不够

**现状**: `checkBudget` 在 agent-manager.ts 中做项目级预算检查。`calcCost` 在每次 LLM 调用后计算。但没有 feature 级的成本追踪和预警。

**差距表现**:
- 一个简单 feature 可能因为 Agent 进入低效循环而消耗大量 token，但只有项目级预算能拦截
- 没有 "单 feature 成本异常" 预警——如果一个 feature 用了 50 轮迭代和 $2，不会有任何告警
- 子 Agent 的成本被归到父 Agent，无法区分

**建议**:
- 在 `ReactResult` 中增加 feature 级成本统计，超过阈值（如平均值的 3 倍）时在日志中警告
- 子 Agent 成本单独追踪和展示

---

## 9. 🟢 项目理解能力

### 9.1 项目导入后的深度理解不足

**现状**: `project-importer.ts` + `probe-orchestrator.ts` 对导入的项目做了静态分析（目录结构、模块图、依赖关系），生成 `skeleton.json` 和 `KNOWN-ISSUES.md`。

**差距表现**:
- 导入分析是纯静态的——不运行项目、不分析运行时行为
- 对于前端项目不会尝试 `npm run build` 来发现编译错误
- 对于 monorepo 不识别 workspace 结构（pnpm workspaces, nx, turborepo）
- 项目的 `.env.example`、`README.md` 中的配置说明没有被提取

**建议**:
- 导入后自动执行 `npm install` + `npm run build`，将结果写入 KNOWN-ISSUES
- 解析 `README.md` 中的 "Getting Started" / "Development" 章节，提取开发环境配置要求
- 识别 monorepo 结构并为每个 package 单独生成模块摘要

### 9.2 运行时上下文缺失

**现状**: Agent 可以通过 `run_command` 执行命令、`browser_launch` 打开浏览器、`screenshot` 截屏。但这些都需要 Agent 主动使用。

**差距表现**:
- 开发 Web 前端 feature 时，Agent 通常不会主动启动 dev server 并打开浏览器验证效果
- 开发 API 时，Agent 通常不会主动发 HTTP 请求测试端点
- 这些 "应该做但 Agent 不做" 的验证行为，需要在 prompt 中更强地暗示或在 guard 中检测

**建议**:
- 在 feature 的 category=ui 时，system prompt 中追加 "完成 UI 修改后，你必须: (1) 启动 dev server (2) browser_launch 打开页面 (3) browser_screenshot 截图验证"
- 在 `task_complete` 的 guard 中，如果 feature.category=ui 但没有执行过任何 browser 工具，注入警告

---

## 10. 综合优先级矩阵

| # | 问题 | 严重程度 | 实施难度 | 影响范围 | 推荐优先级 |
|---|------|---------|---------|---------|-----------|
| 1.1 | 缺乏结构化反思 + 验证强制 | 🔴 | 中 | Developer+QA | **P0** |
| 3.1 | Agent 死循环未覆盖场景 | 🔴 | 低 | 全角色 | **P0** |
| 3.2 | 纯文本回复恢复不足 | 🔴 | 低 | Developer | **P0** |
| 2.1 | 初始上下文不充分+静态 | 🔴 | 高 | Developer | **P1** |
| 2.2 | Prompt 缺乏自适应 | 🟡 | 中 | Developer+QA | **P1** |
| 7.1 | 工具调用缺乏策略层 | 🟡 | 中 | Developer | **P1** |
| 4.1 | Phase 间信息损失 | 🟡 | 中 | 全流水线 | **P1** |
| 6.1 | 跨 Session 学习缺失 | 🟡 | 高 | 全角色 | **P2** |
| 5.1 | 搜索结果利用效率低 | 🟡 | 低 | Developer | **P2** |
| 1.2 | 全局进度感知不足 | 🔴 | 低 | Developer | **P2** (scratchpad 已部分解决) |
| 4.2 | 并行 Worker 信息共享 | 🟡 | 高 | Developer | **P2** |
| 5.2 | 缺乏结构化知识提取 | 🟡 | 中 | Developer | **P2** |
| 6.2 | 技能系统未闭环 | 🟡 | 高 | 全角色 | **P3** |
| 7.2 | 文件编辑策略层次 | 🟡 | 低 | Developer | **P3** |
| 8.1 | 执行过程可追溯性 | 🟢 | 低 | 运维 | **P3** |
| 8.2 | 成本控制粒度 | 🟢 | 低 | 运维 | **P3** |
| 9.1 | 项目导入深度理解 | 🟢 | 中 | PM+Architect | **P3** |
| 9.2 | 运行时上下文 | 🟢 | 低 | Developer+QA | **P3** |

---

## 11. 总结

AutoMater 在 **工具数量**(80+) 和 **架构完整性** (5阶段流水线 + 7角色 + Hot/Warm/Cold 记忆 + 子Agent框架) 上已经非常成熟。

但从 "Agent 能否可靠完成工作" 的角度看，核心差距集中在三个领域：

1. **Agent 的自主性不可靠** — 太多关键行为依赖 Agent 自觉（反思、验证、记忆），而非 harness 强制。这是 Agent 产出不稳定的根本原因。
2. **上下文的精准度不够** — 给 Agent 的信息要么太多（全量工具列表、静态初始上下文），要么太少（缺乏动态上下文刷新、缺乏跨 Worker 信息共享），导致 Agent 在信息洪流中做出次优决策。
3. **从经验中学习的闭环未建立** — 系统有完整的记忆/技能基础设施，但缺乏 harness 层的自动触发，导致这些基础设施空转。

**核心原则（与 EchoAgent 的本质差异）**:
> EchoAgent 的设计哲学是 "trust but verify" — 信任 Agent 的能力，但在每个关键节点设置 verification gate。
> AutoMater 当前的设计更接近 "trust and hope" — 给 Agent 充足的工具和指令，希望它自觉遵循最佳实践。
> 从 hope 到 verify 的转变，是 AutoMater Agent 能力提升的最大杠杆点。
