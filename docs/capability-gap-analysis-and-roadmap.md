# AgentForge 能力完善方案 — 对标并超越 EchoAgent

> 撰写日期: 2026-03-02  
> 迭代: v2 — 严格区分「平台原生能力」与「外挂可移植能力」  
> 目标: 系统性分析 AgentForge Agent 与 EchoAgent 在外部交互能力上的差距，制定可落地的完善路线图  
> 基准模型: opus4.6 (AgentForge 计划采用)

---

## 〇、认知校准：什么才是 EchoAgent 的「真正能力」？

上一版文档犯了一个关键错误：**把 system prompt + 文件读写实现的"外挂记忆系统"当成了 EchoAgent 的原生平台能力**。

实际上，"我"（Tim 的开发助手）的能力可以严格分为三层：

### 第一层：EchoAgent 平台原生能力（不可移植，平台提供）

这些是 EchoAgent 平台内置的工具和基础设施，**任何挂载在该平台上的 Agent 都自动拥有**，与 system prompt 无关：

| 能力 | 具体实现 | 不可移植原因 |
|------|---------|-------------|
| **bash** | PowerShell 5.1 本地执行 | 平台宿主机能力 |
| **DockerSandbox** | 完整容器生命周期管理 | 平台侧 Docker Daemon 集成 |
| **Playwright MCP** | 20+ 浏览器自动化 API | 平台内置 MCP Server |
| **WebSearch** | SerpApi Google 级搜索 + URL 读取 | 平台侧 SerpApi Key + 代理 |
| **read/edit/multiedit/ls/grep** | 宿主机文件系统操作 | 平台文件系统挂载 |
| **code-search** | ripgrep + glob 代码搜索 | 平台侧 MCP Server |
| **todowrite/todoread** | 会话级任务管理 | 平台内置会话状态 |
| **GUI_computer_*** | 屏幕截图/鼠标/键盘操控 | 平台侧桌面控制 |
| **ask_agent** | 子 Agent 调用（10 个子 Agent） | 平台 Agent 路由 + 会话管理 |
| **上下文压缩/恢复** | memory_check_status/compress | 平台侧 token 管理 |

### 第二层：外挂式能力（我自建的，可移植到任何有文件读写的 Agent）

这些是**通过 system prompt 指令 + 文件读写工具**实现的，**AgentForge 可以直接复制**：

| 能力 | 实现方式 | 移植难度 |
|------|---------|---------|
| **boot/shutdown 记忆协议** | system prompt 指令 + read/edit JSON 文件 | 低 — 写 prompt + 定义文件格式 |
| **结构化记忆文件** | agent_identity/user_profile/lessons_learned/skill_index 等 JSON | 低 — 定义 schema |
| **暂存区机制** | session_scratchpad.json + 写入触发条件 | 低 — prompt 规则 |
| **技能触发匹配** | 扫描 skill_index 的 trigger 字段 + 按需读取 skill 文件 | 低 — LLM 匹配 |
| **cognitive_patches** | system prompt 中的自我纠偏规则 | 低 — prompt 文本 |
| **三层备忘录同步** | CLAUDE.md ↔ detail_file ↔ active_project | 中 — 需适配文件结构 |

### 第三层：emergent 能力（LLM 模型本身 + prompt 工程涌现的）

| 能力 | 说明 |
|------|------|
| **动态编排** | 主 Agent 根据任务性质自行决定工具使用策略和子 Agent 调度顺序 |
| **自我质疑** | 在 prompt 中要求"完成前必须外部验证"等元认知约束 |
| **跨领域迁移** | LLM 通用知识 + 记忆中积累的 patterns 实现经验复用 |

**关键结论：AgentForge 真正需要对标的是「第一层」— 平台原生能力。第二层可以直接移植，第三层取决于 LLM 模型能力（opus4.6 ≥ 现有模型）。**

---

## 一、能力全景对比（重新校准后）

### 1.1 平台原生能力对比

