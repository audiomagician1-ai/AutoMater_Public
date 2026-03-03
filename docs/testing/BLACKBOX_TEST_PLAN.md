# 智械母机 AutoMater — 黑盒测试计划

> **版本**: v1.0  
> **日期**: 2026-03-02  
> **适用范围**: AutoMater v6.0+ (含 v7.0~v12.1 暂存功能)  
> **测试方法**: 手动黑盒测试 + 结果记录到 GitHub Issues  
> **仓库**: `audiomagician1-ai/AgentForge`

---

## 〇、测试背景与目标

### 核心风险

AutoMater v6.0+ 所有功能（v7.0~v12.1 共 6 个大版本迭代）**仅通过 `tsc --noEmit` 编译验证**，从未在运行时环境中验证过。这意味着：
- IPC 通道注册/调用可能不匹配
- DB schema 迁移可能有遗漏
- 前端组件渲染可能异常
- 模块间交互可能存在运行时类型错误

### 测试目标

1. **P0 — 冒烟验证**: 应用能否正常启动、创建项目、提交需求、跑通 Phase 1
2. **P1 — 核心流程**: 5 阶段流水线完整走通、LLM 调用正常、文件产出正确
3. **P2 — 辅助功能**: 导入项目、元 Agent、工作流预设、团队配置等
4. **P3 — 边界与异常**: 错误处理、并发防护、熔断机制、极端输入

### 最近迭代覆盖

| 版本 | 关键变更 | 测试关注点 |
|------|---------|-----------|
| v12.1 | DB迁移系统重构(schema_version+safeAddColumn)、类型安全(any 193→138)、ErrorBoundary、ESLint/Prettier | DB迁移是否正确执行、ErrorBoundary是否生效 |
| v12.0 | 多工作流预设体系 + 1/3高度可视化预览 + 工作流驱动引擎 | 预设CRUD、预设切换、自定义工作流执行 |
| v9.0 | Hot-Join + 元Agent管理 + 会话备份 + 会话管理 | 运行中加人、元Agent对话、备份恢复 |
| v6.0 rewrite | 项目导入器重写(2步快速导入) | 导入已有项目、分析流程 |
| v6.0 审计修复 | G1-G15 (并行决策日志/沙箱硬化/QA程序化/增量文档/TDD等) | 多Worker协调、沙箱安全、TDD模式 |
| 品牌更名 | AgentForge → 智械母机 AutoMater (63文件) | 全量UI文字检查、残留"F"/"AgentForge" |
| P0 bug修复 | 并发防护/预检/熔断(NonRetryableError/circuit-breaker) | 双击防护、模型不可用熔断、失败续跑 |
| 代码质量 | 71个单元测试(output-parser+guards+llm-client) | 确认vitest仍通过 |

---

## 一、模块划分与 TC 编号规则

### 模块定义

| 模块ID | 模块名 | 覆盖范围 | 关联页面/文件 |
|--------|--------|---------|--------------|
| `APP` | 应用启动与基础设施 | Electron 启动、窗口管理、DB 初始化、错误边界 | main.ts, db.ts, App.tsx |
| `SET` | 设置与配置 | LLM Provider/Key/Model、MCP 服务器、模型定价 | SettingsPage.tsx, settings.ts |
| `PRJ` | 项目管理 | 项目 CRUD、工作区、删除、列表 | ProjectsPage.tsx, project.ts |
| `IMP` | 项目导入 | 已有项目导入分析 (2步快速导入) | ProjectsPage.tsx, project-importer.ts |
| `WSH` | 许愿与需求 | 需求提交、需求列表、启动开发 | WishPage.tsx, project.ts |
| `PIP` | 流水线编排 | 5阶段流水线、Phase状态流转、续跑/暂停 | OverviewPage.tsx, orchestrator.ts |
| `DEV` | Developer ReAct | ReAct循环、42+工具、文件写入 | react-loop.ts, tool-*.ts, file-writer.ts |
| `QA` | QA 审查 | 程序化检查+LLM审查、TDD、评分 | qa-loop.ts |
| `NAV` | 导航与布局 | 侧边栏、项目切换、全局布局、品牌 | Sidebar.tsx, App.tsx |
| `OVW` | 全景仪表盘 | 架构图、进度面板、统计、实时监控 | OverviewPage.tsx |
| `BRD` | 看板视图 | Feature 看板(5列)、状态流转 | BoardPage.tsx |
| `DOC` | 文档管理 | 5级文档树、设计/需求/测试规格浏览 | DocsPage.tsx, doc-manager.ts |
| `OUT` | 代码产出 | 文件树浏览、代码预览、打开文件夹 | OutputPage.tsx |
| `LOG` | 日志系统 | Agent日志查看、过滤、搜索 | LogsPage.tsx |
| `WKF` | 工作流预设 | 预设CRUD、可视化预览、工作流驱动 | WorkflowPage.tsx, workflow.ts |
| `TEM` | 团队管理 | Agent 配置、热加入、角色管理、实时状态 | TeamPage.tsx |
| `META` | 元 Agent | 元Agent对话、意图检测、需求路由 | MetaAgentPanel.tsx, meta-agent.ts |
| `MSN` | 临时工作流 | 5种Mission类型、Planner→Worker→Judge | WorkflowPage.tsx, mission-runner.ts |
| `CTX` | 上下文管理 | Hot/Warm/Cold 三层、压缩、上下文预览 | ContextPage.tsx, context-collector.ts |
| `TML` | 时间线与分析 | 事件流、分析、检查点、知识库 | TimelinePage.tsx, event-store.ts |
| `GIT` | Git 集成 | auto-init/commit、GitHub push、导出zip | workspace-git.ts, git-provider.ts |
| `LLM` | LLM 调用层 | 流式/非流式、双协议、重试、熔断 | llm-client.ts, model-selector.ts |
| `SBX` | 沙箱执行 | 命令执行、黑名单、路径防护 | sandbox-executor.ts |
| `MEM` | 持久记忆 | 3层记忆(Global/Project/Role)、自动经验 | memory-system.ts |
| `SKL` | 技能系统 | 技能习得/进化/搜索/跨项目共享 | skill-evolution.ts, skill-loader.ts |
| `MCP` | MCP 协议 | 动态工具加载、MCP Server 配置 | mcp-client.ts, mcp.ts |
| `GDE` | 新手教程 | 8篇教程内容、导航入口 | GuidePage.tsx |
| `SES` | 会话管理 | 对话备份、会话列表、恢复 | sessions.ts, conversation-backup.ts |
| `MON` | 系统监控 | CPU/GPU/内存/进程监控 | system-monitor.ts, monitor.ts |
| `ERR` | 错误处理与韧性 | ErrorBoundary、并发防护、预检、熔断 | guards.ts, agent-manager.ts, llm-client.ts |

