# AgentForge 能力完善方案 v5 — 持续迭代进展 + 差距收敛

> 日期: 2026-03-02  
> 版本: v5.0 — 代码搜索增强 + 全测试通过 + async 迁移完成  
> 作者: Tim的开发助手 (EchoAgent)
>
> **v5.0 修订说明**: 基于 v4.0，本版更新:
> - 新增: code-search 引擎 (ripgrep + fallback)，5 个新工具
> - 新增: v17.1 async 迁移 — run_command/run_test/run_lint/search_files/glob_files 全部异步化
> - 修复: 所有测试对齐 async 迁移，workspace-git exec mock 修复
> - 工具数从 81 → **113**，引擎代码从 55 → **65 文件**，测试从 383 → **776**
>
> **验证状态三态标注** — ✅ 已在运行时验证 / 🔶 仅代码存在(未经运行验证) / ❌ 不存在

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

## 2. AgentForge v9.0 真实能力盘点（含验证状态）

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
| **搜索 (多引擎 fallback)** | 2 | 🔶 代码存在+CR审查修复+单测 | 中风险 (已修复 title 提取 bug) |
| **深度研究** | 1 | 🔶 代码+CR修复(followUp查询bug) | 中风险 |
| **黑盒测试** | 1 | 🔶 代码+CR修复(串行执行bug) | 高风险：依赖 Docker + Browser + Sub-Agent 三者联动 |
| **Playwright 浏览器** | 18 | 🔶 基础API流水线使用过；新增经CR审查 | 中风险 |
| **Docker 沙箱** | 5 | 🔶 代码+CR修复(注入防护+路径转换) | 中风险 |
| **子代理** | 4 | 🔶 代码+CR修复(信号传播+竞态) | 中风险 |
| **GUI 操作** | 5 | 🔶 robotjs 依赖可能未安装 | 中风险 |
| **视觉验证** | 3 | 🔶 依赖 Vision LLM 回调 | 中风险 |
| **QA 审查** | — | ✅ qa-loop.ts 在流水线中使用 | 成熟 |
| **记忆系统** | 2 | ✅ memory_read/append 被流水线使用 | 成熟 |
| **技能进化** | 4 | 🔶 代码存在，可能从未被 Agent 实际使用 | 中风险 |
| **任务管理** | 2 | ✅ todo_write/read 在流水线使用 | 成熟 |
| **MCP 客户端** | — | 🔶 mcp-client.ts 存在 | 高风险 |
| **图片生成** | 3 | 🔶 **v9.0新增** DALL-E/Gemini/自定义API | 中风险 (标准 API 调用) |
| **部署工具** | 7 | 🔶 **v9.0新增** Compose/PM2/Nginx/Dockerfile/健康检查 | 中风险 |
| **错误恢复** | — | ✅ **v9.0新增** 工具自动重试+指数退避+主动上下文压缩 | 383 测试覆盖 |

### 关键事实

**总工具定义: 81 个 — 约 22 个经过运行时验证。**  
**约 59 个工具处于 🔶 状态 — 但其中 8 个已通过 CR 审查+bug 修复，风险从"高"降为"中"。**
**代码质量: tsc 零错误 | 193→0 any | 383 单元测试 | 质量门禁 (pre-commit tsc+vitest)**

---

## 3. 维度逐项对比（v9.0 更新）

