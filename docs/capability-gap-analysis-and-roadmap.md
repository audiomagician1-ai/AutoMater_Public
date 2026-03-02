# AgentForge 能力完善方案 — 对标 EchoAgent 并超越

> 撰写日期: 2026-03-02
> 目标: 系统性分析 AgentForge Agent 与 EchoAgent 在"外部交互能力"上的差距，制定可落地的完善路线图，使 AgentForge Agent 达到并超越 EchoAgent 的能力水平。
> 基准模型: opus4.6 (AgentForge 计划采用)

---

## 〇、核心结论

**EchoAgent 的核心优势不在于单一工具的能力强弱，而在于三个维度的"系统性生态"：**

1. **外部交互的广度与深度** — 10+ 类 MCP 工具 + 10 个子 Agent 形成的协作网络
2. **跨会话的持久化智能** — 结构化记忆系统（boot/shutdown/暂存/技能匹配）
3. **人机协同的编排层** — 主 Agent 作为"编排者"而非"执行者"的元认知能力

AgentForge 当前已具备优秀的**项目级自主开发能力**（42+ 工具、5 阶段流水线、ReAct 循环、记忆系统），但在**外部交互**、**人类协同**、**跨领域扩展性**三个维度上存在结构性差距。

---

## 一、能力全景对比

### 1.1 EchoAgent 能力架构

```
EchoAgent (主编排 Agent)
├── 🧠 持久记忆系统
│   ├── boot.md — 自动启动恢复
│   ├── agent_identity.json — 自我认知 + 能力边界
│   ├── user_profile.json — 用户偏好 + 风格
│   ├── lessons_learned.json — 原则 + 模式 (P-01~P-09, M-01~M-34)
│   ├── skill_index.json — 39 个可复用技能 (trigger → 按需加载)
│   ├── active_project.json — 活跃项目索引
│   ├── volatile/ — 暂存区 (session_scratchpad, conclusion_buffer, task_checkpoint)
│   └── shutdown_procedure.md — 结构化记忆整理
│
├── 🔧 本地工具集
│   ├── bash (PowerShell 5.1) — 本地命令执行
│   ├── DockerSandbox — 容器化沙箱 (init/exec/read/write/upload/download)
│   ├── Playwright — 浏览器自动化 (navigate/click/type/snapshot/screenshot 等 20+ API)
│   ├── read/edit/multiedit — 文件读写与精确编辑
│   ├── ls/grep — 目录遍历 + 正则内容搜索
│   ├── code-search — 代码搜索 (read_many_files/search_files/grep)
│   ├── WebSearch — 联网搜索 (SerpApi) + URL 读取
│   └── todowrite/todoread — 会话任务管理
│
├── 🤖 子 Agent 协作网络 (10 个)
│   ├── WebResearchAgent — 联网搜索 + 沙箱 + TODO
│   ├── WebResearch — 轻量搜索 + TODO
│   ├── git sandbox — Git 沙箱执行
│   ├── Code Search Agent — 代码搜索专家
│   ├── 设计绘画助手 — 文生图/图生图/编辑/融合
│   ├── NanoBanana — Gemini 画图
│   ├── 即梦提示词助手 — 即梦平台 prompt 优化
│   ├── SimpleChatBot — 独立审查 (无工具偏见)
│   ├── CR高手 — Agentic Sandbox CR
│   └── GUI Agent — 桌面操控 (Claude, 仅客户端)
│
└── 🧩 元能力
    ├── 主动编排: 拆解任务 → 路由子 Agent → 整合结果
    ├── 自我质疑: cognitive_patches 机制
    ├── 技能匹配: 任务开始时自动扫描 trigger 匹配技能
    ├── 经验积累: 自动暂存 → shutdown 去重合并 → 跨会话持久化
    └── 上下文管理: boot/shutdown/checkpoint/compression 全生命周期
```

### 1.2 AgentForge Agent 能力架构

