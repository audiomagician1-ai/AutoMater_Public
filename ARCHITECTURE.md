# 智械母机 AutoMater — 架构文档

> 最后更新: 2026-03-04 | 面向: 自身 Agent 理解自身代码库时参考 | 总量: 261 TS/TSX 文件, ~88K 行

---

## 1. 系统总览

```
┌─────────────────────────── Electron 应用 ───────────────────────────┐
│                                                                     │
│  ┌──── Renderer Process (React + Vite) ────┐  IPC Bridge  ┌──── Main Process ────────────────────────────┐
│  │                                          │   (preload)  │                                              │
│  │  App.tsx ─── Router                      │◄────────────►│  main.ts                                     │
│  │    ├─ ProjectsPage    (项目列表)           │  23 命名空间  │    ├─ createWindow()                         │
│  │    ├─ WishPage        (许愿台+管家对话)     │              │    ├─ setupXxxHandlers() x12                 │
│  │    ├─ OverviewPage    (指挥中心)           │              │    ├─ startDaemon()                          │
│  │    ├─ TeamPage        (团队管理)           │              │    └─ initDatabase()                         │
│  │    ├─ WorkflowPage    (工作流DAG)          │              │                                              │
│  │    ├─ DocsPage        (文档树)             │              │  db.ts ─── SQLite (22张表, 18版迁移)           │
│  │    ├─ OutputPage      (代码输出)           │              │                                              │
│  │    ├─ LogsPage        (日志流)             │              │  ipc/ ─── 12个IPC Handler文件                 │
│  │    ├─ ContextPage     (上下文可视化)        │              │    ├─ project.ts      (项目CRUD+启停+分析)     │
│  │    ├─ BoardPage       (看板)              │              │    ├─ meta-agent.ts   (管家对话+记忆+配置)      │
│  │    ├─ TimelinePage    (事件重放)           │              │    ├─ sessions.ts     (会话管理+调度)          │
│  │    ├─ GitPage         (Git历史)           │              │    ├─ missions.ts     (临时工作流)             │
│  │    ├─ GuidePage       (新手教程)           │              │    ├─ workflow.ts     (工作流预设)             │
│  │    └─ SettingsPage    (LLM/MCP配置)       │              │    ├─ settings.ts     (应用设置)              │
│  │                                          │              │    ├─ llm.ts          (LLM测试/对话)          │
│  │  Components/                             │              │    ├─ mcp.ts          (MCP服务器管理)          │
│  │    ├─ MetaAgentPanel  (右侧管家面板)       │              │    ├─ events.ts       (事件流查询)             │
│  │    ├─ Sidebar         (左侧导航)          │              │    ├─ monitor.ts      (系统监控)              │
│  │    ├─ SessionManager  (会话管理器)         │              │    └─ workspace.ts    (文件树/读取)            │
│  │    ├─ AgentWorkFeed   (思维链展示)         │              │                                              │
│  │    ├─ ChatInput       (输入框+附件)        │              │  engine/ ─── Agent引擎 (113文件, 46K行)       │
│  │    └─ ... (20个组件)                      │              │    (详见下方模块图)                             │
│  │                                          │              │                                              │
│  │  Stores/ (Zustand)                       │              │                                              │
│  │    └─ app-store.ts (单Store, 4个slice)    │              │                                              │
│  └──────────────────────────────────────────┘              └──────────────────────────────────────────────┘
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Engine 核心模块图

```
engine/ 模块依赖（从上到下 = 从高层到低层）

                              ┌──────────────┐
                              │ orchestrator │  ← 入口: runOrchestrator(projectId)
                              └──────┬───────┘
                                     │ 调用各 Phase
                         ┌───────────┼───────────────────┐
                         ▼           ▼                   ▼
                   ┌──────────┐ ┌──────────┐      ┌──────────────┐
                   │ phases/  │ │ mission  │      │ meta-agent-  │
                   │ pm       │ │ -runner  │      │ daemon       │
                   │ architect│ │          │      │ (heartbeat/  │
                   │ worker   │ └────┬─────┘      │  hooks/cron) │
                   │ docs     │      │            └──────┬───────┘
                   │ devops   │      │                   │
                   │ deploy   │      │                   │
                   │ finalize │      │            ┌──────▼───────┐
                   └────┬─────┘      │            │ meta-agent   │
                        │            │            │ (ipc handler)│
                        ▼            ▼            └──────┬───────┘
                   ┌──────────────────────┐              │
                   │    react-loop.ts     │◄─────────────┘
                   │  (ReAct Developer    │  reactAgentLoop() — 管家也用此循环
                   │   50轮 + 验证门控)    │
                   └──────────┬───────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
     ┌────────────┐  ┌──────────────┐  ┌──────────────┐
     │ tool-      │  │ llm-client   │  │ context-     │
     │ executor   │  │ (OpenAI +    │  │ collector    │
     │ (同步分发)  │  │  Anthropic)  │  │ (Hot/Warm/   │
     │ tool-      │  │              │  │  Cold 3层)   │
     │ handlers-  │  │ model-       │  │ context-     │
     │ async      │  │ selector     │  │ compaction   │
     │ (异步执行)  │  │ (strong/     │  │              │
     └─────┬──────┘  │  worker/fast)│  └──────────────┘
           │         └──────────────┘
           │
    ┌──────┼────────────┬──────────────┬───────────────┐
    ▼      ▼            ▼              ▼               ▼
