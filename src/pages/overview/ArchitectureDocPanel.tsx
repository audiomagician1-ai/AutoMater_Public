/**
 * ArchitectureDocPanel — 展示导入分析生成的 ARCHITECTURE.md 文档
 *
 * 简洁的 markdown 渲染（不引入外部 md 库），支持:
 * - 标题层级 (#, ##, ###)
 * - 代码块 (```)
 * - 列表 (- / *)
 * - 加粗/斜体
 * - 折叠长文档
 */

import React, { useState, useEffect, useCallback } from 'react';

export function ArchitectureDocPanel({ projectId }: { projectId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const loadDoc = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.automater.project.getArchitectureDoc(projectId);
      if (res.success && res.content) {
        setContent(res.content);
      } else {
        setContent(null);
      }
    } catch {
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadDoc(); }, [loadDoc]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-sm text-slate-500">
        <div className="animate-spin w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full" />
        加载架构文档...
      </div>
    );
  }

  if (!content) return null;

  const lines = content.split('\n');
  const previewLines = expanded ? lines : lines.slice(0, 40);
  const needsExpand = lines.length > 40;

  return (
    <section className="bg-slate-900/60 border border-slate-800/60 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-slate-800/50 border-b border-slate-700/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">📄</span>
          <span className="text-sm font-medium text-slate-200">架构文档</span>
          <span className="text-xs text-slate-500">ARCHITECTURE.md</span>
        </div>
        {needsExpand && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            {expanded ? '收起 ▲' : `展开全部 (${lines.length} 行) ▼`}
          </button>
        )}
      </div>
      <div className={`px-5 py-4 text-sm leading-relaxed ${!expanded && needsExpand ? 'max-h-[480px] overflow-hidden relative' : ''}`}>
        <SimpleMdRenderer lines={previewLines} />
        {!expanded && needsExpand && (
          <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-slate-900/90 to-transparent pointer-events-none" />
        )}
      </div>
    </section>
  );
}

/** 极简 Markdown 渲染 — 不需要外部依赖 */
function SimpleMdRenderer({ lines }: { lines: string[] }) {
  const elements: React.ReactElement[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';

  const flushCode = () => {
    if (codeLines.length > 0) {
      elements.push(
        <pre key={`code-${elements.length}`} className="bg-slate-800/80 border border-slate-700/50 rounded-lg px-4 py-3 my-2 overflow-x-auto text-xs font-mono text-slate-300">
          {codeLang && <div className="text-[10px] text-slate-500 mb-1 uppercase">{codeLang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      codeLines = [];
      codeLang = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        flushCode();
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      elements.push(<h4 key={i} className="text-sm font-semibold text-slate-200 mt-4 mb-1">{renderInline(line.slice(4))}</h4>);
    } else if (line.startsWith('## ')) {
      elements.push(<h3 key={i} className="text-base font-semibold text-slate-100 mt-5 mb-2 border-b border-slate-800 pb-1">{renderInline(line.slice(3))}</h3>);
    } else if (line.startsWith('# ')) {
      elements.push(<h2 key={i} className="text-lg font-bold text-slate-50 mt-6 mb-2">{renderInline(line.slice(2))}</h2>);
    } else if (line.match(/^[-*] /)) {
      // List item
      elements.push(
        <div key={i} className="flex gap-2 text-slate-400 ml-2 my-0.5">
          <span className="text-slate-600 flex-shrink-0">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
    } else if (line.match(/^\d+\. /)) {
      // Numbered list
      const match = line.match(/^(\d+)\. (.+)/);
      elements.push(
        <div key={i} className="flex gap-2 text-slate-400 ml-2 my-0.5">
          <span className="text-slate-500 flex-shrink-0 w-4 text-right">{match[1]}.</span>
          <span>{renderInline(match[2])}</span>
        </div>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      elements.push(<p key={i} className="text-slate-400 my-0.5">{renderInline(line)}</p>);
    }
  }

  // Flush any remaining code block
  flushCode();

  return <>{elements}</>;
}

/** 行内 markdown 格式化 (bold, italic, inline code) */
function renderInline(text: string): React.ReactNode {
  // Split by inline code first, then handle bold/italic in text parts
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="bg-slate-800 text-cyan-400 px-1.5 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    }
    // Bold
    let processed: React.ReactNode = part;
    if (part.includes('**')) {
      const segments = part.split(/(\*\*[^*]+\*\*)/g);
      processed = segments.map((seg, j) => {
        if (seg.startsWith('**') && seg.endsWith('**')) {
          return <strong key={j} className="text-slate-200 font-semibold">{seg.slice(2, -2)}</strong>;
        }
        return seg;
      });
    }
    return <span key={i}>{processed}</span>;
  });
}
