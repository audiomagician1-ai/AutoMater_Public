# 智械母机 AutoMater — 产品体验复盘报告

> **日期**: 2026-03-02 | **版本**: v14.0 | **视角**: 产品经理 (UX / 用户旅程)  
> **范围**: 全功能 14 页面 + 12 组件 + 后端引擎交互 | **排除**: 侧边栏重构、全景页重设计

---

## 0. 执行摘要

本次复盘基于 v14.0 全量源码逐行审读，从目标用户（非程序员 + 需要快速原型的开发者）视角，系统梳理产品在**首次体验、日常使用、专业进阶**三个阶段的体验缺陷。

**核心发现**:

| 优先级 | 数量 | 关键主题 |
|--------|------|---------|
| 🔴 P0 (阻断/流失) | 8 | 新手引导缺失、LLM配置门槛、错误信息不友好、删除无确认、无Toast反馈 |
| 🟡 P1 (体验降级) | 14 | 轮询风暴、预算无硬控、状态不一致、功能空转、信息密度过高 |
| 🟢 P2 (打磨优化) | 11 | 动效缺失、键盘导航、响应式适配、品牌一致性、辅助功能 |

总计 **33 个体验问题**，覆盖 7 大类别。

---

## 1. 🔴 P0 — 阻断级体验问题

### 1.1 首次启动无引导 (Onboarding 完全缺失)

**现象**: 用户首次打开应用，直接面对空白项目列表页，唯一的提示是一行小字 "💡 首次使用请先配置 LLM"。没有步骤引导、没有交互式教程、没有示范项目。

**影响**: 目标用户是"非程序员"，对 LLM、API Key、模型选择完全陌生。当前体验等同于把用户扔进一个空房间。GuidePage 虽有 8 篇教程，但用户需要自己找到侧边栏的 📖 图标（在 12 个标签的底部）才能看到。

**建议**:
- 首次启动弹出全屏欢迎向导（3-5 步: 欢迎 → API Key → 创建示例项目 → 完成）
- 预置一个只读的 Demo 项目让用户感受成品效果
- 关键步骤的 Tooltip/Spotlight 高亮

---

### 1.2 LLM 配置门槛过高

**现象**: SettingsPage 的 LLM Tab 直接要求用户填写 Provider、API Key、Base URL、strong/worker/fast 三个模型名。对非程序员来说，"什么是 strong model 和 fast model" 完全不可理解。

**影响**: 这是用户必须通过的第一道门槛——配不好 LLM，整个产品无法使用。但当前的 UI 设计完全面向开发者。

**建议**:
- 增加"一键配置"模式: 用户只需填 API Key + 选择服务商，模型自动分配
- 三层模型选择改用通俗语言: "思考模型 / 执行模型 / 速答模型" + tooltip 解释
- 增加 "检测配置" 一键验证（当前有 test 功能但和保存分离，用户容易跳过）
- 配置完成后自动在底部状态栏显示绿色指示灯

---

### 1.3 错误信息面向开发者

**现象**: 全局使用 `toErrorMessage(err)` 直接将原始错误信息展示给用户。例如 LLM 调用失败时，用户看到的是 "Error: Request failed with status code 401" 而不是 "API Key 无效，请检查设置"。

**代码证据**:
```tsx
// ProjectsPage.tsx:85
addLog({ ..., content: `❌ ${toErrorMessage(err)}` });
// WishPage.tsx:623
addLog({ ..., content: `❌ ${toErrorMessage(err)}` });
```

**影响**: 非程序员用户完全无法理解技术错误信息，无法自行排错。

**建议**:
- 建立错误码映射层: HTTP 401 → "API Key 无效"，HTTP 429 → "请求过快，请稍后重试"，ENOTFOUND → "网络连接失败"
- 每条用户可见错误附带"建议操作"

---

### 1.4 危险操作无二次确认

**现象**: 
- `ProjectsPage.handleDelete` — 删除项目直接执行，无 confirm 对话框
- `TeamPage.handleDeleteMember` — 删除团队成员直接执行
- `WorkflowPage.handleDeletePreset` — 删除工作流预设直接执行
- `WorkflowPage.handleDeleteMission` — 删除任务直接执行

**仅** WishDetailPanel 的删除有 `confirm()` 保护:
```tsx
onClick={() => { if (confirm('确认删除此需求？')) onDelete(wish.id); }}
```

**影响**: 用户误点一下就永久丢失数据，且无法撤销。

