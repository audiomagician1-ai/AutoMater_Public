# 智械母机 AutoMater — 架构·工程·代码质量深度审计报告

> 审计日期: 2026-03-02 | 审计范围: 全仓库 60412 行 TS/TSX（94 引擎模块 + 41 页面/组件 + 12 IPC）  
> 严重度标准: 🔴 Critical（会导致数据丢失/安全漏洞/运行时崩溃）| 🟠 Serious（架构腐化/维护性陷阱）| 🟡 Warning（技术债/不规范）

---

## 一、审计概要

| 维度 | 评分 | 关键发现数 |
|------|------|-----------|
| 安全模型 | C+ | 🔴×2 🟠×1 |
| 架构设计 | B- | 🟠×4 |
| 数据层 | C+ | 🔴×1 🟠×2 |
| 代码质量 | B | 🟡×5 |
| 工程实践 | B- | 🟠×2 🟡×2 |
| 前端 | B+ | 🟡×2 |

**总计**: 🔴 3 Critical + 🟠 9 Serious + 🟡 9 Warning = **21 项发现**

---

## 二、🔴 Critical 级发现（必须优先修复）

### C-01: Preload `on()` 无 Channel 白名单 — 任意 IPC 监听

**位置**: `electron/preload.ts:138-142`

```typescript
on: (channel: string, callback: (...args: unknown[]) => void) => {
  ipcRenderer.on(channel, subscription);  // ← 任意 channel
  return () => ipcRenderer.removeListener(channel, subscription);
},
```

**问题**: 渲染进程可监听主进程发出的**任何** IPC 事件，包括内部调试消息。虽然 `contextIsolation: true` + `nodeIntegration: false` 防止了直接 Node.js 访问，但如果未来有任何 XSS 漏洞进入渲染进程，攻击者可以监听所有 IPC 通道，获取 API Key、工作区路径、代码内容等敏感信息。

**修复**: 添加 channel 白名单：
```typescript
const ALLOWED_CHANNELS = [
  'agent:log', 'agent:spawned', 'agent:status',
  'feature:status', 'project:status', 'zoom:changed',
  'team:member-added', 'import:progress', 'meta-agent:daemon-event',
];
on: (channel: string, callback) => {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    console.warn(`Blocked IPC listen on unauthorized channel: ${channel}`);
    return () => {};
  }
  // ...existing code
},
```

---

### C-02: SQLite 无 `busy_timeout` — 并发写入死锁

**位置**: `electron/db.ts:330-331`

```typescript
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// ← 缺少 busy_timeout
```

**问题**: WAL 模式允许并发读，但并发写仍然需要排他锁。当 orchestrator 多 worker 同时写入（`updateAgentStats`、`lockNextFeature`、`emitEvent`），没有 `busy_timeout` 的情况下，等待锁的操作会**立即返回 SQLITE_BUSY 错误**而不是等待重试。在 15 个并行 worker 的场景下，这几乎必然触发。

**影响**: Feature 状态更新丢失、Agent 统计数据不一致、事件日志缺失——且错误可能被上层 try-catch 吞掉。

**修复**:
```typescript
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');  // 等待最多 5 秒
```

---

### C-03: GitHub Token 仍存于 `projects` 表明文（迁移半完成）

**位置**: `electron/db.ts:357-365` + Migration v10

```sql
CREATE TABLE IF NOT EXISTS projects (
  ...
  github_token TEXT,  -- ← 明文存储
);
```

**问题**: Migration v10 引入了 `project_secrets` 加密存储，并有 `migrateGitHubTokensFromProjects()` 迁移函数。但：
1. `projects` 表的 `github_token` 列**未被清空或删除**（迁移后旧数据残留）
2. 新建项目的 `ipc/project.ts` 仍可能直接写入 `github_token` 列
3. 旧用户升级后两个地方都有 token（加密表+明文表），攻击面扩大

**修复**: 迁移成功后应执行 `UPDATE projects SET github_token = NULL WHERE github_token IS NOT NULL`，并在 v11+ 迁移中 DROP 该列。

---

## 三、🟠 Serious 级发现（架构/工程问题）

### S-01: `ipc/project.ts` — 1228 行 God Object IPC 文件

