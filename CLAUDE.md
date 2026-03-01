# AgentForge — 项目大脑

## 1. PRIME DIRECTIVE

**当前阶段**: Phase 1 — MVP 骨架搭建
**最高优先级**: 完成 Tauri 桌面应用基础框架 + Agent 引擎核心
**MUST NOT**: 不做过度设计，先跑通最小闭环

## 2. PROJECT IDENTITY

**产品**: AgentForge — Agent 集群式软件开发桌面应用
**定位**: "AI 软件开发公司"，用户许愿，虚拟团队交付

### 技术栈
| 层 | 技术 |
|----|------|
| Desktop | Tauri 2.x (Rust + WebView) |
| Frontend | React 19 + TypeScript + Vite + shadcn/ui + Tailwind |
| State | Zustand |
| Agent Engine | TypeScript (Node sidecar) |
| LLM | 统一适配层 (OpenAI / Anthropic / local / custom) |
| Database | SQLite (Tauri plugin-sql) |
| Build | pnpm workspace monorepo + tsup |

### 架构
```
apps/desktop (Tauri) → Node sidecar → @agentforge/core + llm + sandbox
packages/shared      — 公共类型 + 事件总线
packages/llm         — LLM 多 Provider 适配
packages/core        — Agent 引擎 (Orchestrator + FeatureSelector + Evaluator)
packages/sandbox     — 代码执行沙箱 (TODO)
```

## 3. ACTIVE DECISIONS

| # | 决策 | 理由 |
|---|------|------|
| ADR-001 | 选择 Tauri 而非 Electron | 轻量(~10MB vs ~150MB)、安全(Rust后端)、性能好 |
| ADR-002 | Agent 引擎用 TypeScript 而非 Rust | LLM SDK 生态在 Node 更丰富 (openai, anthropic SDK) |
| ADR-003 | 两层 Feature 清单 | 防止 LLM 上下文溢出，索引轻量+详情按需加载 |
| ADR-004 | 事件驱动 + 文件系统双通道通信 | 实时性(事件) + 持久化(文件) |

## 4. CURRENT STATE

- [x] DESIGN.md 设计文档完成
- [x] monorepo 工程骨架创建
- [x] @agentforge/shared 类型系统完成
- [x] @agentforge/llm 适配层完成 (OpenAI + Anthropic)
- [x] @agentforge/core 核心引擎完成 (Orchestrator + FeatureSelector + Evaluator + AgentRunner)
- [x] Prompt 模板完成 (6个角色)
- [ ] Tauri 桌面应用 (apps/desktop)
- [ ] React 前端 UI
- [ ] SQLite 数据持久化
- [ ] @agentforge/sandbox 代码沙箱

## 5. AGENT GUIDELINES

### 必读文件
1. `CLAUDE.md` (本文件)
2. `DESIGN.md` (完整设计文档)
3. 相关 package 的 `package.json`

### 提交规范
- `feat:` 新功能
- `fix:` 修复
- `refactor:` 重构
- `docs:` 文档
- `test:` 测试

### Context 预算
- 单次对话不超过 64K tokens
- 长文件分块读取，不一次性全量加载
- 输出精简，详细日志写文件
