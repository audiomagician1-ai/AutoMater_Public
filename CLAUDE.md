# 智械母机 AutoMater — 项目大脑

> 最后更新: 2026-03-02 | 版本: v13.0

## 1. PRIME DIRECTIVE

**当前阶段**: v13.0 — 全自动化迭代 Iteration 1 完成
**最高优先级**: GitHub 深度集成 + 外部平台自动化 + 密钥安全管理
**MUST NOT**: 不破坏现有流水线，不明文存储密钥

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
| Database | SQLite (better-sqlite3, 同步 API) |
| Build | pnpm + Vite (renderer) + tsc (main/preload) + electron-builder |
| Package | ~355MB Windows installer |

### 目录结构

```
AutoMater/
├── electron/              # Electron 主进程
│   ├── main.ts            # 入口, 窗口管理, IPC 注册
│   ├── preload.ts         # Context Bridge (14 个命名空间)
│   ├── db.ts              # SQLite 数据库 (9 张表)
│   ├── ipc/               # IPC Handlers
│   │   ├── project.ts     # project:* (CRUD, start, stop, analyze)
│   │   ├── meta-agent.ts  # meta-agent:chat (元Agent 对话)
│   │   └── missions.ts    # ephemeralMission:* (7 个处理器)
│   └── engine/            # Agent 引擎核心 (40 个模块)
│       ├── orchestrator.ts    # 多阶段编排器 (入口, v6.0: +DevOps +增量文档同步)
│       ├── react-loop.ts      # Developer ReAct 循环 (25 轮上限)
│       ├── qa-loop.ts         # QA 审查 (程序化检查 + LLM 审查 + TDD 测试骨架生成)
│       ├── tool-registry.ts   # 42+ 工具定义 + 角色权限
│       ├── tool-executor.ts   # 工具执行分发 (同步 + 异步)
│       ├── llm-client.ts      # LLM 调用 (流式/非流式)
│       ├── model-selector.ts  # strong/worker/fast 三层模型选择
│       ├── context-collector.ts # 3 层上下文记忆 (Hot/Warm/Cold)
│       ├── sandbox-executor.ts  # 子进程沙箱 (命令黑名单+环境隔离)
│       ├── mission-runner.ts  # 临时工作流 (Planner→Worker→Judge)
│       ├── project-importer.ts # 已有项目导入分析 (4-Phase + 增量更新)
│       ├── doc-manager.ts     # 文档 CRUD (设计/需求/测试规格)
│       ├── change-manager.ts  # 需求变更检测 + 级联更新
│       ├── memory-system.ts   # 3 层记忆 (Global/Project/Role)
│       ├── skill-evolution.ts # 技能习得/进化/跨项目共享
│       ├── mcp-client.ts      # MCP 协议动态工具加载
│       ├── browser-tools.ts   # Playwright 浏览器自动化
│       ├── computer-use.ts    # Windows 截图/鼠标/键盘
│       ├── visual-tools.ts    # Vision LLM 图像分析
│       ├── prompts.ts         # Agent 提示词模板
│       └── ...               # guards, repo-map, code-graph 等
├── src/                   # React 渲染进程
│   ├── App.tsx            # 路由 + 全局布局
│   ├── stores/
│   │   └── app-store.ts   # Zustand Store (所有状态)
│   ├── pages/             # 13 个页面
│   │   ├── ProjectsPage.tsx   # 项目列表 + 新建 + 导入
│   │   ├── OverviewPage.tsx   # 指挥中心 (架构图 + Agent 头像)
│   │   ├── WishPage.tsx       # 许愿台 + 元Agent 对话
│   │   ├── WorkflowPage.tsx   # 工作流可视化 + 临时任务
│   │   ├── TeamPage.tsx       # 团队配置 + 实时状态
│   │   ├── DocsPage.tsx       # 5 级文档树浏览器
│   │   ├── OutputPage.tsx     # 代码输出浏览
│   │   ├── LogsPage.tsx       # Agent 日志 (过滤/搜索)
│   │   ├── ContextPage.tsx    # 上下文管理器
│   │   ├── BoardPage.tsx      # 看板视图
│   │   ├── TimelinePage.tsx   # 时间线
│   │   ├── GuidePage.tsx      # 8 篇新手教程
│   │   └── SettingsPage.tsx   # LLM/MCP/模型配置
│   └── components/
│       ├── Sidebar.tsx        # 左侧导航
│       ├── MetaAgentPanel.tsx # 右侧元Agent 全局面板
│       └── TechBackground.tsx # Canvas 粒子动效
└── docs/                  # 设计文档 + 审计报告
```

