# 智械母机 AutoMater — 项目大脑

> 最后更新: 2026-03-04 | 版本: v29.0 | **由代码实际盘点生成，非手工维护**

## 1. PRIME DIRECTIVE

**当前阶段**: v29.0 — Session-Agent调度系统 + 管家记忆项目隔离 + DAG工作流引擎 + 思维链可视化
**最高优先级**: 实际运行时全链路验证 (PM→Dev→QA 全流程) + 竞争力 5.61→7.0 路线图执行
**MUST NOT**: 不破坏现有流水线, 不明文存储密钥, 不新增 `any`

## 2. PROJECT IDENTITY

**产品**: 智械母机 AutoMater — AI Agent 集群式软件开发桌面应用
**定位**: "AI 软件开发公司" — 用户许愿(Wish)，虚拟团队(PM/Architect/Developer/QA)自主交付完整软件
**目标用户**: 非程序员或需要快速原型的开发者

### 技术栈

| 层 | 技术 |
|----|------|
| Desktop | **Electron 33** (Main + Renderer + Preload) |
| Frontend | React 19 + TypeScript 5 + Vite 6 + Tailwind CSS 3 |
| State | Zustand 5 (单 Store, Map-based) |
| Agent Engine | TypeScript (Electron Main Process, 全同步架构) |
| LLM | 统一适配层: OpenAI 兼容 + Anthropic 原生双协议 |
| Database | SQLite (better-sqlite3, 同步 API, **22 张表**, 18 版迁移) |
| Build | pnpm + Vite (renderer) + tsc (main/preload) + electron-builder |
| Test | Vitest 4 + @vitest/coverage-v8 (50 测试文件, 918 tests) |
| Lint | ESLint 10 + Prettier 3 |
| Package | ~355MB Windows installer (win:dir) |

### 目录结构

