# AgentForge v2.1+ 工具体系扩展迭代计划

> **日期**: 2026-03-01  
> **版本**: v2.0.0 → v2.1 ~ v3.0  
> **核心认知修正**: AgentForge 的 Agent 不仅写代码，还要做复杂规划、黑盒测试、GUI 操作，未来还要直接操控游戏引擎编辑器（Unity/Unreal）。工具体系必须按此目标全面扩展。

---

## 1. 定位重定义

### 之前的理解（错误）
AgentForge = 代码生成工具，Agent 只需要文件操作 + Shell + Git

### 纠正后的理解
AgentForge = **AI 虚拟开发团队**，Agent 需要：
- ✅ 写代码、读代码、搜索代码（已有）
- ✅ 执行命令、运行测试（已有）
- 🆕 **看到屏幕** — 截图、理解 GUI 界面
- 🆕 **操控鼠标键盘** — 点击按钮、拖拽组件、输入文本
- 🆕 **浏览器自动化** — 打开网页、填表单、爬取内容、E2E 黑盒测试
- 🆕 **搜索互联网** — 查文档、找方案、搜 API 用法
- 🆕 **复杂规划** — 维护任务列表、思考推理、分阶段执行
- 🆕 **视觉验证** — 截图对比、UI 回归检测
- 🆕 **游戏引擎控制** — 通过 HTTP API / CLI 操控 Unity/Unreal Editor

### 对标产品
| 能力层 | 对标 |
|---|---|
| 代码智能 | Claude Code, OpenHands, Cline |
| Computer Use | Anthropic Computer Use, Google Gemini Computer Use |
| 浏览器 | Playwright MCP, Puppeteer MCP |
| 游戏引擎 | Unity API Communicator (200+ HTTP endpoints), Unreal UAT CLI |
| 规划系统 | Claude Code TodoWrite, OpenHands ThinkTool |

---

## 2. 现有工具盘点（17 个）

```
文件操作:  read_file, write_file, edit_file, list_files, glob_files, search_files
Shell:     run_command, run_test, run_lint
Git:       git_commit, git_diff, git_log
GitHub:    github_create_issue, github_list_issues
记忆:      memory_read, memory_append
子Agent:   spawn_researcher
流程:      task_complete
```

---

## 3. EchoAgent（我自己）的工具审计

我自己拥有 ~55 个工具，分为 8 大类。AgentForge 应该参考但不是照搬：

| 类别 | EchoAgent 的工具 | AgentForge 是否需要 | 备注 |
|---|---|---|---|
| **文件系统** | read, edit, multiedit, ls, grep | ✅ 已有等价物 | 需要增加 batch_edit |
| **Shell** | bash (PowerShell) | ✅ 已有 | 需要增加后台执行 + 进程管理 |
| **Web搜索** | WebSearch_websearch (SerpApi), WebSearch_read_url | ✅ **必须新增** | 用 Jina API（免费开源） |
| **Playwright浏览器** | 20个工具：navigate, snapshot, click, type, fill_form, screenshot, evaluate, drag, hover, select_option, file_upload, tabs, network_requests, console_messages... | ✅ **必须新增** | 用 Playwright npm 包 |
| **GUI Computer Use** | 14个工具：screenshot, mouse_move, left_click, right_click, double_click, scroll, key, type, hold_key, drag, cursor_position... | ✅ **必须新增** | PowerShell/.NET + Electron desktopCapturer |
| **Docker沙箱** | initialize, exec, read/write_file, expose_port, upload/download | ⬜ v3.0+ | 当前用子进程沙箱够用 |
| **TODO管理** | todowrite, todoread | ✅ **必须新增** | Agent 规划利器 |
| **子Agent** | ask_agent (10个子Agent) | ✅ 已有 spawn_researcher | 未来可扩展 |

---

## 4. 扩展工具集设计（分 Tier）

### Tier 1: v2.1 — 思考力+互联网（7 个新工具，零新依赖）

**目标**: 让 Agent 能上网搜索、能深度思考、能自我规划

| 工具 | 用途 | 实现方式 |
|---|---|---|
| `think` | 让 LLM 有专门的"思考空间"，不产生副作用 | 纯 echo，返回原文（参考 Claude Code） |
| `web_search` | 搜索互联网 | Jina Search API: `https://s.jina.ai/{query}` — 免费、返回 Markdown |
| `fetch_url` | 抓取网页内容 | Jina Reader API: `https://r.jina.ai/{url}` — 免费、HTML→Markdown |
| `todo_write` | Agent 维护自己的任务清单 | 内存 Map 存储，per-agent 隔离 |
| `todo_read` | 读取当前任务清单 | 读 Map |
| `batch_edit` | 一次调用修改同一文件多处 | 复用 edit_file 逻辑，依次 apply |
| `http_request` | 发送任意 HTTP 请求（测试 API、webhook） | Node fetch，支持 GET/POST/PUT/DELETE + headers + body |

