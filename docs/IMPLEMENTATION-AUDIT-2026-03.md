# AutoMater 实现审计报告 — 规划 vs 现状全面差距分析

> 审计日期: 2026-03-01 (v1.0), 2026-03-02 (v2.0 更新)
> 审计范围: DESIGN.md, REVIEW-v0.9.md, ITERATION-PLAN-v4.md, TOOL-EXPANSION-PLAN.md, architecture-optimization-analysis.md, ephemeral-workflow-design.md, CLAUDE.md
> 基线代码: commit `abbfe82` (v1.0), commit `bea2011` (v2.0)
> 修复状态: **15/15 差距已处理** (13 已修复, 2 有意跳过)

---

## 〇、总览评分

| 规划文档 | v1.0完成度 | v2.0完成度 | 质量评价 |
|----------|-----------|-----------|----------|
| **DESIGN.md** (初始设计) | 🟠 55% | 🟢 80% | 架构偏离已文档化(CLAUDE.md v6.0), DevOps已激活, RFC已实现, 两层索引已实现 |
| **REVIEW-v0.9.md** (业界对标) | 🟢 75% | 🟢 95% | G1 共享决策日志✅, G2 沙箱加固✅, G3 QA程序化测试✅, Replay UI✅, TDD✅ |
| **ITERATION-PLAN-v4.md** (v4迭代) | 🟢 85% | 🟢 95% | 唯一缺失: 需求看板拖拽(已被对话式UI替代) |
| **TOOL-EXPANSION-PLAN.md** (工具扩展) | 🟡 65% | 🟢 80% | Tier 1-4 验证完毕, Tier 5 有意跳过(游戏引擎为niche场景) |
| **architecture-optimization-analysis.md** (v5优化) | 🟢 90% | 🟢 98% | G6增量文档同步✅, 仅 tool result trimming 未全局应用 |
| **ephemeral-workflow-design.md** (临时工作流) | 🟡 60% | 🟢 85% | G7 Mission e2e完整, TTL/ArchivePolicy/Patches待补充 |

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

**评估**: 架构从 Tauri monorepo 简化为 Electron 单体。这是务实选择——Electron 开发更快，但 `DESIGN.md` 中规划的 `@AutoMater/core`、`@AutoMater/llm`、`@AutoMater/sandbox`、`@AutoMater/shared` 4个包 **全部未实现为独立模块**，代码全在 `electron/engine/` 下。

### 1.2 Agent 角色体系

| 规划角色 | 实际状态 | 备注 |
|----------|---------|------|
| **PM** | ✅ 完整实现 | 需求分析、Feature拆分、设计文档、子需求、验收审查 |
| **Architect** | ✅ 完整实现 | 架构设计+产品设计合并一步 |
| **Developer** | ✅ 完整实现 | ReAct 循环，25轮上限，40+工具 |
| **QA** | ✅ 完整实现 | 代码质量审查 + 测试规格生成 |
| **Code Reviewer** | ❌ 未实现 | 职责合并到 QA |
| **DevOps** | ✅ v6.0 已激活 | `phaseDevOpsBuild()` 在 orchestrator Phase 5 自动构建 |

### 1.3 工作流模型

| 规划 | 实际 |
|------|------|
| 3阶段 (Init→Iterative→Delivery) | ✅ 5阶段流水线 (v5.0 优化后) |
| PM→Architect→Developer→QA→Reviewer→DevOps | PM→Architect→(PM+QA)→Developer→(QA+PM)→User |
| Feature 两层清单 (索引层+详情层) | ✅ v6.0 group affinity + getFeatureGroupSummary() |
| RFC 机制 (Agent反向反馈) | ✅ v6.0 `rfc_propose` 工具, pm/architect/developer/qa 均可调用 |
| HITL 审批门 (文件级) | ✅ 用户验收面板 (项目级) |
| FeatureSelector 智能选择 | ⚠️ `lockNextFeature` 简单按优先级+todo状态锁定 |
| 并行 Worker 协调 | ✅ v6.0 decision-log.ts 文件级 claim/release/冲突检测 |

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
| **并行Worker无上下文共享** | 🔴 P0 | ✅ v6.0修复 | decision-log.ts 文件级 claim/release/冲突检测, 集成到 workerLoop |
| **没有 Sandbox** | 🔴 P0 | ✅ v6.0加固 | sandbox-executor.ts 路径逃逸检测+命令黑名单28项+符号链接检查 |

### 2.2 P1 问题修复状态