### TC 编号规则

```
TC-{模块ID}-{序号}
例: TC-APP-001, TC-PIP-005
```

---

## 二、测试用例清单

### TC-APP: 应用启动与基础设施 (10 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-APP-001 | 应用首次启动 | 全新安装(无DB) | 双击启动 AutoMater | 主窗口正常显示，无白屏，无crash。显示空项目列表页 | P0 |
| TC-APP-002 | DB 迁移正确执行 | 旧版DB或全新 | 启动应用 | `schema_version` 表存在，所有迁移按序执行完毕。9张表结构完整 | P0 |
| TC-APP-003 | ErrorBoundary 生效 | 应用已启动 | 模拟前端组件异常(如手动修改store数据类型) | 显示降级错误UI而非白屏 | P1 |
| TC-APP-004 | 品牌标识正确 | 应用已启动 | 检查标题栏、侧边栏Logo、关于页 | 显示"智械母机 AutoMater"，无残留"AgentForge"或"F"字母Logo | P0 |
| TC-APP-005 | 窗口最小化/最大化/关闭 | 应用已启动 | 操作标题栏按钮 | 窗口行为正常，关闭时进程完全退出 | P1 |
| TC-APP-006 | 二次启动(已有DB) | 之前运行过 | 关闭后重新启动 | 正常加载，之前创建的项目数据仍在 | P0 |
| TC-APP-007 | 未配置LLM时的提示 | 无LLM配置 | 启动应用 | 显示明确的"请先配置LLM"提示(amber提示条) | P1 |
| TC-APP-008 | 侧边栏状态灯 | 无LLM配置/已配置 | 观察侧边栏底部状态灯 | 未配置=黄灯，已配置且连接成功=绿灯 | P2 |
| TC-APP-009 | Canvas粒子背景渲染 | 应用已启动 | 观察背景 | Canvas粒子动效正常渲染，不卡顿 | P3 |
| TC-APP-010 | vitest单元测试通过 | 源码环境 | `pnpm test` | 71个测试全部通过(output-parser 17 + guards 42 + llm-client 12) | P0 |

### TC-SET: 设置与配置 (12 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-SET-001 | 添加OpenAI Provider | 无配置 | 填入 base URL + API Key + 选模型 → 保存 | 保存成功，刷新后配置仍在 | P0 |
| TC-SET-002 | 添加Anthropic Provider | 无配置 | 选Anthropic类型 → 填入Key → 保存 | 保存成功，协议切换为Anthropic原生格式 | P0 |
| TC-SET-003 | 连接测试 — 成功 | 有效Key已填 | 点击"测试连接" | 显示绿色成功提示+模型列表 | P0 |
| TC-SET-004 | 连接测试 — 失败 | 无效Key | 点击"测试连接" | 显示红色错误提示，说明原因 | P0 |
| TC-SET-005 | 模型名列表获取 | 有效Key | 点击"获取模型" | 下拉列表显示可用模型 | P1 |
| TC-SET-006 | 三层模型配置 | 有效Provider | 分别选择strong/worker/fast模型 → 保存 | 三个模型独立保存，显示正确 | P1 |
| TC-SET-007 | Worker数量配置 | 有效Provider | 调整parallel workers数(1~15) → 保存 | 保存成功，后续项目使用新配置 | P1 |
| TC-SET-008 | MCP Server 配置 | 无 | 添加MCP Server URL + 名称 → 保存 | 保存成功，列表显示新Server | P2 |
| TC-SET-009 | 自定义模型定价 | 无 | 添加模型名→输入价格/1K tokens → 保存 | 保存成功，后续成本计算使用此价格 | P2 |
| TC-SET-010 | 配置持久化验证 | 已保存配置 | 关闭应用→重新打开→进入设置页 | 所有配置项与保存时一致 | P0 |
| TC-SET-011 | 空Key提交校验 | 未填Key | 清空Key字段→点保存 | 阻止保存或显示警告 | P1 |
| TC-SET-012 | 特殊字符Key处理 | 有效Key含特殊字符 | 输入含`=`、`+`等特殊字符的Key → 保存 | 正确保存和还原，不被截断或转义 | P2 |