**建议**:
- 所有删除操作统一加 confirm 二次确认，且确认文案明确告知后果
- 考虑软删除 + 回收站机制（至少保留 7 天）

---

### 1.5 全局缺少 Toast/Notification 反馈机制

**现象**: 所有用户操作的反馈都写入 `addLog()`，只在 LogsPage 可见。用户在 ProjectsPage 创建项目、在 TeamPage 保存配置、在 SettingsPage 保存设置 — 操作后没有任何即时视觉反馈（没有 Toast、没有 Snackbar、没有动效）。

**影响**: 用户不确定操作是否成功，反复点击或产生焦虑。

**建议**:
- 引入全局 Toast 组件（成功绿色、警告黄色、错误红色）
- 关键操作增加 loading → success/error 状态切换动效

---

### 1.6 项目列表页缺少加载/刷新状态指示

**现象**: `ProjectsPage` 使用 `setInterval(loadProjects, 6000)` 轮询，但加载过程没有 loading 状态，首屏如果项目列表为空但实际是加载中，用户只看到"还没有项目"。

**影响**: 用户以为没有数据，实际只是还在加载。

---

### 1.7 导入项目的进度反馈形同虚设

**现象**: `ProjectsPage` 的导入流程设置了 `importProgress` 状态和进度条 UI，但实际触发 `analyzeExisting()` 是 fire-and-forget (`catch(() => {})`):
```tsx
window.automater.project.analyzeExisting(result.projectId).catch(() => {});
```
导入后立即关闭表单、清空进度，进度条永远停在初始状态。用户被弹到 Overview 页面后，只能通过日志猜测分析是否完成。

**建议**: 
- 导入后保持进度面板打开，通过 IPC 事件推送实时进度
- 分析完成后弹出完成提示

---

### 1.8 "回退到此版本" 功能是 Placeholder

**现象**: OutputPage 和 DocsPage 的"查看历史版本"和"回退到此版本"按钮是空壳实现:
```tsx
// OutputPage.tsx:202-209 — 硬编码两个假版本
versions: [
  { hash: 'HEAD', date: new Date().toISOString(), summary: '当前版本' },
  { hash: 'HEAD~1', date: new Date(Date.now() - 3600000).toISOString(), summary: '上一版本' },
]
// DocsPage.tsx:424 — rollback 只打日志
const handleRollbackDoc = (item, version) => {
  log.info(`Rollback doc ${item.type}:${item.id} to v${version}`);
  setVersionModal(null);
};
```

**影响**: 用户点击"回退到此版本"后什么都没发生，产生"功能坏了"的印象。

**建议**: 要么真正实现 Git 版本回退，要么暂时隐藏此功能按钮

---

## 2. 🟡 P1 — 体验降级问题

### 2.1 轮询风暴 — 至少 8 路并行定时器

**现象**: 多个页面使用 `setInterval` 轮询后端，且页面不可见时不暂停:

| 页面 | 间隔 | 轮询内容 |
|------|------|---------|
| ProjectsPage | 6s | 项目列表 + 每个项目的 stats |
| WishPage | 5s | wishes + features |
| BoardPage | 4s | features + session summaries |
| TeamPage | 3s | agents |
| DocsPage | 8s | doc list + changelog |
| OutputPage | 5s | file tree |
| WorkflowPage | 5s | missions |
| TimelinePage | — | 手动刷新 |

**影响**: 
- 同时打开多个页面时 IPC 请求堆积，主进程 SQLite 竞争
- 无 visibility 检测，Tab 切走/最小化后仍在轮询
- 电池消耗和 CPU 占用不必要升高

**建议**:
- 使用 `document.visibilityState` / `Page Visibility API` 暂停不可见页面轮询
- 统一为 SSE 推送 + 按需拉取
- 至少把 BoardPage 4s 和 TeamPage 3s 放宽到 5-8s

---

### 2.2 预算无硬限制 — "费用保护" 形同虚设

**现象**: Settings 中有 `dailyBudgetUsd` 字段，但审查全部代码未找到任何地方在 LLM 调用前检查是否超预算。StatusBar 只是展示当前花费。

**影响**: 用户设置了 $5 日预算后仍可能跑到 $50，造成经济损失。对非程序员用户这尤其致命——他们不知道一次 Architect 分析可能花多少钱。

**建议**:
- 在 `llm-client.ts` 的每次调用前增加预算门检查
- 超预算时暂停所有 Agent + 弹出通知
- 启动前预估总成本并展示给用户

---

### 2.3 工作流预设的"激活"操作没有即时反馈

