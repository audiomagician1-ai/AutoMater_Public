/**
 * GlobalSearchBar — 顶部全局搜索 (v21.0)
 *
 * 跨所有项目搜索文件名和内容。Ctrl+K 或 Ctrl+Shift+F 打开。
 * 结果按项目分组，点击结果跳转到对应项目的产出页。
 */

import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/app-store';

interface GlobalMatch {
  file: string;
  line: number;
  content: string;
}

interface ProjectResult {
  projectId: string;
  projectName: string;
  matches?: GlobalMatch[];
  files?: string[];
  matchCount: number;
}

export function GlobalSearchBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'filename' | 'content'>('content');
  const [results, setResults] = useState<ProjectResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [stats, setStats] = useState<{ totalProjects: number; durationMs: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const enterProject = useAppStore(s => s.enterProject);

  // Global keyboard shortcut: Ctrl+K to open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === 'k') {
        e.preventDefault();
        setOpen(v => !v);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setStats(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced global search
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) { setResults([]); setStats(null); return; }

    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await window.automater.workspace.searchGlobal(query, {
          mode,
          maxResultsPerProject: 8,
        });
        if (r.success) {
          setResults(r.results);
          setStats({ totalProjects: r.totalProjects, durationMs: r.durationMs });
        }
      } catch { /* silent */ }
      setSearching(false);
    }, 400);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, mode]);

  const handleSelectResult = (projectId: string) => {
    enterProject(projectId, 'output');
    setOpen(false);
  };

  if (!open) {
    // 紧凑的搜索触发按钮
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 text-slate-500 hover:text-slate-300 text-xs transition-all group"
        title="全局搜索 (Ctrl+K)"
      >
        <span className="text-xs">🔍</span>
        <span className="hidden sm:inline">搜索...</span>
        <kbd className="hidden sm:inline text-[10px] px-1 py-0.5 rounded bg-slate-700/50 text-slate-500 group-hover:text-slate-400 ml-1">⌘K</kbd>
      </button>
    );
  }

  return (
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/50 z-50" onClick={() => setOpen(false)} />

      {/* 搜索弹窗 */}
      <div className="fixed top-[10%] left-1/2 -translate-x-1/2 w-[560px] max-h-[70vh] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/40 z-50 flex flex-col overflow-hidden">
        {/* 搜索头部 */}
        <div className="px-4 pt-4 pb-2 border-b border-slate-800 space-y-2 flex-shrink-0">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">🔍</span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={mode === 'filename' ? '搜索所有项目中的文件...' : '搜索所有项目中的代码内容...'}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 pl-9 pr-3 py-2.5 focus:outline-none focus:border-forge-500/50 placeholder:text-slate-600"
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
            />
            {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 animate-pulse">搜索中...</span>}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-0.5 bg-slate-800 rounded p-0.5">
              <button
                onClick={() => setMode('filename')}
                className={`text-[10px] px-2.5 py-1 rounded transition-colors ${mode === 'filename' ? 'bg-forge-600/30 text-forge-300' : 'text-slate-500 hover:text-slate-300'}`}
              >
                📄 文件名
              </button>
              <button
                onClick={() => setMode('content')}
                className={`text-[10px] px-2.5 py-1 rounded transition-colors ${mode === 'content' ? 'bg-forge-600/30 text-forge-300' : 'text-slate-500 hover:text-slate-300'}`}
              >
                📝 内容
              </button>
            </div>
            {stats && (
              <span className="text-[10px] text-slate-600 ml-auto">
                {stats.totalProjects} 个项目 · {stats.durationMs}ms
              </span>
            )}
          </div>
        </div>

        {/* 结果区域 */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {results.length === 0 && query.trim() && !searching && (
            <div className="text-slate-600 text-center py-12 text-xs">无匹配结果</div>
          )}

          {results.length === 0 && !query.trim() && (
            <div className="text-slate-600 text-center py-12 text-xs space-y-1">
              <div>输入关键词搜索所有项目</div>
              <div className="text-slate-700">文件名和代码内容跨项目搜索 · 基于 ripgrep 引擎</div>
            </div>
          )}

          {results.map(pr => (
            <div key={pr.projectId} className="border-b border-slate-800/50 last:border-0">
              {/* 项目标题 */}
              <div
                className="flex items-center gap-2 px-4 py-2 bg-slate-800/30 cursor-pointer hover:bg-slate-800/60 transition-colors"
                onClick={() => handleSelectResult(pr.projectId)}
              >
                <span className="text-xs">📁</span>
                <span className="text-xs font-medium text-slate-300">{pr.projectName}</span>
                <span className="text-[10px] text-slate-600 ml-auto">{pr.matchCount} 匹配</span>
                <span className="text-[10px] text-slate-600">→ 打开</span>
              </div>

              {/* 文件名结果 */}
              {pr.files?.map(f => (
                <div
                  key={f}
                  className="flex items-center gap-2 px-6 py-1 text-xs text-slate-400 hover:bg-slate-800/40 cursor-pointer transition-colors"
                  onClick={() => handleSelectResult(pr.projectId)}
                >
                  <span className="text-slate-600">📄</span>
                  <span className="font-mono truncate">{f}</span>
                </div>
              ))}

              {/* 内容匹配结果 */}
              {pr.matches?.map((m, i) => (
                <div
                  key={`${m.file}-${m.line}-${i}`}
                  className="flex items-start gap-2 px-6 py-1 text-xs text-slate-400 hover:bg-slate-800/40 cursor-pointer transition-colors"
                  onClick={() => handleSelectResult(pr.projectId)}
                >
                  <span className="text-slate-600 flex-shrink-0 font-mono w-16 truncate text-right">{m.file.split('/').pop()}</span>
                  <span className="text-slate-600 flex-shrink-0">:</span>
                  <span className="text-slate-600 flex-shrink-0 w-5 text-right">{m.line}</span>
                  <span className="font-mono truncate text-slate-400 flex-1">{m.content.trim()}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-slate-800 flex items-center gap-4 text-[10px] text-slate-600 flex-shrink-0">
          <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500">↵</kbd> 打开项目</span>
          <span><kbd className="px-1 py-0.5 rounded bg-slate-800 text-slate-500">Esc</kbd> 关闭</span>
          <span className="ml-auto">🔍 全局搜索 v21.0 — ripgrep 引擎</span>
        </div>
      </div>
    </>
  );
}