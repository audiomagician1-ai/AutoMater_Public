# AutoMater v4.x 迭代计划 — 工作流重构与质量体系升级

> 撰写时间: 2026-03-01  
> 基线版本: v3.1.1 (commit `a027149`)  
> 目标: 将 AutoMater 从"原型验证级"升级为"可舒适使用的专业工具"

---

## 一、问题全景

### 1.1 当前架构痛点

| # | 问题 | 根因 | 影响等级 |
|---|------|------|----------|
| P1 | **日志每次启动清空** | `app-store.ts` 的 `logs[]` 是纯内存数组 (最多 500 条)，不读取 `agent_logs` 表 | 🔴 严重 — 无法回溯历史 |
| P2 | **团队提示词过于简陋** | `project.ts:181-187` 默认初始化只给一句话描述，`orchestrator.ts` 未消费 `team_members.system_prompt` | 🔴 严重 — Agent 无专业知识 |
| P3 | **DAG 图节点重叠** | `OverviewPage.tsx` 的 `layoutDAG()` 用固定 x=layerIdx*240 布局，同层多节点只按 yOffset 递增，无防撞/自适应 | 🟡 中等 — 可用性差 |
| P4 | **DAG 滚轮与页面滚动冲突** | `handleWheel` 在 overflow div 内用 `e.preventDefault()`，但外层 `overflow-y-auto` 仍捕获事件 | 🟡 中等 — 体验差 |
| P5 | **工作流过于扁平** | 当前: PM→Architect→Developer→QA，PM 只出 Feature JSON (无设计文档/子需求/验收标准文档) | 🔴 严重 — 无法管控复杂项目 |
| P6 | **无需求变更管理** | 没有"需求版本"概念，无文档一致性校验，变更后旧文档成为脏数据 | 🔴 严重 — 中后期必崩 |
| P7 | **PM 缺乏宏观视野** | PM 只在第一次许愿时运行一次，之后不再参与；无全局架构文档感知 | 🟡 中等 — 各层脱节 |

### 1.2 目标工作流 (用户期望)

```
用户许愿
  │
  ▼
PM: 出详细设计文档 (Design Doc)
  │
  ▼
PM: 拆分为子需求文档 (Sub-Requirements) ← 包含验收标准
  │
  ▼
QA: 每个子需求 → 出功能测试标准文档 (Test Spec)
  │
  ▼
Developer Agent(s): 按子需求开发
  │
  ▼
QA Agent: 功能测试验收 (代码质量 + 缺陷检测)
  │
  ▼
PM Agent: 验收整个功能是否符合项目预期
  │
  ▼
用户验收
```

### 1.3 关键设计原则

1. **文档即真相 (Docs as Source of Truth)**: 设计文档、子需求文档、测试文档在磁盘上持久化，每次变更有版本追踪
2. **严格一致性**: 需求变更时自动触发文档级联更新 (Design Doc → Sub-Reqs → Test Specs)
3. **分层专精**: PM 有宏观视野但不写代码；Developer 专注实现；QA 只管质量不管设计
4. **可观测性**: 日志持久化、上下文可视化、文档变更可追溯

---

## 二、迭代计划

### Phase 1: v4.0 — 日志持久化 + 高级 Agent Prompts (基础修复)

**预计工作量: 中等**  
**目标: 修复 P1/P2，为后续重构打基础**

#### 1a. 日志持久化

**现状分析:**
- `agent_logs` 表已存在 (db.ts:89-97)，`addLog()` 在 `ui-bridge.ts` 中已写入 DB
- 但前端 `LogsPage.tsx` 只从 `app-store.ts` 内存读取，不查 DB
- IPC `project:get-logs` (project.ts:221-224) 已存在但前端未调用

**改动清单:**

| 文件 | 改动 |
|------|------|
| `src/stores/app-store.ts` | `logs[]` 初始化时从 IPC 加载历史；`addLog()` 同时追加到内存 + 通过 IPC 写入 DB |
| `src/pages/LogsPage.tsx` | 初始加载时 `window.AutoMater.project.getLogs()` 填充历史；支持分页加载更早日志；增加搜索/过滤 |
| `electron/ipc/project.ts` | `project:get-logs` 增加分页参数 (offset/limit)、agentId 过滤、关键词搜索 |
| `src/App.tsx` | 进入项目时预加载最近 200 条历史日志到 store |

