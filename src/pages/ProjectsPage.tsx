import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';
import { toErrorMessage } from '../utils/errors';

const STATUS_LABELS: Record<string, { text: string; color: string; icon: string }> = {
  initializing: { text: '分析中', color: 'text-blue-400',    icon: '🔵' },
  analyzing:    { text: '导入分析中', color: 'text-cyan-400',  icon: '📥' },
  developing:   { text: '开发中', color: 'text-emerald-400', icon: '🟢' },
  reviewing:    { text: '审查中', color: 'text-amber-400',   icon: '🟡' },
  delivered:    { text: '已交付', color: 'text-green-400',   icon: '✅' },
  paused:       { text: '已暂停', color: 'text-slate-400',   icon: '⏸️' },
  error:        { text: '出错',   color: 'text-red-400',     icon: '❌' },
};

export function ProjectsPage() {
  // 创建表单
  const [showCreate, setShowCreate] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [historyPath, setHistoryPath] = useState('');
  const [gitMode, setGitMode] = useState<'local' | 'github'>('local');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubTesting, setGithubTesting] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [creating, setCreating] = useState(false);

  // 导入已有项目
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ phase: number; step: string; progress: number } | null>(null);

  const [projects, setProjects] = useState<any[]>([]);
  const [projectStats, setProjectStats] = useState<Record<string, any>>({});
  const { settingsConfigured, setGlobalPage, enterProject, addLog } = useAppStore();

  const loadProjects = async () => {
    const list = await window.automater.project.list();
    setProjects(list || []);
    const stats: Record<string, any> = {};
    for (const p of (list || [])) {
      try { stats[p.id] = await window.automater.project.getStats(p.id); } catch {}
    }
    setProjectStats(stats);
  };

  useEffect(() => { loadProjects(); }, []);
  useEffect(() => {
    const t = setInterval(loadProjects, 6000);
    return () => clearInterval(t);
  }, []);

  const handleCreate = async () => {
    if (!projectName.trim() || creating) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }

    setCreating(true);
    try {
      const options: any = { gitMode };
      if (workspacePath.trim()) options.workspacePath = workspacePath.trim();
      if (historyPath.trim()) options.historyPath = historyPath.trim();
      if (gitMode === 'github' && githubRepo && githubToken) {
        options.githubRepo = githubRepo;
        options.githubToken = githubToken;
      }
      const result = await window.automater.project.create(projectName.trim(), options);
      if (result.success) {
        addLog({ projectId: result.projectId, agentId: 'system', content: `📁 项目已创建: ${result.name}` });
        // 重置表单
        setProjectName('');
        setWorkspacePath('');
        setHistoryPath('');
        setGithubRepo('');
        setGithubToken('');
        setShowCreate(false);
        // 进入项目的许愿页，让用户在那里输入需求
        enterProject(result.projectId, 'wish');
      }
    } catch (err: unknown) {
      addLog({ projectId: '', agentId: 'system', content: `❌ ${toErrorMessage(err)}` });
    } finally {
      setCreating(false);
      loadProjects();
    }
  };

  const handleTestGitHub = async () => {
    if (!githubRepo || !githubToken) return;
    setGithubTesting(true);
    setGithubTestResult(null);
    const result = await window.automater.project.testGitHub(githubRepo, githubToken);
    setGithubTestResult(result);
    setGithubTesting(false);
  };

  const handleStop = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.automater.project.stop(id);
    loadProjects();
  };

  const handleResume = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.automater.project.start(id);
    enterProject(id, 'logs');
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await window.automater.project.delete(id);
    loadProjects();
  };

  const handleExport = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const result = await window.automater.project.export(id);
    if (result.success) addLog({ projectId: id, agentId: 'system', content: `📦 已导出: ${result.path}` });
  };

  const handleImportProject = async () => {
    if (!importPath.trim() || importing) return;
    if (!settingsConfigured) { setGlobalPage('settings'); return; }

    setImporting(true);
    setImportProgress({ phase: 0, step: '准备导入...', progress: 0 });
    try {
      const name = importName.trim() || importPath.split(/[\\/]/).pop() || 'Imported Project';
      const options: any = {
        gitMode: 'local' as const,
        workspacePath: importPath.trim(),
        importExisting: true,
      };
      const result = await window.automater.project.create(name, options);
      if (result.success) {
        // 触发后端异步分析（不阻塞，进度通过事件推送到 OverviewPage）
        window.automater.project.analyzeExisting(result.projectId).catch(() => {});

        addLog({ projectId: result.projectId, agentId: 'system', content: `📥 项目已导入，分析中: ${name}` });
        setImportPath('');
        setImportName('');
        setShowImport(false);
        setImportProgress(null);
        // 直接进入 Overview 页面查看实时进度
        enterProject(result.projectId, 'overview');
      }
    } catch (err: unknown) {
      addLog({ projectId: '', agentId: 'system', content: `❌ 导入失败: ${toErrorMessage(err)}` });
    } finally {
      setImporting(false);
      setImportProgress(null);
      loadProjects();
    }
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* 顶部 */}
      <div className="px-8 pt-8 pb-6 border-b border-slate-800/50">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold">项目</h1>
              <p className="text-slate-500 text-xs mt-1">AI Agent 团队帮你实现软件需求</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setShowImport(!showImport); setShowCreate(false); }}
                className="px-4 py-2.5 rounded-lg font-medium text-sm transition-all bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
              >
                📥 导入已有项目
              </button>
              <button
                onClick={() => { setShowCreate(!showCreate); setShowImport(false); }}
                className="px-4 py-2.5 rounded-lg font-medium text-sm transition-all bg-forge-600 hover:bg-forge-500 text-white shadow-lg shadow-forge-600/20"
              >
                ＋ 新建项目
              </button>
            </div>
          </div>

          {!settingsConfigured && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-amber-400 text-sm text-center mb-4">
              💡 首次使用请先 <button onClick={() => setGlobalPage('settings')} className="underline font-medium">配置 LLM</button>
            </div>
          )}

          {/* 导入已有项目表单 */}
          {showImport && (
            <div className="bg-slate-900 border border-cyan-800/30 rounded-xl p-6 space-y-4 mb-4">
              <h3 className="text-sm font-semibold text-slate-200">📥 导入已有项目</h3>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                将已有代码项目导入 AutoMater。系统会自动执行静态扫描 → 模块摘要 → 架构合成 → 文档填充，
                生成完整的项目文档框架，让 Agent 团队理解你的项目。
              </p>

              {/* 项目路径 */}
              <section className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">项目根目录 *</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={importPath}
                    onChange={e => {
                      setImportPath(e.target.value);
                      if (!importName) {
                        const name = e.target.value.split(/[\\/]/).pop() || '';
                        setImportName(name);
                      }
                    }}
                    placeholder="选择已有代码项目的根目录"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition-colors font-mono text-xs"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const result = await window.automater.dialog.openDirectory('选择项目根目录');
                        if (!result.canceled && result.filePaths?.[0]) {
                          setImportPath(result.filePaths[0]);
                          if (!importName) setImportName(result.filePaths[0].split(/[\\/]/).pop() || '');
                        }
                      } catch {}
                    }}
                    className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs transition-colors shrink-0"
                    title="浏览文件夹"
                  >
                    📂
                  </button>
                </div>
              </section>

              {/* 项目名称 */}
              <section className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">项目名称</label>
                <input
                  type="text"
                  value={importName}
                  onChange={e => setImportName(e.target.value)}
                  placeholder="自动取目录名"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition-colors"
                />
              </section>

              {/* 导入流程说明 */}
              <div className="bg-slate-800/50 rounded-lg p-3 space-y-1">
                <p className="text-[10px] text-slate-500 font-medium">导入分析流程 (v6.0 快速理解)：</p>
                <div className="grid grid-cols-2 gap-1 text-[10px]">
                  <div className={`text-center p-1.5 rounded ${importProgress && importProgress.phase >= 0 ? 'bg-cyan-900/30 text-cyan-400' : 'text-slate-600'}`}>
                    📸 收集快照<br />目录 / 配置 / 符号
                  </div>
                  <div className={`text-center p-1.5 rounded ${importProgress && importProgress.phase >= 1 ? 'bg-cyan-900/30 text-cyan-400' : 'text-slate-600'}`}>
                    🤖 AI 分析<br />大模型理解 → 文档
                  </div>
                </div>
                {importProgress && (
                  <div className="mt-2">
                    <div className="flex justify-between text-[10px] text-cyan-400 mb-1">
                      <span>{importProgress.step}</span>
                      <span>{Math.round(importProgress.progress * 100)}%</span>
                    </div>
                    <div className="w-full h-1 bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-500 rounded-full transition-all duration-300" style={{ width: `${importProgress.progress * 100}%` }} />
                    </div>
                  </div>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleImportProject}
                  disabled={!importPath.trim() || importing}
                  className="flex-1 py-2.5 rounded-lg font-medium text-sm transition-all bg-cyan-700 hover:bg-cyan-600 text-white disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed"
                >
                  {importing ? '⏳ 分析中...' : '📥 开始导入分析'}
                </button>
                <button
                  onClick={() => { setShowImport(false); setImportProgress(null); }}
                  className="px-4 py-2.5 rounded-lg text-sm text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 transition-all"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* 创建项目表单 */}
          {showCreate && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold text-slate-200">创建新项目</h3>

              {/* 项目名称 */}
              <section className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">项目名称 *</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  placeholder="例: My Todo App"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors"
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                  autoFocus
                  onBlur={() => {
                    // 自动填充工作区和历史版本路径
                    if (projectName.trim() && !workspacePath) {
                      const safeName = projectName.trim().replace(/[\s\\/:<>"'|?*]+/g, '-').toLowerCase();
                      const base = `D:\\AutoMater-Projects\\${safeName}`;
                      setWorkspacePath(base);
                      if (!historyPath) setHistoryPath(`${base}\\.versions`);
                    }
                  }}
                />
              </section>

              {/* 工作区路径 (自动填充) */}
              <section className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">
                  工作区路径
                  <span className="text-slate-600 ml-1">(自动生成，可手动修改)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={workspacePath}
                    onChange={e => setWorkspacePath(e.target.value)}
                    placeholder="自动根据项目名填充"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const result = await window.automater.dialog.openDirectory('选择工作区文件夹');
                        if (!result.canceled && result.filePaths?.[0]) setWorkspacePath(result.filePaths[0]);
                      } catch {}
                    }}
                    className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs transition-colors shrink-0"
                    title="浏览文件夹"
                  >
                    📂
                  </button>
                </div>
              </section>

              {/* 历史版本文件夹 (自动填充) */}
              <section className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">
                  历史版本文件夹
                  <span className="text-slate-600 ml-1">(存储文档/产出的历史快照)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={historyPath}
                    onChange={e => setHistoryPath(e.target.value)}
                    placeholder="自动根据工作区路径填充"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const result = await window.automater.dialog.openDirectory('选择历史版本文件夹');
                        if (!result.canceled && result.filePaths?.[0]) setHistoryPath(result.filePaths[0]);
                      } catch {}
                    }}
                    className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs transition-colors shrink-0"
                    title="浏览文件夹"
                  >
                    📂
                  </button>
                </div>
              </section>

              {/* 版本控制 */}
              <section className="space-y-3">
                <label className="text-xs font-medium text-slate-400">版本控制</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setGitMode('local')}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all ${gitMode === 'local' ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                  >
                    📁 本地 Git
                  </button>
                  <button
                    onClick={() => setGitMode('github')}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all ${gitMode === 'github' ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                  >
                    🐙 GitHub
                  </button>
                </div>

                {gitMode === 'github' && (
                  <div className="space-y-2 pl-1">
                    <input
                      type="text"
                      value={githubRepo}
                      onChange={e => setGithubRepo(e.target.value)}
                      placeholder="owner/repo (例: myname/myproject)"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500"
                    />
                    <input
                      type="password"
                      value={githubToken}
                      onChange={e => setGithubToken(e.target.value)}
                      placeholder="GitHub Personal Access Token (ghp_...)"
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleTestGitHub}
                        disabled={!githubRepo || !githubToken || githubTesting}
                        className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 transition-all disabled:opacity-40"
                      >
                        {githubTesting ? '测试中...' : '🔌 测试连接'}
                      </button>
                      {githubTestResult && (
                        <span className={`text-xs ${githubTestResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
                          {githubTestResult.message}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/* 操作按钮 */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleCreate}
                  disabled={!projectName.trim() || creating}
                  className="flex-1 py-2.5 rounded-lg font-medium text-sm transition-all bg-forge-600 hover:bg-forge-500 text-white disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed"
                >
                  {creating ? '⏳ 创建中...' : '📁 创建项目'}
                </button>
                <button
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2.5 rounded-lg text-sm text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 transition-all"
                >
                  取消
                </button>
              </div>

              <p className="text-[10px] text-slate-600">创建后进入项目的「许愿」页面输入具体需求</p>
            </div>
          )}
        </div>
      </div>

      {/* 项目网格 */}
      <div className="flex-1 px-8 py-6">
        <div className="max-w-5xl mx-auto">
          {projects.length === 0 ? (
            <div className="text-center py-20 text-slate-600">
              <p className="text-4xl mb-3">🏗️</p>
              <p className="text-lg">还没有项目</p>
              <p className="text-sm mt-1">点击「新建项目」开始</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {projects.map(p => {
                const st = STATUS_LABELS[p.status] || { text: p.status, color: 'text-slate-500', icon: '⬜' };
                const isActive = p.status === 'initializing' || p.status === 'analyzing' || p.status === 'developing' || p.status === 'reviewing';
                const stats = projectStats[p.id];
                const f = stats?.features || {};
                const a = stats?.agents || {};
                const total = f.total ?? 0;
                const passed = f.passed ?? 0;
                const progress = total > 0 ? (passed / total) * 100 : 0;
                const cost = a.total_cost ?? 0;

                return (
                  <div
                    key={p.id}
                    onClick={() => enterProject(p.id)}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-5 cursor-pointer transition-all hover:border-slate-600 hover:shadow-lg hover:shadow-slate-900/50 group"
                  >
                    {/* 项目名 + 状态 */}
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-slate-200 truncate">{p.name}</h3>
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 ${st.color} flex-shrink-0 ml-2`}>
                        {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-current mr-1 animate-pulse" />}
                        {st.text}
                      </span>
                    </div>

                    {/* 需求描述 */}
                    {p.wish && <p className="text-xs text-slate-400 leading-snug line-clamp-2 mb-3">{p.wish}</p>}
                    {!p.wish && <p className="text-xs text-slate-600 italic mb-3">尚未设置需求</p>}

                    {/* 标签行 */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      {p.git_mode === 'github' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400">🐙 {p.github_repo}</span>
                      )}
                      <span className="text-[10px] text-slate-600">{new Date(p.created_at).toLocaleDateString()}</span>
                    </div>

                    {/* 进度条 */}
                    {total > 0 && (
                      <div className="mb-3">
                        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                          <span>{passed}/{total} features</span>
                          <span>{Math.round(progress)}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${progress >= 100 ? 'bg-green-500' : 'bg-forge-500'}`}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* 底部操作 */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/50">
                      {cost > 0 && <span className="text-[10px] text-amber-500/70">${cost.toFixed(3)}</span>}
                      <div className="flex gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                        {isActive && (
                          <button onClick={e => handleStop(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors" title="停止">⏹</button>
                        )}
                        {(p.status === 'paused' || p.status === 'error') && (
                          <button onClick={e => handleResume(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-emerald-900/50 text-slate-400 hover:text-emerald-400 transition-colors" title="继续">▶</button>
                        )}
                        {p.status === 'delivered' && (
                          <button onClick={e => handleExport(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-forge-900/50 text-slate-400 hover:text-forge-400 transition-colors" title="导出">📦</button>
                        )}
                        {!isActive && (
                          <button onClick={e => handleDelete(e, p.id)} className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-colors" title="删除">🗑</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}