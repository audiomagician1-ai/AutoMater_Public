/**
 * GitPage v1.0 — 本地 Git 版本管理
 *
 * 左侧: 提交历史时间线 + 分支信息
 * 右侧: Commit 详情(文件列表+diff) / 工作区变更 / 手动提交
 *
 * @module GitPage
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/app-store';
import { toast, confirm } from '../stores/toast-store';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
}

interface BranchInfo {
  name: string;
  current: boolean;
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
    ' ' +
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天前`;
  return formatDate(iso);
}

/** 变更类型标签 */
function statusLabel(index: string, worktree: string): { text: string; color: string } {
  if (index === '?' || worktree === '?') return { text: '新文件', color: 'text-emerald-400' };
  if (index === 'D' || worktree === 'D') return { text: '删除', color: 'text-red-400' };
  if (index === 'M' || worktree === 'M') return { text: '修改', color: 'text-amber-400' };
  if (index === 'A') return { text: '新增', color: 'text-emerald-400' };
  if (index === 'R' || worktree === 'R') return { text: '重命名', color: 'text-blue-400' };
  return { text: '变更', color: 'text-slate-400' };
}

/** 简单语法高亮 diff */
function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="text-xs text-slate-600 py-4 text-center">无变更</div>;
  const lines = diff.split('\n').slice(0, 2000); // 限制行数
  return (
    <pre className="text-[11px] leading-relaxed font-mono whitespace-pre overflow-x-auto">
      {lines.map((line, i) => {
        let cls = 'text-slate-400';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-950/30';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-950/30';
        else if (line.startsWith('@@')) cls = 'text-blue-400';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-slate-600';
        return (
          <div key={i} className={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

// ═══════════════════════════════════════
// Main Component
// ═══════════════════════════════════════

export function GitPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);

  // ── State ──
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [status, setStatus] = useState<GitStatusEntry[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // 选中的 commit / "workdir" 表示查看工作区变更
  const [selected, setSelected] = useState<string | 'workdir'>('workdir');
  const [commitFiles, setCommitFiles] = useState<string[]>([]);
  const [diffContent, setDiffContent] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // 手动 commit
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);

  // 文件版本历史
  const [fileHistoryPath, setFileHistoryPath] = useState<string | null>(null);
  const [fileHistory, setFileHistory] = useState<GitLogEntry[]>([]);
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewHash, setPreviewHash] = useState<string | null>(null);

  const commitMsgRef = useRef<HTMLTextAreaElement>(null);

  // ── Data Loading ──
  const loadData = useCallback(async () => {
    if (!currentProjectId) return;
    setLoading(true);
    try {
      const [logResult, statusResult, branchResult] = await Promise.all([
        window.automater.project.gitStructuredLog(currentProjectId, 100),
        window.automater.project.gitStatus(currentProjectId),
        window.automater.project.gitBranches(currentProjectId),
      ]);
      setCommits(logResult || []);
      setStatus(statusResult || []);
      setCurrentBranch(branchResult?.current || '');
      setBranches(branchResult?.branches || []);
    } catch {
      /* silent */
    }
    setLoading(false);
  }, [currentProjectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── 选中 commit 后加载详情 ──
  useEffect(() => {
    if (!currentProjectId) return;
    if (selected === 'workdir') {
      // 显示工作区 diff
      setCommitFiles([]);
      setSelectedFile(null);
      (async () => {
        setDiffLoading(true);
        try {
          const diff = await window.automater.project.gitDiff(currentProjectId);
          setDiffContent(diff);
        } catch {
          setDiffContent('');
        }
        setDiffLoading(false);
      })();
      return;
    }
    // 选中了具体 commit
    (async () => {
      setDiffLoading(true);
      setSelectedFile(null);
      try {
        const files = await window.automater.project.gitCommitFiles(currentProjectId, selected);
        setCommitFiles(files || []);
        // 默认显示整个 commit 的 diff
        const diff = await window.automater.project.gitDiff(currentProjectId, `${selected}^..${selected}`);
        setDiffContent(diff);
      } catch {
        setCommitFiles([]);
        setDiffContent('');
      }
      setDiffLoading(false);
    })();
  }, [selected, currentProjectId]);

  // ── 选中 commit 中的某个文件 → 加载文件 diff ──
  const handleSelectCommitFile = async (filePath: string) => {
    if (!currentProjectId || selected === 'workdir') return;
    setSelectedFile(filePath);
    setDiffLoading(true);
    try {
      const diff = await window.automater.project.gitFileDiff(currentProjectId, selected, filePath);
      setDiffContent(diff);
    } catch {
      setDiffContent('');
    }
    setDiffLoading(false);
  };

  // ── 手动 Commit ──
  const handleCommit = async () => {
    if (!currentProjectId || !commitMsg.trim()) return;
    setCommitting(true);
    try {
      const result = await window.automater.project.gitCommit(currentProjectId, commitMsg.trim());
      if (result.success) {
        toast.success(`已提交 ${result.hash || ''}${result.pushed ? ' (已推送)' : ''}`);
        setCommitMsg('');
        await loadData();
        setSelected('workdir');
      } else {
        toast.warning('无变更可提交');
      }
    } catch (err) {
      toast.error(`提交失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    setCommitting(false);
  };

  // ── 文件版本历史 ──
  const handleViewFileHistory = async (filePath: string) => {
    if (!currentProjectId) return;
    setFileHistoryPath(filePath);
    setFileHistoryLoading(true);
    setPreviewContent(null);
    setPreviewHash(null);
    try {
      const history = await window.automater.project.gitFileLog(currentProjectId, filePath);
      setFileHistory(history || []);
    } catch {
      setFileHistory([]);
    }
    setFileHistoryLoading(false);
  };

  const handlePreviewFileAt = async (hash: string) => {
    if (!currentProjectId || !fileHistoryPath) return;
    setPreviewHash(hash);
    try {
      const content = await window.automater.project.gitShowFile(currentProjectId, hash, fileHistoryPath);
      setPreviewContent(content);
    } catch {
      setPreviewContent(null);
    }
  };

  const handleCheckoutFile = async (hash: string) => {
    if (!currentProjectId || !fileHistoryPath) return;
    const result = await confirm({
      title: '确认回退',
      message: `确定回退 ${fileHistoryPath} 到 ${hash.slice(0, 7)} 版本？\n\n此操作会覆盖当前文件内容（可通过 git checkout 恢复）。`,
      confirmText: '回退',
      danger: true,
    });
    if (!result.confirmed) return;
    try {
      const result = await window.automater.project.gitCheckoutFile(currentProjectId, hash, fileHistoryPath);
      if (result.success) {
        toast.success(`已回退 ${fileHistoryPath} 到 ${hash.slice(0, 7)}`);
        setFileHistoryPath(null);
        await loadData();
      } else {
        toast.error(`回退失败: ${result.error || '未知错误'}`);
      }
    } catch (err) {
      toast.error(`回退失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!currentProjectId) {
    return <div className="h-full flex items-center justify-center text-slate-500">请先选择项目</div>;
  }

  const changedCount = status.length;
  const selectedCommit = selected !== 'workdir' ? commits.find(c => c.hash === selected) : null;

  return (
    <div className="h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold text-slate-200">🔀 版本管理</h1>
          {currentBranch && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-400 border border-blue-800/30">
              ⎇ {currentBranch}
            </span>
          )}
          {branches.length > 1 && <span className="text-[10px] text-slate-600">{branches.length} 分支</span>}
          <span className="text-[10px] text-slate-600">{commits.length} 次提交</span>
          {changedCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 border border-amber-800/30">
              {changedCount} 未提交变更
            </span>
          )}
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="text-[10px] px-2 py-1 rounded-md bg-slate-800 text-slate-400 hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {loading ? '刷新中...' : '🔄 刷新'}
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* ═══ 左侧: 提交历史 + 工作区变更 ═══ */}
        <div className="w-80 shrink-0 border-r border-slate-800 flex flex-col">
          {/* 手动提交区 */}
          {changedCount > 0 && (
            <div className="p-3 border-b border-slate-800 bg-slate-950/50">
              <div className="text-[10px] text-slate-500 mb-1.5">快速提交 ({changedCount} 个变更)</div>
              <textarea
                ref={commitMsgRef}
                value={commitMsg}
                onChange={e => setCommitMsg(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCommit();
                }}
                placeholder="输入提交信息... (Ctrl+Enter 提交)"
                className="w-full bg-slate-800/80 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 resize-none outline-none focus:border-forge-500 transition-colors"
                rows={2}
              />
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[9px] text-slate-600">git add -A && git commit</span>
                <button
                  onClick={handleCommit}
                  disabled={committing || !commitMsg.trim()}
                  className="text-[10px] px-3 py-1 rounded-md bg-forge-600/30 text-forge-400 hover:bg-forge-600/50 disabled:opacity-40 transition-colors"
                >
                  {committing ? '提交中...' : '✓ 提交'}
                </button>
              </div>
            </div>
          )}

          {/* 时间线列表 */}
          <div className="flex-1 overflow-y-auto">
            {/* 工作区变更项 */}
            <div
              onClick={() => setSelected('workdir')}
              className={`px-3 py-2.5 cursor-pointer transition-colors border-b border-slate-800/50 ${
                selected === 'workdir'
                  ? 'bg-forge-600/10 border-l-2 border-l-forge-500'
                  : 'hover:bg-slate-900/50 border-l-2 border-l-transparent'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs font-medium text-slate-200 flex-1">工作区变更</span>
                {changedCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">
                    {changedCount}
                  </span>
                )}
              </div>
              {changedCount === 0 && (
                <div className="text-[10px] text-slate-600 mt-0.5 ml-4">工作区干净，无未提交变更</div>
              )}
            </div>

            {/* Commit 列表 */}
            {commits.map((commit, i) => (
              <div
                key={commit.hash}
                onClick={() => setSelected(commit.hash)}
                className={`px-3 py-2 cursor-pointer transition-colors ${
                  selected === commit.hash
                    ? 'bg-forge-600/10 border-l-2 border-l-forge-500'
                    : 'hover:bg-slate-900/50 border-l-2 border-l-transparent'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${i === 0 ? 'bg-emerald-400' : 'bg-slate-600'}`}
                  />
                  <span className="text-[10px] font-mono text-slate-500">{commit.shortHash}</span>
                  <span className="text-[10px] text-slate-600 ml-auto">{relativeTime(commit.date)}</span>
                </div>
                <div className="text-xs text-slate-300 truncate ml-3.5">{commit.message}</div>
                <div className="text-[9px] text-slate-600 ml-3.5 mt-0.5">{commit.author}</div>
              </div>
            ))}

            {!loading && commits.length === 0 && (
              <div className="text-center py-8 text-slate-600 text-xs">
                <div className="text-lg mb-1.5">📝</div>
                暂无提交记录
                <br />
                <span className="text-slate-700">项目启动后将自动创建提交</span>
              </div>
            )}
          </div>
        </div>

        {/* ═══ 右侧: 详情面板 ═══ */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 详情头部 */}
          <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-950/30 flex-shrink-0">
            {selected === 'workdir' ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-amber-400">📝 工作区变更</span>
                <span className="text-[10px] text-slate-600">{changedCount} 个文件</span>
              </div>
            ) : selectedCommit ? (
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                    {selectedCommit.shortHash}
                  </span>
                  <span className="text-xs font-medium text-slate-200 flex-1 truncate">{selectedCommit.message}</span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-slate-500">
                  <span>👤 {selectedCommit.author}</span>
                  <span>📅 {formatDate(selectedCommit.date)}</span>
                  {commitFiles.length > 0 && <span>📄 {commitFiles.length} 文件变更</span>}
                </div>
              </div>
            ) : (
              <span className="text-xs text-slate-600">选择一个提交查看详情</span>
            )}
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* 文件列表 (commit 模式下) */}
            {selected !== 'workdir' && commitFiles.length > 0 && (
              <div className="w-56 shrink-0 border-r border-slate-800 overflow-y-auto">
                <div className="p-2 text-[10px] text-slate-500 border-b border-slate-800/50">变更文件</div>
                {commitFiles.map(f => (
                  <div
                    key={f}
                    onClick={() => handleSelectCommitFile(f)}
                    className={`px-2.5 py-1.5 cursor-pointer text-[11px] truncate transition-colors ${
                      selectedFile === f
                        ? 'bg-forge-600/15 text-slate-200'
                        : 'text-slate-400 hover:bg-slate-900/50 hover:text-slate-300'
                    }`}
                    title={f}
                  >
                    {f.split('/').pop()}
                    <div className="text-[9px] text-slate-600 truncate">{f}</div>
                  </div>
                ))}
                {/* 文件版本历史入口 */}
                {selectedFile && (
                  <div className="p-2 border-t border-slate-800">
                    <button
                      onClick={() => handleViewFileHistory(selectedFile)}
                      className="w-full text-[10px] px-2 py-1.5 rounded-md bg-slate-800 text-slate-400 hover:bg-slate-700 transition-colors"
                    >
                      📜 查看此文件完整历史
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 工作区变更列表 (workdir 模式下) */}
            {selected === 'workdir' && changedCount > 0 && (
              <div className="w-56 shrink-0 border-r border-slate-800 overflow-y-auto">
                <div className="p-2 text-[10px] text-slate-500 border-b border-slate-800/50">变更文件</div>
                {status.map(s => {
                  const label = statusLabel(s.index, s.worktree);
                  return (
                    <div key={s.path} className="px-2.5 py-1.5 text-[11px] truncate flex items-center gap-1.5 group">
                      <span className={`text-[9px] shrink-0 ${label.color}`}>{label.text}</span>
                      <span className="text-slate-400 truncate flex-1" title={s.path}>
                        {s.path.split('/').pop()}
                      </span>
                      <button
                        onClick={() => handleViewFileHistory(s.path)}
                        className="text-[9px] text-slate-600 hover:text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        title="查看文件历史"
                      >
                        📜
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Diff 内容 */}
            <div className="flex-1 overflow-auto p-4 bg-slate-950/30">
              {diffLoading ? (
                <div className="flex items-center justify-center h-full text-slate-600 text-xs animate-pulse">
                  加载中...
                </div>
              ) : diffContent ? (
                <DiffView diff={diffContent} />
              ) : (
                <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                  {selected === 'workdir' && changedCount === 0
                    ? '✨ 工作区干净 — 所有变更已提交'
                    : selected === 'workdir'
                      ? '选择左侧变更文件查看 diff'
                      : '无 diff 内容'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ 文件版本历史弹窗 ═══ */}
      {fileHistoryPath && (
        <>
          <div className="fixed inset-0 z-[80] bg-black/50" onClick={() => setFileHistoryPath(null)} />
          <div className="fixed z-[81] top-[10%] left-[10%] right-[10%] bottom-[10%] bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-200">📜 文件版本历史</h3>
                <div className="text-[10px] text-slate-500 mt-0.5 font-mono">{fileHistoryPath}</div>
              </div>
              <button
                onClick={() => setFileHistoryPath(null)}
                className="text-slate-500 hover:text-slate-300 transition-colors text-lg"
              >
                ×
              </button>
            </div>

            <div className="flex-1 flex overflow-hidden">
              {/* 左: 版本列表 */}
              <div className="w-72 shrink-0 border-r border-slate-800 overflow-y-auto">
                {fileHistoryLoading ? (
                  <div className="text-center py-8 text-slate-600 text-xs animate-pulse">加载中...</div>
                ) : fileHistory.length === 0 ? (
                  <div className="text-center py-8 text-slate-600 text-xs">此文件尚无提交记录</div>
                ) : (
                  fileHistory.map(entry => (
                    <div
                      key={entry.hash}
                      className={`px-3 py-2.5 border-b border-slate-800/50 cursor-pointer transition-colors ${
                        previewHash === entry.hash ? 'bg-forge-600/10' : 'hover:bg-slate-800/50'
                      }`}
                      onClick={() => handlePreviewFileAt(entry.hash)}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] font-mono text-slate-500">{entry.shortHash}</span>
                        <span className="text-[10px] text-slate-600 ml-auto">{relativeTime(entry.date)}</span>
                      </div>
                      <div className="text-xs text-slate-300 truncate">{entry.message}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[9px] text-slate-600">{entry.author}</span>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            handleCheckoutFile(entry.hash);
                          }}
                          className="text-[9px] ml-auto px-2 py-0.5 rounded bg-amber-900/30 text-amber-400 hover:bg-amber-900/50 transition-colors"
                        >
                          回退到此版本
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* 右: 文件内容预览 */}
              <div className="flex-1 overflow-auto p-4 bg-slate-950/40">
                {previewContent !== null ? (
                  <pre className="text-[11px] leading-relaxed font-mono text-slate-300 whitespace-pre overflow-x-auto">
                    {previewContent}
                  </pre>
                ) : previewHash ? (
                  <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                    此版本中该文件不存在
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-slate-600 text-xs">
                    ← 点击左侧版本查看文件内容
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
