# AgentForge 文档与实际功能漂移分析报告

> **审查日期**: 2026-03-02  
> **审查范围**: 4 个根目录文档 + 16 个 docs/ 文档 + 代码现状  
> **核心发现**: 20 个文档中 **13 个存在显著漂移**, 根目录有 **17 个调试临时文件** 未清理

---

## 一、总览 — 文档健康度评分

| 文档 | 位置 | 行数 | 漂移严重度 | 状态 |
|------|------|:----:|:---------:|------|
| **CLAUDE.md** | 根目录 | 237 | 🔴 严重 | 版本号、表数量、命名空间数量、模块数量全部过时 |
| **DESIGN.md** | 根目录 | 365 | 🟡 中等 | 已标注过时,但内容仍造成混淆 |
| **EVOLUTION-ROADMAP.md** | 根目录 | 307 | 🟢 良好 | 4 Sprint 全标 ✅,与实际一致 |
| **TOOL-EXPANSION-PLAN.md** | 根目录 | 370 | 🟠 较大 | 版本号/工具数量/Tier状态全部过时 |
| **REVIEW-v0.9.md** | 根目录 | 298 | 🟡 中等 | 历史参考文档,但路线图与实际进度偏差大 |
| IMPLEMENTATION-AUDIT | docs/ | 260 | 🟢 良好 | 已做二次更新,基本准确 |
| ITERATION-PLAN-v4 | docs/ | 344 | 🟡 中等 | 基线 v3.1, 多项已完成但未标记 |
| architecture-optimization | docs/ | 295 | 🟡 中等 | 基于 v5.0, 多项建议已实现但文档未更新 |
| ephemeral-workflow-design | docs/ | 155 | 🟢 良好 | 与实际实现基本匹配 |
| capability-gap-analysis | docs/ | 554 | 🟢 良好 | 分析文档,认知校准已完成 |
| capability-enhancement-plan | docs/ | 243 | 🟡 中等 | 进度追踪可能已过时 |
| agent-capability-audit | docs/ | 337 | 🟢 良好 | 审计快照,无需更新 |
| product-experience-review | docs/ | 377 | 🟢 良好 | 体验复盘快照 |
| full-automation-iteration-plan | docs/ | 639 | 🟠 较大 | 规划了 v13 GitHub+Supabase+CF, 实际仅完成 DB migration |
| PROJECT-IMPORT-V7-FINAL | docs/ | 517 | 🟡 中等 | 方案文档,不确定实际实现覆盖度 |
| parallelism-architecture | docs/ | 266 | 🟢 良好 | 构想 A-D 已实现并记录 |
| TEST-ARCHITECTURE | docs/ | 111 | 🟢 良好 | 测试策略文档 |
| BLACKBOX_TEST_PLAN | docs/testing/ | ~700 | 🟡 中等 | 173 TC 计划,实际执行进度未追踪 |
| CODE-QUALITY-REVIEW(x2) | docs/ | 252+281 | 🟢 良好 | 新生成的审计快照 |

---

## 二、P0 — CLAUDE.md 严重漂移 (项目大脑文档)

`CLAUDE.md` 是项目的**核心参考文档**, AI 助手每次都会读取它来理解项目。其中的**多个关键数据与实际代码严重不符**:

### 2.1 版本号与状态自相矛盾

| 字段 | CLAUDE.md 声明 | 实际现状 | 差距 |
|------|---------------|---------|------|
| 标题版本 | v13.0 | 代码无 version 字段, 但 DB migration 到了 v10 (v13.0 feature) | 标题说 v13, 正文说 v6.0 |
| § 4 CURRENT STATE | `v6.0 (全阶段流水线...)` | 实际已迭代到 v12-v13 功能 (workflow presets, session, project_secrets) | **CURRENT STATE 滞后 7 个大版本** |
| 最高优先级 | "GitHub 深度集成 + 外部平台自动化 + 密钥安全管理" | 这是 v13 规划, 仅 DB migration 完成, 代码层面未实现 | 误导性: 暗示已在进行中 |

### 2.2 数据库表数量不准

| CLAUDE.md 声明 | 实际 |
|---------------|------|
| "9 张表" | **19 张表** (settings, projects, features, agents, agent_logs, wishes, team_members, change_requests, missions, mission_tasks, schema_version, events, checkpoints, sessions, feature_sessions, meta_agent_config, meta_agent_memories, workflow_presets, project_secrets) |
| 列出 9 张 | 缺失: schema_version, events, checkpoints, sessions, feature_sessions, meta_agent_config, meta_agent_memories, workflow_presets, project_secrets, agents(在列表中但未标注新增的字段) |

### 2.3 IPC 命名空间数量不准

