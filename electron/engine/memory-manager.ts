/**
 * MemoryManager — 双轨消息架构 + Summary Chain + Memory Fence
 *
 * 核心设计:
 *   - original_messages: 完整历史，不可变，持续增长
 *   - working_messages:  推理用版本，会被压缩
 *   - Summary Chain:     记录每次压缩的 [start, end] + summary 文本，支持恢复
 *   - Memory Fence:      基于 maxTurns 的围栏，超出部分对 LLM 不可见（零开销）
 *   - safe_split_boundary: 保证压缩边界不切断 tool_call-tool_result 对
 *   - Background Compression: 后台异步 LLM 摘要，不阻塞主循环
 *
 * 与现有 react-compression.ts 的集成方式:
 *   - MemoryManager 包装 messages[] 生命周期
 *   - compressMessageHistorySmart 作为压缩后端被 MemoryManager 调用
 *   - react-loop 通过 MemoryManager 获取推理用消息
 *
 * @module memory-manager
 * @since v31.0
 */

import { createLogger } from './logger';
import type { LLMMessage } from './types';

const log = createLogger('memory-manager');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 单次 summary 压缩记录 (持久化用) */
export interface SummaryEntry {
  /** LLM 生成的摘要文本 */
  summaryText: string;
  /** 在 original_messages 中的替换起始索引 (含) */
  originalStart: number;
  /** 在 original_messages 中的替换结束索引 (不含) */
  originalEnd: number;
}

/** MemoryManager 的持久化状态 (可序列化为 JSON) */
export interface MemoryState {
  compressedCount: number;
  isCompressed: boolean;
  summaryEntries: SummaryEntry[];
}

// ═══════════════════════════════════════
// MemoryManager
// ═══════════════════════════════════════

export class MemoryManager {
  // ── 配置常量 ──
  /** 压缩时保留的头部消息数 (system prompt 等) */
  private readonly PRESERVE_HEAD = 2;
  /** 压缩时保留的尾部消息数 */
  private readonly PRESERVE_TAIL = 2;
  /** 中间部分至少需要的可压缩消息数 */
  private readonly MIN_COMPRESSIBLE = 3;

  // ── 双轨消息 ──
  /** 完整历史 — 只追加，不修改 */
  private originalMessages: LLMMessage[] = [];
  /** 推理版本 — 会被压缩 */
  private workingMessages: LLMMessage[] = [];

  // ── 压缩状态 ──
  private isCompressed = false;
  private compressedCount = 0;
  private summaryEntries: SummaryEntry[] = [];

  // ── 围栏 ──
  private maxTurns: number;

  constructor(maxTurns: number = 15) {
    this.maxTurns = maxTurns;
  }

  // ═══════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════

  /** 添加新消息到双轨 */
  addMessages(messages: LLMMessage[]): void {
    // original 深拷贝保护
    this.originalMessages.push(...structuredClone(messages));
    this.workingMessages.push(...messages);
  }

  /** 获取推理用消息 (应用围栏 + 裁剪) */
  getMessagesForInference(): LLMMessage[] {
    const messages = [...this.workingMessages];
    return this.applyFence(messages);
  }

  /** 获取当前 working_messages 的直接引用 (供 compressMessageHistorySmart 就地修改) */
  getWorkingMessages(): LLMMessage[] {
    return this.workingMessages;
  }

  /** 获取原始消息副本 */
  getOriginalMessages(): LLMMessage[] {
    return [...this.originalMessages];
  }

  /** 原始消息总数 */
  get originalCount(): number {
    return this.originalMessages.length;
  }

  /** working 消息总数 */
  get workingCount(): number {
    return this.workingMessages.length;
  }

  /** 是否已执行过压缩 */
  get compressed(): boolean {
    return this.isCompressed;
  }

