# AgentForge 能力完善方案 v3 — 客观差距分析 + 行动计划

> 日期: 2026-03-02  
> 版本: v3.0 — 客观重新审视版  
> 作者: Tim的开发助手 (EchoAgent)
>
> **v3.0 修订说明**: 前两版文档存在「自我拉高、回避弱点」的倾向。本版引入
> **验证状态三态标注** — ✅ 已在运行时验证 / 🔶 仅代码存在(未经运行验证) / ❌ 不存在，
> 以暴露 AgentForge 和 EchoAgent 的真实差距。

---

## 0. 核心认知前提

**EchoAgent 的能力本质是平台+基建提供的**：SerpApi、Docker 集群、Playwright MCP Server、
10 个预训练子代理、OSS 存储——这些是企业级后端基建，运维由平台团队负责。
Agent 开发者（用户）拿到的是"开箱即用的 50+ 工具"。

**AgentForge 是一个单机桌面应用**：所有能力必须自带。没有云端后端，
所有工具实现都打包在 Electron 主进程或本地 Docker 中。这意味着：
- 搜索引擎没有 SerpApi 商业订阅做后盾
- Docker 需要用户自己装
- Playwright 需要自己管理浏览器生命周期
- 子代理是进程内的 Promise，不是独立微服务

**这既是劣势（运维靠用户自己），也是优势（零云端依赖、可完全离线、数据不出本机）。**

---

## 1. EchoAgent 真实能力拆解（含弱点）

| 能力 | 工具 | 真实质量 | 弱点 |
|------|------|----------|------|
| **搜索** | `WebSearch_websearch` (SerpApi) | ✅ 商业级，并行多查询 | 依赖 SerpApi 订阅；`read_url` 有时清洗不干净；无本地缓存 |
| **Docker** | `DockerSandbox_*` (7 API) | ✅ 生产级，秒级启动 | 平台侧管理；Agent 无法自定义镜像构建 |
| **浏览器** | `Playwright_*` (18 MCP API) | ✅ 完整 | MCP 协议开销；ref-based 选择器有时失效需重试 |
| **子代理** | `ask_agent` 10个预设 | ✅ 丰富 | 每个子代理是黑盒，无法定制 prompt；子代理间无共享内存；调用延迟高 |
| **代码搜索** | `code-search_*` (ripgrep) | ✅ 快 | 需要 code-search MCP 服务运行 |
| **文件** | `read`/`edit`/`multiedit`/`ls`/`grep` | ✅ 完整 | Windows 路径偶有问题 |
| **GUI** | `GUI_computer_*` | ✅ 仅 Claude 模型 | 模型限定；截图→坐标映射有误差；无 a11y tree |
| **任务管理** | `todo-plus_*` | ✅ | 纯文本，无优先级排序 |
| **记忆** | boot.md / scratchpad / skill_index | 🔶 外挂，需 read/edit 工具 | 非平台原生；依赖 Agent 主动执行 boot 流程 |
| **深度研究** | 无专用工具，需 Agent 手动编排 search→read→think | 🔶 涌现能力 | 无结构化流程；质量取决于 Agent 自律 |
| **自主测试迭代** | ❌ 无 | ❌ | 无 |
| **技能进化** | ❌ 无原生实现 | ❌ | 记忆系统是近似替代品 |
| **图片生成** | `ask_agent` → 设计绘画助手 / NanoBanana | ✅ | 子代理调用，非直接工具 |
| **离线运行** | ❌ 完全依赖云端 | ❌ | — |

**EchoAgent 真实优势**: 搜索质量(SerpApi)、子代理生态(10个)、Docker零运维、图片生成、Claude GUI操作  
**EchoAgent 真实弱点**: 无离线能力、无自主测试闭环、子代理不可定制、记忆非原生、搜索无冗余

---

## 2. AgentForge v8.0 真实能力盘点（含验证状态）

> 验证状态:  
> ✅ = 已在运行时成功执行过 (有 commit 记录或 vitest 通过)  
> 🔶 = 代码已写入 + tsc 编译通过，但**从未在运行时执行过**  
> ❌ = 不存在

