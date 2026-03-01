# AgentForge 实现审计报告 — 规划 vs 现状全面差距分析

> 审计日期: 2026-03-01
> 审计范围: DESIGN.md, REVIEW-v0.9.md, ITERATION-PLAN-v4.md, TOOL-EXPANSION-PLAN.md, architecture-optimization-analysis.md, ephemeral-workflow-design.md, CLAUDE.md
> 基线代码: commit `abbfe82` (master)

---

## 〇、总览评分

| 规划文档 | 实现完成度 | 质量评价 |
|----------|-----------|----------|
| **DESIGN.md** (初始设计) | 🟠 55% | 架构大幅偏离原设计（Tauri→Electron, monorepo→单体），但核心理念保留 |
| **REVIEW-v0.9.md** (业界对标) | 🟢 75% | P0/P1 问题大部分已修复，P2 部分推进 |
| **ITERATION-PLAN-v4.md** (v4迭代) | 🟢 85% | 5个Phase全部实施，部分超额完成 |
| **TOOL-EXPANSION-PLAN.md** (工具扩展) | 🟡 65% | Tier 1-4 定义齐全，Tier 5 未开始，执行器部分空壳 |
| **architecture-optimization-analysis.md** (v5优化) | 🟢 90% | 核心优化全部落地 |
| **ephemeral-workflow-design.md** (临时工作流) | 🟡 60% | 框架+DB+IPC完成，Planner/Worker/Judge实际执行尚未对接真实LLM |

---

## 一、DESIGN.md (初始设计文档) — 完成度 55%

### 1.1 技术栈偏差

| 规划 | 实际 | 偏差原因 |
|------|------|----------|
| **Tauri 2.x (Rust + WebView)** | **Electron 33 + React 19 + Vite 6** | 开发速度考量，Electron 生态更成熟 |
| shadcn/ui | Tailwind 手写组件 | shadcn 未引入，纯 Tailwind CSS |
| Zustand | ✅ Zustand 5 | 完全一致 |
| Rust 后端 + Node sidecar | **全 TypeScript** (Electron main + preload) | 无 Rust，无 sidecar |
| SQLite (Tauri plugin-sql) | ✅ SQLite (better-sqlite3) | 实现方式不同但效果一致 |
| pnpm workspace monorepo | **单体应用** (electron/ + src/) | 简化了但缺失模块边界 |

**评估**: 架构从 Tauri monorepo 简化为 Electron 单体。这是务实选择——Electron 开发更快，但 `DESIGN.md` 中规划的 `@agentforge/core`、`@agentforge/llm`、`@agentforge/sandbox`、`@agentforge/shared` 4个包 **全部未实现为独立模块**，代码全在 `electron/engine/` 下。

### 1.2 Agent 角色体系

| 规划角色 | 实际状态 | 备注 |
|----------|---------|------|
| **PM** | ✅ 完整实现 | 需求分析、Feature拆分、设计文档、子需求、验收审查 |
| **Architect** | ✅ 完整实现 | 架构设计+产品设计合并一步 |
| **Developer** | ✅ 完整实现 | ReAct 循环，25轮上限，40+工具 |
| **QA** | ✅ 完整实现 | 代码质量审查 + 测试规格生成 |
| **Code Reviewer** | ❌ 未实现 | 职责合并到 QA |
| **DevOps** | ⚠️ 定义存在，未使用 | `DEFAULT_TEAM` 中有 devops 但 orchestrator 不调用 |

### 1.3 工作流模型

| 规划 | 实际 |
|------|------|
| 3阶段 (Init→Iterative→Delivery) | ✅ 5阶段流水线 (v5.0 优化后) |
| PM→Architect→Developer→QA→Reviewer→DevOps | PM→Architect→(PM+QA)→Developer→(QA+PM)→User |
| Feature 两层清单 (索引层+详情层) | ⚠️ 单层 (DB features 表，无独立详情层) |
| RFC 机制 (Agent反向反馈) | ❌ 未实现 |
| HITL 审批门 (文件级) | ✅ 用户验收面板 (项目级) |
| FeatureSelector 智能选择 | ⚠️ `lockNextFeature` 简单按优先级+todo状态锁定 |
| 并行 Worker 协调 | ⚠️ 多 worker 并行但无共享决策日志 |

### 1.4 UI 页面

