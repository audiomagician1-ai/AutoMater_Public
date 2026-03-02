/**
 * Tool Definitions — LLM function-calling schemas
 *
 * Pure data: 所有内置工具的 JSON Schema 定义。
 * 从 tool-registry.ts (1850行) 拆出以提升可维护性。
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDef[] = [
  // ── File Operations ──
  {
    name: 'read_file',
    description: '读取文件内容（支持任意大小文件）。返回带行号的文本，支持 offset/limit 分页。大文件用流式读取，无大小限制。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对于工作区，或绝对路径需要 externalRead 权限）' },
        offset: { type: 'number', description: '起始行号 (从1开始)，默认1' },
        limit: { type: 'number', description: '读取行数，默认300（可在全景页配置），最大2000' },
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
    description: '在工作区文件中搜索文本/正则。基于 ripgrep（自动降级）。返回匹配行及上下文。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（支持正则语法）' },
        include: { type: 'string', description: '文件类型过滤 (如 *.ts, *.py)', default: '*' },
      },
      required: ['pattern'],
    },
  },
  // v17.0: 高级代码搜索工具
  {
    name: 'code_search',
    description: '高性能代码搜索 (ripgrep)。支持正则、多文件类型过滤、排除模式、大小写控制、全词匹配等高级选项。搜索大型代码库时优先使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式搜索模式' },
        include: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '文件过滤 glob 模式，如 "*.ts" 或 ["*.ts", "*.tsx"]',
        },
        exclude: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '排除 glob 模式，如 "*.test.ts" 或 ["*.test.*", "*.spec.*"]',
        },
        context: { type: 'number', description: '上下文行数(前后各N行)，默认2' },
        max_results: { type: 'number', description: '最大结果数，默认50' },
        case_sensitive: { type: 'boolean', description: '区分大小写，默认false' },
        fixed_string: { type: 'boolean', description: '固定字符串搜索(非正则)，默认false' },
        whole_word: { type: 'boolean', description: '全词匹配，默认false' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'code_search_files',
    description: '按 glob 模式搜索文件名（基于 ripgrep --files）。比 glob_files 更快，且遵守 .gitignore。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 模式，如 "*.ts"、"**/*config*"' },
        max_results: { type: 'number', description: '最大结果数，默认50' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_many_files',
    description: '按 glob 模式批量读取多个文件的内容。一次返回多个文件的带行号内容。适合快速了解多个相关文件。',
    parameters: {
      type: 'object',
      properties: {
        patterns: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Glob 模式（字符串或数组），如 "src/**/*.ts" 或 ["src/types.ts", "src/config.ts"]',
        },
        max_files: { type: 'number', description: '最多读取文件数，默认30' },
        max_lines_per_file: { type: 'number', description: '每文件最多行数，默认200' },
      },
      required: ['patterns'],
    },
  },
  {
    name: 'repo_map',
    description: '生成项目代码结构索引 — 提取所有函数签名、类定义、接口、export 等关键符号。快速了解整体项目架构。',
    parameters: {
      type: 'object',
      properties: {
        max_files: { type: 'number', description: '最多扫描文件数，默认80' },
        max_symbols: { type: 'number', description: '每文件最多符号数，默认20' },
        max_lines: { type: 'number', description: '总输出行数上限，默认300' },
      },
    },
  },
  {
    name: 'code_graph_query',
    description: '查询代码 import/export 依赖图。支持: summary(总览), depends_on(查依赖), depended_by(查被谁依赖), related(N跳关联文件)。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['summary', 'depends_on', 'depended_by', 'related'], description: '查询类型' },
        file: { type: 'string', description: '目标文件的相对路径（depends_on/depended_by/related 必填）' },
        hops: { type: 'number', description: 'related 查询的跳数，默认2' },
      },
      required: ['type'],
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
  {
    name: 'wait_for_process',
    description: '等待后台进程完成并返回完整结果。比反复调用 check_process 更高效——一次调用即可阻塞等待直到进程结束或超时。',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: '后台进程 ID (由 run_command 返回)' },
        timeout_seconds: { type: 'number', description: '最长等待秒数 (默认120, 最大600)' },
      },
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

  // ── Scratchpad 持久化工作记忆 (v19.0) ──
  {
    name: 'scratchpad_write',
    description: '将关键信息写入持久化工作记忆（不会因上下文压缩而丢失）。当你做出重要决策、发现关键事实、或完成阶段性进度时，务必调用此工具记录。',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['decision', 'progress', 'key_fact'],
          description: '记录分类: decision=关键决策(如选择了某框架/改变了某方案), progress=阶段进度(如完成了某模块), key_fact=重要发现(如某API有限制/某文件结构特殊)',
        },
        content: {
          type: 'string',
          description: '要记录的内容。应简洁但完整，包含足够的上下文信息让未来的自己能理解。',
        },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'scratchpad_read',
    description: '读取你的持久化工作记忆。包含之前记录的关键决策、进度、文件变更、错误记录等。在上下文被压缩后会自动注入，但你也可以主动读取。',
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

  // ── File Download & Image Search (v19.0) ──
  {
    name: 'download_file',
    description: '从 URL 下载文件（二进制安全）到 workspace。支持图片、PDF、压缩包等任意格式。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的文件 URL' },
        save_path: { type: 'string', description: '保存路径（相对 workspace 或绝对路径）' },
        filename: { type: 'string', description: '可选文件名' },
        timeout: { type: 'number', description: '下载超时 ms，默认 60000', default: 60000 },
        max_size: { type: 'number', description: '最大文件大小 bytes，默认 50MB', default: 52428800 },
      },
      required: ['url', 'save_path'],
    },
  },
  {
    name: 'search_images',
    description: '搜索网络图片。返回图片 URL 列表。配合 download_file 可实现「搜索 → 下载」。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '图片搜索关键词' },
        count: { type: 'number', description: '返回数量，默认 5，最大 20', default: 5 },
      },
      required: ['query'],
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

  // ═══════════════════════════════════════════════════
  // v9.0: Image Generation
  // ═══════════════════════════════════════════════════

  {
    name: 'generate_image',
    description: '文生图 — 根据文字描述生成图像。支持 DALL-E 3/2、Gemini Imagen、自定义 OpenAI 兼容 API (如本地 Stable Diffusion)。\n返回 base64 PNG + 可选本地保存。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像生成提示词 (英文效果更好)' },
        negative_prompt: { type: 'string', description: '负面提示词 (仅自定义 API 支持)' },
        size: { type: 'string', enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'], description: '图像尺寸，默认 1024x1024', default: '1024x1024' },
        quality: { type: 'string', enum: ['standard', 'hd'], description: '质量 (DALL-E 3)，默认 standard' },
        style: { type: 'string', enum: ['vivid', 'natural'], description: '风格 (DALL-E 3)，默认 vivid' },
        save_path: { type: 'string', description: '保存到本地的路径 (可选，如 ./assets/hero.png)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: '图像编辑 (inpainting) — 基于蒙版编辑已有图像的局部区域。仅 DALL-E 2 / 自定义 API 支持。',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '源图像标签 (来自截图缓存或 generate_image 缓存)' },
        prompt: { type: 'string', description: '编辑提示词 — 描述编辑区域的期望效果' },
        mask_label: { type: 'string', description: '蒙版图像标签 (透明区域=编辑区)' },
        size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'], description: '输出尺寸' },
        save_path: { type: 'string', description: '保存路径' },
      },
      required: ['image_label', 'prompt'],
    },
  },
  {
    name: 'configure_image_gen',
    description: '配置图像生成引擎。支持: openai (DALL-E)、gemini (Imagen)、custom (任何 OpenAI 兼容 API)。\n配置一次后所有后续 generate_image 调用都使用此配置。',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['openai', 'gemini', 'custom'], description: '图像生成引擎类型' },
        api_key: { type: 'string', description: 'API Key' },
        base_url: { type: 'string', description: 'API Base URL (OpenAI 默认 https://api.openai.com)' },
        model: { type: 'string', description: '模型名 (dall-e-3, dall-e-2, gemini-2.0-flash-exp 等)' },
      },
      required: ['provider', 'api_key'],
    },
  },

  // ═══════════════════════════════════════════════════
  // v9.0: Deployment Tools
  // ═══════════════════════════════════════════════════

  {
    name: 'deploy_compose_down',
    description: '停止并清理 Docker Compose 部署的服务 (docker compose down -v)',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'deploy_pm2_status',
    description: '查询 PM2 进程状态 — 名称、状态、CPU、内存、运行时间、重启次数',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  // ═══════════════════════════════════════════════════
  // v13.0: GitHub Extended + Deploy Tools
  // ═══════════════════════════════════════════════════

  {
    name: 'github_close_issue',
    description: '关闭 GitHub Issue（仅 GitHub 模式下可用）。',
    parameters: {
      type: 'object',
      properties: { issue_number: { type: 'number', description: 'Issue 编号' } },
      required: ['issue_number'],
    },
  },
  {
    name: 'github_add_comment',
    description: '在 GitHub Issue 上添加评论（仅 GitHub 模式下可用）。支持 Markdown。',
    parameters: {
      type: 'object',
      properties: {
        issue_number: { type: 'number', description: 'Issue 编号' },
        body: { type: 'string', description: '评论内容 (支持 Markdown)' },
      },
      required: ['issue_number', 'body'],
    },
  },
  {
    name: 'github_get_issue',
    description: '获取单个 GitHub Issue 的详细信息（仅 GitHub 模式下可用）。',
    parameters: {
      type: 'object',
      properties: { issue_number: { type: 'number', description: 'Issue 编号' } },
      required: ['issue_number'],
    },
  },
  // ═══════════════════════════════════════════════════
  // v14.0: Branch Management + Remote Sync + PR
  // ═══════════════════════════════════════════════════

  {
    name: 'git_create_branch',
    description: '创建并切换到新的 Git 分支。可指定基础分支，默认从当前分支创建。',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: '新分支名称（如 feature/login, fix/issue-42）' },
        base_branch: { type: 'string', description: '基础分支（可选，默认从当前分支创建）' },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_switch_branch',
    description: '切换到已存在的 Git 分支。',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: '目标分支名称' },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_list_branches',
    description: '列出本地所有 Git 分支及当前分支。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_delete_branch',
    description: '删除本地 Git 分支。不能删除当前所在分支。',
    parameters: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: '要删除的分支名称' },
        force: { type: 'boolean', description: '是否强制删除（未合并的分支需要强制删除）', default: false },
      },
      required: ['branch_name'],
    },
  },
  {
    name: 'git_pull',
    description: '从远程仓库拉取最新代码并合并到当前分支。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远程名称，默认 origin', default: 'origin' },
        branch: { type: 'string', description: '远程分支名（可选，默认跟踪分支）' },
      },
    },
  },
  {
    name: 'git_push',
    description: '将本地提交推送到远程仓库。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远程名称，默认 origin', default: 'origin' },
        branch: { type: 'string', description: '分支名（可选，默认 HEAD）' },
        set_upstream: { type: 'boolean', description: '是否设置上游跟踪（新分支首次 push 时需要）', default: false },
      },
    },
  },
  {
    name: 'git_fetch',
    description: '从远程仓库获取最新引用（不合并）。用于检查远程是否有新分支/提交。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远程名称，默认 origin', default: 'origin' },
      },
    },
  },
  {
    name: 'github_create_pr',
    description: '创建 GitHub Pull Request。需要 GitHub 模式。创建前请确保已 push 分支到远程。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR 标题' },
        body: { type: 'string', description: 'PR 描述 (支持 Markdown)' },
        head_branch: { type: 'string', description: '源分支（要合并的分支）' },
        base_branch: { type: 'string', description: '目标分支，默认 main', default: 'main' },
        draft: { type: 'boolean', description: '是否创建为草稿 PR', default: false },
      },
      required: ['title', 'body', 'head_branch'],
    },
  },
  {
    name: 'github_list_prs',
    description: '列出 GitHub Pull Requests。需要 GitHub 模式。',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态过滤，默认 open', default: 'open' },
      },
    },
  },
  {
    name: 'github_get_pr',
    description: '获取单个 GitHub Pull Request 的详细信息。',
    parameters: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'github_merge_pr',
    description: '合并 GitHub Pull Request。支持 merge/squash/rebase 三种方式。',
    parameters: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: '合并方式，默认 squash', default: 'squash' },
        commit_title: { type: 'string', description: '合并提交标题（可选）' },
      },
      required: ['pr_number'],
    },
  },
  // ═══════════════════════════════════════════════════
  // v14.0: Supabase Tools
  // ═══════════════════════════════════════════════════

  {
    name: 'supabase_status',
    description: '查询 Supabase 项目状态 (数据库地址、API URL、状态)。需要在密钥管理中配置 supabase_access_token 和 supabase_project_ref。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'supabase_migration_create',
    description: '创建 Supabase 数据库迁移文件。迁移文件会存放在 supabase/migrations/ 目录下。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '迁移名称 (如 add_users_table, create_posts)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'supabase_migration_push',
    description: '将本地迁移推送到远程 Supabase 数据库执行。⚠️ 此操作会修改远程数据库 Schema。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'supabase_db_pull',
    description: '从远程 Supabase 数据库拉取当前 Schema 到本地。用于同步远程手动修改。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'supabase_deploy_function',
    description: '部署 Supabase Edge Function。函数源码应在 supabase/functions/<name>/ 目录下。',
    parameters: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Edge Function 名称' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'supabase_gen_types',
    description: '从远程 Supabase Schema 生成 TypeScript 类型定义文件。输出到 src/types/supabase.ts。',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: '输出路径，默认 src/types/supabase.ts', default: 'src/types/supabase.ts' },
      },
    },
  },
  {
    name: 'supabase_set_secret',
    description: '设置 Supabase 项目的远程环境变量 (Secret)。用于配置 Edge Functions 的运行时环境。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '环境变量名' },
        value: { type: 'string', description: '环境变量值' },
      },
      required: ['name', 'value'],
    },
  },

  // ═══════════════════════════════════════════════════
  // v14.0: Cloudflare Tools
  // ═══════════════════════════════════════════════════

  {
    name: 'cloudflare_deploy_pages',
    description: '部署静态站点到 Cloudflare Pages。需要先构建 (npm run build) 生成 dist/ 目录。需要在密钥管理中配置 cloudflare_api_token 和 cloudflare_account_id。',
    parameters: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Pages 项目名称 (首次部署会自动创建)' },
        directory: { type: 'string', description: '构建输出目录，默认 dist', default: 'dist' },
        branch: { type: 'string', description: '部署分支名 (可选，影响预览/正式环境)' },
      },
    },
  },
  {
    name: 'cloudflare_deploy_worker',
    description: '部署 Cloudflare Worker。需要项目根目录有 wrangler.toml 配置文件。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker 名称 (可选，默认用 wrangler.toml 中的配置)' },
        entry_point: { type: 'string', description: '入口文件路径 (可选，默认用 wrangler.toml 中的配置)' },
      },
    },
  },
  {
    name: 'cloudflare_set_secret',
    description: '设置 Cloudflare Worker 的 Secret 环境变量。',
    parameters: {
      type: 'object',
      properties: {
        worker_name: { type: 'string', description: 'Worker 名称' },
        key: { type: 'string', description: '变量名' },
        value: { type: 'string', description: '变量值' },
      },
      required: ['worker_name', 'key', 'value'],
    },
  },
  {
    name: 'cloudflare_dns_list',
    description: '列出域名的 DNS 记录。需要在密钥管理中配置 cloudflare_zone_id。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'cloudflare_dns_create',
    description: '创建 DNS 记录 (A/AAAA/CNAME/TXT/MX 等)。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '记录类型 (A, AAAA, CNAME, TXT, MX 等)' },
        name: { type: 'string', description: '记录名 (如 www, api, @)' },
        content: { type: 'string', description: '记录值 (IP 地址/域名/文本)' },
        proxied: { type: 'boolean', description: '是否通过 Cloudflare 代理，默认 true', default: true },
      },
      required: ['type', 'name', 'content'],
    },
  },
  {
    name: 'cloudflare_status',
    description: '查询 Cloudflare Pages/Workers 部署状态。',
    parameters: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: 'Pages 项目名称' },
      },
      required: ['project_name'],
    },
  },

  // ═══════════════════════════════════════════════════
  // v15.0: Extended Deploy Tools (I4)
  // ═══════════════════════════════════════════════════

  {
    name: 'deploy_compose_generate',
    description: '生成 docker-compose.yml 内容（仅生成不执行）。返回 YAML 字符串供审查或手动修改。',
    parameters: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: '项目名称' },
        services: {
          type: 'array',
          description: '服务列表',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '服务名' },
              image: { type: 'string', description: 'Docker 镜像（与 build 二选一）' },
              build: { type: 'string', description: 'Dockerfile 路径（与 image 二选一）' },
              ports: { type: 'array', items: { type: 'string' }, description: '端口映射 host:container' },
              env: { type: 'object', description: '环境变量 key-value' },
              volumes: { type: 'array', items: { type: 'string' }, description: '卷挂载 host:container' },
              depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的服务名' },
              command: { type: 'string', description: '自定义启动命令' },
              restart: { type: 'string', enum: ['always', 'unless-stopped', 'on-failure', 'no'], description: '重启策略' },
            },
            required: ['name', 'ports'],
          },
        },
        network_name: { type: 'string', description: '自定义网络名（可选）' },
      },
      required: ['project_name', 'services'],
    },
  },
  {
    name: 'deploy_dockerfile_generate',
    description: '生成 Dockerfile 内容（仅生成字符串不写文件）。支持多阶段构建。',
    parameters: {
      type: 'object',
      properties: {
        base_image: { type: 'string', description: '基础镜像 (如 node:20-alpine, python:3.12-slim)' },
        install_cmd: { type: 'string', description: '安装依赖命令 (如 npm ci --omit=dev)' },
        build_cmd: { type: 'string', description: '构建命令 (如 npm run build)' },
        start_cmd: { type: 'string', description: '启动命令 (JSON 数组格式如 ["node","dist/index.js"])' },
        expose_ports: { type: 'array', items: { type: 'number' }, description: '暴露端口列表' },
        work_dir: { type: 'string', description: '工作目录，默认 /app' },
      },
      required: ['base_image', 'start_cmd'],
    },
  },
  {
    name: 'deploy_pm2_start',
    description: '使用 PM2 进程管理器启动 Node.js 应用。自动生成 ecosystem.config.js 并启动。',
    parameters: {
      type: 'object',
      properties: {
        apps: {
          type: 'array',
          description: '要启动的应用列表',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '应用名称' },
              script: { type: 'string', description: '启动脚本路径 (如 dist/index.js)' },
              cwd: { type: 'string', description: '工作目录（可选）' },
              args: { type: 'string', description: '启动参数（可选）' },
              instances: { type: 'number', description: '实例数，0 或 "max" 表示 CPU 核数' },
              env: { type: 'object', description: '环境变量 key-value' },
              max_memory_restart: { type: 'string', description: '内存超限自动重启阈值 (如 500M)' },
              watch: { type: 'boolean', description: '是否监听文件变化自动重启' },
            },
            required: ['name', 'script'],
          },
        },
      },
      required: ['apps'],
    },
  },
  {
    name: 'deploy_nginx_generate',
    description: '生成 Nginx 反向代理站点配置文件。支持 SSL、SPA 模式、WebSocket 代理。',
    parameters: {
      type: 'object',
      properties: {
        server_name: { type: 'string', description: '域名 (如 api.example.com)' },
        upstream: { type: 'string', description: '后端服务地址 (如 127.0.0.1:3000)' },
        listen_port: { type: 'number', description: '监听端口，默认 80 (有 SSL 时默认 443)' },
        static_root: { type: 'string', description: '静态文件根目录路径（可选）' },
        spa_mode: { type: 'boolean', description: '是否启用 SPA 模式 (所有路由 fallback 到 index.html)', default: false },
        ssl_cert_path: { type: 'string', description: 'SSL 证书路径（可选）' },
        ssl_key_path: { type: 'string', description: 'SSL 私钥路径（可选）' },
        output_dir: { type: 'string', description: '配置文件输出目录，默认项目根目录' },
      },
      required: ['server_name', 'upstream'],
    },
  },
  {
    name: 'deploy_find_port',
    description: '检测并返回一个可用的本地端口。用于部署前确认端口不冲突。',
    parameters: {
      type: 'object',
      properties: {
        start_port: { type: 'number', description: '起始端口，默认 3000', default: 3000 },
        end_port: { type: 'number', description: '结束端口，默认 9999', default: 9999 },
      },
    },
  },
];