### TC-PRJ: 项目管理 (10 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-PRJ-001 | 创建新项目(最简) | LLM已配置 | 输入项目名 → 确认 | 项目创建成功，出现在列表中，工作区目录自动创建 | P0 |
| TC-PRJ-002 | 创建项目(完整选项) | LLM已配置 | 输入名称+自定义路径+GitHub模式 → 确认 | 所有选项生效 | P1 |
| TC-PRJ-003 | 项目列表显示 | 已有2+个项目 | 进入项目列表页 | 正确显示所有项目卡片(名称/状态/统计) | P0 |
| TC-PRJ-004 | 项目切换 | 已有2+项目，在A项目内 | 侧边栏点击切换到B项目 | 页面切换到B项目，所有数据刷新 | P0 |
| TC-PRJ-005 | 项目删除 | 已有项目 | 点击删除按钮 | 项目从列表消失，数据清除 | P1 |
| TC-PRJ-006 | 删除运行中项目 | 项目正在running | 尝试删除 | 先停止再删除，或拒绝删除并提示 | P1 |
| TC-PRJ-007 | 空项目列表 | 无任何项目 | 进入列表页 | 显示"还没有项目"空状态+引导创建 | P1 |
| TC-PRJ-008 | 打开工作区文件夹 | 已有项目 | 点击"打开文件夹" | 系统文件管理器打开到正确目录 | P2 |
| TC-PRJ-009 | 项目名称重复 | 已有项目A | 创建同名项目A | 阻止创建或自动追加后缀 | P2 |
| TC-PRJ-010 | 项目统计展示 | 项目已运行过 | 查看项目卡片统计 | 显示Feature数/Agent数/Token消耗/Cost | P1 |

### TC-IMP: 项目导入 (8 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-IMP-001 | 导入小型项目(<50文件) | LLM已配置，有小型代码仓库 | 选择"导入已有项目" → 选路径 → 确认 | 静态扫描完成+LLM分析完成，生成项目骨架和ARCHITECTURE.md | P1 |
| TC-IMP-002 | 导入中型项目(50~500文件) | 有中型项目 | 同上 | Phase 0-1完成，模块摘要生成，无超时 | P1 |
| TC-IMP-003 | 导入大型项目(>500文件) | 有大型项目 | 同上 | 5000文件上限生效，不卡死 | P2 |
| TC-IMP-004 | 导入进度显示 | 正在导入 | 观察OverviewPage | 显示导入进度卡片(Phase/百分比) | P1 |
| TC-IMP-005 | 导入中断恢复 | 导入中途关闭应用 | 重启应用 → 进入该项目 | 项目不卡在analyzing状态，可重试或重新开始 | P1 |
| TC-IMP-006 | 导入LLM调用失败 | 无效模型/Key过期 | 开始导入 | 错误提示明确，项目不卡死 | P1 |
| TC-IMP-007 | 导入非代码目录 | 选择一个图片/文档目录 | 开始导入 | 合理提示"未检测到代码文件"或仍完成(产出最小骨架) | P2 |
| TC-IMP-008 | 导入后开发 | 导入完成 | 提交需求 → 启动开发 | 流水线基于导入分析的上下文工作(非空白项目模式) | P1 |

### TC-WSH: 许愿与需求 (8 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-WSH-001 | 提交简单需求 | 项目已创建，LLM配置OK | 输入"做一个待办事项应用" → 提交 | 需求创建成功，出现在左侧列表 | P0 |
| TC-WSH-002 | 提交后启动开发 | 需求已提交 | 点击"开始开发"或自动启动 | 流水线启动，跳转到OverviewPage | P0 |
| TC-WSH-003 | 提交复杂需求(长文本) | 项目已创建 | 输入500+字的详细需求 | 正确处理，不截断，PM能完整接收 | P1 |
| TC-WSH-004 | 需求列表展示 | 已有多条需求 | 查看WishPage左侧 | 按时间排列，显示状态(pending/processing/done) | P1 |
| TC-WSH-005 | 空需求提交 | 项目已创建 | 不输入任何内容→点提交 | 阻止提交，显示提示 | P1 |
| TC-WSH-006 | 元Agent对话入口 | 项目已创建 | 在WishPage右侧与元Agent对话 | 能正常对话，元Agent回复合理 | P1 |
| TC-WSH-007 | 通过元Agent提需求 | 项目已创建 | 在元Agent对话中表达需求 | 元Agent识别意图并创建需求 | P2 |
| TC-WSH-008 | 续跑追加需求 | 项目已完成一轮 | 添加新需求 → 启动 | PM分诊(detectImplicitChanges)正确区分新增vs迭代 | P1 |

