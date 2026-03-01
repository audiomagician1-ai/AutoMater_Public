# 智械母机 AutoMater — 设计文档

> Agent 版软件开发公司：用户许愿，虚拟团队交付。

> ⚠️ **注意**: 本文档为项目初始设计方案（Tauri + Monorepo 架构）。实际实现已迁移为 **Electron 33 单体架构**。
> 最新架构请参见 [`CLAUDE.md`](./CLAUDE.md)（v6.0 项目大脑）和 [`docs/IMPLEMENTATION-AUDIT-2026-03.md`](./docs/IMPLEMENTATION-AUDIT-2026-03.md)（规划 vs 现实差距分析）。
> 本文档保留作为产品愿景和角色体系的参考。

## 1. 产品愿景

一款 **PC 桌面应用**，用户只需输入原始需求（一句话 / 一段描述），即可启动一支由 AI Agent 组成的虚拟开发团队，自动完成：

```
需求输入 → 需求分析 → 任务拆解 → 架构设计 → 迭代开发 → 测试验收 → 交付产物
```

**核心隐喻**：一家 AI 软件开发公司，全员虚拟员工，用户是老板只管许愿。

---

## 2. 参考项目分析

### 2.1 Actant（D:\VibeCoding\Actant）

**核心借鉴**：
| 概念 | Actant 实现 | AutoMater 吸收 |
|------|-------------|-----------------|
| Docker 隐喻 | Template → Image → Instance | ✅ Agent 角色模板 → 实例化 |
| Agent 生命周期 | create → start → monitor → stop → destroy | ✅ 完整生命周期管理 |
| Domain Context | Skills + Prompts + MCP + Workflow 组合 | ✅ 角色能力定义系统 |
| Employee Scheduler | Heartbeat / Cron / Hook 三种触发源 | ✅ 任务调度器 |
| Web Dashboard | React SPA + SSE 实时推送 | ✅ 嵌入式 Dashboard UI |
| Monorepo 架构 | pnpm workspace + tsup 构建 | ✅ 模块化架构 |
| 权限控制 | 4 级预设 + 沙箱 | ✅ Agent 权限沙箱 |

### 2.2 agent-swarm（D:\EchoAgent\agent-swarm）

**核心借鉴**：
| 概念 | agent-swarm 实现 | AutoMater 吸收 |
|------|-----------------|-----------------|
| 三阶段工作流 | Init → Iterative Execution → Review | ✅ 核心流程 |
| 两层 Feature 清单 | 索引层(轻量) + 详情层(按需读取) | ✅ 任务管理结构 |
| Evaluator-Optimizer | 独立验证 + 诊断重试 | ✅ QA 验证循环 |
| RFC 机制 | Worker 反向反馈设计缺陷 | ✅ Agent 间协作协议 |
| HITL 审批门 | 文件级人工审批 | ✅ 用户审批节点 |
| CLAUDE.md 大脑 | 5 层结构的项目记忆 | ✅ 项目上下文持久化 |
| 成本追踪 | 按 feature / agent / date 聚合 | ✅ Token/成本监控 |
| 文件系统即记忆 | 不依赖 context，用文件持久化 | ✅ 设计原则 |

---

## 3. 系统架构

### 3.1 技术栈

| 层面 | 技术选型 | 理由 |
|------|---------|------|
| **桌面框架** | Tauri 2.x (Rust + WebView) | 轻量、安全、跨平台、原生性能 |
| **前端** | React 19 + TypeScript + Vite | 成熟生态、组件丰富 |
| **UI 库** | shadcn/ui + Tailwind CSS | 现代、可定制、一致性好 |
| **状态管理** | Zustand | 轻量、TS 友好 |
| **后端 (Rust侧)** | Tauri Commands + tokio | 原生性能、并发安全 |
| **Agent 引擎** | TypeScript (运行在 sidecar Node 进程) | 灵活、LLM SDK 生态丰富 |
| **数据库** | SQLite (via Tauri plugin-sql) | 本地、零配置、嵌入式 |
| **LLM 接入** | 统一适配层 (OpenAI / Anthropic / 本地 / 自定义) | 多模型灵活切换 |
| **包管理** | pnpm workspace (monorepo) | 参考 Actant 模式 |

### 3.2 模块架构

