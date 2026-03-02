# Contributing to 智械母机 AutoMater

感谢你对 AutoMater 的兴趣！以下是参与贡献的指南。

## 环境准备

```bash
# 要求
node >= 20.0.0
pnpm >= 9.0.0

# 安装
pnpm install

# 开发
pnpm dev          # 启动 Vite dev server + Electron

# 质量检查
pnpm typecheck    # TypeScript 类型检查
pnpm lint         # ESLint
pnpm test         # 单元测试
pnpm test:coverage # 覆盖率 (有最低阈值门禁)
```

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式:

| 前缀 | 用途 |
|------|------|
| `feat:` | 新功能 |
| `fix:` | 修复 |
| `refactor:` | 重构 |
| `docs:` | 文档 |
| `test:` | 测试 |
| `chore:` | 构建/工具 |

示例: `feat: add admin mode tool execution`

## Pre-commit Hook

项目使用 Husky + lint-staged 自动在提交前运行:
- TypeScript 类型检查
- ESLint 自动修复
- Prettier 格式化

## 项目结构

```
electron/         # Electron 主进程 (引擎 + IPC)
├── engine/       # Agent 引擎核心 (工具/循环/记忆/编排)
├── ipc/          # IPC Handler (前后端通信)
└── main.ts       # 入口
src/              # React 渲染进程
├── pages/        # 页面组件
├── components/   # 共享组件
├── stores/       # Zustand 状态管理
└── utils/        # 工具函数
docs/             # 设计文档 + 审计报告
scripts/          # 构建/质量门禁脚本
```

## 关键文件

开发前请先阅读 `CLAUDE.md` — 它是项目的单一事实源 (Single Source of Truth)。

## 测试

- 测试文件与源码同目录: `foo.ts` → `foo.test.ts`
- 使用 vitest: `pnpm test:watch` 开发时持续运行
- 覆盖率阈值: 见 `vitest.config.ts` (CI 强制)