### TC-PIP: 流水线编排 (15 cases) ⭐ 核心

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-PIP-001 | Phase 1 — PM 需求分析 | 已提交需求并启动 | 等待Phase 1完成 | PM生成Feature清单(至少1个Feature)，状态从todo→done | P0 |
| TC-PIP-002 | Phase 2 — Architect 架构设计 | Phase 1完成 | 等待Phase 2 | 生成ARCHITECTURE.md，可在DocsPage查看 | P0 |
| TC-PIP-003 | Phase 3 — 子需求+测试规格 | Phase 2完成 | 等待Phase 3 | 每个Feature有子需求文档+测试规格 | P0 |
| TC-PIP-004 | Phase 4 — Developer实现 | Phase 3完成 | 等待至少1个Feature开发完成 | 代码文件被写入workspace，可在OutputPage查看 | P0 |
| TC-PIP-005 | Phase 4 — QA 审查 | Feature开发完成 | 等待QA审查 | QA给出pass/fail评分+评审意见 | P0 |
| TC-PIP-006 | Phase 5 — 用户验收 | 所有Feature QA通过 | 查看验收面板 | 显示验收提示和Feature列表 | P1 |
| TC-PIP-007 | 完整流水线走通 | 简单需求 | 从提交到验收完整跑通 | 全5阶段顺利完成，项目状态为delivered | P0 |
| TC-PIP-008 | 暂停/继续 | 流水线运行中 | 点击暂停 → 等5s → 点击继续 | 暂停后Agent停止工作，继续后从断点恢复 | P0 |
| TC-PIP-009 | 续跑(Resume) | 项目之前暂停/失败 | 点击"继续"按钮 | 分诊后从上次断点继续，不重复已完成的Phase | P1 |
| TC-PIP-010 | 流水线进度展示 | 流水线运行中 | 查看OverviewPage进度条 | 正确显示当前Phase + 各Feature进度 | P1 |
| TC-PIP-011 | 多Worker并行开发 | workers>1 | 启动开发 | 多个Developer同时开发不同Feature，日志交错但不混乱 | P1 |
| TC-PIP-012 | Feature锁定机制 | 多Worker运行 | 观察Board页面 | 同一Feature不被多个Worker同时锁定 | P1 |
| TC-PIP-013 | DevOps 自动构建 (G8) | Phase 4b完成 | 等待Phase 4e | DevOps检测框架→install→lint→test→build | P2 |
| TC-PIP-014 | 增量文档同步 (G6) | Phase 4b完成 | 等待Phase 4d | 基于git diff更新受影响模块摘要 | P2 |
| TC-PIP-015 | AGENTS.md 自动生成 (G15) | Phase 5 | 检查workspace目录 | AGENTS.md文件存在且内容反映当前项目 | P2 |

### TC-DEV: Developer ReAct 循环 (10 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-DEV-001 | ReAct循环启动 | Feature进入开发 | 观察Agent日志 | Developer先think规划，然后调用工具 | P0 |
| TC-DEV-002 | 文件写入工具 | Developer实现中 | 观察日志中write_file调用 | 文件正确写入workspace，内容合理 | P0 |
| TC-DEV-003 | 文件编辑工具 | 已有文件 | Developer使用edit_file | 精确替换内容，不破坏文件 | P1 |
| TC-DEV-004 | Shell命令执行 | Developer需要安装依赖 | Developer调用run_command | 命令在沙箱中执行，黑名单命令被拒绝 | P1 |
| TC-DEV-005 | think工具 | ReAct循环中 | Developer使用think | 思考过程记录在日志，不作为工具调用消耗token | P2 |
| TC-DEV-006 | task_complete终止 | Feature实现完成 | Developer调用task_complete | ReAct循环正常终止，Feature状态更新 | P0 |
| TC-DEV-007 | 最大迭代限制(25轮) | 复杂Feature | Developer持续迭代 | 达到25轮后强制终止，不无限循环 | P1 |
| TC-DEV-008 | 工具调用失败处理 | 工具返回错误 | 观察Developer反应 | Agent收到错误信息，尝试修复或换方案 | P1 |
| TC-DEV-009 | 上下文压缩触发 | 长ReAct对话 | 消息累积接近窗口限制 | 自动压缩历史消息，不截断关键信息 | P2 |
| TC-DEV-010 | batch_edit批量编辑 | 需要同时改多个文件 | Developer使用batch_edit | 多文件同时编辑成功 | P2 |

### TC-QA: QA 审查 (6 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-QA-001 | 程序化检查通过 | Feature代码已写入 | QA自动运行 | run_test/run_lint结果记录在评审中 | P0 |
| TC-QA-002 | LLM代码审查 | 程序化检查完成 | QA LLM审查代码 | 给出结构化审查意见(pass/fail+原因) | P0 |
| TC-QA-003 | QA fail后重试 | QA标记fail | 自动触发Developer修复 | Developer根据QA意见修改，最多3轮 | P1 |
| TC-QA-004 | TDD模式(G14) | 项目开启TDD | Phase 4a | QA先生成测试骨架，Developer围绕测试编码 | P2 |
| TC-QA-005 | 硬规则评分 | QA审查中 | 检查评分逻辑 | 测试失败=硬规则fail(不依赖LLM判断) | P1 |
| TC-QA-006 | 三轮修复失败后终态 | Developer修复3次仍fail | 等待结果 | Feature标记为failed，不无限重试 | P1 |

### TC-NAV: 导航与布局 (8 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-NAV-001 | 侧边栏12项导航 | 进入项目 | 依次点击12个Tab | 每个Tab正确切换到对应页面，无白屏 | P0 |
| TC-NAV-002 | 品牌名称全量检查 | 应用已启动 | 遍历所有页面标题/提示文字 | 无"AgentForge"残留，全部为"AutoMater"或"智械母机" | P0 |
| TC-NAV-003 | 侧边栏Logo | 应用已启动 | 查看Logo | 显示"A"或AutoMater图标，非"F" | P0 |
| TC-NAV-004 | 项目级vs全局导航 | 在项目内/列表页 | 切换项目/返回列表 | 导航层级清晰，当前位置明确 | P1 |
| TC-NAV-005 | 页面切换性能 | 有运行中项目 | 快速切换多个Tab | 切换无明显延迟(<500ms)，无闪烁 | P2 |
| TC-NAV-006 | 元Agent全局面板 | 任意页面 | 展开/收起右侧面板 | 面板平滑展开/收起，对话历史保持 | P1 |
| TC-NAV-007 | 响应式布局 | 窗口不同尺寸 | 调整窗口大小 | 内容自适应，无溢出或重叠 | P2 |
| TC-NAV-008 | StatusBar显示 | 有运行中项目 | 查看底部状态栏 | 正确显示Features/Agents/Tokens/Cost | P1 |

