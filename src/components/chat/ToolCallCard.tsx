/**
 * ToolCallCard — 根据工具类型自动选择渲染器
 *
 * 借鉴 Echo Agent ToolCallMessage.vue 的分类渲染设计:
 *   - edit_file / write_file → DiffBlock
 *   - run_command / run_test → BashBlock
 *   - 其他 → GenericToolCard
 *
 * @since v31.0
 */

import type { AgentWorkMessage } from '../../stores/app-store';
import { isEditTool, isBashTool } from './constants';
import { DiffBlock } from './DiffBlock';
import { BashBlock } from './BashBlock';
import { GenericToolCard } from './GenericToolCard';

export function ToolCallCard({
  msg,
  isExpanded,
  onToggle,
}: {
  msg: AgentWorkMessage;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const tool = msg.tool;
  if (!tool) return null;

  const name = tool.name;

  // edit_file / write_file → diff 展示
  if (isEditTool(name) && msg.diff) {
    return <DiffBlock msg={msg} isExpanded={isExpanded} onToggle={onToggle} />;
  }

  // run_command / bash → 终端样式
  if (isBashTool(name)) {
    return <BashBlock msg={msg} isExpanded={isExpanded} onToggle={onToggle} />;
  }

  // 其他工具 → 通用折叠卡片
  return <GenericToolCard msg={msg} isExpanded={isExpanded} onToggle={onToggle} />;
}