```
AutoMater/
├── electron/                   # Electron 主进程
│   ├── main.ts                 # 入口, 窗口管理, IPC 注册
│   ├── preload.ts              # Context Bridge (22 个命名空间)
│   ├── db.ts                   # SQLite 数据库 (22 张表, 18 版 Migration)
│   ├── ipc/                    # IPC Handlers (12 个文件)
│   │   ├── ipc-validator.ts      # IPC 输入校验 (50+ 断言)
│   │   ├── project.ts          # project:* (CRUD, start, stop, analyze, docs, changes)
│   │   ├── meta-agent.ts       # meta-agent:* (chat, config, memory CRUD)
│   │   ├── missions.ts         # mission:* (CRUD, cancel, patches)
│   │   ├── sessions.ts         # session:* (create, switch, backup, feature-links)
│   │   ├── workflow.ts         # workflow:* (预设 CRUD, activate, stages)
│   │   ├── settings.ts         # settings:* (get, save)
│   │   ├── llm.ts              # llm:* (test, chat, list-models)
│   │   ├── mcp.ts              # mcp:* (server CRUD, connect, tools)
│   │   ├── events.ts           # events:* (query, stats, timeline, export)
│   │   ├── monitor.ts          # monitor:* (system-metrics, activity, pricing)
│   │   └── workspace.ts        # workspace:* (tree, read-file, get-path)
│   └── engine/                 # Agent 引擎核心
│       ├── phases/             # 编排器拆分阶段 (10 个文件)
│       ├── probes/             # 项目分析探针 (8 个文件)
│       │   ├── index.ts, base-probe.ts
│       │   ├── api-boundary-probe.ts, config-infra-probe.ts
│       │   ├── data-model-probe.ts, entry-probe.ts
│       │   ├── module-probe.ts, smell-probe.ts
│       │   └──
│       ├── tool-defs/          # 工具定义按类别拆分 (12 个文件)
│       │   ├── index.ts, types.ts
│       │   ├── fs-tools.ts, shell-tools.ts, git-tools.ts
│       │   ├── web-tools.ts, memory-tools.ts, agent-tools.ts
│       │   ├── computer-tools.ts, deploy-tools.ts
│       │   └── admin-tools.ts, session-tools.ts
│       ├── __tests__/          # 单元测试 (50 个文件, 918 tests)
│       ├── orchestrator.ts     # 多阶段编排器 (入口, v12 可配置工作流)
│       ├── react-loop.ts       # Developer ReAct 循环 (50 轮上限, 验证门控)
│       ├── qa-loop.ts          # QA 审查 (程序化 + LLM + TDD)
│       ├── tool-registry.ts    # 工具注册中心 + 角色权限矩阵
│       ├── tool-definitions.ts # 130 工具定义 (re-export barrel → tool-defs/)
│       ├── tool-executor.ts    # 工具执行分发 (同步)
│       ├── tool-handlers-async.ts  # 工具异步执行器
│       ├── tool-handlers-external.ts # 外部工具执行器 (MCP/Skill)
│       ├── tool-permissions.ts # 角色-工具权限矩阵
│       ├── tool-system.ts      # 工具系统抽象层
│       ├── llm-client.ts       # LLM 调用 (流式/非流式, Anthropic/OpenAI)
│       ├── model-selector.ts   # strong/worker/fast 三层模型选择
│       ├── context-collector.ts    # 3 层上下文 (Hot/Warm/Cold)
│       ├── context-compaction.ts   # 上下文压缩策略
│       ├── sandbox-executor.ts     # 子进程沙箱 (命令黑名单+环境隔离)
│       ├── mission-runner.ts   # 临时工作流 (Planner→Worker→Judge)
│       ├── mission.ts          # Mission 持久化 + checkpoint
│       ├── project-importer.ts # 已有项目导入 (4-Phase Scanner + 增量更新)
│       ├── doc-manager.ts      # 文档 CRUD (设计/需求/测试规格)
│       ├── change-manager.ts   # 需求变更检测 + 级联更新
│       ├── memory-system.ts    # 3 层记忆 (Global/Project/Role)
│       ├── memory-layers.ts    # 记忆层实现细节
│       ├── skill-evolution.ts  # 技能习得/进化/跨项目共享
│       ├── skill-loader.ts     # 技能文件加载器
│       ├── mcp-client.ts       # MCP 协议动态工具加载
│       ├── browser-tools.ts    # Playwright 浏览器自动化 (10 工具)
│       ├── computer-use.ts     # Windows 截图/鼠标/键盘 (5 工具)
│       ├── visual-tools.ts     # Vision LLM 图像分析 (3 工具)
│       ├── web-tools.ts        # Web 搜索/抓取 (3 工具)
│       ├── extended-tools.ts   # 扩展工具集 (部署等)
│       ├── deploy-tools.ts     # 部署工具
│       ├── docker-sandbox.ts   # Docker 沙箱 (预留)
│       ├── experience-harvester.ts  # 经验收割器 (失败模式提取)
│       ├── experience-library.ts   # 经验库 (错误经验主动检索)
│       ├── cloudflare-tools.ts     # Cloudflare部署工具
│       ├── supabase-tools.ts       # Supabase部署工具
│       ├── parallel-tools.ts       # 并行执行工具
│       ├── code-search.ts          # 代码搜索工具
│       ├── issue-watcher.ts        # Issue监控器
│       ├── probe-cache.ts          # 探针缓存
│       ├── probe-orchestrator.ts   # 探针编排器
│       ├── tool-result-summarizer.ts # 工具结果摘要压缩
│       ├── workflow-engine.ts      # DAG工作流引擎 (transition-driven)
│       ├── safe-json.ts            # 安全JSON解析
│       ├── image-gen.ts            # 图像生成工具
│       ├── secret-manager.ts   # 密钥加密存储管理
│       ├── prompts.ts          # Agent 提示词模板
│       ├── types.ts            # 共享类型定义
│       ├── constants.ts        # 常量
│       ├── logger.ts           # 结构化日志
│       ├── guards.ts           # 安全防护 (路径/命令) + 验证门控 + 语义死循环检测
│       ├── scratchpad.ts       # Agent 工作记忆 (文件变更/进度/经验自动收集)
│       ├── adaptive-tool-selector.ts  # 自适应工具选择 (项目 profile + 阶段感知)
│       ├── sub-agent-compressor.ts    # 子Agent结果压缩 (防上下文膨胀)
│       ├── iteration-learning.ts      # 迭代间学习 (失败模式提取+策略修正)
│       ├── runtime-telemetry.ts       # 运行时遥测 (工具链/Token/成本追踪)
│       ├── output-parser.ts    # LLM 输出解析
│       ├── planner.ts          # 规划器
│       ├── repo-map.ts         # 仓库结构映射
│       ├── code-graph.ts       # 代码依赖图谱
│       ├── search-provider.ts  # 搜索提供者 (DDG/Bing/Google HTML scraping)
│       ├── research-cache.ts   # 研究结果缓存
│       ├── research-engine.ts  # 研究子Agent引擎
│       ├── sub-agent.ts        # 子Agent框架
│       ├── sub-agent-framework.ts  # 子Agent高级框架
│       ├── git-provider.ts     # Git 操作封装
│       ├── workspace-git.ts    # 工作区 Git 管理
│       ├── event-store.ts      # 事件流持久化
│       ├── conversation-backup.ts  # 会话备份/恢复 + Session-Agent调度集成
│       ├── session-scheduler.ts    # Session并发调度器 (并发上限+僵尸锁清理)
│       ├── session-lifecycle.ts    # Session生命周期管理 (create/start/suspend/complete)
│       ├── scheduler-bus.ts        # 调度事件总线 (发布/订阅调度事件)
│       ├── cross-project.ts    # 跨项目经验共享
│       ├── decision-log.ts     # 决策日志
│       ├── file-lock.ts        # 文件级锁 (并行 Worker)
│       ├── file-writer.ts      # 安全文件写入
│       ├── agent-manager.ts    # Agent 实例管理
│       ├── system-monitor.ts   # 系统性能监控
│       ├── runtime-telemetry.ts    # 运行时遥测
│       ├── ui-bridge.ts        # 主进程→渲染进程通知桥
│       ├── react-resilience.ts # ReAct 循环容错
│       ├── blackbox-test-runner.ts # 黑盒测试执行器
│       └── probe-types.ts      # 探针类型定义
├── src/                        # React 渲染进程
│   ├── App.tsx                 # 路由 + 全局布局
│   ├── stores/
│   │   └── app-store.ts        # Zustand Store (单 Store)
│   ├── pages/                  # 14 个页面
│   │   ├── ProjectsPage.tsx    # 项目列表 + 新建 + 导入
│   │   ├── OverviewPage.tsx    # 指挥中心 (架构图 + Agent 头像)
│   │   ├── overview/           # Overview 子组件 (8 文件)
│   │   │   ├── InteractiveGraph.tsx, AgentActivityPanel.tsx
│   │   │   ├── PipelineBar.tsx, ProgressRing.tsx
│   │   │   ├── DocCompletionBar.tsx, StatCard.tsx
│   │   │   └── types.ts, index.ts
│   │   ├── WishPage.tsx        # 许愿台 + 元Agent 对话
│   │   ├── WorkflowPage.tsx    # 工作流可视化 + 预设管理 (v12)
│   │   ├── TeamPage.tsx        # 团队配置 + 成员级 LLM/MCP (v11)
│   │   ├── DocsPage.tsx        # 5 级文档树浏览器
│   │   ├── OutputPage.tsx      # 代码输出浏览
│   │   ├── LogsPage.tsx        # Agent 日志 (过滤/搜索)
│   │   ├── ContextPage.tsx     # 上下文管理器 (Hot/Warm/Cold 可视化)
│   │   ├── BoardPage.tsx       # 看板视图 (Feature-Session 关联 v8.1)
│   │   ├── TimelinePage.tsx    # 时间线 (事件重放)
│   │   ├── GuidePage.tsx       # 8 篇新手教程
│   │   └── SettingsPage.tsx    # LLM/MCP/密钥/模型配置
│   └── components/             # 20 个组件
│       ├── Sidebar.tsx         # 左侧导航
│       ├── MetaAgentPanel.tsx  # 右侧元Agent 全局面板 (v29: 模式切换增强)
│       ├── MetaAgentSettings.tsx   # 元Agent 配置面板 (v29: 记忆项目隔离)
│       ├── SessionManager.tsx  # 会话管理器 (v8)
│       ├── SessionPanel.tsx    # 会话详情面板
│       ├── AcceptancePanel.tsx # 用户验收面板
│       ├── ActivityCharts.tsx  # 活动图表
│       ├── AgentWorkFeed.tsx   # Agent 工作流 (Echo风格思维链+工具diff)
│       ├── ChatInput.tsx       # 对话输入框 (附件支持)
│       ├── ContextMenu.tsx     # 右键菜单
│       ├── EmptyState.tsx      # 空状态占位组件
│       ├── ErrorBoundary.tsx   # React 错误边界
│       ├── GlobalSearchBar.tsx # 全局搜索栏
│       ├── MessageAttachments.tsx # 消息附件显示
│       ├── Onboarding.tsx      # 新手引导
│       ├── ProjectBar.tsx      # 项目切换栏
│       ├── StatusBar.tsx       # 底部状态栏
│       ├── SystemMonitor.tsx   # 系统监控面板
│       ├── TechBackground.tsx  # Canvas 粒子动效
│       └── Toast.tsx           # Toast通知组件
├── docs/                       # 设计文档 + 审计报告
├── scripts/                    # 构建/质量门禁脚本
├── prompts/                    # 外置提示词模板
└── __mocks__/                  # 测试 Mock
```