### TC-OVW: 全景仪表盘 (8 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-OVW-001 | 架构图渲染 | 项目有ARCHITECTURE.md | 查看架构图区域 | SVG DAG正确渲染，节点和连线清晰 | P1 |
| TC-OVW-002 | 架构图交互 | 架构图已渲染 | 滚轮缩放/拖拽/双击下钻 | 交互流畅，面包屑导航正确 | P2 |
| TC-OVW-003 | 进度环形图 | 有Feature数据 | 查看进度区域 | 环形图显示完成比例，5个统计卡数据正确 | P1 |
| TC-OVW-004 | 实时监控面板 | 应用运行中 | 查看系统监控 | CPU/内存等数据实时更新 | P2 |
| TC-OVW-005 | 流水线进度条 | 流水线运行中 | 查看进度条 | 当前Phase高亮，已完成Phase标记勾选 | P1 |
| TC-OVW-006 | Feature路线图 | 有Feature数据 | 查看路线图列表 | 显示所有Feature+状态+优先级 | P1 |
| TC-OVW-007 | 启动/暂停按钮 | 项目就绪 | 点击启动/暂停 | 按钮状态切换，流水线启动/停止 | P0 |
| TC-OVW-008 | 轮询刷新(5s) | 流水线运行中 | 等待5s观察 | 数据自动刷新，无明显卡顿 | P1 |

### TC-BRD: 看板视图 (5 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-BRD-001 | 看板列渲染 | 有Feature数据 | 进入BoardPage | 5列正确显示(todo/dev/review/pass/fail) | P0 |
| TC-BRD-002 | Feature卡片内容 | 有Feature | 查看卡片 | 显示名称/状态/优先级/assigned agent | P1 |
| TC-BRD-003 | Feature状态实时更新 | 流水线运行中 | 观察卡片移动 | Feature卡片随状态变化在列间移动 | P1 |
| TC-BRD-004 | 轮询刷新(4s) | 流水线运行中 | 等待4s | 数据自动更新，卡片位置变化 | P2 |
| TC-BRD-005 | 空看板 | 新项目无Feature | 进入BoardPage | 显示合理的空状态 | P2 |

### TC-DOC: 文档管理 (5 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-DOC-001 | 5级文档树渲染 | 有设计/需求/测试文档 | 进入DocsPage | 树结构正确展示5级(总览/系统/功能/子需求/测试) | P1 |
| TC-DOC-002 | 文档内容预览 | 有文档 | 点击某文档节点 | 右侧显示Markdown渲染的文档内容 | P1 |
| TC-DOC-003 | 文档版本历史 | 有多版本文档 | 右键查看版本历史 | 显示版本列表，可切换查看 | P2 |
| TC-DOC-004 | 空文档树 | 新项目未运行 | 进入DocsPage | 显示"暂无文档"空状态 | P2 |
| TC-DOC-005 | Markdown渲染质量 | 有复杂文档 | 查看含表格/代码块/列表的文档 | 渲染基本正确(已知自实现渲染器有局限) | P2 |

### TC-OUT: 代码产出 (4 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-OUT-001 | 文件树渲染 | 有代码产出 | 进入OutputPage | workspace目录树正确展示 | P1 |
| TC-OUT-002 | 代码预览 | 有文件 | 点击文件节点 | 右侧显示代码内容(语法高亮) | P1 |
| TC-OUT-003 | 打开文件夹 | 有代码产出 | 点击"打开文件夹" | 系统文件管理器打开workspace | P1 |
| TC-OUT-004 | 空产出 | 未开发 | 进入OutputPage | 显示空状态 | P2 |

### TC-LOG: 日志系统 (5 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-LOG-001 | 实时日志展示 | 流水线运行中 | 进入LogsPage | 日志实时滚动更新 | P0 |
| TC-LOG-002 | 按Agent过滤 | 有多Agent日志 | 选择某Agent过滤 | 只显示该Agent的日志 | P1 |
| TC-LOG-003 | 关键词搜索 | 有日志内容 | 输入关键词搜索 | 匹配的日志高亮显示 | P1 |
| TC-LOG-004 | 日志持久化 | 项目运行后 | 关闭应用→重启→查看日志 | 历史日志仍可查看 | P1 |
| TC-LOG-005 | 大量日志性能 | 1000+条日志 | 滚动浏览 | 无明显卡顿 | P2 |

