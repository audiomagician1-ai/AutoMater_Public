# 智械母机 AutoMater — 产品体验复盘报告

> **日期**: 2026-03-02 | **版本**: v15.0 | **视角**: 产品经理 (UX / 用户旅程)  
> **范围**: 全功能 14 页面 + 12 组件 + 后端引擎交互 | **排除**: 侧边栏重构、全景页重设计  
> **状态**: ✅ 全部 12 项已实施

---

## 0. 执行摘要

本次复盘基于 v14.0 全量源码逐行审读，从目标用户视角梳理产品体验缺陷。经评审确认 **12 个需优化项**，**全部已在 v15.0 中实施**。

| 优先级 | 数量 | 关键主题 | 状态 |
|--------|------|---------|------|
| 🔴 P0 (阻断/流失) | 7 | 新手引导缺失、LLM配置门槛、错误信息技术化、删除无确认、无Toast反馈、导入进度假数据、版本回退空壳 | ✅ 全部完成 |
| 🟡 P1 (体验打磨) | 5 | 页面过渡动效、键盘快捷键、空状态统一、代码高亮、MetaAgent Markdown渲染 | ✅ 全部完成 |

---

## 1. 🔴 P0 — 阻断级体验问题

### 1.1 首次启动无引导 (可跳过式 Onboarding)

**现象**: 用户首次打开应用，直接面对空白项目列表页，唯一的提示是一行小字 "💡 首次使用请先配置 LLM"。没有步骤引导、没有交互式教程、没有示范项目。

**影响**: 目标用户是"非程序员"，对 LLM、API Key、模型选择完全陌生。当前体验等同于把用户扔进一个空房间。GuidePage 虽有 8 篇教程，但用户需要自己找到侧边栏的 📖 图标才能看到。

**建议**:
- 首次启动弹出欢迎向导（3-5 步: 欢迎 → API Key → 创建示例项目 → 完成）
- **必须支持"跳过引导"** — 有经验的用户不应被强制走完流程
- 跳过后在侧边栏或设置中保留"重新查看引导"入口

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
- 所有删除操作统一加二次确认对话框，确认文案明确告知后果
- 使用产品内自定义 Modal 而非浏览器原生 `confirm()`

---

### 1.5 全局缺少 Toast/Notification 反馈机制

**现象**: 所有用户操作的反馈都写入 `addLog()`，只在 LogsPage 可见。用户在 ProjectsPage 创建项目、在 TeamPage 保存配置、在 SettingsPage 保存设置 — 操作后没有任何即时视觉反馈（没有 Toast、没有 Snackbar、没有动效）。部分地方还使用浏览器原生 `alert()/confirm()`（如 SessionManager、ContextPage），与产品风格不一致。

**影响**: 用户不确定操作是否成功，反复点击或产生焦虑。

**建议**:
- 引入全局 Toast 组件（成功绿色、警告黄色、错误红色）
- 替换所有 `alert()/confirm()` 为产品内统一组件
- 关键操作增加 loading → success/error 状态切换

---

### 1.6 导入项目的进度反馈形同虚设

**现象**: `ProjectsPage` 的导入流程设置了 `importProgress` 状态和进度条 UI，但实际触发 `analyzeExisting()` 是 fire-and-forget (`catch(() => {})`):
```tsx
window.automater.project.analyzeExisting(result.projectId).catch(() => {});
```
导入后立即关闭表单、清空进度，进度条永远停在初始状态。用户被弹到 Overview 页面后，只能通过日志猜测分析是否完成。

**建议**: 
- 导入后保持进度面板打开，通过 IPC 事件推送实时进度
- 分析完成后弹出完成提示（结合 Toast 系统）

---

### 1.7 "回退到此版本" 功能是空壳

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

## 2. 🟡 P1 — 体验打磨问题

### 2.1 缺少页面切换过渡动效

**现象**: 页面之间切换是瞬间替换 DOM，没有 fade/slide 过渡动效。切换感受生硬。

**建议**: 添加轻量级 route transition（fade 或 slide），提升切换流畅感

---

### 2.2 无键盘快捷键体系

**现象**: 整个应用没有定义键盘快捷键。无 `Ctrl+N` 创建项目、无 `Ctrl+Enter` 提交需求（WishPage 的 textarea 有但不是全局）、无 `Escape` 关闭弹窗。TeamPage 的 MemberEditModal、WorkflowEditor、AcceptancePanel 等弹窗都没有监听 `Escape` 键。

**建议**:
- 定义核心快捷键: `Ctrl+N` 新建、`Ctrl+Enter` 提交、`Escape` 关闭弹窗
- 所有 Modal 统一支持 `Escape` 关闭
- 可在 GuidePage 或 Settings 中展示快捷键列表

---

### 2.3 空状态设计风格不统一

**现象**: 各页面的空状态设计差异明显:
- ProjectsPage: emoji + 两行文字
- TeamPage 运行状态: emoji + 文字 + 副标题
- DocsPage: 大 emoji + 标题 + 说明 + 底部 legend
- WishPage: emoji + 文字

**建议**: 抽取统一的 `EmptyState` 组件，统一 emoji 大小、标题/副标题层级、操作按钮风格

---

### 2.4 OutputPage 无代码语法高亮

**现象**: CodeView 组件只是纯文本+行号，没有语法高亮。`detectLanguage()` 函数识别了 25+ 种语言但仅用于显示标签，没有实际用于渲染高亮。

**建议**: 引入轻量级语法高亮方案（如 Prism.js 或 Shiki），利用已有的语言检测结果

---