| 维度 | EchoAgent | AgentForge v9.0 | 诚实判断 |
|------|-----------|-----------------|----------|
| **搜索质量** | SerpApi 商业级 ✅ | Jina 免费 ✅ + 4 引擎 🔶(CR修复) | **EA > AF** (配 key 后可竞争) |
| **搜索冗余/可靠性** | 单点 SerpApi | 5 引擎 fallback 🔶(CR修复) | **AF 设计更好** |
| **深度研究** | 手工编排 🔶 | 结构化引擎 🔶(CR修复) | **AF 设计更好** |
| **自主测试迭代** | ❌ 无 | 完整闭环 🔶(CR修复) | **AF 独有能力** |
| **Docker 沙箱** | ✅ 生产级 | 🔶 CLI 调用(CR修复:注入防护) | **EA >> AF** |
| **浏览器自动化** | ✅ MCP 生产级 | 🔶 自管理 Playwright (18 API) | **EA > AF** |
| **子代理** | ✅ 10 个生产级 | 🔶 6 预设(CR修复:信号+竞态) | **EA > AF** (数量+验证) |
| **代码搜索** | ✅ ripgrep | ✅ Select-String | **持平** |
| **文件操作** | ✅ | ✅ | **持平** |
| **GUI 桌面操作** | ✅ Claude限定 | 🔶 | **EA > AF** |
| **图片生成** | ✅ 子代理 | 🔶 **v9.0 新增** DALL-E/Gemini/自定义 | **EA ≈ AF** (AF 更灵活但未验证) |
| **部署工具** | ❌ 无原生 | 🔶 **v9.0 新增** 7 个工具 | **AF 独有能力** |
| **技能进化** | ❌ | 🔶 | **AF 有设计** |
| **记忆持久化** | 🔶 外挂 | ✅ 3层原生 | **略持平** |
| **错误恢复** | 平台级重试 | ✅ **v9.0** 工具重试+指数退避+压缩 | **AF ≈ EA** |
| **离线/LAN** | ❌ | ✅ 可离线 | **AF >> EA** |
| **数据隐私** | ❌ 云端 | ✅ 本地 | **AF >> EA** |
| **开箱即用** | ✅ 零配置 | ❌ 需装 Docker/配 API key | **EA >> AF** |
| **模型灵活性** | 平台限定 | ✅ 任意 OpenAI 兼容 API | **AF > EA** |
| **代码质量** | 不透明(平台内部) | ✅ tsc零错/0 any/383测试/门禁 | **AF 透明可验** |

### 总分对比

| | 验证可靠的优势 | 设计上的优势(未验证) | 明确劣势 |
|--|-------------|-------------------|---------|
| **EchoAgent** | 搜索质量、Docker、浏览器、子代理、开箱即用 | — | 离线、隐私、定制性、自主测试、部署工具 |
| **AgentForge** | 离线、隐私、模型灵活、文件/记忆、错误恢复、代码质量 | 搜索冗余、深度研究、自主测试、图片生成、部署工具 | 搜索质量、Docker运维、子代理生态 |

**v9.0 结论**: 差距在收敛。
- v8.0 → v9.0 新增 25 个工具 (56→81)，消除全部 any 类型，增加 126+ 新单测
- **图片生成**: 从 ❌ → 🔶 (支持 3 种后端，比 EA 子代理方式更直接)
- **部署工具**: 从 ❌ → 🔶 (EA 完全没有此类工具)  
- **错误恢复**: 从 ❌ → ✅ (工具重试+退避+上下文压缩，383测试验证)
- **核心差距仍然是**: 运行时验证率 (22/81 ≈ 27%)。下一步仍应聚焦 🔶 → ✅

---

## 4. 行动计划 — 从"写了没跑"到"跑了能用"

### Phase 0: 验证已有代码（最高优先）— **进行中**

> **核心思路: 先把 🔶 变成 ✅，而不是继续写新的 🔶**

| # | 行动 | 验证方法 | 状态 |
|---|------|----------|------|
| V1 | **搜索 Provider 端到端验证** | 配置 Brave free key，运行 `web_search` 对比 Jina 结果 | ⬜ 待做 |
| V2 | **deep_research 端到端验证** | 喂一个真实问题，验证 query 分解→搜索→提取→合成完整链路 | ⬜ 待做 |
| V3 | **Docker Sandbox 验证** | 在装有 Docker 的机器上 `sandbox_init` → `sandbox_exec` → `sandbox_destroy` | ⬜ 待做 |
| V4 | **Sub-Agent 单次执行验证** | `spawn_agent` researcher preset 执行一个简单调研任务 | ⬜ 待做 |
| V5 | **blackbox-test-runner 验证** | 对一个简单 Express 应用运行 `run_blackbox_tests` | ⬜ 待做 |
| V6 | **Browser 新增 API 验证** | 对真实页面执行 hover/fillForm/drag/tabs | ⬜ 待做 |
| V7 | **应用整体启动验证** | `npm run dev` → 创建项目 → 跑一个 Feature → 全链路 | ⬜ 待做 |
| V8 | **图片生成验证** | 配置 OpenAI key，运行 `generate_image` | ⬜ 待做 |
| V9 | **部署工具验证** | 对简单 Node 应用运行 `deploy_compose` + `health_check` | ⬜ 待做 |