### TC-WKF: 工作流预设 (8 cases) 🆕 v12.0

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-WKF-001 | 预设列表展示 | 有内置预设 | 进入WorkflowPage | 显示预设列表+1/3高度可视化预览 | P1 |
| TC-WKF-002 | 应用内置预设 | 有内置预设 | 选择预设→应用到项目 | 流水线按预设阶段执行 | P1 |
| TC-WKF-003 | 创建自定义预设 | 无 | 点击创建→编辑阶段→保存 | 新预设出现在列表中 | P1 |
| TC-WKF-004 | 编辑预设阶段顺序 | 有自定义预设 | 使用上移/下移调整顺序 | 阶段顺序正确更新 | P2 |
| TC-WKF-005 | 删除预设 | 有自定义预设 | 删除自定义预设 | 从列表移除(内置预设不可删除) | P2 |
| TC-WKF-006 | 预设可视化预览 | 有预设 | 查看预览区 | 1/3高度流程图正确渲染各阶段 | P2 |
| TC-WKF-007 | 工作流驱动引擎 | 应用了预设 | 启动项目 | orchestrator按预设阶段顺序执行 | P1 |
| TC-WKF-008 | 临时工作流(Mission) | 项目已运行 | 创建Ephemeral Mission | Planner→Worker→Judge流程完成 | P2 |

### TC-TEM: 团队管理 (6 cases) 🆕 v9.0

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-TEM-001 | 默认团队展示 | 新项目 | 进入TeamPage | 显示默认团队(PM/Architect/Developer/QA/DevOps) | P1 |
| TC-TEM-002 | Agent实时状态 | 流水线运行中 | 查看TeamPage | Agent卡片显示当前状态(idle/working/waiting) | P1 |
| TC-TEM-003 | Agent统计信息 | 项目运行过 | 查看Agent卡片 | 显示token消耗/cost/完成feature数 | P1 |
| TC-TEM-004 | 热加入(Hot-Join) | 流水线运行中 | 添加新Developer | 新Worker加入运行中的开发流程 | P1 |
| TC-TEM-005 | 自定义角色 | TeamPage配置Tab | 添加角色+System Prompt | 保存成功，新角色出现在团队中 | P2 |
| TC-TEM-006 | Agent工作Feed | 流水线运行中 | 点击某Agent→查看工作动态 | 展示对话式工作日志(think/tool/result) | P1 |

### TC-META: 元 Agent (6 cases) 🆕 v9.0

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-META-001 | 全局面板打开 | 任意页面 | 点击右侧展开按钮 | 元Agent面板展开，显示对话界面 | P1 |
| TC-META-002 | 基础对话 | 面板已展开 | 输入"你好" → 发送 | 元Agent回复合理，对话流畅 | P1 |
| TC-META-003 | 意图检测—需求 | 面板已展开 | 输入"帮我做一个计算器" | 识别为wish意图，引导创建需求 | P1 |
| TC-META-004 | 意图检测—查询 | 面板已展开 | 输入"项目有多少Feature" | 识别为query意图，返回项目信息 | P2 |
| TC-META-005 | 意图检测—控制 | 面板已展开 | 输入"暂停项目" | 识别为control意图，执行暂停 | P2 |
| TC-META-006 | WishPage vs 全局面板一致性 | 打开两处 | 在一处发消息 | 两处对话历史同步(共享store) | P1 |

### TC-CTX: 上下文管理 (4 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-CTX-001 | 上下文模块列表 | 项目有上下文数据 | 进入ContextPage | 显示双栏布局(模块列表+内容预览) | P2 |
| TC-CTX-002 | Hot/Warm/Cold分层 | 项目已运行 | 查看上下文详情 | 明确显示三层(始终加载/索引/按需) | P2 |
| TC-CTX-003 | 上下文压缩 | 长时间运行 | 点击压缩按钮(如有) | 上下文被压缩，token使用降低 | P2 |
| TC-CTX-004 | 基线预览 | 项目未运行 | 进入ContextPage | 显示固定加载模块+剩余空间 | P2 |

### TC-TML: 时间线与分析 (4 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-TML-001 | 事件时间线 | 项目运行过 | 进入TimelinePage | 显示事件列表(25种事件类型) | P2 |
| TC-TML-002 | 分析Tab | 有事件数据 | 切换到分析Tab | 显示统计分析图表 | P2 |
| TC-TML-003 | 检查点Tab | 有checkpoint | 切换到检查点Tab | 显示mission检查点列表 | P2 |
| TC-TML-004 | 知识库Tab | 有跨项目知识 | 切换到知识库Tab | 显示全局知识池条目 | P3 |

### TC-GIT: Git 集成 (5 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-GIT-001 | 自动Git初始化 | 新项目 | 项目开始开发 | workspace自动git init | P1 |
| TC-GIT-002 | 自动commit | Feature完成 | 检查git log | 自动生成commit(包含Feature信息) | P1 |
| TC-GIT-003 | GitHub push | 配置GitHub Token | 完成Feature后 | 代码自动push到GitHub | P2 |
| TC-GIT-004 | 导出zip | 项目完成 | 点击导出 | 生成workspace的zip包 | P2 |
| TC-GIT-005 | Git冲突处理 | 多Worker同时写 | 观察git操作 | 无冲突或冲突被合理处理 | P2 |

### TC-LLM: LLM 调用层 (8 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-LLM-001 | OpenAI流式调用 | OpenAI Provider配置OK | 启动开发 | SSE流式响应正常，token实时更新 | P0 |
| TC-LLM-002 | Anthropic流式调用 | Anthropic Provider | 启动开发 | Anthropic原生协议调用正常 | P1 |
| TC-LLM-003 | 非流式调用 | 任意Provider | 触发非流式场景 | 正常返回完整响应 | P1 |
| TC-LLM-004 | Function-calling | Developer ReAct中 | 工具调用 | 正确格式化tool_use/tool_result | P0 |
| TC-LLM-005 | 重试与退避 | 模拟临时网络错误 | 观察重试行为 | 指数退避重试(最多3次) | P1 |
| TC-LLM-006 | NonRetryableError熔断 | 无效模型名 | 尝试调用 | 立即返回错误，不重试 | P0 |
| TC-LLM-007 | 模型三层选择 | 配置了strong/worker/fast | 观察各Phase使用的模型 | PM/QA用strong，Developer用worker，快速任务用fast | P1 |
| TC-LLM-008 | Token/Cost统计 | 运行中 | 查看StatusBar和Agent统计 | 累计token和cost数据准确 | P1 |