┌───────┐ ┌──────┐ ┌────────┐  ┌───────────┐  ┌───────────┐
│sandbox│ │ git- │ │browser-│  │ web-tools  │  │ mcp-      │
│-exec  │ │prov  │ │ tools  │  │ search-    │  │ client    │
│(进程级 │ │ider  │ │(Play-  │  │ provider   │  │(动态工具)  │
│ 沙箱)  │ │      │ │wright) │  │            │  │           │
└───────┘ └──────┘ └────────┘  └───────────┘  └───────────┘

安全层 (贯穿所有工具调用):
┌─────────────────────────────────────────────────────────────────┐
│ guards.ts ← guardToolCall() 参数校验 + validateCompletion() 门控 │
│ tool-permissions.ts ← 角色-工具权限矩阵                          │
│ sandbox-executor.ts ← 命令黑名单 + 路径逃逸检测 + 环境隔离          │
│ file-lock.ts ← 并行 Worker 文件级写锁                            │
└─────────────────────────────────────────────────────────────────┘

记忆/经验层 (独立于执行流):
┌─────────────────────────────────────────────────────────────────┐
│ memory-system.ts + memory-layers.ts ← 3层记忆 (Global/Project/Role) │
│ scratchpad.ts ← Agent 工作记忆 (文件变更/进度/经验)                   │
│ experience-harvester.ts ← 自动提取失败模式                          │
│ experience-library.ts ← 错误经验检索 + 跨项目共享                    │
│ iteration-learning.ts ← 迭代间策略修正                              │
│ skill-evolution.ts ← 技能习得/进化/跨项目                           │
│ cross-project.ts ← 跨项目经验注入                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 关键数据流

### 3.1 用户许愿 → 代码交付 (主流水线)

