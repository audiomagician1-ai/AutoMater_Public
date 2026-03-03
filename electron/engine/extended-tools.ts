/**
 * Extended Tools — 思考 + 规划 + 批量编辑 (v2.1)
 * 
 * - think:      让 LLM 有专门的思考空间（纯 echo，无副作用）
 * - todo_write: Agent 维护自己的任务清单
 * - todo_read:  读取当前任务清单
 * - batch_edit: 一次调用修改同一文件多处
 */

import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════
// think — 思考工具 (参考 Claude Code)
// ═══════════════════════════════════════

/**
 * 纯 echo 工具：让 LLM 写下推理过程，不产生任何副作用。
 * 输入什么就返回什么。
 * 用于复杂任务中 Agent 需要分步推理的场景。
 */
export function think(thought: string): string {
  return thought;
}

// ═══════════════════════════════════════
// Todo — Agent 任务规划
// ═══════════════════════════════════════

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

/** per-agent 任务列表存储 (agentId → TodoItem[]) */
const agentTodos = new Map<string, TodoItem[]>();

/**
 * 写入/更新 Agent 的任务列表（全量替换）
 * 类似 Claude Code 的 TodoWrite
 */
export function todoWrite(agentId: string, todos: TodoItem[]): string {
  agentTodos.set(agentId, todos);
  const pending = todos.filter(t => t.status === 'pending').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const completed = todos.filter(t => t.status === 'completed').length;
  return `任务列表已更新 (${todos.length} 项: ${completed} 完成, ${inProgress} 进行中, ${pending} 待办)`;
}

/**
 * 读取 Agent 当前的任务列表
 */
export function todoRead(agentId: string): string {
  const todos = agentTodos.get(agentId);
  if (!todos || todos.length === 0) {
    return '(无任务列表)';
  }

  const icons: Record<string, string> = {
    completed: '✅',
    in_progress: '🔄',
    pending: '⬜',
  };

  const lines = todos.map((t, i) =>
    `${icons[t.status] || '⬜'} [${i}] ${t.content}${t.priority === 'high' ? ' 🔴' : t.priority === 'low' ? ' 🟢' : ''}`
  );

  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const pending = todos.length - inProgress - completed;

  return `任务列表 (${completed}/${todos.length} 完成, ${inProgress} 进行中, ${pending} 待办):\n${lines.join('\n')}`;
}

/** 清理指定 Agent 的 todo */
export function todoClear(agentId: string): void {
  agentTodos.delete(agentId);
}

// ═══════════════════════════════════════
// batch_edit — 批量编辑
// ═══════════════════════════════════════

export interface EditOperation {
  old_string: string;
  new_string: string;
}

/**
 * 对同一文件执行多次 str_replace 编辑（按顺序依次 apply）
 * 减少工具调用轮次，提高效率
 */
export function batchEdit(
  workspacePath: string,
  filePath: string,
  edits: EditOperation[],
): { success: boolean; output: string } {
  const normalized = path.normalize(filePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return { success: false, output: `路径不安全: ${filePath}` };
  }

  const absPath = path.join(workspacePath, normalized);
  if (!fs.existsSync(absPath)) {
    return { success: false, output: `文件不存在: ${filePath}` };
  }

  let content = fs.readFileSync(absPath, 'utf-8');
  const results: string[] = [];
  let appliedCount = 0;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    if (edit.old_string === '') {
      // 追加模式
      content += edit.new_string;
      results.push(`  #${i + 1}: 追加 ${edit.new_string.length} 字符`);
      appliedCount++;
      continue;
    }

    const occurrences = content.split(edit.old_string).length - 1;
    if (occurrences === 0) {
      // 尝试 trimmed match
      const trimmedOld = edit.old_string.split('\n').map(l => l.trimEnd()).join('\n');
      const trimmedContent = content.split('\n').map(l => l.trimEnd()).join('\n');
      const trimOccurrences = trimmedContent.split(trimmedOld).length - 1;

      if (trimOccurrences === 0) {
        results.push(`  #${i + 1}: ❌ 未找到匹配 (old_string 前30字符: "${edit.old_string.slice(0, 30)}...")`);
        continue;
      }
      // trimmed 替换
      content = content.split('\n').map(l => l.trimEnd()).join('\n');
      content = content.replace(trimmedOld, edit.new_string);
      results.push(`  #${i + 1}: ✅ 替换成功 (trimmed match)`);
      appliedCount++;
    } else if (occurrences === 1) {
      content = content.replace(edit.old_string, edit.new_string);
      results.push(`  #${i + 1}: ✅ 替换成功`);
      appliedCount++;
    } else {
      results.push(`  #${i + 1}: ❌ 匹配 ${occurrences} 处，需要更精确的上下文`);
    }
  }

  if (appliedCount > 0) {
    fs.writeFileSync(absPath, content, 'utf-8');
  }

  const summary = `batch_edit ${normalized}: ${appliedCount}/${edits.length} 处成功\n${results.join('\n')}`;
  return { success: appliedCount > 0, output: summary };
}