### 2.5 MetaAgent 对话消息无 Markdown 渲染

**现象**: MetaAgentChat 的回复直接用 `whitespace-pre-wrap` 显示纯文本，但 LLM 回复通常包含 Markdown 格式（标题、列表、代码块）。

**影响**: 用户看到的是 `## 标题` 这样的原始文本而不是格式化内容，阅读体验差。

**建议**: 复用 DocsPage 已有的 `renderMarkdown()` 函数渲染 assistant 消息

---

## 3. 用户旅程断点分析

### 旅程 A: 新用户首次使用

```
打开应用 → [P0: 无引导] → 看到空白项目列表 → 注意到 "配置 LLM" 提示
→ 进入设置 → [P0: 配置门槛高] → 不理解三层模型 → 放弃/填错
→ [P0: 错误信息不友好] → 看到技术错误 → 彻底放弃
```
**流失风险**: 极高。Onboarding（可跳过）+ 一键配置是最高优先修复项。

### 旅程 B: 导入已有项目

```
选择导入 → 选文件夹 → 点击导入 → [P0: 进度条假数据]
→ 跳到 Overview → 不知道分析进度 → 反复刷新
→ 分析完成 → 无通知 → 偶然发现文档已生成
```

---

## 4. 行动计划 — ✅ 已全部实施

### Sprint 1: 基础设施 + 阻断修复

| # | 任务 | 状态 | 实施文件 |
|---|------|------|---------|
| 1 | 全局 Toast/Confirm 组件 + 替换所有 `alert()/confirm()` | ✅ | `stores/toast-store.ts` + `components/Toast.tsx` |
| 2 | 错误码映射层 (HTTP 40x/50x, 网络错误, LLM 错误) | ✅ | `utils/errors.ts` — `humanizeError()` + `friendlyErrorMessage()` |
| 3 | 所有删除操作加二次确认 (项目/成员/工作流/任务/需求/记忆) | ✅ | 6 处 `confirm()` 对话框 |
| 4 | LLM 设置"一键配置"模式 + 验证合并到保存 | ✅ | `settings/LlmTab.tsx` — 快速/高级双模式 |
| 5 | 可跳过的新手引导向导 (3 步) | ✅ | `components/Onboarding.tsx` + App localStorage 检测 |
| 6 | 导入进度实时推送 + 完成通知 | ✅ | App.tsx 监听 `project:import-progress` → Toast |
| 7 | 版本回退: 暂时隐藏空壳按钮 | ✅ | OutputPage + DocsPage 改为 toast 提示"即将上线" |

### Sprint 2: 体验打磨

| # | 任务 | 状态 | 实施文件 |
|---|------|------|---------|
| 8 | 页面切换过渡动效 | ✅ | `index.css` — cubic-bezier 优化 + 新增动画类 |
| 9 | 键盘快捷键 + 弹窗 Escape 统一 | ✅ | `hooks/useKeyboardShortcuts.ts` — Escape/Ctrl+N/M/,/数字 |
| 10 | 统一 EmptyState 组件 | ✅ | `components/EmptyState.tsx` + 已替换 3 个页面 |
| 11 | OutputPage 代码语法高亮 | ✅ | `OutputPage.tsx` — `highlightCode()` 内联高亮器 |
| 12 | MetaAgent 消息 Markdown 渲染 | ✅ | `utils/markdown.ts` + WishPage + MetaAgentPanel |

---

## 5. 亮点与肯定

✅ **WishPage 的停滞原因诊断 (stallDiagnosis)** — 自动分析每个 Feature 未推进的原因，对用户理解项目卡点非常有价值  
✅ **ContextPage 的三栏式设计** — 成员列表 / 模块列表 / 内容预览，信息层次清晰，交互流畅  
✅ **WorkflowPage 的 SVG 流水线可视化** — 直观展示阶段进度，活跃阶段有脉冲动效  
✅ **LogsPage 的流式输出面板 + 大段内容格式化** — JSON 折叠、Markdown 标题加粗、分段显示，极大提升日志可读性  
✅ **TeamPage v11 的成员级配置** — 模型/MCP/Skill 独立配置的 4-Tab 弹窗设计合理  
✅ **AcceptancePanel 的验收报告设计** — 完成度、文档状态、Feature 详情、驳回表单，信息完整且决策路径清晰  
✅ **GuidePage 的分难度教程** — 入门/基础/进阶标签帮助用户按水平筛选  
✅ **SystemMonitor 的迷你面积图** — 纯 SVG 无外部依赖，类 Windows 任务管理器的即视感  

---

## 6. 附录: 审查范围

| 类型 | 数量 | 文件 |
|------|------|------|
| 页面 | 14 | ProjectsPage, OverviewPage, WishPage, BoardPage, TeamPage, DocsPage, OutputPage, LogsPage, ContextPage, WorkflowPage, TimelinePage, SettingsPage, GuidePage + overview/ 子目录 |
| 组件 | 12 | Sidebar, StatusBar, AcceptancePanel, MetaAgentPanel, MetaAgentSettings, SessionManager, SystemMonitor, ActivityCharts, AgentWorkFeed, ContextMenu, ErrorBoundary, TechBackground |
| 后端参考 | 43+ | electron/engine/ 全量模块, electron/ipc/ 11 个 handler |
| 设计文档 | 3 | CLAUDE.md (v14.0), DESIGN.md, EVOLUTION-ROADMAP.md |

---

*报告生成: 2026-03-02 | 基于 v14.0→v15.0 全量代码审读 | 产品经理视角 | 12 项全部实施完成*
