/**
 * StructuredMessage — 结构化消息正文渲染
 *
 * 解析 assistant 消息内容，识别:
 *   - <thinking>...</thinking> → 折叠思考卡片 (蓝色左边框)
 *   - ```bash ... ``` → 终端样式代码块
 *   - ```lang ... ``` → 带语言标签的代码块（可复制）
 *   - 其余文本 → Markdown 渲染
 *
 * 替代 dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
 *
 * @since v35.0
 */

import { useState, useMemo } from 'react';
import { renderMarkdown } from '../../utils/markdown';

// ── 解析器 ──

interface ContentBlock {
  type: 'markdown' | 'thinking' | 'code';
  content: string;
  lang?: string; // for code blocks
}

/**
 * 将消息内容解析为结构化块
 * 识别 <thinking>、```code``` 等特殊区域
 */
function parseContent(text: string): ContentBlock[] {
  if (!text?.trim()) return [];

  const blocks: ContentBlock[] = [];
  // 统一正则：同时匹配 thinking 标签和代码块
  // 优先匹配 thinking 标签（支持 <thinking>, <antThinking>, <Thinking> 等变体）
  const combinedRe = /(?:<(?:ant)?[Tt]hinking>([\s\S]*?)<\/(?:ant)?[Tt]hinking>)|(?:```(\w*)\n([\s\S]*?)```)/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = combinedRe.exec(text)) !== null) {
    // Push preceding markdown text
    if (match.index > lastIdx) {
      const before = text.slice(lastIdx, match.index).trim();
      if (before) blocks.push({ type: 'markdown', content: before });
    }

    if (match[1] !== undefined) {
      // thinking block
      blocks.push({ type: 'thinking', content: match[1].trim() });
    } else {
      // code block
      const lang = match[2] || '';
      const code = match[3] || '';
      blocks.push({ type: 'code', content: code, lang });
    }
    lastIdx = match.index + match[0].length;
  }

  // Remaining text after last match
  if (lastIdx < text.length) {
    const remaining = text.slice(lastIdx).trim();
    if (remaining) blocks.push({ type: 'markdown', content: remaining });
  }

  // If nothing matched, entire text is markdown
  if (blocks.length === 0) {
    blocks.push({ type: 'markdown', content: text });
  }

  return blocks;
}

// ── 子组件 ──

/** 折叠式思考块 */
function ThinkingCard({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = content.split('\n')[0].slice(0, 120);
  const isLong = content.length > 150 || content.includes('\n');

  return (
    <div className="my-1.5">
      <div className="flex items-start gap-2 cursor-pointer group" onClick={() => setExpanded(!expanded)}>
        <span className="text-sm leading-5 shrink-0 select-none">💡</span>
        <span className={`text-xs leading-5 text-blue-400/70 ${!expanded && isLong ? 'truncate' : ''}`}>
          {expanded ? '思考过程' : firstLine}
          {!expanded && isLong && '...'}
        </span>
        {isLong && (
          <span className="shrink-0 text-slate-600 text-[10px] leading-5 group-hover:text-slate-400 transition-colors ml-auto">
            {expanded ? '▴' : '▾'}
          </span>
        )}
      </div>
      {expanded && (
        <div className="mt-1 ml-5 pl-3 border-l-2 border-blue-500/30 text-xs text-slate-400 leading-relaxed whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
}

/** 终端风格代码块 (bash/sh/shell/zsh) */
function TerminalBlock({ content, lang }: { content: string; lang: string }) {
  const [expanded, setExpanded] = useState(content.length < 500);
  const lines = content.split('\n');
  // 首行通常是命令
  const commandLine = lines[0] || '';
  const output = lines.slice(1).join('\n');

  return (
    <div className="my-2 rounded-lg overflow-hidden bg-[#1a1b26] border border-slate-700/30">
      <div
        className="flex items-center gap-2 px-3 py-1.5 bg-[#24253a] cursor-pointer hover:bg-[#2a2b42] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-slate-500 text-[10px] font-medium font-mono">{lang || 'bash'}</span>
        <button
          onClick={e => {
            e.stopPropagation();
            navigator.clipboard?.writeText(content);
          }}
          className="text-[10px] text-slate-600 hover:text-slate-300 transition-colors ml-auto"
        >
          复制
        </button>
        <span className="text-slate-600 text-[10px]">{expanded ? '▴' : '▾'}</span>
      </div>
      <div className="px-3 py-2 font-mono text-[11px]">
        <div className="text-slate-400">
          <span className="text-amber-400 select-none">$ </span>
          <span className="text-amber-300">{commandLine}</span>
        </div>
        {expanded && output && (
          <pre className="mt-1 text-slate-500 whitespace-pre-wrap break-all leading-relaxed max-h-60 overflow-y-auto">
            {output}
          </pre>
        )}
        {!expanded && output.length > 0 && (
          <div className="mt-1 text-[9px] text-slate-600">点击展开输出 ({output.split('\n').length} 行) ▾</div>
        )}
      </div>
    </div>
  );
}

/** 通用代码块 (带语言标签、复制按钮) */
function CodeBlock({ content, lang }: { content: string; lang: string }) {
  return (
    <div className="my-2 relative group">
      <div className="flex items-center justify-between px-3 py-1 bg-slate-800/80 rounded-t-lg border border-b-0 border-slate-700/40">
        <span className="text-[10px] text-slate-500 font-mono">{lang || 'code'}</span>
        <button
          onClick={() => navigator.clipboard?.writeText(content)}
          className="text-[10px] text-slate-600 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          复制
        </button>
      </div>
      <pre className="px-3 py-2 bg-slate-900/80 rounded-b-lg border border-t-0 border-slate-700/40 text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all overflow-x-auto leading-relaxed max-h-80 overflow-y-auto">
        {content}
      </pre>
    </div>
  );
}

// ── 主组件 ──

const BASH_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);

export function StructuredMessage({ content }: { content: string }) {
  const blocks = useMemo(() => parseContent(content), [content]);

  // 快速路径：如果只有一个 markdown 块，直接用 renderMarkdown (最常见情况)
  if (blocks.length === 1 && blocks[0].type === 'markdown') {
    return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(blocks[0].content) }} />;
  }

  return (
    <div className="space-y-0.5">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'thinking':
            return <ThinkingCard key={i} content={block.content} />;
          case 'code':
            if (BASH_LANGS.has(block.lang || '')) {
              return <TerminalBlock key={i} content={block.content} lang={block.lang!} />;
            }
            return <CodeBlock key={i} content={block.content} lang={block.lang || ''} />;
          case 'markdown':
          default:
            return (
              <div
                key={i}
                className="markdown-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }}
              />
            );
        }
      })}
    </div>
  );
}