  /** 判断是否应该压缩 */
  shouldCompress(contextTokens: number, maxContextTokens: number, threshold = 0.6): boolean {
    if (contextTokens <= maxContextTokens * threshold) return false;

    const clearableStart = this.compressedCount > 0 ? this.compressedCount : this.PRESERVE_HEAD;
    const clearableEnd = this.workingMessages.length - this.PRESERVE_TAIL;
    const clearable = clearableEnd - clearableStart;

    if (clearable < this.MIN_COMPRESSIBLE) {
      log.debug('Not enough messages to compress', {
        clearable,
        min: this.MIN_COMPRESSIBLE,
        total: this.workingMessages.length,
      });
      return false;
    }

    return true;
  }

  /**
   * 记录一次 LLM summary 压缩的结果
   * 在 compressMessageHistorySmart 成功执行后由调用方调用
   */
  recordSummaryCompression(summaryText: string, compressedRangeStart: number, compressedRangeEnd: number): void {
    // 映射 working 坐标到 original 坐标
    const offset =
      this.summaryEntries.length > 0
        ? this.summaryEntries.reduce((acc, e) => acc + (e.originalEnd - e.originalStart) - 2, 0)
        : 0;

    // 计算 original 坐标
    const nonSyntheticCount = this.workingMessages
      .slice(compressedRangeStart, compressedRangeEnd)
      .filter(m => !m._summary && !m._summaryCompact).length;

    const originalStart = compressedRangeStart + offset;
    const originalEnd = originalStart + nonSyntheticCount;

    if (originalStart < 0 || originalEnd > this.originalMessages.length) {
      log.warn('Summary entry coordinates invalid, skipping', {
        originalStart,
        originalEnd,
        originalLen: this.originalMessages.length,
      });
      return;
    }

    this.summaryEntries.push({ summaryText, originalStart, originalEnd });
    this.isCompressed = true;
    this.compressedCount = Math.max(0, this.workingMessages.length - this.PRESERVE_TAIL);

    log.info('Recorded summary compression', {
      entriesCount: this.summaryEntries.length,
      originalRange: `[${originalStart}, ${originalEnd})`,
      workingCount: this.workingMessages.length,
    });
  }

  /** 记录简单截断压缩 */
  recordRuleBasedCompression(): void {
    this.isCompressed = true;
    this.compressedCount = Math.max(0, this.workingMessages.length - this.PRESERVE_TAIL);
  }

  // ═══════════════════════════════════════
  // Background Compression — 后台异步压缩支持
  // ═══════════════════════════════════════

  /**
   * 快照当前 working_messages 用于后台压缩。
   * 返回深拷贝，后台可安全地在快照上做 LLM 摘要，不影响主循环。
   * 同时返回快照时的消息数量，用于后续 applyBackgroundSummary 判断有效性。
   */
  snapshotForCompression(): { messages: LLMMessage[]; snapshotLength: number } {
    return {
      messages: structuredClone(this.workingMessages),
      snapshotLength: this.workingMessages.length,
    };
  }

  /**
   * 应用后台压缩结果到 working_messages。
   *
   * 后台 compressMessageHistorySmart 在快照上就地修改后，把结果传回这里。
   * 安全策略:
   *   - 如果主循环在后台压缩期间追加了新消息，将新消息 append 到压缩结果后面
   *   - 如果快照已过期太久（新消息超过阈值），放弃此次结果
   *
   * @param compressedMessages 后台压缩完成的消息数组
   * @param snapshotLength     快照时 workingMessages.length
   * @param summaryText        LLM 生成的摘要文本 (如果有)
   * @returns 是否成功应用
   */
  applyBackgroundSummary(compressedMessages: LLMMessage[], snapshotLength: number, summaryText?: string): boolean {
    const currentLength = this.workingMessages.length;
    const newMessagesSinceSnapshot = currentLength - snapshotLength;

    // 安全阈值: 如果快照后新增了太多消息 (>20)，摘要可能已过时
    if (newMessagesSinceSnapshot > 20) {
      log.warn('Background summary expired — too many new messages since snapshot', {
        snapshotLength,
        currentLength,
        newMessages: newMessagesSinceSnapshot,
      });
      return false;
    }

    // 提取快照之后新增的消息
    const tailMessages = newMessagesSinceSnapshot > 0 ? this.workingMessages.slice(snapshotLength) : [];

    // 替换 working_messages = compressed + tail
    this.workingMessages = [...compressedMessages, ...tailMessages];

    // 记录压缩状态
    if (summaryText) {
      this.recordSummaryCompression(summaryText, this.PRESERVE_HEAD, snapshotLength);
    } else {
      this.recordRuleBasedCompression();
    }

    log.info('Applied background summary', {
      compressedCount: compressedMessages.length,
      tailAppended: tailMessages.length,
      newWorkingCount: this.workingMessages.length,
    });

    return true;
  }

