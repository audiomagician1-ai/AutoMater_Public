# 智械母机 AutoMater — 项目大脑

> 最后更新: 2026-03-02 | 版本: v13.0 | **由代码实际盘点生成，非手工维护**

## 1. PRIME DIRECTIVE

**当前阶段**: v13.0 — 全自动化迭代 + GitHub 深度集成 + 密钥安全管理
**最高优先级**: 代码质量治理 (类型安全, 测试覆盖, 文档同步)
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
| Database | SQLite (better-sqlite3, 同步 API, **19 张表**, 10 版迁移) |
| Build | pnpm + Vite (renderer) + tsc (main/preload) + electron-builder |
| Test | Vitest 4 + @vitest/coverage-v8 (31 测试文件) |
| Lint | ESLint 10 + Prettier 3 |
| Package | ~355MB Windows installer (win:dir) |

### 目录结构

```
AutoMater/
├── electron/                   # Electron 主进程
│   ├── main.ts                 # 入口, 窗口管理, IPC 注册
│   ├── preload.ts              # Context Bridge (22 个命名空间)
│   ├── db.ts                   # SQLite 数据库 (19 张表, 10 版 Migration)
│   ├── ipc/                    # IPC Handlers (11 个文件)
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
│       ├── phases/             # 编排器拆分阶段 (9 个文件)
│       │   ├── index.ts        # 阶段注册入口
│       │   ├── pm-phase.ts     # Phase 1: PM 需求分析
│       │   ├── architect-phase.ts  # Phase 2: 架构设计
│       │   ├── bootstrap-phase.ts  # Phase 3: 批量拆分
│       │   ├── worker-phase.ts # Phase 4b: Developer + QA
│       │   ├── devops-phase.ts # Phase 4e: 自动构建
│       │   ├── docs-phase.ts   # Phase 4d: 增量文档
│       │   ├── finalize-phase.ts   # Phase 5: 汇总验收
│       │   └── shared.ts       # 阶段共享工具
│       ├── probes/             # 项目分析探针 (8 个文件)
│       │   ├── index.ts, base-probe.ts
│       │   ├── api-boundary-probe.ts, config-infra-probe.ts
│       │   ├── data-model-probe.ts, entry-probe.ts
│       │   ├── module-probe.ts, smell-probe.ts
│       │   └──
│       ├── __tests__/          # 单元测试 (31 个文件)
│       ├── orchestrator.ts     # 多阶段编排器 (入口, v12 可配置工作流)
│       ├── react-loop.ts       # Developer ReAct 循环 (25 轮上限)
│       ├── qa-loop.ts          # QA 审查 (程序化 + LLM + TDD)
│       ├── tool-registry.ts    # 42+ 工具定义 + 角色权限矩阵
│       ├── tool-executor.ts    # 工具执行分发 (同步 + 异步)
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
│       ├── image-gen.ts        # 图像生成工具
│       ├── secret-manager.ts   # 密钥加密存储管理
│       ├── prompts.ts          # Agent 提示词模板
│       ├── types.ts            # 共享类型定义
│       ├── constants.ts        # 常量
│       ├── logger.ts           # 结构化日志
│       ├── guards.ts           # 安全防护 (路径/命令)
│       ├── output-parser.ts    # LLM 输出解析
│       ├── planner.ts          # 规划器
│       ├── repo-map.ts         # 仓库结构映射
│       ├── code-graph.ts       # 代码依赖图谱
│       ├── search-provider.ts  # 搜索提供者
│       ├── research-engine.ts  # 研究子Agent引擎
│       ├── sub-agent.ts        # 子Agent框架
│       ├── sub-agent-framework.ts  # 子Agent高级框架
│       ├── git-provider.ts     # Git 操作封装
│       ├── workspace-git.ts    # 工作区 Git 管理
│       ├── event-store.ts      # 事件流持久化
│       ├── conversation-backup.ts  # 会话备份/恢复
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
│   └── components/             # 12 个组件
│       ├── Sidebar.tsx         # 左侧导航
│       ├── MetaAgentPanel.tsx  # 右侧元Agent 全局面板
│       ├── MetaAgentSettings.tsx   # 元Agent 配置面板
│       ├── SessionManager.tsx  # 会话管理器 (v8)
│       ├── AcceptancePanel.tsx # 用户验收面板
│       ├── ActivityCharts.tsx  # 活动图表
│       ├── AgentWorkFeed.tsx   # Agent 工作流
│       ├── ContextMenu.tsx     # 右键菜单
│       ├── ErrorBoundary.tsx   # React 错误边界
│       ├── StatusBar.tsx       # 底部状态栏
│       ├── SystemMonitor.tsx   # 系统监控面板
│       └── TechBackground.tsx  # Canvas 粒子动效
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

### 元 Agent (v5.4 → v7.0)

- **位置**: 全局右侧可收起面板 + WishPage 右侧
- **职责**: 跨项目路由, 需求接收转发, 工作流管理, 查询项目技术/设计细节
- **后端**: `electron/ipc/meta-agent.ts`
- **功能**: 意图检测 (wish/query/control/general), 配置管理, **持久记忆 (CRUD + 语义搜索)**
- **数据表**: `meta_agent_config` + `meta_agent_memories`

### 数据库 (SQLite, 19 张表, schema_version 迁移体系)

**核心建表** (initDatabase 创建):

| 表 | 主要字段 | 用途 |
|----|---------|------|
| schema_version | key, value | 迁移版本追踪 |
| settings | key, value | 应用配置 (LLM/MCP/UI) |
| projects | id, name, wish, status, workspace_path, config, git_mode, github_repo | 项目 |
| features | id, project_id, category, priority, status, locked_by, group_id, github_issue_number, github_pr_number, github_branch | Feature (两层索引 + GitHub 关联) |
| agents | id, project_id, role, status, token/cost 统计 | Agent 实例 |
| agent_logs | project_id, agent_id, type, content | 持久化日志 |

**迁移创建** (MIGRATIONS v1-v10):

| 表 | 迁移版本 | 主要字段 | 用途 |
|----|---------|---------|------|
| wishes | v2 | id, project_id, content, status, pm_analysis | 需求队列 |
| team_members | v2 (→v8→v11) | id, project_id, role, system_prompt, llm_config, mcp_servers, skills | 自定义团队 (v11: 成员级独立配置) |
| change_requests | v4 | id, project_id, description, impact_analysis | 变更管理 |
| missions | v5 | id, project_id, type, status, plan, conclusion, patches | 临时工作流 |
| mission_tasks | v5 | id, mission_id, title, status, input, output | 工作流子任务 |
| meta_agent_config | v7 | key, value | 元Agent 配置 |
| meta_agent_memories | v7 | id, category, content, importance | 元Agent 持久记忆 |
| workflow_presets | v9 | id, project_id, name, stages, is_active | 工作流预设 (v12) |
| project_secrets | v10 | project_id, key, value (加密), provider | 密钥安全存储 (v13) |

**模块自管理表** (ensureXxxTable):

| 表 | 管理模块 | 用途 |
|----|---------|------|
| events | event-store.ts | 事件流持久化 |
| checkpoints | mission.ts | 流水线断点恢复 |
| sessions | conversation-backup.ts | 会话备份/恢复 |
| feature_sessions | conversation-backup.ts | Feature↔Session 关联 (v8.1) |

### 42+ 工具体系

| 类别 | 工具名 | 状态 |
|------|--------|------|
| **文件** (7) | read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files | ✅ |
| **Shell** (3) | run_command, run_test, run_lint | ✅ 沙箱执行 |
| **Git** (3) | git_commit, git_diff, git_log | ✅ |
| **GitHub** (2) | github_create_issue, github_list_issues | ✅ v13 |
| **思考/计划** (5) | think, todo_write, todo_read, report_blocked, task_complete | ✅ |
| **记忆** (3) | memory_read, memory_append, spawn_researcher | ✅ |
| **Web** (3) | web_search, fetch_url, http_request | ✅ |
| **Computer Use** (5) | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | ✅ Windows |
| **Playwright** (10) | browser_launch, navigate, click, type, screenshot, evaluate, wait, scroll, select, close | ✅ |
| **视觉** (3) | analyze_image, compare_screenshots, visual_assert | ✅ Vision LLM |
| **技能** (4) | skill_acquire, skill_search, skill_improve, skill_record_usage | ✅ |
| **部署** (2+) | deploy_tools | ✅ v10 |
| **MCP** | 动态加载外部工具 | ✅ mcp-client.ts |

### IPC 命名空间 (preload.ts — 22 个)

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
| `metaAgent` | v5.4→v7 | 元Agent 对话 + 配置 + 记忆 CRUD |
| `ephemeralMission` | v5.5 | 临时工作流 CRUD + cancel + patches |
| `context` | v5.6 | 上下文基线预览 |
| `session` | v8→v8.1 | 会话管理 + Feature-Session 关联 |
| `workflow` | v12 | 工作流预设 CRUD + activate + stages |
| `zoom` | v5.2 | 缩放控制 (webFrame, 无 IPC) |
| `monitor` | v6 | 系统性能/活动时序/模型价格 |

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
| ADR-008 | schema_version 迁移体系 (v12.1) | 替代 try-catch 吞错误, 可审计版本演进 |

## 4. CURRENT STATE

**版本**: v13.0 (全阶段流水线 + 可配置工作流 + GitHub 深度集成 + 密钥安全 + 会话管理)

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
| v13 | GitHub 深度集成 (Issue/PR/Branch), 密钥加密存储, project_secrets 表 |

### 已完成功能
- [x] 5 阶段编排流水线 + 可配置工作流预设 (PM→Arch→Reqs→Dev+QA→Accept)
- [x] ReAct Developer 循环 (25 轮, 42+ 工具 + MCP 动态加载)
- [x] QA 程序化检查 + LLM 审查 + 硬规则评分 + TDD 模式
- [x] 42+ 内置工具 (文件/Shell/Git/GitHub/Web/Computer/Browser/Visual/Skill/Deploy)
- [x] 3 层上下文记忆 (Hot/Warm/Cold) + 压缩
- [x] 3 层持久记忆 (Global/Project/Role) + 元Agent 持久记忆
- [x] 需求变更检测 + 级联更新 + RFC 机制
- [x] 临时工作流 (5 种 Mission 类型) + 断点恢复
- [x] 已有项目导入分析 (4-Phase Scanner + 增量更新 + 7 探针)
- [x] 元Agent (跨项目管家, 意图检测, 配置管理, 持久记忆)
- [x] 技能进化系统 + 跨项目经验迁移
- [x] MCP 协议动态工具加载 + 成员级 MCP 配置
- [x] 会话备份/恢复 + Feature-Session 关联追踪
- [x] 工作流预设管理 (可配置/内置/自定义阶段)
- [x] GitHub 深度集成 (Issue 创建, Feature↔Issue/PR/Branch 关联)
- [x] 密钥加密存储 (project_secrets + secret-manager)
- [x] 14 个 UI 页面 + 12 个组件 + 科技感 Canvas 背景
- [x] 系统监控 (CPU/GPU/内存/硬盘) + 活动时序图
- [x] Electron 通知 + 用户验收面板
- [x] 右键版本历史 + 文档 5 级树
- [x] schema_version 迁移体系 (10 版迁移, 可审计)

### 已知差距 (低优先级)
- [ ] Docker 容器级沙箱隔离 (当前用进程级+黑名单)
- [ ] 游戏引擎集成 (Tier 5 工具)
- [ ] IPC 运行时输入校验 (当前 preload 参数全为 `any`)
- [ ] 大文件 code-splitting (OverviewPage 1457 LOC, context-collector 1061 LOC)

## 5. AGENT GUIDELINES

### 必读文件
1. `CLAUDE.md` (本文件 — 项目大脑, **单一事实源**)
2. `docs/CODE-QUALITY-REVIEW-2026-03-02.md` (代码质量复盘)
3. `docs/DOC-DRIFT-ANALYSIS-2026-03-02.md` (文档漂移分析)

### 提交规范
- `feat:` 新功能 | `fix:` 修复 | `refactor:` 重构 | `docs:` 文档 | `test:` 测试

### Context 预算
- 强模型任务: max 128K tokens (PM 分析, Architect 设计, QA 审查, PM 验收)
- Worker 任务: max 128K tokens (Developer ReAct, Mission Worker)
- 输出精简: tool result 通过 `trimToolResult()` 压缩, 长文件分页读取

### 关键文件速查

| 需要改 | 看这里 |
|--------|--------|
| 流水线阶段 | `electron/engine/orchestrator.ts` + `electron/engine/phases/*.ts` |
| Developer 工具循环 | `electron/engine/react-loop.ts` |
| QA 审查逻辑 | `electron/engine/qa-loop.ts` |
| 工具定义/权限 | `electron/engine/tool-registry.ts` |
| 工具执行 | `electron/engine/tool-executor.ts` |
| LLM 调用 | `electron/engine/llm-client.ts` |
| 数据库 schema + 迁移 | `electron/db.ts` (MIGRATIONS 数组) |
| 密钥管理 | `electron/engine/secret-manager.ts` |
| 会话管理 | `electron/engine/conversation-backup.ts` + `electron/ipc/sessions.ts` |
| 工作流预设 | `electron/ipc/workflow.ts` |
| 前端状态 | `src/stores/app-store.ts` |
| 元Agent 后端 | `electron/ipc/meta-agent.ts` |
| 临时工作流 | `electron/engine/mission-runner.ts` |
| 项目导入分析 | `electron/engine/project-importer.ts` + `electron/engine/probes/*.ts` |
| 系统监控 | `electron/engine/system-monitor.ts` + `src/components/SystemMonitor.tsx` |

## 6. CODE HEALTH (2026-03-02 快照)

> 详见 `docs/CODE-QUALITY-REVIEW-2026-03-02.md`

| 指标 | 值 | 备注 |
|------|-----|------|
| tsc --noEmit 错误 | 72 | 7 个文件 |
| `any` 使用量 | 157 | 36 个文件 |
| 测试覆盖率 | 31/59 引擎模块有测试 | 部分模块无测试 |
| IPC 输入校验 | 0/108 handlers | preload 参数无 runtime 验证 |
| 空 catch 块 | ~5 | ~100 个 silent catch |
| 最大文件 LOC | OverviewPage 1457 | 6 个文件 >600 LOC |