## 3. ARCHITECTURE

### 流水线 (v6.0 → v12.0 可配置工作流)

```
Phase 1:  PM 需求分析 → Feature 清单 (带 group_id 两层索引)
Phase 2:  Architect 架构+产品设计 → ARCHITECTURE.md + design.md
Phase 3:  批量子需求拆分 + 测试规格 (每批 5 Features)
Phase 4a: [TDD可选] QA 生成测试骨架
Phase 4b: Developer ReAct 实现 + QA 审查 + 自动重试 (最多 3 轮)
Phase 4c: PM 批量验收
Phase 4d: 增量文档同步 (git diff → 受影响模块摘要自动更新)
Phase 4e: DevOps 自动构建验证 (检测框架 → install/lint/test/build)
Phase 5:  汇总 + AGENTS.md 自动生成 + 用户验收等待
```

v12.0 起支持 **工作流预设 (Workflow Presets)** — 用户可自定义阶段组合、跳过/重排阶段。

续跑时: PM 分诊 (detectImplicitChanges) 判断新需求 vs 迭代变更。

### Agent 角色

| 角色 | ID 模式 | 工具数 | 职责 |
|------|---------|--------|------|
| PM | pm-* | 11 | 需求分析, Feature 拆分, 设计文档, 验收审查 |
| Architect | architect-* | 11 | 架构设计, ARCHITECTURE.md, 技术选型 |
| Developer | developer-* | 37+ | ReAct 编码, 文件/Shell/Git/浏览器/视觉/MCP |
| QA | qa-* | 24 | 程序化检查 + LLM 审查, 测试执行, TDD |
| DevOps | devops-* | 10 | 自动构建验证 (install→lint→test→build) |
| Researcher | researcher-* | 6 | 只读子 Agent, 8 轮上限 |