```
AgentForge (5 阶段流水线)
├── 🧠 记忆系统 (3 层)
│   ├── Global Memory — %APPDATA%/automater/global-memory.md
│   ├── Project Memory — {workspace}/.automater/project-memory.md
│   └── Role Memory — {workspace}/.automater/memories/{role}.md
│
├── 🔧 工具系统 (42+ 内置 + MCP 扩展)
│   ├── 文件操作: read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files
│   ├── 命令执行: run_command (同步+后台), run_test, run_lint, check_process
│   ├── Git: git_commit, git_diff, git_log
│   ├── GitHub: github_create_issue, github_list_issues
│   ├── Web: web_search (Jina), fetch_url (Jina Reader), http_request
│   ├── 浏览器: browser_launch/navigate/screenshot/snapshot/click/type/evaluate/wait/network/close
│   ├── Computer Use: screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey
│   ├── 视觉验证: analyze_image, compare_screenshots, visual_assert
│   ├── 记忆: memory_read, memory_append
│   ├── 思考/规划: think, todo_write, todo_read, report_blocked, rfc_propose
│   ├── 子 Agent: spawn_researcher (只读研究)
│   ├── 技能进化: skill_acquire, skill_search, skill_improve, skill_record_usage
│   ├── MCP: 动态发现 + 调用外部 MCP 工具
│   └── 任务: task_complete
│
├── 🤖 Agent 角色 (5 个内置)
│   ├── PM — 需求分析 + 验收
│   ├── Architect — 架构设计 + 产品设计
│   ├── Developer ×3 — ReAct 实现 (最多 25 轮)
│   ├── QA — TDD 审查 + E2E 验证
│   └── DevOps — 构建部署
│
└── 🧩 引擎能力
    ├── 编排: 5 阶段流水线 + 可定制工作流
    ├── 上下文: Code Graph + ContextSection + 压缩 + Hot/Cold
    ├── 跨项目: Knowledge Pool (14 tech tags)
    ├── 持久任务: Mission checkpoint + 续跑
    ├── 文档驱动: doc-manager + design/sub-req/test-spec
    ├── 安全: Guards (Tool/React/QA/Pipeline/Budget) + file-lock
    └── 模型选择: 按任务复杂度动态选 strong/worker/mini
```

---

## 二、维度化差距分析

### 2.1 差距矩阵

| 维度 | EchoAgent | AgentForge | 差距评级 | 说明 |
|------|-----------|------------|---------|------|
| **联网搜索质量** | SerpApi (Google级) | Jina Search (有限) | 🔴 严重 | Jina 免费 API 结果质量/稳定性远不及 SerpApi |
| **URL 内容读取** | WebSearch_read_url (可控) | Jina Reader (简单) | 🟡 中等 | Jina Reader 不支持 JS 渲染页面 |
| **沙箱环境** | DockerSandbox (完整隔离) | sandbox-executor (子进程) | 🔴 严重 | 无容器隔离，安全性差，无环境定制能力 |
| **浏览器自动化** | Playwright MCP (20+ API) | playwright-core (10 tools) | 🟡 中等 | 缺少 form_fill, drag, tabs, file_upload, 可访问性快照 |
| **子 Agent 协作** | 10 个专业子 Agent | 1 个 spawn_researcher (只读) | 🔴 严重 | 无法委派写操作、无法并行多子 Agent、无专业领域子 Agent |
| **图像/设计能力** | 3 个视觉子 Agent | analyze_image (仅分析) | 🔴 严重 | 完全无图像生成/编辑能力 |
| **跨会话持久记忆** | 结构化 JSON + boot/shutdown | Markdown 文件追加 | 🟡 中等 | 缺少自动 boot/shutdown、暂存区、技能触发匹配 |
| **人机协同** | ask_user + 主动停下等待 | report_blocked (仅标记) | 🟡 中等 | 无法在执行中途请求人类输入并恢复 |
| **桌面操控** | GUI Agent (Claude, 完整) | Computer Use (基础 5 工具) | 🟡 中等 | 有基础能力但缺少智能元素定位和动作链 |
| **代码审查** | CR高手 + SimpleChatBot | QA Loop (代码审查) | 🟢 轻微 | AgentForge 的 QA 内置且更系统化 |
| **任务编排** | 主 Agent 动态编排 | 5 阶段固定流水线 | 🟡 中等 | 流水线适合开发，但缺乏动态路由灵活性 |
| **MCP 协议** | 平台级内置支持 | mcp-client.ts (stdio+SSE) | 🟢 已有基础 | 已有 MCP Client，但尚未充分利用 |
| **项目理解深度** | code-search + grep | Code Graph + repo-map | 🟢 AgentForge 优势 | AgentForge 在代码理解上更深入 |
| **成本控制** | 无显式控制 | Budget Guard + Model Selector | 🟢 AgentForge 优势 | AgentForge 有完善的成本控制机制 |
| **自主开发流程** | 需人工拆解+调度 | 全自动 5 阶段流水线 | 🟢 AgentForge 显著优势 | 这是 AgentForge 的核心价值 |