## 3. ARCHITECTURE

### 流水线 (v6.0)

```
Phase 1:  PM 需求分析 → Feature 清单 (带 group_id 两层索引)
Phase 2:  Architect 架构+产品设计 → ARCHITECTURE.md + design.md
Phase 3:  批量子需求拆分 + 测试规格 (每批 5 Features)
Phase 4a: [TDD可选] QA 生成测试骨架
Phase 4b: Developer ReAct 实现 + QA 审查 + 自动重试 (最多 3 轮)
Phase 4c: PM 批量验收
Phase 4d: 增量文档同步 (G6 — 基于 git diff 更新模块摘要)
Phase 4e: DevOps 自动构建验证 (G8 — install → lint → test → build)
Phase 5:  汇总 + AGENTS.md 自动生成 + 用户验收等待
```

续跑时: PM 分诊 (detectImplicitChanges) 判断新需求 vs 迭代变更

### Agent 角色

| 角色 | ID 模式 | 工具数 | 职责 |
|------|---------|--------|------|
| PM | pm-* | 11 | 需求分析, Feature 拆分, 设计文档, 验收审查 |
| Architect | architect-* | 11 | 架构设计, ARCHITECTURE.md, 技术选型 |
| Developer | developer-* | 37 | ReAct 编码, 文件操作, Shell, Git, 浏览器, 视觉 |
| QA | qa-* | 24 | 程序化检查 + LLM 代码审查, 测试执行 |
| DevOps | devops-* | 10 | 自动构建验证 (install→lint→test→build), Phase 4e |
| Researcher | researcher-* | 6 | 只读子 Agent, 8 轮上限 |

### 元 Agent

- **位置**: 全局右侧可收起面板 + WishPage 右侧
- **职责**: 跨项目路由, 需求接收转发, 工作流管理, **可按需查询项目技术/设计细节**
- **后端**: `electron/ipc/meta-agent.ts`, 有意图检测 (wish/query/control/general)

### 数据库 (SQLite, 9 表)

| 表 | 主要字段 | 用途 |
|----|---------|------|
| settings | key, value | 应用配置 |
| projects | id, name, wish, status, workspace_path, config | 项目 |
| features | id, project_id, category, priority, status, locked_by, group_id | Feature 清单 (两层索引) |
| agents | id, project_id, role, status, token/cost 统计 | Agent 实例 |
| agent_logs | project_id, agent_id, type, content | 持久化日志 |
| wishes | id, project_id, content, status | 需求队列 |
| team_members | id, project_id, role, system_prompt | 自定义团队 |
| change_requests | id, project_id, impact_analysis | 变更管理 |
| missions + mission_tasks | type, status, plan, conclusion | 临时工作流 |

### 42+ 工具体系

| 类别 | 工具名 | 状态 |
|------|--------|------|
| **文件** (7) | read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files | ✅ 完整 |
| **Shell** (3) | run_command, run_test, run_lint | ✅ 完整 (沙箱执行) |
| **Git** (3) | git_commit, git_diff, git_log | ✅ 完整 |
| **GitHub** (2) | github_create_issue, github_list_issues | ✅ 完整 |
| **思考/计划** (5) | think, todo_write, todo_read, report_blocked, task_complete | ✅ 完整 |
| **记忆** (3) | memory_read, memory_append, spawn_researcher | ✅ 完整 |
| **Web** (3) | web_search, fetch_url, http_request | ✅ 完整 |
| **Computer Use** (5) | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | ✅ Windows 实现 |
| **Playwright** (10) | browser_launch~close | ✅ playwright-core |
| **视觉** (3) | analyze_image, compare_screenshots, visual_assert | ✅ Vision LLM |
| **技能** (4) | skill_acquire, skill_search, skill_improve, skill_record_usage | ✅ 完整 |
| **MCP** | 动态加载 | ✅ mcp-client.ts |

### 核心设计决策

| # | 决策 | 理由 |
|---|------|------|
| ADR-001 | Electron 而非 Tauri | 开发速度, Node.js 生态成熟度, LLM SDK 丰富 |
| ADR-002 | 全 TypeScript (Main + Renderer) | 无 Rust sidecar, 统一语言降低复杂度 |
| ADR-003 | 单体架构 (electron/ + src/) | 比 monorepo 更简单, 模块化通过文件划分 |
| ADR-004 | better-sqlite3 同步 API | Electron 主进程友好, 无 async 竞态 |
| ADR-005 | 3 层模型选择 (strong/worker/fast) | 控制 Token 成本: 规划用 strong, 编码用 worker |
| ADR-006 | ReAct + 内嵌 Planning (无独立 Planner 调用) | 减少 Token 开销, 2026 最佳实践 |
| ADR-007 | 文档驱动开发 (.AutoMater/docs/) | ARCHITECTURE.md + 子需求文档 + 测试规格驱动代码生成 |

