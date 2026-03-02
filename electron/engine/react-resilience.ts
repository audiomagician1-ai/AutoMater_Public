/**
 * React Resilience — 工具调用重试 + LLM 错误恢复 + 上下文窗口管理
 *
 * 从 react-loop.ts 拆出的健壮性增强模块:
 *   1. 工具调用智能重试 — 可重试工具失败时自动重试一次 (带退避)
 *   2. LLM 错误指数退避 — 替代固定 sleep(2000)
 *   3. 上下文 token 预算 — 主动检测并触发压缩
 *   4. 模型自动降级 — 连续 LLM 错误时降级到更稳定的模型
 *
 * 所有函数是纯函数或无状态工具，不引入新依赖。
 *
 * @module react-resilience
 * @since v8.0.0
 */

import { createLogger } from './logger';

const log = createLogger('react-resilience');

// ═══════════════════════════════════════
// 1. 工具调用智能重试
// ═══════════════════════════════════════

/** 判断工具是否可以安全重试 (无副作用 or 幂等) */
export function isRetryableTool(toolName: string): boolean {
  const RETRYABLE = new Set([
    // 搜索/网络 — 无副作用
    'web_search', 'web_search_boost', 'deep_research', 'fetch_url', 'http_request',
    // 读操作 — 无副作用
    'read_file', 'list_files', 'search_files', 'glob_files',
    'memory_read', 'todo_read',
    // 浏览器读操作 — 无副作用
    'browser_screenshot', 'browser_snapshot', 'browser_network', 'browser_console',
    // Docker 读操作
    'sandbox_read',
    // 思考 — 无副作用
    'think',
    // 视觉分析 — 无副作用
    'analyze_image', 'compare_screenshots', 'visual_assert',
    // 图像生成 — 幂等 (可重试)
    'generate_image',
    // 健康检查 — 无副作用
    'health_check', 'deploy_pm2_status',
  ]);
  return RETRYABLE.has(toolName);
}

/** 判断工具失败是否值得重试 (而非参数错误) */
export function isRetryableError(errorOutput: string): boolean {
  const RETRYABLE_PATTERNS = [
    /timeout/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /fetch failed/i,
    /network error/i,
    /rate.?limit/i,
    /429/,
    /500/,
    /502/,
    /503/,
    /504/,
    /搜索失败/,
    /抓取失败/,
    /HTTP \d{3}/,
  ];
  return RETRYABLE_PATTERNS.some(p => p.test(errorOutput));
}

// ═══════════════════════════════════════
// 2. LLM 指数退避
// ═══════════════════════════════════════

/**
 * 计算 LLM 错误重试的等待时间 (ms)
 *
 * - 第1次: 2s
 * - 第2次: 4s
 * - 第3次: 8s
 * - 最大: 30s
 */
export function getBackoffDelayMs(consecutiveErrors: number): number {
  const base = 2000;
  const maxDelay = 30_000;
  const delay = Math.min(base * Math.pow(2, consecutiveErrors - 1), maxDelay);
  // 加上 0-20% 随机抖动, 避免多 Agent 同时重试
  const jitter = delay * Math.random() * 0.2;
  return Math.round(delay + jitter);
}

// ═══════════════════════════════════════
// 3. 上下文窗口 Token 预算管理
// ═══════════════════════════════════════

/** 常见模型的上下文窗口大小 (tokens) */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  // Anthropic
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-opus-4': 200_000,
  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,
};

const DEFAULT_CONTEXT_LIMIT = 32_000;

