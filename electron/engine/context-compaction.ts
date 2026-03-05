import { createLogger } from './logger';
const log = createLogger('context-compaction');

﻿/**
 * Context Compaction — 对话历史压缩 + 工具结果裁剪
 *
 * 从 context-collector.ts 拆分 (v12.3)
 *
 * 功能:
 * 1. needsCompaction() — 检查是否超预算
 * 2. compactMessages() — 智能压缩 ReAct 对话历史
 * 3. trimToolResult() — 裁剪大段工具输出
 * 4. compressFileContent() — 提取代码文件结构骨架
 */

// 粗略估算 token 数（中英文混合约 1.5 字符/token）
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface CompactionResult {
  messages: Array<{ role: string; content: string }>;
  tokensBefore: number;
  tokensAfter: number;
  ratio: number;
  usedLLM: boolean;
}

// ═══════════════════════════════════════
// Compaction check
// ═══════════════════════════════════════

/**
 * 检查消息列表是否需要压缩
 */
export function needsCompaction(
  messages: Array<{ role: string; content: string }>,
  tokenBudget: number,
  threshold: number = 0.75,
): boolean {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return total > tokenBudget * threshold;
}

// ═══════════════════════════════════════
// Message compaction
// ═══════════════════════════════════════

/**
 * 对 ReAct 对话历史进行智能压缩
 *
 * 策略：
 * 1. 保留 system prompt（第一条消息）
 * 2. 保留最近 N 条消息（活跃窗口）
 * 3. 中间的消息用确定性压缩（提取关键信息）
 * 4. 如果提供了 LLM 调用能力，可选用 LLM 生成摘要
 */
export async function compactMessages(
  messages: Array<{ role: string; content: string }>,
  tokenBudget: number,
  keepRecentCount: number = 6,
  llmSummarize?: (text: string) => Promise<string>,
): Promise<CompactionResult> {
  const tokensBefore = messages.reduce((s, m) => s + estimateTokens(m.content), 0);

  // 如果在预算内，不压缩
  if (tokensBefore <= tokenBudget * 0.75) {
    return {
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      ratio: 1.0,
      usedLLM: false,
    };
  }

  // 分区
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const nonSystem = systemMsg ? messages.slice(1) : messages;
  const recentStart = Math.max(0, nonSystem.length - keepRecentCount);
  const recent = nonSystem.slice(recentStart);
  const middle = nonSystem.slice(0, recentStart);

  if (middle.length === 0) {
    // 没有可压缩的中间部分
    return { messages, tokensBefore, tokensAfter: tokensBefore, ratio: 1.0, usedLLM: false };
  }

  // 确定性压缩中间消息
  let summaryText: string;
  let usedLLM = false;

  const middleText = middle.map(m => {
    const prefix = m.role === 'assistant' ? '[Agent]' : m.role === 'user' ? '[Tool Result]' : `[${m.role}]`;
    // 提取关键行：工具调用、错误、文件操作、关键决策
    const lines = m.content.split('\n');
    const keyLines = lines.filter(l => {
      const t = l.trim();
      return (
        t.startsWith('##') ||          // 标题
        t.includes('Error') ||         // 错误
        t.includes('✅') || t.includes('❌') || // 结果标记
        t.includes('created') || t.includes('modified') || // 文件操作
        t.startsWith('Think:') || t.startsWith('Action:') || // ReAct 步骤
        t.startsWith('write_file') || t.startsWith('read_file') || // 工具调用
        t.match(/^(Step|步骤)\s*\d/) // 步骤标记
      );
    });
    const compressed = keyLines.length > 0
      ? keyLines.slice(0, 10).join('\n')
      : lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n...' : '');
    return `${prefix}: ${compressed}`;
  }).join('\n');

  if (llmSummarize && estimateTokens(middleText) > 2000) {
    // 用 LLM 进一步压缩
    try {
      summaryText = await llmSummarize(
        `请将以下 ReAct 对话历史压缩为关键摘要（保留：已完成的操作、已创建/修改的文件、遇到的错误、关键决策）：\n\n${middleText}`,
      );
      usedLLM = true;
    } catch { /* silent: LLM summarize failed — use raw text */
      summaryText = middleText;
    }
  } else {
    summaryText = middleText;
  }

  // 构建压缩后的消息
  const compactedSummaryMsg = {
    role: 'user' as const,
    content: `[Compaction Summary — 以下是之前 ${middle.length} 条消息的压缩摘要]\n\n${summaryText}\n\n[End of compacted history. Continue from here.]`,
  };

  const result: Array<{ role: string; content: string }> = [];
  if (systemMsg) result.push(systemMsg);
  result.push(compactedSummaryMsg);
  result.push(...recent);

  const tokensAfter = result.reduce((s, m) => s + estimateTokens(m.content), 0);

  return {
    messages: result,
    tokensBefore,
    tokensAfter,
    ratio: tokensAfter / tokensBefore,
    usedLLM,
  };
}