| 规划页面 | 实际 | 备注 |
|----------|------|------|
| 许愿台 (Wish) | ✅ WishPage + MetaAgentChat | 超额：有元Agent对话 |
| 看板 (Kanban) | ✅ BoardPage | 已实现 |
| 团队 (Team) | ✅ TeamPage (v3.1) | 超额：配置+运行状态双tab，详情弹窗 |
| 对话 (Chat) | ⚠️ MetaAgentPanel (侧栏) | 不是独立页面，是全局右侧栏 |
| 报告 (Report) | ⚠️ OverviewPage 指挥中心 | 功能集成在Overview，无独立Report |
| 设置 (Settings) | ✅ SettingsPage | 完整 |
| **额外页面** | WorkflowPage, DocsPage, OutputPage, LogsPage, ContextPage, TimelinePage, GuidePage, ProjectsPage | 比规划多8个页面 |

### 1.5 数据模型

| 规划 | 实际 |
|------|------|
| Project (5字段) | ✅ projects表 (12+字段，含 wish, workspace_path, config JSON) |
| FeatureIndex + FeatureDetail | ⚠️ 只有 features 表 (单层，含 group_name, sub_group) |
| AgentInstance (6字段) | ✅ agents表 (10+字段，含 session_count, cost 追踪) |
| — | ✅ 额外表: wishes, team_members, change_requests, missions, mission_tasks, agent_logs |

### 1.6 LLM 集成

| 规划 | 实际 |
|------|------|
| 多Provider (OpenAI/Anthropic/本地/自定义) | ✅ llm-client.ts 支持 OpenAI 兼容 + Anthropic 双协议 |
| 智能路由 (强/中/弱模型) | ✅ model-selector.ts (strong/worker/fast 三层) |
| ModelConfig (含 context_window, pricing) | ✅ 8 模型定价表 |

---

## 二、REVIEW-v0.9.md (业界对标差距) — 完成度 75%

### 2.1 P0 问题修复状态

| 问题 | 严重度 | 修复状态 | 实际做法 |
|------|--------|---------|----------|
| **上下文工程不足** | 🔴 P0 | ✅ 大幅改善 | context-collector.ts v2.0 (3层记忆 Hot/Warm/Cold)，code-graph.ts 依赖追踪，repo-map.ts 符号索引，compaction 压缩 |
| **没有 Repository Map** | 🔴 P0 | ✅ 已实现 | repo-map.ts (AST → 函数签名/class/export 索引) |
| **没有语义搜索** | 🔴 P0 | ⚠️ 部分 | search_files 仍用 findstr/grep，无向量检索。code-graph 做了 import 链追踪 |
| **没有上下文压缩** | 🔴 P0 | ✅ 已实现 | context-collector.ts `compactMessages()` + `trimToolResult()` |
| **并行Worker无上下文共享** | 🔴 P0 | ❌ 未修复 | 仍只靠 `lockNextFeature`，无 shared decision log |
| **没有 Sandbox** | 🔴 P0 | ⚠️ 有文件无实质 | sandbox-executor.ts 存在，但 run_command 仍为直接 `execSync` 无隔离 |

### 2.2 P1 问题修复状态

| 问题 | 修复状态 | 实际做法 |
|------|---------|----------|
| **3层记忆系统** | ✅ 已实现 | memory-system.ts (Global + Project + Agent Role)，cross-project.ts 跨项目经验 |
| **自动经验提取** | ✅ 已实现 | orchestrator.ts `extractLessons()` (QA fail→fix 成功后自动) |
| **AGENTS.md 规范** | ⚠️ 部分 | 有 ARCHITECTURE.md 自动生成，无独立 AGENTS.md 文件 |
| **并行Worker协调** | ❌ 未修复 | 同上，无共享决策日志 |
| **ACI 设计粗糙** | ✅ 大幅改善 | edit_file (str_replace)、batch_edit、read_file (行号+分页)、search_files (上下文行) |

### 2.3 P2 问题修复状态

| 问题 | 修复状态 | 实际做法 |
|------|---------|----------|
| **模型选择不灵活** | ✅ 改善 | model-selector.ts (strong/worker/fast 按任务类型选择) |
| **验证能力弱 (QA纯文本)** | ⚠️ 部分 | QA 仍为 LLM 文本审查，但 Developer 可执行 run_test/run_lint |
| **缺乏可观测性** | ✅ 大幅改善 | agent:react-state 事件、agent:context-snapshot、ContextTimeline SVG、tool call 追踪、持久化日志 |
| **Event Stream + Replay** | ⚠️ 有基础 | event-store.ts 存在，但无 replay UI |

### 2.4 路线图执行对照