| 能力 | 工具数 | 验证状态 | 诚实评价 |
|------|--------|----------|----------|
| **文件操作** | 7 | ✅ 核心流水线每天使用 | 成熟 |
| **命令执行** | 4 | ✅ run_command/run_test 流水线使用 | 成熟，但 execSync 无隔离 |
| **Git** | 3 | ✅ 提交/diff 在流水线中使用 | 成熟 |
| **搜索 (Jina)** | 2 | ✅ web_search/fetch_url 有运行记录 | 可用但质量差 |
| **搜索 (多引擎 fallback)** | 2 | 🔶 代码存在，未配置任何 API key 运行过 | **高风险：Brave/Serper/SearXNG 的 API 响应格式可能变化** |
| **深度研究** | 1 | 🔶 代码存在，从未执行 | **高风险：多轮搜索→LLM合成的完整链路未验证** |
| **黑盒测试** | 1 | 🔶 代码存在，从未执行 | **最高风险：依赖 Docker + Browser + Sub-Agent 三者联动** |
| **Playwright 浏览器** | 18 | 🔶 10个基础API可能被流水线使用过；8个新增从未运行 | 中风险 |
| **Docker 沙箱** | 5 | 🔶 代码存在，依赖用户安装 Docker | 中风险：Docker CLI 调用方式在不同平台可能不同 |
| **子代理** | 4 | 🔶 代码存在，从未执行 | 高风险：ReAct 循环 + 工具分发从未端到端验证 |
| **GUI 操作** | 5 | 🔶 robotjs 依赖可能未安装 | 中风险 |
| **视觉验证** | 3 | 🔶 依赖 Vision LLM 回调 | 中风险 |
| **QA 审查** | — | ✅ qa-loop.ts 在流水线中使用 | 成熟，但仅代码审查，非运行时测试 |
| **记忆系统** | 2 | ✅ memory_read/append 被流水线使用 | 成熟 |
| **技能进化** | 4 | 🔶 代码存在，可能从未被 Agent 实际使用 | 中风险 |
| **任务管理** | 2 | ✅ todo_write/read 在流水线使用 | 成熟 |
| **MCP 客户端** | — | 🔶 mcp-client.ts 存在，连接状况未知 | 高风险 |

### 关键事实

**总工具定义: 56 个 — 但只有约 20 个经过运行时验证。**  
**约 36 个工具处于 🔶 状态（代码写了，tsc 通过了，从未真正跑过）。**

这是 AgentForge 和 EchoAgent 之间**最大的结构性差距**：
EchoAgent 的每一个工具都是平台团队维护的、日常被成千上万 Agent 调用的生产级实现。
AgentForge 的很多工具是"理论上应该能工作"的代码。

---

## 3. 维度逐项对比（诚实版）

| 维度 | EchoAgent | AgentForge v8.0 | 诚实判断 |
|------|-----------|-----------------|----------|
| **搜索质量** | SerpApi 商业级 ✅ | Jina 免费 ✅ + 4 引擎 🔶 | **EA > AF** (AgentForge 配了 key 才有竞争力，且未验证) |
| **搜索冗余/可靠性** | 单点 SerpApi | 5 引擎 fallback 🔶 | **AF 设计更好**，但未验证 |
| **深度研究** | 手工编排 🔶 | 结构化引擎 🔶 | **AF 设计更好**，但都未验证 |
| **自主测试迭代** | ❌ 无 | 完整闭环 🔶 | **AF 有设计**，EA 无此能力 |
| **Docker 沙箱** | ✅ 生产级 | 🔶 CLI 调用 | **EA >> AF** (AF 未验证，且依赖用户装 Docker) |
| **浏览器自动化** | ✅ MCP 生产级 | 🔶 自管理 Playwright | **EA > AF** (AF 基础API可能可用，新增未验证) |
| **子代理** | ✅ 10 个生产级 | 🔶 6 预设未验证 | **EA >> AF** (数量 + 验证程度) |
| **代码搜索** | ✅ ripgrep | ✅ Select-String | **持平** |
| **文件操作** | ✅ | ✅ | **持平** |
| **GUI 桌面操作** | ✅ Claude限定 | 🔶 | **EA > AF** (EA 验证过，AF 不确定) |
| **图片生成** | ✅ 子代理 | ❌ | **EA >> AF** |
| **技能进化** | ❌ | 🔶 | **AF 有设计**，EA 无此概念 |
| **记忆持久化** | 🔶 外挂 | ✅ 3层原生 | **略持平**，各有优劣 |
| **离线/LAN** | ❌ | ✅ 可离线 | **AF >> EA** |
| **数据隐私** | ❌ 云端 | ✅ 本地 | **AF >> EA** |
| **开箱即用** | ✅ 零配置 | ❌ 需装 Docker/配 API key | **EA >> AF** |
| **模型灵活性** | 平台限定 | ✅ 任意 OpenAI 兼容 API | **AF > EA** |