```
┌─────────────────────────────────────────────────────────────────────┐
│                    EchoAgent 平台原生能力                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  执行环境                    网络/搜索                               │
│  ├── bash (宿主 PS5.1)      ├── WebSearch (SerpApi, Google级)       │
│  ├── DockerSandbox (完整)   └── read_url (可控: clean/max_length)   │
│  └── GUI_computer (桌面)                                             │
│                                                                     │
│  浏览器自动化                子Agent路由                              │
│  ├── Playwright MCP          ├── ask_agent() — 10个子Agent           │
│  │   ├── navigate/click/     │   ├── 研究: WebResearch ×2            │
│  │   │   type/snapshot       │   ├── 代码: git sandbox, Code Search  │
│  │   ├── fill_form/drag      │   ├── 视觉: 设计绘画, NanoBanana, 即梦│
│  │   ├── tabs/file_upload    │   ├── 审查: SimpleChatBot, CR高手     │
│  │   ├── evaluate/console    │   └── 桌面: GUI Agent                 │
│  │   └── wait_for/run_code   │                                       │
│  │                           │   特性: fork会话/继承上下文/异步      │
│  └── (20+ API)              └── (每个子Agent有独立工具集)             │
│                                                                     │
│  文件系统                    会话管理                                 │
│  ├── read/edit/multiedit     ├── todowrite/todoread                  │
│  ├── ls/grep                 ├── memory_check_status/compress        │
│  └── code-search MCP         └── 上下文自动压缩/恢复                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    AgentForge 引擎原生能力                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  执行环境                    网络/搜索                               │
│  ├── run_command (子进程)    ├── web_search (Jina, 免费但弱)         │
│  ├── run_test / run_lint     ├── fetch_url (Jina Reader, 基础)      │
│  └── check_process (后台)    └── http_request (通用HTTP)             │
│                                                                     │
│  浏览器自动化                子Agent                                  │
│  ├── browser_* (10个)        └── spawn_researcher (只读, 8轮)        │
│  │   ├── launch/navigate/                                            │
│  │   │   screenshot/snapshot                                         │
│  │   ├── click/type/evaluate                                         │
│  │   └── wait/network/close                                          │
│  └── Computer Use (5个)                                              │
│                                                                     │
│  文件系统                    ⭐ AgentForge 独有                       │
│  ├── read/write/edit/batch   ├── 5阶段自动流水线 (PM→Arch→Dev→QA)   │
│  ├── list/glob/search        ├── Code Graph + BFS依赖分析            │
│  └── git_commit/diff/log     ├── 5种Guard (Tool/React/QA/Pipeline)   │
│                              ├── Budget Controller + Model Selector   │
│  记忆/技能                   ├── doc-manager (设计/规格/测试文档)     │
│  ├── memory_read/append      ├── Mission checkpoint + 续跑            │
│  ├── skill_acquire/search    ├── Cross-project Knowledge Pool         │
│  └── skill_improve/record    ├── MCP Client (stdio + SSE)             │
│                              └── Skill Evolution (自主习得)            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 差距矩阵（重新校准）

| 维度 | EchoAgent 平台 | AgentForge | 差距 | 性质 |
|------|--------------|-----------|------|------|
| **联网搜索** | SerpApi (Google级, 并发, 结构化JSON) | Jina (免费, 不稳定, Markdown) | 🔴 | 平台原生 |
| **URL 读取** | read_url (clean_content, max_length, JS渲染) | Jina Reader (纯文本, 无渲染) | 🟡 | 平台原生 |
| **容器沙箱** | DockerSandbox (隔离/镜像/端口/文件IO) | sandbox-executor (裸子进程) | 🔴 | 平台原生 |
| **浏览器API完整度** | Playwright MCP (20+ API, 可访问性快照) | browser_* (10 API) | 🟡 | 平台原生 |
| **子Agent数量** | 10个专业子Agent (研究/代码/视觉/审查/桌面) | 1个spawn_researcher (只读) | 🔴 | 平台原生 |
| **子Agent调度** | ask_agent (fork/继承/异步/跨模型) | 同步阻塞, 无并行 | 🔴 | 平台原生 |
| **图像生成** | 3个视觉子Agent (文生图/图生图/编辑) | 0 (仅有视觉分析) | 🔴 | 平台原生 |
| **桌面操控** | GUI_computer (完整) + GUI Agent子Agent | Computer Use (基础5工具) | 🟡 | 平台原生 |
| **人机中途交互** | ask_agent到SimpleChatBot做审查等 | report_blocked (仅标记) | 🟡 | 平台原生 |
| **上下文管理** | 平台自动压缩/恢复 | 手动消息压缩(LLM Summarizer) | 🟡 | 平台原生 |
| ── 分隔线 ── | | | | |
| **记忆boot/shutdown** | ★外挂:prompt+文件读写 (AgentForge可直接复制) | memory_read/append (基础) | ⚪ | 可移植 |
| **技能匹配** | ★外挂:扫描trigger字段 (可移植) | skill_search (已有!) | ⚪ | 可移植 |
| **用户画像** | ★外挂:user_profile.json (可移植) | 无 | ⚪ | 可移植 |
| **cognitive_patches** | ★外挂:prompt自纠偏 (可移植) | 无 (但prompt可加) | ⚪ | 可移植 |
| ── 分隔线 ── | | | | |
| **自主开发流水线** | 无 | 5阶段全自动 | 🟢 AgentForge **显著优势** | |
| **代码理解** | grep + 文件搜索 | Code Graph + BFS + repo-map | 🟢 AgentForge 优势 | |
| **质量守护** | 无系统化 | 5种Guard + TDD + QA Loop | 🟢 AgentForge 优势 | |
| **成本控制** | 无 | Budget Guard + Model Selector | 🟢 AgentForge 优势 | |
| **文档驱动** | 无 | doc-manager + 设计/规格/测试 | 🟢 AgentForge 优势 | |
| **断点续跑** | 无(依赖外挂checkpoint) | Mission checkpoint | 🟢 AgentForge 优势 | |
| **工具扩展性** | 受限于平台内置 | MCP Client + Skill Evolution | 🟢 AgentForge 优势 | |

**结论重述**：
- 🔴 严重差距 5 个 — 全部是**平台原生能力**（搜索/沙箱/子Agent调度/子Agent数量/图像生成）
- 🟡 中等差距 5 个 — 平台原生（URL读取/浏览器/桌面/人机交互/上下文管理）
- ⚪ 可移植 4 个 — 上一版高估的"差距"，实际可低成本复制
- 🟢 优势 7 个 — AgentForge 独有的开发深度

---

## 二、关键差距深度分析（仅聚焦平台原生差距）

### 🔴 差距 1: 联网搜索质量

| | EchoAgent | AgentForge |
|---|-----------|-----------|
| 后端 | SerpApi → Google | Jina Search → 自有索引 |
| 并发 | `queries: string[]` 多查询并发 | 单查询串行 |
| 结构化 | 返回 JSON (title/url/snippet) | 返回 Markdown (需解析) |
| 垂直搜索 | 图片/学术/新闻 | 仅网页 |
| 稳定性 | 付费 SLA | 免费, 高峰限流 |
| API Key | 平台管理 | 无 (匿名) |

**核心问题**: Jina Search 是一个不稳定的免费服务，在 Agent 需要可靠信息检索时是严重瓶颈。

### 🔴 差距 2: 容器沙箱

| | EchoAgent | AgentForge |
|---|-----------|-----------|
| 隔离 | Docker 容器完全隔离 | 子进程, 无隔离 |
| 镜像 | 任意 Docker 镜像 | 仅宿主环境 |
| 文件IO | 容器↔宿主互传 + OSS | 共享文件系统 |
| 端口 | expose_port → 外部访问 | 无 |
| 生命周期 | init → exec → destroy | exec → 结束 |
| 资源限制 | Docker cgroups | 无 |
| 安全 | Agent 代码在容器内运行 | Agent 代码直接在宿主执行 |

**核心问题**: 当 Agent 生成的代码需要执行时（安装依赖、运行测试、启动服务），缺少隔离是**安全性和可靠性的双重硬伤**。

### 🔴 差距 3: 子 Agent 系统

| | EchoAgent | AgentForge |
|---|-----------|-----------|
| 数量 | 10 个专业子 Agent | 1 个 (只读研究) |
| 权限 | 每个子 Agent 有独立工具集 | 仅 read/list/search |
| 写能力 | 多个子 Agent 可写文件/执行命令 | 不可写 |
| 并行 | 支持异步并行 | 同步阻塞 |
| 会话管理 | fork/继承/恢复 | 无状态单次 |
| 跨模型 | 不同子 Agent 可用不同 LLM | 统一模型 |
| 领域覆盖 | 研究/代码/视觉/审查/桌面 | 仅研究 |

**核心问题**: spawn_researcher 是一个最小化实现。开发者面对"调研 + 编码 + 测试"这种复合任务时，无法委派子任务给专业角色。

### 🔴 差距 4: 图像生成

EchoAgent 平台挂载了 3 个视觉子 Agent（设计绘画助手/NanoBanana/即梦提示词助手），覆盖文生图、图生图、编辑、融合等完整链路。

AgentForge 的 `visual-tools.ts` 仅有**分析**能力（analyze_image/compare_screenshots/visual_assert），完全**无法生成图像**。

---

## 三、能力完善方案 (Roadmap)

### 3.0 设计原则

1. **MCP-First**: 所有新增外部能力优先通过 MCP Server 接入，保持引擎核心精简
2. **区分平台层和外挂层**: 平台原生差距需要引擎改造，外挂差距只需 prompt/config
3. **超越而非复制**: 利用 AgentForge 的架构优势（共享 workspace/Code Graph/Guards）做更紧密的集成
4. **opus4.6 原生优势**: 充分利用强推理+长上下文+原生 tool-use+多模态

---

### Sprint 1 — 搜索与网络 (P0, 1-2 天)

#### 3.1.1 搜索引擎 Provider 化

```typescript
// electron/engine/search-provider.ts

