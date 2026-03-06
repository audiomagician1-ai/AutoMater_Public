/**
 * MarkdownContent — 轻量 Markdown 渲染 (代码块可复制)
 * @since v31.0 — 从 AgentWorkFeed 提取
 */

import { useMemo } from 'react';

interface MarkdownPart {
  type: 'text' | 'code' | 'heading';
  content: string;
  lang?: string;
}

function splitMarkdown(text: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      pushTextParts(parts, text.slice(lastIdx, match.index));
    }
    parts.push({ type: 'code', content: match[2], lang: match[1] || '' });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    pushTextParts(parts, text.slice(lastIdx));
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return parts;
}

function pushTextParts(parts: MarkdownPart[], text: string) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^#{1,3}\s/.test(trimmed)) {
      parts.push({ type: 'heading', content: trimmed.replace(/^#{1,3}\s*/, '') });
    } else if (trimmed) {
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') {
        last.content += '\n' + trimmed;
      } else {
        parts.push({ type: 'text', content: trimmed });
      }
    }
  }
}

export function formatJsonSafe(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

export function MarkdownContent({ text }: { text: string }) {
  const parts = useMemo(() => splitMarkdown(text), [text]);

  return (
    <div className="text-sm text-slate-300 leading-relaxed space-y-2">
      {parts.map((part, i) => {
        if (part.type === 'code') {
          return (
            <div key={i} className="relative group">
              <div className="flex items-center justify-between px-3 py-1 bg-slate-800/80 rounded-t-lg border border-b-0 border-slate-700/40">
                <span className="text-[10px] text-slate-500 font-mono">{part.lang || 'code'}</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(part.content)}
                  className="text-[10px] text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  复制
                </button>
              </div>
              <pre className="px-3 py-2 bg-slate-900/80 rounded-b-lg border border-t-0 border-slate-700/40 text-xs text-slate-400 font-mono whitespace-pre-wrap break-all overflow-x-auto leading-relaxed max-h-80 overflow-y-auto">
                {part.content}
              </pre>
            </div>
          );
        }
        if (part.type === 'heading') {
          return (
            <div key={i} className="font-bold text-slate-100 text-base mt-2">
              {part.content}
            </div>
          );
        }
        return (
          <div key={i} className="whitespace-pre-wrap break-words">
            {part.content}
          </div>
        );
      })}
    </div>
  );
}