**位置**: `electron/ipc/project.ts` (1228 行)

**问题**: 这个文件承载了 project、wish、team、dialog、context、secrets、issues **7 个不同领域**的 IPC handler。命名空间混杂（`project:*`、`wish:*`、`team:*`、`dialog:*`、`context:*`、`secrets:*`、`issues:*`），职责边界模糊。

**影响**: 
- 修改任何一个领域都要在 1200+ 行中定位
- 无法对单个 IPC 模块做独立测试
- 新开发者无法从文件名推断 handler 归属

**建议**: 拆分为 `ipc/wish.ts`、`ipc/team.ts`、`ipc/secrets.ts`、`ipc/issues.ts`、`ipc/context.ts`，每个独立注册。

---

### S-02: react-loop.ts — 29 个 import + 1134 行

**位置**: `electron/engine/react-loop.ts`

**问题**: 文件顶部有 **29 个 import 语句**，依赖了 guards、planner、model-selector、sub-agent、code-graph、memory-system、event-store、conversation-backup 等几乎所有引擎模块。这是耦合度极高的信号。

**影响**:
- 任何引擎模块的接口变更都可能影响 react-loop
- 无法脱离整个引擎做单元测试（需要 mock 29 个模块）
- 循环依赖风险（react-loop 被 orchestrator 调用，但也间接依赖 orchestrator 的类型）

**建议**: 引入 Context/DI 模式——将工具执行、事件记录、备份等能力通过接口注入，而非直接 import。

---

### S-03: 构建配置 tsconfig 矛盾 — 双模块系统冲突

**位置**: `tsconfig.json` vs `tsconfig.node.json`

| 配置 | tsconfig.json | tsconfig.node.json |
|------|--------------|-------------------|
| module | ESNext | CommonJS |
| moduleResolution | bundler | node |
| include | src + **electron** | **electron** |

**问题**: `electron/` 目录同时被两个 tsconfig include。`tsconfig.json`（被 IDE/tsc 使用）将 electron 代码视为 ESModule，但 `tsconfig.node.json`（被 Vite Electron plugin 使用）将其视为 CommonJS。这导致：
1. IDE 中 `import` 和 `require` 的类型检查可能不一致
2. 动态 `require()` 在主 tsconfig 下是类型错误，但在 node tsconfig 下合法
3. 编辑器的自动导入可能生成错误的语法

**修复**: `tsconfig.json` 的 include 应排除 `electron`，只用 `["src"]`。Electron 代码由 `tsconfig.node.json` 独占管辖。

---

### S-04: 引擎模块爆炸 — 94 个文件无组织结构

**位置**: `electron/engine/` (94 个 .ts 文件)

**问题**: 所有引擎模块平铺在单个目录下，包括核心（orchestrator、react-loop）、工具（browser-tools、computer-use、visual-tools、deploy-tools）、辅助（logger、safe-json）、实验性（probe-*、blackbox-*）等。

**影响**:
- `ls electron/engine/` 需要滚动 3 屏
- 无法从目录结构区分核心/辅助/实验性模块
- `phases/` 子目录已开始拆分，但其他未跟进

**建议**: 
```
engine/
├── core/       → orchestrator, react-loop, agent-manager, llm-client
├── tools/      → tool-system, tool-definitions, tool-handlers-*
├── context/    → context-collector, memory-system, code-graph
├── pipeline/   → phases/, qa-loop, planner, change-manager
├── external/   → browser-tools, computer-use, mcp-client, web-tools
├── infra/      → logger, safe-json, event-store, db-helpers
└── experimental/ → probe-*, blackbox-*, skill-evolution
```

---

### S-05: `electron-builder` 打包配置遗漏

**位置**: `package.json:83-103`

```json
"files": [
  "dist/**/*",
  "dist-electron/**/*",
  "node_modules/**/*",
  "!node_modules/.pnpm",
  ...
],
"win": { "target": "dir" }
```

**问题**:
1. `node_modules/**/*` 全量打包——包含 devDependencies（electron-builder 自身、vitest、eslint 等）。应该只打包 dependencies
2. `win.target` 仅为 `"dir"`（目录输出），无 NSIS/MSI installer 配置。`nsis` 部分虽声明但因 target 是 dir 而被忽略
3. 无 `asar` 内容过滤——`playwright-core` 的 160MB+ 浏览器二进制会被打入 asar