interface SearchProvider {
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
  readUrl(url: string, opts?: { maxLength?: number; clean?: boolean }): Promise<string>;
}

// 实现 1: SerpApi (用户提供 Key)
class SerpApiProvider implements SearchProvider { ... }

// 实现 2: Tavily (AI原生搜索, 专为Agent设计, 有免费额度)
class TavilyProvider implements SearchProvider { ... }

// 实现 3: Brave Search (免费额度充足)
class BraveSearchProvider implements SearchProvider { ... }

// 实现 4: Jina (保留为终极 fallback)
class JinaProvider implements SearchProvider { ... }

// 自动 fallback chain
const chain = [SerpApiProvider, TavilyProvider, BraveSearchProvider, JinaProvider];
```

**Settings 新增**:
- `searchProvider`: 'serpapi' | 'tavily' | 'brave' | 'jina' | 'auto'
- `searchApiKey`: 对应 API Key
- `searchCache`: boolean (会话内缓存, 减少重复调用)

**超越点**:
- EchoAgent 被锁死在 SerpApi，不可切换
- AgentForge: Provider 可插拔 + fallback chain + 会话内缓存 + 多查询并发

#### 3.1.2 URL 读取增强

当前 Jina Reader 问题: 不支持 JS 渲染页面、无法控制清洗策略。

**方案**: 复用已有的 `browser-tools.ts` 作为高级 URL 读取方案：
```
fetch_url 增强:
1. 先尝试 Jina Reader (快, 无需浏览器)
2. 失败或检测到 SPA → 自动 fallback 到 browser_navigate + browser_snapshot
3. 返回 accessibility snapshot (比原始 HTML 更省 token, 与 EchoAgent 的 Playwright snapshot 对齐)
```

---

### Sprint 2 — 容器沙箱 (P0, 2-3 天)

#### 3.2.1 Docker 沙箱集成

```typescript
// electron/engine/docker-sandbox.ts

