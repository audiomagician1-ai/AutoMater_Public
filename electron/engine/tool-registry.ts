/**
 * Tool Registry — 工具定义 + 角色权限 + Schema 格式化
 *
 * 职责单一：声明工具的 name / description / parameters (JSON Schema)，
 * 管理各角色的工具白名单，以及转换为 LLM function-calling 格式。
 *
 * v2.6.0: 从 tool-system.ts (1250行 God Object) 拆出
 * v5.0.0: 支持动态外部工具 (MCP + Skill) 合并到 getToolsForRole()
 */

import type { OpenAIFunctionTool } from './types';

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
  /** 当前 Worker ID — 用于文件级写锁 (构想A) */
  workerId?: string;
  /** 当前 Feature ID — 用于文件级写锁 (构想A) */
  featureId?: string;
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
    description: '在工作区中执行 shell 命令。用于安装依赖(npm install)、运行测试、编译检查等。同步模式超时60秒。background=true 时异步执行(最长30分钟)，返回进程ID供后续查询。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell 命令' },
        background: { type: 'boolean', description: '是否后台执行(长时间进程如dev server/build)，默认false' },
        timeout_seconds: { type: 'number', description: '超时秒数(同步默认60，后台默认1800)' },
      },
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
  {
    name: 'check_process',
    description: '查询后台进程的状态和输出。使用 run_command(background=true) 启动后台进程后，可用此工具查看进度。',
    parameters: {
      type: 'object',
      properties: { process_id: { type: 'string', description: '后台进程 ID (由 run_command 返回)' } },
      required: ['process_id'],
    },
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
    name: 'report_blocked',
    description: '当你无法获取完成任务所需的关键信息时调用此工具。它会暂停流水线并通知用户。\n使用场景：用户引用了你无法访问的路径/资源、需求描述严重不足无法做出合理分析、存在矛盾需要用户澄清。\n注意：仅在信息缺失会导致输出严重偏离时使用，小的模糊点用 notes 标注即可。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '阻塞原因：详细描述缺少什么信息' },
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          description: '建议的解决方式（如"请提供 xxx 目录的文件列表"、"请确认使用的技术栈"等）',
        },
        partial_result: { type: 'string', description: '到目前为止能确定的部分结果（如果有的话）' },
      },
      required: ['reason', 'suggestions'],
    },
  },
  {
    name: 'rfc_propose',
    description: '提出设计变更请求 (RFC)。当你在实现过程中发现设计文档中的问题、矛盾、或更优方案时使用此工具。RFC 会被记录并通知 PM 和用户审批。\n使用场景：发现架构设计不合理、API 设计有冲突、依赖不兼容、性能瓶颈需要架构调整等。\n注意：不要滥用——只在确实需要修改设计时使用，小的实现细节自行决定即可。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'RFC 标题（简短，<30字）' },
        problem: { type: 'string', description: '当前设计的问题描述' },
        proposal: { type: 'string', description: '建议的变更方案' },
        impact: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '影响范围：low=单个 feature, medium=多个 feature, high=整体架构',
        },
        affected_features: {
          type: 'array',
          items: { type: 'string' },
          description: '受影响的 Feature ID 列表',
        },
      },
      required: ['title', 'problem', 'proposal', 'impact'],
    },
  },
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

  // ── Skill Evolution (v5.1) ──
  {
    name: 'skill_acquire',
    description: '习得新技能：当你发现一个可复用的多步骤模式/流程时，用此工具将其提炼为技能。技能会跨项目共享，帮助未来的任务。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（简短，<20字）' },
        description: { type: 'string', description: '技能描述（<50字）' },
        trigger: { type: 'string', description: '触发条件描述（什么场景下应使用此技能，<30字）' },
        tags: { type: 'array', items: { type: 'string' }, description: '分类标签（如 ["typescript","testing"]）' },
        knowledge: { type: 'string', description: '详细步骤说明（Markdown 格式，200-500字，包含具体的操作步骤和注意事项）' },
      },
      required: ['name', 'description', 'trigger', 'knowledge'],
    },
  },
  {
    name: 'skill_search',
    description: '搜索已有技能：输入当前任务描述，查找相关的已习得技能和经验。返回匹配的技能列表及其知识文档。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或任务描述' },
        max_results: { type: 'number', description: '最大结果数，默认 3', default: 3 },
      },
      required: ['query'],
    },
  },
  {
    name: 'skill_improve',
    description: '改进已有技能：基于新的经验更新技能的步骤说明、触发条件或标签。每次改进自动版本递增。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '要改进的技能 ID（如 SK-001）' },
        knowledge: { type: 'string', description: '更新后的知识文档（Markdown 格式）' },
        trigger: { type: 'string', description: '更新后的触发条件（可选）' },
        change_note: { type: 'string', description: '本次改进说明（<50字）' },
      },
      required: ['skill_id', 'change_note'],
    },
  },
  {
    name: 'skill_record_usage',
    description: '记录技能使用结果：在使用了某个技能后，报告使用结果（成功/失败）和反馈。帮助系统追踪技能有效性并自动晋升成熟度。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '使用的技能 ID' },
        success: { type: 'boolean', description: '使用是否成功' },
        feedback: { type: 'string', description: '使用反馈或改进建议（可选）' },
      },
      required: ['skill_id', 'success'],
    },
  },

  // ═══════════════════════════════════════════════════
  // v7.0: Sub-Agent Framework
  // ═══════════════════════════════════════════════════

  {
    name: 'spawn_agent',
    description: '启动一个子 Agent 执行委派任务。子 Agent 拥有自己的工具集和执行环境，完成后返回结论和产出文件列表。\n预设角色: researcher(只读研究)、coder(编码)、reviewer(审查)、tester(测试)、doc_writer(文档)、deployer(运维)。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '委派给子 Agent 的任务描述（要清晰具体，包含足够上下文）' },
        preset: { type: 'string', enum: ['researcher', 'coder', 'reviewer', 'tester', 'doc_writer', 'deployer'], description: '预设角色' },
        extra_prompt: { type: 'string', description: '额外的指令（追加到角色 prompt 之后，可选）' },
        max_iterations: { type: 'number', description: '最大工具调用轮次（可选，默认按角色预设）' },
      },
      required: ['task', 'preset'],
    },
  },
  {
    name: 'spawn_parallel',
    description: '并行启动多个子 Agent，各自独立执行，全部完成后汇总结果。适合可并行的调研/编码/测试任务。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '任务 ID（用于结果匹配）' },
              task: { type: 'string', description: '任务描述' },
              preset: { type: 'string', enum: ['researcher', 'coder', 'reviewer', 'tester', 'doc_writer', 'deployer'], description: '预设角色' },
            },
            required: ['id', 'task', 'preset'],
          },
          description: '并行任务列表',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'list_sub_agents',
    description: '列出当前正在运行的子 Agent 及其状态。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_sub_agent',
    description: '取消一个正在执行的子 Agent。',
    parameters: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: '子 Agent ID（由 spawn_agent 返回）' } },
      required: ['agent_id'],
    },
  },

  // ═══════════════════════════════════════════════════
  // v7.0: Docker Sandbox
  // ═══════════════════════════════════════════════════

  {
    name: 'sandbox_init',
    description: '创建一个 Docker 容器沙箱。用于在隔离环境中安装依赖、运行测试、执行不信任的代码。需要宿主机已安装 Docker。\n预设: node, python, rust, go, ubuntu。也可指定任意 Docker 镜像。',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Docker 镜像或预设名（node/python/rust/go/ubuntu），默认 node', default: 'node' },
        mount_workspace: { type: 'boolean', description: '是否将当前工作区挂载到容器（默认 false）', default: false },
        env: { type: 'object', description: '环境变量 (key-value)' },
        memory_limit: { type: 'string', description: '内存限制（如 512m, 2g），默认 1g' },
      },
    },
  },
  {
    name: 'sandbox_exec',
    description: '在 Docker 沙箱中执行命令。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID (由 sandbox_init 返回)' },
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout: { type: 'number', description: '超时秒数，默认 60', default: 60 },
      },
      required: ['container_id', 'command'],
    },
  },
  {
    name: 'sandbox_write',
    description: '向 Docker 沙箱写入文件。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID' },
        path: { type: 'string', description: '容器内文件路径' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['container_id', 'path', 'content'],
    },
  },
  {
    name: 'sandbox_read',
    description: '从 Docker 沙箱读取文件。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID' },
        path: { type: 'string', description: '容器内文件路径' },
      },
      required: ['container_id', 'path'],
    },
  },
  {
    name: 'sandbox_destroy',
    description: '销毁 Docker 沙箱容器。',
    parameters: {
      type: 'object',
      properties: {
        container_id: { type: 'string', description: '容器 ID' },
      },
      required: ['container_id'],
    },
  },

  // ═══════════════════════════════════════════════════
  // v7.0: Browser Enhancements
  // ═══════════════════════════════════════════════════

  {
    name: 'browser_hover',
    description: '悬停在页面元素上（触发 tooltip / dropdown 等）。',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_select_option',
    description: '在下拉框中选择选项。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '下拉框 CSS 选择器' },
        values: { type: 'array', items: { type: 'string' }, description: '要选择的值' },
      },
      required: ['selector', 'values'],
    },
  },
  {
    name: 'browser_press_key',
    description: '按键盘键，如 ArrowDown、Escape、Enter、Tab 等。',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: '按键名（如 ArrowDown, Escape, Enter, Tab, Backspace）' } },
      required: ['key'],
    },
  },
  {
    name: 'browser_fill_form',
    description: '批量填写表单（多个字段一次调用）。支持文本框、复选框、下拉框。',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: '字段 CSS 选择器' },
              value: { type: 'string', description: '填入的值（checkbox 用 true/false）' },
              type: { type: 'string', enum: ['text', 'checkbox', 'select'], description: '字段类型，默认 text' },
            },
            required: ['selector', 'value'],
          },
          description: '表单字段列表',
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'browser_drag',
    description: '拖放操作（从一个元素拖到另一个元素）。',
    parameters: {
      type: 'object',
      properties: {
        source_selector: { type: 'string', description: '源元素 CSS 选择器' },
        target_selector: { type: 'string', description: '目标元素 CSS 选择器' },
      },
      required: ['source_selector', 'target_selector'],
    },
  },
  {
    name: 'browser_tabs',
    description: '管理浏览器标签页。操作: list(列出)、new(新建)、close(关闭)、select(切换)。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'close', 'select'], description: '操作类型' },
        index: { type: 'number', description: '标签页索引（close/select 时使用）' },
        url: { type: 'string', description: '新标签页的 URL（new 时使用）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_file_upload',
    description: '上传文件到页面的文件输入框。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '文件输入框 CSS 选择器（input[type=file]）' },
        file_paths: { type: 'array', items: { type: 'string' }, description: '要上传的文件路径列表' },
      },
      required: ['selector', 'file_paths'],
    },
  },
  {
    name: 'browser_console',
    description: '获取浏览器控制台日志（用于调试）。',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['error', 'warning', 'info', 'all'], description: '日志级别过滤，默认 info', default: 'info' },
      },
    },
  },

  // ═══════════════════════════════════════════════════
  // v8.0: Enhanced Search & Research
  // ═══════════════════════════════════════════════════

  {
    name: 'web_search_boost',
    description: '增强搜索：并行查询多个搜索引擎 (Brave/SearXNG/Serper/Jina)，结果去重合并，多引擎交叉验证的结果排名更高。用于重要查询。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        max_results: { type: 'number', description: '最大结果数，默认 15', default: 15 },
      },
      required: ['query'],
    },
  },
  {
    name: 'deep_research',
    description: '深度研究：对复杂问题进行多轮搜索、源页面深度提取、LLM 综合分析、事实交叉验证。输出完整研究报告。\n适合：技术选型调研、竞品分析、最佳实践研究、复杂 bug 根因分析。\n深度: quick(1轮) / standard(2轮) / deep(3轮+fact-check)。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '研究问题（越具体越好）' },
        context: { type: 'string', description: '额外上下文（项目背景、技术栈等）' },
        depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: '研究深度，默认 standard', default: 'standard' },
      },
      required: ['question'],
    },
  },
  {
    name: 'configure_search',
    description: '配置搜索引擎 API Keys。配置后搜索质量将大幅提升。\n推荐: Brave Search (免费 2000次/月)、Serper.dev (免费 2500次/月)。\nSearXNG 适合完全离线 LAN 部署。',
    parameters: {
      type: 'object',
      properties: {
        brave_api_key: { type: 'string', description: 'Brave Search API Key' },
        searxng_url: { type: 'string', description: 'SearXNG 实例 URL (如 http://localhost:8888)' },
        tavily_api_key: { type: 'string', description: 'Tavily API Key' },
        serper_api_key: { type: 'string', description: 'Serper.dev API Key' },
      },
    },
  },

  // ═══════════════════════════════════════════════════
  // v8.0: Black-Box Test Runner
  // ═══════════════════════════════════════════════════

  {
    name: 'run_blackbox_tests',
    description: '运行自主黑盒测试 + 迭代修复循环。\n流程: 自动生成测试用例 → 执行 → 分析失败 → 自动修复 → 重跑 → 直到全部通过或达到轮次限制。\n支持: 单元测试(沙箱)、集成测试、API测试、E2E浏览器测试。',
    parameters: {
      type: 'object',
      properties: {
        feature_description: { type: 'string', description: '要测试的功能描述（需求/验收标准）' },
        acceptance_criteria: { type: 'string', description: '验收标准（每条一行）' },
        code_files: { type: 'array', items: { type: 'string' }, description: '相关代码文件路径列表' },
        max_rounds: { type: 'number', description: '最大修复轮次，默认 5', default: 5 },
        test_types: { type: 'array', items: { type: 'string', enum: ['unit', 'integration', 'e2e', 'api'] }, description: '要运行的测试类型' },
        app_url: { type: 'string', description: '应用 URL (E2E 测试用，如 http://localhost:3000)' },
      },
      required: ['feature_description'],
    },
  },
];