**验收标准:**
- [ ] 关闭应用重启后，之前的日志全部可见
- [ ] 日志支持按 Agent 过滤、按关键词搜索
- [ ] 日志量 > 1000 条时无性能问题 (虚拟列表或分页)

#### 1b. 高级 Agent System Prompts

**现状分析:**
- `prompts.ts` 中有各角色 prompt，但 `team_members.system_prompt` 字段在 orchestrator 中**完全未被消费**
- `orchestrator.ts:100-103` 直接使用 `PM_SYSTEM_PROMPT` 常量，不查 team_members
- 默认团队初始化 (project.ts:181-187) 给的 prompt 极简

**改动清单:**

| 文件 | 改动 |
|------|------|
| `electron/engine/prompts.ts` | 重写所有角色 prompt 为专业级 (参考 Claude Code / Devin / Factory 水准)，增加领域知识、工作流指导、输出格式约束 |
| `electron/engine/orchestrator.ts` | PM/Architect 阶段查询 `team_members` 表，用 `system_prompt` 字段覆盖默认 prompt |
| `electron/engine/react-loop.ts` | Developer 循环查询 team_members，用自定义 prompt 覆盖 `DEVELOPER_REACT_PROMPT` |
| `electron/engine/qa-loop.ts` | QA 审查查询 team_members prompt |
| `electron/ipc/project.ts` | `team:init-defaults` 的默认 prompt 升级为专业版 |

**Prompt 设计方向:**
- **PM**: 产品思维 + 用户故事 + 验收标准矩阵 + 优先级决策框架 + 风险评估
- **Architect**: 技术选型决策树 + 可扩展性检查清单 + 安全设计原则 + 性能预算
- **Developer**: ReAct 工作流 + 代码质量标准 + 测试驱动 + 错误处理最佳实践 + 渐进式实现策略
- **QA**: 多维度检查矩阵 + 边界值分析 + 安全扫描清单 + 性能基线 + 回归检测

---

### Phase 2: v4.1 — DAG 图重设计 (多层级 + 交互优化)

**预计工作量: 较大**  
**目标: 修复 P3/P4，支持大型项目的层级浏览**

#### 数据模型

```typescript
// 新增概念: 三层结构
interface SystemModule {        // 顶层: 系统模块 (如 "用户系统", "订单系统")
  id: string;
  name: string;
  children: SubModule[];        // 子模块
  dependencies: string[];       // 模块间依赖
}

interface SubModule {           // 中层: 子模块 (如 "用户注册", "用户登录")
  id: string;
  name: string;
  features: string[];           // 关联的 Feature ID
  dependencies: string[];
}

// 底层: Feature (已有, 从 DB features 表读取)
```

**分层浏览方案:**

| 层级 | 节点内容 | 交互 |
|------|----------|------|
| L1: 系统模块 | 每个系统模块一个大节点 (聚合进度) | 双击→下钻到 L2 |
| L2: 子模块 | 模块内的子模块节点 | 双击→下钻到 L3，面包屑返回 L1 |
| L3: Feature | 具体 Feature 节点 (当前的细粒度) | 展开详情面板 |

**改动清单:**

| 文件 | 改动 |
|------|------|
| `electron/engine/orchestrator.ts` | PM 阶段输出包含 `group_name` (系统模块) 和 `sub_group` (子模块) 字段 |
| `src/pages/OverviewPage.tsx` | 完全重写: (1) 新 layout 引擎 — 力导向/Dagre 布局避免重叠 (2) 三层级视图切换 (3) 面包屑导航 (4) SVG 容器独立事件处理 — `pointer-events: all` + `touch-action: none` 阻止穿透 |
| `electron/engine/output-parser.ts` | `PM_FEATURE_SCHEMA` 增加 `group_name` 和 `sub_group` 字段 |
| `electron/db.ts` | `features` 表已有 `group_name` 字段，增加 `sub_group TEXT` 列迁移 |
| `electron/engine/prompts.ts` | PM prompt 指导输出带分组信息 |

**布局引擎选择:**
- 方案 A: 使用 `dagre` 库 (纯 JS，~15KB) 做分层布局 — **推荐**
- 方案 B: 自写力导向引擎 — 更灵活但工作量大
- 方案 C: 使用 `elkjs` (Eclipse Layout Kernel) — 布局质量最好但较重