### 总分对比

| | 验证可靠的优势 | 设计上的优势(未验证) | 明确劣势 |
|--|-------------|-------------------|---------|
| **EchoAgent** | 搜索质量、Docker、浏览器、子代理、图片生成、开箱即用 | — | 离线、隐私、定制性、自主测试 |
| **AgentForge** | 离线、隐私、模型灵活性、文件/记忆 | 搜索冗余、深度研究、自主测试、技能进化 | 搜索质量、Docker、浏览器、子代理、图片生成 |

**结论: 如果只看"已验证能力"，EchoAgent 仍然显著领先。
AgentForge 的优势主要在架构设计层面，但大量模块处于"写了没跑"状态。**

---

## 4. 行动计划 — 从"写了没跑"到"跑了能用"

### Phase 0: 验证已有代码（最高优先）

> **核心思路: 先把 🔶 变成 ✅，而不是继续写新的 🔶**

| # | 行动 | 验证方法 | 预计 |
|---|------|----------|------|
| V1 | **搜索 Provider 端到端验证** | 配置 Brave free key，运行 `web_search` 对比 Jina 结果 | 2h |
| V2 | **deep_research 端到端验证** | 喂一个真实问题，验证 query 分解→搜索→提取→合成完整链路 | 4h |
| V3 | **Docker Sandbox 验证** | 在装有 Docker 的机器上 `sandbox_init` → `sandbox_exec` → `sandbox_destroy` | 2h |
| V4 | **Sub-Agent 单次执行验证** | `spawn_agent` researcher preset 执行一个简单调研任务 | 3h |
| V5 | **blackbox-test-runner 验证** | 对一个简单 Express 应用运行 `run_blackbox_tests` | 1天 |
| V6 | **Browser 新增 API 验证** | 对真实页面执行 hover/fillForm/drag/tabs | 3h |
| V7 | **应用整体启动验证** | `npm run dev` → 创建项目 → 跑一个 Feature → 全链路 | 1天 |

### Phase 1: 弥补关键短板

| # | 行动 | 说明 | 预计 |
|---|------|------|------|
| F1 | **图片生成集成** | 接入 DALL-E 3 / Gemini Image API (工具: `generate_image`) | 2天 |
| F2 | **搜索质量保底** | 内置 Brave Search free API key 申请引导 + SearXNG Docker 一键部署脚本 | 1天 |
| F3 | **Sub-Agent 可靠性** | 增加超时、重试、graceful degradation | 1天 |
| F4 | **E2E 测试集成测试** | 为 blackbox-test-runner 编写集成测试，验证 Docker+Browser 联动 | 2天 |

### Phase 2: 形成独特优势

| # | 行动 | 说明 | 预计 |
|---|------|------|------|
| A1 | **本地 RAG** | 基于 sqlite-vec 的代码向量检索，替代纯 grep | 3天 |
| A2 | **研究报告缓存** | 相同/相似问题命中缓存，避免重复搜索消耗 | 1天 |
| A3 | **测试覆盖率追踪** | blackbox-test-runner 输出覆盖率报告，驱动迭代 | 2天 |
| A4 | **MCP 生态扩展** | 接入 GitHub MCP / Figma MCP / 自定义 MCP 注册 | 3天 |
| A5 | **自适应工作流** | Agent 根据项目类型自动选择工具集和测试策略 | 3天 |

### Phase 3: 超越目标

| # | 行动 | 说明 | 预计 |
|---|------|------|------|
| S1 | **持续学习系统** | skill-evolution 从 🔶→✅，实现跨项目技能迁移 | 3天 |
| S2 | **多 Agent 协作协议** | Sub-Agent 间共享发现/冲突检测/自动协调 | 5天 |
| S3 | **自部署 SearXNG** | 应用内一键启动 SearXNG Docker，实现完全离线搜索 | 1天 |
| S4 | **可视化调试** | Agent 思考过程、工具调用链、搜索结果的实时可视化 | 3天 |