**影响**: 安装包体积可能是合理值的 3-5 倍。

---

### S-06: 版本号跳跃混乱 — package.json v13.0.0 vs 文档 v6.0

**位置**: `package.json:3` vs `CLAUDE.md:7`

- `package.json` 声明 `"version": "13.0.0"`
- `CLAUDE.md` 声明 `v6.0`
- `EVOLUTION-ROADMAP.md` 提到 `v0.9`
- Git tag 历史从未标记过任何版本

**问题**: 缺乏统一版本策略。package.json 的版本号似乎代表"迭代计数"，而 CLAUDE.md 的版本号代表"功能里程碑"。preload.ts 中的注释也用不同的版本号（v5.0、v5.1、v7.0、v8.0 等）。

**影响**: 无法从版本号判断功能差异，未来用户升级/降级时无参照。

---

### S-07: 迁移系统 — `ensureXxxTable()` 绕过了版本化迁移

**位置**: `electron/db.ts:413-418`

```typescript
runMigrations();  // ← 版本化迁移系统
// ...然后:
ensureEventTable();       // ← 模块自管理表创建
ensureCheckpointTable();  // ← 不在 MIGRATIONS 中
ensureSessionsTable();    // ← 不在 MIGRATIONS 中
ensureHeartbeatTable();   // ← 不在 MIGRATIONS 中
```

**问题**: 建立了正式的 `MIGRATIONS[]` 版本化迁移系统，但 4 个表仍然由模块自行 `CREATE TABLE IF NOT EXISTS` 创建，不受迁移系统管控。如果这些表需要加列或改字段，就会出现迁移死角。

**建议**: 将所有表创建收入 MIGRATIONS 系统，模块中的 `ensureXxxTable()` 仅做版本校验。

---

### S-08: 加密密钥盐值残留旧品牌名

**位置**: `electron/engine/secret-manager.ts:21`

```typescript
const APP_SALT = 'AgentForge:SecretManager:v1:a8f3b2c1';
```

**问题**: 改名时刻意保留了此值（改了会导致已加密数据无法解密），但这引入了一个**迁移债务**：未来如果盐值需要更新，需要先用旧盐解密所有数据再用新盐重新加密。当前没有这个迁移路径。

**建议**: 在密钥记录中增加 `salt_version` 字段，支持多版本盐值平滑迁移。

---

### S-09: 无 CSP (Content Security Policy)

**位置**: `electron/main.ts`

**问题**: 未配置任何 CSP。Electron 应用如果渲染了任何用户输入或 LLM 输出到 HTML（教程页、日志页、管家对话），就可能被 XSS 攻击。结合 C-01 的 IPC 无白名单问题，攻击链完整。