**现象**: 点击 PresetCard 触发 `handleActivate`，调用 `workflow.activate()`，但成功后只是静默刷新列表，用户不知道切换是否生效。且如果项目正在运行中切换工作流，没有警告。

**建议**: 
- 激活成功后 Toast 提示 "✅ 已切换至 XXX 工作流"
- 运行中切换时弹出警告 "当前正在开发中，切换工作流将影响后续阶段"

---

### 2.4 看板页无拖拽 — 功能名不副实

**现象**: BoardPage 是纯展示的看板视图，没有拖拽功能。Feature 卡片不能在列之间拖动来改变状态。标题叫"看板"但行为像"只读列表"。

**影响**: 用户对"看板"的心理预期是 Trello/Jira 式交互。

**建议**: 
- 短期: 在标题旁加 "(只读)" 标注，管理期望
- 中期: 支持手动调整 Feature 优先级排序
- 长期: 实现 DnD 拖拽改变状态

---

### 2.5 DocsPage 有两个空的"幽灵"分类

**现象**: 文档树中硬编码了"系统级设计文档"和"功能级设计文档"两个分类，但 `items` 永远传入空数组 `[]`:
```tsx
<DocTreeSection title="系统级设计文档" icon="🏗️" items={[]} />
<DocTreeSection title="功能级设计文档" icon="⚙️" items={[]} />
```

**影响**: 用户看到两个永远为空的分类，困惑 "为什么这两个始终没有文档"。

**建议**: 隐藏未实现的分类，或将其标记为 "coming soon"

---

### 2.6 ContextPage 的"压缩"按钮是 alert 占位

**现象**:
```tsx
onClick={() => alert('上下文压缩将在下次 Agent 执行时自动触发')}
```

**影响**: 用户点击后弹出浏览器原生 alert，体验粗糙，且没有实际执行压缩操作。

---

### 2.7 SessionManager 使用 confirm/alert 原生对话框

**现象**: `handleCleanup` 使用 `confirm()` + `alert()`:
```tsx
if (!confirm('确认清理 30 天前的旧备份？')) return;
alert(`已清理 ${result.deletedFolders} 个旧备份文件夹`);
```

**影响**: Electron 应用中使用浏览器原生对话框，风格与产品整体设计语言不一致。

---

### 2.8 TeamPage 的默认 Tab 是 "团队配置" 而非 "运行状态"

**现象**: `const [tab, setTab] = useState<'runtime' | 'config'>('config')`

**影响**: 对于已经配置好团队的用户（绝大多数场景），进入 TeamPage 的首要关注是 Agent 实时工作状态，而不是编辑团队配置。

**建议**: 默认 Tab 改为 'runtime'（或根据是否有 agents 数据智能切换）

---

### 2.9 GuidePage 版本号硬编码且过时

**现象**: 底部显示 "v12.0 · 8 篇教程"，但实际产品已是 v14.0。

**建议**: 从 CLAUDE.md 或 package.json 动态读取版本号

---

### 2.10 WishPage "提交并启动开发" 跳转链过长

**现象**: 用户提交需求后，代码连续执行: `wish.create` → `project.setWish` → `wish.update(developing)` → `project.start` → `setProjectPage('overview')` — 总共 4 次 IPC 调用后才跳转，期间没有中间状态展示。任一环节失败整个链路中断。

**建议**: 
- 后端合并为一个原子操作 `project.startWithWish(projectId, wishContent)`
- 前端只需一次调用 + loading 动画

---

### 2.11 MetaAgent 对话消息无 Markdown 渲染

**现象**: MetaAgentChat 的回复直接用 `whitespace-pre-wrap` 显示纯文本，但 LLM 回复通常包含 Markdown 格式（标题、列表、代码块）。

**影响**: 用户看到的是 `## 标题` 这样的原始文本而不是格式化内容，阅读体验差。

**建议**: 复用 DocsPage 已有的 `renderMarkdown()` 函数

---

### 2.12 StatusBar 信息密度不足 — 最后一条日志显示被截断

**现象**: StatusBar 右侧显示最后一条日志，但使用 `truncate` 且没有 hover tooltip:
```tsx
<span className="text-slate-600 animate-slide-in">{lastLog.content}</span>
```
当日志较长时用户只能看到前面几个字。

**建议**: hover 时显示完整内容的 tooltip

---

### 2.13 TimelinePage 的 export 默认导出格式不明确

**现象**: TimelinePage 头部 CLAUDE.md 提到有 `events:export` API，但页面 UI 中没有导出按钮。events IPC handler 中有 `export` 方法但前端未接入。

