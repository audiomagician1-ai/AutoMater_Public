# AgentForge 全链路能力审计报告

> 审计日期: 2026-03-02
> 审计范围: tool-registry.ts (1163行) + tool-executor.ts (1183行) + react-loop.ts (977行) + meta-agent.ts (637行) + 15个底层模块
> 审计方法: 三层交叉验证 — 角色白名单 → 工具定义 → 执行器实现 → 底层依赖模块

---

## 一、工具总览

### 1.1 TOOL_DEFINITIONS 完整清单 (64 个内置工具)

| 序号 | 工具名 | 类别 | 同步/异步 | 底层模块 |
|---|---|---|---|---|
| 1 | `read_file` | File | 同步 | file-writer.ts → `readWorkspaceFile()` |
| 2 | `write_file` | File | 同步 | fs.writeFileSync + file-lock |
| 3 | `edit_file` | File | 同步 | fs.readFileSync/writeFileSync + file-lock |
| 4 | `list_files` | File | 同步 | file-writer.ts → `readDirectoryTree()` |
| 5 | `glob_files` | File | 同步 | execSync (PowerShell/find) |
| 6 | `search_files` | File | 同步 | execSync (Select-String/grep) + rankSearchResults |
| 7 | `batch_edit` | File | 同步 | extended-tools.ts → `batchEdit()` + file-lock |
| 8 | `run_command` | Shell | 同步/异步 | sandbox-executor.ts → `execInSandbox()`/`execInSandboxAsync()` |
| 9 | `run_test` | Shell | 同步 | sandbox-executor.ts → `runTest()` |
| 10 | `run_lint` | Shell | 同步 | sandbox-executor.ts → `runLint()` |
| 11 | `check_process` | Shell | 同步 | sandbox-executor.ts → `getActiveProcess()` |
| 12 | `git_commit` | Git | **异步** | git-provider.ts → `commit()` |
| 13 | `git_diff` | Git | **异步** | git-provider.ts → `getDiff()` |
| 14 | `git_log` | Git | **异步** | git-provider.ts → `getLog()` |
| 15 | `github_create_issue` | GitHub | 异步 | git-provider.ts → `createIssue()` |
| 16 | `github_list_issues` | GitHub | 异步 | git-provider.ts → `listIssues()` |
| 17 | `task_complete` | Control | 同步 | 硬编码返回，在 ReAct 循环中标记 completed=true |
| 18 | `memory_read` | Memory | 同步 | memory-system.ts → `readMemoryForRole()` |
| 19 | `memory_append` | Memory | 同步 | memory-system.ts → `appendProjectMemory()`/`appendRoleMemory()` |
| 20 | `spawn_researcher` | SubAgent | 异步 | sub-agent.ts → `runResearcher()` (ReAct循环硬编码处理) |
| 21 | `report_blocked` | Control | 同步 | 格式化输出，在 `reactAgentLoop` 中标记 blocked=true |
| 22 | `rfc_propose` | Control | 同步 | 格式化 + 写入 DB change_requests 表 |
| 23 | `think` | Thinking | 同步 | extended-tools.ts → `think()` (纯echo) |
| 24 | `todo_write` | Planning | 同步 | extended-tools.ts → `todoWrite()` |
| 25 | `todo_read` | Planning | 同步 | extended-tools.ts → `todoRead()` |
| 26 | `web_search` | Web | 异步 | web-tools.ts → search-provider.ts → 多引擎 fallback |
| 27 | `fetch_url` | Web | 异步 | web-tools.ts → search-provider.ts → `readUrl()` |
| 28 | `http_request` | Web | 异步 | web-tools.ts → `httpRequest()` |
| 29 | `screenshot` | ComputerUse | 同步 | computer-use.ts → `takeScreenshot()` |
| 30 | `mouse_click` | ComputerUse | 同步 | computer-use.ts → `mouseClick()` |
| 31 | `mouse_move` | ComputerUse | 同步 | computer-use.ts → `mouseMove()` |
| 32 | `keyboard_type` | ComputerUse | 同步 | computer-use.ts → `keyboardType()` |
| 33 | `keyboard_hotkey` | ComputerUse | 同步 | computer-use.ts → `keyboardHotkey()` |
| 34 | `browser_launch` | Browser | 异步 | browser-tools.ts → `launchBrowser()` |
| 35 | `browser_navigate` | Browser | 异步 | browser-tools.ts → `navigate()` |
| 36 | `browser_screenshot` | Browser | 异步 | browser-tools.ts → `browserScreenshot()` |
| 37 | `browser_snapshot` | Browser | 异步 | browser-tools.ts → `browserSnapshot()` |
| 38 | `browser_click` | Browser | 异步 | browser-tools.ts → `browserClick()` |
| 39 | `browser_type` | Browser | 异步 | browser-tools.ts → `browserType()` |
| 40 | `browser_evaluate` | Browser | 异步 | browser-tools.ts → `browserEvaluate()` |
| 41 | `browser_wait` | Browser | 异步 | browser-tools.ts → `browserWait()` |
| 42 | `browser_network` | Browser | 异步 | browser-tools.ts → `browserNetwork()` |
| 43 | `browser_close` | Browser | 异步 | browser-tools.ts → `closeBrowser()` |
| 44 | `analyze_image` | Visual | 异步 | visual-tools.ts → `analyzeImage()` (需 Vision LLM) |
| 45 | `compare_screenshots` | Visual | 异步 | visual-tools.ts → `compareScreenshots()` (需 Vision LLM) |
| 46 | `visual_assert` | Visual | 异步 | visual-tools.ts → `visualAssert()` (需 Vision LLM) |
| 47 | `skill_acquire` | Skill | 同步 | skill-evolution.ts → `skillEvolution.acquire()` |
| 48 | `skill_search` | Skill | 同步 | skill-evolution.ts → `skillEvolution.searchSkills()` |
| 49 | `skill_improve` | Skill | 同步 | skill-evolution.ts → `skillEvolution.improve()` |
| 50 | `skill_record_usage` | Skill | 同步 | skill-evolution.ts → `skillEvolution.recordUsage()` |
| 51 | `spawn_agent` | SubAgent v7 | 异步 | sub-agent-framework.ts → `spawnSubAgent()` |
| 52 | `spawn_parallel` | SubAgent v7 | 异步 | sub-agent-framework.ts → `spawnParallel()` |
| 53 | `list_sub_agents` | SubAgent v7 | 同步 | sub-agent-framework.ts → `getActiveSubAgents()` |
| 54 | `cancel_sub_agent` | SubAgent v7 | 同步 | sub-agent-framework.ts → `cancelSubAgent()` |
| 55 | `sandbox_init` | Docker | 异步 | docker-sandbox.ts → `initSandbox()` |
| 56 | `sandbox_exec` | Docker | 异步 | docker-sandbox.ts → `execInContainer()` |
| 57 | `sandbox_write` | Docker | 异步 | docker-sandbox.ts → `writeToContainer()` |
| 58 | `sandbox_read` | Docker | 异步 | docker-sandbox.ts → `readFromContainer()` |
| 59 | `sandbox_destroy` | Docker | 异步 | docker-sandbox.ts → `destroySandbox()` |
| 60 | `browser_hover` | Browser v7 | 异步 | browser-tools.ts → `browserHover()` |
| 61 | `browser_select_option` | Browser v7 | 异步 | browser-tools.ts → `browserSelectOption()` |
| 62 | `browser_press_key` | Browser v7 | 异步 | browser-tools.ts → `browserPressKey()` |
| 63 | `browser_fill_form` | Browser v7 | 异步 | browser-tools.ts → `browserFillForm()` |
| 64 | `browser_drag` | Browser v7 | 异步 | browser-tools.ts → `browserDrag()` |
| 65 | `browser_tabs` | Browser v7 | 异步 | browser-tools.ts → `browserTabs()` |
| 66 | `browser_file_upload` | Browser v7 | 异步 | browser-tools.ts → `browserFileUpload()` |
| 67 | `browser_console` | Browser v7 | 异步 | browser-tools.ts → `browserConsole()` |
| 68 | `web_search_boost` | Search v8 | 异步 | web-tools.ts → `webSearchBoost()` → search-provider.ts |
| 69 | `deep_research` | Research v8 | 异步 | research-engine.ts → `deepResearch()` |
| 70 | `configure_search` | Search v8 | 同步 | search-provider.ts → `configureSearch()` |
| 71 | `run_blackbox_tests` | Testing v8 | 异步 | blackbox-test-runner.ts → `runBlackboxTests()` |