### 元 Agent (v5.4 → v29.0 管家4模式系统 + 上下文管理 + 附件 + 记忆项目隔离)

- **位置**: 全局右侧可收起面板 + WishPage 右侧
- **职责**: 跨项目路由, 需求接收转发, 工作流管理, 查询项目技术/设计细节, **团队/项目直接管理 (admin模式)**
- **后端**: `electron/ipc/meta-agent.ts` + `electron/engine/meta-agent-daemon.ts`
- **4种对话模式**:
  | 模式 | ID | 职责 | 工具集 | 迭代上限 |
  |------|-----|------|--------|--------|
  | 工作模式 | work | 需求接收→create_wish→委派团队 | 全量工具 | 50 |
  | 闲聊模式 | chat | 轻松对话, 技术咨询, 不执行任务 | 最小工具集 | 5 |
  | 深度讨论 | deep | 深度分析, 可写文件/编辑/派任务 | 全量+write/edit | 80 |
  | 管理模式 | admin | 直接管理团队/工作流/项目配置 | 9个admin_*工具 | 30 |
- **Per-Mode 配置**: `ModeConfig { maxReactIterations, maxResponseTokens, contextHistoryLimit, contextTokenLimit }` 可在设置面板独立调整
- **管家守护进程**: Heartbeat 定时检查 + 事件钩子 + Cron 任务 (meta-agent-daemon.ts ~400行)
- **设置面板**: 4 Tab — 基础配置 / 模式参数 / 记忆管理 / 自主行为
- **数据表**: `meta_agent_config` + `meta_agent_memories` + `meta_agent_chat_messages` + `meta_agent_heartbeat_log`
- **模式切换**: ModeSwitchBadge UI组件, session.updateChatMode IPC, sessions.chat_mode 列持久化

### 数据库 (SQLite, 22 张表, schema_version 迁移体系, 18 版)

**核心建表** (initDatabase 创建):

| 表 | 主要字段 | 用途 |
|----|---------|------|
| schema_version | key, value | 迁移版本追踪 |
| settings | key, value | 应用配置 (LLM/MCP/UI) |
| projects | id, name, wish, status, workspace_path, config, git_mode, github_repo | 项目 |
| features | id, project_id, category, priority, status, locked_by, group_id, github_issue_number, github_pr_number, github_branch | Feature (两层索引 + GitHub 关联) |
| agents | id, project_id, role, status, token/cost 统计 | Agent 实例 |
| agent_logs | project_id, agent_id, type, content | 持久化日志 |

**迁移创建** (MIGRATIONS v1-v18):

| 表 | 迁移版本 | 主要字段 | 用途 |
|----|---------|---------|------|
| wishes | v2 | id, project_id, content, status, pm_analysis | 需求队列 |
| team_members | v2 (→v8→v11) | id, project_id, role, system_prompt, llm_config, mcp_servers, skills | 自定义团队 (v11: 成员级独立配置) |
| change_requests | v4 | id, project_id, description, impact_analysis | 变更管理 |
| missions | v5 | id, project_id, type, status, plan, conclusion, patches | 临时工作流 |
| mission_tasks | v5 | id, mission_id, title, status, input, output | 工作流子任务 |
| meta_agent_config | v7 | key, value | 元Agent 配置 |
| meta_agent_memories | v7 | id, category, content, importance | 元Agent 持久记忆 |
| meta_agent_chat_messages | v7 (ensureTable) | session_id, role, content | 管家对话消息持久化 |
| workflow_presets | v9 | id, project_id, name, stages, is_active | 工作流预设 (v12) |
| project_secrets | v10 | project_id, key, value (加密), provider | 密钥安全存储 (v13) |

v11: team_members 增加 max_iterations 列 (可配置 Agent 最大迭代数)
v12: context_window 默认值从 128000 升级到 256000
v13: features.summary 列 — PM 一句话摘要用于索引层
v14: agents 表改复合主键 (id, project_id)
v15: sessions.chat_mode 列 — 管家会话模式 (work/chat/deep/admin)
v16: sessions 置顶/重命名/隐藏 — pinned, custom_title, hidden 列
v17: Session-Agent 调度系统 — sessions.member_id/feature_id/started_at/suspended_at/error_message + team_members.max_concurrent_sessions + features.locked_at + 索引
v18: 管家记忆项目隔离 — meta_agent_memories.project_id + 索引