**新增 action 类型**: `'web'`, `'think'`, `'plan'`

**交付物**: `electron/engine/web-tools.ts`, `electron/engine/extended-tools.ts`, 更新 `tool-system.ts` + `prompts.ts`

---

### Tier 2: v2.2 — Computer Use 基础（5 个新工具，依赖 PowerShell/.NET）

**目标**: Agent 能看到屏幕、操控鼠标键盘 — 黑盒测试的基础

| 工具 | 用途 | 实现方式 |
|---|---|---|
| `screenshot` | 截取屏幕/指定窗口 | Windows: PowerShell `[System.Drawing]` 截图→Base64 PNG；也可用 Electron `desktopCapturer` |
| `mouse_click` | 鼠标点击指定坐标 | PowerShell: `[System.Windows.Forms.Cursor]::Position` + SendInput via .NET |
| `mouse_move` | 移动鼠标到坐标 | 同上 |
| `keyboard_type` | 键入文本 | PowerShell: `[System.Windows.Forms.SendKeys]` 或 .NET P/Invoke `SendInput` |
| `keyboard_hotkey` | 按组合键 (Ctrl+S 等) | 同上 |

**架构设计**:
```
Agent ReAct Loop:
  1. screenshot → 获取当前屏幕图像
  2. LLM 分析图像 (vision model) → 决定点击/输入坐标
  3. mouse_click / keyboard_type → 执行操作
  4. screenshot → 验证结果
  重复...
```

**关键依赖**: LLM 必须支持 vision（图像输入）。`callLLMWithTools` 需要支持 image_url 类型的 content。

**新增模块**: `electron/engine/computer-use.ts`

**风险**: 
- 截图+视觉理解比纯文本工具慢很多（每轮多一次视觉推理）
- 坐标精度取决于分辨率和 LLM 的空间理解能力
- 需要设计安全边界（禁止操作系统级危险操作）

---

### Tier 3: v2.3 — Playwright 浏览器自动化（10 个新工具，依赖 playwright npm 包）

**目标**: Agent 能驱动真实浏览器做 E2E 测试、填表、爬取、验证 UI

| 工具 | 用途 |
|---|---|
| `browser_launch` | 启动浏览器实例（Chromium） |
| `browser_navigate` | 导航到 URL |
| `browser_screenshot` | 截取页面截图 |
| `browser_snapshot` | 获取页面可访问性快照（文本 DOM，比截图更省 token） |
| `browser_click` | 点击元素（by selector / text / coordinates） |
| `browser_type` | 在输入框输入文本 |
| `browser_evaluate` | 执行 JS 代码（可获取 DOM 数据） |
| `browser_wait` | 等待元素/文本出现 |
| `browser_network` | 查看网络请求（API 响应验证） |
| `browser_close` | 关闭浏览器 |

**实现方案**:
```
方案 A: 内嵌 Playwright（推荐）
  - pnpm add playwright-core (不含浏览器二进制)
  - 使用系统已安装的 Chrome/Edge: channel: 'msedge'
  - 在 Electron 主进程中 launch browser
  - 优点: 功能完整、稳定、业界标准
  - 缺点: 需要安装 playwright-core (~3MB)

方案 B: Puppeteer-core
  - 类似方案 A，但 API 更简单
  - 只支持 Chromium

方案 C: Electron BrowserView
  - 不引入新依赖，用 Electron 自带的 BrowserView
  - 功能有限，无法模拟完整浏览器环境
```

**推荐方案 A: playwright-core** — 与 EchoAgent 自己使用的 Playwright 工具对齐。

**新增模块**: `electron/engine/browser-tools.ts`

---

### Tier 4: v2.4 — 视觉验证 + 图像分析（3 个新工具）

**目标**: Agent 能理解截图内容、对比 UI 变化、发现视觉 Bug

| 工具 | 用途 | 实现方式 |
|---|---|---|
| `analyze_image` | 用 Vision LLM 分析图像内容 | 将图像 base64 发送到 LLM (GPT-4o/Claude vision) |
| `compare_screenshots` | 对比两张截图的差异 | 像素级 diff (纯 JS Canvas) + LLM 总结差异 |
| `visual_assert` | 断言截图中包含/不包含指定元素 | 截图 → LLM vision → JSON verdict |

**关键**: 这些工具把 Computer Use + Browser 截图真正用起来，形成闭环：
```
操作 → 截图 → 视觉验证 → 发现问题 → 修复 → 再截图 → 再验证
```