| 规划版本 | 规划内容 | 实际状态 |
|---------|----------|---------|
| v1.0 | A1 str_replace edit + A2 repo map + B3 AGENTS.md | ✅ A1/A2完成, B3部分 |
| v1.1 | A3 sandbox + B1 3-layer memory + B2 auto lessons | ⚠️ A3形式完成无实质, ✅ B1/B2 |
| v1.2 | A4 shared decision log + C1 summarizer + C3 TDD | ❌ A4未做, ✅ C1完成, ❌ C3未做 |
| v1.3 | C2 code graph + C4 sub-agent + C5 dynamic model | ✅ C2完成, ✅ C4完成 (spawn_researcher), ✅ C5完成 |
| v2.0 | C6 event stream + B4 cross-project + Multi-day missions | ⚠️ C6基础完成, ✅ B4完成, ✅ Missions完成 |

---

## 三、ITERATION-PLAN-v4.md (v4迭代计划) — 完成度 85%

### Phase 1 (v4.0): 日志持久化 + 高级 Prompt ✅ 完成

| 改进项 | 状态 | 实际 |
|--------|------|------|
| 日志持久化 (DB→前端加载) | ✅ | ui-bridge.ts 自动写 agent_logs 表，LogsPage 可从 DB 加载 |
| 高级 Agent Prompts | ✅ | prompts.ts 全面重写，team_members.system_prompt 被 orchestrator 消费 |
| 日志按Agent过滤/搜索 | ✅ | LogsPage 支持 |

### Phase 2 (v4.1): DAG 多层级重设计 ✅ 完成

| 改进项 | 状态 | 实际 |
|--------|------|------|
| dagre 布局引擎 | ✅ | OverviewPage 使用 dagre 自动布局 |
| 三层级视图 (模块→子模块→Feature) | ✅ | L1/L2/L3 + 面包屑导航 + 双击下钻 |
| 滚轮冲突解决 | ✅ | 独立 wheel 事件处理 + touch-action: none |
| 节点无重叠 | ✅ | dagre 自动计算 |

### Phase 3 (v4.2): 工作流引擎重构 ✅ 完成

| 改进项 | 状态 | 实际 |
|--------|------|------|
| 7阶段流水线 → 5阶段优化 | ✅ | orchestrator v5.0 |
| 文档体系 (.agentforge/docs/) | ✅ | doc-manager.ts (设计文档/子需求/测试规格) |
| PM 多次参与 (分析+验收) | ✅ | PM 在 Phase 1/4/5 参与 |
| 门控检查 (PM→Arch, Arch→Dev) | ✅ | guards.ts |
| 文档版本追踪 | ✅ | 每次更新递增 version |

### Phase 4 (v4.3): 需求变更管理 ✅ 完成

| 改进项 | 状态 | 实际 |
|--------|------|------|
| change-manager.ts | ✅ | 影响分析 + 级联更新 + 一致性校验 |
| detectImplicitChanges (续跑分诊) | ✅ | PM 自动判断新需求 vs 变更 |
| change_requests 表 | ✅ | DB 已建 |
| 文档一致性引擎 | ✅ | checkConsistency() |

### Phase 5 (v4.4): 体验打磨 ✅ 完成

| 改进项 | 状态 | 实际 |
|--------|------|------|
| 用户验收面板 | ✅ | AcceptancePanel.tsx + project:awaiting-acceptance 事件 |
| 文档浏览器 | ✅ | DocsPage (5级文档树，右键版本历史) |
| 7阶段流水线进度条 | ✅ | PipelineBar 组件 |
| 文档完成度指示器 | ✅ | DocCompletionBar 组件 |
| 通知系统 | ✅ | Electron 通知 + badge 计数 |

### 未完成项

| 规划项 | 状态 | 说明 |
|--------|------|------|
| 需求看板拖拽排序 | ❌ | WishPage 已重构为对话式，无拖拽看板 |

---

## 四、TOOL-EXPANSION-PLAN.md (工具扩展) — 完成度 65%

### 工具定义统计

实际 tool-registry.ts 中定义了 **42+ 个工具**（不含动态 MCP 工具）：