## 4. CURRENT STATE

**版本**: v6.0 (全阶段流水线 + DevOps + TDD + 增量文档 + 事件重放)

### 已完成
- [x] 5 阶段编排流水线 (PM→Arch→Reqs→Dev+QA→Accept)
- [x] ReAct Developer 循环 (25 轮, 40+ 工具)
- [x] QA 程序化检查 + LLM 审查 + 硬规则评分
- [x] 42+ 工具 (文件/Shell/Git/Web/Computer/Browser/Visual/Skill)
- [x] 3 层上下文记忆 (Hot/Warm/Cold) + 压缩
- [x] 3 层持久记忆 (Global/Project/Role)
- [x] 需求变更检测 + 级联更新
- [x] 临时工作流 (5 种 Mission 类型)
- [x] 已有项目导入分析 (4-Phase Scanner)
- [x] 元 Agent (跨项目管家, LLM 对话, 意图检测)
- [x] 技能进化系统 + 跨项目经验迁移
- [x] MCP 协议动态工具加载
- [x] 13 个 UI 页面 + 科技感 Canvas 背景
- [x] Electron 通知 + 用户验收面板
- [x] 右键版本历史 + 文档 5 级树

### v6.0 新增
- [x] G1: 并行 Worker 共享决策日志 (文件级 claim/release/conflict)
- [x] G2: Sandbox 硬化 (路径遍历防护, 符号链接检测, 扩展黑名单)
- [x] G3: QA 程序化测试 (始终 run_test/run_lint, 测试失败=硬规则 fail)
- [x] G6: 增量文档同步 (git diff → 受影响模块摘要自动更新)
- [x] G7: Mission cancel 真正中断 LLM 调用 (AbortController)
- [x] G8: DevOps 自动构建验证 (检测框架 → install/lint/test/build)
- [x] G9: RFC 机制 (rfc_propose 工具 → change_requests 表)
- [x] G10: Feature 两层索引 (group_id + group-affinity 锁定)
- [x] G12: Event Stream Replay UI (时间线重放 + 播放控制)
- [x] G14: TDD 模式 (QA 先生成测试骨架, Developer 围绕测试编码)
- [x] G15: AGENTS.md 自动生成 (每次运行重新生成, 含依赖/配置/目录结构)

### 已知差距 (低优先级)
- [ ] Docker 容器级沙箱隔离 (当前用进程级+黑名单)
- [ ] 游戏引擎集成 (Tier 5 工具)

## 5. AGENT GUIDELINES

### 必读文件
1. `CLAUDE.md` (本文件)
2. `docs/IMPLEMENTATION-AUDIT-2026-03.md` (实现审计报告)
3. `docs/architecture-optimization-analysis.md` (v5 优化分析)

### 提交规范
- `feat:` 新功能 | `fix:` 修复 | `refactor:` 重构 | `docs:` 文档 | `test:` 测试

### Context 预算
- 强模型任务: max 128K tokens (PM 分析, Architect 设计, QA 审查, PM 验收)
- Worker 任务: max 128K tokens (Developer ReAct, Mission Worker)
- 输出精简: tool result 通过 `trimToolResult()` 压缩, 长文件分页读取

### IPC 命名空间 (preload.ts)
`settings`, `llm`, `project`, `wish`, `workspace`, `events`, `mission`,
`metaAgent`, `ephemeralMission`, `mcp`, `dialog`

### 关键文件速查
| 需要改 | 看这里 |
|--------|--------|
| 流水线阶段 | `electron/engine/orchestrator.ts` |
| Developer 工具循环 | `electron/engine/react-loop.ts` |
| QA 审查逻辑 | `electron/engine/qa-loop.ts` |
| 工具定义/权限 | `electron/engine/tool-registry.ts` |
| 工具执行 | `electron/engine/tool-executor.ts` |
| LLM 调用 | `electron/engine/llm-client.ts` |
| 数据库 schema | `electron/db.ts` |
| 前端状态 | `src/stores/app-store.ts` |
| 元 Agent 后端 | `electron/ipc/meta-agent.ts` |
| 临时工作流 | `electron/engine/mission-runner.ts` |