```
用户在 WishPage 输入需求
    │
    ▼
project:start IPC ──► orchestrator.runOrchestrator(projectId)
    │
    ├─ Phase 0: phaseEnvironmentBootstrap (依赖安装)
    │
    ├─ Phase 1: phasePMAnalysis
    │     PM Agent (reactAgentLoop) → Feature 清单写入 DB
    │
    ├─ Phase 2: phaseArchitect
    │     Architect Agent → ARCHITECTURE.md + design docs
    │
    ├─ Phase 3: phaseReqsAndTestSpecs
    │     PM 批量拆分子需求 + 测试规格
    │
    ├─ Phase 4: phaseWorker (并行)
    │     ┌─ Developer Worker(s) ──────────────────────┐
    │     │  reactDeveloperLoop():                      │
    │     │    LLM 思考 → tool_call → executeTool       │
    │     │    → 观察结果 → 循环 (最多50轮)              │
    │     │    → validateCompletion() 验证门控           │
    │     └─────────────────────────────────────────────┘
    │     ┌─ QA Loop ──────────────────────────────────┐
    │     │  程序化检查 + LLM 审查 → accept/reject       │
    │     │  reject → Developer 重做 (最多3轮)           │
    │     └─────────────────────────────────────────────┘
    │     ┌─ PM 验收 ─────────────────────────────────┐
    │     │  批量审查 → accept/requestChange             │
    │     └─────────────────────────────────────────────┘
    │
    ├─ Phase 4d: 增量文档同步
    ├─ Phase 4e: DevOps 构建验证 (install→lint→test→build)
    │
    └─ Phase 5: phaseFinalize
          汇总 → AGENTS.md → 等待用户验收
```

### 3.2 管家对话流 (Meta-Agent)

```
用户在 MetaAgentPanel 或 WishPage 输入消息
    │
    ▼
preload.metaAgent.chat(projectId, message, history, attachments, chatMode)
    │
    ▼
ipc/meta-agent.ts:  'meta-agent:chat' handler
    │
    ├─ 解析 mode (work/chat/deep/admin)
    ├─ 按 mode 决定是否加载记忆 (chat 模式跳过)
    ├─ 按 mode 决定是否注入项目上下文 (chat 模式跳过)
    ├─ buildSystemPrompt(config, memories, mode)
    ├─ 构建 messages 数组 (system + project_context + history + user)
    │
    ├─ mode=admin → 使用 admin 专用工具集, callLLMWithTools + ReAct 循环
    ├─ mode=deep  → 使用全量工具+write/edit, reactAgentLoop()
    ├─ mode=work  → 使用全量工具, 意图检测 + create_wish 委派
    └─ mode=chat  → 最小工具集, 简单对话
```

### 3.3 工具调用链

```
react-loop.ts:  LLM 返回 tool_calls
    │
    ▼
guardToolCall(toolName, args, hasWorkspace)     ← guards.ts: 参数校验+速率限制
    │ (allowed=true)
    ▼
isAsync(toolName) ?
    ├─ Yes → executeToolAsync(call, ctx)        ← tool-executor.ts
    │          └─ executeToolAsyncRaw(call, ctx) ← tool-handlers-async.ts
    │               ├─ run_command → execInSandboxPromise() ← sandbox-executor.ts
    │               ├─ read_file  → fs.readFile (权限检查)
    │               ├─ git_*      → git-provider.ts
    │               ├─ browser_*  → browser-tools.ts (Playwright)
    │               ├─ web_*      → web-tools.ts + search-provider.ts
    │               └─ mcp_*/skill_* → tool-handlers-external.ts
    └─ No  → executeTool(call, ctx)             ← tool-executor.ts
               └─ executeToolRaw(call, ctx)
                    ├─ write_file → assertWritePath() + fs.writeFile
                    ├─ edit_file  → assertWritePath() + patchFile
                    ├─ list_files → readDirectoryTree()
                    ├─ search_files → codeSearch()
                    └─ memory_*  → memory-layers.ts

路径安全:
  - 相对路径 → 基于 ctx.workspacePath 解析
  - 绝对路径写入 → 需要 ctx.permissions.externalWrite = true
  - 绝对路径读取 → 需要 ctx.permissions.externalRead = true
  - shell 执行 → 需要 ctx.permissions.shellExec = true
```

---

## 4. 数据库概览

**22 张表, 18 版迁移** — `electron/db.ts`