| Tier | 规划 | 实际定义 | 执行器实现 | 说明 |
|------|------|---------|-----------|------|
| **已有基础 (17)** | read_file, write_file, edit_file, list_files, glob_files, search_files, run_command, run_test, run_lint, git_commit, git_diff, git_log, github_create_issue, github_list_issues, memory_read, memory_append, spawn_researcher, task_complete | ✅ 全部 | ✅ 全部 | |
| **Tier 1: 思考+互联网 (7)** | think, web_search, fetch_url, todo_write, todo_read, batch_edit, http_request | ✅ 全部 | ✅ 全部 | web-tools.ts + extended-tools.ts |
| **Tier 2: Computer Use (5)** | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | ✅ 全部定义 | ⚠️ 空壳 | computer-use.ts 存在但实际执行逻辑待验证 |
| **Tier 3: Playwright (10)** | browser_launch~close | ✅ 全部定义 | ⚠️ 空壳 | browser-tools.ts 存在但 playwright-core 未确认安装 |
| **Tier 4: 视觉验证 (3)** | analyze_image, compare_screenshots, visual_assert | ✅ 全部定义 | ⚠️ 空壳 | visual-tools.ts 存在 |
| **Tier 5: 游戏引擎** | engine_* 系列 | ❌ 未定义 | ❌ | 完全未开始 |
| **额外: 技能系统 (3)** | skill_acquire, skill_search, skill_improve, skill_record_usage | ✅ 定义 | ⚠️ | skill-evolution.ts + skill-loader.ts |

### 动态工具加载

| 规划 | 实际 |
|------|------|
| `getToolsForAgent(role, phase)` 按角色动态加载 | ✅ `getToolsForRole(role)` 实现，但无 phase 维度 |
| MCP 协议工具 | ✅ mcp-client.ts 动态加载外部 MCP 工具 |

### 关键差距

1. **Tier 2-4 工具定义完整但执行器可能为空壳**——定义在 tool-registry.ts，但 computer-use.ts / browser-tools.ts / visual-tools.ts 的实际执行逻辑需要逐一验证
2. **Tier 5 游戏引擎完全未开始**——无 engine-bridge.ts，无 unity/unreal bridge
3. **缺少 background 执行模式**——run_command 仍为同步 execSync，无长时间进程支持

---

## 五、architecture-optimization-analysis.md (v5优化) — 完成度 90%

| 优化项 | 状态 | 详情 |
|--------|------|------|
| 删除 tech_lead | ✅ | 已从 DEFAULT_TEAM 移除 |
| 移除 Developer 独立 planning 调用 | ✅ | react-loop.ts 不再调用 PLANNER_FEATURE_PROMPT |
| 合并 Phase 2 (PM设计文档) 到 Phase 3 (Architect) | ✅ | Architect prompt 包含设计职责 |
| 批量化 Phase 4 (子需求+测试规格) | ✅ | 每批 4-5 个 Feature |
| 批量化 PM 验收 | ✅ | 分组处理 |
| WorkflowPage 更新 | ✅ | 5阶段→v2.0紧凑版 |
| **Project Importer (4-Phase分析)** | ✅ | project-importer.ts ~620行 |
| **Hot/Cold Memory 分层** | ✅ | context-collector.ts collectLayeredContext() |
| **Compaction 上下文压缩** | ✅ | compactMessages() + trimToolResult() |
| 元Agent 职责边界 | ✅ | 轻量常驻+按需深入，meta-agent.ts IPC |

### 未完成

| 项目 | 状态 |
|------|------|
| Phase 4 增量更新 (git diff → 只重新分析变更模块) | ❌ 未实现 |
| tool result trimming 按需压缩 | ⚠️ trimToolResult 存在但未在所有工具中使用 |

---

## 六、ephemeral-workflow-design.md (临时工作流) — 完成度 60%

| 组件 | 规划 | 实际状态 |
|------|------|---------|
| **DB: missions + mission_tasks** | ✅ | db.ts 中建表 |
| **5种 Mission 类型** | ✅ 定义 | regression_test, code_review, retrospective, security_audit, perf_benchmark |
| **IPC: 7个处理器** | ✅ | missions.ts (create, list, get, cancel, delete, getTasks, retry) |
| **mission-runner.ts** | ✅ 有代码 | Planner→Worker→Judge 流程框架 |
| **WorkflowPage 集成** | ✅ | v2.0 常驻面板 + 任务卡片 |
| **Planner 实际 LLM 调用** | ⚠️ 待验证 | 代码框架存在，但实际 prompt 和执行逻辑的完整性未经测试 |
| **Worker 并行执行** | ⚠️ 待验证 | 同上 |
| **Judge 评估** | ⚠️ 待验证 | 同上 |
| **Patches 产出 & 应用** | ❌ 未实现 | 设计中有 patches 字段，但 UI 无 "应用patch" 功能 |
| **TTL 超时自动 fail** | ⚠️ 未确认 | 设计中有 ttlHours 但不确定是否实现 |
| **archivePolicy** | ❌ 未实现 | 设计中有 3 种策略，代码中可能使用默认 |

---

## 七、CLAUDE.md (项目大脑) — 严重过时