---

### Tier 5: v3.0 — 游戏引擎集成（可插拔架构）

**目标**: Agent 能操控 Unity/Unreal Editor，创建场景、放置对象、运行测试

**Unity 路线** (已有成熟开源方案):
- **Unity API Communicator** — 200+ REST endpoints，HTTP 控制 Unity Editor
  - `POST /api/gameobject/create` — 创建对象
  - `POST /api/scene/save` — 保存场景
  - `GET /api/screenshot/camera` — 截取 Camera 视图
  - 支持 MCP 协议直接对接 AI Agent
- 或自研 Unity C# 插件暴露 HTTP API

**Unreal 路线**:
- **UnrealAutomationTool (UAT)** — CLI 命令行控制构建/测试/打包
- **Remote Control API** — UE 内置 REST API (UE5+)
- **Python Editor Utility** — UE 的 Python 脚本集成

**AgentForge 架构设计**:
```
electron/engine/
  engine-bridge.ts          ← 统一接口层
  bridges/
    unity-bridge.ts         ← Unity API Communicator HTTP 调用
    unreal-bridge.ts        ← Unreal Remote Control / UAT CLI
    godot-bridge.ts         ← 未来扩展
    custom-bridge.ts        ← 用户自定义 HTTP API

工具定义:
  engine_create_object      ← 在引擎中创建对象
  engine_modify_object      ← 修改对象属性
  engine_screenshot         ← 截取引擎视图
  engine_run_play           ← 运行/暂停游戏
  engine_run_test           ← 运行引擎内测试
  engine_execute            ← 执行引擎脚本
  engine_build              ← 构建/打包项目
```

**可插拔设计**: 用户在 Settings 中选择引擎类型 + 填入连接地址，AgentForge 自动加载对应 bridge。

---

## 5. 迭代时间线

```
v2.1 [Tier 1] — 思考力 + 互联网            📅 1-2 天
  新增: think, web_search, fetch_url, todo_write, todo_read, batch_edit, http_request
  依赖: 无
  价值: Agent 能上网搜资料、能自我规划

v2.2 [Tier 2] — Computer Use 基础          📅 2-3 天
  新增: screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey
  依赖: PowerShell/.NET (Windows 内置)
  前置: callLLMWithTools 支持 vision (image content)
  价值: Agent 能看到屏幕并操作 — 黑盒测试基础能力

v2.3 [Tier 3] — 浏览器自动化                📅 2-3 天
  新增: browser_launch/navigate/screenshot/snapshot/click/type/evaluate/wait/network/close
  依赖: playwright-core (npm, ~3MB)
  价值: E2E 黑盒测试、网页爬取、UI 验证

v2.4 [Tier 4] — 视觉验证                   📅 1-2 天
  新增: analyze_image, compare_screenshots, visual_assert
  依赖: LLM vision API
  价值: 自动化 UI 回归测试、视觉 Bug 发现

v3.0 [Tier 5] — 游戏引擎集成               📅 3-5 天
  新增: engine_* 系列 (可插拔 bridge 架构)
  依赖: Unity API Communicator / Unreal Remote Control
  价值: Agent 直接操控游戏引擎编辑器
```

---

## 6. 技术风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Vision LLM 坐标理解不准 | Computer Use 点击偏移 | 使用 Accessibility Snapshot 优先于截图；降低分辨率到 1024x768 (Anthropic 推荐) |
| Playwright 浏览器实例管理 | 内存泄漏、僵尸进程 | 单例管理器 + 超时自动 close + ReAct 循环结束时强制 cleanup |
| 游戏引擎版本碎片化 | Unity/Unreal API 差异 | 可插拔 bridge + 用户自定义端点 |
| 工具数量膨胀 (17→45+) | LLM token 浪费、选择困难 | **动态工具加载**: 根据 Agent 角色/任务阶段只加载相关工具子集 |
| 截图传输占用大量 token | 成本飙升 | 压缩截图到 720p JPEG; 优先用 text snapshot; 只在必要时发图 |

---

## 7. 动态工具加载策略（关键架构决策）

工具从 17 扩展到 45+ 后，不能全部塞进每个 LLM 调用。参考 Claude Code 的 progressive disclosure：

