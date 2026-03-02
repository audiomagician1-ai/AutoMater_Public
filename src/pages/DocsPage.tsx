/**
 * DocsPage v4.4 — 项目文档浏览器
 *
 * 左侧: 三类文档树 (设计文档 / 子需求 / 测试规格) + 变更日志
 * 右侧: Markdown 渲染 + 版本信息 + 变更历史筛选
 *
 * 数据来源:
 *   - project:list-all-docs  → 文档元信息
 *   - project:read-doc       → 文档内容
 *   - project:get-doc-changelog → 变更日志
 *
 * @module DocsPage
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { createLogger } from '../utils/logger';

const log = createLogger('DocsPage');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface DocTreeItem {
  type: 'design' | 'requirement' | 'test_spec';
  id: string;
  label: string;
  version: number;
  updatedAt: string;
  sizeBytes: number;
}

type ViewMode = 'document' | 'changelog';

interface DocChangeEntry {
  type: string;
  id: string;
  action: string;
  version: number;
  summary: string;
  timestamp: string;
  agentId: string;
}

interface DocMeta {
  type: string;
  id: string;
  version: number;
  updatedAt: string;
  sizeBytes: number;
}

interface DocListResult {
  design: DocMeta[];
  requirements: DocMeta[];
  testSpecs: DocMeta[];
}

// ═══════════════════════════════════════
// Constants
// ═══════════════════════════════════════

const DOC_TYPE_LABELS: Record<string, { icon: string; label: string; color: string }> = {
  design:      { icon: '📐', label: '总体设计文档', color: 'text-violet-400' },
  requirement: { icon: '📋', label: '子需求文档',   color: 'text-blue-400' },
  test_spec:   { icon: '🧪', label: '测试规格',     color: 'text-emerald-400' },
};

const DOC_ACTION_LABELS: Record<string, { text: string; color: string }> = {
  create: { text: '创建', color: 'bg-emerald-500/20 text-emerald-400' },
  update: { text: '更新', color: 'bg-amber-500/20 text-amber-400' },
};

// ═══════════════════════════════════════
// Simple Markdown Renderer
// ═══════════════════════════════════════

/**
 * 轻量 Markdown→HTML 转换器。
 * 支持: 标题 (h1–h4)、粗体、行内代码、代码块、无序/有序列表、分割线、引用块。
 * 不引入任何第三方 Markdown 库, 保持零依赖。
 */