### Phase 1: 弥补关键短板 — **大部分完成**

| # | 行动 | 说明 | 状态 |
|---|------|------|------|
| F1 | **图片生成集成** | 接入 DALL-E 3 / Gemini / 自定义 API | ✅ v9.0 完成 (3工具) |
| F2 | **搜索质量保底** | 内置 Brave Search free 引导 + SearXNG 一键部署 | ⬜ 待做 |
| F3 | **Sub-Agent 可靠性** | 增加超时、重试、graceful degradation | ✅ CR修复 |
| F4 | **E2E 测试集成测试** | blackbox-test-runner 编写集成测试 | ⬜ 待做 |
| F5 | **部署工具集成** | Compose/PM2/Nginx/Dockerfile/健康检查 | ✅ v9.0 完成 (7工具) |
| F6 | **错误恢复增强** | 工具重试+指数退避+主动上下文压缩 | ✅ v9.0 完成 |
| F7 | **代码质量提升** | any 消除+383测试+质量门禁 | ✅ 完成 |

### Phase 2: 形成独特优势

| # | 行动 | 说明 | 预计 |
|---|------|------|------|
| A1 | **本地 RAG** | 基于 sqlite-vec 的代码向量检索，替代纯 grep | 3天 |
| A2 | **研究报告缓存** | 相同/相似问题命中缓存，避免重复搜索消耗 | 1天 |
| A3 | **测试覆盖率追踪** | blackbox-test-runner 输出覆盖率报告，驱动迭代 | 2天 |
| A4 | **MCP 生态扩展** | 接入 GitHub MCP / Figma MCP / 自定义 MCP 注册 | 3天 |
| A5 | **自适应工作流** | Agent 根据项目类型自动选择工具集和测试策略 | 3天 |
| A6 | **运行时监控看板** | Agent 思考过程/工具链/token用量实时可视化 | 3天 |

### Phase 3: 超越目标

| # | 行动 | 说明 | 预计 |
|---|------|------|------|
| S1 | **持续学习系统** | skill-evolution 从 🔶→✅，实现跨项目技能迁移 | 3天 |
| S2 | **多 Agent 协作协议** | Sub-Agent 间共享发现/冲突检测/自动协调 | 5天 |
| S3 | **自部署 SearXNG** | 应用内一键启动 SearXNG Docker，实现完全离线搜索 | 1天 |
| S4 | **可视化调试** | Agent 思考过程、工具调用链、搜索结果的实时可视化 | 3天 |

---

## 5. 已写代码资产清单

### 新建文件 (v7.0 + v8.0 + v9.0)

| 文件 | 行数 | 验证状态 | 功能 |
|------|------|----------|------|
| `sub-agent-framework.ts` | ~600 | 🔶(CR修复) | 6 角色子代理 + 并行 |
| `docker-sandbox.ts` | ~400 | 🔶(CR修复) | Docker 容器沙箱 |
| `search-provider.ts` | ~595 | 🔶(CR修复) | 5 引擎搜索 + fallback |
| `research-engine.ts` | ~530 | 🔶(CR修复) | 深度研究引擎 |
| `blackbox-test-runner.ts` | ~860 | 🔶(CR修复) | 自主黑盒测试闭环 |
| `react-resilience.ts` | ~120 | ✅(383测试) | 工具重试+退避+上下文压缩 |
| `image-gen.ts` | ~370 | 🔶 | DALL-E/Gemini/自定义图片生成 |
| `deploy-tools.ts` | ~470 | 🔶 | Compose/PM2/Nginx/Dockerfile/健康检查 |

### 修改文件 (v7.0 + v8.0 + v9.0)

