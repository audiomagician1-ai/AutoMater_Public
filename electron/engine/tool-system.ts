/**
 * Tool System — Agent 工具注册表与执行器
 * 
 * v0.8: 初始工具集 (file/search/shell/git/github)
 * v1.0: edit_file (str_replace), read_file 带行号+分页, search_files 带上下文,
 *       glob_files, 改进 ACI 设计 (参考 Claude Code / SWE-agent)
 * v2.1: think, web_search, fetch_url, todo_write, todo_read, batch_edit, http_request
 *       动态工具加载 (getToolsForRole)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { readWorkspaceFile, readDirectoryTree } from './file-writer';
import { commit as gitCommit, getDiff, getLog as gitLog, createIssue, listIssues, type GitProviderConfig } from './git-provider';
import { execInSandbox, runTest as sandboxRunTest, runLint as sandboxRunLint, type SandboxConfig } from './sandbox-executor';
import { readMemoryForRole, appendProjectMemory, appendRoleMemory } from './memory-system';
import { webSearch, fetchUrl, httpRequest } from './web-tools';
import { think, todoWrite, todoRead, batchEdit, type TodoItem, type EditOperation } from './extended-tools';
import { takeScreenshot, mouseMove, mouseClick, keyboardType, keyboardHotkey } from './computer-use';
import {
  launchBrowser, closeBrowser, navigate as browserNavigateFn,
  browserScreenshot, browserSnapshot, browserClick, browserType,
  browserEvaluate, browserWait, browserNetwork,
} from './browser-tools';
import {
  analyzeImage, compareScreenshots, visualAssert,
  cacheScreenshot, getCachedScreenshot,
  type VisionCallback,
} from './visual-tools';

// ═══════════════════════════════════════
// Tool Interface
// ═══════════════════════════════════════

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  output: string;
  /** 操作类型 (用于 UI 展示) */
  action?: 'read' | 'write' | 'edit' | 'search' | 'shell' | 'git' | 'github' | 'web' | 'think' | 'plan' | 'computer';
}

/** 工具执行上下文 */
export interface ToolContext {
  workspacePath: string;
  projectId: string;
  gitConfig: GitProviderConfig;
  /** v2.4: Vision LLM 回调 (由 orchestrator 注入，用于视觉验证工具) */
  callVision?: VisionCallback;
}

