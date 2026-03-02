/**
 * 共享 Markdown → HTML 渲染器
 * v15.0: 从 DocsPage 抽取, 供 MetaAgentChat / DocsPage / GuidePage 复用
 */

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 安全链接协议白名单 — 阻止 javascript: / data: / vbscript: XSS */
const SAFE_URL_PROTOCOLS = /^(?:https?|mailto|tel|ftp):/i;
const isSafeUrl = (url: string): boolean => {
  const decoded = url.replace(/&amp;/g, '&');
  const trimmed = decoded.trim();
  // 相对路径 / 锚点 / 纯 ASCII 路径允许
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('.')) return true;
  // 有协议前缀时只允许白名单
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) return SAFE_URL_PROTOCOLS.test(trimmed);
  // 无协议的普通文本（如 example.com）允许
  return true;
};

const inlineFormat = (text: string) => {
  let result = escapeHtml(text);
  // inline code
  result = result.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 bg-slate-800 rounded text-amber-300 text-xs">$1</code>');
  // bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>');
  // italic
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // links — sanitize href to block javascript:/data:/vbscript: XSS
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    if (isSafeUrl(url)) {
      return `<a href="${url}" class="text-forge-400 underline" rel="noopener noreferrer">${text}</a>`;
    }
    // 不安全的协议：仅渲染文本，不生成链接
    return `<span class="text-forge-400">${text}</span>`;
  });
  return result;
};

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let _codeLang = '';
  let inList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (inList) {
      html.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  };

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        closeList();
        inCodeBlock = true;
        _codeLang = line.trim().slice(3).trim();
        codeBuffer = [];
      } else {
        html.push(`<pre class="bg-slate-900 border border-slate-800 rounded-lg p-4 overflow-x-auto my-3"><code class="text-xs text-slate-300 leading-relaxed">${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        inCodeBlock = false;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      closeList();
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const sizes: Record<number, string> = {
        1: 'text-xl font-bold text-slate-100 mt-6 mb-3 pb-2 border-b border-slate-800',
        2: 'text-lg font-bold text-slate-200 mt-5 mb-2',
        3: 'text-base font-semibold text-slate-300 mt-4 mb-2',
        4: 'text-sm font-semibold text-slate-400 mt-3 mb-1',
      };
      html.push(`<h${level} class="${sizes[level]}">${inlineFormat(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      closeList();
      html.push('<hr class="border-slate-800 my-4" />');
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('> ')) {
      closeList();
      html.push(`<blockquote class="border-l-2 border-slate-600 pl-4 my-2 text-slate-400 italic">${inlineFormat(line.replace(/^>\s*/, ''))}</blockquote>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        inList = 'ul';
        html.push('<ul class="list-disc list-inside space-y-1 my-2 text-slate-300 text-sm">');
      }
      html.push(`<li class="leading-relaxed">${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        inList = 'ol';
        html.push('<ol class="list-decimal list-inside space-y-1 my-2 text-slate-300 text-sm">');
      }
      html.push(`<li class="leading-relaxed">${inlineFormat(olMatch[2])}</li>`);
      continue;
    }

    // Paragraph
    closeList();
    html.push(`<p class="text-sm text-slate-300 leading-relaxed my-1.5">${inlineFormat(line)}</p>`);
  }

  // Cleanup
  closeList();
  if (inCodeBlock) {
    html.push(`<pre class="bg-slate-900 border border-slate-800 rounded-lg p-4 overflow-x-auto my-3"><code class="text-xs text-slate-300">${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }

  return html.join('\n');
}
