/**
 * Sub-Agent Result Compressor — 子 Agent 结果压缩器 (v19.0)
 *
 * 核心理念: 子 Agent 在内部做了 10~25 轮工具调用、读了几十个文件、
 * 搜了一堆网页——但父 Agent 只需要知道「关键结论 + 影响了哪些文件 + 关键发现」。
 *
 * 两种压缩模式:
 *   1. 结构化提取 (快速, 零 token) — 从 SubAgentResult 提取结构化信息
 *   2. LLM 摘要 (高质量, 消耗 token) — 对超长 conclusion 用 LLM 做二次提炼
 *
 * 使用位置:
 *   - tool-handlers-async.ts: spawn_agent / spawn_parallel 结果返回前
 *   - react-loop.ts: spawn_researcher 结果返回前
 *   - sub-agent-framework.ts: spawnSubAgent 内部的 tool 输出 masking
 *
 * @module sub-agent-compressor
 * @since v19.0
 */

import { createLogger } from './logger';

const log = createLogger('sub-agent-compressor');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SubAgentOutput {
  success: boolean;
  conclusion: string;
  filesCreated?: string[];
  filesModified?: string[];
  filesRead?: string[];
  actionSummary?: string;
  iterations?: number;
  cost?: number;
  durationMs?: number;
}

export interface CompressOptions {
  /** 输出最大字符数 (默认 2000) */
  maxChars?: number;
  /** 是否使用 LLM 做二次提炼 (需要传入 callLLM) */
  useLLM?: boolean;
  /** LLM 回调 (仅 useLLM=true 时需要) */
  callLLM?: (prompt: string) => Promise<string>;
  /** 子 Agent 角色/用途 (用于摘要上下文) */
  role?: string;
  /** 原始任务描述 (用于摘要上下文) */
  originalTask?: string;
}

// ═══════════════════════════════════════
// 结构化压缩 (零 token)
// ═══════════════════════════════════════

/**
 * 将子 Agent 结果压缩为父 Agent 可消费的精简格式。
 *
 * 策略:
 *   1. conclusion 超过 maxChars → 截断 + 提取关键信息
 *   2. actionSummary → 完全丢弃 (父 Agent 不需要知道子 Agent 调了哪些工具)
 *   3. 文件列表 → 保留 (影响决策)
 *   4. 元数据 → 一行统计
 */
export function compressSubAgentResult(
  output: SubAgentOutput,
  options: CompressOptions = {},
): string {
  const maxChars = options.maxChars ?? 2000;
  const sections: string[] = [];

  // ── 状态行 ──
  const statusIcon = output.success ? '✅' : '❌';
  const meta: string[] = [];
  if (output.iterations) meta.push(`${output.iterations}轮`);
  if (output.durationMs) meta.push(`${Math.round(output.durationMs / 1000)}s`);
  if (output.cost) meta.push(`$${output.cost.toFixed(4)}`);
  const role = options.role || '子Agent';
  sections.push(`${statusIcon} ${role} ${output.success ? '完成' : '失败'}${meta.length ? ` (${meta.join(', ')})` : ''}`);

  // ── 文件影响 ──
  const allFiles: string[] = [];
  if (output.filesCreated?.length) {
    allFiles.push(...output.filesCreated.map(f => `+ ${f}`));
  }
  if (output.filesModified?.length) {
    allFiles.push(...output.filesModified.map(f => `~ ${f}`));
  }
  if (output.filesRead?.length) {
    // 只列前 10 个读取的文件
    const readList = output.filesRead.length > 10
      ? [...output.filesRead.slice(0, 10), `... 及其他 ${output.filesRead.length - 10} 个`]
      : output.filesRead;
    allFiles.push(...readList.map(f => `📄 ${f}`));
  }
  if (allFiles.length > 0) {
    sections.push(`文件: ${allFiles.join(', ')}`);
  }

  // ── 核心结论 ──
  let conclusion = output.conclusion || '(无结论)';

  // 智能压缩: 如果结论过长, 提取关键段落
  const remainingBudget = maxChars - sections.join('\n').length - 50; // 留 50 字符余量
  if (conclusion.length > remainingBudget) {
    conclusion = smartTruncateConclusion(conclusion, remainingBudget);
  }
  sections.push(`\n${conclusion}`);

  const result = sections.join('\n');

  // 最终安全截断
  if (result.length > maxChars) {
    return result.slice(0, maxChars - 20) + '\n... [结论已截断]';
  }
  return result;
}

/**
 * 智能截断结论文本 — 保留关键段落而不是简单切头。
 *
 * 策略:
 *   1. 如果有明确的标题结构(#, ##, === 等), 保留各段首行
 *   2. 如果有编号列表(1. 2. 3.), 保留列表项
 *   3. 否则保留首段 + 末段
 */
