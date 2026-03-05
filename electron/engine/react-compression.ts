/**
 * ReAct Message Compression — 消息历史压缩 + 域推断 + tool pair 清理
 *
 * 从 react-loop.ts 拆出 (v30.2)
 */

import { callLLM, sleep } from './llm-client';
import { resolveModel, selectModelTier } from './model-selector';
import { createLogger } from './logger';
import type { AppSettings, LLMMessage, LLMToolCall, EnrichedFeature } from './types';

const log = createLogger('react-compression');

// ═══════════════════════════════════════
// Feature Domain Inference (for Experience Library)
// ═══════════════════════════════════════

/** 从 feature 的标题/描述/分类推断相关领域 */
export function inferDomainsFromFeature(feature: EnrichedFeature): string[] {
  const text =
    `${feature.title || ''} ${feature.description || ''} ${feature.category || ''} ${feature.acceptance_criteria || ''}`.toLowerCase();
  const domains: string[] = [];
  if (/typescript|tsx?|type|interface/.test(text)) domains.push('typescript');
  if (/react|component|hook|state|jsx|页面|组件/.test(text)) domains.push('react');
  if (/css|style|tailwind|布局|样式/.test(text)) domains.push('css');
  if (/api|endpoint|fetch|request|接口/.test(text)) domains.push('api');
  if (/test|spec|assert|mock|测试/.test(text)) domains.push('testing');
  if (/git|commit|branch/.test(text)) domains.push('git');
  if (/security|auth|token|权限|认证/.test(text)) domains.push('security');
  if (/sql|database|migration|表|数据库/.test(text)) domains.push('database');
  if (/electron|ipc|preload/.test(text)) domains.push('electron');
  if (/deploy|build|ci|cd|部署/.test(text)) domains.push('deploy');
  if (domains.length === 0) domains.push('general');
  return domains;
}

// ═══════════════════════════════════════
// Message History Compression
// ═══════════════════════════════════════

/**
 * 找到安全的压缩分界点 — 确保不会把 assistant(tool_calls) 和对应的 tool(tool_result) 拆散。
 * 返回可以安全压缩的消息数量（从 messages[1] 开始计数）。
 */
export function findSafeCompressBoundary(messages: LLMMessage[], keepRecent: number): number {
  let boundary = messages.length - keepRecent;
  // 向前扫描: 如果 boundary 切到了 assistant(tool_calls) 与 tool 之间，往前收缩
  // 确保 boundary 处不是 tool 消息（否则它的 assistant 在被压缩区域内但 tool 在保留区域）
  while (boundary > 1 && messages[boundary]?.role === 'tool') {
    boundary--;
  }
  // 同时确保 boundary 处不是带 tool_calls 的 assistant（否则 tool 结果在保留区但 assistant 被压缩）
  if (boundary > 1 && messages[boundary]?.role === 'assistant' && messages[boundary]?.tool_calls?.length) {
    // 这条 assistant 带 tool_calls，它后面的 tool 消息也应该一起保留
    boundary--;
  }
  return Math.max(1, boundary);
}

/**
 * 消息完整性修复 — 清理压缩后可能残留的孤儿 tool/tool_result 消息。
 * 确保每条 role=tool 的消息前面都有一条 assistant(tool_calls) 包含其 tool_call_id。
 */
export function sanitizeToolPairs(messages: LLMMessage[]): void {
  // 收集所有 assistant 消息中声明的 tool_call ids
  const declaredIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls as Array<{ id: string }>) {
        declaredIds.add(tc.id);
      }
    }
  }
  // 移除孤立的 tool 消息（其 tool_call_id 没有对应的 assistant tool_use）
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool' && messages[i].tool_call_id) {
      if (!declaredIds.has(messages[i].tool_call_id as string)) {
        messages.splice(i, 1);
      }
    }
  }
  // 移除孤立的 assistant(tool_calls)：如果其 tool_call_id 没有对应的 tool 结果
  const existingToolIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) existingToolIds.add(m.tool_call_id as string);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      const tcIds = (messages[i].tool_calls as Array<{ id: string }>).map(tc => tc.id);
      const hasAnyResult = tcIds.some(id => existingToolIds.has(id));
      if (!hasAnyResult) {
        // 这条 assistant 的所有 tool 结果都没了 → 退化为纯文本
        delete messages[i].tool_calls;
        if (!messages[i].content) messages[i].content = '[工具调用结果已压缩]';
      }
    }
  }
}

export async function compressMessageHistorySmart(
  messages: LLMMessage[],
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<void> {
  const keepRecent = 10;
  if (messages.length <= keepRecent + 2) return;

  const safeCount = findSafeCompressBoundary(messages, keepRecent);
  const compressRange = messages.slice(1, safeCount);
  if (compressRange.length < 5) return;

  const compressText = compressRange
    .map(m => {
      const role = m.role;
      const content = typeof m.content === 'string' ? m.content.slice(0, 300) : JSON.stringify(m.content).slice(0, 300);
      const toolInfo = m.tool_calls
        ? ` [tools: ${m.tool_calls.map((t: LLMToolCall) => t.function.name).join(',')}]`
        : '';
      return `[${role}]${toolInfo} ${content}`;
    })
    .join('\n');

  try {
    const summaryModel = resolveModel(selectModelTier({ type: 'summarize' }).tier, settings);
    const summaryResult = await callLLM(
      settings,
      summaryModel,
      [
        {
          role: 'system',
          content:
            '你是对话摘要助手。将以下 Agent 对话历史压缩为一段简洁摘要（200-400字），保留关键决策、已创建的文件、遇到的问题和解决方案。只输出摘要，不要其他内容。',
        },
        { role: 'user', content: `请摘要以下 ${compressRange.length} 条对话:\n\n${compressText.slice(0, 4000)}` },
      ],
      signal,
      1024,
      0,
    );

    if (summaryResult.content) {
      const summaryMsg: LLMMessage = {
        role: 'user',
        content: `## 之前的对话摘要 (${compressRange.length} 条消息已压缩)\n${summaryResult.content}`,
      };
      messages.splice(1, compressRange.length, summaryMsg);
      sanitizeToolPairs(messages);
      return;
    }
  } catch (err) {
    log.warn('LLM summarizer failed, falling back to simple truncation', { error: String(err) });
  }

  compressMessageHistorySimple(messages);
  sanitizeToolPairs(messages);
}

export function compressMessageHistorySimple(messages: LLMMessage[]) {
  const keepRecent = 10;
  const cutoff = messages.length - keepRecent;
  for (let i = 1; i < cutoff; i++) {
    if (messages[i].role === 'tool' && typeof messages[i].content === 'string') {
      const content = messages[i].content as string;
      if (content.length > 300) {
        messages[i].content = content.slice(0, 200) + '\n... [已压缩]';
      }
    }
  }
}