### TC-SBX: 沙箱执行 (4 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-SBX-001 | 正常命令执行 | Developer调用run_command | 执行 `npm install` | 命令在workspace内正常执行 | P1 |
| TC-SBX-002 | 黑名单命令拦截 | Developer尝试危险命令 | 执行 `rm -rf /` 或 `format` | 命令被拒绝，返回错误 | P1 |
| TC-SBX-003 | 路径遍历防护(G2) | Developer尝试路径穿越 | 读取 `../../etc/passwd` | 路径穿越被检测并拒绝 | P1 |
| TC-SBX-004 | 命令超时 | Developer执行长时间命令 | 执行超时命令 | 60秒后强制终止 | P2 |

### TC-ERR: 错误处理与韧性 (10 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-ERR-001 | 并发启动防护 | 项目已运行 | 再次点击启动 | 被拦截，不重复启动orchestrator | P0 |
| TC-ERR-002 | 并发防护UI反馈 | 项目已运行 | 快速双击启动 | 1.5s防抖+提示"项目已在运行中" | P1 |
| TC-ERR-003 | 模型预检(Pre-flight) | 配置无效模型 | 启动项目 | 预检发现模型不可用，阻止启动并提示 | P0 |
| TC-ERR-004 | 熔断器触发 | 连续3次LLM失败 | 自动重试后 | 熔断器打开，Feature标记failed+记录原因 | P0 |
| TC-ERR-005 | 熔断器恢复 | 熔断后修改模型 | 重新启动 | 熔断器reset，允许新请求 | P1 |
| TC-ERR-006 | 续跑死循环防护 | Feature failed(模型不可用) | 不改配置直接续跑 | 检测到失败原因未变，拒绝重试该Feature | P0 |
| TC-ERR-007 | API Key过期 | Key失效 | 运行中Key过期 | 错误分类为NonRetryable，提示用户更新Key | P1 |
| TC-ERR-008 | 网络断开 | 断开网络 | 运行中断网 | 超时后标记错误，网络恢复后可继续 | P1 |
| TC-ERR-009 | Output解析失败 | LLM返回非JSON | 观察output-parser | 多策略修复(JSON extraction + schema repair) | P1 |
| TC-ERR-010 | ErrorBoundary捕获 | 前端组件异常 | 触发渲染错误 | 显示错误降级UI，非白屏 | P1 |

### TC-SES: 会话管理 (4 cases) 🆕 v9.0

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-SES-001 | 对话备份 | 元Agent有对话记录 | 触发备份(自动或手动) | 对话记录被保存 | P2 |
| TC-SES-002 | 备份恢复 | 有备份记录 | 恢复某次备份 | 对话历史恢复到备份点 | P2 |
| TC-SES-003 | 会话列表 | 有多次会话 | 查看会话列表 | 显示时间/摘要/状态 | P2 |
| TC-SES-004 | 会话切换 | 有多个会话 | 切换到旧会话 | 加载旧会话的上下文和对话 | P2 |

### TC-MEM: 持久记忆 (4 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-MEM-001 | 自动经验记录 | 项目完成一轮 | 检查记忆系统 | 自动提取lessons learned | P2 |
| TC-MEM-002 | 跨项目经验注入 | 有旧项目经验 | 新项目启动 | 相关技术标签的经验被注入新项目context | P2 |
| TC-MEM-003 | 三层记忆结构 | 有记忆数据 | 查看记忆 | Global/Project/Role三层分明 | P2 |
| TC-MEM-004 | memory_read/write工具 | Developer ReAct中 | Agent使用记忆工具 | 正确读写项目级记忆 | P2 |

### TC-GDE: 新手教程 (3 cases)

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-GDE-001 | 教程页面渲染 | 应用已启动 | 进入GuidePage | 8篇教程标题列表正确显示 | P2 |
| TC-GDE-002 | 教程内容展开 | 在GuidePage | 点击某篇教程 | 内容正确渲染，无空白 | P2 |
| TC-GDE-003 | 教程入口可达 | 任意页面 | 找到教程入口 | 可通过侧边栏导航到GuidePage | P2 |

### TC-MON: 系统监控 (3 cases) 🆕

| TC | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|----|--------|---------|---------|---------|--------|
| TC-MON-001 | 监控数据获取 | 应用运行中 | 查看OverviewPage监控区 | CPU/内存数据显示且实时更新 | P2 |
| TC-MON-002 | 进程内存统计 | 应用运行中 | 查看进程内存 | 显示Electron进程内存用量 | P3 |
| TC-MON-003 | 长时间运行稳定性 | 流水线运行>10min | 观察监控数据 | 内存无明显泄漏，CPU不持续高位 | P2 |

---

## 三、测试执行策略

### 3.1 分轮执行计划