```
AutoMater/
├── apps/
│   └── desktop/                  # Tauri 桌面应用 (主入口)
│       ├── src-tauri/            # Rust 后端
│       │   ├── src/
│       │   │   ├── main.rs
│       │   │   ├── commands/     # Tauri IPC 命令
│       │   │   ├── db/           # SQLite 数据层
│       │   │   └── sidecar/      # Node 进程管理
│       │   └── Cargo.toml
│       └── src/                  # React 前端
│           ├── components/       # UI 组件
│           ├── pages/            # 页面
│           ├── stores/           # Zustand 状态
│           └── lib/              # 工具函数
│
├── packages/
│   ├── @AutoMater/core/         # Agent 引擎核心
│   │   ├── src/
│   │   │   ├── orchestrator/     # 主编排器
│   │   │   ├── agents/           # Agent 角色定义
│   │   │   ├── scheduler/        # 任务调度器
│   │   │   ├── evaluator/        # 结果验证器
│   │   │   ├── feature/          # Feature 管理 (两层清单)
│   │   │   ├── rfc/              # RFC 变更请求
│   │   │   └── session/          # 会话管理
│   │   └── package.json
│   │
│   ├── @AutoMater/llm/          # LLM 适配层
│   │   ├── src/
│   │   │   ├── providers/        # OpenAI / Anthropic / 本地
│   │   │   ├── router.ts         # 模型路由
│   │   │   └── cost-tracker.ts   # 成本追踪
│   │   └── package.json
│   │
│   ├── @AutoMater/sandbox/      # 代码执行沙箱
│   │   ├── src/
│   │   │   ├── docker.ts         # Docker 容器管理
│   │   │   ├── process.ts        # 本地进程管理
│   │   │   └── fs.ts             # 文件系统隔离
│   │   └── package.json
│   │
│   └── @AutoMater/shared/       # 公共类型 & 工具
│       ├── src/
│       │   ├── types/            # 共享类型定义
│       │   ├── events/           # 事件总线
│       │   └── utils/            # 工具函数
│       └── package.json
│
├── prompts/                      # Agent Prompt 模板
│   ├── pm.md                     # 产品经理 Agent
│   ├── architect.md              # 架构师 Agent
│   ├── developer.md              # 开发者 Agent
│   ├── qa.md                     # QA 测试 Agent
│   ├── reviewer.md               # Code Review Agent
│   └── devops.md                 # DevOps Agent
│
├── templates/                    # 项目模板
│   ├── feature_list.json         # Feature 清单模板
│   ├── CLAUDE.md.template        # 项目大脑模板
│   └── ADR_TEMPLATE.md           # 架构决策记录模板
│
├── DESIGN.md                     # 本文件
├── CLAUDE.md                     # AutoMater 自身的项目大脑
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### 3.3 依赖关系

```
shared ← core ← sandbox
             ← llm
             
desktop (Tauri) ─── [IPC] ──→ Node sidecar ─── core + llm + sandbox
       ↑
       └── React UI (WebView)
```

---

## 4. Agent 角色体系

### 4.1 内置虚拟员工

| 角色 | 代号 | 职责 | 触发方式 |
|------|------|------|---------|
| **产品经理** | PM | 需求分析、拆解为 Feature、优先级排序、生成 Feature List | 用户提交需求时 |
| **架构师** | Architect | 技术选型、架构设计、生成骨架代码、ADR 记录 | PM 完成后 |
| **开发者** | Developer | 按 Feature 实现代码、写单元测试、提交 PR | 从看板认领任务 |
| **QA 工程师** | QA | 白盒测试(代码审查) + 黑盒测试(功能验证) | 开发者完成后 |
| **Code Reviewer** | Reviewer | 代码质量审查、安全审查 | PR 提交时 |
| **DevOps** | DevOps | 构建、部署、环境管理 | 全部通过后 |

### 4.2 工作流 (三阶段模型，参考 agent-swarm)

```
Phase 1: 初始化
  User → [需求描述]
       → PM Agent: 需求分析 → Feature List (50-150个)
       → Architect Agent: 架构设计 → 骨架代码 + ADR
       → 输出: feature_list.json + project scaffold + CLAUDE.md

Phase 2: 迭代开发 (并行)
  Orchestrator 循环:
    1. FeatureSelector 选择最优 feature + 锁定
    2. 注入 prompt → Developer Agent 实现
    3. Evaluator 验证 → 通过/重试/跳过
    4. QA Agent 定期审查 (每 N 个 commit)
    5. Reviewer Agent 代码审查
    ↻ 直到所有 feature 完成或用户中止

Phase 3: 交付
  DevOps Agent: 构建 → 测试 → 打包 → 交付
  生成项目总结报告
```

### 4.3 Agent 间通信

采用 **事件驱动 + 文件系统** 双通道（参考 agent-swarm 设计原则 #3）：

1. **事件总线**：进程内实时通信，UI 更新
2. **文件系统**：持久化状态，跨会话恢复
3. **RFC 机制**：Agent 发现问题时反向反馈

---

## 5. 数据模型

### 5.1 核心实体

```typescript
// 项目
interface Project {
  id: string;
  name: string;
  description: string;        // 用户原始需求
  status: 'initializing' | 'developing' | 'reviewing' | 'delivered' | 'paused';
  workspace_path: string;      // 本地工作目录
  created_at: string;
  config: ProjectConfig;
}

// Feature (两层清单 — 索引层)
interface FeatureIndex {
  id: string;                  // F001, F002, ...
  category: string;
  priority: 0 | 1 | 2;
  group: string | null;
  description: string;
  depends_on: string[];
  status: 'todo' | 'in_progress' | 'testing' | 'passed' | 'failed';
  locked_by: string | null;    // Agent ID
}