```typescript
function getToolsForAgent(role: AgentRole, phase: TaskPhase): ToolDefinition[] {
  const base = ['think', 'task_complete', 'todo_read', 'todo_write'];
  
  switch (role) {
    case 'pm':
      return [...base, 'web_search', 'fetch_url'];
    
    case 'architect':
      return [...base, 'read_file', 'list_files', 'search_files', 'web_search', 'fetch_url', 'write_file'];
    
    case 'developer':
      return [...base, 
        'read_file', 'write_file', 'edit_file', 'batch_edit',
        'list_files', 'glob_files', 'search_files',
        'run_command', 'run_test', 'run_lint',
        'git_commit', 'git_diff',
        'web_search', 'fetch_url',
        'spawn_researcher', 'memory_read', 'memory_append',
      ];
    
    case 'qa':
      return [...base,
        'read_file', 'list_files', 'search_files',
        'run_command', 'run_test', 'run_lint',
        // Computer Use — 黑盒测试
        'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
        'analyze_image', 'compare_screenshots', 'visual_assert',
        // 浏览器 — E2E 测试
        'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
        'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
        'browser_network', 'browser_close',
      ];
    
    case 'devops':
      return [...base,
        'run_command', 'http_request',
        'git_commit', 'git_diff', 'git_log',
        'github_create_issue', 'github_list_issues',
      ];
  }
}
```

---

## 8. 与 EchoAgent 能力的最终对齐表

| 能力 | EchoAgent (我自己) | AgentForge v2.0 | AgentForge v3.0 (目标) |
|---|---|---|---|
| 文件读写编辑 | ✅ read/edit/multiedit/ls/grep | ✅ 6个工具 | ✅ +batch_edit |
| Shell 执行 | ✅ bash (PowerShell) | ✅ run_command | ✅ +后台进程 |
| 代码搜索 | ✅ code-search 5个工具 | ✅ glob_files + search_files | ✅ 不变 |
| Web 搜索 | ✅ SerpApi 并发搜索 | ❌ | ✅ Jina Search |
| Web 抓取 | ✅ read_url | ❌ | ✅ Jina Reader |
| Playwright 浏览器 | ✅ 20个完整工具 | ❌ | ✅ 10个核心工具 |
| GUI Computer Use | ✅ 14个工具 | ❌ | ✅ 5个核心工具 |
| Docker 沙箱 | ✅ 7个工具 | ❌ (子进程沙箱) | ⬜ 可选 |
| TODO/规划 | ✅ todowrite/todoread | ❌ | ✅ todo_write/todo_read |
| 思考推理 | ✅ (内置) | ❌ | ✅ think 工具 |
| 子 Agent | ✅ 10个子Agent | ✅ spawn_researcher | ✅ 不变 |
| Git/GitHub | ✅ bash git | ✅ 5个工具 | ✅ 不变 |
| 记忆系统 | ✅ agent-memory 体系 | ✅ memory_read/append | ✅ 不变 |
| HTTP 客户端 | ✅ bash curl | ❌ | ✅ http_request |
| 视觉验证 | ⬜ (可组合) | ❌ | ✅ 3个工具 |
| 游戏引擎 | ❌ | ❌ | ✅ engine_* 可插拔 |

---

## 9. 开源依赖决策

| 需求 | 方案 | 为什么 |
|---|---|---|
| Web搜索 | **Jina Search** (`s.jina.ai`) | 免费、零依赖、返回 Markdown、开源 |
| Web抓取 | **Jina Reader** (`r.jina.ai`) | 免费、零依赖、HTML→Markdown，替代自写 HTML 解析器 |
| 浏览器自动化 | **playwright-core** (npm) | 业界标准、支持 Chromium/Firefox/WebKit、Electron 官方推荐的测试工具 |
| 截图 (Windows) | **PowerShell + System.Drawing** | 零依赖、Windows 内置 |
| 键鼠操控 | **PowerShell + .NET WinForms/User32** | 零依赖、Windows 内置 |
| Unity 引擎 | **Unity API Communicator** (开源 Lite 版) | 200+ endpoints、支持 MCP、已有 AI Agent 集成 |
| Unreal 引擎 | **Remote Control API** (UE 内置) + **UAT CLI** | 官方提供、无额外依赖 |
| HTML 解析 | ❌ **不自己写** | Jina Reader 已解决，之前写的 web-tools.ts 可以删掉 |

---

## 10. 总结

AgentForge 从 v2.0 到 v3.0 的工具扩展路线：

```
v2.0 (当前)   17 工具 → 纯代码生成
v2.1 (+7)     24 工具 → 能上网、能思考、能规划
v2.2 (+5)     29 工具 → 能看屏幕、操控桌面
v2.3 (+10)    39 工具 → 能驱动浏览器、做 E2E 测试
v2.4 (+3)     42 工具 → 能做视觉验证
v3.0 (+7~10)  49~52 工具 → 能操控游戏引擎
```

配合**动态工具加载**，每个 Agent 每次调用只看到 10-20 个相关工具，不会产生 token 浪费。

**最核心的架构转变**: 从"文本世界的代码机器人"进化为"能看、能想、能操作的全栈数字员工"。