/** 获取模型的上下文窗口大小 */
export function getModelContextLimit(model: string): number {
  // 精确匹配
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
  // 前缀匹配
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(key)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * 检查当前消息历史是否接近上下文窗口限制
 *
 * 返回:
 *   'ok'         — 低于 50% 使用率
 *   'warning'    — 50-75% 使用率 (建议压缩旧 tool 结果)
 *   'critical'   — 75-90% (必须立即压缩)
 *   'overflow'   — >90% (必须截断)
 *
 * @param estimatedTokens 当前消息总 token 估算
 * @param model 当前使用的模型名
 */
export function checkContextBudget(
  estimatedTokens: number,
  model: string,
): { status: 'ok' | 'warning' | 'critical' | 'overflow'; ratio: number; limit: number; headroom: number } {
  const limit = getModelContextLimit(model);
  const ratio = estimatedTokens / limit;
  const headroom = limit - estimatedTokens;

  let status: 'ok' | 'warning' | 'critical' | 'overflow';
  if (ratio > 0.9) status = 'overflow';
  else if (ratio > 0.75) status = 'critical';
  else if (ratio > 0.5) status = 'warning';
  else status = 'ok';

  return { status, ratio, limit, headroom };
}

/**
 * 对超长 tool 输出进行渐进式压缩
 *
 * 策略:
 *   1. warning  → 将旧 tool 输出截断到 500 字符
 *   2. critical → 将旧 tool 输出截断到 200 字符 + 移除 tool_calls 中间的 content
 *   3. overflow → 激进截断 + 移除最旧的 tool 对话轮
 *
 * @param messages 消息数组 (会被原地修改)
 * @param keepRecent 保留最近 N 条消息不压缩
 */
export function compressToolOutputs(
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }>,
  level: 'warning' | 'critical' | 'overflow',
  keepRecent: number = 8,
): { compressedCount: number; estimatedSaved: number } {
  const cutoff = Math.max(1, messages.length - keepRecent);
  let compressedCount = 0;
  let estimatedSaved = 0;

  const maxLen = level === 'overflow' ? 100 : level === 'critical' ? 200 : 500;

  for (let i = 1; i < cutoff; i++) {
    const msg = messages[i];

    // 压缩 tool 结果
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const content = msg.content as string;
      if (content.length > maxLen) {
        estimatedSaved += Math.ceil((content.length - maxLen) / 1.5);
        msg.content = content.slice(0, maxLen) + `\n... [已压缩, 原始 ${content.length} 字符]`;
        compressedCount++;
      }
    }

    // 压缩 assistant 内容 (保留 tool_calls)
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      const content = msg.content as string;
      if (content.length > maxLen * 2) {
        estimatedSaved += Math.ceil((content.length - maxLen * 2) / 1.5);
        msg.content = content.slice(0, maxLen * 2) + '\n... [已压缩]';
        compressedCount++;
      }
    }
  }

  // overflow 时: 移除最旧的工具交互轮次 (assistant + tool 对)
  if (level === 'overflow' && messages.length > keepRecent + 5) {
    // 找到最旧的 tool 交互对 (assistant with tool_calls + following tool messages)
    let removableStart = -1;
    let removableEnd = -1;
    for (let i = 1; i < cutoff; i++) {
      if (messages[i].role === 'assistant' && messages[i].tool_calls) {
        removableStart = i;
        // 找到这个 assistant 之后所有连续的 tool messages
        removableEnd = i + 1;
        while (removableEnd < cutoff && messages[removableEnd].role === 'tool') {
          removableEnd++;
        }
        break;
      }
    }
    if (removableStart >= 0) {
      const removed = messages.splice(removableStart, removableEnd - removableStart);
      const removedTokens = removed.reduce((sum, m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + Math.ceil(text.length / 1.5);
      }, 0);
      estimatedSaved += removedTokens;
      compressedCount += removed.length;
      log.info(`Overflow compression: removed ${removed.length} messages (~${removedTokens} tokens)`);
    }
  }

  return { compressedCount, estimatedSaved };
}

// ═══════════════════════════════════════
// 4. 模型自动降级
// ═══════════════════════════════════════

/**
 * 根据连续错误次数决定是否降级模型
 *
 * 策略:
 *   - 1-2 次错误: 保持当前模型
 *   - 3+ 次错误: 降级到 worker 模型
 *   - 5+ 次错误: 降级到 mini/fast 模型
 *
 * @returns null 表示不降级; 否则返回建议的模型 tier
 */
export function suggestModelDowngrade(
  consecutiveErrors: number,
  currentTier: 'strong' | 'worker' | 'mini',
): 'strong' | 'worker' | 'mini' | null {
  if (consecutiveErrors < 3) return null;

  if (currentTier === 'strong' && consecutiveErrors >= 3) {
    return 'worker';
  }
  if (currentTier === 'worker' && consecutiveErrors >= 5) {
    return 'mini';
  }

  return null; // 已经是最低层级 or 不需要降级
}

// ═══════════════════════════════════════
// 5. 错误恢复消息注入
// ═══════════════════════════════════════

/**
 * 当工具重复失败时, 生成提示 LLM 换策略的消息
 */
export function buildRecoveryHint(
  toolName: string,
  failCount: number,
  lastError: string,
): string {
  if (failCount >= 3) {
    return `⚠️ 工具 ${toolName} 已连续失败 ${failCount} 次 (最后错误: ${lastError.slice(0, 100)})。
请换一种方法完成当前任务，不要继续重试同一个工具。`;
  }
  if (failCount >= 2) {
    return `⚠️ 工具 ${toolName} 第 ${failCount} 次失败。请检查参数或考虑替代方案。`;
  }
  return '';
}