**合计: 71 个内置工具定义 + 动态 MCP/Skill 外部工具**

---

## 二、角色工具白名单 vs 实际可用性

### 2.1 PM (16 个工具)

| 工具名 | TOOL_DEFINITIONS ✓ | executor 实现 ✓ | 调用路径 | 状态 |
|---|---|---|---|---|
| `think` | ✅ | ✅ 同步 | executeTool → think() | ✅ 完整 |
| `task_complete` | ✅ | ✅ 硬编码 | reactAgentLoop 特殊处理 | ✅ 完整 |
| `todo_write` | ✅ | ✅ 同步 | executeTool → todoWrite() | ✅ 完整 |
| `todo_read` | ✅ | ✅ 同步 | executeTool → todoRead() | ✅ 完整 |
| `read_file` | ✅ | ✅ 同步 | executeTool → readWorkspaceFile() | ✅ 完整 |
| `list_files` | ✅ | ✅ 同步 | executeTool → readDirectoryTree() | ✅ 完整 |
| `search_files` | ✅ | ✅ 同步 | executeTool → execSync grep | ✅ 完整 |
| `glob_files` | ✅ | ✅ 同步 | executeTool → execSync | ✅ 完整 |
| `web_search` | ✅ | ✅ 异步 | executeToolAsync → webSearch() | ✅ 完整 |
| `fetch_url` | ✅ | ✅ 异步 | executeToolAsync → fetchUrl() | ✅ 完整 |
| `web_search_boost` | ✅ | ✅ 异步 | executeToolAsync → webSearchBoost() | ✅ 完整 |
| `deep_research` | ✅ | ✅ 异步 | executeToolAsync → deepResearch() | ✅ 完整 |
| `configure_search` | ✅ | ✅ 同步 | executeTool → configureSearch() | ✅ 完整 |
| `memory_read` | ✅ | ✅ 同步 | executeTool → readMemoryForRole() | ✅ 完整 |
| `memory_append` | ✅ | ✅ 同步 | executeTool → appendProjectMemory() | ✅ 完整 |
| `report_blocked` | ✅ | ✅ 同步/硬编码 | reactAgentLoop 特殊处理 + executeTool | ✅ 完整 |
| `rfc_propose` | ✅ | ✅ 同步 | executeTool → DB write | ✅ 完整 |