**模块自管理表** (ensureXxxTable):

| 表 | 管理模块 | 用途 |
|----|---------|------|
| events | event-store.ts | 事件流持久化 |
| checkpoints | mission.ts | 流水线断点恢复 |
| sessions | conversation-backup.ts | 会话备份/恢复 (v15: +chat_mode列) |
| feature_sessions | conversation-backup.ts | Feature↔Session 关联 (v8.1) |
| meta_agent_heartbeat_log | meta-agent-daemon.ts | 守护进程心跳日志 |

### 130 工具体系

| 类别 | 工具名 | 状态 |
|------|--------|------|
| **文件** (12) | read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files, code_search, code_search_files, read_many_files, repo_map, code_graph_query | ✅ |
| **Shell** (5) | run_command, run_test, run_lint, check_process, wait_for_process | ✅ 沙箱执行 |
| **Git** (10) | git_commit, git_diff, git_log, git_create_branch, git_delete_branch, git_switch_branch, git_fetch, git_pull, git_push, git_list_branches | ✅ |
| **GitHub** (9) | github_create_issue, github_list_issues, github_get_issue, github_close_issue, github_add_comment, github_create_pr, github_list_prs, github_get_pr, github_merge_pr | ✅ v13 |
| **思考/计划** (8) | think, todo_write, todo_read, report_blocked, task_complete, rfc_propose, scratchpad_write, scratchpad_read | ✅ |
| **记忆** (3) | memory_read, memory_append, spawn_researcher | ✅ |
| **Web** (8) | web_search, web_search_boost, deep_research, configure_search, fetch_url, download_file, search_images, http_request | ✅ Zero-key |
| **Computer Use** (5) | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | ✅ Windows |
| **Playwright** (16) | browser_launch/navigate/click/type/screenshot/snapshot/evaluate/wait/network/close/hover/select_option/press_key/fill_form/drag/tabs/file_upload/console | ✅ |
| **视觉** (3+) | analyze_image, compare_screenshots, visual_assert, generate_image, edit_image, configure_image_gen | ✅ Vision LLM |
| **技能** (4) | skill_acquire, skill_search, skill_improve, skill_record_usage | ✅ |
| **子Agent** (5) | spawn_agent, spawn_parallel, list_sub_agents, cancel_sub_agent, run_blackbox_tests | ✅ |
| **沙箱** (5) | sandbox_init, sandbox_exec, sandbox_write, sandbox_read, sandbox_destroy | ✅ |
| **部署** (13) | deploy_*(nginx/pm2/compose/dockerfile/port) + cloudflare_*(deploy_pages/worker/dns/secret/status) + supabase_*(status/deploy/migration/types/secret/db_pull) | ✅ |
| **元Agent** (1) | create_wish | ✅ 委派任务给团队 |
| **Admin** (9) | admin_list_members, admin_add_member, admin_update_member, admin_remove_member, admin_list_workflows, admin_activate_workflow, admin_update_workflow, admin_update_project, admin_get_available_stages | ✅ v21 (仅admin模式) |
| **Session** (2) | list_conversation_sessions, read_conversation_history | ✅ v28 |
| **MCP** | 动态加载外部工具 | ✅ mcp-client.ts |

### IPC 命名空间 (preload.ts — 23 个)

| 命名空间 | 引入版本 | 说明 |
|----------|---------|------|
| `settings` | v1 | 应用配置 CRUD |
| `llm` | v1 | LLM 连接测试/对话/模型列表 |
| `project` | v1 | 项目全生命周期 (CRUD, start, stop, docs, changes, analyze) |
| `wish` | v3.1 | 需求队列 CRUD |
| `team` | v3.1→v11 | 团队成员管理 + 成员级 LLM 测试 |
| `workspace` | v1 | 工作区文件树/读取 |
| `events` | v2 | 事件流查询/统计/导出 |
| `mission` | v2 | Mission 状态/断点/进度 |
| `knowledge` | v2 | 知识库查询 |
| `on` | v1 | 事件订阅 (主进程→渲染进程) |
| `mcp` | v5 | MCP 服务器 CRUD + 工具列表 |
| `skill` | v5 | 技能目录管理 |
| `skillEvolution` | v5.1 | 技能进化索引/排名/详情 |
| `dialog` | v5.1 | 文件夹选择对话框 |
| `secrets` | v13 | 密钥加密存储 CRUD |
| `metaAgent` | v5.4→v21 | 元Agent 对话 + 配置 + 记忆 + 守护进程 (7 daemon API) |
| `ephemeralMission` | v5.5 | 临时工作流 CRUD + cancel + patches |
| `context` | v5.6 | 上下文基线预览 |
| `session` | v8→v21 | 会话管理 + Feature-Session 关联 + updateChatMode |
| `workflow` | v12 | 工作流预设 CRUD + activate + stages |
| `zoom` | v5.2 | 缩放控制 (webFrame, 无 IPC) |
| `monitor` | v6 | 系统性能/活动时序/模型价格 |
| `issues` | v20 | GitHub Issues 查询 |