// ═══════════════════════════════════════
// Tool result trimming
// ═══════════════════════════════════════

/**
 * 对单条工具返回结果进行裁剪
 * 当工具返回大段代码/日志时，智能截取关键部分
 */
export function trimToolResult(content: string, maxTokens: number = 3000): string {
  const charLimit = Math.floor(maxTokens * 1.5);
  if (content.length <= charLimit) return content;

  // 策略：保留头部 + 尾部 + 错误信息，按字符预算分配
  const lines = content.split('\n');
  const errorLines = lines.filter(l =>
    /error|Error|FAIL|warning/i.test(l),
  );

  // 预算分配：错误行30%, 头部50%, 尾部20%
  const errorBudget = errorLines.length > 0 ? Math.floor(charLimit * 0.3) : 0;
  const headBudget = Math.floor((charLimit - errorBudget) * 0.7);
  const tailBudget = charLimit - errorBudget - headBudget;

  // 按字符预算收集头部行
  const head: string[] = [];
  let headChars = 0;
  for (const line of lines) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
  }

  // 收集尾部行
  const tail: string[] = [];
  let tailChars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tailChars + lines[i].length + 1 > tailBudget) break;
    tail.unshift(lines[i]);
    tailChars += lines[i].length + 1;
  }

  // 收集错误行（去重与head/tail）
  const headTailSet = new Set([...head, ...tail]);
  const errors = errorLines.filter(l => !headTailSet.has(l)).slice(0, 10);

  const parts = [
    ...head,
    '',
    `... [省略 ${lines.length - head.length - tail.length} 行]`,
    '',
  ];

  if (errors.length > 0) {
    parts.push('--- 关键错误/警告 ---');
    parts.push(...errors);
    parts.push('');
  }

  parts.push(...tail);

  const result = parts.join('\n');
  return result.length <= charLimit + 50
    ? result
    : result.slice(0, charLimit) + '\n... [结果已截断]';
}

// ═══════════════════════════════════════
// File content compression
// ═══════════════════════════════════════

/**
 * 对单个文件内容进行压缩摘要
 * 保留：imports、exports、函数签名、类定义、关键注释
 * 裁剪：函数体、冗余注释、空行
 */
export function compressFileContent(content: string, maxLines: number = 30): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  const important: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 始终保留: import, export, interface, type, class, function 签名, 关键注释
    if (
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export ') ||
      trimmed.startsWith('interface ') ||
      trimmed.startsWith('type ') ||
      trimmed.startsWith('class ') ||
      trimmed.match(/^(export\s+)?(async\s+)?function\s/) ||
      trimmed.match(/^(export\s+)?const\s+\w+\s*[:=]/) ||
      trimmed.startsWith('/**') ||
      trimmed.startsWith('// ═') ||
      trimmed.startsWith('## ') ||
      trimmed.startsWith('# ')
    ) {
      important.push(line);
    }

    if (important.length >= maxLines) break;
  }

  if (important.length === 0) {
    // fallback: 取前 N 行 + 后 N 行
    const head = lines.slice(0, Math.floor(maxLines / 2));
    const tail = lines.slice(-Math.floor(maxLines / 4));
    return [...head, '// ... [已压缩]', ...tail].join('\n');
  }

  return [...important, `\n// ... [已压缩: ${lines.length} → ${important.length} 行]`].join('\n');
}
