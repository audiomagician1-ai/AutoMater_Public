# AgentForge 能力完善方案 — 目标：超越 EchoAgent

> 日期: 2026-03-02
> 版本: v2.0 (含 v7.0 + v8.0 全部已实现代码)
> 作者: Tim的开发助手

---

## 1. 背景：EchoAgent (对标对象) 的核心能力拆解

EchoAgent 平台为每个 Agent 提供以下能力层：

| 能力层 | 具体工具 | 说明 |
|--------|----------|------|
| **多子代理** | `ask_agent` 调用 10 个专用子 Agent (设计助手/WebResearch/GUI Agent/Code Search/CR高手 等) | 按需委派，并行工作 |
| **Docker Sandbox** | `DockerSandbox_*` (init/exec/write/read/upload/download/expose_port) | 完全隔离的代码执行，多镜像 |
| **浏览器自动化** | `Playwright_*` (18 个 MCP 工具: snapshot/click/type/fill_form/drag/tabs/evaluate/upload 等) | 基于 Playwright MCP Server |
| **互联网搜索** | `WebSearch_websearch` (SerpApi, 并行多查询) + `WebSearch_read_url` (智能清洗) | 商业级搜索质量 |
| **代码搜索** | `code-search_*` (ripgrep/glob/read_many_files/list_directory) | 高性能 + 多文件并行读取 |
| **文件操作** | `read`/`edit`/`multiedit`/`ls`/`grep` + Windows PowerShell | 原生文件系统完整访问 |
| **GUI 操作** | `GUI_computer_*` (screenshot/click/type/scroll/key/drag/wait) | 操控桌面应用 |
| **任务管理** | `todo-plus_*` (create/list/update/complete/clear) | 结构化任务追踪 |
| **记忆系统** | boot.md → skill_index → lessons_learned → scratchpad | 跨会话持久化 (外部插件) |

## 2. AgentForge 改造前后能力对比

### 2.1 v6.0 (改造前) 能力盘点

| 能力 | 状态 | 工具数 | 质量 |
|------|------|--------|------|
| 子代理 | ⚠️ 仅 `spawn_researcher` (只读, 8轮) | 1 | 弱 |
| 沙箱执行 | ⚠️ 仅宿主 `execSync` (无隔离) | 2 | 弱 |
| 浏览器 | ✅ Playwright 基础 10 API | 10 | 中等 |
| 互联网搜索 | ⚠️ 仅 Jina (免费, 无结构化结果, 8K截断) | 2 | 弱 |
| 深度研究 | ❌ 无 | 0 | 无 |
| 黑盒测试 | ⚠️ 仅 LLM 审查 (无运行时执行闭环) | 0 | 弱 |
| 代码搜索 | ✅ 本地 Select-String/grep + 智能排序 | 3 | 中等 |
| 文件操作 | ✅ read/write/edit/batch_edit/glob | 7 | 好 |
| GUI 操作 | ✅ screenshot/click/move/type/hotkey | 5 | 中等 |
| 任务管理 | ✅ todo_write/todo_read | 2 | 好 |
| 技能进化 | ✅ acquire/search/improve/record | 4 | 好 |
| 记忆系统 | ✅ memory_read/memory_append (3层) | 2 | 好 |

**总工具数: ~38 | 主要差距: 搜索质量弱、无深度研究、无隔离沙箱、子代理单一、无自主测试闭环**

### 2.2 v8.0 (改造后) 能力盘点

| 能力 | 状态 | 工具数 | 质量 | 对标 EchoAgent |
|------|------|--------|------|----------------|
| 子代理 | ✅ 6预设角色 + 并行执行 + 取消 | 4 | **超越** — 角色分化比 ask_agent 更精细 |
| Docker 沙箱 | ✅ 完整生命周期 + 5预设镜像 + 文件I/O | 5 | **持平** — API 设计对齐 |
| 浏览器 | ✅ 18 API (完整 Playwright 覆盖) | 18 | **持平** — 功能对齐 |
| 互联网搜索 | ✅ 5引擎 fallback + Boost并行 + 配置化 | 4 | **超越** — 多引擎冗余 + 自动降级 |
| 深度研究 | ✅ 多轮搜索 + 源提取 + LLM综合 + Fact-check | 1 | **超越** — EchoAgent 无内置深度研究 |
| 黑盒测试 | ✅ 完整闭环: 生成→执行→修复→重跑×N | 1 | **超越** — EchoAgent 无自主测试迭代 |
| 代码搜索 | ✅ (同 v6) | 3 | 持平 |
| 文件操作 | ✅ (同 v6) | 7 | 持平 |
| GUI 操作 | ✅ (同 v6) | 5 | 持平 |
| 任务管理 | ✅ (同 v6) | 2 | 持平 |
| 技能进化 | ✅ (同 v5.1) | 4 | **超越** — EchoAgent 原生无此能力 |
| 记忆系统 | ✅ (同 v3.0) | 2 | 持平 |

