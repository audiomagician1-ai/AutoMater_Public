/**
 * Experience Harvester — 经验收割钩子
 *
 * 设计哲学 (借鉴 agent-memory 写保护 + SWE-Exp 多层提取):
 *   - 由 harness 强制触发，不依赖 Agent 自觉
 *   - 先收割再去重，宁多勿漏
 *   - 产出写入已有存储 (project-memory / cross-project)
 *   - 所有操作 fire-and-forget，不阻塞主流程
 *
 * 触发点:
 *   1. harvestPostSession  — react-loop 结束后 (每次 session)
 *   2. harvestPostFeature   — Feature 完成/失败/PM 驳回后
 *
 * v1.0.0: 初始实现 (D4+D5+D9)
 */

import { callLLM } from './llm-client';
import { selectModelTier, resolveModel } from './model-selector';
import { appendProjectMemory } from './memory-system';
import { contributeKnowledge } from './cross-project';
import { createLogger } from './logger';
import type { AppSettings } from './types';

const log = createLogger('experience-harvester');

// ═══════════════════════════════════════
// D4: Post-Session 轻量反思 (每次 react-loop 结束)
// ═══════════════════════════════════════

export interface PostSessionOpts {
  projectId: string;
  agentId: string;
  role: string;
  featureId: string;
  featureTitle: string;
  completed: boolean;
  iterations: number;
  filesWritten: string[];
  workspacePath: string;
  settings: AppSettings;
  signal: AbortSignal;
}

/**
 * React-loop 结束后自动触发的轻量反思。
 * 条件: ≥3 轮迭代或写过文件。
 * 产出: 1-2 句经验写入 project-memory.md
 */
export async function harvestPostSession(opts: PostSessionOpts): Promise<void> {
  // 只有实际做了工作(≥3轮迭代或写过文件)才触发
  if (opts.iterations < 3 && opts.filesWritten.length === 0) return;

  try {
    const model = resolveModel(
      selectModelTier({ type: 'lesson_extract' }).tier,
      opts.settings,
    );
    const result = await callLLM(
      opts.settings, model,
      [
        {
          role: 'system',
          content:
            '你是经验提取助手。用1-2句话总结这次工作的关键经验(做对了什么/踩了什么坑)。' +
            '格式: 直接输出经验文本，不要标题、编号或其他格式。≤100字。',
        },
        {
          role: 'user',
          content:
            `Agent ${opts.agentId} (${opts.role}) 处理 Feature ${opts.featureId} "${opts.featureTitle}":\n` +
            `- 完成状态: ${opts.completed ? '成功' : '未完成'}\n` +
            `- 迭代次数: ${opts.iterations}\n` +
            `- 写入文件: ${opts.filesWritten.slice(0, 10).join(', ') || '(无)'}`,
        },
      ],
      opts.signal,
      256,
    );

    const lesson = result.content?.trim();
    if (lesson && lesson.length > 5) {
      appendProjectMemory(
        opts.workspacePath,
        `[${opts.featureId}:session] ${lesson}`,
      );
      log.info('Post-session harvest OK', { featureId: opts.featureId, lesson: lesson.slice(0, 80) });
    }
  } catch (e) {
    log.warn('Post-session harvest failed (non-fatal)', { error: String(e) });
  }
}

// ═══════════════════════════════════════
// D5+D9: Post-Feature 多层经验提取
// (含成功/失败/PM驳回/超时全路径)
// ═══════════════════════════════════════

export interface PostFeatureOpts {
  projectId: string;
  featureId: string;
  featureTitle: string;
  result: 'passed' | 'failed' | 'pm_rejected' | 'timeout';
  qaAttempts?: number;
  filesWritten?: string[];
  reason?: string;        // PM 驳回原因 / 超时描述 / 失败原因
  workspacePath: string;
  projectName: string;
  settings: AppSettings;
  signal: AbortSignal;
}

/**
 * Feature 完成后自动触发的多层经验提取。
 * 覆盖所有终态: passed / failed / pm_rejected / timeout
 * 产出:
 *   - project-memory.md (所有 scope)
 *   - cross-project knowledge (scope=global 的条目)  ← D9
 */
