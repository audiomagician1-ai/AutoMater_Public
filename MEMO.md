# 智械母机 AutoMater — 开发备忘录

> 最后更新: 2026-03-04 | 面向: 开发者 + 自修改 Agent | 用途: 避免重蹈覆辙

---

## 1. 架构决策记录 (ADR)

### ADR-001: Electron 而非 Tauri
- **决策时间**: 项目启动
- **背景**: 最初设计文档 (DESIGN.md) 基于 Tauri + Monorepo 架构
- **决策**: 迁移到 Electron 33 单体架构
- **理由**: Node.js 生态成熟度更高, LLM SDK (OpenAI/Anthropic) 都是 JS 原生; Tauri 的 Rust sidecar 增加了不必要的复杂度
- **后果**: 包体较大 (~355MB), 但开发效率显著提升
- **教训**: 不要为了技术新颖性牺牲开发速度, 尤其在 Agent 工具链全是 JS 的情况下

### ADR-002: 全 TypeScript 无 Rust
- **决策**: Main + Renderer 全部 TypeScript, 无 native 模块 (除 better-sqlite3)
- **理由**: 统一语言降低认知负担, Agent 引擎和前端共享类型
- **后果**: 性能天花板受限于 V8, 但 CPU 密集操作极少 (瓶颈在 LLM API 网络延迟)

### ADR-003: 单体架构而非 Monorepo
- **决策**: `electron/` + `src/` 同一 package.json
- **理由**: 早期迭代速度 > 模块化纯度; 依赖共享更简单
- **代价**: engine/ 目录膨胀到 113 文件 46K 行, 内部模块边界靠约定而非包管理
- **未来**: 如果要拆微模块, 优先拆 `engine/tool-defs/`, `engine/phases/`, `engine/probes/`

### ADR-004: better-sqlite3 同步 API
- **决策**: 使用 better-sqlite3 而非 sqlite3 (callback-based) 或 better-sqlite3 async wrapper
- **理由**: Electron 主进程适合同步 DB; 避免 async 竞态; `db.prepare().run()` 极简
- **代价**: 需要 asarUnpack (native 模块不能在 asar 内); 测试需 mock (50 个 test skip native)
- **约束**: **不要尝试在 Renderer 进程直接访问 DB**, 所有 DB 操作必须通过 IPC

### ADR-005: 三层模型策略
- **决策**: strong (规划/审查) / worker (编码) / fast (轻量辅助)
- **理由**: 控制 token 成本; PM/Architect 用贵模型保证质量, Developer 用便宜模型跑量
- **实现**: `model-selector.ts` + `team_members.llm_config` 支持成员级覆盖
- **教训**: 用户经常忘记配三个模型, 需要设默认值和预检 (`validateModel`)

### ADR-006: ReAct 模式 (无独立 Planner 调用)
- **决策**: Developer 循环采用 ReAct (Reason + Act), 不做独立 plan 调用
- **理由**: 2026 年主流 LLM 足够强, 独立 plan 多消耗一次 API 调用但收益有限
- **实现**: `react-loop.ts` 内嵌 Planning (LLM 在 think 工具中自行规划)
- **教训**: 这意味着 Agent 的计划能力完全依赖 LLM 的 in-context 能力, 弱模型效果会差很多

### ADR-007: 文档驱动开发
- **决策**: 每个项目自动生成 `.automater/docs/` (ARCHITECTURE.md + 需求文档 + 测试规格)
- **理由**: Agent 需要持久化的项目知识, 不能全靠 context window
- **实现**: `doc-manager.ts` + Phase 3 批量生成
- **教训**: 文档容易过时 (doc drift); Phase 4d 增量同步是必要的

### ADR-008: schema_version 迁移体系
- **决策**: v12.1 从 try-catch ALTER TABLE 迁移到 MIGRATIONS 数组 + 版本号
- **理由**: try-catch 吞掉非 "duplicate column" 错误, 导致静默数据损坏
- **实现**: `electron/db.ts` MIGRATIONS[0..17]
- **约束**: **迁移只能追加, 不能修改已有迁移**; 新迁移必须幂等 (CREATE IF NOT EXISTS / safeAddColumn)

