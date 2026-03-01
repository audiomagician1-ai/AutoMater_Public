/**
 * Tool Registry — 工具定义 + 角色权限 + Schema 格式化
 *
 * 职责单一：声明工具的 name / description / parameters (JSON Schema)，
 * 管理各角色的工具白名单，以及转换为 LLM function-calling 格式。
 *
 * v2.6.0: 从 tool-system.ts (1250行 God Object) 拆出
 * v5.0.0: 支持动态外部工具 (MCP + Skill) 合并到 getToolsForRole()
 */

// ═══════════════════════════════════════
// Types
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

/** 工具执行上下文 (由 orchestrator 注入) */
export interface ToolContext {
  workspacePath: string;
  projectId: string;
  gitConfig: import('./git-provider').GitProviderConfig;
  /** Vision LLM 回调 (用于视觉验证工具) */
  callVision?: import('./visual-tools').VisionCallback;
}

// ═══════════════════════════════════════
// Tool Definitions (LLM JSON Schema)
// ═══════════════════════════════════════

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── File Operations ──
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

  // ── Shell / Test / Lint ──
  {
    name: 'run_command',
    description: '在工作区中执行 shell 命令。用于安装依赖(npm install)、运行测试、编译检查等。超时60秒。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell 命令' } },
      required: ['command'],
    },
  },
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

  // ── Git ──
  {
    name: 'git_commit',
    description: '提交当前所有变更到 git。如配置了 GitHub 会自动 push。',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: '提交信息' } },
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
      properties: { count: { type: 'number', description: '显示条数，默认10', default: 10 } },
    },
  },

  // ── GitHub ──
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
      properties: { state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' } },
    },
  },

  // ── Task / Memory ──
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
  {
    name: 'memory_read',
    description: '读取 Agent 记忆 (全局 + 项目 + 角色)。用于回忆之前的经验和约定。',
    parameters: {
      type: 'object',
      properties: { role: { type: 'string', description: '角色 (developer/qa/architect/pm)，默认 developer', default: 'developer' } },
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
  {
    name: 'spawn_researcher',
    description: '启动一个只读研究子 Agent。子 Agent 可以读取文件、搜索代码、查看目录，但不能修改任何内容。用于在不打断当前工作的情况下调研问题。最多 8 轮工具调用。',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: '要研究的问题，包括足够的背景信息' } },
      required: ['question'],
    },
  },

  // ── Thinking & Planning (v2.1) ──
  {
    name: 'think',
    description: '用于深度思考和推理的工具。写下你的分析、假设、计划，不会产生任何副作用。在面对复杂问题时，先用 think 理清思路再行动。',
    parameters: {
      type: 'object',
      properties: { thought: { type: 'string', description: '你的思考内容（推理过程、分析、计划等）' } },
      required: ['thought'],
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

  // ── Web (v2.1) ──
  {
    name: 'web_search',
    description: '搜索互联网。用于查找文档、API 用法、错误解决方案、最佳实践等。返回 Markdown 格式的搜索结果。',
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
    description: '抓取网页内容并转为 Markdown 纯文本。用于阅读文档页面、API 参考、博客文章等。',
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

  // ── Computer Use (v2.2) ──
  {
    name: 'screenshot',
    description: '截取当前屏幕截图。返回 base64 PNG 图像。用于查看桌面应用界面、验证 UI 状态。',
    parameters: {
      type: 'object',
      properties: { scale: { type: 'number', description: '缩放比例 (0.5=50%, 1=原始尺寸)，默认 0.75', default: 0.75 } },
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
    description: '移动鼠标到指定屏幕坐标（不点击）。',
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
      properties: { text: { type: 'string', description: '要输入的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'keyboard_hotkey',
    description: '按组合键或特殊键。格式: "modifier+key"。示例: "ctrl+s", "alt+f4", "enter", "tab"。',
    parameters: {
      type: 'object',
      properties: { combo: { type: 'string', description: '按键组合，如 "ctrl+s"、"enter"' } },
      required: ['combo'],
    },
  },

  // ── Playwright Browser (v2.3) ──
  {
    name: 'browser_launch',
    description: '启动浏览器实例（使用系统已安装的 Edge/Chrome）。',
    parameters: {
      type: 'object',
      properties: { headless: { type: 'boolean', description: '是否无头模式，默认 false', default: false } },
    },
  },
  {
    name: 'browser_navigate',
    description: '浏览器导航到指定 URL。返回页面标题和实际 URL。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要访问的 URL' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取当前浏览器页面的截图。返回 base64 PNG。',
    parameters: {
      type: 'object',
      properties: { full_page: { type: 'boolean', description: '是否截取整页，默认 false', default: false } },
    },
  },
  {
    name: 'browser_snapshot',
    description: '获取页面可访问性快照（文本 DOM 树）。比截图更省 token。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: '点击页面元素。使用 CSS 选择器或文本内容定位。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器或 Playwright 选择器' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: '在页面输入框中输入文本。',
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
    description: '在页面中执行 JavaScript 代码。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript 表达式或代码块' } },
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
    description: '查看浏览器网络请求（最近 3 秒）。',
    parameters: {
      type: 'object',
      properties: { url_pattern: { type: 'string', description: '过滤 URL 包含的字符串' } },
    },
  },
  {
    name: 'browser_close',
    description: '关闭浏览器实例。在测试完成后调用以释放资源。',
    parameters: { type: 'object', properties: {} },
  },

  // ── Visual Verification (v2.4) ──
  {
    name: 'analyze_image',
    description: '用 AI 视觉分析图像内容。配合 screenshot / browser_screenshot 使用。',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '要分析的图像标签，默认 "latest"', default: 'latest' },
        question: { type: 'string', description: '要分析的问题' },
      },
      required: ['question'],
    },
  },
  {
    name: 'compare_screenshots',
    description: '对比两张截图的差异。用于 UI 回归测试。',
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
    description: '视觉断言：验证截图是否满足指定条件。返回 pass/fail 和置信度。',
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
// Role-based Tool Permissions
// ═══════════════════════════════════════

export type AgentRole = 'pm' | 'architect' | 'developer' | 'qa' | 'devops' | 'researcher';

/** 各角色可用工具白名单 — 最小权限原则 */
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
    // Computer Use — 调试 GUI/桌面应用
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    // Playwright 浏览器 — 调试 Web 前端
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // 视觉验证
    'analyze_image', 'compare_screenshots', 'visual_assert',
  ],
  qa: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'run_command', 'run_test', 'run_lint',
    'web_search', 'fetch_url', 'http_request',
    'memory_read', 'memory_append',
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
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

// ═══════════════════════════════════════
// Formatting & Filtering
// ═══════════════════════════════════════

/** 将 ToolDefinition 转为 OpenAI function-calling 格式 */
function toOpenAITool(def: ToolDefinition): Record<string, any> {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  };
}