function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = '';
  let inList: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (inList) {
      html.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  };

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inlineFormat = (text: string) => {
    let result = escapeHtml(text);
    // inline code
    result = result.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 bg-slate-800 rounded text-amber-300 text-xs">$1</code>');
    // bold
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100 font-semibold">$1</strong>');
    // italic
    result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-forge-400 underline">$1</a>');
    return result;
  };

  for (const raw of lines) {
    const line = raw;

    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        closeList();
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
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

// ═══════════════════════════════════════
// Doc Tree Section Component
// ═══════════════════════════════════════

function DocTreeSection({
  title,
  icon,
  color,
  items,
  selectedId,
  onSelect,
  onRightClick,
}: {
  title: string;
  icon: string;
  color: string;
  items: DocTreeItem[];
  selectedId: string | null;
  onSelect: (item: DocTreeItem) => void;
  onRightClick?: (e: React.MouseEvent, item: DocTreeItem) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 rounded-lg transition-colors"
      >
        <span className="text-[10px] text-slate-600">{expanded ? '▼' : '▶'}</span>
        <span>{icon}</span>
        <span className={color}>{title}</span>
        <span className="ml-auto text-[10px] text-slate-600">{items.length}</span>
      </button>
      {expanded && items.length > 0 && (
        <div className="ml-3 border-l border-slate-800/50 pl-2 space-y-0.5">
          {items.map(item => {
            const isSelected = selectedId === `${item.type}:${item.id}`;
            return (
              <button
                key={`${item.type}:${item.id}`}
                onClick={() => onSelect(item)}
                onContextMenu={(e) => { e.preventDefault(); onRightClick?.(e, item); }}
                className={`w-full text-left px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  isSelected
                    ? 'bg-forge-600/15 text-forge-300 border-l-2 border-forge-500 -ml-[1px]'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{item.label}</span>
                  <span className="text-[9px] text-slate-600 flex-shrink-0">v{item.version}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {expanded && items.length === 0 && (
        <div className="ml-7 text-[10px] text-slate-700 py-1">暂无文档</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// Changelog Entry Component
// ═══════════════════════════════════════

function ChangelogEntry({ entry }: { entry: DocChangeEntry }) {
  const typeInfo = DOC_TYPE_LABELS[entry.type] || { icon: '📄', label: entry.type, color: 'text-slate-400' };
  const actionInfo = DOC_ACTION_LABELS[entry.action] || { text: entry.action, color: 'bg-slate-700 text-slate-400' };
  const date = new Date(entry.timestamp);

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-slate-800/50 hover:bg-slate-900/50 transition-colors">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-sm">
        {typeInfo.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-xs font-medium ${typeInfo.color}`}>{entry.id}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${actionInfo.color}`}>
            {actionInfo.text} v{entry.version}
          </span>
          <span className="text-[10px] text-slate-600 ml-auto flex-shrink-0">
            {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed truncate">{entry.summary}</p>
        <p className="text-[10px] text-slate-600 mt-0.5">by {entry.agentId}</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Main DocsPage
// ═══════════════════════════════════════

export function DocsPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const [docList, setDocList] = useState<DocListResult | null>(null);
  const [changelog, setChangelog] = useState<DocChangeEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('document');
  const [changelogFilter, setChangelogFilter] = useState<string>('all');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: DocTreeItem } | null>(null);
  const [versionModal, setVersionModal] = useState<{ item: DocTreeItem; versions: Array<{ version: number; date: string; summary: string; action?: string; agent?: string }> } | null>(null);

  // ── Load doc list + changelog ──
  const loadDocList = useCallback(async () => {
    if (!currentProjectId) return;
    const [docs, log] = await Promise.all([
      window.automater.project.listAllDocs(currentProjectId),
      window.automater.project.getDocChangelog(currentProjectId),
    ]);
    setDocList(docs as DocListResult);
    setChangelog((log || []) as DocChangeEntry[]);
  }, [currentProjectId]);

  useEffect(() => { loadDocList(); }, [loadDocList]);
  useEffect(() => { const t = setInterval(loadDocList, 8000); return () => clearInterval(t); }, [loadDocList]);

  // ── Transform doc meta → tree items ──
  const treeItems = useMemo(() => {
    if (!docList) return { design: [], requirements: [], testSpecs: [] };
    return {
      design: docList.design.map(d => ({
        type: d.type,
        id: d.id,
        label: '总体设计文档',
        version: d.version,
        updatedAt: d.updatedAt,
        sizeBytes: d.sizeBytes,
      } as DocTreeItem)),
      requirements: docList.requirements.map(d => ({
        type: d.type,
        id: d.id,
        label: d.id,
        version: d.version,
        updatedAt: d.updatedAt,
        sizeBytes: d.sizeBytes,
      } as DocTreeItem)),
      testSpecs: docList.testSpecs.map(d => ({
        type: d.type,
        id: d.id,
        label: d.id,
        version: d.version,
        updatedAt: d.updatedAt,
        sizeBytes: d.sizeBytes,
      } as DocTreeItem)),
    };
  }, [docList]);

  // ── Select doc → load content ──
  const handleSelectDoc = useCallback(async (item: DocTreeItem) => {
    const key = `${item.type}:${item.id}`;
    setSelectedKey(key);
    setViewMode('document');
    setLoadingContent(true);
    try {
      if (!currentProjectId) return;
      const content = await window.automater.project.readDoc(
        currentProjectId,
        item.type,
        item.type === 'design' ? '' : item.id,
      );
      setDocContent(content);
    } finally {
      setLoadingContent(false);
    }
  }, [currentProjectId]);

  // ── Find selected doc meta ──
  const selectedMeta = useMemo(() => {
    if (!selectedKey || !docList) return null;
    const [type, id] = selectedKey.split(':');
    const all = [...docList.design, ...docList.requirements, ...docList.testSpecs];
    return all.find(d => d.type === type && d.id === id) || null;
  }, [selectedKey, docList]);

  // ── Filter changelog ──
  const filteredChangelog = useMemo(() => {
    if (changelogFilter === 'all') return changelog;
    return changelog.filter(e => e.type === changelogFilter);
  }, [changelog, changelogFilter]);

  // ── Version history for selected doc ──
  const selectedDocHistory = useMemo(() => {
    if (!selectedKey) return [];
    const [type, id] = selectedKey.split(':');
    const docId = type === 'design' ? 'design' : id;
    return changelog.filter(e => e.type === type && e.id === docId).reverse();
  }, [selectedKey, changelog]);

  const totalDocs = (docList?.design.length ?? 0) + (docList?.requirements.length ?? 0) + (docList?.testSpecs.length ?? 0);

  const handleDocRightClick = (e: React.MouseEvent, item: DocTreeItem) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, item });
  };

  const handleViewDocVersions = (item: DocTreeItem) => {
    const docId = item.type === 'design' ? 'design' : item.id;
    const versions = changelog
      .filter(e => e.type === item.type && e.id === docId)
      .reverse()
      .map(e => ({ version: e.version, action: e.action, summary: e.summary, date: e.timestamp, agent: e.agentId }));
    setVersionModal({ item, versions: versions.length > 0 ? versions : [{ version: item.version, action: 'create', summary: '当前版本', date: new Date().toISOString(), agent: 'system' }] });
  };

  const handleRollbackDoc = (item: DocTreeItem, version: number) => {
    // Placeholder — would call IPC to restore doc to specific version
    log.info(`Rollback doc ${item.type}:${item.id} to v${version}`);
    setVersionModal(null);
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">加载中...</div>;
  }

  return (
    <div className="h-full flex overflow-hidden">
      {/* ═══ 左侧: 文档树 ═══ */}
      <div className="w-64 border-r border-slate-800 flex flex-col flex-shrink-0">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-200">文档浏览器</h2>
          <span className="text-[10px] text-slate-600">{totalDocs} 篇</span>
        </div>

        {/* Tab: 文档树 only (变更已移至工作流) */}
        <div className="flex-1 overflow-y-auto py-2">
          <DocTreeSection
            title="总览设计文档"
            icon="📐"
            color="text-violet-400"
            items={treeItems.design}
            selectedId={selectedKey}
            onSelect={handleSelectDoc}
            onRightClick={handleDocRightClick}
          />
          <DocTreeSection
            title="系统级设计文档"
            icon="🏗️"
            color="text-indigo-400"
            items={[]}
            selectedId={selectedKey}
            onSelect={handleSelectDoc}
            onRightClick={handleDocRightClick}
          />
          <DocTreeSection
            title="功能级设计文档"
            icon="⚙️"
            color="text-cyan-400"
            items={[]}
            selectedId={selectedKey}
            onSelect={handleSelectDoc}
            onRightClick={handleDocRightClick}
          />
          <DocTreeSection
            title="子需求文档"
            icon="📋"
            color="text-blue-400"
            items={treeItems.requirements}
            selectedId={selectedKey}
            onSelect={handleSelectDoc}
            onRightClick={handleDocRightClick}
          />
          <DocTreeSection
            title="测试规格"
            icon="🧪"
            color="text-emerald-400"
            items={treeItems.testSpecs}
            selectedId={selectedKey}
            onSelect={handleSelectDoc}
            onRightClick={handleDocRightClick}
          />
        </div>

        <div className="px-4 py-2 border-t border-slate-800">
          <button
            onClick={loadDocList}
            className="w-full text-xs text-slate-500 hover:text-slate-300 transition-colors py-1"
          >
            🔄 刷新
          </button>
        </div>
      </div>

      {/* ═══ 右侧: 文档内容 ═══ */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedKey && selectedMeta ? (
          <>
            {/* Header bar */}
            <div className="px-6 py-3 border-b border-slate-800 flex items-center gap-3 flex-shrink-0 bg-slate-900/30">
              <span className="text-sm">
                {DOC_TYPE_LABELS[selectedMeta.type]?.icon || '📄'}
              </span>
              <div className="flex-1">
                <h3 className="text-sm font-bold text-slate-200">
                  {selectedMeta.type === 'design' ? '总体设计文档' : selectedMeta.id}
                </h3>
                <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5">
                  <span className={DOC_TYPE_LABELS[selectedMeta.type]?.color}>
                    {DOC_TYPE_LABELS[selectedMeta.type]?.label}
                  </span>
                  <span>版本 {selectedMeta.version}</span>
                  <span>更新于 {new Date(selectedMeta.updatedAt).toLocaleString()}</span>
                  <span>{(selectedMeta.sizeBytes / 1024).toFixed(1)} KB</span>
                </div>
              </div>
            </div>

            {/* Content + History split */}
            <div className="flex-1 flex overflow-hidden">
              {/* Rendered content */}
              <div className="flex-1 overflow-y-auto px-8 py-6">
                {loadingContent ? (
                  <div className="flex items-center justify-center py-16 text-slate-500">
                    <span className="animate-spin mr-2">⏳</span> 加载中...
                  </div>
                ) : docContent ? (
                  <div
                    className="max-w-3xl"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(docContent) }}
                  />
                ) : (
                  <div className="text-center py-16 text-slate-600">文档为空</div>
                )}
              </div>

              {/* Right sidebar: version history */}
              {selectedDocHistory.length > 0 && (
                <div className="w-56 border-l border-slate-800 flex flex-col flex-shrink-0 overflow-hidden">
                  <div className="px-3 py-2 border-b border-slate-800 text-xs font-medium text-slate-400">
                    📝 版本历史 ({selectedDocHistory.length})
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {selectedDocHistory.map((entry, i) => (
                      <div key={i} className="px-3 py-2 border-b border-slate-800/30 hover:bg-slate-900/50">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`text-[10px] px-1 py-0.5 rounded ${DOC_ACTION_LABELS[entry.action]?.color || ''}`}>
                            v{entry.version}
                          </span>
                          <span className="text-[10px] text-slate-600">
                            {new Date(entry.timestamp).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-500 leading-relaxed line-clamp-2">{entry.summary}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-3">
            <div className="text-5xl">📄</div>
            <div className="text-lg font-medium text-slate-400">文档浏览器</div>
            <div className="text-sm text-center max-w-md leading-relaxed">
              项目的设计文档、子需求文档和测试规格都集中在这里。
              <br />
              <span className="text-slate-600">
                当 PM Agent 完成需求分析后, 文档将自动生成并在此展示。
              </span>
            </div>
            <div className="mt-4 flex gap-6 text-[10px] text-slate-600">
              <span>📐 设计文档 — PM 总体方案</span>
              <span>📋 子需求 — Feature 级别拆分</span>
              <span>🧪 测试规格 — QA 验收标准</span>
            </div>
          </div>
        )}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            { label: '查看历史版本', icon: '📜', onClick: () => handleViewDocVersions(ctxMenu.item) },
            { label: '刷新文档列表', icon: '🔄', onClick: () => loadDocList() },
            { label: '复制文档ID', icon: '📋', onClick: () => navigator.clipboard?.writeText(`${ctxMenu.item.type}:${ctxMenu.item.id}`) },
          ]}
        />
      )}

      {/* Version history modal */}
      {versionModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setVersionModal(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-[480px] max-h-[60vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-200">📜 文档版本历史</h3>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {versionModal.item.type === 'design' ? '总体设计文档' : versionModal.item.id}
                </p>
              </div>
              <button onClick={() => setVersionModal(null)} className="text-slate-500 hover:text-slate-300">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {versionModal.versions.map((v, i) => (
                <div key={`${v.version}-${i}`} className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50 hover:bg-slate-800/30">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-mono shrink-0 ${
                    i === 0 ? 'bg-forge-600/20 text-forge-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    v{v.version}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-300">{v.summary}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      {v.action === 'create' ? '📝 创建' : '✏️ 更新'} · {new Date(v.date).toLocaleString()} · {v.agent}
                    </div>
                  </div>
                  {i > 0 && (
                    <button
                      onClick={() => handleRollbackDoc(versionModal.item, v.version)}
                      className="text-[10px] px-2 py-1 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0"
                    >
                      回退到此版本
                    </button>
                  )}
                </div>
              ))}
              {versionModal.versions.length === 0 && (
                <div className="text-center py-8 text-slate-600 text-xs">暂无版本记录</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}