### 核心设计决策

| # | 决策 | 理由 |
|---|------|------|
| ADR-001 | Electron 而非 Tauri | 开发速度, Node.js 生态成熟度, LLM SDK 丰富 |
| ADR-002 | 全 TypeScript (Main + Renderer) | 无 Rust sidecar, 统一语言降低复杂度 |
| ADR-003 | 单体架构 (electron/ + src/) | 比 monorepo 更简单, 模块化通过文件划分 |
| ADR-004 | better-sqlite3 同步 API | Electron 主进程友好, 无 async 竞态 |
| ADR-005 | 3 层模型选择 (strong/worker/fast) | 控制 Token 成本: 规划用 strong, 编码用 worker |
| ADR-006 | ReAct + 内嵌 Planning (无独立 Planner 调用) | 减少 Token 开销, 2026 最佳实践 |
| ADR-007 | 文档驱动开发 (.AutoMater/docs/) | ARCHITECTURE.md + 子需求 + 测试规格驱动代码生成 |
| ADR-008 | schema_version 迁移体系 (v12.1→v18) | 替代 try-catch 吞错误, 可审计版本演进 |

## 4. CURRENT STATE

**版本**: v29.0 (Session-Agent调度系统 + 管家记忆项目隔离 + DAG工作流引擎 + 思维链可视化 + 130工具)

### 版本演进总览

| 版本 | 核心特性 |
|------|---------|
| v1-v3 | 基础流水线, ReAct 循环, 工具体系, 许愿系统 |
| v4 | 需求变更检测, Feature 两层索引, 文档浏览器, TDD |
| v5 | MCP 协议, 技能进化, 临时工作流, 元Agent, 项目导入 |
| v6 | DevOps 自动构建, 增量文档, 事件重放, 并行 Worker |
| v7 | 元Agent 持久记忆 + 配置管理 |
| v8 | 会话备份/恢复, Feature-Session 关联, 看板增强 |
| v9 | 全自动迭代 (PM 续跑分诊) |
| v10 | 部署工具, 系统监控 |
| v11 | 团队成员级独立 LLM/MCP/Skill 配置 |
| v12 | 工作流预设 (可配置阶段), schema_version 迁移体系 |
| v13 | GitHub 深度集成 (Issue/PR/Branch), 密钥加密存储 |
| v14-v15 | UX 体验 Sprint (Toast/错误映射/删除确认/Markdown 渲染) + CI/CD Pipeline |
| v16-v17 | 代码质量治理 (any 清理 389→2, IPC 校验 50 断言, execSync→async) |
| v18 | Agent 智能增强 5 大模块 (迭代学习/自适应工具/子Agent压缩/观察遮蔽/Scratchpad) |
| v19 | 多模态交互 (图片/文件上传 + 网络图片搜索), 大文件拆分 (tool-registry/executor) |
| v20 | Agent 能力差距15项改进 (验证门控/语义死循环/纯文本容忍/自适应Prompt/架构裁剪/经验提取) |
| v21 | 元Agent 4模式系统 (work/chat/deep/admin) + 9管理工具 + per-mode配置 + 守护进程 + 流式通信修复 + 导入详细进度 |
| v22 | CI/CD(Husky+lint-staged) + CSP安全头 + PS注入转义 + JSON.parse修复 + 859 tests |
| v23 | Meta-agent路径安全防护 + Git访问权限用户可配置化 + Lazy Loading(13页面+3面板) |
| v24 | 搜索引擎大修(DuckDuckGo/Bing/Google HTML scraping) + Zero-key search + Agent资源上限自动终结 + 上下文主动压缩 |
| v25 | DAG WorkflowEngine(状态机驱动阶段执行+transitions+12测试) + WorkflowPreview DAG可视化 + 内置工作流升级 + 错误经验主动检索 |
| v26 | Echo风格思维链展示 + 完整工具调用可视化(diff/终端样式/Markdown代码块可复制) |
| v28 | MetaAgent附件UI + 管家产品知识库 + session工具 + 工作过程完成后保留展示 + 管家上下文管理 |
| v28.2 | 会话置顶/重命名/隐藏 + toast反馈 + 错误日志 + 工作过程默认展开 |
| v29 | Session-Agent调度系统(并发调度+僵尸锁+生命周期) + 管家记忆项目隔离 + 模式切换增强 |