### ADR-009: 管家 4 模式系统
- **决策时间**: v21.0
- **决策**: 管家 (Meta-Agent) 支持 work/chat/deep/admin 四种对话模式
- **理由**: 单一模式下管家要么太重 (闲聊也注入全部项目上下文), 要么太轻 (深度分析缺工具)
- **实现**: `sessions.chat_mode` 列, `buildSystemPrompt()` 按 mode 裁剪, `ModeConfig` per-mode 参数
- **教训**: v29.0 修复了 button 嵌套导致模式切换不响应的 bug — HTML 规范不允许 `<button>` 嵌套, 浏览器 DOM 矫正会破坏事件链

### ADR-010: 进程级沙箱 (非 Docker)
- **决策**: `sandbox-executor.ts` 使用 `execSync/spawn` + 黑名单 + 路径检查, 而非 Docker 容器
- **理由**: Docker 依赖太重, 大部分用户 PC 没装 Docker; 进程级沙箱足够应对开发场景
- **代价**: 安全性不如容器隔离; 危险命令靠正则黑名单, 有绕过风险
- **预留**: `docker-sandbox.ts` 已有基础设施, `blackbox-test-runner.ts` 支持 Docker 模式

---

## 2. 已知问题 & 技术债

### 2.1 高优先级

| # | 问题 | 影响 | 位置 | 备注 |
|---|------|------|------|------|
| D-001 | engine/ 目录过大 (46K 行, 113 文件) | 难以理解模块边界, 新开发者上手慢 | electron/engine/ | 最大文件 react-loop.ts 2146行, 应考虑拆分 |
| D-002 | ipc/meta-agent.ts 过大 (~1900行) | 管家4模式+记忆+配置+守护所有逻辑在一个文件 | electron/ipc/meta-agent.ts | 应拆为 meta-agent-chat.ts / meta-agent-memory.ts / meta-agent-config.ts |
| D-003 | WishPage.tsx 过大 (1856行) | 许愿台+管家对话+会话管理+模式切换全在一个组件 | src/pages/WishPage.tsx | 应拆为子组件 |
| D-004 | 无自动更新机制 | 用户需要手动下载新版本 | electron/main.ts | 需要 electron-updater 或自建更新通道 |
| D-005 | 50 个测试 skip native SQLite | 测试覆盖有盲区 | electron/engine/__tests__/ | better-sqlite3 在 vitest 环境需要特殊 mock |

### 2.2 中优先级

| # | 问题 | 影响 | 位置 |
|---|------|------|------|
| D-006 | 搜索引擎依赖 HTML scraping | DDG/Bing/Google 随时可能改 HTML 结构 | search-provider.ts |
| D-007 | 缺少 E2E 测试 | UI 回归靠人工 | 无 Playwright E2E 测试 |
| D-008 | 构建产物 617KB 单文件 main.js | 启动时全量加载, 冷启动慢 | vite.config.ts electron build |
| D-009 | 管家守护进程 heartbeat 每次都调 LLM | 空闲时也消耗 token | meta-agent-daemon.ts |
| D-010 | 幽灵项目残留数据 | 已删除项目的 sessions/memories 仍在 DB | conversation-backup.ts + meta_agent_memories |

### 2.3 低优先级 / 已接受

| # | 问题 | 状态 |
|---|------|------|
| D-011 | `any` 残留 2 处 | 从 389→2, 已接受 (原生模块类型) |
| D-012 | 包体 ~355MB | Electron 固有开销, 已接受 |
| D-013 | 无 macOS/Linux 构建 | 当前只打 Windows, 按需扩展 |
| D-014 | Docker 沙箱未启用 | 进程级沙箱足够当前场景 |

---

## 3. 踩坑记录 & 经验教训

### 3.1 HTML 规范相关

**bug**: MetaAgentPanel 模式切换 popover 无法点击
- **根因**: `<button>` 嵌套在另一个 `<button onClick={toggle}>` 内, HTML 规范不允许 button 嵌套, 浏览器 DOM 矫正后事件链断裂
- **修复**: 外层 `<button>` → `<div>` (commit `0e5738d`)
- **教训**: 永远不要嵌套 `<button>`, 用 `<div role="button">` 代替外层