**修复**: 在 `session.defaultSession.webRequest.onHeadersReceived` 中注入：
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
```

---

## 四、🟡 Warning 级发现（技术债/不规范）

### W-01: 37 处 `as any` 类型断言

散布在前后端代码中。虽然许多是合理的（JSON parse 后立即校验），但应逐步替换为 type guard 或 zod schema 验证。

### W-02: 10 处动态 `require()` 

`electron/engine/` 中有 10 处动态 require()，用于延迟加载避免循环依赖。这是循环依赖的症状而非解决方案。

### W-03: `db.ts` 核心建表 + MIGRATIONS 存在重复定义

`projects` 表在 CREATE TABLE 中就有 `git_mode`/`github_repo`/`github_token`，但 Migration v1 又 `ALTER TABLE ADD COLUMN` 同样的字段。对新装用户没问题（CREATE 已包含），对旧用户也没问题（safeAddColumn 会跳过），但逻辑冗余且容易造成误解。

### W-04: 测试覆盖不均

43 个测试文件覆盖 94 个引擎模块（45% 覆盖率），但关键路径 `orchestrator.ts` 和 `ipc/project.ts` **无专用测试**。react-loop 有测试但主要测 mock 场景。

### W-05: `GuidePage.tsx` 使用 `dangerouslySetInnerHTML` 渲染用户可控内容

虽然教程内容是硬编码字符串，但渲染管线（`renderGuideMarkdown`）将 markdown 转为原始 HTML。如果未来教程内容来自外部源（如用户自定义 guide），就会成为 XSS 入口。

### W-06: 前端依赖放在 dependencies 而非 devDependencies

`react`、`react-dom`、`react-router-dom`、`zustand`、`clsx`、`tailwind-merge`、`lucide-react` 这些前端库放在 `dependencies` 中。对 Electron 打包来说它们会被打入 `node_modules`，增加包体积。应移至 `devDependencies`（Vite 会将它们 bundle 进 dist/）。

### W-07: 5 处 `console.log` 残留在生产代码

应统一使用 `createLogger()` 结构化日志。

### W-08: preload.ts 322 行单文件暴露 21 个命名空间

preload 文件本身就是一个 API 注册表。随着功能增长，它已经很难维护。建议按命名空间拆分为多个 preload helper。

### W-09: `tailwind.config.js` 自定义 `forge-*` 颜色名称未随改名更新

改名时 CSS 颜色变量名 `forge-950`、`forge-600`、`forge-500` 等仍保留旧名。虽然这不影响功能，但语义不一致。

---

## 五、正面发现（做得好的地方）

| 维度 | 实践 |
|------|------|
| **Electron 安全基线** | `contextIsolation: true` + `nodeIntegration: false` — 基本安全模型正确 |
| **数据库迁移** | 有版本化 MIGRATIONS 系统，safeAddColumn 防护重复 ALTER |
| **Zustand 使用** | 全部使用 selector 模式（`useAppStore(s => s.xxx)`），无全量订阅 |
| **Store 分片** | 4 个 slice（navigation/log/agent/meta-agent）职责清晰 |
| **密钥加密** | AES-256-GCM + PBKDF2 100K 迭代，工业级强度 |
| **类型安全** | Window 接口正确扩展、api.d.ts 868 行类型声明完整 |
| **测试存在** | 43 个测试文件，核心模块有覆盖 |
| **结构化日志** | createLogger() 全局统一，避免 console.log |
| **Phase 拆分** | orchestrator 已拆分为 phases/ 子目录，方向正确 |

---

## 六、修复优先级排序

| 优先级 | ID | 标题 | 工作量 |
|--------|-----|------|--------|
| **P0** | C-02 | SQLite busy_timeout | 1 行代码 |
| **P0** | C-01 | Preload on() 白名单 | 15 分钟 |
| **P0** | C-03 | 清除 projects.github_token 残留 | 1 小时 |
| **P1** | S-09 | CSP 配置 | 30 分钟 |
| **P1** | S-01 | 拆分 ipc/project.ts | 2 小时 |
| **P1** | S-03 | 修复 tsconfig 双 include | 15 分钟 |
| **P2** | S-07 | 统一迁移系统 | 1 小时 |
| **P2** | S-04 | 引擎目录重组 | 3 小时 |
| **P2** | S-05 | electron-builder 配置修正 | 1 小时 |
| **P2** | S-06 | 统一版本号策略 | 30 分钟 |
| **P3** | W-01~W-09 | 技术债清理 | 各 15-60 分钟 |

---

## 七、总结

AutoMater 作为一个从 v0.1 快速迭代到 v12+ 的项目，代码量已达 60K+ 行、94 个引擎模块、13 个页面。核心架构决策（Electron 单体、SQLite 同步 API、Zustand 分片）都是务实选择。

**最大的系统性风险**不在单个 bug，而在**增长速度超过了架构的组织能力**：
1. `engine/` 94 个文件无分层 → 每个新模块都在加剧耦合
2. `ipc/project.ts` 1228 行包含 7 个领域 → 修改任何 IPC 都是高风险操作
3. `react-loop.ts` 29 个 import → 引擎的"中心节点"越来越脆弱
4. 版本号混乱 + 迁移系统半覆盖 → 随着用户增长，升级路径不可预测

建议在下一个 Sprint 中，先花 1 天时间修完 3 个 Critical（总共 2 小时工作量），然后花 1 天做 S-01 + S-03 的结构性修复，为后续安全地继续增长打下基础。