| Round | 聚焦 | 模块 | 预估用例数 | 阈值 |
|-------|------|------|-----------|------|
| **R1: 冒烟测试** | 应用能否启动和创建项目 | APP + SET + PRJ | 22 | 全P0通过 |
| **R2: 核心流程** | 流水线能否走通 | WSH + PIP + DEV + QA + LLM | 47 | P0全通过，P1≥80% |
| **R3: 辅助功能** | 导入/元Agent/工作流/团队 | IMP + META + WKF + TEM | 28 | P1≥80% |
| **R4: 浏览与展示** | 各页面渲染和交互 | NAV + OVW + BRD + DOC + OUT + LOG | 35 | P1≥90% |
| **R5: 韧性与边界** | 错误处理/防护/记忆 | ERR + SBX + GIT + MEM + SES + CTX + TML | 35 | P0全通过 |
| **R6: 体验打磨** | 教程/监控/性能 | GDE + MON + 回归 | 10+ | ≥90%总通过率 |

### 3.2 环境要求

| 项 | 要求 |
|----|------|
| 操作系统 | Windows 10/11 |
| Node.js | 18+ |
| pnpm | 8+ |
| LLM Provider | 至少一个有效的 OpenAI Compatible 或 Anthropic API Key |
| 测试项目 | 1个小型代码仓库(用于导入测试) |
| 网络 | 可访问 LLM API |
| 屏幕分辨率 | 1920×1080 推荐 |

### 3.3 测试数据准备

| 数据 | 用途 | 准备方式 |
|------|------|---------|
| 简单Wish | "做一个待办事项应用" | 手动输入 |
| 复杂Wish | 500+字详细需求 | 预先编写 |
| 小型代码仓库 | 导入测试 | Git clone 一个公开小项目 |
| 无效API Key | 错误测试 | 使用过期或伪造Key |
| 无效模型名 | 熔断测试 | 使用不存在的模型名 |

---

## 四、Bug Issue 模板与流程

### Bug 生命周期

```
needs-triage → confirmed → in-progress → needs-retest → verified → [CLOSED]
                    ↘ duplicate/wontfix → [CLOSED]         ↘ 复测失败 → in-progress
```

### 验收 Issue 流程

1. 按模块创建 `[Test] TC-{模块} — 日期` Issue
2. 逐条执行用例，填写结果：✅通过 ❌失败 ⚠️有问题 ⏭️跳过
3. ❌项创建关联 Bug Issue
4. 写总结(通过率/关联Bug/评估)
5. 标记 `test-pass`/`test-fail`/`test-partial` → Close

---

## 五、里程碑映射

| Milestone | 条件 | 对应 Round |
|-----------|------|-----------|
| `v6.0-smoke` | R1 全P0通过 | R1 |
| `v6.0-pipeline` | R2 P0全通过 + P1≥80% | R2 |
| `v6.0-beta` | R1-R5 所有P0归零 + P1≥85% | R1-R5 |
| `v6.0-release` | 全部TC≥95%通过 | R1-R6 |

---

## 六、统计总览

| 优先级 | 用例数 | 占比 |
|--------|--------|------|
| P0 | 32 | 18.5% |
| P1 | 72 | 41.6% |
| P2 | 56 | 32.4% |
| P3 | 13 | 7.5% |
| **总计** | **173** | 100% |

| 模块 | 用例数 | 模块 | 用例数 |
|------|--------|------|--------|
| APP | 10 | OVW | 8 |
| SET | 12 | BRD | 5 |
| PRJ | 10 | DOC | 5 |
| IMP | 8 | OUT | 4 |
| WSH | 8 | LOG | 5 |
| PIP | 15 | WKF | 8 |
| DEV | 10 | TEM | 6 |
| QA | 6 | META | 6 |
| NAV | 8 | CTX | 4 |
| LLM | 8 | TML | 4 |
| SBX | 4 | GIT | 5 |
| ERR | 10 | MEM | 4 |
| SES | 4 | GDE | 3 |
| MON | 3 | | |

---

## 七、附录：与产品体验复盘的交叉引用

以下 42 个体验问题(来自 `docs/product-experience-review-2026-03.md`)在本测试计划中的覆盖情况：

| 复盘问题 | 覆盖TC | 备注 |
|----------|--------|------|
| P0-01 无Onboarding | TC-APP-001, TC-APP-007 | 验证当前状态 |
| P0-02 LLM配置门槛 | TC-SET-001~004 | 验证功能正确性 |
| P0-06 未经运行时验证 | 整个测试计划 | 这是本计划的核心目标 |
| P0-07 品牌残留"F" | TC-NAV-002, TC-NAV-003 | 全量品牌检查 |
| P0-19 错误消息不友好 | TC-ERR-003~010 | 验证错误信息 |
| P1-08 并发防护UI缺失 | TC-ERR-001, TC-ERR-002 | 验证防护+UI反馈 |
| P1-09 熔断不可见 | TC-ERR-004~006 | 验证熔断机制 |
| P1-10 续跑无分诊展示 | TC-PIP-009 | 验证续跑行为 |
| P1-20 删除无确认 | TC-PRJ-005, TC-PRJ-006 | 验证删除流程 |
| P1-21 导入失败无恢复 | TC-IMP-005, TC-IMP-006 | 验证错误恢复 |
| P1-22 轮询过于激进 | TC-OVW-008, TC-BRD-004 | 验证刷新行为 |
| P1-31 元Agent入口重复 | TC-META-006 | 验证一致性 |

> 体验改善类建议(非功能缺陷)不在黑盒TC中覆盖，待功能验证通过后作为enhancement处理。