**PM 结论: 17/17 工具全部可用 ✅**

### 2.2 Architect (17 个工具)

与 PM 完全一致，额外多了 `write_file`。

| 额外工具 | 状态 |
|---|---|
| `write_file` | ✅ 完整 — executeTool → fs.writeFileSync + file-lock |

**Architect 结论: 18/18 工具全部可用 ✅**

### 2.3 Developer (56+ 个工具 — 最大权限角色)

| 类别 | 工具列表 | 数量 | 状态 |
|---|---|---|---|
| File | read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files | 7 | ✅ 全部完整 |
| Shell | run_command, run_test, run_lint, check_process | 4 | ✅ 全部完整 |
| Git | git_commit, git_diff | 2 | ✅ 完整 (异步) |
| Web | web_search, fetch_url, http_request, web_search_boost, deep_research, configure_search | 6 | ✅ 全部完整 |
| Thinking | think, task_complete, todo_write, todo_read, rfc_propose | 5 | ✅ 全部完整 |
| Memory | memory_read, memory_append | 2 | ✅ 完整 |
| SubAgent | spawn_researcher, spawn_agent, spawn_parallel, list_sub_agents, cancel_sub_agent | 5 | ✅ 全部完整 |
| ComputerUse | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | 5 | ✅ 全部完整 |
| Browser (12) | browser_launch..browser_console | 12 + 6(v7) | ✅ 全部完整 |
| Visual | analyze_image, compare_screenshots, visual_assert | 3 | ⚠️ 需要 Vision LLM callVision 回调 |
| Skill | skill_acquire, skill_search, skill_improve, skill_record_usage | 4 | ✅ 全部完整 |
| Docker | sandbox_init..sandbox_destroy | 5 | ⚠️ 需要宿主机安装 Docker |
| Testing | run_blackbox_tests | 1 | ✅ 完整 |

