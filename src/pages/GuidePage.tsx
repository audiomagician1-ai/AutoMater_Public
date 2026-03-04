/**
 * GuidePage — 内置教程文档中心
 *
 * 面向非程序员的全面使用指南，覆盖：
 * 1. 快速上手           2. 设计理念与架构
 * 3. 工具能力全景       4. 导入已有项目
 * 5. LLM 配置           6. 许愿与管家对话
 * 7. 团队与工作流       8. 管家详解
 * 9. GitHub 配置       10. MCP 扩展
 * 11. 产出与版本管理   12. 监控与调试
 * 13. 快捷键与技巧     14. 常见问题
 *
 * v29.0: 大幅增强 — 新增设计理念、工具全景、管家详解、监控调试、快捷键章节
 */

import { useState } from 'react';

// ═══════════════════════════════════════
// Guide data
// ═══════════════════════════════════════

interface GuideSection {
  id: string;
  icon: string;
  title: string;
  content: string; // Markdown-ish
  difficulty: '入门' | '基础' | '进阶';
  diffColor: string;
}

const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'quickstart',
    icon: '🚀',
    title: '快速上手',
    difficulty: '入门',
    diffColor: 'bg-emerald-500/20 text-emerald-400',
    content: `## 欢迎使用智械母机 AutoMater！

AutoMater 是一个 **AI 驱动的软件开发工具**。你只需要用自然语言描述你想要的软件，一支虚拟 Agent 团队就会自动帮你完成开发。

### 三步上手

**第一步 — 配置 LLM（必须）**
点击左侧栏底部的 ⚙️ 设置按钮，填入你的 AI 模型密钥（API Key）。如果你不知道怎么获取，请参考「LLM 配置指南」。

**第二步 — 创建项目**
回到项目列表页，点击「＋ 新建项目」，输入项目名即可。或者点击「📥 导入已有项目」导入现有代码。

**第三步 — 许愿**
进入项目后，在「✨ 许愿」页面用自然语言描述你想要什么。例如：
- "帮我做一个待办事项 App，支持添加、删除、标记完成"
- "做一个个人博客网站，要有暗色主题"
- "给现有项目添加用户登录功能"

然后点击「🚀 启动开发」，Agent 团队就会开始工作！

### 界面导览

| 页面 | 用途 |
|------|------|
| 🗺️ 全景 | 总控制台，查看项目进度和架构 |
| ✨ 许愿 | 输入需求，和管家对话（支持 4 种模式） |
| 📋 看板 | Feature 任务看板，拖拽调整优先级 |
| 📄 文档 | 自动生成的设计文档（支持版本历史） |
| 🔄 工作流 | Agent 工作流水线预设和自定义 |
| 👥 团队 | 查看和配置各 Agent（支持动态添加成员） |
| 📦 产出 | 查看生成的源代码（含搜索 Ctrl+P/Ctrl+Shift+F） |
| 🔀 版本 | Git 版本管理（diff/回退/手动提交） |
| 📜 日志 | 实时运行日志 |
| 🧠 上下文 | Agent 信息量和 Token 使用分析 |
| ⏱️ 时间线 | 事件重放和历史回溯 |
| 📼 会话 | Agent 会话记录浏览 |
| 📖 教程 | 本教程中心 |

> 💡 **提示**：不确定的地方都可以保持默认，AutoMater 会自动处理大部分配置。`,
  },
  {
    id: 'architecture',
    icon: '🏗️',
    title: '设计理念与架构',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## AutoMater 是怎么工作的？

理解 AutoMater 的设计理念，能帮助你更好地使用它。

### 核心理念：模拟真实软件公司

AutoMater 不是一个"代码生成器"，而是一个**虚拟软件公司**。它模拟了真实团队的协作模式：

| 真实公司 | AutoMater |
|---------|-----------|
| 产品经理收集需求 | PM Agent 分析需求、拆分 Feature |
| 架构师设计方案 | Architect Agent 技术选型、写设计文档 |
| 多个开发者并行编码 | Developer Agent(s) 并行领取 Feature |
| QA 审查代码质量 | QA Agent 代码审查、运行测试 |
| 运维部署上线 | DevOps Agent 构建验证、生成部署配置 |
| 老板/管理层协调 | 元Agent管家（就是我！）调度全局 |

### ReAct 循环引擎

每个 Agent 执行任务时，运行一个**ReAct 循环**：

1. **Think** — 分析当前状态，决定下一步行动
2. **Act** — 调用工具（读文件、写代码、运行命令等）
3. **Observe** — 查看工具返回的结果
4. **Repeat** — 根据结果继续迭代，直到任务完成

这不是简单的"一次性生成"，而是 Agent 像人类开发者一样**边做边调整**。循环次数可配置（默认 50 轮），确保复杂任务也能完成。

### 工具驱动

Agent 的能力来自**工具**。系统内置了 **130 个工具**（详见「工具能力全景」章节），涵盖：
- 文件读写和代码搜索
- Shell 命令和测试运行
- Git 版本控制和 GitHub 集成
- 浏览器自动化和 UI 测试
- 网络搜索和深度调研
- Docker sandbox 隔离执行
- 部署配置（Supabase/Cloudflare/Docker/PM2）

每个 Agent 只能使用与其角色匹配的工具子集（**最小权限原则**），防止越权操作。

### 分层记忆系统

AutoMater 有多层记忆来保持上下文连贯：

| 层次 | 作用域 | 持久性 | 说明 |
|------|--------|--------|------|
| 会话上下文 | 单次对话 | 临时 | 最近 N 条消息，每次对话自动带入 |
| 项目记忆 | 单个项目 | 持久 | Agent 工作中积累的项目经验（.automater/ 目录） |
| 管家记忆 | 按项目隔离 | 持久 | 管家对话中自动/手动保存的重要信息 |
| 技能库 | 跨项目 | 持久 | Agent 积累的可复用代码片段和经验 |

### Session-Agent 调度

系统的并发能力基于 Session 机制：
- 每个 Agent 工作实例 = 一个 Session
- 多个 Developer 可以**并行**工作在不同 Feature 上
- Session 生命周期: created → running → suspended → completed/failed
- 支持动态添加 Agent（团队页面添加 developer → 自动领取任务）

> 💡 **提示**：你不需要理解所有底层机制。了解"多Agent协作+ReAct循环"的基本概念就够了。`,
  },
  {
    id: 'tools-overview',
    icon: '🔧',
    title: '工具能力全景',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 130 个内置工具

AutoMater 的 Agent 通过工具与外部世界交互。以下是完整的工具分类：

### 🗂️ 文件系统（12 个）

| 工具 | 作用 |
|------|------|
| read_file | 读取文件内容（支持指定行范围） |
| write_file | 创建或覆盖文件 |
| edit_file | 精确替换文件中的指定内容 |
| batch_edit | 批量编辑多个文件 |
| list_files | 列出目录内容 |
| glob_files | 按模式匹配搜索文件路径 |
| search_files | 在文件内容中搜索文本 |
| code_search | 高性能代码搜索（基于 ripgrep） |
| code_search_files | 搜索文件名 |
| read_many_files | 批量读取多个文件 |
| repo_map | 生成项目结构概览 |
| code_graph_query | 查询模块间依赖和调用关系 |

### 🐚 Shell（5 个）

| 工具 | 作用 |
|------|------|
| run_command | 执行任意 Shell 命令 |
| run_test | 运行测试套件 |
| run_lint | 运行代码检查工具 |
| check_process | 检查后台进程状态 |
| wait_for_process | 等待进程完成 |

### 🌿 Git 与 GitHub（19 个）

**本地 Git**: git_commit, git_diff, git_log, git_create_branch, git_switch_branch, git_list_branches, git_delete_branch, git_pull, git_push, git_fetch

**GitHub**: github_create_issue, github_list_issues, github_close_issue, github_add_comment, github_get_issue, github_create_pr, github_list_prs, github_get_pr, github_merge_pr

### 🌐 网络与搜索（8 个）

| 工具 | 作用 |
|------|------|
| web_search | 网页搜索 |
| web_search_boost | 增强搜索（多引擎聚合） |
| deep_research | 深度调研（多轮自动搜索+总结） |
| fetch_url | 获取网页内容 |
| http_request | 发送 HTTP 请求（GET/POST/PUT 等） |
| download_file | 下载文件到本地 |
| search_images | 搜索图片 |
| configure_search | 配置搜索引擎参数 |

### 🖥️ Computer Use（26 个）

基于 Playwright 的完整浏览器控制和 GUI 操作：

**桌面操作**: screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey

**浏览器**: browser_launch, browser_navigate, browser_screenshot, browser_snapshot, browser_click, browser_type, browser_evaluate, browser_wait, browser_network, browser_close, browser_hover, browser_select_option, browser_press_key, browser_fill_form, browser_drag, browser_tabs, browser_file_upload, browser_console

**视觉**: analyze_image, compare_screenshots, visual_assert

### 🤖 Agent 协作（14 个）

| 工具 | 作用 |
|------|------|
| spawn_agent | 创建子 Agent 执行子任务 |
| spawn_parallel | 并行创建多个子 Agent |
| list_sub_agents | 查看子 Agent 状态 |
| cancel_sub_agent | 取消子 Agent |
| skill_acquire/search/improve/record_usage | 技能库管理 |
| sandbox_init/exec/write/read/destroy | Docker sandbox 隔离环境 |
| run_blackbox_tests | 在 sandbox 中运行黑盒测试 |

### ☁️ 部署与基础设施（23 个）

**图片**: generate_image, edit_image, configure_image_gen

**容器/进程**: deploy_dockerfile_generate, deploy_compose_generate, deploy_compose_down, deploy_pm2_start, deploy_pm2_status, deploy_nginx_generate, deploy_find_port

**Supabase**: supabase_status, supabase_migration_create, supabase_migration_push, supabase_db_pull, supabase_deploy_function, supabase_gen_types, supabase_set_secret

**Cloudflare**: cloudflare_deploy_pages, cloudflare_deploy_worker, cloudflare_set_secret, cloudflare_dns_list, cloudflare_dns_create, cloudflare_status

### 🧠 协调与记忆（12 个）

think, task_complete, memory_read, memory_append, todo_write, todo_read, scratchpad_write, scratchpad_read, spawn_researcher, report_blocked, rfc_propose, create_wish

### 各角色能使用的工具数

| 角色 | 工具数 | 说明 |
|------|--------|------|
| 开发者 | 108 | 拥有最全的工具集，几乎可以做任何事 |
| DevOps | 80 | 侧重部署、构建、基础设施管理 |
| QA | 65 | 侧重测试、浏览器自动化、截图对比 |
| 架构师 | 31 | 侧重设计文档编写、搜索调研 |
| PM | 30 | 侧重需求分析、搜索、图片生成 |
| 管家 | 33 | 读代码+搜索+管理团队+需求派发 |
| 研究员 | 16 | 仅搜索和读取（由 spawn_researcher 创建） |

> 💡 **设计原则**：每个角色只获得完成其职责所需的最少工具（最小权限原则），防止 Agent 越权操作。`,
  },
  {
    id: 'import-project',
    icon: '📥',
    title: '导入已有项目',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 把现有代码交给 Agent 团队

如果你已经有一个代码项目，可以将它导入 AutoMater。Agent 团队会自动深度分析项目结构，生成架构文档，然后就能基于现有代码继续开发。

### 适用场景

- 🔧 想给现有项目**添加新功能**
- 📖 接手了别人的代码，想**快速理解架构**
- 🏗️ 项目越来越复杂，想让 AI **辅助重构**
- 📝 缺少文档，想**自动生成架构文档**

### 导入步骤

1. 在项目列表页点击「📥 导入已有项目」
2. 选择代码项目根目录（包含 package.json 等配置文件的目录）
3. 点击「开始导入分析」，系统自动执行三阶段分析

### 三阶段分析（设计说明）

导入分析采用**多探针并行探索**架构，这是因为大型项目不可能靠单次 LLM 调用理解全貌。

| 阶段 | 耗时 | 做什么 | 为什么这样设计 |
|------|------|--------|----------------|
| Phase 0: 骨架扫描 | ~1-2 秒 | 目录结构、技术栈检测、代码依赖图 | 零成本的本地分析，为后续探针提供导航地图 |
| Phase 1: 并行探测 | ~30秒-3分钟 | 多个 AI 探针从不同角度分析项目 | 并行 = 快速；多角度 = 覆盖面广 |
| Phase 2: 拼图合成 | ~10-30 秒 | 用强模型综合所有探针报告 | 各探针只看到局部，合成阶段产生全局理解 |

### 六类探针

| 探针 | 分析内容 |
|------|----------|
| 🚪 入口追踪 | 从 main/index 出发追踪"系统怎么跑起来的" |
| 📦 模块纵深 | 核心模块的职责、接口和数据结构 |
| 🌐 API 边界 | 对外接口、路由、IPC handler |
| 💾 数据模型 | Schema、数据库模型、核心类型 |
| ⚙️ 配置基础设施 | 配置文件、中间件、构建管道 |
| 🔍 异常检测 | TODO/HACK、超大文件、循环依赖 |

### 导入产出

- **ARCHITECTURE.md** — 系统架构文档（含函数名和类型名，不是空话）
- **module-graph.json** — 结构化模块关系图
- **KNOWN-ISSUES.md** — 技术债和风险清单
- **skeleton.json** — 项目骨架（技术栈、模块列表、入口文件）
- **探针报告** — 每个探针的详细记录（.automater/analysis/probes/）

所有文件存放在 \`.automater/\` 目录，不影响源代码。

### 费用参考

| 项目规模 | 探针数 | 时间 | 费用 |
|---------|--------|------|------|
| ~500 文件 | ~10 | 1-2 分钟 | $0.10-0.20 |
| ~1000 文件 | ~20 | 2-4 分钟 | $0.20-0.40 |
| 3000+ 文件 | ~35 | 4-8 分钟 | $0.50-1.00 |

> 💡 探针使用便宜的快速模型，仅合成阶段使用强模型。有预算保护（默认 $1.00）。

> ⚠️ 导入不会修改你的任何源文件。不满意可直接删除 \`.automater/\` 重新导入。`,
  },
  {
    id: 'llm-setup',
    icon: '🔑',
    title: 'LLM 配置指南',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 什么是 LLM？

LLM（大语言模型）是 AutoMater 的"大脑"。所有 Agent 都通过 LLM 来理解任务和生成代码。

### 三种模型角色

AutoMater 支持为不同场景配置不同模型：

| 角色 | 用途 | 推荐 |
|------|------|------|
| 强模型 (Strong) | 管家对话、架构设计、复杂决策 | Claude Sonnet / GPT-4o |
| 工作模型 (Worker) | 日常开发、代码编写 | Claude Sonnet / GPT-4o |
| 快速模型 (Fast) | 探针扫描、简单分类、摘要 | GPT-4o-mini / Claude Haiku |

没配置的角色会自动降级到已配置的模型。

### 获取 API Key

**方式一：OpenAI**
1. 打开 [platform.openai.com](https://platform.openai.com)
2. 注册 → API Keys → Create new secret key
3. 复制密钥（以 \`sk-\` 开头）

**方式二：Anthropic Claude**
1. 打开 [console.anthropic.com](https://console.anthropic.com)
2. 注册 → API Keys → 创建密钥

**方式三：兼容服务（DeepSeek/通义千问/本地模型等）**
需要额外填写 API 地址（Base URL），指向兼容 OpenAI 格式的服务端点。

### 配置步骤

1. 点击左下角 ⚙️ 进入设置
2. 填写 API Key
3. 如使用非 OpenAI 服务，填写 API 地址
4. 选择模型名称（可分别设置强/工作/快速模型）
5. 保存

### 费用说明

- 一个中等复杂度的项目约花费 $0.5 - $5
- 在全景页面可实时查看费用
- 使用快速模型做探针/简单任务可大幅降低费用

> ⚠️ API Key 是私人凭证，AutoMater 安全存储在本地数据库中，不会上传到任何服务器。`,
  },
  {
    id: 'wish-guide',
    icon: '✨',
    title: '许愿与管家对话',
    difficulty: '入门',
    diffColor: 'bg-emerald-500/20 text-emerald-400',
    content: `## 许愿页——你和 AI 团队沟通的入口

许愿页是你与管家交互的主要界面，也是向团队下达需求的地方。

### 四种对话模式（设计说明）

不同的场景需要管家扮演不同角色，因此设计了四种模式：

| 模式 | 图标 | 管家角色 | 管家能用的工具 | 适合场景 |
|------|------|----------|---------------|----------|
| 工作 | 🔧 | 指挥调度 | 读文件+搜索+create_wish | 正式提需求，管家派发给团队 |
| 闲聊 | 💬 | 朋友 | 仅搜索 | 技术讨论、头脑风暴、产品咨询 |
| 深度 | 🔬 | 资深工程师 | 读写文件+搜索+create_wish | 代码分析、架构审查、报告输出 |
| 管理 | 🛠️ | CTO | admin_* 工具 | 管理团队成员、工作流、项目配置 |

**为什么要区分模式？**
- **闲聊模式**不加载项目记忆和上下文，回复更轻量
- **工作模式**的回复是 JSON 格式（含意图识别），方便自动触发 create_wish
- **深度模式**给管家完整的文件读写权限，可以亲自分析代码
- **管理模式**给管家 admin 工具，可以直接修改项目配置

### 模式切换

- 点击对话区顶部的模式标签即可切换
- **已有对话也可以切换模式**——会立即生效于下一条消息
- 在会话列表中右键也可以切换

### 如何写好需求

✅ **好的需求**：
- "做一个待办事项 App，React+TS，支持添加/删除/标记完成，深色主题"
- "给现有项目的用户模块添加邮箱验证功能"

❌ **不太好的需求**：
- "做个 App"（太模糊）
- "做一个像 Photoshop 一样的图片编辑器"（太复杂，建议拆分）

### 迭代开发

不必一次做完！推荐的节奏：
1. 先许一个小需求，等完成后查看结果
2. 在深度模式下让管家分析代码质量
3. 继续许愿添加新功能或修复问题
4. 在管理模式下调整团队配置（如增加 Developer 提速）`,
  },
  {
    id: 'team-guide',
    icon: '👥',
    title: '团队与工作流',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 虚拟软件团队

每个项目配有一支 Agent 团队，各司其职：

| 角色 | 工具数 | 核心能力 |
|------|--------|----------|
| 👔 PM | 30 | 需求分析、Feature拆分、搜索调研、阻塞上报 |
| 🏗️ 架构师 | 31 | 系统设计、技术选型、RFC提案、设计文档 |
| 💻 开发者 | 108 | 全栈编码、测试、浏览器自动化、部署、子Agent |
| 🔍 QA | 65 | 代码审查、运行测试、截图对比、视觉验证 |
| 🚀 DevOps | 80 | 构建验证、Docker/PM2、Supabase、Cloudflare |

### 工作流预设

| 预设 | 阶段数 | 适合场景 |
|------|--------|----------|
| 完整开发 | 9 | 新项目从零开始 |
| 快速迭代 | 5 | 小功能、紧急修复 |
| 质量加固 | 6 | 已有代码的质量提升 |

你可以在「🔄 工作流」页面自定义——添加/移除/重排阶段。

### 动态添加成员

在「👥 团队」页面添加新的 developer 角色成员：
- 如果项目正在开发阶段，新成员会**自动热加入**
- 多个 Developer 可以**并行**开发不同 Feature
- 每个 Agent 可以单独配置模型、提示词、上下文限制

### Agent 自定义

每个 Agent 卡片可编辑：
- **系统提示词** — 控制 Agent 的行为风格和专长
- **AI 模型** — 可为不同 Agent 选择不同模型
- **上下文限制** — 控制每次对话的 Token 预算
- **MCP 服务器** — 为特定 Agent 添加外部工具
- **技能** — 查看 Agent 积累的可复用经验

> 💡 通常不需要修改 Agent 配置。默认配置已经过优化。高级用户可以通过管家的「管理模式」用对话方式调整。`,
  },
  {
    id: 'meta-agent',
    icon: '🤖',
    title: '管家（元Agent）详解',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 管家是谁？

管家是你与 AutoMater 系统之间的**总入口**。它不是简单的聊天机器人，而是一个拥有 33 个工具的智能调度中心。

### 管家的能力

**读取能力**: read_file, list_files, search_files, glob_files, code_search, code_search_files, read_many_files, repo_map, code_graph_query

**搜索能力**: web_search, fetch_url, web_search_boost, deep_research, download_file, search_images

**写入能力**（深度模式）: write_file, edit_file, batch_edit

**管理能力**（管理模式）: admin_list_members, admin_add_member, admin_update_member, admin_remove_member, admin_list_workflows, admin_activate_workflow, admin_update_workflow, admin_update_project, admin_get_available_stages

**调度能力**: create_wish（将需求派发给团队）

**记忆能力**: memory_read, memory_append（跨会话记忆）

**协作能力**: list_conversation_sessions, read_conversation_history（浏览团队对话）

### 管家记忆系统

管家有一个持久化的记忆系统，能跨会话记住重要信息：

- **自动记忆**: 工作模式下，管家会自动提取值得记住的信息
- **手动管理**: 在管家设置 → 记忆管理 Tab，可以查看/编辑/删除所有记忆
- **项目隔离**: 每条记忆绑定到产生它的项目，不会跨项目泄漏
- **全局记忆**: project_id 为空的记忆会在所有项目中可见

### 管家设置

点击许愿页右上角的 ⚙️ 齿轮进入管家设置：

| Tab | 内容 |
|-----|------|
| 基本设置 | 名字、称呼、性格、系统提示词、上下文配置 |
| 模式配置 | 各模式的独立参数（循环次数/Token限制/历史条数） |
| 记忆管理 | 浏览/搜索/新增/编辑/删除记忆 |
| 守护进程 | 定时心跳、事件钩子（Feature失败/项目完成通知）  |

> 💡 管家是你的"AI 助手的助手"——遇到任何关于 AutoMater 使用的问题，都可以直接问管家。`,
  },
  {
    id: 'github-setup',
    icon: '🐙',
    title: 'GitHub 配置（可选）',
    difficulty: '进阶',
    diffColor: 'bg-amber-500/20 text-amber-400',
    content: `## 代码同步到 GitHub

配置 GitHub 后，AutoMater 生成的代码会自动同步到你的 GitHub 仓库。**不需要也完全可以使用，默认用本地 Git。**

### 配置步骤

1. 在 GitHub 创建一个**空仓库**（不要勾选 README）
2. 生成 Personal Access Token: Settings → Developer settings → Personal access tokens → 勾选 \`repo\` 权限
3. 创建项目时选择「🐙 GitHub」模式
4. 填入 \`用户名/仓库名\` 和 Token
5. 点击「🔌 测试连接」确认

> 💡 Token 以 \`ghp_\` 开头。丢失需重新生成。`,
  },
  {
    id: 'mcp-setup',
    icon: '🔌',
    title: 'MCP 工具扩展（可选）',
    difficulty: '进阶',
    diffColor: 'bg-amber-500/20 text-amber-400',
    content: `## 用 MCP 扩展 Agent 能力

MCP（Model Context Protocol）是一种标准协议，让 Agent 获得额外能力。

**AutoMater 已内置 130 个工具，一般不需要额外配置。** MCP 适合有特殊需求的高级用户。

### 何时需要 MCP？

- 连接特定数据库或内部 API
- 使用特定的搜索引擎
- 集成公司内部工具链
- 让 Agent 操作第三方 SaaS 服务

### 配置方法

1. 进入 ⚙️ 设置 → MCP 服务器
2. 点击「添加服务器」
3. 填写名称、启动命令、参数

MCP 可以配置给**特定 Agent**（在团队页面编辑 Agent → MCP 配置），也可以设为全局。

> 💡 MCP 需要 Node.js 环境。不确定就先跳过。`,
  },
  {
    id: 'output-git',
    icon: '📦',
    title: '产出与版本管理',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 查看和管理 Agent 的产出

### 📦 产出页

- 左侧文件树，点击预览代码（语法高亮）
- **Ctrl+P**: 文件名搜索
- **Ctrl+Shift+F**: 文件内容搜索
- 右键文件: 查看历史版本、回退、在文件管理器中打开
- 顶部「📂 打开文件夹」和「📦 导出 zip」

### 🔀 版本页

AutoMater 每个开发阶段完成后自动 git commit，你可以：

- **查看提交历史**: 左侧时间线，点击查看 diff
- **查看未提交改动**: "工作区变更"项，彩色 diff 预览
- **手动提交**: 顶部快速提交区（Ctrl+Enter）
- **文件版本历史**: 📜 按钮 → 弹窗展示完整历史，可回退

### 📄 文档页

自动生成的设计文档：
- 总览设计: 系统整体架构
- 系统级设计: 模块划分和接口定义
- 功能级设计: 每个 Feature 的详细方案
- 需求文档和测试规格

支持版本历史和回退。

> 💡 你可以随时用自己的编辑器修改产出目录中的文件，但 Agent 运行时可能覆盖。建议在暂停状态下手动编辑。`,
  },
  {
    id: 'monitoring',
    icon: '📊',
    title: '监控与调试',
    difficulty: '进阶',
    diffColor: 'bg-amber-500/20 text-amber-400',
    content: `## 了解系统状态

### 🗺️ 全景页

- **Agent 工作图谱**: 可视化展示各 Agent 的协作关系和当前状态
- **Feature 进度条**: 每个功能的开发进度
- **Token/费用图表**: 实时累计消耗
- **系统资源**: CPU/内存/GPU 使用率
- **控制按钮**: 启动/暂停/停止

### 🧠 上下文页

查看每个 Agent 当前的信息构成：
- 系统提示词占多少 Token
- 历史消息占多少
- 工具定义占多少
- 距离上下文窗口上限还有多少空间

### ⏱️ 时间线

事件重放，查看开发过程中的所有关键事件（Agent启动/工具调用/Feature状态变更等）。

### 📼 会话页

查看所有 Agent 的 Session：
- Session 状态（running/completed/failed）
- 关联的 Feature
- Token 使用和费用
- 可查看 Session 备份

### 📜 日志

实时滚动日志流，支持按 Agent 过滤。

### 常见调试技巧

| 现象 | 可能原因 | 解决方法 |
|------|---------|----------|
| Feature 卡在 developing | Agent 陷入循环 | 看日志确认，可暂停后重启 |
| 费用突增 | Agent 大量调用工具 | 在上下文页检查 Token 使用 |
| 代码质量差 | 模型能力不足或提示词不当 | 换更强模型或在团队页调整提示词 |
| 导入分析不准 | 项目太大或结构特殊 | 删除 .automater/ 重试，提高预算 |`,
  },
  {
    id: 'shortcuts',
    icon: '⌨️',
    title: '快捷键与技巧',
    difficulty: '入门',
    diffColor: 'bg-emerald-500/20 text-emerald-400',
    content: `## 快捷键

| 快捷键 | 作用 | 可用页面 |
|--------|------|----------|
| Ctrl+K | 全局搜索（跨项目） | 任意 |
| Ctrl+Shift+F | 文件内容搜索 | 产出页 |
| Ctrl+P | 文件名搜索 | 产出页 |
| Ctrl+Enter | 发送消息 / 提交 commit | 许愿页 / 版本页 |

### 右键菜单

**许愿页会话列表右键**:
- 📌 置顶
- ✏️ 重命名
- 🙈 隐藏
- 📋 复制全部 / 复制关键结论
- 📁 跳转至所在文件夹
- 切换模式

**产出页文件右键**:
- 📜 查看历史版本
- ⏪ 版本回退
- 📂 在文件管理器中打开
- 📋 复制路径

### 使用技巧

1. **善用管家的深度模式** — 让管家亲自分析代码，比你描述问题更精准
2. **善用管理模式** — 通过对话调整团队配置，比手动编辑更直观
3. **迭代开发** — 不要一次许太大的需求，小步快跑
4. **查看会话记录** — 在会话页可以看到 Agent 间的完整对话，了解决策过程
5. **管家记忆管理** — 定期在设置里清理不需要的记忆，保持上下文干净`,
  },
  {
    id: 'faq',
    icon: '❓',
    title: '常见问题',
    difficulty: '入门',
    diffColor: 'bg-emerald-500/20 text-emerald-400',
    content: `## 常见问题解答

### Q: 启动后一直没反应？
**A:** 请检查：
1. 是否已配置 API Key（设置页，状态指示灯应为绿色）
2. 是否已输入需求（许愿页面）
3. 网络是否正常

### Q: 费用太高了？
**A:** 降低费用的方法：
- 为快速模型选择便宜的模型（如 GPT-4o-mini、Claude Haiku）
- 减小需求范围，分步迭代
- 在团队页降低各 Agent 的 max token

### Q: 生成的代码质量不好？
**A:** 尝试：
- 提供更详细的需求描述
- 指定技术栈和框架
- 在管家深度模式下先做代码审查
- 换更强的模型

### Q: 可以修改已生成的代码吗？
**A:** 可以！在产出页找到工作区路径，用编辑器修改。建议在暂停状态下修改，避免被 Agent 覆盖。

### Q: 导入项目后分析不准确？
**A:** 
- 确保选择了正确的根目录
- 删除 \`.automater/\` 后重新导入
- 可在设置中调高导入预算
- 分析完成后在文档页手动修正

### Q: 导入会修改源代码吗？
**A:** 不会。所有产物在 \`.automater/\` 目录中。

### Q: 管家总是提到一些我不认识的项目信息？
**A:** 可能是旧的管家记忆。进入管家设置 → 记忆管理，查看和清理不需要的记忆。

### Q: 管家的对话模式有什么区别？
**A:** 
- **工作模式**: 管家只做调度，把具体任务派发给团队
- **闲聊模式**: 不加载项目记忆，纯聊天
- **深度模式**: 管家亲自读代码写分析，最适合代码审查
- **管理模式**: 通过对话修改团队配置

### Q: 如何联系支持？
**A:** 直接和管家对话描述你遇到的问题，管家了解 AutoMater 的所有功能。`,
  },
];