function smartTruncateConclusion(text: string, maxLen: number): string {
  // 策略 1: 标题结构
  const sections = text.split(/\n(?=#{1,3}\s|={3,}|-{3,})/);
  if (sections.length >= 3) {
    let result = '';
    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;
      // 取每个 section 的前几行
      const lines = trimmed.split('\n');
      const sectionHead = lines.slice(0, Math.min(3, lines.length)).join('\n');
      if (result.length + sectionHead.length + 10 > maxLen) {
        result += '\n... [更多结论已省略]';
        break;
      }
      result += (result ? '\n\n' : '') + sectionHead;
      if (lines.length > 3) result += '\n...';
    }
    return result;
  }

  // 策略 2: 编号列表
  const numberedLines = text.split('\n').filter(l => /^\s*\d+[.)]\s/.test(l));
  if (numberedLines.length >= 3) {
    let result = '';
    for (const line of numberedLines) {
      if (result.length + line.length + 2 > maxLen) {
        result += '\n... [更多条目已省略]';
        break;
      }
      result += (result ? '\n' : '') + line;
    }
    return result;
  }

  // 策略 3: 首段 + 末段
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  if (paragraphs.length >= 2) {
    const first = paragraphs[0].slice(0, Math.floor(maxLen * 0.6));
    const last = paragraphs[paragraphs.length - 1].slice(0, Math.floor(maxLen * 0.35));
    return `${first}\n\n... [${paragraphs.length - 2} 段已省略]\n\n${last}`;
  }

  // Fallback: 直接截断
  return text.slice(0, maxLen - 20) + '\n... [已截断]';
}

// ═══════════════════════════════════════
// LLM 二次提炼 (高质量, 消耗 token)
// ═══════════════════════════════════════

/**
 * 用 LLM 对子 Agent 的长结论做二次提炼。
 * 仅在 conclusion > 3000 字符时触发, 避免浪费 token。
 */
export async function compressWithLLM(
  output: SubAgentOutput,
  options: CompressOptions,
): Promise<string> {
  if (!options.callLLM) {
    return compressSubAgentResult(output, options);
  }

  const conclusion = output.conclusion || '';
  // 短结论不需要 LLM 压缩
  if (conclusion.length < 3000) {
    return compressSubAgentResult(output, options);
  }

  try {
    const prompt = buildCompressionPrompt(output, options);
    const compressed = await options.callLLM(prompt);
    if (compressed && compressed.length < conclusion.length * 0.7) {
      // LLM 成功压缩了内容
      const compressedOutput = { ...output, conclusion: compressed };
      return compressSubAgentResult(compressedOutput, { ...options, maxChars: options.maxChars ?? 2500 });
    }
  } catch (err) {
    log.warn('LLM compression failed, falling back to structural', { error: String(err) });
  }

  // Fallback: 结构化压缩
  return compressSubAgentResult(output, options);
}

function buildCompressionPrompt(output: SubAgentOutput, options: CompressOptions): string {
  const task = options.originalTask ? `原始任务: ${options.originalTask}\n` : '';
  const files = [
    ...(output.filesCreated || []).map(f => `创建: ${f}`),
    ...(output.filesModified || []).map(f => `修改: ${f}`),
    ...(output.filesRead || []).map(f => `读取: ${f}`),
  ].join('\n');

  return `你是信息压缩专家。将以下子Agent的工作报告提炼为简洁的关键发现摘要。

要求:
- 只保留对父Agent后续决策有价值的信息
- 保留具体的文件名、行号、错误信息、API名称等关键细节
- 去除过程描述(我先做了X,然后做了Y)
- 输出 200-400 字即可
- 直接输出摘要,不要额外解释

${task}${files ? `相关文件:\n${files}\n\n` : ''}子Agent报告:
${output.conclusion.slice(0, 6000)}`;
}

// ═══════════════════════════════════════
// 用于 spawn_parallel 的批量压缩
// ═══════════════════════════════════════

export interface ParallelResultCompact {
  id: string;
  success: boolean;
  summary: string;
}

/**
 * 批量压缩并行子 Agent 结果
 */
export function compressParallelResults(
  results: Array<{ id: string; result: SubAgentOutput }>,
  maxTotalChars: number = 4000,
): string {
  const perResultBudget = Math.floor(maxTotalChars / Math.max(results.length, 1));

  const summaries = results.map(r => {
    const compact = compressSubAgentResult(r.result, { maxChars: perResultBudget });
    return `[${r.id}] ${compact}`;
  });

  const result = `并行执行完成 (${results.length} 个任务):\n\n${summaries.join('\n\n')}`;

  if (result.length > maxTotalChars) {
    return result.slice(0, maxTotalChars - 30) + '\n... [部分结果已截断]';
  }
  return result;
}