| 层 | 表 | 核心字段 | 创建方式 |
|----|----|----|-----|
| 核心 | `schema_version` | key, value | initDatabase |
| 核心 | `settings` | key, value | initDatabase |
| 核心 | `projects` | id, name, wish, status, workspace_path, config | initDatabase |
| 核心 | `features` | id, project_id, category, priority, status, locked_by, group_id | initDatabase |
| 核心 | `agents` | id, project_id, role, status, total_tokens, total_cost | initDatabase |
| 核心 | `agent_logs` | project_id, agent_id, type, content | initDatabase |
| 需求 | `wishes` | id, project_id, content, status, pm_analysis | Migration v2 |
| 团队 | `team_members` | id, project_id, role, system_prompt, llm_config, mcp_servers | Migration v2 |
| 变更 | `change_requests` | id, project_id, description, impact_analysis | Migration v4 |
| 任务 | `missions` | id, project_id, type, status, plan, conclusion, patches | Migration v5 |
| 任务 | `mission_tasks` | id, mission_id, title, status, input, output | Migration v5 |
| 管家 | `meta_agent_config` | key, value | Migration v7 |
| 管家 | `meta_agent_memories` | id, category, content, importance, project_id | Migration v7+v18 |
| 管家 | `meta_agent_chat_messages` | session_id, role, content, project_id | ensureTable |
| 管家 | `meta_agent_heartbeat_log` | timestamp, type, summary | ensureTable |
| 工作流 | `workflow_presets` | id, project_id, name, stages, is_active | Migration v9 |
| 密钥 | `project_secrets` | project_id, key, value(加密), provider | Migration v10 |
| 事件 | `events` | id, project_id, agent_id, type, data, timestamp | ensureTable |
| 会话 | `sessions` | id, project_id, agent_id, status, chat_mode, member_id | ensureTable |
| 会话 | `feature_sessions` | session_id, feature_id, project_id | ensureTable |
| 检查点 | `checkpoints` | id, mission_id, data | ensureTable |

---

## 5. 安全架构

### 5.1 多层防线

```
Layer 1: IPC 输入校验 (ipc-validator.ts)
         ├─ assertNonEmptyString / assertEnum / assertValidId
         └─ 50+ 断言覆盖关键 handler

Layer 2: 工具参数校验 (guards.ts → guardToolCall)
         ├─ 类型强制转换 + 范围钳制
         ├─ 路径安全验证 (validateRelativePath / validateReadPath)
         ├─ 速率限制 (per-tool per-minute)
         └─ 枚举校验 + 自定义 validate

Layer 3: 路径安全 (tool-executor.ts)
         ├─ assertWritePath(): 绝对路径需 externalWrite 权限
         ├─ checkExternalReadPermission(): 绝对路径需 externalRead 权限
         └─ 相对路径不允许 .. 遍历

Layer 4: 命令安全 (sandbox-executor.ts)
         ├─ isForbidden(): 28 种危险命令模式黑名单
         ├─ hasPathTraversal(): 路径逃逸检测
         ├─ validateWorkspacePath(): 工作路径不能是系统目录
         └─ buildSafeEnv(): 环境变量白名单

Layer 5: 角色权限矩阵 (tool-permissions.ts)
         ├─ 7 角色 × 130 工具的权限映射
         ├─ admin 工具仅 meta-agent admin 模式可用
         └─ 研究员角色只读 (6 工具)

Layer 6: 验证门控 (guards.ts → validateCompletion)
         ├─ 写过文件 → 必须执行 run_command/test 验证
         ├─ 语义死循环检测 → 同一工具+文件连续失败自动升级
         └─ 资源上限终止 (50轮/token/成本/挂钟/空转/重复)

Layer 7: CSP (main.ts)
         └─ Content-Security-Policy header (script/style/img/connect)
```

### 5.2 权限模型