| CLAUDE.md 声明 | 实际 |
|---------------|------|
| "14 个命名空间" | **21 个命名空间** |
| 列出: settings, llm, project, wish, workspace, events, mission, metaAgent, ephemeralMission, mcp, dialog | 缺失: **team, skill, skillEvolution, secrets, context, session, workflow, zoom, monitor, knowledge** |

### 2.4 引擎模块数量不准

| CLAUDE.md 声明 | 实际 |
|---------------|------|
| "40 个模块" | **48 个模块** + 8 个 phase 文件 = **56 个 .ts 文件** |
| 目录列出 ~20 个 | 缺失: `file-lock.ts`, `extended-tools.ts`, `constants.ts`, `workspace-git.ts`, `tool-system.ts`, `sub-agent-framework.ts`, `phases/` 全部 8 文件 等 |

### 2.5 v6.0 以后的功能全部未记录

CLAUDE.md 的 "已完成" 和 "v6.0 新增" 列表**完全停留在 v6.0**, 以下重大功能在 CLAUDE.md 中**无任何提及**:

| 版本 | 功能 | 影响 |
|------|------|------|
| v7.0 | 元Agent 管理面板 (配置/记忆/人格自定义) | 前端+后端+DB, 重大功能 |
| v8.0 | Session/Backup 管理 (会话持久化+切换+恢复) | 新模块 conversation-backup.ts |
| v8.1 | Feature-Session 关联 (看板级会话追踪) | 新 DB 表 feature_sessions |
| v9.0 | Cross-project 经验迁移 | 新模块 cross-project.ts |
| v10.0 | Sub-Agent 框架 (独立子Agent并发执行) | 新模块 sub-agent-framework.ts |
| v11.0 | 团队成员独立 LLM/MCP/Skill 配置 | team_members 表 3 新字段 |
| v12.0 | 工作流预设系统 (自定义Pipeline) | 新 DB 表 + 新 IPC + 新页面 WorkflowPage |
| v12.1 | types.ts 强类型体系 + EngineError 层次 | 628 行类型定义 |
| v12.2-12.3 | LLM/MCP/Guard/Conversation 类型细化 | types.ts 持续扩充 |
| v13.0 | project_secrets 加密密钥表 + GitHub Issue 关联字段 | DB migration 10 |
| — | file-lock.ts (文件级写锁) | v6.1 并行架构优化 |
| — | phases/ 目录拆分 | orchestrator 从 1800+ 行拆到 546 行 |
| — | Guards 五子系统 (607 行) | 程序化硬约束 |
| — | ErrorBoundary 全页面覆盖 | 前端防白屏 |
| — | ESLint + Prettier + vitest 配置 | 工程化基础 |

### 2.6 建议修复

CLAUDE.md 需要**全面重写 § 4 CURRENT STATE** 和更新以下区域:
- 数据库表: 9 → 19
- IPC 命名空间: 14 → 21 (列表需补全)
- 引擎模块: 40 → 56
- 已完成功能: 补录 v7-v13 全部 15+ 重大功能
- phases/ 目录: 补充到目录结构图
- 移除或标注 "CURRENT STATE: v6.0" 的过时声明

---

## 三、P1 — TOOL-EXPANSION-PLAN.md 数据过时

### 3.1 版本号和工具数错误

| 文档声明 | 实际 |
|---------|------|
| 标题 "v2.1+" | 当前已远超 v2.x, 应为 v6.x+ |
| "现有 17 个工具" | 实际 **42+ 工具** (文档自己在 § 2 就承认了 17,但实际已全部扩展) |
| Tier 1 "v2.1 — 1-2天" | ✅ 全部完成 (think, web_search, fetch_url, todo_write, todo_read, batch_edit, http_request) |
| Tier 2 "v2.2 — 2-3天" | ✅ 全部完成 (screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey) |
| Tier 3 "v2.3 — 2-3天" | ✅ 全部完成 (10个 browser_* 工具, 实际增加到 18个) |
| Tier 4 "v2.4 — 1-2天" | ✅ 全部完成 (analyze_image, compare_screenshots, visual_assert) |
| Tier 5 "v3.0 — 游戏引擎" | ❌ 未实现 (有意跳过) |

### 3.2 核心问题

文档的 **Tier 1-4 全部已完成** 但文档未做任何完成标记。读者无法区分"计划"和"已实现"。此外:
- § 8 "EchoAgent 对齐表"中多项标为 ❌ 的能力实际已实现
- 新增的 `skill_acquire/search/improve/record_usage` 4 个技能工具在文档中**不存在**
- MCP 动态工具加载在文档中未提及
- `report_blocked` 工具在文档中未提及

### 3.3 建议

**归档此文档**为历史参考, 在 CLAUDE.md 的工具表中维护最新工具列表 (当前 CLAUDE.md 的工具表是最新的,但 TOOL-EXPANSION-PLAN.md 会误导)。

---

## 四、P1 — REVIEW-v0.9.md 路线图已完成但未标记