### 2.2 关键差距深度分析

#### 🔴 差距 1: 联网搜索 — Jina vs SerpApi

**现状**: AgentForge 的 `web_search` 通过 Jina Search API (`s.jina.ai`) 实现，这是一个免费的基于 AI 的搜索服务。

**问题**:
- Jina Search 结果数量和质量不稳定（高峰期限流严重）
- 不支持并发多查询（EchoAgent 的 SerpApi 支持）
- 无法搜索图片/视频/学术等垂直领域
- 返回格式不稳定（Markdown 解析可能失败）
- 无 API Key 管理，依赖免费额度

**EchoAgent 优势**: SerpApi 提供 Google 级搜索质量，支持并发、支持垂直搜索、返回结构化 JSON。

#### 🔴 差距 2: 沙箱环境 — Docker vs 子进程

**现状**: AgentForge 的 `sandbox-executor.ts` 通过 `child_process.exec` 在本机子进程中执行命令。

**问题**:
- **无隔离**: 代码直接在用户系统执行，恶意命令可能损坏系统
- **无环境定制**: 无法按项目需求安装不同 runtime/依赖
- **无状态持久化**: 无法保存沙箱状态供后续使用
- **无资源限制**: 无法限制 CPU/内存/磁盘

**EchoAgent 优势**: DockerSandbox 提供完整容器隔离、多镜像支持、状态持久化、文件上传/下载、端口暴露。

#### 🔴 差距 3: 子 Agent 协作 — 1 vs 10

**现状**: AgentForge 仅有 `spawn_researcher`——一个只读研究子 Agent，最多 8 轮工具调用。

**问题**:
- 子 Agent 只能读不能写（无法委派文件编辑、代码生成等任务）
- 无法并行多个子 Agent（当前是同步阻塞）
- 无专业领域子 Agent（设计、审查、部署等）
- 子 Agent 无法访问外部工具（只有 read_file/list_files/search_files）
- 缺乏子 Agent 结果的质量评估和重试机制

**EchoAgent 优势**: 10 个子 Agent 覆盖研究、代码、视觉、审查、桌面 5 大领域，支持 fork 会话、继承上下文、异步并行。

#### 🔴 差距 4: 图像/设计能力 — 0 vs 3

**现状**: AgentForge 有 `visual-tools.ts`（analyze_image/compare_screenshots/visual_assert），但这些都是**分析**工具，不是**生成**工具。

**问题**:
- 完全无法生成图像（UI 原型、图标、示意图）
- 无法编辑/修改图像
- 无法生成 Markdown/SVG 之外的可视化产出
- 用户说"画一个 XXX 界面"时完全无能为力

**EchoAgent 优势**: 设计绘画助手（文生图/图生图/编辑/融合）+ NanoBanana（Gemini 画图）+ 即梦提示词助手。

---

## 三、能力完善方案 (Roadmap)

### 3.0 设计原则

1. **MCP-First**: 所有新增外部能力优先通过 MCP Server 接入，而非硬编码
2. **渐进增强**: 每个阶段独立可用，不需要全部完成才能获得收益
3. **超越而非复制**: 不是复制 EchoAgent 的实现，而是基于 AgentForge 的架构优势做更好的设计
4. **opus4.6 原生优势**: 充分利用 opus4.6 的强推理+长上下文能力，减少对工具的依赖

### 3.1 Sprint 1 — 基础外部交互 (优先级: P0, 预计 2-3 天)

#### 3.1.1 🔍 搜索引擎升级

**目标**: 从 Jina 替换为高质量搜索方案，支持并发。

**方案 A — SerpApi 集成 (推荐)**:
```
新增 electron/engine/search-provider.ts:
- SearchProvider 接口 (search / searchImages / searchScholar)
- SerpApiProvider 实现 (用户提供 API Key)
- JinaProvider 保留为 fallback (免费但质量低)
- 在 Settings 中新增 "搜索引擎" 配置项
```