// ═══════════════════════════════════════
// Role-based Tool Permissions
// ═══════════════════════════════════════

export type AgentRole = 'pm' | 'architect' | 'developer' | 'qa' | 'devops' | 'researcher' | 'meta-agent';

/** 各角色可用工具白名单 — 最小权限原则 */
const ROLE_TOOLS: Record<AgentRole, string[]> = {
  pm: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'list_files', 'search_files', 'glob_files',  // v5.5: PM 需要读文件能力 (分析用户提到的本地工程)
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research', 'configure_search',  // v8.0
    'memory_read', 'memory_append',
    'report_blocked',  // v5.5: 信息不足时阻塞反馈给用户
    'rfc_propose',     // v5.5: RFC 设计变更提案
  ],
  architect: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'write_file',
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research', 'configure_search',  // v8.0
    'memory_read', 'memory_append',
    'report_blocked',  // v5.5: 信息不足时阻塞反馈给用户
    'rfc_propose',     // v5.5: RFC 设计变更提案
  ],
  developer: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'write_file', 'edit_file', 'batch_edit',
    'list_files', 'glob_files', 'search_files',
    'run_command', 'run_test', 'run_lint',
    'git_commit', 'git_diff',
    'web_search', 'fetch_url', 'http_request',
    'web_search_boost', 'deep_research', 'configure_search',  // v8.0
    'spawn_researcher',
    'memory_read', 'memory_append',
    'check_process',   // v6.0: 查询后台进程状态
    'rfc_propose',     // v5.5: RFC 设计变更提案
    // Computer Use — 调试 GUI/桌面应用
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    // Playwright 浏览器 — 调试 Web 前端
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // v7.0: 浏览器增强
    'browser_hover', 'browser_select_option', 'browser_press_key', 'browser_fill_form',
    'browser_drag', 'browser_tabs', 'browser_file_upload', 'browser_console',
    // 视觉验证
    'analyze_image', 'compare_screenshots', 'visual_assert',
    // 技能进化 (v5.1)
    'skill_acquire', 'skill_search', 'skill_improve', 'skill_record_usage',
    // v7.0: Sub-Agent
    'spawn_agent', 'spawn_parallel', 'list_sub_agents', 'cancel_sub_agent',
    // v7.0: Docker Sandbox
    'sandbox_init', 'sandbox_exec', 'sandbox_write', 'sandbox_read', 'sandbox_destroy',
    // v8.0: Black-box test runner
    'run_blackbox_tests',
  ],
  qa: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'run_command', 'run_test', 'run_lint',
    'web_search', 'fetch_url', 'http_request',
    'web_search_boost', 'deep_research',  // v8.0
    'memory_read', 'memory_append',
    'screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey',
    'browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait',
    'browser_network', 'browser_close',
    // v7.0: 浏览器增强
    'browser_hover', 'browser_select_option', 'browser_press_key', 'browser_fill_form',
    'browser_drag', 'browser_tabs', 'browser_file_upload', 'browser_console',
    'analyze_image', 'compare_screenshots', 'visual_assert',
    // 技能进化 (v5.1)
    'skill_search', 'skill_record_usage',
    'rfc_propose',     // v5.5: RFC 设计变更提案
    // v7.0: Sub-Agent (QA can spawn researcher for analysis)
    'spawn_agent', 'list_sub_agents',
    // v7.0: Docker Sandbox (QA can use sandbox for test isolation)
    'sandbox_init', 'sandbox_exec', 'sandbox_read', 'sandbox_destroy',
    // v8.0: Black-box test runner
    'run_blackbox_tests',
  ],
  devops: [
    'think', 'task_complete', 'todo_write', 'todo_read',
    'run_command', 'check_process', 'http_request',
    'git_commit', 'git_diff', 'git_log',
    'github_create_issue', 'github_list_issues',
    'memory_read', 'memory_append',
  ],
  researcher: [
    'think',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research',  // v8.0
  ],
  // v6.1: 元Agent (管家) — 只读工具集 + 搜索 + 项目查询
  'meta-agent': [
    'think', 'task_complete',
    'read_file', 'list_files', 'search_files', 'glob_files',
    'web_search', 'fetch_url',
    'web_search_boost', 'deep_research',  // v8.0
    'memory_read', 'memory_append',
    'git_log',
  ],
};

