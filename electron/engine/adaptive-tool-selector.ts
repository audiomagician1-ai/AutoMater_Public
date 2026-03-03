/**
 * Adaptive Tool Selector — 自适应工具选择器
 *
 * 根据项目类型、当前任务阶段、和历史调用效果，动态调整推荐给 Agent 的工具子集。
 * 核心思想: 减少工具列表噪声 → 提高 Agent 工具选择准确率 → 减少无效 token 消耗。
 *
 * 按 project profile + task phase 裁剪工具集，减少 30-50% 工具描述 token。
 *
 * v1.0 — 2026-03-02
 */

import type { OpenAIFunctionTool } from './types';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ProjectProfile {
  /** 项目语言/框架: react, vue, node, python, go, rust, etc. */
  languages: string[];
  /** 有 package.json? */
  hasPackageJson: boolean;
  /** 有 Docker? */
  hasDocker: boolean;
  /** 有测试框架? */
  hasTests: boolean;
  /** 项目规模 (文件数) */
  fileCount: number;
  /** 有 git 仓库? */
  hasGit: boolean;
  /** 外部 API (需要网络搜索?) */
  needsWebSearch: boolean;
}

export interface TaskContext {
  /** 当前阶段: planning / coding / testing / debugging / deploying / reviewing */
  phase: 'planning' | 'coding' | 'testing' | 'debugging' | 'deploying' | 'reviewing';
  /** 任务描述 (用于关键词匹配) */
  description?: string;
  /** 当前迭代次数 (后期减少探索工具) */
  iteration?: number;
  /** 最近使用的工具 (用于推荐互补工具) */
  recentTools?: string[];
  /** 最近失败的工具 (降权) */
  failedTools?: string[];
}

export interface ToolSelectionResult {
  /** 推荐的工具列表 (已过滤+排序) */
  tools: OpenAIFunctionTool[];
  /** 被移除的工具名 */
  removed: string[];
  /** 推荐理由 (人类可读) */
  reasoning: string;
  /** 节省的 token 估算 (工具描述) */
  estimatedTokenSaved: number;
}

// ═══════════════════════════════════════
// Tool Categories
// ═══════════════════════════════════════

interface ToolCategory {
  tools: string[];
  phases: string[];     // 适用阶段
  condition?: (profile: ProjectProfile) => boolean;
  priority: number;     // 1-10, 10 最高
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // 核心工具 — 始终可用
  core_read: {
    tools: ['read_file', 'list_files', 'search_files', 'code_search', 'code_search_files', 'glob_files'],
    phases: ['planning', 'coding', 'testing', 'debugging', 'deploying', 'reviewing'],
    priority: 10,
  },
  core_write: {
    tools: ['write_file', 'edit_file', 'batch_edit'],
    phases: ['coding', 'testing', 'debugging', 'deploying'],
    priority: 10,
  },
  core_think: {
    tools: ['think', 'todo_write', 'todo_read', 'task_complete', 'report_blocked'],
    phases: ['planning', 'coding', 'testing', 'debugging', 'deploying', 'reviewing'],
    priority: 10,
  },

  // 高级搜索 — 大项目或调试阶段
  advanced_search: {
    tools: ['read_many_files', 'repo_map', 'code_graph_query'],
    phases: ['planning', 'coding', 'debugging', 'reviewing'],
    condition: (p) => p.fileCount > 20,
    priority: 8,
  },

  // 命令执行 — coding/testing/debugging
  command_exec: {
    tools: ['run_command', 'run_test', 'run_lint'],
    phases: ['coding', 'testing', 'debugging', 'deploying'],
    priority: 9,
  },

  // Git — coding 及之后
  git: {
    tools: ['git_commit', 'git_diff', 'git_log'],
    phases: ['coding', 'testing', 'debugging', 'deploying', 'reviewing'],
    condition: (p) => p.hasGit,
    priority: 7,
  },
  github: {
    tools: ['github_create_issue', 'github_list_issues'],
    phases: ['planning', 'reviewing'],
    condition: (p) => p.hasGit,
    priority: 4,
  },

  // Web 搜索/研究 — planning, debugging, 或有外部依赖
  web_search: {
    tools: ['web_search', 'fetch_url', 'http_request', 'web_search_boost'],
    phases: ['planning', 'coding', 'debugging'],
    condition: (p) => p.needsWebSearch,
    priority: 6,
  },
  deep_research: {
    tools: ['deep_research'],
    phases: ['planning'],
    condition: (p) => p.needsWebSearch,
    priority: 5,
  },

  // Docker 沙箱 — 有 Docker 的项目
  docker: {
    tools: ['sandbox_init', 'sandbox_exec', 'sandbox_write', 'sandbox_read', 'sandbox_destroy'],
    phases: ['testing', 'debugging', 'deploying'],
    condition: (p) => p.hasDocker,
    priority: 6,
  },