---

## 5. 已写代码资产清单

### 新建文件 (v7.0 + v8.0)

| 文件 | 行数 | 验证状态 | 功能 |
|------|------|----------|------|
| `sub-agent-framework.ts` | 588 | 🔶 | 6 角色子代理 + 并行 |
| `docker-sandbox.ts` | 397 | 🔶 | Docker 容器沙箱 |
| `search-provider.ts` | 595 | 🔶 | 5 引擎搜索 + fallback |
| `research-engine.ts` | 531 | 🔶 | 深度研究引擎 |
| `blackbox-test-runner.ts` | 857 | 🔶 | 自主黑盒测试闭环 |

### 修改文件 (v7.0 + v8.0)

| 文件 | 修改范围 | 验证状态 |
|------|----------|----------|
| `tool-registry.ts` | +23 工具定义 + 权限表更新 | 🔶 (tsc ✅) |
| `tool-executor.ts` | +19 工具执行分支 | 🔶 (tsc ✅) |
| `web-tools.ts` | 重构委托 search-provider | 🔶 (tsc ✅, 但改变了运行时行为) |
| `browser-tools.ts` | +8 API 实现 | 🔶 |

### 代码质量状态

- **tsc**: 非 test 文件零错误 (test 文件缺 `@types/vitest`)
- **引擎总代码**: 51 文件, 23,284 行
- **新增代码占比**: ~2,968 行 / 23,284 行 = 12.7%
- **运行时验证覆盖**: 约 20/56 工具 = 36%

---

## 6. 工具完整清单 (56个, 含验证状态)

| 类别 | 工具 | 状态 |
|------|------|------|
| 文件 | read_file, write_file, edit_file, batch_edit, list_files, glob_files, search_files | ✅ |
| 命令 | run_command, run_test, run_lint, check_process | ✅ |
| Git | git_commit, git_diff, git_log | ✅ |
| GitHub | github_create_issue, github_list_issues | 🔶 |
| 搜索 | web_search, fetch_url | ✅ (Jina) |
| 搜索+ | http_request, **web_search_boost**, **configure_search** | 🔶 |
| 研究 | **deep_research** | 🔶 |
| 测试 | **run_blackbox_tests** | 🔶 |
| 子代理 | spawn_researcher | ✅ (旧版) |
| 子代理+ | **spawn_agent**, **spawn_parallel**, **list_sub_agents**, **cancel_sub_agent** | 🔶 |
| 沙箱 | **sandbox_init**, **sandbox_exec**, **sandbox_write**, **sandbox_read**, **sandbox_destroy** | 🔶 |
| 浏览器 | browser_launch/navigate/screenshot/snapshot/click/type/evaluate/wait/network/close | ✅/🔶 混合 |
| 浏览器+ | **browser_hover/select_option/press_key/fill_form/drag/tabs/file_upload/console** | 🔶 |
| GUI | screenshot, mouse_click, mouse_move, keyboard_type, keyboard_hotkey | 🔶 |
| 视觉 | analyze_image, compare_screenshots, visual_assert | 🔶 |
| 记忆 | memory_read, memory_append | ✅ |
| 技能 | skill_acquire, skill_search, skill_improve, skill_record_usage | 🔶 |
| 思考 | think, todo_write, todo_read, task_complete, report_blocked, rfc_propose | ✅ |

**✅ 已验证: ~20 | 🔶 仅代码: ~36 | 验证率: 36%**

---

## 7. 最终结论

AgentForge v8.0 在**架构设计**层面已经具备超越 EchoAgent 的潜力：
- 搜索冗余设计 > 单点 SerpApi
- 深度研究引擎 > 手工编排
- 自主测试闭环 > 完全不存在
- 技能进化系统 > 外挂记忆
- 离线/隐私 > 纯云端

但在**实际可用性**层面仍然落后：
- 64% 的工具从未运行过
- 核心复杂模块 (deep_research, blackbox-test-runner, sub-agent) 零运行时验证
- Docker/Browser 依赖链未在真机测试

**下一步的重点不是写更多代码，而是把已有代码跑起来、验证通、修好 bug。**
Phase 0 (验证已有代码) 完成后，AgentForge 才能真正声称在特定维度超越 EchoAgent。