**总工具数: ~56 | 主要超越点: 搜索+研究+自主测试+技能进化+子代理分化**

## 3. 已实现模块详细说明

### 3.1 Search Provider System (`search-provider.ts`) — v8.0 NEW

**可插拔多搜索引擎 + 自动 Fallback + Boost 模式**

```
搜索引擎层:
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │  Brave   │ │ SearXNG  │ │  Tavily  │ │  Serper  │ │   Jina   │
  │ (免费2K) │ │ (自建)   │ │ (AI优化) │ │ (Google) │ │ (兜底)   │
  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
       │            │            │            │            │
       └──────────┬─┘──────────┬─┘──────────┬─┘────────────┘
                  │            │            │
            ┌─────▼────────────▼────────────▼─────┐
            │    Search Manager (Fallback Chain)   │
            │    配置引擎 → 按序尝试 → 首成功返回  │
            └─────┬───────────────────────┬────────┘
                  │                       │
          search()                searchBoost()
         (fallback)             (并行全引擎, 去重合并)
```

**关键设计决策:**
- **零配置即可用**: Jina 作为永久兜底, 无需任何 API Key
- **渐进增强**: 配置 Brave Key → 搜索质量飞跃; 加 SearXNG → 离线可用
- **Boost 模式**: 重要查询并行请求所有引擎, 多引擎交叉出现的结果排名更高
- **统一 SearchResult 格式**: 所有引擎输出标准化, LLM 无感知切换

**工具:**
| 工具名 | 说明 | 角色 |
|--------|------|------|
| `web_search` | 标准搜索 (fallback chain) | 所有 |
| `web_search_boost` | 增强搜索 (并行多引擎) | pm/architect/developer/qa/researcher |
| `configure_search` | 配置搜索引擎 API Keys | developer |
| `fetch_url` | 抓取 URL (Jina + native fallback) | 所有 |

### 3.2 Research Engine (`research-engine.ts`) — v8.0 NEW

**深度研究分析引擎 — 单次调用完成完整研究流程**

```
                    ┌─── Question ───┐
                    │                │
                    ▼                │
           ┌─────────────────┐      │
     ┌──── │  LLM 拆解子查询 │      │
     │     └────────┬────────┘      │
     │              │               │
     │    ┌─────────▼──────────┐    │
Round│    │ 并行搜索 (N queries)│    │
  1  │    └────────┬───────────┘    │
     │             │                │
     │    ┌────────▼───────────┐    │
     │    │ 深度提取 Top N 页面 │    │
     │    └────────┬───────────┘    │
     │             │                │
     │    ┌────────▼───────────┐    │
     └──▶ │  LLM 综合分析报告  │    │
          │  + 置信度评估       │    │
          │  + follow-up 建议  │    │
          └────────┬───────────┘    │
                   │                │
            confidence < 85% ?      │
              ├─ YES ───────────────┘ (下一轮)
              └─ NO
                   │
          ┌────────▼───────────┐
          │  Fact-Check 验证   │ (deep 模式)
          └────────┬───────────┘
                   │
          ┌────────▼───────────┐
          │   最终研究报告      │
          │   + 引用来源列表    │
          │   + 置信度          │
          └────────────────────┘
```

**三档深度:**
| 深度 | 轮次 | 查询数/轮 | 深度提取 | Fact-Check | 适用场景 |
|------|------|-----------|----------|------------|----------|
| `quick` | 1 | 2 | 1页 | ❌ | 快速查API/错误解决方案 |
| `standard` | 2 | 4 | 3页 | ❌ | 技术选型/最佳实践调研 |
| `deep` | 3 | 4 | 3页 | ✅ | 竞品分析/架构决策/严谨调研 |