### 4.1 建议执行顺序 vs 实际

| 文档规划 | 实际状态 | 备注 |
|---------|---------|------|
| v1.0: A1 (str_replace edit) | ✅ edit_file 工具已实现 | |
| v1.0: A2 (repo map) | ✅ repo-map.ts 已实现 | |
| v1.0: B3 (AGENTS.md) | ✅ ensureAgentsMd() 自动生成 | |
| v1.1: A3 (sandbox) | ✅ sandbox-executor.ts 进程级沙箱 | Docker 级未实现 |
| v1.1: B1 (3-layer memory) | ✅ memory-system.ts | |
| v1.1: B2 (auto lessons) | ✅ skill-evolution.ts 自动经验提取 | |
| v1.2: A4 (shared decision log) | ✅ decision-log.ts | |
| v1.2: C1 (summarizer) | ✅ react-loop.ts LLM summarizer | |
| v1.2: C3 (TDD mode) | ✅ qa-loop.ts TDD 测试骨架生成 | |
| v1.3: C2 (code graph) | ✅ code-graph.ts | |
| v1.3: C4 (sub-agent) | ✅ sub-agent.ts + sub-agent-framework.ts | |
| v1.3: C5 (dynamic model) | ✅ model-selector.ts | |
| v2.0: C6 (event stream) | ✅ event-store.ts + TimelinePage.tsx | |
| v2.0: B4 (cross-project) | ✅ cross-project.ts | |

**结论**: 路线图 14/14 项全部完成, 但文档中**没有一项被标记为完成**。全部仍显示为未勾选的 `- [ ]` 或空白。

---

## 五、P1 — full-automation-iteration-plan.md 规划远超实现

这份 639 行文档规划了 v13 "全自动化迭代" (GitHub + Supabase + Cloudflare 集成), 但:

| 规划项 | 实际实现 | 差距 |
|--------|---------|------|
| secret-manager.ts 加密密钥管理 | ✅ 文件存在 | 已实现 |
| project_secrets DB 表 | ✅ migration 10 | 已实现 |
| GitHub Issue 自动创建/关联 | ⚠️ git-provider.ts 有 createIssue/listIssues | 基础 API 存在, 但自动化流程未集成 |
| Supabase Auth/DB/Storage | ❌ 完全未实现 | 零代码 |
| Cloudflare Pages 部署 | ❌ 完全未实现 | 零代码 |
| GitHub Actions CI/CD | ❌ 完全未实现 | 无 .github/workflows/ |
| 自动化发版流程 | ❌ 完全未实现 | |

**完成度约 15%** — 仅完成了 DB schema 和密钥管理基础, 95% 的自动化流程仍在纸面。但文档标题和内容暗示这是"即将执行的计划"。

---

## 六、P2 — DESIGN.md 已标注过时但仍混淆

### 6.1 正面

文档第 6 行已加注：
> ⚠️ **注意**: 本文档为项目初始设计方案（Tauri + Monorepo 架构）。实际实现已迁移为 Electron 33 单体架构。

### 6.2 仍然造成混淆的内容