**滚轮冲突解决:**
```tsx
// 方案: 容器使用 CSS isolation
<div 
  style={{ touchAction: 'none', isolation: 'isolate' }}
  onWheel={(e) => {
    e.stopPropagation();         // 阻止向上冒泡
    // 仅在图区域内做 zoom
  }}
>
```

**验收标准:**
- [ ] 节点无重叠，即使 50+ features
- [ ] 滚轮在图区域内只做缩放，不触发页面滚动
- [ ] 三层导航: 模块概览 → 子模块 → Feature 详情
- [ ] 面包屑路径清晰可返回

---

### Phase 3: v4.2 — 工作流引擎重构 (核心)

**预计工作量: 很大**  
**目标: 修复 P5/P7，实现完整的 PM→QA→Dev→QA→PM→用户 流水线**

#### 3.1 文档体系设计

在项目工作区中引入 `.AutoMater/docs/` 结构:

```
.AutoMater/
├── docs/
│   ├── design-doc.md           # PM 总设计文档 (含项目愿景、模块划分、技术方向)
│   ├── requirements/
│   │   ├── REQ-001.md          # 子需求文档 (含验收标准、影响范围、优先级)
│   │   ├── REQ-002.md
│   │   └── ...
│   ├── test-specs/
│   │   ├── TEST-REQ-001.md     # QA 功能测试标准文档
│   │   ├── TEST-REQ-002.md
│   │   └── ...
│   └── changelog.md            # 文档变更记录
├── AGENTS.md                   # 项目规范 (已有)
└── shared-decisions.jsonl      # 共享决策日志 (已有)
```

#### 3.2 新流水线 (7 阶段)

```
┌──────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR v4                        │
├──────┬──────┬──────┬──────┬──────┬──────┬──────┬────────┤
│ P1   │ P2   │ P3   │ P4   │ P5   │ P6   │ P7   │ P8    │
│PM:   │PM:   │QA:   │Dev:  │QA:   │PM:   │User: │Close  │
│Design│Split │Test  │Code  │Func  │Accept│Accept│       │
│Doc   │Reqs  │Specs │      │Test  │      │      │       │
└──────┴──────┴──────┴──────┴──────┴──────┴──────┴────────┘
```

| 阶段 | Agent | 输入 | 输出 | 门控 |
|------|-------|------|------|------|
| P1: Design Doc | PM | 用户 wish + 现有架构 | `design-doc.md` | 文档结构完整性检查 |
| P2: Split Reqs | PM | design-doc.md | `REQ-xxx.md` × N (含验收标准) | 每个 req 有 ID、验收标准 ≥ 2 条、无循环依赖 |
| P3: Test Specs | QA | 每个 `REQ-xxx.md` | `TEST-REQ-xxx.md` × N | 每个 test spec 覆盖对应 req 的所有验收标准 |
| P4: Development | Developer(s) | REQ-xxx.md + TEST-REQ-xxx.md + 架构 | 代码文件 | ReAct 循环 (已有) |
| P5: QA Functional | QA | 代码 + TEST-REQ-xxx.md | pass/fail + issues | 程序化检查 + LLM 审查 (已有) |
| P6: PM Acceptance | PM | 代码 + design-doc.md + REQ-xxx.md | pass/fail + 偏差报告 | 功能是否符合项目愿景 |
| P7: User Acceptance | — | PM 验收报告 | 用户手动 approve/reject | UI 操作 |
| P8: Close | System | 用户 approve | 标记完成、commit、经验提取 | — |

#### 3.3 改动清单