  // 浏览器自动化 — 前端项目
  browser: {
    tools: ['browser_launch', 'browser_navigate', 'browser_screenshot', 'browser_snapshot',
            'browser_click', 'browser_type', 'browser_evaluate', 'browser_wait', 'browser_close',
            'browser_network'],
    phases: ['testing', 'debugging'],
    condition: (p) => p.languages.some(l => ['react', 'vue', 'angular', 'svelte', 'html'].includes(l)),
    priority: 5,
  },
  browser_advanced: {
    tools: ['browser_hover', 'browser_select_option', 'browser_press_key', 'browser_fill_form',
            'browser_drag', 'browser_tabs', 'browser_file_upload', 'browser_console'],
    phases: ['testing', 'debugging'],
    condition: (p) => p.languages.some(l => ['react', 'vue', 'angular', 'svelte', 'html'].includes(l)),
    priority: 3,
  },

  // 子代理 — 复杂任务 / 批量工作 / 大范围探索
  sub_agents: {
    tools: ['spawn_agent', 'spawn_parallel', 'spawn_researcher', 'list_sub_agents', 'cancel_sub_agent'],
    phases: ['planning', 'coding', 'testing', 'reviewing'],
    // v26.0: 大幅降低门槛 — 即使小项目也可以用子代理做并行编码/调研
    // 以前要 > 50 文件才给，现在只要有 5 个文件以上就给
    condition: (p) => p.fileCount > 5,
    priority: 6,
  },

  // 图片生成 — 特定需求
  image: {
    tools: ['generate_image', 'edit_image', 'configure_image_gen'],
    phases: ['coding'],
    priority: 2,
  },

  // 部署工具 — deploying 阶段
  deploy: {
    tools: ['deploy_compose', 'deploy_compose_down', 'deploy_pm2', 'deploy_pm2_status',
            'generate_nginx_config', 'generate_dockerfile', 'health_check'],
    phases: ['deploying'],
    condition: (p) => p.hasDocker,
    priority: 7,
  },

  // 黑盒测试 — testing 阶段
  blackbox: {
    tools: ['run_blackbox_tests'],
    phases: ['testing'],
    condition: (p) => p.hasDocker && p.hasTests,
    priority: 5,
  },

  // 视觉验证 — testing
  visual: {
    tools: ['analyze_image', 'compare_screenshots', 'visual_assert'],
    phases: ['testing'],
    priority: 3,
  },

  // 记忆/技能 — 所有阶段
  memory: {
    tools: ['memory_read', 'memory_append'],
    phases: ['planning', 'coding', 'testing', 'debugging', 'deploying', 'reviewing'],
    priority: 5,
  },
  skills: {
    tools: ['skill_acquire', 'skill_search', 'skill_improve', 'skill_record_usage'],
    phases: ['coding', 'reviewing'],
    priority: 3,
  },

  // GUI 桌面操作 — 极少使用
  gui: {
    tools: ['screenshot', 'mouse_click', 'mouse_move', 'keyboard_type', 'keyboard_hotkey'],
    phases: ['testing'],
    priority: 1,
  },

  // RFC — 架构讨论
  rfc: {
    tools: ['rfc_propose'],
    phases: ['planning', 'reviewing'],
    priority: 4,
  },

  // 搜索配置
  search_config: {
    tools: ['configure_search'],
    phases: ['planning'],
    priority: 2,
  },
};

// ═══════════════════════════════════════
// Profile Detection
// ═══════════════════════════════════════

/**
 * 从文件列表推断项目 Profile
 */
export function detectProjectProfile(files: string[]): ProjectProfile {
  const exts = new Map<string, number>();
  let hasPackageJson = false;
  let hasDocker = false;
  let hasTests = false;
  let hasGit = false;

  for (const file of files) {
    const lower = file.toLowerCase();
    const ext = lower.split('.').pop() || '';
    exts.set(ext, (exts.get(ext) || 0) + 1);

    if (lower.endsWith('package.json')) hasPackageJson = true;
    if (lower.includes('dockerfile') || lower.includes('docker-compose')) hasDocker = true;
    if (lower.includes('.test.') || lower.includes('.spec.') || lower.includes('__tests__')) hasTests = true;
    if (lower.includes('.git/') || lower === '.gitignore') hasGit = true;
  }

  const languages: string[] = [];
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'react', jsx: 'react', js: 'javascript',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c',
    vue: 'vue', svelte: 'svelte',
    html: 'html', css: 'css', scss: 'css',
  };

  for (const [ext, count] of exts) {
    if (count >= 3 && langMap[ext]) {
      languages.push(langMap[ext]);
    }
  }

  // React 检测 (tsx/jsx 或 package.json 有 react)
  if (hasPackageJson && !languages.includes('react')) {
    // 粗略推断: 有 tsx 就可能是 react
    if ((exts.get('tsx') || 0) > 0 || (exts.get('jsx') || 0) > 0) {
      languages.push('react');
    }
  }

  // 去重
  const uniqueLangs = [...new Set(languages)];

  return {
    languages: uniqueLangs,
    hasPackageJson,
    hasDocker,
    hasTests,
    fileCount: files.length,
    hasGit,
    needsWebSearch: false, // 默认不需要，由任务描述决定
  };
}

// ═══════════════════════════════════════
// Keyword-based need detection
// ═══════════════════════════════════════