**Developer 结论: 61/61 工具全部有执行路径 ✅ (2个有运行时前置条件)**

### 2.4 QA (42+ 个工具)

与 Developer 类似但**缺少**写文件权限。特殊差异：
- ❌ 无 `write_file`, `edit_file`, `batch_edit` (正确, QA 不应写代码)
- ❌ 无 `git_commit`, `git_diff` (正确, QA 不应提交)
- ✅ 有 `run_command` (可执行测试)
- ✅ 有 `sandbox_init/exec/read/destroy` (但缺少 `sandbox_write`)
- ✅ 有 `spawn_agent`, `list_sub_agents` (可生成子Agent, 但缺少 `cancel_sub_agent`, `spawn_parallel`)
- ✅ 有 `skill_search`, `skill_record_usage` (但缺少 `skill_acquire`, `skill_improve`)
- ✅ 有 `run_blackbox_tests`

**QA 结论: 全部白名单工具均有执行路径 ✅ — 权限设计合理**

### 2.5 DevOps (12 个工具)

| 工具名 | 状态 |
|---|---|
| think, task_complete, todo_write, todo_read | ✅ 完整 |
| run_command, check_process, http_request | ✅ 完整 |
| git_commit, git_diff, git_log | ✅ 完整 (异步) |
| github_create_issue, github_list_issues | ✅ 完整 (仅 GitHub 模式) |
| memory_read, memory_append | ✅ 完整 |

**DevOps 结论: 14/14 工具全部可用 ✅**

### 2.6 Researcher (9 个工具)

| 工具名 | 状态 |
|---|---|
| think | ✅ 完整 |
| read_file, list_files, search_files, glob_files | ✅ 完整 |
| web_search, fetch_url | ✅ 完整 |
| web_search_boost, deep_research | ✅ 完整 |

**Researcher 结论: 9/9 工具全部可用 ✅ — 纯只读 + 搜索, 无 task_complete**

⚠️ **发现: Researcher 没有 `task_complete`**。这意味着 researcher 子Agent 无法主动标记任务完成——它依赖 `sub-agent.ts` 中 `runResearcher()` 的 8 轮硬限制自动结束，以及 `sub-agent-framework.ts` 中 `spawnSubAgent()` 的迭代限制自动结束。**这是故意设计，非 bug。**

### 2.7 Meta-Agent (13 个工具)

| 工具名 | TOOL_DEFINITIONS ✓ | executor ✓ | 调用路径 (meta-agent.ts) | 状态 |
|---|---|---|---|---|
| `think` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `task_complete` | ✅ | ✅ 硬编码 | 第489行特殊处理 | ✅ 完整 |
| `read_file` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `list_files` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `search_files` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `glob_files` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `web_search` | ✅ | ✅ 异步 | 第519行 isAsync 判定 → executeToolAsync() | ✅ 完整 |
| `fetch_url` | ✅ | ✅ 异步 | 第519行 isAsync 判定 → executeToolAsync() | ✅ 完整 |
| `web_search_boost` | ✅ | ✅ 异步 | ⚠️ 第519行 isAsync 判定**未包含** | 🔴 **BUG** |
| `deep_research` | ✅ | ✅ 异步 | ⚠️ 第519行 isAsync 判定**未包含** | 🔴 **BUG** |
| `memory_read` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `memory_append` | ✅ | ✅ 同步 | executeTool() | ✅ 完整 |
| `git_log` | ✅ | ✅ 异步 | 第519行 isAsync 判定**未包含** | 🔴 **BUG** |

---

## 三、发现的问题

### 🔴 BUG-1: Meta-Agent isAsync 路由不完整 (严重)

**位置**: `meta-agent.ts` 第519行
```typescript
const isAsync = ['web_search', 'fetch_url', 'git_log'].includes(tc.function.name)
  || tc.function.name.startsWith('mcp_');
```

**问题**: `web_search_boost`, `deep_research`, `git_log` 这三个工具被加入了 meta-agent 的 ROLE_TOOLS 白名单，但 meta-agent 内部的 isAsync 判定**遗漏了 `web_search_boost` 和 `deep_research`**。