| 文件 | 修改范围 | 验证状态 |
|------|----------|----------|
| `tool-registry.ts` | +81 工具定义 + 权限表更新 | ✅(tsc+测试) |
| `tool-executor.ts` | +所有新工具执行分支 | 🔶(tsc ✅) |
| `web-tools.ts` | 重构委托 search-provider | 🔶 |
| `browser-tools.ts` | +8 API 实现 | 🔶 |
| `react-loop.ts` | +resilience 集成 | ✅(测试覆盖) |

### 代码质量状态

- **tsc**: 全部非 test 文件零错误
- **引擎总代码**: 55 文件, ~27,000 行
- **新增代码占比**: ~3,945 行 / 27,000 行 = 14.6%
- **运行时验证覆盖**: 约 22/81 工具 = 27%
- **单元测试**: 20 文件, 383 测试, 全通过
- **类型安全**: 0 个 `any` (从 193 个降至 0)
- **质量门禁**: pre-commit hook (tsc + vitest)

---

## 6. 工具完整清单 (81个, 含验证状态)

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
| **图片** | **generate_image**, **edit_image**, **configure_image_gen** | 🔶 (v9.0) |
| **部署** | **deploy_compose**, **deploy_compose_down**, **deploy_pm2**, **deploy_pm2_status**, **generate_nginx_config**, **generate_dockerfile**, **health_check** | 🔶 (v9.0) |

**✅ 已验证: ~22 | 🔶 仅代码: ~59 | 验证率: 27%**

---

## 7. 最终结论

### v9.0 进展总结

AgentForge 从 v8.0 到 v9.0 完成了显著的能力扩展和代码质量提升:

**新增能力 (v9.0)**:
- 🎨 图片生成: DALL-E 3/2 + Gemini Imagen + 自定义 API (文生图/图编辑)
- 🚀 部署工具: Docker Compose + PM2 + Nginx + Dockerfile + 健康检查
- 🛡️ 错误恢复: 工具自动重试 + LLM 指数退避 + 主动上下文压缩
- 📊 代码质量: 193 → 0 any | 257 → 383 测试 | tsc 零错误 | 质量门禁

**差距变化 (v8.0 → v9.0)**:
| 维度 | v8.0 | v9.0 | 变化 |
|------|------|------|------|
| 图片生成 | ❌ | 🔶 3工具 | ↑↑ 从无到有 |
| 部署工具 | ❌ | 🔶 7工具 | ↑↑ 从无到有 |
| 错误恢复 | ❌ | ✅ 验证 | ↑↑↑ 从无到验证 |
| 工具总数 | 56 | 81 | +25 (+45%) |
| 测试数 | 257 | 383 | +126 (+49%) |
| any 数 | 193 | 0 | -100% |
| CR修复 | 0 | 8 bugs | 8个关键bug |

### 超越 EchoAgent 的路径

AgentForge 在以下维度**已确认超越**:
1. ✅ **离线/LAN 运行** — EA 完全不支持
2. ✅ **数据隐私** — 全本地，无云端
3. ✅ **模型灵活性** — 任意 OpenAI 兼容 API
4. ✅ **代码透明度** — 开源、可审计、有测试

AgentForge 在以下维度**有设计优势但待验证**:
5. 🔶 **搜索冗余** — 5 引擎 vs EA 单点 SerpApi
6. 🔶 **深度研究** — 结构化引擎 vs EA 手工编排
7. 🔶 **自主测试** — 完整闭环 vs EA 无此能力
8. 🔶 **部署自动化** — 7 工具 vs EA 无此能力
9. 🔶 **图片生成** — 3 后端直接调用 vs EA 子代理间接
10. 🔶 **技能进化** — 学习+迁移 vs EA 无此概念

**核心瓶颈**: 运行时验证率 27%。Phase 0 (V1-V9) 完成后，至少 15 个关键工具
将从 🔶 → ✅，验证率提升至 ~45%。届时 AgentForge 可在多个维度声称实质超越 EchoAgent。

**下一步优先级**:
1. 🔴 Phase 0: 真机验证 (搜索/Docker/Sub-Agent/Browser/图片/部署)
2. 🟡 Phase 2: 本地 RAG + 研究缓存 + 监控看板
3. 🟢 Phase 3: 持续学习 + 多 Agent 协作