**bug**: 模式切换 popover 一点就消失
- **根因**: popover 用 `position: fixed` 渲染在 DOM 树外部, mousedown outside-click handler 在 click 事件触发前就关闭了 popover
- **修复**: 添加 `modePopoverContentRef` 排除 popover 区域
- **教训**: 使用 outside-click 关闭 popover 时, 必须排除 popover 自身 DOM (特别是 portal/fixed 定位场景)

### 3.2 数据库相关

**bug**: 迁移失败静默吞掉
- **根因**: 早期用 try-catch ALTER TABLE, 只判断 "duplicate column", 其他错误也被吞
- **修复**: v12.1 引入 schema_version 迁移体系 (ADR-008)
- **教训**: DB 迁移必须有版本追踪, 不能靠 try-catch 做幂等

**bug**: 幽灵记忆 — 已删除项目的记忆污染其他项目
- **根因**: `meta_agent_memories` 表最初没有 `project_id` 列, 所有记忆全局注入
- **修复**: v18 迁移添加 `project_id` 列, `getMemories()` 按项目过滤 (commit `f0ca7e0`)
- **教训**: 多租户数据必须从设计起就做隔离, 后补很痛苦

### 3.3 LLM 相关

**问题**: Agent 纯文本回复 (不调用工具) 导致循环终止
- **修复**: v20.0 "纯文本容忍" — 允许连续 3 次纯文本, 之后注入 nudge 提示
- **教训**: LLM 有时会"忘记"自己该用工具, 需要柔性容错

**问题**: 弱模型无法遵循 ReAct 格式
- **表现**: 输出不符合 tool_call schema, 或在 think 中写完代码不执行
- **缓解**: `output-parser.ts` 尝试修复格式; `react-resilience.ts` 重试机制
- **教训**: ReAct 模式强依赖模型 instruction following 能力, fast model 几乎不可用于 Developer 角色

**问题**: 上下文窗口爆满
- **表现**: Agent 在 30+ 轮后 token 超限, 或摘要质量下降
- **缓解**: `tool-result-summarizer.ts` 压缩旧输出; `context-compaction.ts` 主动压缩; `scratchpad.ts` 锚点恢复
- **教训**: 上下文管理是 Agent 系统最核心的工程挑战, 需要多层策略

### 3.4 安全相关

**事件**: 有一次 commit (88e032f) 试图清除内部开发文档, 被立即 revert (c9ffe1f)
- **教训**: 安全清理要精确, 不要批量删除 docs/

**问题**: `run_command` 可以被 Agent 用来执行任意命令
- **缓解**: `isForbidden()` 28 种黑名单 + `shellExec` 权限开关 + `hasPathTraversal()` 检测
- **残余风险**: 正则黑名单可能被绕过 (编码/别名); 建议长期迁移到 Docker 沙箱

### 3.5 架构相关

**教训**: 管家 (Meta-Agent) 和项目 Agent 共享 `reactAgentLoop()` 是正确决策
- 避免了两套循环的维护成本; 但导致 `react-loop.ts` 承载过重 (2146行)
- 管家的 deep 模式直接复用 Developer 循环, 零额外开发成本

**教训**: IPC handler 中不要直接写业务逻辑
- `ipc/meta-agent.ts` 反例: ~1900行全在 handler 内, 导致测试困难
- 正确做法: handler 只做参数校验 + 调用 engine 函数 + 格式化返回

**教训**: 事件驱动 (event-store.ts) 比直接 DB 更新好调试
- 所有 Agent 动作都发 event, TimelinePage 可回放, 极大方便排障
- 但事件表增长快, 需要定期清理

---

## 4. 版本演进关键里程碑