// ═══════════════════════════════════════
// Tool Definitions (给 LLM 看的 schema)
// v1.0: 16 个工具 (新增 edit_file, glob_files; 增强 read_file, search_files)
// ═══════════════════════════════════════

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取工作区中指定文件的内容，返回带行号的文本。支持分页读取大文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        offset: { type: 'number', description: '起始行号 (从1开始)，默认1' },
        limit: { type: 'number', description: '读取行数，默认300，最大1000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建新文件或完全覆盖已有文件。自动创建目录。仅用于创建新文件，修改已有文件请用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: '对已有文件进行精确的文本替换编辑。使用 old_string/new_string 模式，只修改需要改的部分，无需重写整个文件。如果 old_string 为空则追加到文件末尾。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配，包含缩进）。为空则追加到文件末尾。' },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    description: '列出工作区的文件目录树。用于了解项目结构。',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: '相对目录路径，默认为根目录', default: '' },
        max_depth: { type: 'number', description: '最大深度，默认3', default: 3 },
      },
    },
  },
  {
    name: 'glob_files',
    description: '按 glob 模式查找文件路径。例如 "**/*.ts" 查找所有 TypeScript 文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 模式，如 "src/**/*.ts", "*.json", "**/*test*"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_files',
    description: '在工作区文件中搜索文本模式。返回匹配行及前后各2行上下文。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索的文本模式' },
        include: { type: 'string', description: '文件类型过滤 (如 *.ts, *.py)', default: '*' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: '在工作区中执行 shell 命令。用于安装依赖(npm install)、运行测试、编译检查等。超时60秒。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell 命令' },
      },
      required: ['command'],
    },
  },
  {
    name: 'git_commit',
    description: '提交当前所有变更到 git。如配置了 GitHub 会自动 push。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '提交信息' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_diff',
    description: '查看当前未提交的变更（git diff）',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_log',
    description: '查看最近的 git 提交历史',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '显示条数，默认10', default: 10 },
      },
    },
  },
  {
    name: 'github_create_issue',
    description: '在 GitHub 仓库创建 Issue (仅 GitHub 模式)',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue 标题' },
        body: { type: 'string', description: 'Issue 内容(Markdown)' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签列表' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'github_list_issues',
    description: '列出 GitHub 仓库的 Issues (仅 GitHub 模式)',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
      },
    },
  },
  {
    name: 'task_complete',
    description: '标记当前任务已完成。必须在所有文件写入完毕且验证通过后调用。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '完成总结' },
        files_changed: { type: 'array', items: { type: 'string' }, description: '修改的文件列表' },
      },
      required: ['summary'],
    },
  },
  // ── v1.2: Sandbox 工具 ──
  {
    name: 'run_test',
    description: '在沙箱中运行项目测试 (自动检测 npm test/pytest/cargo test/go test)。超时 180 秒。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'run_lint',
    description: '在沙箱中运行 lint 和类型检查 (自动检测 tsc/eslint/py_compile)。超时 60 秒。',
    parameters: { type: 'object', properties: {} },
  },
  // ── v1.2: 记忆工具 ──
  {
    name: 'memory_read',
    description: '读取 Agent 记忆 (全局 + 项目 + 角色)。用于回忆之前的经验和约定。',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色 (developer/qa/architect/pm)，默认 developer', default: 'developer' },
      },
    },
  },
  {
    name: 'memory_append',
    description: '向项目记忆追加一条经验/约定。用于记录重要发现、踩坑记录、架构决策。',
    parameters: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: '要记录的经验条目 (简短清晰)' },
        layer: { type: 'string', enum: ['project', 'role'], description: '写入层: project(项目级) 或 role(角色级)', default: 'project' },
        role: { type: 'string', description: '角色 (仅 layer=role 时需要)', default: 'developer' },
      },
      required: ['entry'],
    },
  },
  // ── v1.3: Sub-agent 工具 ──
  {
    name: 'spawn_researcher',
    description: '启动一个只读研究子 Agent。子 Agent 可以读取文件、搜索代码、查看目录，但不能修改任何内容。用于在不打断当前工作的情况下调研问题。最多 8 轮工具调用。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要研究的问题，包括足够的背景信息' },
      },
      required: ['question'],
    },
  },

  // ═══ v2.1: 思考 + 互联网 + 规划 + 增强编辑 ═══

  {
    name: 'think',
    description: '用于深度思考和推理的工具。写下你的分析、假设、计划，不会产生任何副作用。在面对复杂问题时，先用 think 理清思路再行动。',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: '你的思考内容（推理过程、分析、计划等）' },
      },
      required: ['thought'],
    },
  },
  {
    name: 'web_search',
    description: '搜索互联网。用于查找文档、API 用法、错误解决方案、最佳实践等。返回 Markdown 格式的搜索结果（标题、URL、摘要）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（建议用英文，结果更全面）' },
        max_results: { type: 'number', description: '最大结果数，默认 8', default: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: '抓取网页内容并转为 Markdown 纯文本。用于阅读文档页面、API 参考、博客文章等。自动处理 HTML → Markdown 转换。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL（必须 http:// 或 https:// 开头）' },
        max_length: { type: 'number', description: '最大返回字符数，默认 15000', default: 15000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'http_request',
    description: '发送任意 HTTP 请求。用于测试 API 接口、调用 webhook、验证服务端响应等。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '请求 URL' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP 方法，默认 GET', default: 'GET' },
        headers: { type: 'object', description: '请求头 (key-value 对象)' },
        body: { type: 'string', description: '请求体（JSON 字符串或文本）' },
        timeout: { type: 'number', description: '超时毫秒数，默认 30000，最大 60000', default: 30000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'todo_write',
    description: '创建/更新你的任务清单（全量替换）。用于规划复杂任务的执行步骤、跟踪进度。每次调用传入完整列表。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '任务唯一标识' },
              content: { type: 'string', description: '任务描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '优先级' },
            },
            required: ['id', 'content', 'status'],
          },
          description: '完整的任务列表',
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'todo_read',
    description: '读取你当前的任务清单。用于检查进度、决定下一步行动。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'batch_edit',
    description: '对同一文件执行多次 str_replace 编辑（按顺序依次应用）。一次调用修改多处，减少轮次。每个编辑的 old_string 必须精确匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: '要替换的原始文本（空字符串=追加到文件末尾）' },
              new_string: { type: 'string', description: '替换后的新文本' },
            },
            required: ['old_string', 'new_string'],
          },
          description: '编辑操作列表（按顺序应用）',
        },
      },
      required: ['path', 'edits'],
    },
  },

  // ═══ v2.2: Computer Use 工具 ═══

  {
    name: 'screenshot',
    description: '截取当前屏幕截图。返回 base64 PNG 图像。用于查看桌面应用界面、验证 UI 状态、黑盒测试。截图会自动缩放以节省 token。',
    parameters: {
      type: 'object',
      properties: {
        scale: { type: 'number', description: '缩放比例 (0.5=50%, 0.75=75%, 1=原始尺寸)，默认 0.75', default: 0.75 },
      },
    },
  },
  {
    name: 'mouse_click',
    description: '在指定屏幕坐标执行鼠标点击。配合 screenshot 使用：先截图分析界面，确定目标坐标，再点击。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标 (像素)' },
        y: { type: 'number', description: '屏幕 Y 坐标 (像素)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键，默认 left', default: 'left' },
        double_click: { type: 'boolean', description: '是否双击，默认 false', default: false },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_move',
    description: '移动鼠标到指定屏幕坐标（不点击）。用于悬停触发工具提示等。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'keyboard_type',
    description: '在当前焦点窗口键入文本。先用 mouse_click 点击目标输入框，再用此工具输入文本。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
      },
      required: ['text'],
    },
  },
  {
    name: 'keyboard_hotkey',
    description: '按组合键或特殊键。格式: "modifier+key" 或单个键名。示例: "ctrl+s", "alt+f4", "enter", "tab", "escape", "f5", "ctrl+shift+p"。',
    parameters: {
      type: 'object',
      properties: {
        combo: { type: 'string', description: '按键组合，如 "ctrl+s"、"enter"、"alt+tab"' },
      },
      required: ['combo'],
    },
  },

  // ═══ v2.3: Playwright 浏览器自动化 ═══

  {
    name: 'browser_launch',
    description: '启动浏览器实例（使用系统已安装的 Edge/Chrome）。必须在使用其他 browser_* 工具前调用。如果已有实例会复用。',
    parameters: {
      type: 'object',
      properties: {
        headless: { type: 'boolean', description: '是否无头模式，默认 false (可见窗口)', default: false },
      },
    },
  },
  {
    name: 'browser_navigate',
    description: '浏览器导航到指定 URL。返回页面标题和实际 URL。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要访问的 URL' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取当前浏览器页面的截图。返回 base64 PNG。用于视觉验证 UI 状态。',
    parameters: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: '是否截取整页（含滚动区域），默认 false', default: false },
      },
    },
  },
  {
    name: 'browser_snapshot',
    description: '获取页面可访问性快照（文本 DOM 树）。比截图更省 token，适合了解页面结构和元素。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: '点击页面元素。使用 CSS 选择器或文本内容定位。示例: "button.submit", "text=登录", "#login-btn"',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器或 Playwright 选择器 (如 "text=点击我")' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键', default: 'left' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: '在页面输入框中输入文本。先用 selector 定位输入框，再输入文本。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框的 CSS 选择器' },
        text: { type: 'string', description: '要输入的文本' },
        clear: { type: 'boolean', description: '是否先清空再输入，默认 false', default: false },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_evaluate',
    description: '在页面中执行 JavaScript 代码。可用于获取 DOM 数据、检查状态、触发事件等。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript 表达式或代码块' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_wait',
    description: '等待页面条件满足（元素出现、文本出现、或等待指定时间）。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '等待的元素 CSS 选择器' },
        text: { type: 'string', description: '等待页面中出现的文本' },
        timeout: { type: 'number', description: '超时毫秒数，默认 10000', default: 10000 },
      },
    },
  },
  {
    name: 'browser_network',
    description: '查看浏览器网络请求（最近 3 秒）。用于验证 API 调用是否正确、检查请求状态码。',
    parameters: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: '过滤 URL 包含的字符串，如 "/api/"' },
      },
    },
  },
  {
    name: 'browser_close',
    description: '关闭浏览器实例。在测试完成后调用以释放资源。',
    parameters: { type: 'object', properties: {} },
  },

  // ═══ v2.4: 视觉验证工具 ═══

  {
    name: 'analyze_image',
    description: '用 AI 视觉分析图像内容。配合 screenshot / browser_screenshot 使用。可用于理解 UI 状态、识别元素位置、读取屏幕文本。',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '要分析的图像标签（最近一次 screenshot 自动缓存为 "latest"）', default: 'latest' },
        question: { type: 'string', description: '要分析的问题，如 "页面上有哪些按钮" 或 "登录表单是否存在"' },
      },
      required: ['question'],
    },
  },
  {
    name: 'compare_screenshots',
    description: '对比两张截图的差异。用于 UI 回归测试、检查操作前后的变化。需要先用 screenshot/browser_screenshot 截图并记住标签。',
    parameters: {
      type: 'object',
      properties: {
        before_label: { type: 'string', description: '"之前" 截图的标签' },
        after_label: { type: 'string', description: '"之后" 截图的标签，默认 "latest"', default: 'latest' },
        description: { type: 'string', description: '对比的上下文描述' },
      },
      required: ['before_label'],
    },
  },
  {
    name: 'visual_assert',
    description: '视觉断言：验证截图是否满足指定条件。返回 pass/fail 和置信度。示例: "页面中应该有登录按钮" 或 "表格应显示 5 行数据"',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '要验证的图像标签，默认 "latest"', default: 'latest' },
        assertion: { type: 'string', description: '要验证的条件描述' },
      },
      required: ['assertion'],
    },
  },
];