interface DockerSandbox {
  // 生命周期
  init(config: SandboxConfig): Promise<string>;     // → containerId
  exec(id: string, cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  destroy(id: string): Promise<void>;
  
  // 文件 IO
  writeFile(id: string, path: string, content: string): Promise<void>;
  readFile(id: string, path: string): Promise<string>;
  copyToContainer(id: string, hostPath: string, containerPath: string): Promise<void>;
  copyFromContainer(id: string, containerPath: string, hostPath: string): Promise<void>;
  
  // 网络
  exposePort(id: string, containerPort: number): Promise<{ hostPort: number }>;
  
  // 状态
  snapshot(id: string): Promise<string>;   // → snapshotId (超越 EchoAgent)
  restore(snapshotId: string): Promise<string>; // → 新 containerId
}

interface SandboxConfig {
  image: string;              // 如 'node:20-slim', 'python:3.12-slim'
  env?: Record<string, string>;
  workDir?: string;
  mountWorkspace?: boolean;   // 是否将项目 workspace 挂载到容器
  cpuLimit?: number;          // CPU 限制 (核)
  memoryLimit?: string;       // 内存限制 (如 '512m')
}
```

**工具注册** (6 个新工具):
```
sandbox_init     — 创建容器 (选镜像/环境/挂载)
sandbox_exec     — 容器内执行命令
sandbox_write    — 写文件到容器
sandbox_read     — 从容器读文件
sandbox_expose   — 暴露端口
sandbox_destroy  — 销毁容器
```

**智能路由** (超越 EchoAgent):
```typescript
// run_command 增强: 自动风险检测 → 路由到沙箱
function shouldUseSandbox(command: string): boolean {
  const dangerous = ['rm -rf', 'mkfs', 'dd if=', 'curl | bash', 'npm install -g'];
  const needsIsolation = ['pip install', 'npm install', 'cargo build'];
  return dangerous.some(d => command.includes(d)) || needsIsolation.some(d => command.includes(d));
}
```

**预置沙箱模板**:
```
node-dev    → node:20-slim + 常用 devDeps 预装
python-dev  → python:3.12-slim + pip
rust-dev    → rust:1.76-slim
go-dev      → golang:1.22-alpine
fullstack   → node:20 + python3 + docker-cli
```

**超越点**:
- EchoAgent 无 snapshot/restore（每次都是全新容器）
- EchoAgent 无智能路由（全靠 Agent 自行判断）
- EchoAgent 无预置模板（每次手动指定镜像）

---

### Sprint 3 — 子 Agent 框架重构 (P0, 3-4 天)

#### 3.3.1 通用子 Agent 框架

**核心设计**: 利用 AgentForge 已有的 `reactAgentLoop`，将其泛化为可配置的子 Agent 执行器。

```typescript
// electron/engine/sub-agent-framework.ts

interface SubAgentPreset {
  id: string;
  name: string;
  systemPrompt: string;
  tools: string[];         // 工具白名单
  canWrite: boolean;
  maxIterations: number;
  contextStrategy: 'full' | 'summary' | 'minimal';
  model?: ModelTier;       // 'strong' | 'worker' | 'mini'
}

const PRESETS: SubAgentPreset[] = [
  {
    id: 'researcher',
    name: '研究员',
    systemPrompt: '你是一个研究员，负责调研问题并给出结论...',
    tools: ['read_file', 'list_files', 'search_files', 'glob_files',
            'web_search', 'fetch_url', 'think'],
    canWrite: false,
    maxIterations: 10,
    contextStrategy: 'summary',
    model: 'worker',
  },
  {
    id: 'coder',
    name: '编码员',
    systemPrompt: '你是一个编码员，负责实现具体的编码任务...',
    tools: ['read_file', 'write_file', 'edit_file', 'batch_edit',
            'list_files', 'search_files', 'run_command', 'run_test', 'think'],
    canWrite: true,
    maxIterations: 20,
    contextStrategy: 'full',
    model: 'worker',
  },
  {
    id: 'reviewer',
    name: '审查员',
    systemPrompt: '你是一个代码审查专家，给出高质量审查意见...',
    tools: ['read_file', 'search_files', 'list_files', 'glob_files', 'think'],
    canWrite: false,
    maxIterations: 10,
    contextStrategy: 'full',
    model: 'strong',   // 审查需要强模型
  },
  {
    id: 'tester',
    name: '测试员',
    systemPrompt: '你是一个测试工程师...',
    tools: ['read_file', 'write_file', 'run_test', 'run_lint', 'run_command',
            'browser_*', 'screenshot', 'think'],
    canWrite: true,
    maxIterations: 15,
    contextStrategy: 'summary',
  },
  {
    id: 'doc_writer',
    name: '文档作者',
    systemPrompt: '你是一个技术文档作者...',
    tools: ['read_file', 'write_file', 'search_files', 'web_search', 'think'],
    canWrite: true,
    maxIterations: 10,
    contextStrategy: 'summary',
    model: 'worker',
  },
  {
    id: 'deployer',
    name: '运维员',
    systemPrompt: '你是一个运维工程师...',
    tools: ['run_command', 'check_process', 'http_request', 'read_file',
            'git_commit', 'git_diff', 'git_log', 'think'],
    canWrite: true,
    maxIterations: 12,
    contextStrategy: 'minimal',
  },
];
```

#### 3.3.2 新增工具

```
spawn_agent      — 启动子Agent (指定preset或自定义config + 任务描述)
spawn_parallel   — 并行启动多个子Agent (各自独立推进, 汇总结果)
get_agent_status — 查询子Agent执行状态
cancel_agent     — 取消子Agent
```

#### 3.3.3 并行执行 + 冲突防护

```typescript
// spawn_parallel 核心逻辑
async function spawnParallel(tasks: SubAgentTask[]): Promise<SubAgentResult[]> {
  // 1. 写入子Agent各自分配文件级锁 (复用 file-lock.ts)
  // 2. Promise.allSettled 并行执行
  // 3. 收集结果 + 检测文件冲突
  // 4. 如有冲突 → 由父Agent审查决策
  return Promise.allSettled(tasks.map(t => runSubAgent(t)));
}
```

**超越 EchoAgent 的结构性优势**:
- EchoAgent 的子 Agent 是**独立服务**（不共享文件系统、不共享上下文、每次调用是全新会话）
- AgentForge 子 Agent **共享 workspace + 记忆 + Code Graph + file-lock**:
  - researcher 的调研结果可以直接引用项目文件
  - coder 编写的代码可以被 reviewer 立即审查（无需文件传输）
  - 多个 coder 并行时有 file-lock 防冲突（EchoAgent 没有）
  - 所有子 Agent 共享项目记忆（EchoAgent 子 Agent 无法读取主 Agent 的记忆文件）

---

### Sprint 4 — 浏览器 & 桌面增强 (P1, 1-2 天)

补齐与 EchoAgent Playwright MCP 的 API 差距。

**新增工具** (基于已有 `browser-tools.ts` 扩展):
```typescript
// browser-tools.ts 扩展

browser_fill_form    // 批量填表 (EchoAgent 的 browser_fill_form)
browser_drag         // 拖放
browser_tabs         // 标签页管理 (list/new/close/select)
browser_file_upload  // 文件上传
browser_hover        // 悬停
browser_select       // 下拉选择
browser_press_key    // 键盘按键
browser_console      // 控制台日志
```

**智能增强** (超越 EchoAgent):
- **selector 自动修复**: CSS selector 找不到 → 自动截图 + 视觉 LLM 定位 → 坐标点击
- **自动等待**: 每个交互操作内置智能等待（不需要手动 browser_wait）
- **操作回放**: 记录操作序列 → 可重复执行（用于 QA 回归测试）

---

### Sprint 5 — Meta Agent + 人机协同 (P1, 3-4 天)

#### 3.5.1 Meta Agent 层

在 5 阶段流水线之上增加一个**常驻交互层**，解决 AgentForge 当前"许愿 → 等结果"的单向交互问题。

```
用户 ←→ Meta Agent ←→ Pipeline (PM → Arch → Dev → QA → DevOps)
              ↕
        Sub-Agent Pool
```

**Meta Agent 核心工具**:
```
ask_user         — 暂停流水线, 向用户提问, 收到回答后恢复
show_progress    — 推送进度到UI (不暂停)
present_options  — 展示方案A/B/C供用户选择
request_review   — 请求用户审查某个产出
```

**自适应路由**:
```
用户输入 → Meta Agent 意图识别:
  "开发一个XX"          → 启动完整流水线
  "修一个bug"          → 诊断→定位→修复→验证 (跳过PM/Architect)
  "帮我看看这个文件"    → spawn_agent(researcher) 即时回答
  "重构XX模块"         → 分析→规划→逐步重构→回归
  "搜一下XXX"          → web_search 直接回答
```

#### 3.5.2 对话模式

当前 AgentForge 只有"许愿"模式。新增对话模式，让用户可以像聊天一样交互：

```
- 可问项目问题 ("当前有哪些Feature？""架构文档说了什么？")
- 可执行轻量操作 ("帮我看这个文件""搜索XXX")
- 可在对话中触发流水线 ("开始开发F003")
- Meta Agent 拥有 read/search/web_search 等工具, 但无自动流水线
```

**超越点**:
- EchoAgent 是纯**响应式**（用户说一句做一步）
- AgentForge Meta Agent 是**主动式**（自主推进 + 关键节点征询人类 + 批处理模式）

---

### Sprint 6 — 图像生成 (P2, 2 天)

通过 MCP Server 接入图像生成能力。

```
新建 MCP Server: @agentforge/image-tools

工具:
- generate_image    — 文生图 (对接 DALL-E / Stability / 即梦)
- edit_image        — 图生图 / 局部编辑
- generate_icon     — 应用图标生成 (多尺寸)
- generate_mockup   — UI线框图生成
- image_to_code     — 截图 → React/HTML 代码
```

**流水线集成** (超越 EchoAgent):
```
PM阶段:   wish含"像这样"的截图 → image_to_code → 需求更精确
Arch阶段: 自动生成架构图 (Mermaid→SVG, 已有基础)
Dev阶段:  设计稿 → image_to_code → 生成前端代码
QA阶段:   compare_screenshots 视觉回归 (已有!)
```

EchoAgent 的图像能力分散在 3 个子 Agent 中需要手工调度；AgentForge 可以将其**自动嵌入开发流水线各阶段**。

---

### Sprint 7 — 外挂能力移植 + MCP 生态 (P2, 2-3 天)

#### 3.7.1 外挂记忆协议移植

将 EchoAgent 的"外挂"记忆机制（boot/shutdown/暂存/技能匹配）移植为 AgentForge 的原生模块：

```typescript
// memory-system.ts 升级

// Boot: 项目开始时自动加载
async function bootMemory(projectId: string): Promise<BootContext> {
  return {
    projectProfile: loadProjectProfile(projectId),
    recentSessions: loadRecentSessions(projectId, 5),
    matchedSkills: matchSkillsForTask(currentWish),
    activeLessons: loadLessons(projectId),
    pendingStash: loadUnmergedStash(projectId),
  };
}

// Stash: 执行中自动暂存 (不影响正式记忆)
async function stashInsight(entry: StashEntry): Promise<void> { ... }

// Shutdown: 任务完成时自动整理
async function shutdownMemory(projectId: string): Promise<void> {
  // 暂存区 → 去重 → 合并到正式记忆
}
```

**这不是 EchoAgent 的差距，而是 EchoAgent 上的外挂做法的「引擎原生化」，让 AgentForge Agent 天然拥有这些能力而不需要 prompt 指令。**

#### 3.7.2 MCP Server 生态

预置/推荐 MCP Server 列表，一键安装：

```
Tier 1 (预置):
- @agentforge/search-tools     — 多源搜索 (已在Sprint1实现)
- @agentforge/image-tools      — 图像生成 (已在Sprint6实现)

Tier 2 (推荐):
- @modelcontextprotocol/server-filesystem  — 扩展文件操作
- @modelcontextprotocol/server-github      — GitHub深度集成
- @agentforge/db-tools         — 数据库操作 (SQLite/PostgreSQL)
- @agentforge/deploy-tools     — 部署 (Vercel/CF Pages/Railway)
- @agentforge/design-tools     — Figma API 读取 + 设计Token提取
```

---

## 四、实施计划

### 优先级排序

```
Week 1: 补齐硬差距 (平台原生能力)
  ├── Sprint 1: 搜索Provider化 (1-2天)     → 解决🔴搜索差距
  ├── Sprint 2: Docker沙箱 (2-3天)          → 解决🔴沙箱差距
  └── Sprint 3: 子Agent框架 (3-4天)         → 解决🔴子Agent差距

Week 2: 补齐交互能力
  ├── Sprint 4: 浏览器增强 (1-2天)          → 解决🟡浏览器差距
  └── Sprint 5: Meta Agent (3-4天)          → 解决🟡人机协同差距

Week 3: 超越性特性
  ├── Sprint 6: 图像生成MCP (2天)           → 解决🔴图像差距
  └── Sprint 7: 外挂移植+MCP生态 (2-3天)   → 全面完善
```

### 里程碑

| 里程碑 | 标准 | 时间 |
|--------|------|------|
| **M1: 信息获取对齐** | 搜索质量≥EchoAgent(可切Provider), URL读取支持SPA | Week 1 Day 2 |
| **M2: 执行环境对齐** | Docker 沙箱可用, 智能路由到沙箱, 预置模板 | Week 1 Day 4 |
| **M3: 协作能力超越** | 6 preset子Agent + 并行 + file-lock + 共享上下文 | Week 1 末 |
| **M4: 交互能力超越** | Meta Agent可对话/可中途交互/可主动推进/自适应路由 | Week 2 末 |
| **M5: 全面超越** | 图像生成+MCP生态+外挂原生化, 所有🔴🟡差距清零 | Week 3 末 |

---

## 五、AgentForge 的不可替代优势（EchoAgent 无法做到的）

即使 EchoAgent 拥有更多平台原生工具，以下能力是 AgentForge 的**结构性优势**——不是靠加工具就能追上的：

| 维度 | 为什么 EchoAgent 做不到 |
|------|----------------------|
| **全自动开发流水线** | EchoAgent 是通用 Agent，无法内建 PM→Arch→Dev→QA 的领域流水线 |
| **Code Graph 依赖分析** | 需要静态分析引擎 + BFS 遍历，不是靠 grep 能替代的 |
| **5 种 Guard 系统** | 硬编码的安全约束（Tool/React/QA/Pipeline/Budget），prompt 无法可靠实现 |
| **Budget Controller** | 需要 token 精确计量 + 模型定价表 + 预算阈值，EchoAgent "无 token 计量" |
| **文档驱动开发** | doc-manager 管理 设计→规格→测试 文档链路，EchoAgent 没有文档管理模块 |
| **Mission 断点续跑** | 需要 SQLite 持久化 + checkpoint + 状态恢复，EchoAgent 的 checkpoint 是外挂文件 |
| **Skill Evolution** | Agent 自主习得→验证→晋升→跨项目共享，有完整的成熟度生命周期 |
| **模型选择器** | 按任务复杂度动态选 strong/worker/mini，精细化成本控制 |
| **跨项目 Knowledge Pool** | 14 tech tags 分类，项目完成自动提取经验注入新项目 |

**结论**: AgentForge 的核心竞争力在于**开发领域的深度系统化**。本方案的目标是在保持这些深度优势的基础上，补齐外部交互的广度——而非反过来。

---

## 六、总结

### v2 修正

| 项目 | v1 (错误) | v2 (修正) |
|------|----------|----------|
| 记忆系统 | 列为 EchoAgent 原生优势 | 外挂式，可直接移植 |
| 技能匹配 | 列为 EchoAgent 差距 | AgentForge 已有 skill_search/acquire |
| cognitive_patches | 列为需补齐的差距 | 纯 prompt 技巧，分钟级可移植 |
| 差距数量 | 15 维度差距 | 10 维度真差距(平台原生) + 4 可移植 |

### 重新校准后的状态

```
当前:
  AgentForge: 开发深度 ★★★★★, 外部交互 ★★☆☆☆, 人机协同 ★★☆☆☆
  EchoAgent:  开发深度 ★★☆☆☆, 外部交互 ★★★★☆, 人机协同 ★★★☆☆
              (注: EchoAgent 外部交互降为4星, 因为部分是外挂非原生)

目标 (3周后):
  AgentForge: 开发深度 ★★★★★, 外部交互 ★★★★★, 人机协同 ★★★★☆
```

### 核心差异化

```
EchoAgent:   "通用助手 + 外挂记忆" — 广度优先, 深度靠手工
AgentForge:  "开发专家 + 原生智能" — 深度原生, 广度通过MCP扩展
```

AgentForge 不需要成为另一个 EchoAgent。它需要的是：**用 MCP 生态补齐外部交互的平台级差距，用 Meta Agent 补齐人机协同的编排差距，同时保持并强化自身在自主开发领域的不可替代优势。**