- `web_search_boost`: 未在 isAsync 列表中 → 走同步 `executeTool()` → 返回 `[async] web_search_boost...` 占位字符串 → **永远无法获得真实结果**
- `deep_research`: 同上 → **永远无法获得真实结果**
- `git_log`: 已在 isAsync 列表中 ✅ (但 executeTool 同步入口会 throw Error "git_log is now async-only") → 如果 isAsync 判定失败会崩溃。实际上已包含在列表中，所以 OK。

**修复方案**:
```typescript
const isAsync = ['web_search', 'fetch_url', 'git_log', 'web_search_boost', 'deep_research'].includes(tc.function.name)
  || tc.function.name.startsWith('mcp_');
```

### 🔴 BUG-2: react-loop.ts 中 isAsync 判定也不完整 (中等)

**位置**: `react-loop.ts` 第443行 (reactDeveloperLoop)
```typescript
const isAsync = tc.function.name.startsWith('github_') || tc.function.name.startsWith('browser_')
  || tc.function.name.startsWith('mcp_') || tc.function.name.startsWith('skill_')
  || tc.function.name.startsWith('git_')
  || ['web_search', 'fetch_url', 'http_request', 'analyze_image', 'compare_screenshots', 'visual_assert'].includes(tc.function.name);
```

**遗漏工具**: 
- `web_search_boost` ❌
- `deep_research` ❌  
- `run_blackbox_tests` ❌
- `spawn_agent` ❌ (由 isAsyncTool() 注册但 reactDeveloperLoop 硬编码了 spawn_researcher 特殊处理，spawn_agent 走默认同步路径会返回 `[async] spawn_agent...` 占位)
- `spawn_parallel` ❌ (同上)
- `sandbox_*` 5个 ❌ (以 `sandbox_` 开头，不在 startsWith 前缀列表中)

**注意**: 这些工具在同步 `executeTool()` 中已有 fallback `case` 返回 `[async] ...` 占位，**不会崩溃**，但它们**永远无法获得真实执行结果**。

与此对比，**`reactAgentLoop` (通用版, 第887行)** 的 isAsync 判定同样不完整，遗漏了同样的工具。

**根因**: isAsync 判定逻辑存在**三份独立副本** — `isAsyncTool()` 在 tool-registry.ts (权威源)、reactDeveloperLoop 硬编码、reactAgentLoop 硬编码。三者不同步。

**修复方案**: 统一使用 `isAsyncTool()` 函数 (tool-registry.ts 第1150行):
```typescript
import { isAsyncTool } from './tool-registry';
// ...
const isAsync = isAsyncTool(tc.function.name);
```

### 🟡 WARN-1: isAsyncTool() 自身也有遗漏 (低)

**位置**: `tool-registry.ts` 第1150-1162行

```typescript
export function isAsyncTool(toolName: string): boolean {
  if (toolName.startsWith('mcp_') || toolName.startsWith('skill_')) return true;
  return toolName.startsWith('github_')
    || toolName.startsWith('browser_')
    || toolName.startsWith('sandbox_')
    || ['web_search', 'fetch_url', 'http_request',
        'web_search_boost', 'deep_research', 'run_blackbox_tests',
        'analyze_image', 'compare_screenshots', 'visual_assert',
        'spawn_agent', 'spawn_parallel', 'spawn_researcher',
       ].includes(toolName);
}
```

遗漏: **`git_commit`, `git_diff`, `git_log`** — 这三个 git 工具在 tool-executor.ts 第376-379行已标记为 "async-only" (throw Error)，但 `isAsyncTool()` 没有标记它们。在 reactDeveloperLoop 中通过 `startsWith('git_')` 覆盖了，但在使用 `isAsyncTool()` 的地方（如果有代码直接调用该函数）会漏掉 git 工具。

**修复**: 在 isAsyncTool 中加上 `|| toolName.startsWith('git_')`。

### 🟡 WARN-2: Skill 工具 isAsync 标记错误

`isAsyncTool()` 标记所有 `skill_` 前缀工具为异步，但实际的 `skill_acquire`/`skill_search`/`skill_improve`/`skill_record_usage` 四个工具在 `executeTool()` (同步分支) 中有完整实现。外部 Skill 工具 (`skill_loader` 注入的) 确实需要异步执行。