```
项目级权限 (存储在 projects.config.permissions):
  ├─ externalRead: boolean   — 读取 workspace 外绝对路径
  ├─ externalWrite: boolean  — 写入 workspace 外绝对路径
  └─ shellExec: boolean      — 执行 shell 命令

角色级权限 (tool-permissions.ts 静态矩阵):
  ├─ Developer: 108 工具 (最多)
  ├─ DevOps: 80 工具
  ├─ QA: 65 工具
  ├─ Meta-Agent: 33 工具 + 9 admin 工具 (admin模式)
  ├─ Architect: 31 工具
  ├─ PM: 30 工具
  └─ Researcher: 16 工具 (只读)
```

---

## 6. 模块职责速查

### 6.1 Engine 模块 (46K 行, 113 文件)

| 文件 | 行数 | 职责 | 修改频率 |
|------|------|------|---------|
| `react-loop.ts` | 2146 | Developer/Agent ReAct 循环, 工具调用, 上下文管理 | 🔴 极高 |
| `project-importer.ts` | 1668 | 已有项目4阶段导入分析 | 🟡 中 |
| `tool-handlers-async.ts` | 1568 | 异步工具执行器 (run_command/git/browser/web) | 🔴 高 |
| `guards.ts` | 1114 | 安全防护 + 验证门控 + 语义循环检测 + 终止策略 | 🔴 高 |
| `search-provider.ts` | 1082 | DDG/Bing/Google HTML scraping | 🟡 中 |
| `context-collector.ts` | 1055 | Hot/Warm/Cold 3层上下文收集 | 🟡 中 |
| `prompts.ts` | 1026 | Agent 提示词模板 (PM/Dev/QA/Arch) | 🔴 高 |
| `conversation-backup.ts` | 947 | 会话备份/恢复 + Session 调度集成 | 🟡 中 |
| `orchestrator.ts` | 941 | 多阶段编排器入口 | 🟡 中 |
| `tool-result-summarizer.ts` | 904 | 工具结果摘要压缩 (节省上下文) | 🟢 低 |
| `experience-library.ts` | 900 | 错误经验库 + 跨项目检索 | 🟢 低 |
| `skill-evolution.ts` | 866 | 技能习得/进化/跨项目共享 | 🟢 低 |
| `blackbox-test-runner.ts` | 853 | 黑盒测试 (Docker/本地双模) | 🟢 低 |
| `llm-client.ts` | 830 | LLM 调用 (流式/非流式, OpenAI/Anthropic) | 🟡 中 |
| `tool-executor.ts` | 798 | 同步工具执行分发 | 🟡 中 |
| `git-provider.ts` | 760 | Git 操作 (commit/diff/log/branch/push) | 🟢 低 |
| `code-graph.ts` | 684 | 代码依赖图谱 | 🟢 低 |
| `meta-agent-daemon.ts` | 652 | 管家守护进程 (heartbeat/hooks/cron) | 🟡 中 |
| `sandbox-executor.ts` | 627 | 进程级沙箱 (命令执行/安全检查) | 🟢 低 |
| `sub-agent-framework.ts` | 608 | 子Agent高级框架 | 🟢 低 |

### 6.2 IPC 模块 (5.7K 行, 12 文件)

| 文件 | 行数 | IPC 命名空间 | 说明 |
|------|------|-------------|------|
| `meta-agent.ts` | ~1900 | meta-agent:* | 管家对话/记忆/配置/守护 — **最大最复杂** |
| `project.ts` | ~1100 | project:* | 项目全生命周期 |
| `sessions.ts` | ~600 | session:* | 会话管理+Feature关联+调度 |
| `missions.ts` | ~300 | mission:* | 临时工作流CRUD |
| `workflow.ts` | ~250 | workflow:* | 工作流预设管理 |
| `settings.ts` | ~200 | settings:* | 应用配置 |
| `events.ts` | ~200 | events:* | 事件流查询 |
| `mcp.ts` | ~200 | mcp:* | MCP服务器管理 |

### 6.3 前端页面 (22.9K 行, 79 文件)