**方案 B — 多源聚合搜索 (MCP Server)**:
```
新建 MCP Server: agentforge-search-server
- 聚合 SerpApi + Brave Search + Tavily 等多源
- 支持并发多查询 (Promise.all)
- 返回结构化 JSON + 去重 + 排序
- 作为标准 MCP Server, AgentForge 通过 mcp-client 接入
```

**超越 EchoAgent 的点**:
- EchoAgent 依赖平台内置的 SerpApi，无法切换。AgentForge 支持 Provider 可插拔
- 支持搜索结果缓存（同一会话内重复搜索不浪费 API 调用）
- 支持搜索结果与项目上下文的**自动关联**（Code Graph 标签匹配）

#### 3.1.2 📦 Docker 沙箱

**目标**: 提供完整容器化隔离执行环境。

**方案: 新增 electron/engine/docker-sandbox.ts**:
```typescript
interface SandboxManager {
  // 生命周期
  initialize(image: string, env?: Record<string, string>): Promise<string>; // → containerId
  exec(containerId: string, command: string, timeout?: number): Promise<ExecResult>;
  
  // 文件操作
  writeFile(containerId: string, path: string, content: string): Promise<void>;
  readFile(containerId: string, path: string): Promise<string>;
  uploadFile(containerId: string, hostPath: string, containerPath: string): Promise<void>;
  downloadFile(containerId: string, containerPath: string, hostPath: string): Promise<void>;
  
  // 网络
  exposePort(containerId: string, containerPort: number): Promise<{ hostPort: number; url: string }>;
  
  // 清理
  destroy(containerId: string): Promise<void>;
  destroyAll(): Promise<void>; // 应用退出时
}
```

**新增工具注册**:
```
sandbox_init    — 初始化容器 (选择镜像 + 环境变量)
sandbox_exec    — 在容器内执行命令
sandbox_write   — 向容器写入文件
sandbox_read    — 从容器读取文件
sandbox_expose  — 暴露容器端口
sandbox_destroy — 销毁容器
```

**超越 EchoAgent 的点**:
- 自动沙箱策略: run_command 自动检测危险操作（rm -rf, 网络访问等）→ 自动路由到沙箱
- 沙箱快照: 保存容器状态 → 续跑时恢复（EchoAgent 的 DockerSandbox 无此功能）
- 沙箱模板: 预置常见开发环境模板（Node.js/Python/Rust/Go）

#### 3.1.3 🌐 浏览器自动化增强

**目标**: 补齐 Playwright 工具缺失的 API，达到 EchoAgent Playwright MCP 的完整度。

**新增工具**:
```
browser_fill_form    — 批量填表 (多字段一次调用)
browser_drag         — 拖放操作
browser_tabs         — 标签页管理 (list/new/close/select)
browser_file_upload  — 文件上传
browser_hover        — 悬停 (触发 tooltip/dropdown)
browser_select_option — 下拉选择
browser_press_key    — 键盘按键 (如 ArrowDown, Escape)
browser_console      — 获取控制台日志 (调试用)
browser_accessibility_snapshot — 可访问性快照 (比 DOM tree 更省 token)
```

**超越 EchoAgent 的点**:
- 元素智能定位: 集成视觉 LLM，当 CSS selector 定位失败时，自动截图 → 视觉分析 → 坐标点击
- 操作录制回放: 记录用户操作序列 → 生成 Playwright 脚本 → QA Agent 可复用
- 自动等待策略: 不需要手动 browser_wait，每个操作自动智能等待

---

### 3.2 Sprint 2 — 子 Agent 系统重构 (优先级: P0, 预计 3-4 天)

#### 3.2.1 通用子 Agent 框架

**目标**: 从 `spawn_researcher` 的只读模式，升级为通用的多能力子 Agent 框架。

**方案: 新增 electron/engine/sub-agent-framework.ts**:

```typescript
interface SubAgentConfig {
  /** 子 Agent 唯一标识 */
  id: string;
  /** 角色描述 (用于 system prompt) */
  role: string;
  /** 允许使用的工具白名单 (null = 继承父 Agent 的全部工具) */
  allowedTools: string[] | null;
  /** 是否允许写操作 */
  canWrite: boolean;
  /** 最大工具调用轮次 */
  maxIterations: number;
  /** 上下文继承策略 */
  contextInherit: 'full' | 'summary' | 'none';
  /** 独立工作目录 (null = 共享父 Agent 的 workspace) */
  workDir: string | null;
  /** 超时 (秒) */
  timeout: number;
}

interface SubAgentResult {
  success: boolean;
  conclusion: string;
  /** 子 Agent 产出的文件列表 */
  filesCreated: string[];
  filesModified: string[];
  /** 子 Agent 的工具调用历史摘要 */
  actionSummary: string;
  /** token 消耗 */
  inputTokens: number;
  outputTokens: number;
}

// 子 Agent 注册表 — 预置专业子 Agent
const SUB_AGENT_PRESETS: Record<string, SubAgentConfig> = {
  researcher:   { canWrite: false, maxIterations: 8,  allowedTools: ['read_file', 'list_files', 'search_files', 'web_search', 'fetch_url'] },
  coder:        { canWrite: true,  maxIterations: 15, allowedTools: ['read_file', 'write_file', 'edit_file', 'batch_edit', 'run_command', 'search_files'] },
  reviewer:     { canWrite: false, maxIterations: 10, allowedTools: ['read_file', 'search_files', 'list_files', 'think'] },
  tester:       { canWrite: true,  maxIterations: 12, allowedTools: ['read_file', 'write_file', 'run_test', 'run_lint', 'browser_*'] },
  deployer:     { canWrite: true,  maxIterations: 10, allowedTools: ['run_command', 'check_process', 'http_request', 'git_*'] },
  doc_writer:   { canWrite: true,  maxIterations: 8,  allowedTools: ['read_file', 'write_file', 'search_files', 'web_search'] },
};
```

**新增工具**:
```
spawn_agent      — 创建任意类型子 Agent (preset 或自定义配置)
spawn_parallel   — 并行启动多个子 Agent (Promise.all)
wait_agent       — 等待指定子 Agent 完成
cancel_agent     — 取消正在执行的子 Agent
list_agents      — 列出当前活跃的子 Agent 及状态
```

#### 3.2.2 子 Agent 并行执行

**目标**: 支持同时运行多个子 Agent，各自独立推进，结果汇总。

**关键设计**:
```
spawn_parallel({
  agents: [
    { preset: 'researcher', task: '调研 React 19 的新 API' },
    { preset: 'researcher', task: '搜索竞品的实现方案' },
    { preset: 'coder',      task: '实现 A 模块', workDir: 'src/modules/a/' },
  ],
  merge_strategy: 'concat' | 'dedupe' | 'llm_merge'
})
```

**文件冲突处理**:
- 子 Agent 使用独立分支 (git worktree) 或独立目录
- 完成后由父 Agent 审查 + 合并冲突
- 利用已有的 `file-lock.ts` 机制防止并发写冲突

**超越 EchoAgent 的点**:
- EchoAgent 的子 Agent 是完全独立的服务，无法共享上下文或文件系统
- AgentForge 的子 Agent 共享 workspace + 记忆 + Code Graph，协作效率远高于 EchoAgent 的松散协作
- 支持**子 Agent 链式调用**（researcher 结果 → 自动喂给 coder），EchoAgent 需要主 Agent 手工转发

---

### 3.3 Sprint 3 — 智能记忆系统升级 (优先级: P1, 预计 2-3 天)

#### 3.3.1 结构化记忆 + Boot/Shutdown 协议

**目标**: 从 Markdown 追加式记忆升级为结构化 JSON 记忆，支持自动 boot/shutdown。

**方案: 重构 memory-system.ts**:

```typescript
// 新增: 结构化记忆格式
interface MemorySystem {
  // Boot — Agent 启动时自动执行
  boot(projectId: string): Promise<BootContext>;
  
  // 暂存 — 执行过程中自动写入
  stash(entry: MemoryEntry): Promise<void>;
  
  // Shutdown — 任务完成时自动整理
  shutdown(projectId: string): Promise<ShutdownReport>;
  
  // 技能匹配 — 任务开始时自动匹配
  matchSkills(taskDescription: string): Promise<MatchedSkill[]>;
  
  // 经验检索 — RAG 式语义搜索
  search(query: string, scope: 'global' | 'project' | 'role'): Promise<MemoryHit[]>;
}

interface BootContext {
  /** 项目基本信息 */
  projectProfile: ProjectProfile;
  /** 最近 5 次会话摘要 */
  recentSessions: SessionSummary[];
  /** 匹配的技能列表 */
  matchedSkills: MatchedSkill[];
  /** 活跃的原则和模式 */
  activeLessons: Lesson[];
  /** 未合并的暂存条目 */
  pendingStash: MemoryEntry[];
}
```

