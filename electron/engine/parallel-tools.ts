/**
 * Parallel Tool Execution — 无依赖工具并行执行
 *
 * 当 LLM 在一次回复中返回多个工具调用时，分析它们之间的依赖关系，
 * 将无依赖的只读调用并行执行，有副作用的调用串行执行。
 *
 * 性能影响: 典型 3 个并行搜索从 ~3s 降为 ~1s (节省 2/3 等待时间)
 *
 * v1.0 — 2026-03-02
 */


// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ExecutionPlan {
  /** 可以并行执行的批次 */
  batches: ToolCallInfo[][];
  /** 是否有工具被并行化 */
  hasParallelism: boolean;
  /** 预估节省的时间 (ms) */
  estimatedTimeSavedMs: number;
}

// ═══════════════════════════════════════
// Side-effect classification
// ═══════════════════════════════════════

/** 纯只读工具 — 可以安全并行 */
const READ_ONLY_TOOLS = new Set([
  // 文件读取
  'read_file', 'list_files', 'search_files', 'code_search', 'code_search_files',
  'read_many_files', 'glob_files', 'repo_map', 'code_graph_query',
  // Web 读取
  'web_search', 'web_search_boost', 'fetch_url', 'http_request',
  // 浏览器只读
  'browser_snapshot', 'browser_screenshot', 'browser_network', 'browser_console',
  // 思考/计划
  'think', 'todo_read', 'memory_read',
  // 技能查询
  'skill_search',
  // Git 只读
  'git_log', 'git_diff',
  // Docker 只读
  'sandbox_read',
  // 视觉分析
  'analyze_image', 'compare_screenshots', 'visual_assert',
]);

/** 有副作用的工具 — 必须串行 */
function hasSideEffect(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

// ═══════════════════════════════════════
// Dependency Analysis
// ═══════════════════════════════════════

/**
 * 检查两个工具调用之间是否有数据依赖
 * 简化规则: 如果工具 B 的参数引用了工具 A 操作的路径 → 有依赖
 */
function hasDependency(earlier: ToolCallInfo, later: ToolCallInfo): boolean {
  // 写入 → 读取同一文件
  if (earlier.name === 'write_file' || earlier.name === 'edit_file') {
    const writtenPath = String(earlier.arguments.path || '');
    if (writtenPath) {
      const laterArgs = JSON.stringify(later.arguments);
      if (laterArgs.includes(writtenPath)) return true;
    }
  }

  // sandbox_exec 后的 sandbox_read
  if (earlier.name === 'sandbox_exec' && later.name === 'sandbox_read') return true;

  // browser_navigate 后的 browser_snapshot/screenshot
  if (earlier.name === 'browser_navigate' &&
      (later.name === 'browser_snapshot' || later.name === 'browser_screenshot')) return true;

  // 浏览器交互后的其他浏览器操作
  if (earlier.name.startsWith('browser_') && later.name.startsWith('browser_') &&
      hasSideEffect(earlier.name)) return true;

  return false;
}

// ═══════════════════════════════════════
// Execution Plan Builder
// ═══════════════════════════════════════

/**
 * 分析一组工具调用，生成最优执行计划
 *
 * 策略:
 * 1. 所有只读工具 → 一个并行批次
 * 2. 有副作用的工具 → 按顺序单独批次
 * 3. 依赖于前一个写操作的读 → 延迟到写完成后
 */
export function buildExecutionPlan(toolCalls: ToolCallInfo[]): ExecutionPlan {
  if (toolCalls.length <= 1) {
    return {
      batches: [toolCalls],
      hasParallelism: false,
      estimatedTimeSavedMs: 0,
    };
  }

  const batches: ToolCallInfo[][] = [];
  let currentParallelBatch: ToolCallInfo[] = [];
  const executedSoFar: ToolCallInfo[] = [];

  for (const tc of toolCalls) {
    const isReadOnly = !hasSideEffect(tc.name);

    // 检查是否依赖前面的写操作
    const dependsOnPrevious = executedSoFar.some(prev => hasDependency(prev, tc));

    if (isReadOnly && !dependsOnPrevious) {
      // 可以并行
      currentParallelBatch.push(tc);
    } else {
      // 有副作用或有依赖 → 先 flush 并行批次，然后串行执行
      if (currentParallelBatch.length > 0) {
        batches.push(currentParallelBatch);
        executedSoFar.push(...currentParallelBatch);
        currentParallelBatch = [];
      }
      batches.push([tc]);
      executedSoFar.push(tc);
    }
  }

  // flush 最后的并行批次
  if (currentParallelBatch.length > 0) {
    batches.push(currentParallelBatch);
  }

  const parallelBatches = batches.filter(b => b.length > 1);
  const parallelToolCount = parallelBatches.reduce((sum, b) => sum + b.length, 0);

  // 估算节省时间: 每个并行批次中 (n-1) 个工具的平均时间
  const avgToolMs = 800; // 平均异步工具执行时间
  const savedMs = parallelBatches.reduce((sum, b) => sum + (b.length - 1) * avgToolMs, 0);

  return {
    batches,
    hasParallelism: parallelToolCount > 0,
    estimatedTimeSavedMs: savedMs,
  };
}

/**
 * 检查一个工具调用列表是否可以受益于并行执行
 * 快速检查 — 无需完整 plan 构建
 */
export function canParallelize(toolCalls: ToolCallInfo[]): boolean {
  if (toolCalls.length <= 1) return false;

  let readOnlyCount = 0;
  for (const tc of toolCalls) {
    if (!hasSideEffect(tc.name)) readOnlyCount++;
  }

  return readOnlyCount >= 2;
}

/**
 * 估算一个工具的典型执行时间 (ms)
 * 用于超时和进度估计
 */
export function estimateToolDuration(toolName: string): number {
  const estimates: Record<string, number> = {
    read_file: 50,
    list_files: 100,
    search_files: 300,
    code_search: 200,
    write_file: 50,
    edit_file: 50,
    run_command: 5000,
    run_test: 10000,
    run_lint: 3000,
    web_search: 2000,
    web_search_boost: 3000,
    fetch_url: 2000,
    deep_research: 15000,
    browser_navigate: 3000,
    browser_snapshot: 500,
    browser_screenshot: 1000,
    git_commit: 2000,
    git_diff: 500,
    spawn_agent: 30000,
    spawn_parallel: 30000,
    generate_image: 10000,
    deploy_compose: 15000,
    sandbox_exec: 5000,
  };

  return estimates[toolName] ?? 1000;
}