  // ═══════════════════════════════════════
  // Memory Fence — 基于 maxTurns 的围栏
  // ═══════════════════════════════════════

  /** 设置围栏轮数 */
  setMaxTurns(n: number): void {
    this.maxTurns = n;
  }

  private applyFence(messages: LLMMessage[]): LLMMessage[] {
    if (this.maxTurns <= 0 || messages.length === 0) return messages;

    // 从后往前找 user 消息
    const userIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user' && !messages[i]._summaryCompact) {
        userIndices.push(i);
      }
    }

    if (userIndices.length <= this.maxTurns) return messages;

    // 取倒数第 maxTurns 个 user 的索引作为围栏
    const fenceIndex = userIndices[userIndices.length - this.maxTurns];

    // 保留 system prompt + fence 之后的消息
    const result = messages.filter((msg, i) => msg.role === 'system' || i >= fenceIndex);

    if (result.length < messages.length) {
      log.debug('Applied memory fence', {
        maxTurns: this.maxTurns,
        fenceIndex,
        hidden: messages.length - result.length,
      });
    }

    return result;
  }

  // ═══════════════════════════════════════
  // 持久化 — 导出/恢复
  // ═══════════════════════════════════════

  /** 导出持久化状态 */
  toState(): MemoryState {
    return {
      compressedCount: this.compressedCount,
      isCompressed: this.isCompressed,
      summaryEntries: [...this.summaryEntries],
    };
  }

  /** 从持久化状态 + 原始消息恢复 */
  restoreFromState(state: MemoryState, originalMessages: LLMMessage[]): void {
    this.isCompressed = state.isCompressed;
    this.compressedCount = state.compressedCount;
    this.summaryEntries = [...state.summaryEntries];
    this.originalMessages = structuredClone(originalMessages);

    if (!this.isCompressed || this.summaryEntries.length === 0) {
      this.workingMessages = [...originalMessages];
      return;
    }

    // 从 Summary Chain 重建 working_messages
    this.workingMessages = this.rebuildFromSummaryChain(originalMessages);
    log.info('Restored memory from state', {
      originalCount: originalMessages.length,
      workingCount: this.workingMessages.length,
      summaryEntries: this.summaryEntries.length,
    });
  }

  private rebuildFromSummaryChain(messages: LLMMessage[]): LLMMessage[] {
    let cursor = 0;
    const result: LLMMessage[] = [];

    for (const entry of this.summaryEntries) {
      if (entry.originalStart < cursor || entry.originalEnd > messages.length) {
        log.warn('Invalid summary entry during rebuild, using original messages', {
          cursor,
          start: entry.originalStart,
          end: entry.originalEnd,
        });
        return [...messages];
      }

      // 保留 cursor → originalStart 之间的原始消息
      result.push(...messages.slice(cursor, entry.originalStart));
      cursor = entry.originalEnd;

      // 插入 summary pair
      result.push(
        {
          role: 'user',
          content:
            '[CONTEXT COMPACTED] The following assistant message contains a summary of the previous conversation.',
          _summaryCompact: true,
        } as LLMMessage,
        {
          role: 'assistant',
          content: entry.summaryText,
          _summary: true,
        } as LLMMessage,
      );
    }

    // tail
    result.push(...messages.slice(cursor));
    return result;
  }

  /** 重置所有状态 */
  reset(): void {
    this.originalMessages = [];
    this.workingMessages = [];
    this.isCompressed = false;
    this.compressedCount = 0;
    this.summaryEntries = [];
  }
}
