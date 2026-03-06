/**
 * Chat Components — 共享聊天 UI 组件库
 *
 * 借鉴 Echo Agent 的 ChatMessage/CompactMessage/ToolCallMessage 三组件设计:
 *   - 分类渲染: ThinkingBlock / DiffBlock / BashBlock / GenericToolCard / OutputBlock
 *   - Compact/Full 双模式: CollapsibleWorkBlock (折叠/展开工作过程)
 *   - InlineWorkMessage: 紧凑的内联工作消息卡片
 *   - MarkdownContent: 轻量 Markdown 渲染 (代码块可复制)
 *   - UserMessageNav: 用户消息快速跳转导航
 *
 * 替代之前在 MetaAgentPanel / WishPage / SessionPanel 中的重复实现。
 *
 * @since v31.0
 */

export { MSG_STYLES, isBashTool, isEditTool, isReadTool } from './constants';
export { MarkdownContent, formatJsonSafe } from './MarkdownContent';
export { ThinkingBlock } from './ThinkingBlock';
export { DiffBlock } from './DiffBlock';
export { BashBlock } from './BashBlock';
export { GenericToolCard } from './GenericToolCard';
export { ToolCallCard } from './ToolCallCard';
export { OutputBlock } from './OutputBlock';
export { ErrorBlock } from './ErrorBlock';
export { StatusBlock } from './StatusBlock';
export { InlineWorkMessage } from './InlineWorkMessage';
export { CollapsibleWorkBlock } from './CollapsibleWorkBlock';
export { UserMessageNav } from './UserMessageNav';
