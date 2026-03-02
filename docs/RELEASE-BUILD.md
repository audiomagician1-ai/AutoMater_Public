# 发布构建指南

> Windows 环境下构建干净的安装包 / 便携压缩包

## 快速开始

```powershell
# 仅生成 解压即用 ZIP（推荐，最快）
pnpm release:zip

# 生成 ZIP + NSIS 安装包
pnpm release
```

## 产出物

| 文件 | 说明 | 用途 |
|------|------|------|
| `release/win-unpacked/` | 解压即用目录 | 本地测试、内部分发 |
| `release/AutoMater-{ver}-win-x64.zip` | 便携压缩包 | 解压即用，无需安装 |
| `release/AutoMater-{ver}-win-x64-setup.exe` | NSIS 安装包 | 正式安装，含卸载程序 |

## 构建流程详解

脚本位置: `scripts/release-build.js`

```
Phase 1  清理旧产物     删除 dist/ dist-electron/ release/，避免旧哈希文件混入
Phase 2  Vite 构建      前端 + Electron 主进程（启用 minify，关闭 sourcemap）
Phase 3  清理残留        删除 .js.map，确认无多余文件
Phase 4  准备依赖        替换 pnpm 符号链接为真实拷贝（playwright-core 等）
Phase 5  electron-builder  打包为 win-unpacked 目录
Phase 6  生成 ZIP        将 win-unpacked 压缩为便携 ZIP
Phase 7  NSIS 安装包     可选，--no-installer 跳过
Phase 8  最终校验        扫描敏感文件（.env .db .log 等），统计产出大小
```

## 命令参数

```powershell
node scripts/release-build.js [选项]

  --no-installer    跳过 NSIS 安装包生成（省时间）
  --keep-sourcemap  保留 .js.map 文件（调试用）
```

## 隐私安全

构建脚本确保产物**不包含**：

- ❌ `.env` / API Key / 密钥文件
- ❌ SQLite 数据库（用户数据存储在 `%APPDATA%/automater/`，不在安装目录）
- ❌ 日志文件
- ❌ sourcemap（默认删除，`--keep-sourcemap` 可保留）
- ❌ 旧版本构建残留（每次构建前完整清理 dist）

### 用户数据位置

应用的所有运行时数据都存储在 `%APPDATA%/automater/`，与安装目录完全隔离：

```
%APPDATA%/automater/
├── data/automater.db          # SQLite 数据库
├── workspaces/                # 项目工作空间
├── conversation-backups/      # 对话备份
├── evolved-skills/            # 进化技能
├── global-memory.md           # 全局记忆
└── (Electron 缓存目录...)
```

## 前置环境

| 依赖 | 版本 | 安装命令 |
|------|------|----------|
| Node.js | ≥ 20 | `winget install OpenJS.NodeJS` |
| pnpm | ≥ 9 | `npm i -g pnpm` |
| NSIS | 最新 | `choco install nsis`（仅安装包需要） |

## 常见问题

### Q: 构建出的 ZIP 很大（~130MB）
Electron 自带 Chromium 运行时，这是正常大小。主要组成：

- Electron + Chromium: ~200MB（解压后）
- better-sqlite3 native addon: ~10MB
- 应用代码: ~1MB
- node_modules 运行时依赖: ~50MB

### Q: 打包时报 better-sqlite3 rebuild 错误
需要安装 C++ 编译工具：
```powershell
npm install -g windows-build-tools
# 或
winget install Microsoft.VisualStudio.2022.BuildTools
```

### Q: 想发布到新机器上测试
1. 解压 ZIP 到任意目录
2. 双击 `智械母机 AutoMater.exe` 运行
3. 首次运行会自动在 `%APPDATA%/automater/` 创建数据目录
4. 进入设置页配置 LLM API Key

### Q: 如何清理构建缓存重新来
```powershell
Remove-Item -Recurse -Force dist, dist-electron, release
pnpm release:zip
```

## 版本号管理

版本号来源于 `package.json` 的 `version` 字段。更新版本：

```powershell
# 手动编辑 package.json 的 version 字段
# 或使用 npm version
npm version patch   # 13.0.0 → 13.0.1
npm version minor   # 13.0.0 → 13.1.0
npm version major   # 13.0.0 → 14.0.0
```