/**
 * 按角色返回工具列表 (OpenAI function-calling 格式)
 *
 * 合并三个来源:
 *   1. 内置工具 (TOOL_DEFINITIONS 中角色白名单内的)
 *   2. MCP 服务器发现的工具 (按 allowedRoles 过滤)
 *   3. Skill 目录加载的工具 (按 allowedRoles 过滤)
 *
 * @param role - Agent 角色
 * @param gitMode - git 模式 ('local' | 'github')
 */
export function getToolsForRole(role: AgentRole, gitMode: string = 'local'): any[] {
  const allowed = new Set(ROLE_TOOLS[role] || ROLE_TOOLS.developer);

  if (gitMode !== 'github') {
    allowed.delete('github_create_issue');
    allowed.delete('github_list_issues');
  }

  // 1. 内置工具
  const builtinTools = TOOL_DEFINITIONS
    .filter(t => allowed.has(t.name))
    .map(toOpenAITool);

  // 2. MCP 工具 (延迟导入避免循环依赖)
  const mcpTools = getExternalMcpTools(role);

  // 3. Skill 工具 (延迟导入避免循环依赖)
  const skillTools = getExternalSkillTools(role);

  return [...builtinTools, ...mcpTools, ...skillTools];
}

/** 返回所有工具 (OpenAI format)，可选按 gitMode 过滤 GitHub 工具 */
export function getToolsForLLM(gitMode: string = 'local'): any[] {
  const builtinTools = TOOL_DEFINITIONS
    .filter(t => {
      if (gitMode !== 'github' && t.name.startsWith('github_')) return false;
      return true;
    })
    .map(toOpenAITool);

  const mcpTools = getExternalMcpTools();
  const skillTools = getExternalSkillTools();

  return [...builtinTools, ...mcpTools, ...skillTools];
}

/**
 * 从 MCP Manager 获取外部工具 (OpenAI format)。
 * 使用延迟 require 避免模块初始化时的循环依赖。
 */
function getExternalMcpTools(role?: string): any[] {
  try {
    const { mcpManager } = require('./mcp-client') as typeof import('./mcp-client');
    const allTools = mcpManager.getAllTools();

    return allTools.map(t => toOpenAITool({
      name: `mcp_${t.serverId}_${t.name}`,
      description: `[MCP] ${t.description}`,
      parameters: t.inputSchema,
    }));
  } catch {
    return [];
  }
}

/**
 * 从 Skill Manager 获取外部工具 (OpenAI format)。
 */
function getExternalSkillTools(role?: string): any[] {
  try {
    const { skillManager } = require('./skill-loader') as typeof import('./skill-loader');
    const defs = role
      ? skillManager.getDefinitionsForRole(role)
      : skillManager.getAllDefinitions();
    return defs.map(toOpenAITool);
  } catch {
    return [];
  }
}

/** 解析 LLM 返回的 tool_calls (OpenAI 格式 → ToolCall[]) */
export function parseToolCalls(message: any): ToolCall[] {
  if (!message?.tool_calls) return [];
  return message.tool_calls.map((tc: any) => ({
    name: tc.function.name,
    arguments: typeof tc.function.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : tc.function.arguments,
  }));
}

/** 判断一个工具是否需要异步执行 */
export function isAsyncTool(toolName: string): boolean {
  // MCP 和 Skill 工具始终异步执行
  if (toolName.startsWith('mcp_') || toolName.startsWith('skill_')) return true;

  return toolName.startsWith('github_')
    || toolName.startsWith('browser_')
    || ['web_search', 'fetch_url', 'http_request',
        'analyze_image', 'compare_screenshots', 'visual_assert',
       ].includes(toolName);
}