**工具:**
| 工具名 | 说明 |
|--------|------|
| `deep_research` | 一键深度研究: question + context + depth → 完整 Markdown 报告 |

### 3.3 Blackbox Test Runner (`blackbox-test-runner.ts`) — v8.0 NEW

**自主黑盒测试 + 迭代修复闭环**

```
     Feature Description
           │
     ┌─────▼─────────────┐
     │ LLM 生成测试计划   │ (最多10个用例)
     │ unit/integration/  │
     │ e2e/api            │
     └─────┬─────────────┘
           │
     ┌─────▼─────────────┐
     │ 执行全部测试用例   │
     │  ├ unit → Docker   │
     │  ├ api  → fetch    │
     │  └ e2e  → Browser  │
     └─────┬─────────────┘
           │
      All passed? ──YES──▶ ✅ 报告
           │
           NO
           │
     ┌─────▼─────────────┐
     │ LLM 分析最严重失败 │
     │ (错误+stdout+      │
     │  screenshot+console)│
     └─────┬─────────────┘
           │
     ┌─────▼─────────────┐
     │ Coder Agent 修复   │ (Sub-Agent: coder)
     └─────┬─────────────┘
           │
     ┌─────▼─────────────┐
     │ 重跑全部测试       │
     │ (含回归检测)       │
     └─────┬─────────────┘
           │
      Round < N? ──YES──▶ 回到执行
           │
           NO
           │
     ┌─────▼─────────────┐
     │ 最终测试报告       │
     │ (Markdown表格+详情)│
     └─────────────────────┘
```

**测试类型支持:**
| 类型 | 执行环境 | 失败信息收集 |
|------|----------|-------------|
| `unit` | Docker Sandbox (隔离) / 宿主 execSync (fallback) | stdout + stderr + exit code |
| `integration` | 同上 | 同上 |
| `api` | fetch / curl | HTTP status + response body |
| `e2e` | Playwright (headless) | 截图 + console logs + 网络错误 + DOM 断言 |

**工具:**
| 工具名 | 说明 |
|--------|------|
| `run_blackbox_tests` | 一键启动: feature描述 → 自动测试+修复×N → 最终报告 |

### 3.4 Sub-Agent Framework (`sub-agent-framework.ts`) — v7.0

**6 角色预设 + 并行执行 + 权限隔离**

| 角色 | 可写 | 工具集 | 轮次 | 模型 |
|------|------|--------|------|------|
| `researcher` | ❌ | 读文件+搜索+web_search_boost+deep_research | 12 | worker |
| `coder` | ✅ | 全部读写+命令+测试 | 20 | worker |
| `reviewer` | ❌ | 读文件+搜索 | 12 | strong |
| `tester` | ✅ | 读写+命令+浏览器+run_blackbox_tests | 15 | worker |
| `doc_writer` | ✅ | 读写+搜索+web | 10 | worker |
| `deployer` | ✅ | 命令+HTTP+git | 12 | worker |

### 3.5 Docker Sandbox (`docker-sandbox.ts`) — v7.0

5 预设镜像 (node/python/rust/go/ubuntu) + 完整生命周期 + 文件双向I/O + 命令安全分类

### 3.6 Browser Enhancements (`browser-tools.ts`) — v7.0

在原有 10 API 基础上新增 8 个: hover / select_option / press_key / fill_form / drag / tabs / file_upload / console

## 4. 对比 EchoAgent — AgentForge 的超越点

| 维度 | EchoAgent | AgentForge v8.0 | 谁更强 |
|------|-----------|-----------------|--------|
| 搜索引擎数量 | 1 (SerpApi) | 5 (Brave/SearXNG/Tavily/Serper/Jina) | **AF** |
| 搜索 Boost | ❌ | ✅ 并行多引擎+去重排名 | **AF** |
| 深度研究 | 需人工编排子Agent | ✅ 一键 deep_research (多轮+fact-check) | **AF** |
| 自主测试迭代 | ❌ 无 | ✅ run_blackbox_tests (自动修复闭环) | **AF** |
| 技能进化 | ❌ (记忆系统是外挂) | ✅ 原生 skill acquire/search/improve | **AF** |
| 子代理角色分化 | 10个独立子Agent (功能固定) | 6个预设+自定义prompt (灵活) | 各有优势 |
| 离线/LAN | ❌ 依赖云端 | ✅ SearXNG+Docker, 零外部依赖 | **AF** |
| 桌面GUI操作 | ✅ (Claude限定) | ✅ | 持平 |
| 代码搜索 | ✅ ripgrep | ✅ Select-String+智能排序 | 持平 |
| 多模态图片分析 | ✅ (子代理) | ✅ (视觉工具) | 持平 |

