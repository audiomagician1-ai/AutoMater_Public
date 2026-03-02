/**
 * Iteration Learning — 迭代间学习
 *
 * 在 ReAct 循环中跟踪工具调用失败模式，提取教训，并在后续迭代中
 * 将教训注入到系统 prompt 或 user message 中，帮助 Agent 避免重复犯错。
 *
 * 学习类型:
 *   1. 工具参数修正 (如 path 格式错误、缺少必填字段)
 *   2. 策略调整 (如搜索无结果 → 建议换关键词)
 *   3. 环境约束 (如 Docker 不可用 → 避免 sandbox 工具)
 *
 * v1.0 — 2026-03-02
 */

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ToolFailure {
  toolName: string;
  errorOutput: string;
  arguments: Record<string, unknown>;
  timestamp: number;
}

export interface Lesson {
  /** 教训类型 */
  type: 'param_fix' | 'strategy_change' | 'env_constraint' | 'general';
  /** 人类可读的教训描述 */
  description: string;
  /** 适用的工具 (空 = 通用) */
  tools: string[];
  /** 来源失败 */
  sourceFailure: ToolFailure;
  /** 创建时间 */
  createdAt: number;
}

export interface LearningState {
  /** 累积的失败记录 */
  failures: ToolFailure[];
  /** 提取的教训 */
  lessons: Lesson[];
  /** 已应用到 prompt 的教训数量 */
  appliedCount: number;
}

// ═══════════════════════════════════════
// Failure Pattern Matching
// ═══════════════════════════════════════

interface FailurePattern {
  /** 匹配条件: 工具名 (正则) */
  toolPattern: RegExp;
  /** 匹配条件: 错误输出 (正则) */
  errorPattern: RegExp;
  /** 生成的教训 */
  lessonType: Lesson['type'];
  /** 教训描述模板 */
  descriptionTemplate: string;
}

const FAILURE_PATTERNS: FailurePattern[] = [
  // 路径错误
  {
    toolPattern: /read_file|write_file|edit_file|list_files/,
    errorPattern: /not found|ENOENT|no such file|找不到/i,
    lessonType: 'param_fix',
    descriptionTemplate: '文件路径不存在。先用 list_files 或 search_files 确认路径，再操作文件。',
  },
  {
    toolPattern: /read_file|write_file|edit_file/,
    errorPattern: /permission denied|EACCES|权限/i,
    lessonType: 'env_constraint',
    descriptionTemplate: '文件权限不足。该路径可能是系统文件或只读目录。',
  },

  // 搜索无结果
  {
    toolPattern: /web_search|search_files|code_search/,
    errorPattern: /无匹配|no results|0 results|无结果/i,
    lessonType: 'strategy_change',
    descriptionTemplate: '搜索无结果。尝试: 1) 简化关键词 2) 换同义词 3) 放宽搜索范围。',
  },

  // Edit 匹配失败
  {
    toolPattern: /edit_file/,
    errorPattern: /old_string not found|未找到|不匹配/i,
    lessonType: 'param_fix',
    descriptionTemplate: 'edit_file 的 old_string 与文件内容不匹配。先用 read_file 读取最新内容，确认精确匹配。',
  },

  // 命令执行超时
  {
    toolPattern: /run_command|run_test/,
    errorPattern: /timeout|超时|ETIMEDOUT/i,
    lessonType: 'strategy_change',
    descriptionTemplate: '命令执行超时。考虑: 1) 增加 timeout 参数 2) 分拆为小命令 3) 使用 background: true。',
  },

  // 命令执行失败
  {
    toolPattern: /run_command/,
    errorPattern: /command not found|not recognized|无法识别/i,
    lessonType: 'env_constraint',
    descriptionTemplate: '命令不存在。检查工具是否安装、或使用 npx/pip 等包管理器运行。',
  },

  // Docker 不可用
  {
    toolPattern: /sandbox_init|sandbox_exec/,
    errorPattern: /docker.*not found|Cannot connect|docker daemon/i,
    lessonType: 'env_constraint',
    descriptionTemplate: 'Docker 不可用。该环境未安装 Docker，请使用 run_command 替代 sandbox_exec。',
  },

  // 浏览器操作失败
  {
    toolPattern: /browser_/,
    errorPattern: /not launched|timeout|no page|element not found/i,
    lessonType: 'param_fix',
    descriptionTemplate: '浏览器操作失败。确保: 1) 先 browser_launch 2) 先 browser_navigate 3) 用 browser_snapshot 确认元素存在。',
  },

  // JSON 解析失败
  {
    toolPattern: /.*/,
    errorPattern: /JSON|parse error|syntax error|unexpected token/i,
    lessonType: 'param_fix',
    descriptionTemplate: '参数格式错误 (JSON 解析失败)。确保工具参数是合法 JSON。',
  },

  // API Key 缺失
  {
    toolPattern: /web_search|generate_image/,
    errorPattern: /api.?key|unauthorized|401|403/i,
    lessonType: 'env_constraint',
    descriptionTemplate: 'API Key 未配置或无效。使用 configure_search/configure_image_gen 设置有效的 API Key。',
  },
];