---

### 2.14 项目创建时工作区路径硬编码 Windows 路径

**现象**:
```tsx
const base = `D:\\AutoMater-Projects\\${safeName}`;
```

**影响**: 如果用户的 D 盘不存在（笔记本单盘用户很常见），创建会失败。且此路径对用户来说不直观。

**建议**: 使用 Electron 的 `app.getPath('documents')` 或 `app.getPath('home')` 动态获取

---

## 3. 🟢 P2 — 打磨优化问题

### 3.1 缺少全局页面切换动效

**现象**: 页面之间切换是瞬间替换 DOM，没有 fade/slide 过渡动效。

### 3.2 深色主题下对比度不足

**现象**: 大量使用 `text-slate-600` 和 `text-[10px]`，在某些显示器上几乎不可见。尤其是 StatusBar 的最后一条日志 (`text-slate-600`)、各页面的 ID 字段。

### 3.3 无键盘快捷键体系

**现象**: 整个应用没有定义键盘快捷键。无 `Ctrl+N` 创建项目、无 `Ctrl+Enter` 提交需求（WishPage 的 textarea 有但不是全局）、无 `Escape` 关闭弹窗。

### 3.4 弹窗/模态框没有统一的 Escape 关闭行为

**现象**: TeamPage 的 MemberEditModal、WorkflowEditor、AcceptancePanel 等弹窗都没有监听 `Escape` 键。

### 3.5 OutputPage 无代码高亮

**现象**: CodeView 组件只是纯文本+行号，没有语法高亮。`detectLanguage()` 函数识别了 25+ 种语言但仅用于显示标签。

### 3.6 响应式适配不完整

**现象**: 
- ProjectsPage 项目网格用 `xl:grid-cols-3`，但窄窗口下没有适配
- WorkflowPage 临时任务 `grid-cols-5` 在窄窗口溢出
- ContextPage 左侧 `w-72` 是固定宽度，无法折叠

### 3.7 空状态设计不统一

**现象**: 各页面的空状态设计风格差异大:
- ProjectsPage: emoji + 两行文字
- TeamPage 运行状态: emoji + 文字 + 副标题
- DocsPage: 大 emoji + 标题 + 说明 + 底部 legend
- WishPage: emoji + 文字

### 3.8 无 Loading Skeleton/Placeholder

**现象**: 所有页面在数据加载时要么显示 "加载中..." 文字，要么显示空状态。没有骨架屏。

### 3.9 `any` 类型在 UI 层的遗留

**现象**: 
- `TeamPage`: `const [agents, setAgents] = useState<any[]>([])`
- `BoardPage`: 缺少 `FeatureSessionSummary` 类型导入（编译时类型来自全局）
- `TimelinePage`: `useState<any[]>([])` 出现 5 处
- `AcceptancePanel`: `useState<any>(null)` for stats

**影响**: 维护成本高，重构时容易引入运行时错误。

### 3.10 GuidePage 教程内容与最新功能不同步

**现象**: 
- 快速上手中"界面导览"只列了 8 个页面，实际有 14 个
- 未提及 v11 团队成员级 LLM 配置
- 未提及 v12 工作流预设
- 未提及 v13 GitHub 深度集成和密钥管理
- 未提及 v14 Branch/PR 管理

### 3.11 重复的 Markdown 渲染器

**现象**: DocsPage 和 GuidePage 各自实现了一套 Markdown→HTML 渲染器（`renderMarkdown` 和 `renderGuideMarkdown`），逻辑高度重叠但分别维护。

**建议**: 抽取为共享 `utils/markdown.ts`

---

## 4. 用户旅程断点分析

### 旅程 A: 新用户首次使用

```
打开应用 → [P0: 无引导] → 看到空白项目列表 → 注意到 "配置 LLM" 提示
→ 进入设置 → [P0: 配置门槛高] → 不理解三层模型 → 放弃/填错
→ [P0: 错误信息不友好] → 看到技术错误 → 彻底放弃
```
**流失风险**: 极高。建议将 Onboarding + 一键配置 列为最高优先修复项。

### 旅程 B: 配置完成后的首个项目

```
创建项目 → [P1: 路径硬编码] → D盘不存在则失败
→ 进入许愿页 → 提交需求 → [P1: 4次IPC链] → 等待较久
→ 跳到全景页 → [P0: 无Toast] → 不确定是否启动成功
→ 等待 Agent 工作 → 去看板页 → [P1: 无拖拽] → 只能观看
→ 项目完成 → 验收面板弹出 → [正常]
```

