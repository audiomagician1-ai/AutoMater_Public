import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { createLogger } from '../utils/logger';
import { toast } from '../stores/toast-store';
import { EmptyState } from '../components/EmptyState';

const log = createLogger('OutputPage');

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
function highlightCode(line: string, lang: string): string {
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
function CodeView({ content, filename }: { content: string; filename: string }) {
  const lines = content.split('\n');
  const lang = detectLanguage(filename);

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
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-slate-800/30">
                <td className="text-right text-slate-600 select-none px-3 py-0 w-12 border-r border-slate-800/50 align-top">{i + 1}</td>
                <td className="px-4 py-0 text-slate-300 whitespace-pre-wrap break-all"
                  dangerouslySetInnerHTML={{ __html: highlightCode(line, lang) || ' ' }} />
              </tr>
            ))}
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

export function OutputPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filePath: string } | null>(null);
  const [versionModal, setVersionModal] = useState<{ filePath: string; versions: Array<{ hash: string; date: string; summary: string }> } | null>(null);

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
    setLoading(true);
    try {
      const result = await window.automater.workspace.readFile(currentProjectId, filePath);
      setFileContent(result.success ? result.content : '无法读取文件');
    } catch {
      setFileContent('读取失败');
    }
    setLoading(false);
  };

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

  const handleViewVersions = async (filePath: string) => {
    // TODO: 实现真正的 git log 版本查询 — 暂时隐藏此功能
    toast.info('版本历史功能即将上线');
  };

  const handleRollback = async (filePath: string, hash: string) => {
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
        {/* 左侧文件树 */}
        <div className="w-64 border-r border-slate-800 overflow-y-auto flex-shrink-0 py-2">
          {tree.length === 0 ? (
            <EmptyState icon="📂" title="暂无文件" description="Agent 开发过程中会自动生成代码文件" />
          ) : (
            tree.map(node => (
              <TreeNode key={node.path} node={node} depth={0} selectedPath={selectedFile} onSelect={handleSelectFile} onRightClick={handleFileRightClick} />
            ))
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
            <CodeView content={fileContent} filename={selectedFilename} />
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