**关键升级点**:
1. **自动 Boot**: Agent 开始工作前，自动加载项目上下文 + 最近会话 + 匹配技能
2. **暂存区**: 执行过程中的重要发现自动写入暂存区（不影响正式记忆）
3. **自动 Shutdown**: 任务完成时自动整理暂存区 → 去重 → 合并到正式记忆
4. **经验索引**: 用轻量 embedding（本地模型 or 关键词匹配）支持语义搜索

#### 3.3.2 用户画像系统

**目标**: Agent 自动学习用户偏好，逐步提高决策质量。

```typescript
interface UserProfile {
  /** 技术偏好 (如 "偏好 TypeScript + React") */
  techPrefs: string[];
  /** 代码风格偏好 (如 "使用 2 空格缩进") */
  codeStyle: Record<string, string>;
  /** 交互风格 (如 "直接给结论不客套") */
  interactionStyle: string;
  /** 已确认的决策 (如 "后端用 Supabase") */
  confirmedDecisions: Decision[];
  /** 推断的偏好 (低置信度, 可被覆盖) */
  inferredPrefs: InferredPref[];
}
```

**超越 EchoAgent 的点**:
- EchoAgent 的用户画像是静态 JSON，需要手工维护
- AgentForge 可以**自动推断**用户偏好（从代码风格、技术选型、反馈中学习）
- 支持**按项目差异化**（同一用户不同项目可能有不同偏好）

---

### 3.4 Sprint 4 — 元 Agent 交互层 (优先级: P1, 预计 3-4 天)

#### 3.4.1 Meta Agent — 人机协同编排

**目标**: 在流水线 Agent（PM/Architect/Dev/QA）之上增加一个 Meta Agent 层，作为用户交互的唯一入口。

**设计**:
```
用户 ←→ Meta Agent ←→ Pipeline (PM → Architect → Dev → QA)
                  ↕
            子 Agent Pool
```

**Meta Agent 职责**:
1. **需求理解**: 将用户自然语言转化为结构化意图
2. **路由决策**: 判断是新项目/迭代变更/Bug 修复/纯问答，路由到对应处理流程
3. **进度汇报**: 主动向用户报告进展，而非等用户查看
4. **中途交互**: 当 Agent 遇到阻塞时，Meta Agent 暂停流水线 → 向用户提问 → 收到回答后恢复
5. **结果审查**: 流水线完成后，Meta Agent 审查产出质量，必要时自行发起重做

**新增工具**:
```
ask_user         — 暂停执行，向用户提问并等待回答
show_progress    — 向用户展示当前进度（不暂停）
present_options  — 向用户展示多个方案供选择
request_review   — 请求用户审查产出
```

**超越 EchoAgent 的点**:
- EchoAgent 的编排是**响应式**的（用户说一句，做一步）
- AgentForge 的 Meta Agent 是**主动式**的（自主推进 + 关键节点请求人类参与）
- 支持**批处理**模式（用户提需求后离开，Agent 自主完成并通知）

#### 3.4.2 对话式交互 (Chat Mode)

**目标**: 除了"许愿-执行"模式外，新增对话模式，让用户可以像与 EchoAgent 聊天一样交互。

**方案**:
```
新增 Meta Agent 的对话模式:
- 用户可以在任何时候切换到对话模式
- 对话模式中 Meta Agent 拥有 read_file/search_files/web_search 等工具
- 可以回答关于项目的问题（"当前有哪些 Feature？""ARCHITECTURE.md 说了什么？"）
- 可以执行轻量操作（"帮我看看这个文件""搜索一下 XXX"）
- 可以在对话中启动流水线（"开始开发这个 Feature"）
```

---

### 3.5 Sprint 5 — 图像生成 + 多模态 (优先级: P2, 预计 2-3 天)

#### 3.5.1 图像生成 MCP Server

**目标**: 通过 MCP Server 接入图像生成能力。

**方案: 新建 MCP Server — agentforge-image-server**:
```
工具列表:
- generate_image    — 文生图 (DALL-E / Stability AI / 即梦)
- edit_image        — 图生图 / 局部编辑
- generate_icon     — 应用图标生成
- generate_mockup   — UI 原型图生成 (输入描述 → 线框图)
- image_to_code     — 图片转 UI 代码 (截图 → React/HTML)
```

