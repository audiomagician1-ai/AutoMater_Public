/**
 * GuidePage — 内置教程文档中心
 *
 * 面向非程序员的全面使用指南，覆盖：
 * 1. 快速上手         2. 导入已有项目
 * 3. LLM 配置         4. GitHub 配置
 * 5. MCP 工具配置     6. 许愿与需求管理
 * 7. 团队与 Agent     8. 文档与产出
 * 9. 常见问题
 */

import { useState } from 'react';

// ═══════════════════════════════════════
// Guide data
// ═══════════════════════════════════════

interface GuideSection {
  id: string;
  icon: string;
  title: string;
  content: string;         // Markdown-ish
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
点击左侧栏底部的 ⚙️ 设置按钮，填入你的 AI 模型密钥（API Key）。如果你不知道怎么获取，请参考下一章「LLM 配置指南」。

**第二步 — 创建项目**
回到项目列表页，点击「＋ 新建项目」，输入项目名即可。工作区路径会自动生成，通常不用修改。

**第三步 — 许愿**
进入项目后，在「✨ 许愿」页面用自然语言描述你想要什么。例如：
- "帮我做一个待办事项 App，支持添加、删除、标记完成"
- "做一个个人博客网站，要有暗色主题"
- "做一个简单的记账本程序"

然后点击「🚀 启动开发」，Agent 团队就会开始工作！

### 界面导览

| 页面 | 用途 |
|------|------|
| 🗺️ 全景 | 总控制台，查看项目进度和架构 |
| ✨ 许愿 | 输入需求，和管家对话 |
| 📋 看板 | Feature 任务看板 |
| 📄 文档 | 自动生成的设计文档 |
| 🔄 工作流 | Agent 工作流水线（支持多种预设和自定义） |
| 👥 团队 | 查看和配置各 Agent（支持动态添加成员） |
| 📦 产出 | 查看生成的源代码 |
| 📜 日志 | 实时运行日志 |

> 💡 **提示**：不确定的地方都可以保持默认，AutoMater 会自动处理大部分配置。`,
  },
  {
    id: 'import-project',
    icon: '📥',
    title: '导入已有项目',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 把现有代码交给 Agent 团队

如果你已经有一个代码项目（无论是自己写的还是接手的），可以将它导入 AutoMater。Agent 团队会自动深度分析项目结构，生成架构文档，然后就能基于现有代码继续开发新功能。

### 适用场景

- 🔧 想给现有项目**添加新功能**
- 📖 接手了别人的代码，想**快速理解架构**
- 🏗️ 项目越来越复杂，想让 AI **辅助重构**
- 📝 缺少文档，想**自动生成架构文档**

### 导入步骤

**第一步 — 确保已配置 LLM**
导入分析需要调用 AI 模型，请先完成「🔑 LLM 配置」。

**第二步 — 点击「📥 导入已有项目」**
在项目列表页，点击右上角的「📥 导入已有项目」按钮。

**第三步 — 选择项目路径**
点击 📂 按钮选择你的代码项目根目录（就是包含 \`package.json\`、\`Cargo.toml\` 等文件的那个目录）。项目名称会自动填充，你也可以手动修改。

**第四步 — 开始导入分析**
点击「📥 开始导入分析」，系统会自动跳转到项目全景页面，你可以实时观看分析进度。

### 分析流程（三阶段）

导入分析采用多探针并行探索技术，分三个阶段自动完成：

| 阶段 | 耗时 | 做什么 |
|------|------|--------|
| Phase 0: 骨架扫描 | ~1-2 秒 | 扫描目录结构、检测技术栈、构建代码依赖图、识别入口文件 |
| Phase 1: 并行探测 | ~30 秒 - 3 分钟 | 多个 AI 探针同时从不同角度分析项目（入口追踪、模块纵深、API 边界等） |
| Phase 2: 拼图合成 | ~10-30 秒 | 用更强的 AI 模型综合所有探针报告，生成最终的架构文档和模块图 |

在全景页面你会看到实时进度条，包括每个探针的状态（排队/运行/完成）、覆盖率和费用。

### 六类探针

系统会根据项目规模自动安排不同类型的探针：

| 探针 | 分析内容 |
|------|----------|
| 🚪 入口追踪 | 从 main/index 入口文件出发，沿依赖链追踪"系统是怎么跑起来的" |
| 📦 模块纵深 | 分析核心模块的职责、公开接口和关键数据结构 |
| 🌐 API 边界 | 找出所有对外接口（路由、IPC handler 等），追踪数据流向 |
| 💾 数据模型 | 发现核心数据类型、Schema 定义、数据库模型 |
| ⚙️ 配置基础设施 | 分析配置文件、中间件、构建管道、部署结构 |
| 🔍 异常检测 | 发现 TODO/HACK 标记、超大文件、循环依赖等技术债 |

探针数量根据项目规模自动调节：200-500 文件约 8-12 个，500-2000 文件约 15-25 个。

### 导入产出

分析完成后，系统会在项目中生成以下文件：

- **ARCHITECTURE.md** — 完整的系统架构文档（有具体函数名和类型名，不是空话）
- **module-graph.json** — 结构化模块关系图，供 Agent 后续精准理解代码
- **KNOWN-ISSUES.md** — 技术债和潜在风险清单
- **skeleton.json** — 项目骨架信息（技术栈、模块列表、入口文件等）
- **探针报告** — 每个探针的详细分析记录（在 \`.automater/analysis/probes/\` 下）

这些文件存放在项目的 \`.automater/\` 目录下，不会影响你的源代码。

### 导入后能做什么？

导入完成后，项目就和新建项目一样可以使用所有功能：

1. **许愿添加功能** — 在「✨ 许愿」页描述想要的新功能，Agent 会基于对现有代码的理解来实现
2. **查看架构文档** — 在「📄 文档」页浏览自动生成的设计文档
3. **启动开发流程** — 选择工作流（完整开发/快速迭代/质量加固）启动 Agent 团队

### 费用参考

| 项目规模 | 探针数 | 时间 | 预估费用 |
|---------|--------|------|----------|
| ~500 文件 | ~10 | 1-2 分钟 | $0.10-0.20 |
| ~1000 文件 | ~20 | 2-4 分钟 | $0.20-0.40 |
| 3000+ 文件 | ~35 | 4-8 分钟 | $0.50-1.00 |

> 💡 **提示**：导入分析的探针使用较便宜的快速模型，仅最终合成阶段使用强模型，总体费用较低。系统有预算上限保护（默认 $1.00），不会无限消耗。

### 支持的技术栈

AutoMater 可以导入几乎所有主流语言的项目：

- **前端**: TypeScript/JavaScript、React、Vue、Svelte、Next.js、Nuxt
- **后端**: Node.js、Python、Go、Rust、Java/Kotlin、C#、Ruby、PHP
- **移动端**: Swift、Kotlin
- **系统**: C/C++

> ⚠️ **注意**：导入不会修改你的任何源文件。所有分析产物都在 \`.automater/\` 目录中。如果不满意，可以直接删除该目录重新导入。`,
  },
  {
    id: 'llm-setup',
    icon: '🔑',
    title: 'LLM 配置指南',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 什么是 LLM？

LLM（大语言模型）是 AutoMater 的"大脑"。AutoMater 需要连接一个 AI 模型来理解你的需求并生成代码。

### 获取 API Key

目前支持以下模型服务：

**方式一：OpenAI（推荐新手）**
1. 打开 [platform.openai.com](https://platform.openai.com)
2. 注册账号（需要手机号验证）
3. 进入 API Keys 页面，点击「Create new secret key」
4. 复制生成的密钥（以 \`sk-\` 开头）

**方式二：Anthropic Claude**
1. 打开 [console.anthropic.com](https://console.anthropic.com)
2. 注册并进入 API Keys 页面
3. 创建密钥

**方式三：其他兼容服务**
如果你使用 DeepSeek、通义千问等国产模型，需要额外填写 API 地址。

### 在 AutoMater 中配置

1. 点击左下角 ⚙️ 进入设置
2. 在「API Key」栏粘贴你的密钥
3. 如果使用非 OpenAI 服务，还需要填写「API 地址」
4. 选择合适的模型名称
5. 点击保存

### 费用说明

- 使用 AI 模型会产生少量费用（通常几美分到几美元）
- 一个中等复杂度的项目大约花费 $0.5 - $5
- 你可以在「全景」页面实时查看费用

> ⚠️ **重要**：API Key 是你的私人凭证，请勿分享给他人。AutoMater 会安全地存储在你的本地电脑上。`,
  },
  {
    id: 'github-setup',
    icon: '🐙',
    title: 'GitHub 配置（可选）',
    difficulty: '进阶',
    diffColor: 'bg-amber-500/20 text-amber-400',
    content: `## 什么是 GitHub？

GitHub 是一个代码托管平台。配置 GitHub 后，AutoMater 生成的代码会自动同步到你的 GitHub 仓库，方便备份和分享。

**如果你不需要代码同步，可以跳过此步骤。** AutoMater 默认使用本地 Git 存储。

### 配置步骤

**1. 注册 GitHub 账号**
打开 [github.com](https://github.com)，注册一个免费账号。

**2. 创建一个空仓库**
- 点击右上角「+」→「New repository」
- 输入仓库名（如 my-project）
- 选择 Public 或 Private
- **不要**勾选 "Add a README file"
- 点击「Create repository」

**3. 生成 Personal Access Token**
- 点击右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic)
- 点击「Generate new token (classic)」
- 名称随意，如 "AutoMater"
- 勾选 \`repo\` 权限
- 点击生成，**立即复制**（只显示一次）

**4. 在新建项目时配置**
- 创建项目时选择「🐙 GitHub」模式
- 填入 \`你的用户名/仓库名\`（如 \`john/my-project\`）
- 粘贴刚才的 Token
- 点击「🔌 测试连接」确认

> 💡 Token 以 \`ghp_\` 开头。如果丢失了需要重新生成。`,
  },
  {
    id: 'mcp-setup',
    icon: '🔌',
    title: 'MCP 工具配置（可选）',
    difficulty: '进阶',
    diffColor: 'bg-amber-500/20 text-amber-400',
    content: `## 什么是 MCP？

MCP（Model Context Protocol）是一种让 AI 获得额外能力的扩展协议。通过 MCP，Agent 可以：
- 搜索网页
- 读写文件
- 执行命令
- 调用外部 API

**对于一般使用，AutoMater 已经内置了必要的工具，不需要额外配置 MCP。**

### 何时需要配置 MCP？

- 你希望 Agent 能搜索最新技术文档
- 你需要连接特定的数据库或服务
- 你想扩展 Agent 的能力

### 配置方法

1. 进入 ⚙️ 设置 → MCP 服务器
2. 点击「添加服务器」
3. 填写服务器信息：
   - **名称**：给这个工具取个名
   - **命令**：启动命令（如 \`npx @mcp/web-search\`）
   - **参数**：按需填写

### 常用 MCP 服务器

| 名称 | 命令 | 用途 |
|------|------|------|
| Web Search | \`npx @mcp/web-search\` | 网页搜索 |
| File System | \`npx @mcp/filesystem\` | 文件操作 |
| GitHub | \`npx @mcp/github\` | GitHub API |

> 💡 MCP 配置需要已安装 Node.js 环境。如果你不确定，可以先跳过。`,
  },
  {
    id: 'wish-guide',
    icon: '✨',
    title: '许愿与需求管理',
    difficulty: '入门',
    diffColor: 'bg-emerald-500/20 text-emerald-400',
    content: `## 如何写好一个需求？

AutoMater 的 PM Agent 会分析你的需求，但描述越清晰，结果越好。

### 好的需求示例

✅ "做一个待办事项管理应用，需要以下功能：
1. 添加新任务（输入任务名和截止日期）
2. 标记任务为已完成
3. 删除任务
4. 按日期筛选
使用 React + TypeScript，深色主题"

✅ "做一个天气查询网站，输入城市名显示当前天气和未来三天预报，使用卡片式布局"

### 不太好的需求

❌ "做个 App"（太模糊）
❌ "做一个像 Photoshop 一样的图片编辑器"（太复杂，建议拆分）

### 需求管理流程

1. 在「✨ 许愿」页面输入需求
2. PM Agent 自动分析，拆分为多个 Feature
3. 在「📋 看板」查看拆分结果
4. 可以继续添加新需求（支持迭代）
5. 可以和右侧的「元Agent管家」对话，调整需求

### 迭代开发

项目不必一次做完！你可以：
- 先许一个小需求，等完成后再加功能
- 在运行中追加新的许愿
- 和管家对话调整优先级`,
  },
  {
    id: 'team-guide',
    icon: '👥',
    title: '团队与 Agent 管理',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## AutoMater 的虚拟团队

每个项目都配有一支完整的 Agent 团队：

| 角色 | 职责 |
|------|------|
| 👔 产品经理 (PM) | 分析需求、拆分功能、制定计划、验收审查 |
| 🏗️ 架构师 | 设计系统架构、技术选型 |
| 💻 开发者 | 编写代码、实现功能（支持多 Worker 并行） |
| 🔍 QA 测试 | 代码审查、质量保证、TDD 测试骨架 |
| 🚀 DevOps | 部署配置、自动构建验证 |

### 工作流预设

在「🔄 工作流」页面，可以选择不同的开发流水线：
- **完整开发**：PM → 架构 → 文档 → 开发 → QA → 验收 → 构建 → 文档同步 → 交付（9 阶段）
- **快速迭代**：PM 分诊 → 开发 → QA → 构建 → 交付（5 阶段）
- **质量加固**：静态分析 → QA → 安全审计 → 性能基准 → 构建 → 报告（6 阶段）

你也可以自定义工作流，添加或移除阶段。

### 自定义 Agent

在「👥 团队」页面，你可以：

**查看配置**
每张 Agent 卡片显示名称、角色、能力标签。

**编辑 Agent**
点击卡片上的编辑按钮，可以修改：
- 系统提示词（控制 Agent 的行为风格）
- 使用的 AI 模型
- 上下文 Token 限制

**查看上下文**
在「🧠 上下文」页面可以看到每个 Agent 当前的信息量和 Token 使用情况。

**实时监控**
在「🗺️ 全景」页面可以查看系统资源（CPU/GPU/内存）和 Token 消耗的实时图表。

> 💡 通常不需要修改 Agent 配置。默认配置已经过优化。`,
  },
  {
    id: 'docs-output',
    icon: '📄',
    title: '文档与产出查看',
    difficulty: '基础',
    diffColor: 'bg-blue-500/20 text-blue-400',
    content: `## 自动生成的文档

AutoMater 在开发过程中会自动生成多类文档：

**📐 设计文档**
- 总览设计：系统整体架构和技术方案
- 系统级设计：模块划分和接口定义
- 功能级设计：每个功能的详细方案

**📋 需求文档**
每个 Feature 的详细需求说明。

**🧪 测试规格**
每个 Feature 的测试验收标准。

### 查看文档
在「📄 文档」页面，左侧是文档树，点击即可在右侧预览。

### 查看源代码产出
在「📦 产出」页面可以：
- 浏览文件树
- 在线预览代码
- 点击「📂 打开文件夹」用系统文件管理器打开
- 点击「📦 导出 zip」打包下载

### 版本历史
在文档或产出页面，右键文件可以：
- 查看历史版本
- 回退到之前的版本`,
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
1. 是否已配置 API Key（左下角圆点应为绿色）
2. 是否已输入需求（许愿页面）
3. 网络是否正常（需要访问 AI API）

### Q: 费用太高了怎么办？
**A:** 几种方法降低费用：
- 使用更便宜的模型（如 GPT-3.5 代替 GPT-4）
- 减小每次需求的范围
- 在设置中降低 Agent 的最大 Token 数

### Q: 生成的代码质量不好？
**A:** 尝试：
- 提供更详细的需求描述
- 指定技术栈和框架
- 分步骤迭代，先做核心功能

### Q: 如何暂停/继续项目？
**A:** 在全景页面点击控制栏的按钮即可暂停或继续。

### Q: 支持哪些编程语言？
**A:** 理论上支持所有主流语言。默认推荐 TypeScript/React 前端项目，但你可以在需求中指定任何技术栈。

### Q: 可以修改已生成的代码吗？
**A:** 可以！在产出页面找到工作区路径，用你喜欢的编辑器修改。但注意 Agent 运行时可能会覆盖改动。

### Q: 导入项目后分析结果不准确？
**A:** 几种改善方法：
- 确保项目根目录选择正确（应是包含 package.json 等配置文件的目录）
- 删除 \`.automater/\` 目录后重新导入，系统会重新分析
- 非常大的项目（3000+ 文件）可能需要更高预算，可在设置中调整
- 分析完成后可以在「📄 文档」页面查看并手动修正架构文档

### Q: 导入会修改我的源代码吗？
**A:** 不会。所有分析产物都存放在项目根目录下的 \`.automater/\` 文件夹中，你的源代码不会被改动。如果不需要了，直接删除 \`.automater/\` 即可。

### Q: 如何联系支持？
**A:** 你可以和右侧的元Agent管家对话，描述你遇到的问题。`,
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
  let tableHeader = false;

  const closeList = () => { if (inList) { html.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; } };
  const closeTable = () => {
    if (inTable && tableRows.length > 0) {
      html.push('<table class="w-full text-xs my-3 border-collapse">');
      tableRows.forEach((row, i) => {
        const tag = i === 0 ? 'th' : 'td';
        const cls = i === 0
          ? 'bg-slate-800/50 text-slate-300 font-medium px-3 py-2 text-left border-b border-slate-700'
          : 'text-slate-400 px-3 py-2 border-b border-slate-800/50';
        html.push('<tr>' + row.map(c => `<${tag} class="${cls}">${esc(c)}</${tag}>`).join('') + '</tr>');
      });
      html.push('</table>');
      tableRows = [];
      inTable = false;
      tableHeader = false;
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
    r = r.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 bg-slate-800 rounded text-amber-300 text-xs font-mono">$1</code>');
    r = r.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>');
    r = r.replace(/\*(.+?)\*/g, '<em>$1</em>');
    r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m: string, label: string, url: string) =>
      isSafeUrl(url)
        ? `<a href="${url}" class="text-forge-400 underline hover:text-forge-300" target="_blank" rel="noopener noreferrer">${label}</a>`
        : `<span class="text-forge-400">${label}</span>`
    );
    return r;
  };

  for (const raw of lines) {
    const line = raw;

    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) { closeList(); closeTable(); inCodeBlock = true; codeBuffer = []; }
      else { html.push(`<pre class="bg-slate-900 border border-slate-800 rounded-lg p-4 overflow-x-auto my-3"><code class="text-xs text-slate-300 leading-relaxed font-mono">${esc(codeBuffer.join('\n'))}</code></pre>`); inCodeBlock = false; }
      continue;
    }
    if (inCodeBlock) { codeBuffer.push(line); continue; }
    if (line.trim() === '') { closeList(); closeTable(); continue; }

    // Table row
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      closeList();
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) { tableHeader = true; continue; }
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

    if (/^---+$/.test(line.trim())) { closeList(); html.push('<hr class="border-slate-800 my-4" />'); continue; }

    if (line.trimStart().startsWith('> ')) {
      closeList();
      const content = line.replace(/^>\s*/, '');
      const isWarning = content.startsWith('⚠️');
      const isTip = content.startsWith('💡');
      const border = isWarning ? 'border-amber-500/40 bg-amber-500/5' : isTip ? 'border-forge-500/40 bg-forge-500/5' : 'border-slate-600';
      html.push(`<blockquote class="border-l-2 ${border} pl-4 pr-3 py-2 my-3 rounded-r-lg text-xs text-slate-400">${inline(content)}</blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') { closeList(); inList = 'ul'; html.push('<ul class="list-disc list-inside space-y-1.5 my-2 text-slate-300 text-sm ml-2">'); }
      html.push(`<li class="leading-relaxed">${inline(ulMatch[2])}</li>`);
      continue;
    }
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') { closeList(); inList = 'ol'; html.push('<ol class="list-decimal list-inside space-y-1.5 my-2 text-slate-300 text-sm ml-2">'); }
      html.push(`<li class="leading-relaxed">${inline(olMatch[2])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p class="text-sm text-slate-300 leading-relaxed my-1.5">${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  if (inCodeBlock) html.push(`<pre class="bg-slate-900 border border-slate-800 rounded-lg p-4 overflow-x-auto my-3"><code class="text-xs text-slate-300 font-mono">${esc(codeBuffer.join('\n'))}</code></pre>`);
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
        <div className="px-4 py-2 border-t border-slate-800 text-[10px] text-slate-600">
          v13.0 · 9 篇教程
        </div>
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
          <div
            className="guide-content"
            dangerouslySetInnerHTML={{ __html: renderGuideMarkdown(selected.content) }}
          />

          {/* Navigation */}
          <div className="flex justify-between mt-10 pt-6 border-t border-slate-800">
            {(() => {
              const idx = GUIDE_SECTIONS.findIndex(s => s.id === selectedId);
              const prev = idx > 0 ? GUIDE_SECTIONS[idx - 1] : null;
              const next = idx < GUIDE_SECTIONS.length - 1 ? GUIDE_SECTIONS[idx + 1] : null;
              return (
                <>
                  {prev ? (
                    <button onClick={() => setSelectedId(prev.id)} className="flex items-center gap-2 text-xs text-slate-400 hover:text-forge-300 transition-colors">
                      <span>←</span> <span>{prev.icon} {prev.title}</span>
                    </button>
                  ) : <div />}
                  {next ? (
                    <button onClick={() => setSelectedId(next.id)} className="flex items-center gap-2 text-xs text-slate-400 hover:text-forge-300 transition-colors">
                      <span>{next.icon} {next.title}</span> <span>→</span>
                    </button>
                  ) : <div />}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