export async function harvestPostFeature(opts: PostFeatureOpts): Promise<void> {
  try {
    const model = resolveModel(
      selectModelTier({ type: 'lesson_extract' }).tier,
      opts.settings,
    );
    const result = await callLLM(
      opts.settings, model,
      [
        {
          role: 'system',
          content:
            '你是经验提取助手。从以下 Feature 结果中提取经验教训。\n' +
            '输出 JSON 数组，每条格式: {"summary":"≤80字经验","scope":"project 或 global"}\n' +
            'scope 说明: project=仅本项目有效, global=跨项目通用经验。\n' +
            '最多 3 条。只输出 JSON 数组，不要其他内容。',
        },
        {
          role: 'user',
          content:
            `Feature ${opts.featureId} "${opts.featureTitle}" 结果: ${opts.result}\n` +
            (opts.qaAttempts ? `QA 尝试次数: ${opts.qaAttempts}\n` : '') +
            (opts.reason ? `原因/反馈: ${opts.reason}\n` : '') +
            (opts.filesWritten?.length ? `涉及文件: ${opts.filesWritten.slice(0, 15).join(', ')}` : ''),
        },
      ],
      opts.signal,
      512,
    );

    const lessons = parseJsonArray(result.content);
    if (lessons.length === 0) {
      log.debug('Post-feature harvest: no lessons extracted', { featureId: opts.featureId });
      return;
    }

    for (const lesson of lessons) {
      // 写入 project-memory
      appendProjectMemory(
        opts.workspacePath,
        `[${opts.featureId}:${opts.result}] ${lesson.summary}`,
      );

      // D9: scope=global 时实时写入跨项目经验池
      if (lesson.scope === 'global') {
        contributeKnowledge(opts.projectName, [{
          summary: lesson.summary,
          content: `[${opts.result}] ${lesson.summary}`,
        }]);
      }
    }

    log.info('Post-feature harvest OK', {
      featureId: opts.featureId,
      result: opts.result,
      lessonsCount: lessons.length,
    });
  } catch (e) {
    log.warn('Post-feature harvest failed (non-fatal)', { error: String(e) });
  }
}

// ═══════════════════════════════════════
// D8: 从 project-memory.md 提取近期 Feature 经验
// ═══════════════════════════════════════

/**
 * 从 project-memory 中提取最近 N 条 [F-xxx] 格式的经验条目。
 * 用于 context-collector 注入 Instance Memory，让 Agent 在处理新 Feature 时
 * 知道之前 Feature 踩过什么坑。
 *
 * 纯函数，无副作用，无 LLM 调用。
 */
export function extractRecentFeatureLessons(
  projectMemoryContent: string,
  limit: number = 5,
): string {
  if (!projectMemoryContent) return '';

  // 匹配 [F-xxx:xxx] 或 [Fxxx:xxx] 格式的经验行
  // 典型格式: - [2025-03-02T10:30:00] [F-001:passed] 经验内容
  // 或:       - [2025-03-02T10:30:00] [F-001:session] 经验内容
  const lines = projectMemoryContent.split('\n');
  const featureLessons: string[] = [];

  for (const line of lines) {
    // 匹配 [F-xxx:yyy] 或 [Fxxx:yyy] 模式
    const match = line.match(/\[F[\w-]+:(passed|failed|pm_rejected|timeout|session)\]\s*(.+)/);
    if (match) {
      featureLessons.push(match[0]); // 保留完整的 [Fxxx:status] + 经验文本
    }
  }

  if (featureLessons.length === 0) return '';

  // 取最新的 N 条
  const recent = featureLessons.slice(-limit);
  return recent.join('\n');
}

// ═══════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════

function parseJsonArray(text: string): Array<{ summary: string; scope: string }> {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    // Validate structure
    return parsed
      .filter((item: unknown): item is { summary: string; scope: string } =>
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>).summary === 'string' &&
        typeof (item as Record<string, unknown>).scope === 'string',
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}