// ═══════════════════════════════════════
// Tool Executor
// ═══════════════════════════════════════

export function executeTool(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    switch (call.name) {

      // ── read_file: 带行号 + 分页 ──
      case 'read_file': {
        const filePath = call.arguments.path;
        const content = readWorkspaceFile(ctx.workspacePath, filePath);
        if (content === null) return { success: false, output: `文件不存在: ${filePath}`, action: 'read' };

        const lines = content.split('\n');
        const offset = Math.max(1, call.arguments.offset ?? 1);
        const limit = Math.min(1000, Math.max(1, call.arguments.limit ?? 300));
        const start = offset - 1;
        const end = Math.min(start + limit, lines.length);

        const numbered = lines.slice(start, end)
          .map((line, i) => `${String(start + i + 1).padStart(4)}| ${line}`)
          .join('\n');

        const header = `[${filePath}] ${lines.length} 行, 显示 ${offset}-${end}`;
        const hasMore = end < lines.length ? `\n... 还有 ${lines.length - end} 行 (用 offset=${end + 1} 继续)` : '';
        return { success: true, output: `${header}\n${numbered}${hasMore}`, action: 'read' };
      }

      // ── write_file: 创建/覆盖 ──
      case 'write_file': {
        const filePath = call.arguments.path;
        const content = call.arguments.content;
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
          return { success: false, output: `路径不安全: ${filePath}`, action: 'write' };
        }
        const absPath = path.join(ctx.workspacePath, normalized);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
        const size = Buffer.byteLength(content, 'utf-8');
        return { success: true, output: `已写入 ${normalized} (${size} bytes)`, action: 'write' };
      }

      // ── edit_file: str_replace 精确编辑 (v1.0 核心新增) ──
      case 'edit_file': {
        const filePath = call.arguments.path;
        const oldStr = call.arguments.old_string;
        const newStr = call.arguments.new_string;
        const normalized = path.normalize(filePath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
          return { success: false, output: `路径不安全: ${filePath}`, action: 'edit' };
        }
        const absPath = path.join(ctx.workspacePath, normalized);
        if (!fs.existsSync(absPath)) {
          return { success: false, output: `文件不存在: ${filePath}`, action: 'edit' };
        }
        let content = fs.readFileSync(absPath, 'utf-8');

        if (!oldStr && oldStr !== '') {
          return { success: false, output: 'old_string 参数缺失', action: 'edit' };
        }

        if (oldStr === '') {
          // 追加模式
          content = content + newStr;
          fs.writeFileSync(absPath, content, 'utf-8');
          return { success: true, output: `已追加到 ${normalized} (${Buffer.byteLength(newStr, 'utf-8')} bytes added)`, action: 'edit' };
        }

        // 精确匹配替换
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          // 尝试忽略行尾空白匹配
          const trimmedOld = oldStr.split('\n').map((l: string) => l.trimEnd()).join('\n');
          const trimmedContent = content.split('\n').map((l: string) => l.trimEnd()).join('\n');
          const trimOccurrences = trimmedContent.split(trimmedOld).length - 1;
          if (trimOccurrences === 0) {
            return { success: false, output: `未找到匹配的文本 (0 occurrences)。请确保 old_string 精确匹配文件内容（包含缩进和空白）。`, action: 'edit' };
          }
          // 用 trimmed 版本替换
          const newTrimmedContent = trimmedContent.replace(trimmedOld, newStr);
          fs.writeFileSync(absPath, newTrimmedContent, 'utf-8');
          return { success: true, output: `已编辑 ${normalized} (1 处替换, trimmed match)`, action: 'edit' };
        }
        if (occurrences > 1) {
          return { success: false, output: `old_string 匹配了 ${occurrences} 处，需要更精确的上下文使其唯一。`, action: 'edit' };
        }

        content = content.replace(oldStr, newStr);
        fs.writeFileSync(absPath, content, 'utf-8');
        return { success: true, output: `已编辑 ${normalized} (1 处替换)`, action: 'edit' };
      }

      // ── list_files ──
      case 'list_files': {
        const dir = call.arguments.directory || '';
        const maxDepth = call.arguments.max_depth ?? 3;
        const tree = readDirectoryTree(ctx.workspacePath, dir, maxDepth);
        const formatTree = (nodes: any[], indent: string = ''): string => {
          return nodes.map(n => {
            if (n.type === 'dir') {
              return `${indent}${n.name}/\n${n.children ? formatTree(n.children, indent + '  ') : ''}`;
            }
            return `${indent}${n.name}`;
          }).join('\n');
        };
        return { success: true, output: formatTree(tree) || '(空目录)', action: 'read' };
      }

      // ── glob_files: 按模式查找文件 (v1.0 新增) ──
      case 'glob_files': {
        const pattern = call.arguments.pattern;
        try {
          // 使用 PowerShell/bash 实现简单 glob
          let cmd: string;
          if (process.platform === 'win32') {
            // PowerShell: Get-ChildItem -Recurse with filter
            const psPattern = pattern.replace(/\*\*\//g, '').replace(/\*/g, '*');
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Recurse -File -Filter '${psPattern}' | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1).Replace('\\\\', '/') }"`;
          } else {
            cmd = `find . -type f -name "${pattern.replace(/\*\*\//g, '')}" | head -50`;
          }
          const output = execSync(cmd, {
            cwd: ctx.workspacePath,
            encoding: 'utf-8',
            maxBuffer: 256 * 1024,
            timeout: 10000,
          });
          const files = output.trim().split('\n')
            .filter(f => f && !f.includes('node_modules') && !f.includes('.git'))
            .slice(0, 50);
          return { success: true, output: files.length > 0 ? files.join('\n') : '无匹配文件', action: 'search' };
        } catch {
          return { success: true, output: '无匹配文件', action: 'search' };
        }
      }

      // ── search_files: 带上下文行 ──
      case 'search_files': {
        const pattern = call.arguments.pattern;
        const include = call.arguments.include || '*';
        try {
          let cmd: string;
          if (process.platform === 'win32') {
            // PowerShell Select-String with context
            const escapedPattern = pattern.replace(/'/g, "''");
            const includeFilter = include === '*' ? '' : ` -Include '${include}'`;
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Recurse -File${includeFilter} | Where-Object { $_.FullName -notmatch 'node_modules|.git|dist' } | Select-String -Pattern '${escapedPattern}' -Context 2,2 | Select-Object -First 25 | Out-String -Width 200"`;
          } else {
            cmd = `grep -rn --include="${include}" -C 2 "${pattern.replace(/"/g, '\\"')}" . | head -80`;
          }
          const output = execSync(cmd, {
            cwd: ctx.workspacePath,
            encoding: 'utf-8',
            maxBuffer: 512 * 1024,
            timeout: 15000,
          });
          return { success: true, output: output.trim().slice(0, 5000) || '无匹配', action: 'search' };
        } catch {
          return { success: true, output: '无匹配', action: 'search' };
        }
      }

      // ── run_command (v1.2: 通过 sandbox executor 执行) ──
      case 'run_command': {
        const command = call.arguments.command;
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath, timeoutMs: 60_000 };
        const result = execInSandbox(command, sandboxCfg);
        if (result.success) {
          return { success: true, output: (result.stdout || '(无输出)').slice(0, 8000), action: 'shell' };
        } else if (result.timedOut) {
          return { success: false, output: `命令超时 (${Math.round(result.duration / 1000)}s):\n${result.stderr.slice(0, 2000)}`, action: 'shell' };
        } else {
          return { success: false, output: `命令失败 (exit ${result.exitCode}):\n${result.stderr.slice(0, 3000)}${result.stdout ? '\n--- stdout ---\n' + result.stdout.slice(0, 2000) : ''}`, action: 'shell' };
        }
      }

      // ── run_test (v1.2) ──
      case 'run_test': {
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath };
        const result = sandboxRunTest(sandboxCfg);
        const output = result.stdout + (result.stderr ? '\n[stderr] ' + result.stderr : '');
        return {
          success: result.success,
          output: `[run_test] exit=${result.exitCode} duration=${result.duration}ms${result.timedOut ? ' TIMEOUT' : ''}\n${output.slice(0, 8000)}`,
          action: 'shell',
        };
      }

      // ── run_lint (v1.2) ──
      case 'run_lint': {
        const sandboxCfg: SandboxConfig = { workspacePath: ctx.workspacePath };
        const result = sandboxRunLint(sandboxCfg);
        return {
          success: result.success,
          output: `[run_lint] exit=${result.exitCode}\n${result.stdout.slice(0, 8000)}`,
          action: 'shell',
        };
      }

      // ── memory_read (v1.2) ──
      case 'memory_read': {
        const role = call.arguments.role || 'developer';
        const mem = readMemoryForRole(ctx.workspacePath, role);
        return { success: true, output: mem.combined || '(无记忆)', action: 'read' };
      }

      // ── memory_append (v1.2) ──
      case 'memory_append': {
        const entry = call.arguments.entry;
        const layer = call.arguments.layer || 'project';
        const role = call.arguments.role || 'developer';
        if (layer === 'role') {
          appendRoleMemory(ctx.workspacePath, role, entry);
          return { success: true, output: `已写入 ${role} 角色记忆: ${entry.slice(0, 100)}`, action: 'write' };
        } else {
          appendProjectMemory(ctx.workspacePath, entry);
          return { success: true, output: `已写入项目记忆: ${entry.slice(0, 100)}`, action: 'write' };
        }
      }

      case 'git_commit': {
        const result = gitCommit(ctx.gitConfig, call.arguments.message);
        if (result.success) {
          return { success: true, output: `已提交 ${result.hash}${result.pushed ? ' (已 push)' : ''}`, action: 'git' };
        }
        return { success: false, output: '无变更可提交', action: 'git' };
      }

      case 'git_diff': {
        const diff = getDiff(ctx.workspacePath);
        return { success: true, output: diff.slice(0, 8000) || '无未提交变更', action: 'git' };
      }

      case 'git_log': {
        const count = call.arguments.count ?? 10;
        const logs = gitLog(ctx.workspacePath, count);
        return { success: true, output: logs.join('\n') || '无提交记录', action: 'git' };
      }

      case 'github_create_issue': {
        return { success: true, output: `[async] 正在创建 Issue: ${call.arguments.title}`, action: 'github' };
      }

      case 'github_list_issues': {
        return { success: true, output: '[async] 正在查询 Issues...', action: 'github' };
      }

      case 'task_complete': {
        return { success: true, output: `任务完成: ${call.arguments.summary}`, action: 'write' };
      }

      // spawn_researcher 是异步工具，同步入口返回提示
      case 'spawn_researcher': {
        return { success: true, output: '[async] 正在启动研究子 Agent...', action: 'read' };
      }

      // ═══ v2.1: 新工具 ═══

      case 'think': {
        const thought = call.arguments.thought || '';
        return { success: true, output: think(thought), action: 'think' };
      }

      case 'web_search': {
        // 异步工具，同步入口返回占位
        return { success: true, output: '[async] 正在搜索...', action: 'web' };
      }

      case 'fetch_url': {
        return { success: true, output: '[async] 正在抓取...', action: 'web' };
      }

      case 'http_request': {
        return { success: true, output: '[async] 正在发送请求...', action: 'web' };
      }

      case 'todo_write': {
        const todos: TodoItem[] = call.arguments.todos || [];
        const agentId = (call.arguments as any)._agentId || 'default';
        const result = todoWrite(agentId, todos);
        return { success: true, output: result, action: 'plan' };
      }

      case 'todo_read': {
        const agentId = (call.arguments as any)._agentId || 'default';
        const result = todoRead(agentId);
        return { success: true, output: result, action: 'plan' };
      }

      case 'batch_edit': {
        const edits: EditOperation[] = call.arguments.edits || [];
        if (edits.length === 0) {
          return { success: false, output: '编辑列表为空', action: 'edit' };
        }
        const result = batchEdit(ctx.workspacePath, call.arguments.path, edits);
        return { success: result.success, output: result.output, action: 'edit' };
      }

      // ═══ v2.2: Computer Use 工具 ═══

      case 'screenshot': {
        const scale = call.arguments.scale ?? 0.75;
        const result = takeScreenshot(scale);
        if (!result.success) {
          return { success: false, output: `截图失败: ${result.error}`, action: 'computer' };
        }
        // 返回 base64 图像信息（实际图像需在 orchestrator 中作为 image_url 传给 LLM）
        // v2.4: 自动缓存截图供视觉验证工具使用
        if (result.base64) cacheScreenshot('latest', result.base64);
        return {
          success: true,
          output: `[screenshot] ${result.width}x${result.height} PNG (${Math.round(result.base64.length / 1024)}KB base64)`,
          action: 'computer',
          // 附加 base64 数据供 orchestrator 使用
          ...(result.base64 ? { _imageBase64: result.base64 } : {}),
        } as any;
      }

      case 'mouse_click': {
        const x = call.arguments.x;
        const y = call.arguments.y;
        const button = call.arguments.button || 'left';
        const dbl = call.arguments.double_click || false;
        const result = mouseClick(x, y, button, dbl);
        return {
          success: result.success,
          output: result.success ? `鼠标${dbl ? '双' : ''}点击 (${x}, ${y}) [${button}]` : `点击失败: ${result.error}`,
          action: 'computer',
        };
      }

      case 'mouse_move': {
        const result = mouseMove(call.arguments.x, call.arguments.y);
        return {
          success: result.success,
          output: result.success ? `鼠标移动到 (${call.arguments.x}, ${call.arguments.y})` : `移动失败: ${result.error}`,
          action: 'computer',
        };
      }

      case 'keyboard_type': {
        const result = keyboardType(call.arguments.text);
        return {
          success: result.success,
          output: result.success ? `已键入 ${call.arguments.text.length} 字符` : `键入失败: ${result.error}`,
          action: 'computer',
        };
      }

      case 'keyboard_hotkey': {
        const result = keyboardHotkey(call.arguments.combo);
        return {
          success: result.success,
          output: result.success ? `已按下 ${call.arguments.combo}` : `按键失败: ${result.error}`,
          action: 'computer',
        };
      }

      // ═══ v2.3: Playwright 浏览器工具（全部异步，同步入口返回占位） ═══

      case 'browser_launch':
      case 'browser_navigate':
      case 'browser_screenshot':
      case 'browser_snapshot':
      case 'browser_click':
      case 'browser_type':
      case 'browser_evaluate':
      case 'browser_wait':
      case 'browser_network':
      case 'browser_close': {
        return { success: true, output: `[async] ${call.name}...`, action: 'computer' };
      }

      // v2.4: 视觉验证工具（异步，同步入口返回占位）
      case 'analyze_image':
      case 'compare_screenshots':
      case 'visual_assert': {
        return { success: true, output: `[async] ${call.name}...`, action: 'computer' };
      }

      default:
        return { success: false, output: `未知工具: ${call.name}` };
    }
  } catch (err: any) {
    return { success: false, output: `工具执行错误: ${err.message}` };
  }
}