// Feature (详情层)
interface FeatureDetail extends FeatureIndex {
  title: string;
  acceptance_criteria: string[];
  test_commands: string[];
  affected_files: string[];
  estimated_time: string;
  completed_at: string | null;
}

// Agent 实例
interface AgentInstance {
  id: string;
  role: 'pm' | 'architect' | 'developer' | 'qa' | 'reviewer' | 'devops';
  status: 'idle' | 'working' | 'waiting' | 'error' | 'stopped';
  current_task: string | null;  // Feature ID
  session_count: number;
  total_tokens: number;
  total_cost_usd: number;
}
```

---

## 6. UI 设计

### 6.1 主要页面

| 页面 | 功能 |
|------|------|
| **许愿台 (Wish)** | 用户输入需求的主入口，简洁的对话界面 |
| **看板 (Kanban)** | Feature 看板视图 (Todo → In Progress → Testing → Done) |
| **团队 (Team)** | Agent 状态面板，查看每个虚拟员工的工作状态 |
| **对话 (Chat)** | 与特定 Agent 的交互界面，查看工作日志 |
| **报告 (Report)** | 项目进度、成本、质量的可视化仪表板 |
| **设置 (Settings)** | LLM API 配置、模型选择、预算控制 |

### 6.2 UI 布局

```
┌─────────────────────────────────────────────────────┐
│  🔥 AutoMater           [Project ▾]  [⚙ Settings] │
├──────┬──────────────────────────────────────────────┤
│      │                                              │
│  🏠  │  ┌─────────────────────────────────────────┐ │
│  Wish│  │                                         │ │
│      │  │            Main Content Area             │ │
│  📋  │  │                                         │ │
│ Board│  │    (Wish / Kanban / Team / Chat /        │ │
│      │  │     Report depending on nav)             │ │
│  👥  │  │                                         │ │
│ Team │  │                                         │ │
│      │  └─────────────────────────────────────────┘ │
│  💬  │  ┌─────────────────────────────────────────┐ │
│ Chat │  │  Activity Log / Agent Output Stream     │ │
│      │  └─────────────────────────────────────────┘ │
│  📊  │                                              │
│Report│                                              │
├──────┴──────────────────────────────────────────────┤
│  Status: 3 agents working · F12/50 done · $2.34    │
└─────────────────────────────────────────────────────┘
```

---

## 7. LLM 集成策略

### 7.1 多模型支持

```typescript
interface LLMProvider {
  id: string;
  name: string;
  type: 'openai' | 'anthropic' | 'local' | 'custom';
  base_url: string;
  api_key: string;
  models: ModelConfig[];
}

interface ModelConfig {
  id: string;
  name: string;
  context_window: number;
  input_price_per_1k: number;
  output_price_per_1k: number;
}
```

### 7.2 智能路由

| 角色 | 推荐模型 | 理由 |
|------|---------|------|
| PM / Architect | 强模型 (Claude Opus / GPT-4o) | 需要深度理解和规划能力 |
| Developer | 中等模型 (Claude Sonnet / GPT-4o-mini) | 平衡质量与成本 |
| QA / Reviewer | 中等模型 | 检查能力足够 |
| DevOps | 轻量模型 | 主要执行脚本 |

---

## 8. 开发路线图

### Phase 1: MVP (核心骨架) — 2 周
- [ ] 项目工程搭建 (Tauri + React + monorepo)
- [ ] LLM 适配层 (@AutoMater/llm)
- [ ] 基础 Agent 引擎 (单 Agent 对话)
- [ ] 许愿台 UI + 设置页

### Phase 2: 团队协作 — 3 周
- [ ] 完整 Agent 角色体系 (PM → Architect → Developer)
- [ ] Feature 两层清单管理
- [ ] Orchestrator 编排引擎
- [ ] 看板 UI

### Phase 3: 质量 & 闭环 — 2 周
- [ ] QA Agent + Evaluator
- [ ] RFC 机制
- [ ] 成本追踪
- [ ] 代码沙箱执行

### Phase 4: 打磨 — 持续
- [ ] 多项目管理
- [ ] 插件系统
- [ ] Agent 记忆系统
- [ ] 自定义角色/Prompt
- [ ] 性能优化

---

## 9. 设计原则

1. **Context 是最稀缺资源** — 所有输出精简，详细日志写文件（from agent-swarm）
2. **文件系统即记忆** — 不依赖 LLM context 做持久化（from agent-swarm）
3. **Docker 隐喻** — Template → Instance 的生命周期模型（from Actant）
4. **Orchestrator 驱动** — Agent 不自行选任务，编排器统一调度（from agent-swarm）
5. **用户是老板** — 最小化用户干预，必要时才请求审批（from HITL 设计）
6. **成本可控** — 内建预算、追踪、告警机制（from agent-swarm）
7. **离线优先** — 本地运行，数据不出本机（桌面应用天然优势）
8. **模型中立** — 不绑定特定 LLM 供应商（用户自带 API Key）
