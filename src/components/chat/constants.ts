/**
 * Chat component constants — 消息类型样式 + 工具分类判断
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';

/** 消息类型 → 样式映射 (统一全局使用) */
export const MSG_STYLES: Record<AgentWorkMessage['type'], { icon: string; border: string; bg: string; label: string }> =
  {
    think: { icon: '💡', border: 'border-l-blue-400', bg: '', label: '思考' },
    'tool-call': { icon: '🔧', border: 'border-l-amber-500', bg: 'bg-amber-500/5', label: '工具' },
    'tool-result': { icon: '🔧', border: '', bg: '', label: '工具' },
    output: { icon: '✅', border: 'border-l-green-500', bg: '', label: '输出' },
    status: { icon: '📌', border: '', bg: '', label: '状态' },
    'sub-agent': { icon: '🔬', border: 'border-l-violet-500', bg: 'bg-violet-500/5', label: '子Agent' },
    error: { icon: '⚠️', border: 'border-l-red-500', bg: 'bg-red-500/5', label: '错误' },
    plan: { icon: '📋', border: 'border-l-orange-500', bg: 'bg-orange-500/5', label: '计划' },
  };

/** 判断工具是否为命令类 (bash / terminal 样式展示) */
export function isBashTool(name: string): boolean {
  return ['run_command', 'run_test', 'run_lint'].includes(name);
}

/** 判断工具是否为文件编辑类 (diff 展示) */
export function isEditTool(name: string): boolean {
  return ['edit_file', 'write_file', 'batch_edit'].includes(name);
}

/** 判断工具是否为读取类 (折叠展示) */
export function isReadTool(name: string): boolean {
  return ['read_file', 'read_many_files', 'search_files', 'list_files', 'glob_files', 'code_graph_query'].includes(
    name,
  );
}