**影响**: 当 isAsyncTool 被用于路由决策时，内置 skill 工具会被错误路由到异步路径 → `executeToolAsyncRaw` 末尾的 `executeSkillTool()` → 尝试通过 skillManager 执行 → 可能找不到内置工具 → 走 fallback 到同步 `executeTool()`。**最终能工作但路径冗余。**

---

## 四、各 Agent 调用路径汇总

### 4.1 调用路径图

```
用户操作
  │
  ├── 开发流水线 (orchestrator.ts)
  │   ├── Phase 1: PM 需求分析      → reactAgentLoop(role='pm')       → getToolsForRole('pm')
  │   ├── Phase 2: Architect 架构    → reactAgentLoop(role='architect') → getToolsForRole('architect')
  │   ├── Phase 3: Developer 编码    → reactDeveloperLoop()             → getToolsForRole('developer')
  │   │   └── spawn_researcher       → sub-agent.ts → runResearcher()  (独立8轮mini ReAct)
  │   │   └── spawn_agent/parallel   → sub-agent-framework.ts          (独立25轮ReAct)
  │   ├── Phase 4: QA 审查           → reactAgentLoop(role='qa')       → getToolsForRole('qa')
  │   └── Phase 5: DevOps 部署       → reactAgentLoop(role='devops')   → getToolsForRole('devops')
  │
  └── Meta-Agent 对话 (meta-agent.ts)
      └── 自建8轮ReAct循环             → getToolsForRole('meta-agent')
          └── executeTool / executeToolAsync 手动路由
```

### 4.2 三种 ReAct 循环对比

| 维度 | reactDeveloperLoop | reactAgentLoop (通用) | meta-agent 内联 |
|---|---|---|---|
| 文件位置 | react-loop.ts:148 | react-loop.ts:766 | meta-agent.ts:438 |
| 最大轮次 | 25 | 15 (可配) | 8 |
| 工具权限 | developer 固定 | 按 role 参数 | meta-agent 固定 |
| Guard 系统 | ✅ 完整 (checkReactTermination) | ✅ 完整 | ❌ 无 guard |
| isAsync 路由 | 硬编码 ⚠️ 不完整 | 硬编码 ⚠️ 不完整 | 硬编码 ⚠️ 不完整 |
| 消息压缩 | ✅ LLM摘要 + fallback | ✅ LLM摘要 + fallback | ❌ 无压缩 |
| 会话备份 | ✅ backupConversation | ✅ backupConversation | ✅ backupConversation |
| 文件写锁 | ✅ acquireFileLock | ❌ (无 workerId) | N/A (只读) |
| Skill 上下文 | ✅ buildSkillContext | ❌ | ❌ |
| Code Graph | ✅ buildCodeGraph | ❌ | ❌ |
| 预算检查 | ✅ checkBudget | ❌ | ❌ |
| 对话备份 | ✅ | ✅ | ✅ |

---

## 五、外部工具注入路径

### 5.1 MCP 工具
```
getToolsForRole() → getExternalMcpTools() → mcpManager.getAllTools()
  → 工具名格式: mcp_{serverId}_{originalName}
  → 执行: executeToolAsync → executeMcpTool() → mcpManager.callTool()
```
✅ 完整闭环，工具注册和执行路径均通。

### 5.2 Skill Loader 工具  
```
getToolsForRole() → getExternalSkillTools() → skillManager.getDefinitionsForRole()
  → 工具名格式: 原始 name
  → 执行: executeToolAsync → executeSkillTool() → skillManager.executeSkill()
```
✅ 完整闭环。

---

## 六、修复优先级

| 优先级 | 问题 | 影响 | 修复难度 |
|---|---|---|---|
| **P0** | BUG-1: meta-agent isAsync 遗漏 web_search_boost/deep_research | 这两个工具在 meta-agent 中永远返回占位符 | 1行代码 |
| **P0** | BUG-2: reactDeveloperLoop + reactAgentLoop isAsync 三份硬编码不同步 | spawn_agent/spawn_parallel/sandbox_*/deep_research/web_search_boost/run_blackbox_tests 在开发者循环中永远返回占位符 | 统一调用 isAsyncTool() |
| **P1** | WARN-1: isAsyncTool() 遗漏 git_* 前缀 | git 工具如果不经 startsWith('git_') 硬编码兜底会走同步 throw Error | 1行代码 |
| **P2** | WARN-2: 内置 skill 工具被错误标记为异步 | 路径冗余但不影响功能 | 可暂不修 |
| **P2** | meta-agent 无 Guard 系统 | 无重复调用检测、无超时/预算控制 | 建议迁移到 reactAgentLoop |