| 文件 | 行数 | 说明 | 修改频率 |
|------|------|------|---------|
| `WishPage.tsx` | 1856 | 许愿台+管家对话主页面 | 🔴 极高 |
| `MetaAgentSettings.tsx` | 1300 | 管家设置 4-Tab 面板 | 🟡 中 |
| `MetaAgentPanel.tsx` | 983 | 右侧管家全局面板 | 🔴 高 |
| `GuidePage.tsx` | 1022 | 新手教程 (14章) | 🟢 低 |
| `ContextPage.tsx` | 987 | 上下文管理 (Hot/Warm/Cold可视化) | 🟢 低 |
| `OverviewPage.tsx` | 706 | 指挥中心 (架构图+Agent头像) | 🟡 中 |

---

## 7. 启动链 (关键路径)

```
electron/main.ts
    │
    ├─ app.requestSingleInstanceLock()     — 单实例锁
    │
    ├─ app.whenReady() →
    │   ├─ CSP Header 注册
    │   ├─ createWindow()                  — BrowserWindow (1280×800)
    │   │   └─ preload.js (contextIsolation: true)
    │   │
    │   ├─ initDatabase()                  — electron/db.ts
    │   │   ├─ 创建 %APPDATA%/automater/data/automater.db
    │   │   ├─ 创建 6 张核心表
    │   │   └─ 执行 MIGRATIONS[0..17] (v1-v18)
    │   │
    │   ├─ setupXxxHandlers() × 12         — 注册所有 IPC handler
    │   │   ├─ setupSettingsHandlers()
    │   │   ├─ initSearchConfigFromDb()    — 加载搜索引擎配置
    │   │   ├─ setupLLMHandlers()
    │   │   ├─ setupProjectHandlers()
    │   │   ├─ setupWorkspaceHandlers()
    │   │   ├─ setupEventHandlers()
    │   │   ├─ setupMcpHandlers()
    │   │   ├─ setupMetaAgentHandlers()
    │   │   ├─ setupMissionHandlers()
    │   │   ├─ setupSessionHandlers()
    │   │   ├─ setupMonitorHandlers()
    │   │   └─ registerWorkflowHandlers()
    │   │
    │   ├─ initMcpAndSkills()              — 后台连接 MCP + 加载技能
    │   └─ startDaemon()                   — 管家守护进程启动
    │
    └─ window-all-closed → stopDaemon() + shutdownMcpAndSkills() + app.quit()

⚠️ 关键脆弱点:
  - initDatabase() 失败 → 弹 dialog 但不退出 (部分功能可能异常)
  - 所有 IPC handler 注册是同步的, 如果任一 setup 抛异常, 后续 handler 不注册
  - MCP 连接失败被 catch 静默吞掉 (不阻塞启动)
```

---

## 8. 前端状态管理

```
Zustand 单 Store (app-store.ts) — 4 个 slice:

NavigationSlice (navigation-slice.ts):
  ├─ currentProject: Project | null
  ├─ currentPage: string
  └─ sidebarCollapsed: boolean

AgentSlice (agent-slice.ts):
  ├─ agentMessages: Map<string, AgentWorkMessage[]>
  ├─ agentStates: Map<string, AgentState>
  └─ projectStats: Map<string, ProjectStats>

MetaAgentSlice (meta-agent-slice.ts):
  ├─ metaMessages: MetaAgentMessage[]
  ├─ metaSessions: MetaSessionItem[]
  ├─ currentMetaSessionId: string | null
  ├─ currentChatMode: ChatMode
  ├─ metaPanelVisible: boolean
  └─ metaAgentStreaming: boolean

LogSlice (log-slice.ts):
  ├─ logs: LogEntry[]
  └─ logFilter: LogFilter

IPC 事件 → Store 更新:
  preload.on('agent:log', ...) → addAgentMessage()
  preload.on('agent:status', ...) → setAgentState()
  preload.on('meta-agent:stream', ...) → appendMetaStream()
```

---

## 9. 构建与部署