| 版本 | 里程碑 | 核心变更 | 投入 |
|------|--------|---------|------|
| v1-v3 | 基础可用 | 流水线+ReAct+工具+许愿 | 基础框架搭建 |
| v5 | 生态接入 | MCP协议+技能进化+临时工作流+元Agent+项目导入 | 大量新功能 |
| v12 | 可配置化 | 工作流预设+schema_version迁移 | 架构升级 |
| v13 | GitHub集成 | Issue/PR/Branch+密钥加密 | 外部集成 |
| v16-v17 | 质量治理 | any 389→2, IPC校验50+, execSync→async | 还债 |
| v20 | Agent智能 | 验证门控+语义死循环+经验提取+并行共享 | Agent 能力质变 |
| v21 | 管家升级 | 4模式系统+admin工具+守护进程 | 管家从辅助→核心 |
| v25 | DAG引擎 | WorkflowEngine状态机+transition驱动 | 架构级变更 |
| v26 | 可视化 | Echo风格思维链+工具调用展示 | UX 质变 |
| v29 | 调度系统 | Session-Agent调度+记忆隔离+模式切换修复 | 多Agent并发基础 |

---

## 5. 关键配置 & 环境

### 5.1 数据存储位置
```
%APPDATA%/automater/data/automater.db    — 主数据库 (SQLite)
%APPDATA%/automater/workspaces/          — 默认项目工作区
<项目workspace>/.automater/              — 项目级 Agent 产物
  ├─ docs/                               — 生成的文档
  ├─ analysis/                           — 导入分析结果
  ├─ memory/                             — 项目/角色记忆
  ├─ todo/                               — Agent TODO 持久化
  ├─ scratchpad/                         — Agent 工作记忆
  └─ experience/                         — 经验库
```

### 5.2 关键环境变量
```
VITE_DEV_SERVER_URL    — 开发模式: Vite dev server URL
AUTOMATER_SANDBOX=1    — 沙箱内子进程标记
```

### 5.3 外部依赖
```
必须:
  - Node.js (Electron 33 自带)
  - better-sqlite3 (native, asarUnpack)

可选:
  - Docker (黑盒测试 + 部署工具)
  - Playwright (浏览器自动化, 按需安装)
  - Git (项目版本管理)
```

---

## 6. 修改项目自身时的检查清单

如果 Agent (或开发者) 需要修改 AutoMater 自身的源码, 遵循此清单:

### 修改前
- [ ] 确认当前 master 是干净的 (`git status`)
- [ ] 创建分支 `git checkout -b self-upgrade/<描述>`
- [ ] 理解要改的文件在架构中的位置 (参考 ARCHITECTURE.md §6)
- [ ] 检查该文件的修改风险等级 (参考 ARCHITECTURE.md §10)

### 修改中
- [ ] 如果改 `electron/db.ts`: 只追加 MIGRATIONS, 不改已有迁移
- [ ] 如果改 `electron/preload.ts`: 同步更新 `src/types/api.d.ts`
- [ ] 如果改工具定义: 同步更新 `tool-permissions.ts` 权限矩阵
- [ ] 如果改 `main.ts`: 注意启动链顺序, 不要在 IPC handler 注册前使用 DB
- [ ] 保持向后兼容 (用户数据库不能 break)

### 修改后 (三重验证)
- [ ] `pnpm typecheck` — 0 errors
- [ ] `pnpm test` — 所有测试通过
- [ ] `pnpm build` — 构建成功
- [ ] (如果改了 UI) 手动启动 `pnpm dev` 检查页面是否正常
- [ ] (如果改了引擎) 创建一个测试项目跑一次完整流水线

### 合并
- [ ] `git merge self-upgrade/<描述>` 到 master
- [ ] 如果验证失败: `git branch -D self-upgrade/<描述>` 回退

---

## 7. 性能参考数据

| 指标 | 值 | 来源 |
|------|-----|------|
| 代码总量 | 261 文件, ~88K 行 TS/TSX | 2026-03-04 统计 |
| Engine 占比 | 113 文件, 46K 行 (53%) | electron/engine/ |
| 前端占比 | 79 文件, 23K 行 (26%) | src/ |
| IPC 占比 | 12 文件, 5.7K 行 (6%) | electron/ipc/ |
| 数据库表 | 22 张, 18 版迁移 | electron/db.ts |
| 工具总数 | 130 (内置) + MCP 动态 | tool-definitions.ts |
| 测试 | 918 tests, 50 files | vitest |
| 构建产物 | ~355MB (Windows dir) | electron-builder |
| 冷启动 | ~3-5s (Electron 进程 + DB init) | 实测 |