### 已完成功能
- [x] 5 阶段编排流水线 + 可配置工作流预设 (PM→Arch→Reqs→Dev+QA→Accept)
- [x] ReAct Developer 循环 (50 轮, 130 工具 + MCP 动态加载)
- [x] QA 程序化检查 + LLM 审查 + 硬规则评分 + TDD 模式
- [x] 130 内置工具 (文件/Shell/Git/GitHub/Web/Computer/Browser/Visual/Skill/Deploy/Docker/SubAgent/Admin/Session)
- [x] 3 层上下文记忆 (Hot/Warm/Cold) + 压缩 + Scratchpad 持久化
- [x] 3 层持久记忆 (Global/Project/Role) + 元Agent 持久记忆
- [x] **v20.0 验证门控** — task_complete 前强制验证 (写过文件必须 run_command/test)
- [x] **v20.0 语义死循环检测** — 同一工具+文件连续失败→自动策略升级
- [x] **v20.0 纯文本容忍** — LLM 偶发纯文本回复不立即终止 (容忍 3 次)
- [x] **v20.0 自适应 Prompt** — 按 feature category 动态注入特定指导 + 工具列表裁剪
- [x] **v20.0 架构裁剪** — 按 feature 关键词裁剪 ARCHITECTURE.md 注入相关段
- [x] **v20.0 经验自动提取** — Feature 完成/QA reject 自动记录项目经验
- [x] **v20.0 并行 Worker 信息共享** — 每 5 轮注入其他 Worker 变更摘要
- [x] **v19.0 多模态交互** — 图片/文件上传 + 网络图片搜索下载
- [x] 需求变更检测 + 级联更新 + RFC 机制
- [x] 临时工作流 (5 种 Mission 类型) + 断点恢复
- [x] 已有项目导入分析 (4-Phase Scanner + 增量更新 + 7 探针 + 缓存)
- [x] 元Agent (跨项目管家, 意图检测, 配置管理, 持久记忆, 多会话)
- [x] **v21.0 元Agent 4模式系统** — work(委派团队)/chat(轻松对话)/deep(深度分析+写文件)/admin(9个管理工具直接操作DB)
- [x] **v21.0 Per-Mode 配置** — 每种模式独立的 maxReactIterations/maxResponseTokens/contextHistoryLimit
- [x] **v21.0 管家守护进程** — Heartbeat 定时检查 + 事件钩子 + Cron 任务 + HEARTBEAT_OK 协议
- [x] **v21.0 LLM 流式通信修复** — _callOpenAIWithTools() 强制 stream:true + SSE 解析
- [x] **v21.0 导入分析详细进度** — ImportLogCallback + 每个探针实时流式日志 + 5分钟超时保护
- [x] **v21.0 模式切换 UI** — ModeSwitchBadge 组件 + session.updateChatMode IPC
- [x] **v22.0 CI/CD Pipeline** — Husky pre-commit hooks + lint-staged + CSP安全头 + 42 tests新增
- [x] **v23.0 安全加固** — meta-agent路径安全防护 + git访问权限可配置 + 13页面Lazy Loading
- [x] **v24.0 搜索引擎大修** — DuckDuckGo/Bing/Google HTML scraping + Zero-key search (v24.1) + Agent资源终结总结
- [x] **v25.0 DAG 工作流引擎** — transition-driven阶段执行 + dev_implement失败重试 + WorkflowPreview DAG可视化 + 错误经验主动检索
- [x] **v26.0 思维链可视化** — Echo风格思考过程展示 + 工具调用diff/终端样式/Markdown代码块可复制
- [x] **v28.0 多模态补全** — MetaAgent附件UI + 管家产品知识库 + session工具 + 工作过程完成后保留展示
- [x] **v28.1 上下文管理升级** — ContextPage支持管家Agent + 管家配置概览面板 + snapshot缓存
- [x] **v28.2 会话管理增强** — 置顶/重命名/隐藏 + toast反馈 + 工作过程默认展开
- [x] **v29.0 Session-Agent调度系统** — session-scheduler(并发上限+僵尸锁清理) + session-lifecycle(状态机) + scheduler-bus(事件总线) + DB v17迁移
- [x] **v29.0 管家记忆项目隔离** — meta_agent_memories.project_id + 按项目过滤/管理记忆 + DB v18迁移
- [x] **v29.0 模式切换增强** — button嵌套修复 + chat模式不注入记忆/项目上下文 + 侧边栏查看/修改已有对话模式
- [x] 技能进化系统 + 跨项目经验迁移
- [x] MCP 协议动态工具加载 + 成员级 MCP 配置
- [x] 会话备份/恢复 + Feature-Session 关联追踪
- [x] 工作流预设管理 (可配置/内置/自定义阶段)
- [x] GitHub 深度集成 (Issue 创建, Feature↔Issue/PR/Branch 关联)
- [x] 密钥加密存储 (project_secrets + secret-manager)
- [x] 14 个 UI 页面 + 20 个组件 + 科技感 Canvas 背景
- [x] 系统监控 (CPU/GPU/内存/硬盘) + 活动时序图
- [x] 全局 Toast/确认系统 + 错误码中文映射 + 删除二次确认
- [x] IPC 输入校验 (50+ 断言覆盖关键 handlers)
- [x] schema_version 迁移体系 (18 版迁移, 可审计)