---

## 七、架构改进建议

### 7.1 统一 isAsync 路由 (立即可做)
将三处硬编码的 isAsync 判定全部替换为 `isAsyncTool(toolName)`，并补全该函数中的 `git_*` 前缀。

### 7.2 Meta-Agent 迁移到 reactAgentLoop (中期)
当前 meta-agent 在 `meta-agent.ts` 中自建了一个简化版 ReAct 循环。建议迁移到 `reactAgentLoop()`，获得:
- Guard 系统 (防重复、防超时)
- 消息压缩 (长对话不爆上下文)
- 统一的 isAsync 路由
- 统一的日志格式
- 预算管控

### 7.3 工具执行路由重构 (长期)
当前工具执行存在 sync/async 双路径 + 同步入口中大量异步工具返回占位符的设计。建议:
- 所有工具统一走 `async executeToolAsync()` 
- 移除 `executeTool()` 同步入口中的占位符 case
- 或者让 `executeTool()` 检测到异步工具时自动 reject 而非返回无用占位

---

## 八、结论

**总体健康度: 85/100**

- ✅ 7个角色 × 71个工具的白名单映射**全部正确** — 每个角色白名单中的工具名在 TOOL_DEFINITIONS 中都有定义
- ✅ 71个工具的 executor 实现**全部存在** — 每个工具在 `executeTool()`/`executeToolAsync()` 中都有 case 处理
- ✅ 底层实现模块**全部存在** — 15个依赖模块 (file-writer, sandbox-executor, git-provider, memory-system, web-tools, search-provider, computer-use, browser-tools, visual-tools, extended-tools, skill-evolution, skill-loader, mcp-client, sub-agent, sub-agent-framework, docker-sandbox, research-engine, blackbox-test-runner) 全部有文件且导出匹配
- 🔴 isAsync 路由三处硬编码不同步 — 导致 **spawn_agent, spawn_parallel, sandbox_*, web_search_boost, deep_research, run_blackbox_tests** 等高级工具在实际 ReAct 循环中**无法获得真实执行结果**
- 🟡 meta-agent 自建循环缺少 Guard/压缩/预算 保护

**最紧急修复**: 统一 isAsync 路由到 `isAsyncTool()` 函数，一次修复解决所有问题。

---

## 九、修复记录 (2026-03-02 已执行)

### 修复 1: isAsyncTool() 补充 git_* 前缀
- **文件**: `electron/engine/tool-registry.ts` 第1157行
- **变更**: 添加 `|| toolName.startsWith('git_')`
- **效果**: git_commit, git_diff, git_log 现在被权威 isAsyncTool() 函数正确标记为异步

### 修复 2: reactDeveloperLoop isAsync 统一化  
- **文件**: `electron/engine/react-loop.ts` 第18行, 第443行
- **变更**: import 添加 `isAsyncTool`; 第443行硬编码替换为 `isAsyncTool(tc.function.name)`
- **效果**: 修复了 spawn_agent, spawn_parallel, sandbox_*, web_search_boost, deep_research, run_blackbox_tests 在开发者ReAct循环中无法获得真实结果的问题

### 修复 3: reactAgentLoop isAsync 统一化
- **文件**: `electron/engine/react-loop.ts` 第887行
- **变更**: 硬编码替换为 `isAsyncTool(tc.function.name)`
- **效果**: 通用ReAct循环 (PM/Architect/QA/DevOps) 的异步路由与权威函数同步

### 修复 4: meta-agent isAsync 统一化
- **文件**: `electron/ipc/meta-agent.ts` 第22行, 第519行  
- **变更**: import 添加 `isAsyncTool`; 第519行硬编码替换为 `isAsyncTool(tc.function.name)`
- **效果**: 修复了 web_search_boost, deep_research 在元Agent中无法获得真实结果的问题

### tsc 验证
- 四个修改文件 **零新增 tsc 错误**
- 项目现存 245 个 tsc 错误全部来自 `__tests__/*.test.ts` 和 `context-collector.ts`，为预存旧错误