| 问题 | 修复状态 | 实际做法 |
|------|---------|----------|
| **3层记忆系统** | ✅ 已实现 | memory-system.ts (Global + Project + Agent Role)，cross-project.ts 跨项目经验 |
| **自动经验提取** | ✅ 已实现 | orchestrator.ts `extractLessons()` (QA fail→fix 成功后自动) |
| **AGENTS.md 规范** | ✅ v6.0 | orchestrator 每次运行自动重新生成 AGENTS.md (G15) |
| **并行Worker协调** | ✅ v6.0修复 | decision-log.ts 共享决策日志 (同上 P0 修复) |
| **ACI 设计粗糙** | ✅ 大幅改善 | edit_file (str_replace)、batch_edit、read_file (行号+分页)、search_files (上下文行) |

### 2.3 P2 问题修复状态

| 问题 | 修复状态 | 实际做法 |
|------|---------|----------|
| **模型选择不灵活** | ✅ 改善 | model-selector.ts (strong/worker/fast 按任务类型选择) |
| **验证能力弱 (QA纯文本)** | ✅ v6.0 改善 | qa-loop.ts 强制执行 run_test/run_lint (G3), 测试失败=硬失败(score 30) |
| **缺乏可观测性** | ✅ 大幅改善 | agent:react-state 事件、agent:context-snapshot、ContextTimeline SVG、tool call 追踪、持久化日志 |
| **Event Stream + Replay** | ✅ v6.0 | TimelinePage 5-tab: 时间线/重放/分析/检查点/经验池 (G12) |

### 2.4 路线图执行对照

| 规划版本 | 规划内容 | 实际状态 |
|---------|----------|---------|
| v1.0 | A1 str_replace edit + A2 repo map + B3 AGENTS.md | ✅ A1/A2完成, B3部分 |
| v1.1 | A3 sandbox + B1 3-layer memory + B2 auto lessons | ✅ A3加固完成, ✅ B1/B2 |
| v1.2 | A4 shared decision log + C1 summarizer + C3 TDD | ✅ A4 decision-log.ts, ✅ C1完成, ✅ C3 qa-loop TDD模式 |
| v1.3 | C2 code graph + C4 sub-agent + C5 dynamic model | ✅ C2完成, ✅ C4完成 (spawn_researcher), ✅ C5完成 |
| v2.0 | C6 event stream + B4 cross-project + Multi-day missions | ✅ C6 replay完整, ✅ B4完成, ✅ Missions完成 |

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
| 文档体系 (.AutoMater/docs/) | ✅ | doc-manager.ts (设计文档/子需求/测试规格) |
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
| **Tier 2: Computer Use (5)** | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | ✅ 全部定义 | ✅ 已验证 | computer-use.ts 真实实现 (G4 ✅) |
| **Tier 3: Playwright (10)** | browser_launch~close | ✅ 全部定义 | ✅ 已验证 | browser-tools.ts + playwright-core@1.58.2 (G4 ✅) |
| **Tier 4: 视觉验证 (3)** | analyze_image, compare_screenshots, visual_assert | ✅ 全部定义 | ✅ 已验证 | visual-tools.ts 有实现逻辑 (G4 ✅) |
| **Tier 5: 游戏引擎** | engine_* 系列 | ❌ 有意跳过 | ❌ | niche场景, 优先级最低 |
| **额外: 技能系统 (3)** | skill_acquire, skill_search, skill_improve, skill_record_usage | ✅ 定义 | ⚠️ | skill-evolution.ts + skill-loader.ts |

### 动态工具加载

| 规划 | 实际 |
|------|------|
| `getToolsForAgent(role, phase)` 按角色动态加载 | ✅ `getToolsForRole(role)` 实现，但无 phase 维度 |
| MCP 协议工具 | ✅ mcp-client.ts 动态加载外部 MCP 工具 |

### 关键差距

1. ~~**Tier 2-4 工具定义完整但执行器可能为空壳**~~ → ✅ G4 已验证, 所有 Tier 1-4 执行器真实可用
2. **Tier 5 游戏引擎有意跳过**——无 engine-bridge.ts，为 niche 场景，暂不投入
3. **缺少 background 执行模式**——run_command 仍为同步 execSync，无长时间进程支持 → v2.0 迭代中

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
| Phase 4 增量更新 (git diff → 只重新分析变更模块) | ✅ v6.0 phaseIncrementalDocSync() 已实现 (G6) |
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
| **Planner 实际 LLM 调用** | ✅ 已验证 | callLLM → strongModel, JSON plan 解析, 20 task 上限 |
| **Worker 并行执行** | ✅ 已验证 | Promise.allSettled 批量并行, maxWorkers 默认 3 |
| **Judge 评估** | ✅ 已验证 | callLLM → strongModel, 汇总报告 + 通过率评判 |
| **Patches 产出 & 应用** | ⚠️ 框架存在 | MissionResult.patches 类型定义完整, 但 Worker 未产出实际文件 diff → v2.0 迭代中 |
| **TTL 超时自动 fail** | ⚠️ 待补充 | config.ttlHours 字段定义但未实现超时检测 → v2.0 迭代中 |
| **archivePolicy** | ⚠️ 待补充 | 设计中有 3 种策略, 当前使用默认 keep-all → v2.0 迭代中 |