**超越 EchoAgent 的点**:
- EchoAgent 的图像能力分散在 3 个子 Agent 中，需要主 Agent 手工调度
- AgentForge 将图像能力**深度集成到开发流水线**:
  - PM 阶段: 自动生成 UI Mockup 辅助需求描述
  - Architect 阶段: 自动生成架构图 (Mermaid → SVG)
  - Dev 阶段: image_to_code 将设计稿转为代码
  - QA 阶段: compare_screenshots 自动视觉回归

#### 3.5.2 多模态上下文

**目标**: Agent 在对话和执行中原生支持图像输入/输出。

**方案**:
```
- LLM Client 支持 Vision Message (image_url / base64)
- 用户 Wish 支持附带图片 ("做一个像这样的界面" + 截图)
- Agent 产出支持图像 (将生成的图片嵌入文档)
- 浏览器截图自动纳入上下文 (visual feedback loop)
```

---

### 3.6 Sprint 6 — 高级特性 (优先级: P2, 预计 4-5 天)

#### 3.6.1 实时协作通道

**目标**: 用户可以在 Agent 执行过程中实时观察和干预。

**方案**:
```
- 实时日志流 (已有 SSE, 增强)
- 文件变更实时通知 (file watcher → UI diff view)
- Agent 思考过程可视化 (think 工具输出 → 侧边栏)
- 用户可随时注入指令 ("停一下，先处理这个 bug")
- Agent 决策树可视化 (当前正在考虑的方案 A/B/C)
```

#### 3.6.2 MCP Server 生态

**目标**: 预置常用 MCP Server，打造"开箱即用"的扩展生态。

**预置 MCP Server 清单**:
```
1. agentforge-search-server    — 多源搜索聚合 (SerpApi + Brave + Tavily)
2. agentforge-image-server     — 图像生成/编辑 (DALL-E + Stability)
3. agentforge-db-server        — 数据库操作 (SQLite + PostgreSQL + MySQL)
4. agentforge-deploy-server    — 部署 (Vercel + CF Pages + Railway)
5. agentforge-monitor-server   — 监控 (Sentry + Uptime)
6. agentforge-design-server    — 设计 (Figma API 读取 + 设计 Token 提取)
7. agentforge-docs-server      — 文档 (Notion + Confluence API)
```

**MCP Server 商店**:
- 社区贡献的 MCP Server 索引
- 一键安装 + 自动配置
- 版本管理 + 兼容性检查

#### 3.6.3 自适应工作流

**目标**: 从固定 5 阶段流水线升级为自适应工作流。

**方案**:
```
- Meta Agent 根据任务类型自动选择工作流:
  - "新项目" → 完整 5 阶段
  - "修 Bug" → 诊断 → 定位 → 修复 → 验证 (跳过 PM/Architect)
  - "重构" → 分析 → 规划 → 逐步重构 → 回归测试
  - "纯问答" → 直接对话 (不启动流水线)
  - "运维" → DevOps Agent 直接执行
- 用户可自定义工作流模板 (已有 WorkflowPreset 基础)
- 工作流可在执行中动态调整 (Meta Agent 判断)
```

---

## 四、优先级排序与实施计划

### 4.1 实施优先级

```
Phase 1 (Week 1): Sprint 1 + Sprint 2 — 基础外部交互 + 子 Agent
  ├── 搜索引擎升级 (1天)
  ├── Docker 沙箱 (2天)
  ├── 浏览器自动化增强 (1天)
  └── 子 Agent 框架 (3天)

Phase 2 (Week 2): Sprint 3 + Sprint 4 — 记忆系统 + Meta Agent
  ├── 结构化记忆 + Boot/Shutdown (2天)
  ├── 用户画像系统 (1天)
  ├── Meta Agent 交互层 (3天)
  └── 对话式交互 (1天)

Phase 3 (Week 3): Sprint 5 + Sprint 6 — 多模态 + 高级特性
  ├── 图像生成 MCP Server (2天)
  ├── 多模态上下文 (1天)
  ├── 实时协作通道 (2天)
  ├── MCP Server 生态 (2天)
  └── 自适应工作流 (2天)
```

### 4.2 关键里程碑

