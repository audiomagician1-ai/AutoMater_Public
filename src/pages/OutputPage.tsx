import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/app-store';
import { ContextMenu } from '../components/ContextMenu';
import { createLogger } from '../utils/logger';
import { toast } from '../stores/toast-store';
import { EmptyState } from '../components/EmptyState';

const _log = createLogger('OutputPage');

// ── Types ──
interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

// ── 语言检测 ──
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript (React)', js: 'JavaScript', jsx: 'JSX',
    py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin',
    html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', yaml: 'YAML', yml: 'YAML',
    md: 'Markdown', sql: 'SQL', sh: 'Shell', bat: 'Batch', ps1: 'PowerShell',
    toml: 'TOML', xml: 'XML', svg: 'SVG', txt: 'Text', env: 'Env',
    dockerfile: 'Dockerfile', gitignore: 'Git Ignore',
  };
  return map[ext] || ext.toUpperCase() || 'File';
}

// ── 文件图标 ──
function fileIcon(name: string, type: 'file' | 'dir'): string {
  if (type === 'dir') return '📁';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const icons: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟡', jsx: '⚛️', py: '🐍', rs: '🦀',
    html: '🌐', css: '🎨', json: '📋', md: '📝', sql: '🗃️', sh: '🐚',
    yaml: '⚙️', yml: '⚙️', toml: '⚙️',
  };
  return icons[ext] || '📄';
}