| 文档声明 | 实际 | 混淆点 |
|---------|------|--------|
| Tauri 2.x + Rust 后端 | Electron 33 + 纯 TS | 读者可能误以为有 Rust 代码 |
| pnpm workspace monorepo | 单体 electron/ + src/ | 4 个 @AutoMater/* 包完全不存在 |
| 6 个页面 (Wish/Kanban/Team/Chat/Report/Settings) | 14 个页面 | 实际页面数是规划的 2.3 倍 |
| 6 个 Agent 角色 (含 Reviewer) | 6 个角色 (含 DevOps, 不含 Reviewer) | Reviewer 被合并到 QA |
| Phase 1-4 路线图 | 所有 Phase 全部完成 | 仍显示未勾选的 `- [ ]` |
| UI 布局 ASCII 图 | 实际 UI 差异很大 | 双层导航 + MetaAgent 面板都未在图中 |

### 6.3 建议

在文档顶部**加粗警告**后紧接 "请查看 CLAUDE.md § 2-3 获取最新架构", 或直接将此文档移至 `docs/archive/` 目录。

---

## 七、P2 — ITERATION-PLAN-v4.md 完成状态未更新

基线版本 v3.1, 文档列出的 7 个痛点的修复状态:

| 痛点 | 规划修复 | 实际状态 |
|------|---------|---------|
| P1 日志清空 | 持久化到 agent_logs | ✅ 已实现 (LogsPage 读 DB) |
| P2 团队提示词简陋 | 丰富 system_prompt | ✅ 已实现 (project.ts 默认 7 人团队含详细 prompt) |
| P3 DAG 节点重叠 | dagre 布局 | ✅ 已实现 (overview/InteractiveGraph.tsx 使用 dagre) |
| P4 滚轮冲突 | 事件处理修复 | ✅ 已实现 |
| P5 工作流扁平 | 5 阶段 + 文档驱动 | ✅ 已实现 |
| P6 无变更管理 | change_requests 表 | ✅ 已实现 (change-manager.ts) |
| P7 PM 缺宏观视野 | PM 持续参与 | ✅ 已实现 (PM 验收, 增量分诊) |

**7/7 全部完成**, 但文档中**没有一处标记为完成**。

---

## 八、P2 — architecture-optimization-analysis.md 建议已大量采纳

v5 优化分析文档中的建议实际采纳情况:

| 编号 | 建议 | 采纳状态 | 文档标记 |
|------|------|---------|---------|
| G1 | 并行 Worker 共享决策日志 | ✅ decision-log.ts | 未标记 |
| G2 | 沙箱硬化 | ✅ sandbox-executor.ts 路径遍历防护 | 未标记 |
| G3 | QA 程序化测试 | ✅ qa-loop.ts run_test/run_lint | 未标记 |
| G6 | 增量文档同步 | ✅ phaseIncrementalDocSync | 未标记 |
| G7 | Mission cancel AbortController | ✅ 已实现 | 未标记 |
| G8 | DevOps 自动构建 | ✅ phaseDevOpsBuild | 未标记 |
| G14 | TDD 模式 | ✅ qa-loop TDD 骨架生成 | 未标记 |
| Tool result trimming | 全局应用 | ⚠️ 部分实现 (trimToolResult 存在但非全局) | 未标记 |

---

## 九、P3 — 根目录临时文件堆积

根目录存在 **17 个调试/临时文件**, 全部创建于 2026-03-02 (Playwright/CDP 调试会话):

```
调试脚本 (14 个):
  debug-cdp.js, debug-cdp2.js, debug-cdp3.js, debug-cdp4.js, debug-cdp5.js
  debug-click.js, debug-click2.js, debug-click3.js
  debug-final.js, debug-prod.js, debug-state.js
  cdp-get-error.js, cdp-monitor.js, check-db.js

日志文件 (5 个):
  cdp-error.log, cdp-output.log, electron-debug.log, electron-stdout.log, vite-dev.log

测试输出 (2 个):
  coverage-out.txt, coverage-out2.txt

空文件 (1 个):
  release-test.log (0 bytes)
```

**总计约 80KB 垃圾文件**。这些文件:
- 不在 `.gitignore` 中排除
- 会被提交到 Git 仓库
- 污染根目录可读性

**建议**: 将 `debug-*.js`, `cdp-*.js`, `check-db.js`, `*.log`, `coverage-out*.txt` 加入 `.gitignore` 并删除。

---

## 十、量化总结

```
┌──────────────────────────────────┬─────────┐
│ 指标                             │ 数量     │
├──────────────────────────────────┼─────────┤
│ 文档总数 (根 + docs/)            │ 20      │
│ 严重漂移 (P0)                    │ 1       │
│ 较大漂移 (P1)                    │ 4       │
│ 中等漂移 (P2)                    │ 5       │
│ 健康/快照类                       │ 10      │
│ CLAUDE.md 过时数据点              │ 15+     │
│ 已完成但文档未标记的功能/路线图项  │ 35+     │
│ 根目录临时文件                    │ 17 个   │
│ 文档总行数                        │ ~7,200  │
│ 需要实质更新的文档                 │ 6 个    │
│ 建议归档的文档                    │ 2 个    │
└──────────────────────────────────┴─────────┘
```

---

## 十一、修复优先级

### 立即处理 (1-2 小时)

1. **CLAUDE.md 全面更新** — 这是项目大脑, 所有 AI 助手都依赖它
   - § 2 数据库: 9→19 表, 补全列表
   - § 2 IPC: 14→21 命名空间, 补全列表
   - § 2 引擎: 40→56 模块, 补充 phases/ + 新模块
   - § 4 CURRENT STATE: v6.0→当前, 补录 v7-v13 全部功能
   - § 2 目录结构: 补充 phases/, __tests__/, 前端新组件
2. **根目录清理** — 删除 17 个临时文件, 更新 .gitignore

### 近期处理 (半天)

3. **TOOL-EXPANSION-PLAN.md** — 归档或标注 Tier 1-4 全部完成
4. **REVIEW-v0.9.md** — 路线图 14/14 标为 ✅
5. **ITERATION-PLAN-v4.md** — 7/7 痛点标为 ✅
6. **DESIGN.md** — 移至 docs/archive/ 或顶部增加强警告

### 择机处理

7. **full-automation-iteration-plan.md** — 标注实际完成度 (~15%), 区分已实现/未实现
8. **architecture-optimization-analysis.md** — 标注 G1-G14 采纳状态
9. **BLACKBOX_TEST_PLAN.md** — 补充实际执行进度