---

## 七、CLAUDE.md (项目大脑) — ✅ v6.0 已重写

CLAUDE.md 已在 G5 修复中全面重写为 v6.0，准确反映 Electron + TypeScript 架构、5-phase pipeline、42+ 工具、13 页面等实际状态。

---

## 八、全局差距汇总 (按重要度排序)

### 🔴 高优先级差距 (影响核心功能) — ✅ 全部修复

| # | 差距 | 来源 | 修复状态 |
|---|------|------|---------|
| G1 | **并行Worker共享决策日志** | REVIEW-v0.9 A4 | ✅ decision-log.ts (commit e2d9342) |
| G2 | **Sandbox加固** | REVIEW-v0.9 A3 | ✅ 路径逃逸+黑名单+符号链接检查 (commit e2d9342) |
| G3 | **QA程序化测试执行** | REVIEW-v0.9 C3 | ✅ qa-loop.ts 强制run_test/run_lint (commit e2d9342) |
| G4 | **Tier 2-4 工具执行器验证** | TOOL-EXPANSION | ✅ 验证通过 (commit e2d9342) |
| G5 | **CLAUDE.md 重写** | CLAUDE.md | ✅ v6.0 全面重写 (commit e2d9342) |

### 🟡 中优先级差距 — ✅ 全部修复

| # | 差距 | 来源 | 修复状态 |
|---|------|------|---------|
| G6 | **增量文档同步** | optimization-analysis | ✅ phaseIncrementalDocSync (commit 7fe9f8f) |
| G7 | **Ephemeral Mission e2e** | ephemeral-design | ✅ AbortController + 完整执行链 (commit e2d9342) |
| G8 | **DevOps 角色激活** | DESIGN.md | ✅ phaseDevOpsBuild 在 orchestrator Phase 5 (commit 7fe9f8f) |
| G9 | **RFC 机制** | DESIGN.md | ✅ rfc_propose 工具 + change_requests DB (commit e2d9342) |
| G10 | **Feature 两层索引** | DESIGN.md | ✅ group affinity + getFeatureGroupSummary (commit 7fe9f8f) |

### 🟢 低优先级差距

| # | 差距 | 来源 | 修复状态 |
|---|------|------|---------|
| G11 | 游戏引擎集成 (Tier 5) | TOOL-EXPANSION | ⏭️ 有意跳过 (niche 场景) |
| G12 | Event Stream Replay UI | REVIEW-v0.9 C6 | ✅ TimelinePage 5-tab replay (commit 7fe9f8f) |
| G13 | Docker 沙箱 | TOOL-EXPANSION | ⏭️ 有意跳过 (需 Docker Desktop, 非核心) |
| G14 | TDD 模式 | REVIEW-v0.9 C3 | ✅ qa-loop.ts generateTestSkeleton (commit 7fe9f8f) |
| G15 | AGENTS.md 自动生成 | REVIEW-v0.9 B3 | ✅ orchestrator 每次运行自动生成 (commit 7fe9f8f) |

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

## 十、v2.0 迭代方向 (G1-G15 完成后)

### 已完成
1. ~~重写 CLAUDE.md~~ ✅ G5
2. ~~验证 Tier 2-4 工具执行器~~ ✅ G4
3. ~~实现共享决策日志~~ ✅ G1
4. ~~端到端测试 Ephemeral Mission~~ ✅ G7
5. ~~QA 程序化测试~~ ✅ G3

### v2.0 进阶优化
1. **Mission Patches 产出** — Worker 产出文件修改建议时生成实际 diff patch, UI 支持 "应用patch" 按钮
2. **Mission TTL 超时** — 实现 ttlHours 到期自动 fail + 3 种归档策略 (keep-all/keep-conclusion/delete)
3. **异步命令执行** — sandbox-executor 增加 spawn 异步模式, 支持长时间进程 + 实时 stdout 流式输出
4. **智能搜索增强** — search_files 增加 TF-IDF 关键词加权排序, 不依赖向量模型但比纯 grep 更智能
5. **全局 trimToolResult** — 在所有工具返回路径统一应用 trimToolResult, 节省上下文窗口