// ── 文件树节点 ──
function TreeNode({
  node, depth, selectedPath, onSelect, onRightClick
}: {
  node: FileNode; depth: number; selectedPath: string | null;
  onSelect: (path: string) => void;
  onRightClick?: (e: React.MouseEvent, node: FileNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isSelected = node.path === selectedPath;

  if (node.type === 'dir') {
    return (
      <div>
        <div
          className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-xs hover:bg-slate-800 transition-colors ${isSelected ? 'bg-slate-800 text-slate-100' : 'text-slate-400'}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-slate-600 w-3 text-center">{expanded ? '▾' : '▸'}</span>
          <span>{fileIcon(node.name, 'dir')}</span>
          <span className="truncate">{node.name}</span>
        </div>
        {expanded && node.children?.map((child: FileNode) => (
          <TreeNode key={child.path} node={child} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} onRightClick={onRightClick} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-xs transition-colors ${isSelected ? 'bg-forge-600/20 text-forge-300' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-300'}`}
      style={{ paddingLeft: `${depth * 14 + 20}px` }}
      onClick={() => onSelect(node.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRightClick?.(e, node);
      }}
    >
      <span>{fileIcon(node.name, 'file')}</span>
      <span className="truncate">{node.name}</span>
      {node.size !== undefined && (
        <span className="ml-auto text-slate-600 text-[10px] flex-shrink-0">
          {node.size < 1024 ? `${node.size}B` : `${(node.size / 1024).toFixed(1)}K`}
        </span>
      )}
    </div>
  );
}

// ── 轻量语法高亮 ──
function highlightCode(line: string, _lang: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(line);

  // 注释 — 大多数语言
  html = html.replace(/(\/\/.*$)/gm, '<span class="text-slate-500 italic">$1</span>');
  html = html.replace(/(#.*$)/gm, (m) => {
    // 避免误匹配 CSS hex 颜色
    if (/^#[0-9a-fA-F]{3,8}\b/.test(m.trim())) return m;
    return `<span class="text-slate-500 italic">${m}</span>`;
  });

  // 字符串
  html = html.replace(/(&quot;[^&]*&quot;|&#39;[^&]*&#39;|`[^`]*`)/g, '<span class="text-emerald-400">$1</span>');
  html = html.replace(/("[^"]*"|'[^']*')/g, '<span class="text-emerald-400">$1</span>');

  // 关键字 (JS/TS/Python/Rust/Go/Java)
  const keywords = /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|typeof|interface|type|enum|extends|implements|try|catch|throw|finally|switch|case|break|default|continue|yield|in|of|as|is|null|undefined|true|false|this|self|def|fn|pub|mod|use|struct|impl|trait|where|match|loop|mut|ref|move|super|package|func|go|chan|select|defer|map|range|lambda|pass|raise|with|elif|except|print|None|True|False|void|int|float|double|string|bool|byte|char|long|short|static|final|abstract|public|private|protected|override|virtual|readonly|declare|namespace|module)\b/g;
  html = html.replace(keywords, '<span class="text-violet-400">$1</span>');

  // 数字
  html = html.replace(/\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/g, '<span class="text-amber-400">$1</span>');

  // 类型/大写开头标识符
  html = html.replace(/\b([A-Z][a-zA-Z0-9]*)\b/g, '<span class="text-cyan-400">$1</span>');

  // 装饰器/注解
  html = html.replace(/(@\w+)/g, '<span class="text-yellow-400">$1</span>');

  return html;
}

// ── 行号 + 语法高亮 ──
function CodeView({ content, filename, highlightLine }: { content: string; filename: string; highlightLine?: number }) {
  const lines = content.split('\n');
  const lang = detectLanguage(filename);
  const highlightRef = useRef<HTMLTableRowElement>(null);

  // 当 highlightLine 变化时滚动到对应行
  useEffect(() => {
    if (highlightLine && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightLine]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800/50 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs">{fileIcon(filename, 'file')}</span>
          <span className="text-xs text-slate-300 font-mono">{filename}</span>
        </div>
        <span className="text-[10px] text-slate-500">{lang} · {lines.length} lines</span>
      </div>
      <div className="flex-1 overflow-auto font-mono text-xs leading-5">
        <table className="w-full">
          <tbody>
            {lines.map((line, i) => {
              const lineNum = i + 1;
              const isHighlighted = highlightLine === lineNum;
              return (
                <tr
                  key={i}
                  ref={isHighlighted ? highlightRef : undefined}
                  className={isHighlighted ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/30' : 'hover:bg-slate-800/30'}
                >
                  <td className={`text-right select-none px-3 py-0 w-12 border-r align-top ${isHighlighted ? 'text-amber-400 border-amber-500/30' : 'text-slate-600 border-slate-800/50'}`}>{lineNum}</td>
                  <td className="px-4 py-0 text-slate-300 whitespace-pre-wrap break-all"
                    dangerouslySetInnerHTML={{ __html: highlightCode(line, lang) || ' ' }} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 统计摘要 ──
function countFiles(nodes: FileNode[]): { files: number; dirs: number } {
  let files = 0, dirs = 0;
  for (const n of nodes) {
    if (n.type === 'file') files++;
    else {
      dirs++;
      if (n.children) {
        const sub = countFiles(n.children);
        files += sub.files;
        dirs += sub.dirs;
      }
    }
  }
  return { files, dirs };
}

// ── 搜索面板 (v21.0 — VS Code 风格, 文件名 + 内容搜索) ──
function SearchPanel({
  projectId, onSelectFile, onSelectMatch,
}: {
  projectId: string;
  onSelectFile: (path: string) => void;
  onSelectMatch: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'filename' | 'content'>('content');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState<WorkspaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) { setResults(null); return; }

    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await window.automater.workspace.search(projectId, query, {
          mode, caseSensitive, wholeWord, maxResults: 80, context: 1,
        });
        setResults(r);
      } catch { /* silent */ }
      setSearching(false);
    }, 300);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, mode, caseSensitive, wholeWord, projectId]);

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="flex flex-col h-full">
      {/* 搜索框 */}
      <div className="px-2 pt-2 pb-1.5 space-y-1.5 border-b border-slate-800 flex-shrink-0">
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={mode === 'filename' ? '搜索文件名...' : '搜索内容...'}
            className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-200 pl-7 pr-2 py-1.5 focus:outline-none focus:border-forge-500/50 placeholder:text-slate-600"
          />
          {searching && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 animate-pulse">...</span>}
        </div>
        <div className="flex items-center justify-between">
          {/* 模式切换 */}
          <div className="flex gap-0.5 bg-slate-800 rounded p-0.5">
            <button
              onClick={() => setMode('filename')}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${mode === 'filename' ? 'bg-forge-600/30 text-forge-300' : 'text-slate-500 hover:text-slate-300'}`}
              title="文件名搜索 (Ctrl+P)"
            >
              📄 文件
            </button>
            <button
              onClick={() => setMode('content')}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${mode === 'content' ? 'bg-forge-600/30 text-forge-300' : 'text-slate-500 hover:text-slate-300'}`}
              title="内容搜索 (Ctrl+Shift+F)"
            >
              📝 内容
            </button>
          </div>
          {/* 选项 */}
          <div className="flex gap-1">
            <button
              onClick={() => setCaseSensitive(v => !v)}
              className={`text-[10px] w-5 h-5 rounded flex items-center justify-center font-mono transition-colors ${caseSensitive ? 'bg-forge-600/30 text-forge-300 ring-1 ring-forge-500/30' : 'text-slate-600 hover:text-slate-400'}`}
              title="区分大小写"
            >
              Aa
            </button>
            <button
              onClick={() => setWholeWord(v => !v)}
              className={`text-[10px] w-5 h-5 rounded flex items-center justify-center font-bold transition-colors ${wholeWord ? 'bg-forge-600/30 text-forge-300 ring-1 ring-forge-500/30' : 'text-slate-600 hover:text-slate-400'}`}
              title="全词匹配"
            >
              ab
            </button>
          </div>
        </div>
      </div>

      {/* 搜索结果 */}
      <div className="flex-1 overflow-y-auto text-xs">
        {!results && !searching && (
          <div className="text-slate-600 text-center mt-8 px-4 text-[10px] leading-4">
            输入关键词搜索<br />
            <span className="text-slate-700">内容搜索基于 ripgrep 引擎<br />与 Agent 使用同一搜索能力</span>
          </div>
        )}

        {results && results.mode === 'filename' && results.files && (
          <div className="py-1">
            <div className="px-2 py-1 text-[10px] text-slate-500">{results.totalMatches} 个文件{results.truncated ? ' (已截断)' : ''}</div>
            {results.files.map(f => (
              <div
                key={f}
                className="flex items-center gap-1.5 px-2 py-1 cursor-pointer text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
                onClick={() => onSelectFile(f)}
              >
                <span className="flex-shrink-0">{fileIcon(f.split('/').pop() || '', 'file')}</span>
                <span className="truncate font-mono">{f}</span>
              </div>
            ))}
          </div>
        )}

        {results && results.mode === 'content' && results.matches && (
          <div className="py-1">
            <div className="px-2 py-1 text-[10px] text-slate-500">
              {results.totalMatches} 个匹配{results.truncated ? ' (已截断)' : ''}{results.engine ? ` · ${results.engine}` : ''}{results.durationMs ? ` · ${results.durationMs}ms` : ''}
            </div>
            {groupMatchesByFile(results.matches).map(([file, matches]) => (
              <div key={file}>
                <div className="px-2 py-1 text-slate-400 font-medium bg-slate-900/50 sticky top-0 flex items-center gap-1.5">
                  <span className="flex-shrink-0">{fileIcon(file.split('/').pop() || '', 'file')}</span>
                  <span className="truncate font-mono">{file}</span>
                  <span className="ml-auto text-slate-600 flex-shrink-0">{matches.length}</span>
                </div>
                {matches.map((m, i) => (
                  <div
                    key={`${m.line}-${i}`}
                    className="flex items-start gap-2 px-2 py-0.5 cursor-pointer text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition-colors"
                    onClick={() => onSelectMatch(file, m.line)}
                  >
                    <span className="text-slate-600 w-8 text-right flex-shrink-0 font-mono">{m.line}</span>
                    <span className="font-mono truncate whitespace-pre">{highlightMatch(m.content, query)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {results && results.totalMatches === 0 && (
          <div className="text-slate-600 text-center mt-8 text-[10px]">无匹配结果</div>
        )}
      </div>
    </div>
  );
}

/** 按文件分组搜索结果 */
function groupMatchesByFile(matches: SearchMatchItem[]): Array<[string, SearchMatchItem[]]> {
  const map = new Map<string, SearchMatchItem[]>();
  for (const m of matches) {
    if (!map.has(m.file)) map.set(m.file, []);
    map.get(m.file)!.push(m);
  }
  return Array.from(map.entries());
}

/** 高亮匹配文本 (简易版 — 对 query 做纯文本匹配) */
function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-amber-500/30 text-amber-200 rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

export function OutputPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filePath: string } | null>(null);
  const [versionModal, setVersionModal] = useState<{ filePath: string; versions: Array<{ hash: string; date: string; summary: string }> } | null>(null);
  // v21.0: 搜索状态
  const [showSearch, setShowSearch] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | undefined>(undefined);

  const loadTree = useCallback(async () => {
    if (!currentProjectId) return;
    const result = await window.automater.workspace.tree(currentProjectId);
    if (result.success) setTree(result.tree);
  }, [currentProjectId]);

  // 初始加载 + 定时刷新
  useEffect(() => { loadTree(); }, [loadTree]);
  useEffect(() => {
    const t = setInterval(loadTree, 5000);
    return () => clearInterval(t);
  }, [loadTree]);

  // 监听工作区变化事件
  useEffect(() => {
    const unsub = window.automater.on('workspace:changed', (data: IpcWorkspaceChangedData) => {
      if (data.projectId === currentProjectId) loadTree();
    });
    return unsub;
  }, [currentProjectId, loadTree]);

  const handleSelectFile = async (filePath: string) => {
    if (!currentProjectId) return;
    setSelectedFile(filePath);
    setHighlightLine(undefined);
    setLoading(true);
    try {
      const result = await window.automater.workspace.readFile(currentProjectId, filePath);
      setFileContent(result.success ? result.content : '无法读取文件');
    } catch { /* silent: 文件读取失败 */
      setFileContent('读取失败');
    }
    setLoading(false);
  };

  /** v21.0: 搜索结果 — 内容匹配点击 → 打开文件并跳转到行 */
  const handleSearchMatch = async (filePath: string, line: number) => {
    if (!currentProjectId) return;
    setSelectedFile(filePath);
    setHighlightLine(line);
    setLoading(true);
    try {
      const result = await window.automater.workspace.readFile(currentProjectId, filePath);
      setFileContent(result.success ? result.content : '无法读取文件');
    } catch {
      setFileContent('读取失败');
    }
    setLoading(false);
  };

  // v21.0: 快捷键 — Ctrl+Shift+F (内容搜索), Ctrl+P (文件搜索)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowSearch(true);
      } else if (ctrl && e.key === 'p') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleOpenInExplorer = async () => {
    if (!currentProjectId) return;
    await window.automater.project.openWorkspace(currentProjectId);
  };

  const handleExport = async () => {
    if (!currentProjectId) return;
    await window.automater.project.export(currentProjectId);
  };

  const handleFileRightClick = (e: React.MouseEvent, node: FileNode) => {
    if (node.type === 'file') {
      setCtxMenu({ x: e.clientX, y: e.clientY, filePath: node.path });
    }
  };

  const handleViewVersions = async (_filePath: string) => {
    // TODO: 实现真正的 git log 版本查询 — 暂时隐藏此功能
    toast.info('版本历史功能即将上线');
  };

  const handleRollback = async (_filePath: string, _hash: string) => {
    // TODO: 实现 git checkout <hash> -- <file>
    toast.info('版本回退功能即将上线');
  };

  if (!currentProjectId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        <p>加载中...</p>
      </div>
    );
  }

  const stats = countFiles(tree);
  const selectedFilename = selectedFile?.split('/').pop() ?? '';

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">产出</h2>
          <span className="text-xs text-slate-500">{stats.files} 文件 · {stats.dirs} 目录</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSearch(v => !v)}
            className={`text-xs px-2.5 py-1.5 rounded transition-colors ${showSearch ? 'bg-forge-600/25 text-forge-300 ring-1 ring-forge-500/30' : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-300'}`}
            title="搜索 (Ctrl+Shift+F)"
          >
            🔍 搜索
          </button>
          <button
            onClick={loadTree}
            className="text-xs px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-300 transition-colors"
          >
            🔄 刷新
          </button>
          <button
            onClick={handleOpenInExplorer}
            className="text-xs px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-300 transition-colors"
          >
            📂 打开文件夹
          </button>
          <button
            onClick={handleExport}
            className="text-xs px-2.5 py-1.5 rounded bg-slate-800 hover:bg-forge-700/50 text-slate-400 hover:text-forge-300 transition-colors"
          >
            📦 导出 zip
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧: 文件树 或 搜索面板 */}
        <div className="w-64 border-r border-slate-800 flex-shrink-0 flex flex-col min-h-0">
          {showSearch && currentProjectId ? (
            <SearchPanel
              projectId={currentProjectId}
              onSelectFile={handleSelectFile}
              onSelectMatch={handleSearchMatch}
            />
          ) : (
            <div className="flex-1 overflow-y-auto py-2">
              {tree.length === 0 ? (
                <EmptyState icon="📂" title="暂无文件" description="Agent 开发过程中会自动生成代码文件" />
              ) : (
                tree.map(node => (
                  <TreeNode key={node.path} node={node} depth={0} selectedPath={selectedFile} onSelect={handleSelectFile} onRightClick={handleFileRightClick} />
                ))
              )}
            </div>
          )}
        </div>

        {/* 右侧代码预览 */}
        <div className="flex-1 overflow-hidden bg-slate-950">
          {!selectedFile ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState icon="📄" title="选择文件查看" description="在左侧文件树中选择一个文件预览内容" />
            </div>
          ) : loading ? (
            <div className="h-full flex items-center justify-center text-slate-500 text-sm">加载中...</div>
          ) : (
            <CodeView content={fileContent} filename={selectedFilename} highlightLine={highlightLine} />
          )}
        </div>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            { label: '查看历史版本', icon: '📜', onClick: () => handleViewVersions(ctxMenu.filePath) },
            { label: '在文件管理器中打开', icon: '📂', onClick: () => handleOpenInExplorer() },
            { label: '复制文件路径', icon: '📋', onClick: () => navigator.clipboard?.writeText(ctxMenu.filePath) },
          ]}
        />
      )}

      {/* Version history modal */}
      {versionModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setVersionModal(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-[480px] max-h-[60vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-200">📜 历史版本</h3>
                <p className="text-[10px] text-slate-500 mt-0.5 font-mono">{versionModal.filePath}</p>
              </div>
              <button onClick={() => setVersionModal(null)} className="text-slate-500 hover:text-slate-300">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {versionModal.versions.map((v, i) => (
                <div key={v.hash} className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50 hover:bg-slate-800/30">
                  <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs text-slate-400 font-mono shrink-0">
                    {i === 0 ? '⭐' : `v${versionModal.versions.length - i}`}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-300">{v.summary}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">
                      <span className="font-mono">{v.hash.slice(0, 8)}</span> · {new Date(v.date).toLocaleString()}
                    </div>
                  </div>
                  {i > 0 && (
                    <button
                      onClick={() => handleRollback(versionModal.filePath, v.hash)}
                      className="text-[10px] px-2 py-1 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0"
                    >
                      回退到此版本
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