// ═══════════════════════════════════════
// Learning Engine
// ═══════════════════════════════════════

/**
 * 创建新的学习状态
 */
export function createLearningState(): LearningState {
  return {
    failures: [],
    lessons: [],
    appliedCount: 0,
  };
}

/**
 * 记录一次工具调用失败
 */
export function recordFailure(state: LearningState, failure: ToolFailure): Lesson | null {
  state.failures.push(failure);

  // 保留最近 20 次失败
  if (state.failures.length > 20) {
    state.failures = state.failures.slice(-20);
  }

  // 尝试匹配失败模式
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.toolPattern.test(failure.toolName) &&
        pattern.errorPattern.test(failure.errorOutput)) {

      // 检查是否已有相同教训
      const duplicate = state.lessons.find(
        l => l.type === pattern.lessonType && l.tools.includes(failure.toolName),
      );
      if (duplicate) return null;

      const lesson: Lesson = {
        type: pattern.lessonType,
        description: pattern.descriptionTemplate,
        tools: [failure.toolName],
        sourceFailure: failure,
        createdAt: Date.now(),
      };

      state.lessons.push(lesson);

      // 保留最近 10 条教训
      if (state.lessons.length > 10) {
        state.lessons = state.lessons.slice(-10);
      }

      return lesson;
    }
  }

  // 重复失败检测: 同一工具连续失败 3 次
  const recentSameTool = state.failures
    .slice(-3)
    .filter(f => f.toolName === failure.toolName);

  if (recentSameTool.length >= 3) {
    const lesson: Lesson = {
      type: 'general',
      description: `${failure.toolName} 已连续失败 ${recentSameTool.length} 次。考虑: 1) 换一种方法 2) 检查参数 3) 跳过此步骤。`,
      tools: [failure.toolName],
      sourceFailure: failure,
      createdAt: Date.now(),
    };

    // 去重
    if (!state.lessons.find(l => l.type === 'general' && l.tools[0] === failure.toolName)) {
      state.lessons.push(lesson);
      return lesson;
    }
  }

  return null;
}

/**
 * 生成要注入 system prompt 的教训文本
 */
export function formatLessonsForPrompt(state: LearningState): string {
  if (state.lessons.length === 0) return '';

  const parts = ['## ⚠️ 从之前的迭代中学到的教训 (请严格遵守)'];

  for (let i = 0; i < state.lessons.length; i++) {
    const lesson = state.lessons[i];
    const toolInfo = lesson.tools.length > 0 ? ` [${lesson.tools.join(', ')}]` : '';
    parts.push(`${i + 1}. ${lesson.description}${toolInfo}`);
  }

  state.appliedCount = state.lessons.length;
  return parts.join('\n');
}

/**
 * 检查是否有新教训需要注入
 */
export function hasNewLessons(state: LearningState): boolean {
  return state.lessons.length > state.appliedCount;
}

/**
 * 将教训注入到消息历史中
 * 策略: 在 system message 之后追加一条 user message
 */
export function injectLessons(
  messages: Array<{ role: string; content: string | unknown }>,
  state: LearningState,
): boolean {
  if (!hasNewLessons(state)) return false;

  const lessonsText = formatLessonsForPrompt(state);
  if (!lessonsText) return false;

  // 查找是否已有教训消息
  const existingIdx = messages.findIndex(
    m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('⚠️ 从之前的迭代中学到的教训'),
  );

  if (existingIdx >= 0) {
    // 更新已有教训
    messages[existingIdx].content = lessonsText;
  } else {
    // 在第一条 user message 之后插入
    const firstUserIdx = messages.findIndex(m => m.role === 'user');
    if (firstUserIdx >= 0) {
      messages.splice(firstUserIdx + 1, 0, { role: 'user', content: lessonsText });
    }
  }

  return true;
}