| 文件 | 改动 |
|------|------|
| `electron/engine/orchestrator.ts` | **大幅重构**: 7 阶段流水线替代当前 4 阶段。PM 运行两次 (P1+P2)，QA 运行两次 (P3+P5)，新增 PM 验收 (P6)，新增用户验收等待 (P7) |
| `electron/engine/prompts.ts` | 新增: `PM_DESIGN_DOC_PROMPT`、`PM_SPLIT_REQS_PROMPT`、`QA_TEST_SPEC_PROMPT`、`PM_ACCEPTANCE_PROMPT` |
| `electron/engine/qa-loop.ts` | 新增 `generateTestSpec()` 函数 — QA 读取子需求文档生成测试标准 |
| 新文件: `electron/engine/doc-manager.ts` | 文档读写/校验/版本追踪工具。`writeDesignDoc()`、`writeRequirement()`、`writeTestSpec()`、`readDoc()`、`listDocs()` |
| `electron/db.ts` | `features` 表扩展: 增加 `requirement_doc TEXT`、`test_spec_doc TEXT`、`pm_verdict TEXT` 字段 |
| `electron/ipc/project.ts` | 新增 IPC: `project:user-accept` (用户验收通过/拒绝)，`project:get-docs` (获取文档列表) |
| `src/stores/app-store.ts` | 新增: 用户验收等待状态、文档列表缓存 |
| `src/pages/OverviewPage.tsx` 或新页面 | 用户验收 UI — 显示 PM 验收报告 + approve/reject 按钮 |

#### 3.4 PM 宏观视野方案

**问题**: PM 只在首次许愿时运行，之后不了解项目演进。

**解决方案**: PM 在每次执行 P1/P2/P6 时注入:
1. `design-doc.md` (当前设计全局视图)
2. 已完成 features 的摘要 (从 DB 查询 passed features)
3. `ARCHITECTURE.md` 最新版
4. 项目 memory (`.AutoMater/project-memory.md`)
5. `shared-decisions.jsonl` 最近 20 条决策

这样 PM 在验收时拥有完整的项目上下文。

---

### Phase 4: v4.3 — 需求变更管理 (关键)

**预计工作量: 大**  
**目标: 修复 P6，保证文档一致性**

#### 4.1 变更流程

```
用户提交需求变更
  │
  ▼
PM: 影响分析 (Impact Analysis)
  │ 输入: 变更描述 + design-doc.md + 所有 REQ-xxx.md
  │ 输出: 影响报告 (哪些文档/代码需要更新)
  │
  ▼
PM: 更新 design-doc.md
  │
  ▼
PM: 更新受影响的 REQ-xxx.md (或创建新的 REQ)
  │
  ▼
QA: 更新受影响的 TEST-REQ-xxx.md
  │
  ▼
一致性校验 (自动)
  │ 检查: design-doc 涵盖所有 REQ → 每个 REQ 有对应 TEST → 所有文档版本对齐
  │
  ▼
标记受影响的 Feature 为 "needs_rework"
  │
  ▼
Developer: 重新实现标记的 Feature
  │
  ▼
正常 QA → PM → 用户验收流程
```

#### 4.2 一致性引擎

```typescript
interface ConsistencyCheckResult {
  passed: boolean;
  violations: Array<{
    type: 'missing_req' | 'missing_test' | 'orphan_test' | 'version_mismatch' | 'coverage_gap';
    description: string;
    affectedDocs: string[];
    severity: 'error' | 'warning';
  }>;
}

function checkDocConsistency(workspacePath: string): ConsistencyCheckResult {
  // 1. design-doc 中的模块 ↔ REQ 文档是否对应
  // 2. 每个 REQ 是否有对应 TEST
  // 3. TEST 是否覆盖 REQ 的所有验收标准
  // 4. 文档间的引用是否有效
  // 5. 变更日志是否连续
}
```

#### 4.3 改动清单

| 文件 | 改动 |
|------|------|
| 新文件: `electron/engine/change-manager.ts` | 需求变更管理器: `analyzeImpact()`、`cascadeUpdate()`、`checkConsistency()`、`markAffectedFeatures()` |
| `electron/engine/orchestrator.ts` | 新增变更流程入口: `runChangeRequest(projectId, changeDescription)` |
| `electron/engine/prompts.ts` | 新增: `PM_IMPACT_ANALYSIS_PROMPT`、`PM_UPDATE_DESIGN_PROMPT`、`QA_UPDATE_TEST_SPEC_PROMPT` |
| `electron/ipc/project.ts` | 新增 IPC: `project:submit-change`、`project:get-impact-analysis` |
| `src/pages/WishPage.tsx` | 新增 "需求变更" 入口 (区别于新需求) |
| `src/stores/app-store.ts` | 新增变更请求状态 |
| `electron/db.ts` | 新表 `change_requests` (id, project_id, description, impact_analysis, status, affected_docs, created_at) |