/** 异步工具执行 (GitHub API 等) */
export async function executeToolAsync(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  if (call.name === 'github_create_issue') {
    const issue = await createIssue(
      ctx.gitConfig,
      call.arguments.title,
      call.arguments.body,
      call.arguments.labels || []
    );
    if (issue) {
      return { success: true, output: `Issue #${issue.number} 已创建: ${issue.html_url}`, action: 'github' };
    }
    return { success: false, output: 'GitHub Issue 创建失败 (可能未配置 GitHub 模式)', action: 'github' };
  }

  if (call.name === 'github_list_issues') {
    const issues = await listIssues(ctx.gitConfig, call.arguments.state || 'open');
    if (issues.length === 0) return { success: true, output: '无 Issues', action: 'github' };
    const list = issues.map(i => `#${i.number} [${i.state}] ${i.title} ${i.labels.join(',')}`).join('\n');
    return { success: true, output: list, action: 'github' };
  }

  // ═══ v2.1: 异步网络工具 ═══

  if (call.name === 'web_search') {
    const result = await webSearch(call.arguments.query, call.arguments.max_results ?? 8);
    if (result.success) {
      return { success: true, output: result.content.slice(0, 6000), action: 'web' };
    }
    return { success: false, output: `搜索失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'fetch_url') {
    const result = await fetchUrl(call.arguments.url, call.arguments.max_length ?? 15000);
    if (result.success) {
      return { success: true, output: result.content, action: 'web' };
    }
    return { success: false, output: `抓取失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'http_request') {
    const result = await httpRequest({
      url: call.arguments.url,
      method: call.arguments.method,
      headers: call.arguments.headers,
      body: call.arguments.body,
      timeout: call.arguments.timeout,
    });
    const headersSummary = Object.entries(result.headers)
      .slice(0, 10)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const output = `HTTP ${result.status}\n--- Headers ---\n${headersSummary}\n--- Body ---\n${result.body}`;
    return { success: result.success, output: output.slice(0, 8000), action: 'web' };
  }

  // ═══ v2.3: Playwright 浏览器工具（异步执行） ═══

  if (call.name === 'browser_launch') {
    const result = await launchBrowser({ headless: call.arguments.headless });
    return { success: result.success, output: result.success ? '浏览器已启动' : `启动失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_navigate') {
    const result = await browserNavigateFn(call.arguments.url);
    return {
      success: result.success,
      output: result.success ? `已导航到: ${result.title}\nURL: ${result.url}` : `导航失败: ${result.error}`,
      action: 'computer',
    };
  }

  if (call.name === 'browser_screenshot') {
    const result = await browserScreenshot(call.arguments.full_page);
    if (result.success) {
      // v2.4: 自动缓存截图供视觉验证工具使用
      cacheScreenshot('latest', result.base64);
      return {
        success: true,
        output: `[browser_screenshot] ${Math.round(result.base64.length / 1024)}KB PNG`,
        action: 'computer',
        _imageBase64: result.base64,
      } as any;
    }
    return { success: false, output: `截图失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_snapshot') {
    const result = await browserSnapshot();
    return { success: result.success, output: result.success ? result.content : `快照失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_click') {
    const result = await browserClick(call.arguments.selector, { button: call.arguments.button });
    return { success: result.success, output: result.success ? `已点击: ${call.arguments.selector}` : `点击失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_type') {
    const result = await browserType(call.arguments.selector, call.arguments.text, { clear: call.arguments.clear });
    return { success: result.success, output: result.success ? `已输入 ${call.arguments.text.length} 字符到 ${call.arguments.selector}` : `输入失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_evaluate') {
    const result = await browserEvaluate(call.arguments.expression);
    return { success: result.success, output: result.success ? result.result : `执行失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_wait') {
    const result = await browserWait({
      selector: call.arguments.selector,
      text: call.arguments.text,
      timeout: call.arguments.timeout,
    });
    return { success: result.success, output: result.success ? '等待条件已满足' : `等待超时: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_network') {
    const result = await browserNetwork({ urlPattern: call.arguments.url_pattern });
    return { success: result.success, output: result.success ? result.requests : `网络监听失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'browser_close') {
    const result = await closeBrowser();
    return { success: result.success, output: '浏览器已关闭', action: 'computer' };
  }

  // ═══ v2.4: 视觉验证工具（异步 + 需要 VisionCallback） ═══

  if (call.name === 'analyze_image') {
    if (!ctx.callVision) return { success: false, output: '视觉分析不可用：未配置 Vision LLM', action: 'computer' };
    const label = call.arguments.image_label || 'latest';
    const base64 = getCachedScreenshot(label);
    if (!base64) return { success: false, output: `未找到标签为 "${label}" 的截图。请先使用 screenshot 或 browser_screenshot 截图。`, action: 'computer' };
    const result = await analyzeImage(base64, call.arguments.question, ctx.callVision);
    return { success: result.success, output: result.success ? result.analysis : `分析失败: ${result.error}`, action: 'computer' };
  }

  if (call.name === 'compare_screenshots') {
    if (!ctx.callVision) return { success: false, output: '视觉对比不可用：未配置 Vision LLM', action: 'computer' };
    const beforeBase64 = getCachedScreenshot(call.arguments.before_label);
    const afterBase64 = getCachedScreenshot(call.arguments.after_label || 'latest');
    if (!beforeBase64) return { success: false, output: `未找到 "before" 截图: "${call.arguments.before_label}"`, action: 'computer' };
    if (!afterBase64) return { success: false, output: `未找到 "after" 截图: "${call.arguments.after_label || 'latest'}"`, action: 'computer' };
    const result = await compareScreenshots(beforeBase64, afterBase64, call.arguments.description || '', ctx.callVision);
    return {
      success: result.success,
      output: result.success
        ? `差异分析 (粗略差异: ${result.pixelDiffPercent}%):\n${result.analysis}`
        : `对比失败: ${result.error}`,
      action: 'computer',
    };
  }

  if (call.name === 'visual_assert') {
    if (!ctx.callVision) return { success: false, output: '视觉断言不可用：未配置 Vision LLM', action: 'computer' };
    const label = call.arguments.image_label || 'latest';
    const base64 = getCachedScreenshot(label);
    if (!base64) return { success: false, output: `未找到标签为 "${label}" 的截图`, action: 'computer' };
    const result = await visualAssert(base64, call.arguments.assertion, ctx.callVision);
    return {
      success: result.success,
      output: result.success
        ? `视觉断言 ${result.passed ? '✅ PASS' : '❌ FAIL'} (置信度: ${result.confidence}%)\n断言: ${call.arguments.assertion}\n依据: ${result.reasoning}`
        : `断言失败: ${result.error}`,
      action: 'computer',
    };
  }

  // 其余工具走同步
  return executeTool(call, ctx);
}

/** 生成 LLM function-calling 的 tools 参数 (OpenAI 格式) */
export function getToolsForLLM(gitMode: string = 'local'): any[] {
  return TOOL_DEFINITIONS
    .filter(t => {
      if (gitMode !== 'github' && t.name.startsWith('github_')) return false;
      return true;
    })
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

// ═══════════════════════════════════════
// v2.1: 动态工具加载 — 按角色筛选
// ═══════════════════════════════════════

export type AgentRole = 'pm' | 'architect' | 'developer' | 'qa' | 'devops' | 'researcher';

/** 各角色可用工具白名单 */
const ROLE_TOOLS: Record<AgentRole, string[]> = {
  pm: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'web_search', 'fetch_url',
  ],
  architect: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'write_file',
    'web_search', 'fetch_url',
    'memory_read', 'memory_append',
  ],
  developer: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'write_file', 'edit_file', 'batch_edit',
    'list_files', 'glob_files', 'search_files',
    'run_command', 'run_test', 'run_lint',
    'git_commit', 'git_diff',
    'web_search', 'fetch_url', 'http_request',
    'spawn_researcher',
    'memory_read', 'memory_append',
    // v2.4: Computer Use — 调试 GUI/桌面应用时截图、模拟操作
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    // v2.4: Playwright 浏览器 — 调试 Web 前端时启动浏览器验证
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // v2.4: 视觉验证 — 截图分析、前后对比、视觉断言
    'analyze_image', 'compare_screenshots', 'visual_assert',
  ],
  qa: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'run_command', 'run_test', 'run_lint',
    'web_search', 'fetch_url', 'http_request',
    'memory_read', 'memory_append',
    // v2.2: Computer Use 工具
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    // v2.3: Playwright 浏览器工具
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // v2.4: 视觉验证工具
    'analyze_image', 'compare_screenshots', 'visual_assert',
  ],
  devops: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'run_command', 'http_request',
    'git_commit', 'git_diff', 'git_log',
    'github_create_issue', 'github_list_issues',
    'memory_read', 'memory_append',
  ],
  researcher: [
    'think',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'web_search', 'fetch_url',
  ],
};

/**
 * 按角色返回工具列表 (OpenAI function-calling 格式)
 * 只返回该角色允许使用的工具，减少 token 浪费
 */
export function getToolsForRole(role: AgentRole, gitMode: string = 'local'): any[] {
  const allowed = new Set(ROLE_TOOLS[role] || ROLE_TOOLS.developer);

  // GitHub 工具额外过滤
  if (gitMode !== 'github') {
    allowed.delete('github_create_issue');
    allowed.delete('github_list_issues');
  }

  return TOOL_DEFINITIONS
    .filter(t => allowed.has(t.name))
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

/** 解析 LLM 返回的 tool_calls */
export function parseToolCalls(message: any): ToolCall[] {
  if (!message?.tool_calls) return [];
  return message.tool_calls.map((tc: any) => ({
    name: tc.function.name,
    arguments: typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : tc.function.arguments,
  }));
}