function detectNeedsFromDescription(description: string): Partial<ProjectProfile> {
  const lower = description.toLowerCase();
  const needs: Partial<ProjectProfile> = {};

  if (/api|http|fetch|外部|third.?party|接口|调研|research/i.test(lower)) {
    needs.needsWebSearch = true;
  }

  return needs;
}

// ═══════════════════════════════════════
// Main Selection Logic
// ═══════════════════════════════════════

/**
 * 根据项目 Profile 和当前任务上下文，选择最适合的工具子集
 *
 * @param allTools     完整工具列表 (from getToolsForRole)
 * @param profile      项目 Profile
 * @param taskContext   当前任务上下文
 * @returns 过滤后的工具列表 + 推荐理由
 */
export function selectTools(
  allTools: OpenAIFunctionTool[],
  profile: ProjectProfile,
  taskContext: TaskContext,
): ToolSelectionResult {
  // 从描述中补充 profile
  if (taskContext.description) {
    const detected = detectNeedsFromDescription(taskContext.description);
    if (detected.needsWebSearch) profile.needsWebSearch = true;
  }

  // 计算每个工具的得分
  const toolScores = new Map<string, number>();
  const reasons: string[] = [];

  for (const [catName, cat] of Object.entries(TOOL_CATEGORIES)) {
    // 阶段匹配
    if (!cat.phases.includes(taskContext.phase)) continue;

    // 条件匹配
    if (cat.condition && !cat.condition(profile)) continue;

    for (const tool of cat.tools) {
      const existing = toolScores.get(tool) || 0;
      let score = cat.priority;

      // 迭代次数调整: 后期减少探索工具 (搜索、研究)
      if (taskContext.iteration && taskContext.iteration > 10) {
        if (catName.includes('search') || catName.includes('research')) {
          score *= 0.5;
        }
      }

      // 最近失败的工具降权
      if (taskContext.failedTools?.includes(tool)) {
        score *= 0.3;
      }

      // 互补推荐: 如果最近在读文件，推荐写入; 如果最近在搜索，推荐读取
      if (taskContext.recentTools) {
        const recent = new Set(taskContext.recentTools);
        if (recent.has('search_files') && catName === 'core_read') score *= 1.2;
        if (recent.has('read_file') && catName === 'core_write') score *= 1.2;
        if (recent.has('write_file') && catName === 'command_exec') score *= 1.3;
        if (recent.has('run_test') && tool === 'edit_file') score *= 1.3;
      }

      toolScores.set(tool, Math.max(existing, score));
    }
  }

  // 过滤: 保留得分 >= 1 的工具
  const selectedNames = new Set<string>();
  for (const [tool, score] of toolScores) {
    if (score >= 1) selectedNames.add(tool);
  }

  // 从 allTools 中过滤
  const selected: OpenAIFunctionTool[] = [];
  const removed: string[] = [];

  for (const tool of allTools) {
    if (selectedNames.has(tool.function.name)) {
      selected.push(tool);
    } else {
      removed.push(tool.function.name);
    }
  }

  // 按得分排序 (高分在前 → LLM 更容易注意到)
  selected.sort((a, b) => {
    const scoreA = toolScores.get(a.function.name) || 0;
    const scoreB = toolScores.get(b.function.name) || 0;
    return scoreB - scoreA;
  });

  // 生成推荐理由
  reasons.push(`阶段: ${taskContext.phase}`);
  reasons.push(`语言: ${profile.languages.join(', ') || '未检测'}`);
  reasons.push(`选中: ${selected.length}/${allTools.length} 工具`);
  if (removed.length > 0) {
    reasons.push(`移除: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ` +${removed.length - 5}` : ''}`);
  }

  // 估算 token 节省 (每个工具定义 ~100-200 tokens)
  const avgTokensPerTool = 150;
  const estimatedTokenSaved = removed.length * avgTokensPerTool;

  return {
    tools: selected,
    removed,
    reasoning: reasons.join(' | '),
    estimatedTokenSaved,
  };
}

// ═══════════════════════════════════════
// Phase Detection from task description
// ═══════════════════════════════════════

/**
 * 从任务描述推断当前阶段
 */
export function detectPhase(description: string, role: string): TaskContext['phase'] {
  const lower = description.toLowerCase();

  // 角色优先
  if (role === 'pm') return 'planning';
  if (role === 'architect') return 'planning';
  if (role === 'qa') return 'testing';
  if (role === 'devops') return 'deploying';

  // 关键词匹配
  if (/deploy|部署|上线|发布|nginx|docker.?compose|pm2/i.test(lower)) return 'deploying';
  if (/test|测试|验证|coverage|覆盖率|spec|e2e/i.test(lower)) return 'testing';
  if (/debug|修复|fix|bug|error|错误|排查|调试/i.test(lower)) return 'debugging';
  if (/review|审查|检查|code review|重构|refactor/i.test(lower)) return 'reviewing';
  if (/plan|规划|设计|需求|方案|architecture|架构/i.test(lower)) return 'planning';

  return 'coding'; // 默认
}