### 旅程 C: 导入已有项目

```
选择导入 → 选文件夹 → 点击导入 → [P0: 进度条假数据]
→ 跳到 Overview → 不知道分析进度 → 反复刷新
→ 分析完成 → 无通知 → 偶然发现文档已生成
```

---

## 5. 优先行动建议

### 🔴 Sprint 1: 首次体验修复 (1-2 周)

| # | 任务 | 预估 |
|---|------|------|
| 1 | 全局 Toast 组件 + 替换所有 `alert()/confirm()` | 4h |
| 2 | 错误码映射层 (至少覆盖 HTTP 40x/50x, 网络错误, LLM 特定错误) | 3h |
| 3 | 所有删除操作加 confirm (项目/成员/工作流/任务) | 2h |
| 4 | LLM 设置增加"一键配置"模式 + 验证合并到保存流程 | 4h |
| 5 | 新手引导向导 (Welcome Modal, 3-5 步) | 6h |
| 6 | 工作区路径改用动态默认值 | 1h |

### 🟡 Sprint 2: 核心流程打磨 (2-3 周)

| # | 任务 | 预估 |
|---|------|------|
| 7 | 轮询优化 (Page Visibility API + 统一刷新间隔) | 3h |
| 8 | 预算硬限制 (LLM调用前检查 + 超预算暂停) | 4h |
| 9 | 隐藏 Placeholder 功能 (版本回退, 空文档分类, alert 压缩按钮) | 2h |
| 10 | WishPage 提交原子化 + MetaAgent 消息 Markdown 渲染 | 4h |
| 11 | 导入进度实时推送 | 3h |
| 12 | TeamPage 默认 Tab 智能切换 | 0.5h |

### 🟢 Sprint 3: 品质提升 (3-4 周)

| # | 任务 | 预估 |
|---|------|------|
| 13 | 统一空状态设计 + Loading Skeleton | 4h |
| 14 | 全局快捷键 + 弹窗 Escape | 3h |
| 15 | GuidePage 教程内容更新至 v14 | 2h |
| 16 | Markdown 渲染器抽取复用 | 1h |
| 17 | UI 层 `any` 类型清理 | 3h |
| 18 | 代码高亮 (OutputPage) | 2h |

---

## 6. 亮点与肯定

复盘同时也要记录做得好的部分:

✅ **WishPage 的停滞原因诊断 (stallDiagnosis)** — 自动分析每个 Feature 未推进的原因，对用户理解项目卡点非常有价值  
✅ **ContextPage 的三栏式设计** — 成员列表 / 模块列表 / 内容预览，信息层次清晰，交互流畅  
✅ **WorkflowPage 的 SVG 流水线可视化** — 直观展示阶段进度，活跃阶段有脉冲动效  
✅ **LogsPage 的流式输出面板 + 大段内容格式化** — JSON 折叠、Markdown 标题加粗、分段显示，极大提升日志可读性  
✅ **TeamPage v11 的成员级配置** — 模型/MCP/Skill 独立配置的 4-Tab 弹窗设计合理  
✅ **AcceptancePanel 的验收报告设计** — 完成度、文档状态、Feature 详情、驳回表单，信息完整且决策路径清晰  
✅ **GuidePage 的分难度教程** — 入门/基础/进阶标签帮助用户按水平筛选  
✅ **SystemMonitor 的迷你面积图** — 纯 SVG 无外部依赖，类 Windows 任务管理器的即视感  

---

## 7. 附录: 审查范围

| 类型 | 数量 | 文件 |
|------|------|------|
| 页面 | 14 | ProjectsPage, OverviewPage, WishPage, BoardPage, TeamPage, DocsPage, OutputPage, LogsPage, ContextPage, WorkflowPage, TimelinePage, SettingsPage, GuidePage + overview/ 子目录 |
| 组件 | 12 | Sidebar, StatusBar, AcceptancePanel, MetaAgentPanel, MetaAgentSettings, SessionManager, SystemMonitor, ActivityCharts, AgentWorkFeed, ContextMenu, ErrorBoundary, TechBackground |
| 后端参考 | 43+ | electron/engine/ 全量模块, electron/ipc/ 11 个 handler |
| 设计文档 | 3 | CLAUDE.md (v14.0), DESIGN.md, EVOLUTION-ROADMAP.md |

---

*报告生成: 2026-03-02 | 基于 v14.0 全量代码审读 | 产品经理视角*