#### 4.4 文档版本追踪

每次文档更新时:
1. 在 `changelog.md` 追加条目 (时间、触发原因、变更内容摘要)
2. 在文档头部增加 `version` 和 `last_updated` 元数据
3. Git commit 记录完整 diff

**格式示例:**
```markdown
---
id: REQ-003
version: 2
last_updated: 2026-03-01T14:30:00Z
change_trigger: CR-002 (用户要求增加多语言支持)
---

# REQ-003: 用户注册

## 验收标准
1. ...
2. (v2 新增) 支持中英文切换
```

---

### Phase 5: v4.4 — 体验打磨 + 用户验收 UI

**预计工作量: 中等**  
**目标: 让整个流程舒适可用**

| 改进项 | 描述 |
|--------|------|
| 用户验收面板 | Feature 完成后在 Overview 弹出验收卡片: 显示 PM 验收报告、测试结果、代码变更摘要。用户点"通过"/"驳回(附理由)" |
| 文档浏览器 | 新页面或面板: 树状展示 `.AutoMater/docs/` 下所有文档，点击查看 Markdown 渲染，显示版本历史 |
| 需求看板 | WishPage 升级: 需求卡片可拖拽排序，显示关联的 REQ/TEST 文档状态，变更请求醒目标记 |
| 进度仪表盘升级 | OverviewPage: 增加 7 阶段流水线进度条 (当前处于哪个阶段)，文档完成度指示器 |
| 通知系统 | 需要用户操作时 (验收/审批变更) 发 Electron 通知 + 侧边栏 badge |

---

## 三、迭代顺序与优先级

```
v4.0 ─── 日志持久化 + 高级 Prompt ──────────────── 2-3 天
  │      (基础修复，不影响架构)
  │
  ▼
v4.1 ─── DAG 多层级重设计 ───────────────────────── 2-3 天
  │      (需引入 dagre 依赖，重写 OverviewPage)
  │
  ▼
v4.2 ─── 工作流引擎重构 ────────────────────────── 4-5 天
  │      (核心改动: 7阶段流水线 + 文档体系 + PM多次参与)
  │      (最大风险点，需充分测试)
  │
  ▼
v4.3 ─── 需求变更管理 ──────────────────────────── 3-4 天
  │      (依赖 v4.2 的文档体系)
  │
  ▼
v4.4 ─── 体验打磨 + 用户验收 UI ────────────────── 2-3 天
          (依赖 v4.2 的新流水线)
```

**总预计: 13-18 天 (含测试)**

---

## 四、技术风险与缓解

| 风险 | 概率 | 缓解策略 |
|------|------|----------|
| v4.2 重构 orchestrator 引入回归 | 高 | 每阶段独立测试；保留旧 `runOrchestrator()` 作 fallback |
| PM 多次 LLM 调用成本激增 | 中 | P1/P2/P6 可用 worker-tier 模型；文档更新只发 diff 而非全文 |
| 文档一致性检查误报 | 中 | 宽松模式 (warning) vs 严格模式 (block)，用户可选 |
| dagre 布局对超大图性能差 | 低 | 限制单层级最多 50 节点，超出自动折叠 |
| 需求变更级联更新链路过长 | 中 | 设最大级联深度；变更影响超过 30% 文档时提示用户确认 |

---

## 五、不在此次迭代范围内

- v3.0 Game Engine Integration (推迟到 v5.x)
- Docker 真容器隔离 (当前 subprocess 足够)
- 多用户协作 (当前为单人桌面应用)
- 跨项目模板市场

---

## 六、成功标准

完成后，用户应能:

1. ✅ **随时回顾**任何历史日志，支持搜索和过滤
2. ✅ 每个 Agent 使用**专业级系统提示词**，输出质量显著提升
3. ✅ 在全景图中**多层级浏览**项目结构，从系统模块到具体功能，无重叠无卡顿
4. ✅ 完整体验 **PM设计→需求拆分→QA测试标准→开发→QA验收→PM验收→用户验收** 流程
5. ✅ 项目中后期提交需求变更时，系统**自动级联更新**所有相关文档并标记受影响的开发任务
6. ✅ 任何时刻检查文档一致性，系统能**自动发现冲突**并提示修复