| 里程碑 | 达成标准 | 预期时间 |
|--------|---------|---------|
| M1: 外部交互对齐 | 搜索质量 ≥ EchoAgent, Docker 沙箱可用, 浏览器 API 完整 | Week 1 中 |
| M2: 子 Agent 超越 | 支持 6+ preset 子 Agent, 并行执行, 链式调用 | Week 1 末 |
| M3: 记忆智能化 | 自动 boot/shutdown, 技能匹配, 用户画像 | Week 2 中 |
| M4: 人机协同 | Meta Agent 可对话, 可中途交互, 可主动推进 | Week 2 末 |
| M5: 全面超越 | 图像生成, MCP 生态, 自适应工作流全部可用 | Week 3 末 |

---

## 五、AgentForge 的结构性优势 (超越 EchoAgent 的基础)

在补齐差距的同时，必须清楚认识到 AgentForge 已有的结构性优势——这些是 EchoAgent 无法做到的：

| 优势维度 | AgentForge | EchoAgent |
|---------|-----------|-----------|
| **自主开发** | 完整 5 阶段流水线, 用户许愿 → 自动交付 | 每步需人工指令驱动 |
| **代码理解** | Code Graph + BFS 依赖分析 + repo-map | 只有 grep + 文件搜索 |
| **质量守护** | 5 种 Guard + TDD + QA Loop + Budget | 无系统化质量保障 |
| **成本控制** | 模型选择器 + 预算守卫 + 定价表 | 无成本控制机制 |
| **项目级记忆** | 3 层记忆 + 跨项目 Knowledge Pool | 单一记忆文件系统 |
| **文档驱动** | doc-manager + 设计文档 + 测试规格 | 无文档管理 |
| **断点续跑** | Mission checkpoint + 状态恢复 | 依赖手工 checkpoint |
| **扩展性** | MCP Client + Skill Evolution | 依赖平台内置工具 |

**核心洞察**: AgentForge 的优势在**深度**（单一项目的开发能力），EchoAgent 的优势在**广度**（跨领域的交互能力）。本方案的目标是让 AgentForge 在保持深度优势的同时补齐广度，最终在两个维度都超越。

---

## 六、技术实现注意事项

### 6.1 opus4.6 模型特性利用

opus4.6 作为 AgentForge 计划采用的模型，有以下特性值得深度利用:

1. **超长上下文**: 充分利用长窗口，减少 summarize 压缩频率
2. **强推理**: 复杂编排逻辑可以直接放在 prompt 中，减少硬编码规则
3. **原生 tool-use**: 减少 output-parser 的 JSON 修复开销
4. **多模态**: 原生支持图像输入，不需要单独的 vision 模型

### 6.2 架构约束

1. **MCP-First**: 所有新增外部工具通过 MCP Server 接入，保持 engine 核心精简
2. **向后兼容**: 新增能力不破坏现有 42 个工具和 5 阶段流水线
3. **可选依赖**: Docker/SerpApi 等外部服务为可选配置，缺少时自动降级
4. **安全优先**: 沙箱隔离 + 工具权限 + 用户确认的三重防线

### 6.3 避免的陷阱

1. **不要复制 EchoAgent 的实现**: EchoAgent 是基于平台 MCP 的松散协作，AgentForge 应基于自身架构做更紧密的集成
2. **不要过度设计**: 先做最小可用版本，在实际使用中迭代优化
3. **不要忽略已有优势**: Code Graph、Guards、Budget 等是 AgentForge 独有的竞争力，新能力必须与之集成
4. **不要盲目追求工具数量**: 45 个高质量工具 > 100 个低质量工具

---

## 七、总结

### 当前状态
- AgentForge: 单项目深度 ★★★★★, 外部交互广度 ★★☆☆☆
- EchoAgent:  单项目深度 ★★☆☆☆, 外部交互广度 ★★★★★

### 目标状态 (3 周后)
- AgentForge: 单项目深度 ★★★★★, 外部交互广度 ★★★★★

### 关键差异化
```
EchoAgent: "一个聪明的助手，啥都能帮你做一点"
AgentForge: "一个自主的开发团队，啥都能帮你做到底"
```

AgentForge 的终极目标不是成为另一个 EchoAgent，而是成为一个**拥有 EchoAgent 交互广度 + 自身开发深度**的全能 Agent 平台。通过 MCP 生态扩展 + 子 Agent 框架 + Meta Agent 编排层的三位一体升级，AgentForge 将在保持核心竞争力（自主开发）的同时，全面超越 EchoAgent 的外部交互能力。