```
开发模式:
  pnpm dev → Vite dev server (React HMR) + electron-vite 自动重启主进程

构建流程:
  pnpm build
    ├─ vite build (React → dist/)
    ├─ scripts/prepare-build.js (tsc 编译 electron/ → dist-electron/)
    └─ electron-builder (打包 → release/)
        ├─ asar: true (better-sqlite3 除外)
        └─ win: { target: "dir" }

质量门禁:
  pre-commit hook (Husky + lint-staged):
    ├─ tsc --noEmit
    ├─ eslint --fix
    └─ prettier --write

测试:
  pnpm test → vitest run (918 tests, 50 files)
```

---

## 10. 修改热点 & 注意事项

### 🔴 高危修改区 (改错影响全局)

| 文件 | 风险 | 注意事项 |
|------|------|---------|
| `electron/main.ts` | 启动链断裂 | 任何异常导致窗口不创建。修改后必须完整启动测试 |
| `electron/db.ts` | 数据丢失 | 迁移只能追加 (MIGRATIONS 数组), 不能修改已有迁移。新迁移必须幂等 |
| `electron/preload.ts` | 前后端通信断裂 | 修改 API surface 必须同时更新 `src/types/api.d.ts` |
| `react-loop.ts` | Agent 核心循环 | 改错导致所有 Agent 不工作。有 50+ 测试覆盖 |
| `guards.ts` | 安全防线 | 放松校验可能导致安全漏洞。加严校验可能导致工具不可用 |
| `tool-executor.ts` | 工具分发 | 改错导致特定工具失效。注意同步/异步分流逻辑 |
| `sandbox-executor.ts` | 命令安全 | 黑名单太松有安全风险, 太严影响功能 |

### 🟡 中等风险

| 文件 | 注意事项 |
|------|---------|
| `ipc/meta-agent.ts` | 管家核心, ~1900行, 修改需注意4种mode的分支逻辑 |
| `prompts.ts` | 提示词质量直接影响 Agent 表现, 改动需验证多场景 |
| `orchestrator.ts` | Phase 顺序和控制流, 改错导致流水线中断 |
| `llm-client.ts` | 双协议 (OpenAI/Anthropic), 改错影响所有 LLM 调用 |

### 🟢 安全修改区 (低耦合)

| 文件 | 说明 |
|------|------|
| `src/pages/*.tsx` | UI 页面, 彼此独立, 不影响引擎 |
| `src/components/*.tsx` | UI 组件, 改错只影响对应面板 |
| `electron/engine/probes/*.ts` | 分析探针, 彼此独立 |
| `electron/engine/phases/*.ts` | 编排阶段, 彼此相对独立 |
| `docs/` | 文档, 不影响功能 |

---

## 11. 自修改距离评估

> 此节记录系统距离"能修改自身源码"的技术差距。

### 11.1 已具备 (65%)
- ✅ 130 工具中包含完整的读/写/搜索/编辑/执行/提交能力
- ✅ `externalRead` + `externalWrite` + `shellExec` 权限体系
- ✅ Git 版本控制 (10 工具)
- ✅ 管家 `create_wish` → PM → 架构 → 开发 → QA 流水线
- ✅ 测试 (918 tests) + TypeScript 类型检查 + ESLint

### 11.2 缺失 (35%)
- ❌ 自指向机制: 没有把自身目录作为 workspace 的入口
- ❌ 热重载: 修改后需手动 build + 重启 Electron
- ❌ 安全回滚: 无 "auto-branch → test → merge / rollback" 自动化流程
- ❌ 死人开关: 自修改破坏启动链后无恢复途径
- ❌ 沙箱验证: 无隔离环境预验证自修改

### 11.3 最小实现路径
1. 创建 `self-project` 类型, workspace = 自身源码目录 (~3h)
2. 自修改自动在 `self-upgrade/*` 分支操作 (~2h)
3. build + test + typecheck 三重验证门控 (~2h)
4. `app.relaunch()` 自重启 + watchdog 脚本 (~5h)