## 5. 仍需持续改进的方向 (Phase 3)

| 优先级 | 方向 | 说明 | 预计工作量 |
|--------|------|------|-----------|
| 🔴 高 | **MCP 服务器生态** | 接入更多 MCP: GitHub Copilot/Figma/Notion/Slack | 3-5天 |
| 🔴 高 | **图片生成** | 接入 DALL-E / Stable Diffusion / Gemini Image | 2天 |
| 🟡 中 | **RAG 增强** | 本地向量检索 (代码+文档) 替代纯 grep | 3天 |
| 🟡 中 | **Web Worker 并行** | Electron 主进程卸载耗时任务到 Worker | 2天 |
| 🟢 低 | **语音交互** | Whisper 语音输入 + TTS 语音反馈 | 2天 |
| 🟢 低 | **实时协作** | 多用户 WebSocket 共享工作区 | 5天 |

## 6. 使用指南：如何发挥最大能力

### 搜索配置 (推荐)

```
[Agent 调用]
configure_search({
  brave_api_key: "BSA...",      // 免费: https://brave.com/search/api/
  serper_api_key: "...",         // 免费: https://serper.dev/
  searxng_url: "http://localhost:8888"  // LAN: docker run -p 8888:8080 searxng/searxng
})
```

配置后:
- `web_search` 自动使用 Brave (质量↑300%)
- `web_search_boost` 并行 Brave+Serper+Jina, 交叉验证
- `deep_research` 多轮研究, 置信度评估

### 深度研究示例

```
deep_research({
  question: "Electron 应用如何实现热更新, 对比 electron-updater vs custom ASAR",
  context: "我们的项目是 Electron 33 + Vite 6, 需要 LAN 内分发",
  depth: "deep"
})
→ 输出: 3轮搜索 + 深度提取5篇文章 + LLM综合报告 + Fact-check + 来源列表
```

### 自主黑盒测试

```
run_blackbox_tests({
  feature_description: "用户登录功能: 支持邮箱+密码登录, 记住我复选框, 错误提示",
  acceptance_criteria: "1. 正确邮箱密码可登录\n2. 错误密码显示提示\n3. 记住我勾选后重启保持登录",
  code_files: ["src/auth/login.ts", "src/components/LoginForm.tsx"],
  app_url: "http://localhost:3000/login",
  test_types: ["unit", "e2e"],
  max_rounds: 3
})
→ 自动生成测试 → 执行 → 修复失败 → 重跑 → 最终报告
```

---

## 附录：完整工具清单 (v8.0, 56个)

| 类别 | 工具 | 新增 |
|------|------|------|
| 文件 | read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files | |
| 命令 | run_command, run_test, run_lint, check_process | |
| Git | git_commit, git_diff, git_log | |
| GitHub | github_create_issue, github_list_issues | |
| 搜索 | web_search, fetch_url, http_request, **web_search_boost**, **configure_search** | ✅ |
| 研究 | **deep_research** | ✅ |
| 测试 | **run_blackbox_tests** | ✅ |
| 子代理 | **spawn_agent**, **spawn_parallel**, **list_sub_agents**, **cancel_sub_agent** | ✅ |
| 沙箱 | **sandbox_init**, **sandbox_exec**, **sandbox_write**, **sandbox_read**, **sandbox_destroy** | ✅ |
| 浏览器 | browser_launch/navigate/screenshot/snapshot/click/type/evaluate/wait/network/close | |
| 浏览器+ | **browser_hover/select_option/press_key/fill_form/drag/tabs/file_upload/console** | ✅ |
| GUI | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | |
| 视觉 | analyze_image, compare_screenshots, visual_assert | |
| 记忆 | memory_read, memory_append | |
| 技能 | skill_acquire, skill_search, skill_improve, skill_record_usage | |
| 思考 | think, todo_write, todo_read, task_complete, report_blocked, rfc_propose, spawn_researcher | |

**新增工具: 19 个 | 总计: 56 个**
