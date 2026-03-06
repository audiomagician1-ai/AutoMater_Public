/**
 * InlineWorkMessage — 紧凑内联工作消息卡片
 *
 * 用于 MetaAgentPanel / WishPage 中嵌入 assistant 消息下方。
 * 工具调用两行摘要设计,
 * 同时集成分类渲染 (DiffBlock / BashBlock / GenericToolCard)。
 *
 * v31.0: 从 MetaAgentPanel + WishPage 的重复实现合并为单一共享组件,
 *        增加分类渲染支持 (edit→diff, bash→terminal, 其他→generic)
 *
 * @since v31.0
 */

import { useState } from 'react';
import type { AgentWorkMessage } from '../../stores/app-store';
import { MSG_STYLES, isEditTool, isBashTool } from './constants';

export function InlineWorkMessage({ msg }: { msg: AgentWorkMessage }) {
  const style = MSG_STYLES[msg.type] || MSG_STYLES.status;
  const [expanded, setExpanded] = useState(false);
  const isLong = msg.content.length > 300;

  // v31.0: 分类渲染 — edit_file 展示 diff, bash 展示终端
  if ((msg.type === 'tool-result' || msg.type === 'tool-call') && msg.tool) {
    return <InlineToolCard msg={msg} style={style} />;
  }

  return (
    <div className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-2.5 py-1.5 transition-colors`}>
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-0.5">
        <span>{style.icon}</span>
        <span className="font-medium text-slate-400">{style.label}</span>
        {msg.iteration && <span className="text-slate-600">#{msg.iteration}</span>}
        <span className="ml-auto text-slate-700">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      <div
        className={`text-[11px] text-slate-300 leading-relaxed ${isLong && !expanded ? 'line-clamp-4 cursor-pointer' : 'whitespace-pre-wrap break-all'}`}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        {msg.content}
      </div>
      {isLong && !expanded && (
        <div
          className="text-[9px] text-slate-600 mt-0.5 cursor-pointer hover:text-slate-400"
          onClick={() => setExpanded(true)}
        >
          点击展开 ▸
        </div>
      )}
    </div>
  );
}

// ── 内联工具卡片 (分类渲染) ──

function InlineToolCard({
  msg,
  style,
}: {
  msg: AgentWorkMessage;
  style: { icon: string; border: string; bg: string; label: string };
}) {
  const tool = msg.tool!;
  const [expanded, setExpanded] = useState(false);

  // edit_file / write_file → 紧凑 diff
  if (isEditTool(tool.name) && msg.diff) {
    return (
      <div className="rounded-lg border border-slate-700/50 overflow-hidden bg-slate-900/60">
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-800/40 cursor-pointer hover:bg-slate-800/60 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-amber-400 font-semibold text-[10px]">
            {tool.name === 'write_file' ? 'write' : 'edit'}
          </span>
          <span className="text-slate-300 text-[10px] font-mono truncate flex-1">{msg.diff.path}</span>
          <span className="text-emerald-400 text-[10px] font-mono">+{msg.diff.added}</span>
          <span className="text-red-400 text-[10px] font-mono">-{msg.diff.removed}</span>
          {tool.success && <span className="text-emerald-400 text-[10px]">✓</span>}
          {tool.success === false && <span className="text-red-400 text-[10px]">✗</span>}
          <span className="text-slate-600 text-[10px]">{expanded ? '▴' : '▾'}</span>
        </div>
        {expanded && (
          <div className="font-mono text-[10px] leading-relaxed max-h-48 overflow-y-auto">
            {msg.diff.oldString?.split('\n').map((line, i) => (
              <div key={`o${i}`} className="px-2.5 py-0.5 bg-red-500/10 text-red-300">
                <span className="text-red-500/60 select-none mr-1">-</span>
                {line}
              </div>
            ))}
            {msg.diff.newString?.split('\n').map((line, i) => (
              <div key={`n${i}`} className="px-2.5 py-0.5 bg-emerald-500/10 text-emerald-300">
                <span className="text-emerald-500/60 select-none mr-1">+</span>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // run_command / bash → 紧凑终端
  if (isBashTool(tool.name)) {
    const command = tool.command || tool.args;
    const output = expanded ? tool.fullOutput || tool.outputPreview || '' : '';
    return (
      <div className="rounded-lg overflow-hidden bg-[#1a1b26] border border-slate-700/30">
        <div
          className="flex items-center gap-2 px-2.5 py-1 bg-[#24253a] cursor-pointer hover:bg-[#2a2b42] transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-slate-500 text-[10px] font-medium">bash</span>
          {tool.success === true && <span className="text-emerald-400 text-[10px]">✓</span>}
          {tool.success === false && <span className="text-red-400 text-[10px]">✗</span>}
          <span className="ml-auto text-slate-600 text-[10px]">{expanded ? '▴' : '▾'}</span>
        </div>
        <div className="px-2.5 py-1.5 font-mono text-[10px]">
          <div className="text-slate-400">
            <span className="text-amber-400">$ </span>
            <span className="text-amber-300">{command}</span>
          </div>
          {tool.outputPreview && !expanded && (
            <div className="mt-0.5 text-slate-500 truncate">{tool.outputPreview.slice(0, 100)}</div>
          )}
          {expanded && output && (
            <pre className="mt-1 text-slate-500 whitespace-pre-wrap break-all leading-relaxed max-h-40 overflow-y-auto">
              {output}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // 其他工具 → 通用紧凑卡片
  return (
    <div className={`border-l-2 ${style.border} ${style.bg} rounded-r-lg px-2.5 py-1.5 transition-colors`}>
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500 mb-0.5">
        <span>{style.icon}</span>
        <span className="font-medium text-slate-400">{style.label}</span>
        {msg.iteration && <span className="text-slate-600">#{msg.iteration}</span>}
        <span className="ml-auto text-slate-700">
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`text-[10px] font-mono px-1 py-0.5 rounded ${tool.success ? 'bg-emerald-500/20 text-emerald-400' : tool.success === false ? 'bg-red-500/20 text-red-400' : 'bg-slate-500/20 text-slate-400'}`}
          >
            {tool.name}
          </span>
          <span className="text-[10px] text-slate-500 truncate max-w-[300px]">{tool.args}</span>
        </div>
        {tool.outputPreview && (
          <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto">
            {tool.outputPreview}
          </pre>
        )}
      </div>
    </div>
  );
}