| 字段 | CLAUDE.md 内容 | 实际 |
|------|---------------|------|
| 当前阶段 | "Phase 1 — MVP 骨架搭建" | **远超 MVP，已是 v5.x 成熟产品** |
| 技术栈 | Tauri 2.x + Node sidecar | **Electron 33 + 全TS** |
| 架构 | monorepo: apps/desktop, packages/* | **单体: electron/ + src/** |
| 状态 | "Tauri桌面应用 [ ]" "React前端UI [ ]" | **全部完成且经过多次迭代** |

**⚠️ CLAUDE.md 需要全面重写**，当前内容与实际项目状态严重脱节。

---

## 八、全局差距汇总 (按重要度排序)

### 🔴 高优先级差距 (影响核心功能)

| # | 差距 | 来源 | 影响 |
|---|------|------|------|
| G1 | **并行Worker无共享决策日志** | REVIEW-v0.9 A4 | Worker间可能产出冲突代码 |
| G2 | **Sandbox无实质隔离** | REVIEW-v0.9 A3 | run_command 直接 execSync，安全风险 |
| G3 | **QA仍为纯文本审查，无程序化测试执行** | REVIEW-v0.9 C3 | 验证质量依赖 LLM 主观判断 |
| G4 | **Computer Use / Playwright / Visual 工具执行器未验证** | TOOL-EXPANSION Tier 2-4 | 42个工具定义但实际可用可能只有25个 |
| G5 | **CLAUDE.md 严重过时** | CLAUDE.md | 任何基于此文件的 Agent 行为都会被误导 |

### 🟡 中优先级差距 (影响效率/体验)

| # | 差距 | 来源 | 影响 |
|---|------|------|------|
| G6 | **Project Importer Phase 4 增量更新未实现** | optimization-analysis | 代码变更后无法自动更新文档 |
| G7 | **Ephemeral Mission 实际执行未经端到端测试** | ephemeral-design | 用户点击发起任务但可能失败 |
| G8 | **devops 角色定义但未使用** | DESIGN.md | 无自动构建/部署能力 |
| G9 | **RFC 机制 (Agent反向反馈) 未实现** | DESIGN.md | Agent 发现设计问题无法上报 |
| G10 | **Feature 两层清单退化为单层** | DESIGN.md | 大项目100+ Feature 时性能/token 浪费 |

### 🟢 低优先级差距 (锦上添花)

| # | 差距 | 来源 | 影响 |
|---|------|------|------|
| G11 | 游戏引擎集成 (Tier 5) | TOOL-EXPANSION | 特定场景需求 |
| G12 | Event Stream Replay UI | REVIEW-v0.9 C6 | 调试便利性 |
| G13 | Docker 沙箱 | TOOL-EXPANSION | 更强隔离 |
| G14 | TDD 模式 (先写测试再写代码) | REVIEW-v0.9 C3 | 代码质量 |
| G15 | AGENTS.md 自动生成 | REVIEW-v0.9 B3 | 项目规范传递 |

---

## 九、超额完成项 (规划中没有但已实现)

| 特性 | 说明 |
|------|------|
| **元Agent (MetaAgent)** | 跨项目管家，轻量常驻+按需深入，LLM 真实对话 |
| **科技感UI** | TechBackground canvas 粒子系统、CSS 动画 |
| **8篇新手教程** | GuidePage (LLM配置、GitHub、MCP 等) |
| **Agent 实时状态可视化** | 架构图头像+悬停详情、TeamPage/ContextPage 状态同步 |
| **MCP 协议支持** | mcp-client.ts 动态加载外部工具 |
| **技能进化系统** | skill-evolution.ts + skill-loader.ts |
| **跨项目经验迁移** | cross-project.ts |
| **导入已有项目 (4-Phase分析)** | project-importer.ts |
| **3层上下文记忆** | Hot/Warm/Cold 分层，超越原 3-layer memory 设计 |
| **右键版本历史菜单** | DocsPage + OutputPage |
| **项目文件夹自动填充** | ProjectsPage 创建时 |
| **全局右侧MetaAgent面板** | 可收起/展开 |

---

## 十、建议下一步优先级

1. **重写 CLAUDE.md** — 消除最大的"元数据债务"
2. **验证 Tier 2-4 工具执行器** — 确认 42 个工具中哪些真正可用
3. **实现共享决策日志 (G1)** — 并行 Worker 核心安全保障
4. **端到端测试 Ephemeral Mission** — 确保 5 种任务类型能走通
5. **QA 程序化测试** — 至少执行 run_test/run_lint 而非纯文本审查
