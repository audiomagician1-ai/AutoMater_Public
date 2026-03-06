/**
 * MemoryManager tests — 双轨消息 + Summary Chain + Memory Fence
 * @since v31.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager, type SummaryEntry, type MemoryState } from '../memory-manager';
import type { LLMMessage } from '../types';

function msg(role: LLMMessage['role'], content: string, extras?: Partial<LLMMessage>): LLMMessage {
  return { role, content, ...extras };
}

describe('MemoryManager', () => {
  let mm: MemoryManager;

  beforeEach(() => {
    mm = new MemoryManager(10);
  });

  // ── 基本双轨操作 ──

  describe('dual-track messages', () => {
    it('addMessages stores to both tracks', () => {
      mm.addMessages([msg('system', 'hello'), msg('user', 'hi')]);
      expect(mm.originalCount).toBe(2);
      expect(mm.workingCount).toBe(2);
    });

    it('original and working are independent (deepcopy isolation)', () => {
      const m = msg('user', 'original text');
      mm.addMessages([m]);
      // Mutate working messages directly
      mm.getWorkingMessages()[0].content = 'mutated';
      // original should be unchanged
      expect(mm.getOriginalMessages()[0].content).toBe('original text');
    });

    it('getMessagesForInference returns copy, not reference', () => {
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1')]);
      const inference = mm.getMessagesForInference();
      expect(inference.length).toBe(2);
      expect(inference).not.toBe(mm.getWorkingMessages());
    });
  });

  // ── Memory Fence ──

  describe('memory fence', () => {
    it('does not fence when under maxTurns', () => {
      mm.setMaxTurns(5);
      mm.addMessages([
        msg('system', 'sys'),
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('user', 'q2'),
        msg('assistant', 'a2'),
      ]);
      const result = mm.getMessagesForInference();
      expect(result.length).toBe(5);
    });

    it('applies fence when exceeding maxTurns', () => {
      mm.setMaxTurns(2);
      mm.addMessages([
        msg('system', 'sys'),
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('user', 'q2'),
        msg('assistant', 'a2'),
        msg('user', 'q3'),
        msg('assistant', 'a3'),
      ]);
      const result = mm.getMessagesForInference();
      // system + last 2 user turns (q2+a2, q3+a3) = 5
      expect(result.length).toBe(5);
      expect(result[0].role).toBe('system');
      expect(result[1].content).toBe('q2');
    });

    it('fence preserves system prompts', () => {
      mm.setMaxTurns(1);
      mm.addMessages([
        msg('system', 'sys'),
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('user', 'q2'),
        msg('assistant', 'a2'),
      ]);
      const result = mm.getMessagesForInference();
      expect(result[0].role).toBe('system');
      expect(result[0].content).toBe('sys');
      expect(result[1].content).toBe('q2');
    });

    it('fence does nothing when maxTurns=0', () => {
      mm.setMaxTurns(0);
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')]);
      expect(mm.getMessagesForInference().length).toBe(4);
    });
  });

  // ── Compression state ──

  describe('compression', () => {
    it('shouldCompress returns false when under threshold', () => {
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1')]);
      expect(mm.shouldCompress(1000, 10000, 0.6)).toBe(false);
    });

    it('shouldCompress returns false when not enough messages', () => {
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1'), msg('assistant', 'a1')]);
      // Only 3 messages, PRESERVE_HEAD=2 + PRESERVE_TAIL=2 → no clearable range
      expect(mm.shouldCompress(9000, 10000, 0.6)).toBe(false);
    });

    it('shouldCompress returns true when threshold exceeded and enough messages', () => {
      const msgs: LLMMessage[] = [msg('system', 'sys')];
      for (let i = 0; i < 10; i++) {
        msgs.push(msg('user', `q${i}`), msg('assistant', `a${i}`));
      }
      mm.addMessages(msgs);
      expect(mm.shouldCompress(9000, 10000, 0.6)).toBe(true);
    });

    it('recordSummaryCompression tracks entries', () => {
      const msgs: LLMMessage[] = [msg('system', 'sys')];
      for (let i = 0; i < 10; i++) {
        msgs.push(msg('user', `q${i}`), msg('assistant', `a${i}`));
      }
      mm.addMessages(msgs);
      mm.recordSummaryCompression('Summary of early conversation', 2, 12);
      expect(mm.compressed).toBe(true);
      const state = mm.toState();
      expect(state.summaryEntries.length).toBe(1);
    });
  });

  // ── Persistence ──

  describe('persistence', () => {
    it('toState/restoreFromState roundtrip preserves data', () => {
      const msgs: LLMMessage[] = [
        msg('system', 'sys'),
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('user', 'q2'),
        msg('assistant', 'a2'),
      ];
      mm.addMessages(msgs);

      const state = mm.toState();
      const newMm = new MemoryManager(10);
      newMm.restoreFromState(state, mm.getOriginalMessages());

      expect(newMm.originalCount).toBe(5);
      expect(newMm.workingCount).toBe(5);
    });

    it('restoreFromState rebuilds from summary chain', () => {
      const msgs: LLMMessage[] = [
        msg('system', 'sys'),
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('user', 'q2'),
        msg('assistant', 'a2'),
        msg('user', 'q3'),
        msg('assistant', 'a3'),
      ];
      mm.addMessages(msgs);

      // Simulate summary compression of original messages [1, 3) → [q1, a1]
      const state: MemoryState = {
        compressedCount: 5,
        isCompressed: true,
        summaryEntries: [
          {
            summaryText: 'User asked q1, assistant responded with a1.',
            originalStart: 1,
            originalEnd: 3,
          },
        ],
      };

      const newMm = new MemoryManager(10);
      newMm.restoreFromState(state, mm.getOriginalMessages());

      // Should be: sys + [compact + summary] replacing [q1, a1] + [q2, a2, q3, a3]
      const working = newMm.getWorkingMessages();
      expect(working.length).toBe(7); // 1 sys + 2 summary pair + 4 remaining
      expect(working[0].content).toBe('sys');
      expect((working[1] as any)._summaryCompact).toBe(true);
      expect((working[2] as any)._summary).toBe(true);
      expect(working[2].content).toContain('q1');
      expect(working[3].content).toBe('q2');
      expect(working[6].content).toBe('a3');
    });
  });

  // ── Reset ──

  describe('reset', () => {
    it('clears all state', () => {
      mm.addMessages([msg('user', 'q1')]);
      mm.reset();
      expect(mm.originalCount).toBe(0);
      expect(mm.workingCount).toBe(0);
      expect(mm.compressed).toBe(false);
    });
  });

  // ── snapshotForCompression ──

  describe('snapshotForCompression', () => {
    it('returns deep copy and correct length', () => {
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1'), msg('assistant', 'a1')]);
      const snapshot = mm.snapshotForCompression();
      expect(snapshot.snapshotLength).toBe(3);
      expect(snapshot.messages.length).toBe(3);
      // Should be a deep copy — mutating snapshot should not affect working
      snapshot.messages[1].content = 'mutated';
      expect(mm.getWorkingMessages()[1].content).toBe('q1');
    });
  });

  // ── applyBackgroundSummary ──

  describe('applyBackgroundSummary', () => {
    it('applies compressed messages and appends tail', () => {
      // Setup: 10 messages
      const msgs: LLMMessage[] = [msg('system', 'sys')];
      for (let i = 0; i < 5; i++) {
        msgs.push(msg('user', `q${i}`), msg('assistant', `a${i}`));
      }
      mm.addMessages(msgs); // 11 messages total

      // Take snapshot at length 11
      const snapshot = mm.snapshotForCompression();

      // Simulate adding 2 more messages after snapshot (main loop continues)
      mm.addMessages([msg('user', 'q5'), msg('assistant', 'a5')]);
      expect(mm.workingCount).toBe(13);

      // Simulate compression result: snapshot compressed to 4 messages
      const compressed = [
        msg('system', 'sys'),
        msg('user', 'Summary of q0-q4'),
      ];

      const applied = mm.applyBackgroundSummary(compressed, snapshot.snapshotLength, 'Summary of q0-q4');
      expect(applied).toBe(true);
      // Should be: 2 compressed + 2 tail = 4
      expect(mm.workingCount).toBe(4);
      expect(mm.getWorkingMessages()[0].content).toBe('sys');
      expect(mm.getWorkingMessages()[1].content).toBe('Summary of q0-q4');
      expect(mm.getWorkingMessages()[2].content).toBe('q5');
      expect(mm.getWorkingMessages()[3].content).toBe('a5');
      expect(mm.compressed).toBe(true);
    });

    it('rejects when too many new messages since snapshot', () => {
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1')]);
      const snapshotLen = mm.workingCount;

      // Add 25 messages after snapshot
      for (let i = 0; i < 25; i++) {
        mm.addMessages([msg('user', `extra-${i}`)]);
      }

      const compressed = [msg('system', 'sys'), msg('user', 'summary')];
      const applied = mm.applyBackgroundSummary(compressed, snapshotLen);
      expect(applied).toBe(false);
      // Working messages should be unchanged
      expect(mm.workingCount).toBe(27);
    });

    it('applies without summary text (rule-based fallback)', () => {
      const msgs: LLMMessage[] = [msg('system', 'sys')];
      for (let i = 0; i < 5; i++) {
        msgs.push(msg('user', `q${i}`));
      }
      mm.addMessages(msgs);
      const snapshotLen = mm.workingCount;

      const compressed = [msg('system', 'sys'), msg('user', 'truncated')];
      const applied = mm.applyBackgroundSummary(compressed, snapshotLen);
      expect(applied).toBe(true);
      expect(mm.compressed).toBe(true);
    });

    it('applies with zero tail messages', () => {
      mm.addMessages([msg('system', 'sys'), msg('user', 'q1'), msg('assistant', 'a1')]);
      const snapshotLen = mm.workingCount;
      // No new messages added

      const compressed = [msg('system', 'sys'), msg('user', 'summary')];
      const applied = mm.applyBackgroundSummary(compressed, snapshotLen, 'summary');
      expect(applied).toBe(true);
      expect(mm.workingCount).toBe(2);
    });
  });
});