### 已知差距 (低优先级)
- [ ] Docker 容器级沙箱隔离 (当前用进程级+黑名单)
- [ ] 游戏引擎集成 (Tier 5 工具)
- [ ] 跨 Session 学习闭环 (harness 层自动技能提取)

## 5. AGENT GUIDELINES

### 必读文件
1. `CLAUDE.md` (本文件 — 项目大脑, **单一事实源**)
2. `docs/agent-capability-gap-analysis-2026-03.md` (Agent 能力差距分析, v20.0 改进基准)
3. `docs/CODE-QUALITY-REVIEW-2026-03-02.md` (代码质量复盘)
4. `docs/ARCHITECTURE-AUDIT-2026-03-02.md` (架构审计报告)

### 提交规范
- `feat:` 新功能 | `fix:` 修复 | `refactor:` 重构 | `docs:` 文档 | `test:` 测试

### Context 预算
- 强模型任务: max 256K tokens (PM 分析, Architect 设计, QA 审查, PM 验收)
- Worker 任务: max 256K tokens (Developer ReAct, Mission Worker)
- 输出精简: tool result 通过 `trimToolResult()` 压缩, 长文件分页读取
- 观察遮蔽: 旧 tool output → 结构化一行摘要 (节省 50%+ context)
- Scratchpad 锚点: 压缩后自动注入 Agent 工作记忆恢复上下文

### 关键文件速查

| 需要改 | 看这里 |
|--------|--------|
| 流水线阶段 | `electron/engine/orchestrator.ts` + `electron/engine/phases/*.ts` |
| Developer 工具循环 | `electron/engine/react-loop.ts` |
| QA 审查逻辑 | `electron/engine/qa-loop.ts` |
| 工具定义 | `electron/engine/tool-definitions.ts` |
| 工具权限 | `electron/engine/tool-permissions.ts` |
| 工具执行 | `electron/engine/tool-executor.ts` + `tool-handlers-async.ts` |
| 安全防护/门控 | `electron/engine/guards.ts` (验证门控, 语义循环, 终止策略) |
| Agent 提示词 | `electron/engine/prompts.ts` (含 getCategoryGuidance) |
| Agent 工作记忆 | `electron/engine/scratchpad.ts` (文件变更/进度/经验收集) |
| 自适应工具选择 | `electron/engine/adaptive-tool-selector.ts` |
| 子Agent压缩 | `electron/engine/sub-agent-compressor.ts` |
| LLM 调用 | `electron/engine/llm-client.ts` |
| 数据库 schema + 迁移 | `electron/db.ts` (MIGRATIONS 数组, 18 版) |
| 密钥管理 | `electron/engine/secret-manager.ts` |
| 会话管理 | `electron/engine/conversation-backup.ts` + `electron/ipc/sessions.ts` |
| Session-Agent调度 | `electron/engine/session-scheduler.ts` + `session-lifecycle.ts` + `scheduler-bus.ts` |
| 工作流预设 | `electron/ipc/workflow.ts` |
| 前端状态 | `src/stores/app-store.ts` + `src/stores/slices/*.ts` |
| 元Agent 后端 | `electron/ipc/meta-agent.ts` (含 4模式提示词 + admin工具执行 + ModeConfig) |
| 元Agent 守护进程 | `electron/engine/meta-agent-daemon.ts` (heartbeat/hooks/cron) |
| 元Agent 设置面板 | `src/components/MetaAgentSettings.tsx` (4 tab: 配置/模式/记忆/守护) |
| 项目导入分析 | `electron/engine/project-importer.ts` + `electron/engine/probes/*.ts` |
| 系统监控 | `electron/engine/system-monitor.ts` + `src/components/SystemMonitor.tsx` |

## 6. CODE HEALTH (2026-03-04 快照)

> 详见 `docs/CODE-QUALITY-REVIEW-2026-03-02.md`

| 指标 | 值 | 备注 |
|------|-----|------|
| tsc --noEmit 错误 | **0** | 全量通过 |
| `any` 使用量 | **2** | 从 389 → 2 (99.5% 消除) |
| 测试文件/用例 | 50 / 918 | 50 skipped (native SQLite) |
| IPC 输入校验 | 50+ 断言 | 覆盖关键 handlers |
| 空 catch 块 | ~5 (标注意图) | 42 个 catch 已加注释 |
| 主进程 main.js | 617 KB | Vite tree-shaking 后 |
| 质量门禁 | pre-commit hook (Husky + lint-staged) | tsc + eslint + prettier 自动运行 |