// ═══════════════════════════════════════
// Simple MD renderer (reuse from DocsPage concept)
// ═══════════════════════════════════════

function renderGuideMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inTable = false;
  let tableRows: string[][] = [];
  let _tableHeader = false;

  const closeList = () => {
    if (inList) {
      html.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  };
  const closeTable = () => {
    if (inTable && tableRows.length > 0) {
      html.push('<table class="w-full text-xs my-3 border-collapse">');
      tableRows.forEach((row, i) => {
        const tag = i === 0 ? 'th' : 'td';
        const cls =
          i === 0
            ? 'bg-slate-800/50 text-slate-300 font-medium px-3 py-2 text-left border-b border-slate-700'
            : 'text-slate-400 px-3 py-2 border-b border-slate-800/50';
        html.push('<tr>' + row.map(c => `<${tag} class="${cls}">${esc(c)}</${tag}>`).join('') + '</tr>');
      });
      html.push('</table>');
      tableRows = [];
      inTable = false;
      _tableHeader = false;
    }
  };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const SAFE_URL_RE = /^(?:https?|mailto|tel|ftp):/i;
  const isSafeUrl = (url: string): boolean => {
    const t = url.replace(/&amp;/g, '&').trim();
    if (t.startsWith('/') || t.startsWith('#') || t.startsWith('.')) return true;
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(t)) return SAFE_URL_RE.test(t);
    return true;
  };
  const inline = (text: string) => {
    let r = esc(text);
    r = r.replace(
      /`([^`]+)`/g,
      '<code class="px-1.5 py-0.5 bg-slate-800 rounded text-amber-300 text-xs font-mono">$1</code>',
    );
    r = r.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>');
    r = r.replace(/\*(.+?)\*/g, '<em>$1</em>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, label: string, url: string) =>
      isSafeUrl(url)
        ? `<a href="${url}" class="text-forge-400 underline hover:text-forge-300" target="_blank" rel="noopener noreferrer">${label}</a>`
        : `<span class="text-forge-400">${label}</span>`,
    );
    return r;
  };

  for (const raw of lines) {
    const line = raw;

    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        closeList();
        closeTable();
        inCodeBlock = true;
        codeBuffer = [];
      } else {
        html.push(
          `<pre class="bg-slate-900 border border-slate-800 rounded-lg p-4 overflow-x-auto my-3"><code class="text-xs text-slate-300 leading-relaxed font-mono">${esc(codeBuffer.join('\n'))}</code></pre>`,
        );
        inCodeBlock = false;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }
    if (line.trim() === '') {
      closeList();
      closeTable();
      continue;
    }

    // Table row
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      closeList();
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) {
        _tableHeader = true;
        continue;
      }
      if (!inTable) inTable = true;
      tableRows.push(cells);
      continue;
    } else {
      closeTable();
    }

    // Heading
    const hm = line.match(/^(#{1,4})\s+(.+)$/);
    if (hm) {
      closeList();
      const level = hm[1].length;
      const sizes: Record<number, string> = {
        1: 'text-xl font-bold text-slate-100 mt-6 mb-3 pb-2 border-b border-slate-800',
        2: 'text-lg font-bold text-slate-200 mt-5 mb-2',
        3: 'text-sm font-semibold text-slate-300 mt-4 mb-2',
        4: 'text-xs font-semibold text-slate-400 mt-3 mb-1',
      };
      html.push(`<h${level} class="${sizes[level]}">${inline(hm[2])}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      html.push('<hr class="border-slate-800 my-4" />');
      continue;
    }

    if (line.trimStart().startsWith('> ')) {
      closeList();
      const content = line.replace(/^>\s*/, '');
      const isWarning = content.startsWith('⚠️');
      const isTip = content.startsWith('💡');
      const border = isWarning
        ? 'border-amber-500/40 bg-amber-500/5'
        : isTip
          ? 'border-forge-500/40 bg-forge-500/5'
          : 'border-slate-600';
      html.push(
        `<blockquote class="border-l-2 ${border} pl-4 pr-3 py-2 my-3 rounded-r-lg text-xs text-slate-400">${inline(content)}</blockquote>`,
      );
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        inList = 'ul';
        html.push('<ul class="list-disc list-inside space-y-1.5 my-2 text-slate-300 text-sm ml-2">');
      }
      html.push(`<li class="leading-relaxed">${inline(ulMatch[2])}</li>`);
      continue;
    }
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        inList = 'ol';
        html.push('<ol class="list-decimal list-inside space-y-1.5 my-2 text-slate-300 text-sm ml-2">');
      }
      html.push(`<li class="leading-relaxed">${inline(olMatch[2])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p class="text-sm text-slate-300 leading-relaxed my-1.5">${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  if (inCodeBlock)
    html.push(
      `<pre class="bg-slate-900 border border-slate-800 rounded-lg p-4 overflow-x-auto my-3"><code class="text-xs text-slate-300 font-mono">${esc(codeBuffer.join('\n'))}</code></pre>`,
    );
  return html.join('\n');
}

// ═══════════════════════════════════════
// GuidePage component
// ═══════════════════════════════════════

export function GuidePage() {
  const [selectedId, setSelectedId] = useState(GUIDE_SECTIONS[0].id);
  const selected = GUIDE_SECTIONS.find(s => s.id === selectedId) || GUIDE_SECTIONS[0];

  return (
    <div className="h-full flex overflow-hidden">
      {/* Left nav */}
      <div className="w-56 border-r border-slate-800 flex flex-col flex-shrink-0 bg-slate-950">
        <div className="px-4 py-4 border-b border-slate-800">
          <h2 className="text-sm font-bold text-slate-200 flex items-center gap-2">📖 使用教程</h2>
          <p className="text-[10px] text-slate-500 mt-1">面向所有用户的完整指南</p>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {GUIDE_SECTIONS.map(sec => (
            <button
              key={sec.id}
              onClick={() => setSelectedId(sec.id)}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-2.5 transition-all text-xs ${
                selectedId === sec.id
                  ? 'bg-forge-600/10 text-forge-300 border-r-2 border-forge-500'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <span className="text-base">{sec.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium">{sec.title}</div>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full mt-0.5 inline-block ${sec.diffColor}`}>
                  {sec.difficulty}
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-600">v21.0 · 8 篇教程</div>
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-forge-500/20 to-indigo-500/20 flex items-center justify-center text-2xl border border-forge-500/20">
              {selected.icon}
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-100">{selected.title}</h1>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${selected.diffColor}`}>
                {selected.difficulty}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="guide-content" dangerouslySetInnerHTML={{ __html: renderGuideMarkdown(selected.content) }} />

          {/* Navigation */}
          <div className="flex justify-between mt-10 pt-6 border-t border-slate-800">
            {(() => {
              const idx = GUIDE_SECTIONS.findIndex(s => s.id === selectedId);
              const prev = idx > 0 ? GUIDE_SECTIONS[idx - 1] : null;
              const next = idx < GUIDE_SECTIONS.length - 1 ? GUIDE_SECTIONS[idx + 1] : null;
              return (
                <>
                  {prev ? (
                    <button
                      onClick={() => setSelectedId(prev.id)}
                      className="flex items-center gap-2 text-xs text-slate-400 hover:text-forge-300 transition-colors"
                    >
                      <span>←</span>{' '}
                      <span>
                        {prev.icon} {prev.title}
                      </span>
                    </button>
                  ) : (
                    <div />
                  )}
                  {next ? (
                    <button
                      onClick={() => setSelectedId(next.id)}
                      className="flex items-center gap-2 text-xs text-slate-400 hover:text-forge-300 transition-colors"
                    >
                      <span>
                        {next.icon} {next.title}
                      </span>{' '}
                      <span>→</span>
                    </button>
                  ) : (
                    <div />
                  )}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
