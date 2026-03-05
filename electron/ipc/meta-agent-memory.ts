/**
 * meta-agent-memory.ts — 元Agent 记忆系统 CRUD
 *
 * 从 meta-agent.ts 拆分 (v30.2)
 */

import { getDb } from '../db';
import { createLogger } from '../engine/logger';
import type { MetaAgentMemory } from './meta-agent-types';

const log = createLogger('ipc:meta-agent:memory');

// ═══════════════════════════════════════
// Memory Management
// ═══════════════════════════════════════

export function getMemories(category?: string, limit?: number, projectId?: string | null): MetaAgentMemory[] {
  const db = getDb();
  let sql = 'SELECT * FROM meta_agent_memories';
  const conditions: string[] = [];
  const params: Array<string | number | null> = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  // v29.0: 按项目过滤 — 返回该项目的记忆 + 全局记忆 (project_id IS NULL)
  if (projectId !== undefined) {
    if (projectId) {
      conditions.push('(project_id = ? OR project_id IS NULL)');
      params.push(projectId);
    } else {
      // projectId 为 null → 只返回全局记忆
      conditions.push('project_id IS NULL');
    }
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY importance DESC, updated_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return db.prepare(sql).all(...params) as MetaAgentMemory[];
}

export function addMemory(memory: Omit<MetaAgentMemory, 'id' | 'created_at' | 'updated_at'>): MetaAgentMemory {
  const db = getDb();
  const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO meta_agent_memories (id, category, content, source, importance, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, memory.category, memory.content, memory.source, memory.importance, memory.project_id ?? null, now, now);

  return { id, ...memory, created_at: now, updated_at: now };
}

export function updateMemory(
  id: string,
  updates: { content?: string; importance?: number; category?: string },
): boolean {
  const db = getDb();
  const parts: string[] = [];
  const params: Array<string | number> = [];

  if (updates.content !== undefined) {
    parts.push('content = ?');
    params.push(updates.content);
  }
  if (updates.importance !== undefined) {
    parts.push('importance = ?');
    params.push(updates.importance);
  }
  if (updates.category !== undefined) {
    parts.push('category = ?');
    params.push(updates.category);
  }

  if (parts.length === 0) return false;

  parts.push("updated_at = datetime('now')");
  params.push(id);

  const result = db.prepare(`UPDATE meta_agent_memories SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM meta_agent_memories WHERE id = ?').run(id);
  return result.changes > 0;
}

export function searchMemories(query: string, limit: number = 20): MetaAgentMemory[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM meta_agent_memories WHERE content LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT ?`)
    .all(`%${query}%`, limit) as MetaAgentMemory[];
}

export function getMemoryStats(): { total: number; byCategory: Record<string, number> } {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as count FROM meta_agent_memories').get() as { count: number }).count;
  const rows = db
    .prepare('SELECT category, COUNT(*) as count FROM meta_agent_memories GROUP BY category')
    .all() as Array<{ category: string; count: number }>;
  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category] = r.count;
  return { total, byCategory };
}

// ═══════════════════════════════════════
// Auto Memory: Extract and store from conversations
// ═══════════════════════════════════════

export function autoExtractMemory(memoryNotes: string, projectId?: string | null): void {
  if (!memoryNotes || !memoryNotes.trim()) return;

  try {
    // Determine category heuristically
    const lower = memoryNotes.toLowerCase();
    let category: MetaAgentMemory['category'] = 'facts';
    if (
      lower.includes('偏好') ||
      lower.includes('喜欢') ||
      lower.includes('不喜欢') ||
      lower.includes('习惯') ||
      lower.includes('称呼')
    ) {
      category = 'user_profile';
    } else if (
      lower.includes('教训') ||
      lower.includes('经验') ||
      lower.includes('避免') ||
      lower.includes('注意') ||
      lower.includes('bug') ||
      lower.includes('坑')
    ) {
      category = 'lessons';
    }

    addMemory({
      category,
      content: memoryNotes.trim(),
      source: 'auto',
      importance: 5,
      project_id: projectId ?? null,
    });

    log.info('Auto-memory stored', { category, preview: memoryNotes.slice(0, 50) });
  } catch (err) {
    log.error('Auto-memory failed', err);
  }
}