// ═══════════════════════════════════════
// Formatting & Filtering
// ═══════════════════════════════════════

/** 将 ToolDefinition 转为 OpenAI function-calling 格式 */
function toOpenAITool(def: ToolDefinition): OpenAIFunctionTool {
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
export function getToolsForRole(role: AgentRole, gitMode: string = 'local'): OpenAIFunctionTool[] {
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

  return [...builtinTools, ...mcpTools, ...skillTools] as OpenAIFunctionTool[];
}

/** 返回所有工具 (OpenAI format)，可选按 gitMode 过滤 GitHub 工具 */
export function getToolsForLLM(gitMode: string = 'local'): OpenAIFunctionTool[] {
  const builtinTools = TOOL_DEFINITIONS
    .filter(t => {
      if (gitMode !== 'github' && t.name.startsWith('github_')) return false;
      return true;
    })
    .map(toOpenAITool);

  const mcpTools = getExternalMcpTools();
  const skillTools = getExternalSkillTools();

  return [...builtinTools, ...mcpTools, ...skillTools] as OpenAIFunctionTool[];
}
/**
 * 从 MCP Manager 获取外部工具 (OpenAI format)。
 * 使用延迟 require 避免模块初始化时的循环依赖。
 */
function getExternalMcpTools(role?: string): OpenAIFunctionTool[] {
  try {
    // Lazy import to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
function getExternalSkillTools(role?: string): OpenAIFunctionTool[] {
  try {
    // Lazy import to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
export function parseToolCalls(message: { tool_calls?: Array<{ function: { name: string; arguments: string | Record<string, unknown> } }> }): ToolCall[] {
  if (!message?.tool_calls) return [];
  return message.tool_calls.map((tc) => ({
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
    || toolName.startsWith('sandbox_')
    || ['web_search', 'fetch_url', 'http_request',
        'web_search_boost', 'deep_research', 'run_blackbox_tests',
        'analyze_image', 'compare_screenshots', 'visual_assert',
        'spawn_agent', 'spawn_parallel', 'spawn_researcher',
       ].includes(toolName);
}
