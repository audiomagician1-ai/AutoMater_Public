/**
 * EvolutionPage — 自我进化仪表板 (Phase 2)
 *
 * 全局页面 (无需项目), 提供:
 *  - StatusTab:   实时进化状态 + preflight + 一键评估 + Kill Switch
 *  - FitnessTab:  适应度评估结果与历史对比
 *  - ArchiveTab:  进化历史 (generation 谱系)
 *  - MemoriesTab: 进化记忆 (成功/失败模式)
 *  - ConfigTab:   进化配置 + 不可变文件校验
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

interface FitnessResult {
  score: number;
  tscPassed: boolean;
  tscErrors?: number;
  testPassRate: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  statementCoverage: number;
}

interface ProgressData {
  status: string;
  generation: number;
  maxGenerations: number;
  currentBranch: string;
  baselineFitness: number;
  currentFitness: number;
  archive: ArchiveEntry[];
  memories: MemoryEntry[];
  updatedAt: number;
  logs: string[];
}

interface ArchiveEntry {
  id: string;
  parent_id?: string;
  generation: number;
  branch: string;
  fitness_score?: number;
  fitnessScore?: number;
  description: string;
  status: string;
  created_at: string;
  modified_files?: string;
  fitness_json?: string;
}

interface MemoryEntry {
  id?: number;
  pattern: string;
  outcome: string;
  module: string;
  description: string;
  fitness_impact: number;
  created_at: string;
}

interface PreflightResult {
  success: boolean;
  ok: boolean;
  errors: string[];
  baselineFitness?: FitnessResult;
}

interface ImmutableResult {
  success: boolean;
  ok: boolean;
  violations: string[];
  manifest?: Record<string, string>;
}

// ═══════════════════════════════════════
// Tabs
// ═══════════════════════════════════════

type TabId = 'status' | 'fitness' | 'archive' | 'memories' | 'config';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'status', label: '状态', icon: '📡' },
  { id: 'fitness', label: '适应度', icon: '📊' },
  { id: 'archive', label: '历史', icon: '🧬' },
  { id: 'memories', label: '记忆', icon: '🧠' },
  { id: 'config', label: '配置', icon: '🔧' },
];

// ═══════════════════════════════════════
// Main Component
// ═══════════════════════════════════════

export function EvolutionPage() {
  const [activeTab, setActiveTab] = useState<TabId>('status');

  // ── Shared state ──
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [fitness, setFitness] = useState<FitnessResult | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [immutable, setImmutable] = useState<ImmutableResult | null>(null);
  const [archive, setArchive] = useState<ArchiveEntry[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  // ── Auto-refresh progress ──
  const refreshProgress = useCallback(async () => {
    try {
      const p = await window.automater.evolution.getProgress();
      setProgress(p as unknown as ProgressData);
      if (p.logs) setLogs(prev => [...prev, ...(p.logs as string[])]);
    } catch {
      /* silent */
    }
  }, []);

  const refreshArchive = useCallback(async () => {
    try {
      const res = await window.automater.evolution.getArchive();
      if (res.success) setArchive(res.archive as unknown as ArchiveEntry[]);
    } catch {
      /* silent */
    }
  }, []);

  const refreshMemories = useCallback(async () => {
    try {
      const res = await window.automater.evolution.getMemories();
      if (res.success) setMemories(res.memories as unknown as MemoryEntry[]);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    refreshProgress();
    refreshArchive();
    refreshMemories();
    window.automater.evolution
      .getConfig()
      .then((c: Record<string, unknown>) => setConfig(c))
      .catch(() => {});

    // Poll progress every 5s
    const iv = setInterval(refreshProgress, 5000);

    // Real-time event subscriptions
    const unsubLog = window.automater.on('evolution:log', (data: unknown) => {
      const d = data as { message?: string };
      if (d?.message) setLogs(prev => [...prev, d.message!]);
    });
    const unsubProgress = window.automater.on('evolution:progress', (data: unknown) => {
      const d = data as { status?: string };
      if (d?.status) {
        refreshProgress();
        refreshArchive();
      }
    });

    return () => {
      clearInterval(iv);
      unsubLog();
      unsubProgress();
    };
  }, [refreshProgress, refreshArchive, refreshMemories]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // ── Actions ──
  const doPreflight = useCallback(async () => {
    setLoading('preflight');
    setLogs(prev => [...prev, '🔍 执行进化前预检...']);
    try {
      const res = await window.automater.evolution.preflight();
      setPreflight(res as unknown as PreflightResult);
      if (res.baselineFitness) setFitness(res.baselineFitness as unknown as FitnessResult);
      setLogs(prev => [...prev, res.ok ? '✅ 预检通过' : `❌ 预检失败: ${(res.errors || []).join(', ')}`]);
    } catch (e: unknown) {
      setLogs(prev => [...prev, `❌ 预检异常: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setLoading(null);
      await refreshProgress();
    }
  }, [refreshProgress]);

  const doEvaluate = useCallback(async () => {
    setLoading('evaluate');
    setLogs(prev => [...prev, '📊 评估适应度...']);
    try {
      const res = await window.automater.evolution.evaluate();
      if (res.success && res.fitness) {
        setFitness(res.fitness as unknown as FitnessResult);
        setLogs(prev => [...prev, `✅ 适应度: ${(res.fitness as unknown as FitnessResult).score.toFixed(4)}`]);
      } else {
        setLogs(prev => [...prev, `❌ 评估失败: ${res.error || 'unknown'}`]);
      }
    } catch (e: unknown) {
      setLogs(prev => [...prev, `❌ 评估异常: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setLoading(null);
    }
  }, []);

  const doAbort = useCallback(async () => {
    setLoading('abort');
    setLogs(prev => [...prev, '⛔ 中止进化...']);
    try {
      const res = await window.automater.evolution.abort();
      setLogs(prev => [...prev, res.success ? '✅ 已中止' : `⚠️ ${res.error || '中止失败'}`]);
    } catch (e: unknown) {
      setLogs(prev => [...prev, `❌ 中止异常: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setLoading(null);
      await refreshProgress();
    }
  }, [refreshProgress]);

  const doVerifyImmutable = useCallback(async () => {
    setLoading('verify');
    setLogs(prev => [...prev, '🔒 校验不可变文件...']);
    try {
      const res = await window.automater.evolution.verifyImmutable();
      setImmutable(res as unknown as ImmutableResult);
      setLogs(prev => [...prev, res.ok ? '✅ 不可变文件完整性通过' : `❌ 发现 ${res.violations.length} 个违规`]);
    } catch (e: unknown) {
      setLogs(prev => [...prev, `❌ 校验异常: ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setLoading(null);
    }
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-lg shadow-lg shadow-emerald-500/20">
            🧬
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">自我进化</h1>
            <p className="text-xs text-slate-500">
              {progress
                ? `${STATUS_LABEL[progress.status as keyof typeof STATUS_LABEL] || progress.status} · 第 ${progress.generation} 代`
                : '加载中...'}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <StatusBadge status={progress?.status || 'idle'} />
          </div>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex-shrink-0 px-6">
        <div className="flex gap-1 bg-slate-900 rounded-lg p-1 border border-slate-800">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-3 py-2 rounded-md text-sm transition-all flex items-center justify-center gap-1.5 ${
                activeTab === tab.id
                  ? 'bg-slate-800 text-white shadow-inner'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
              }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {activeTab === 'status' && (
          <StatusTab
            progress={progress}
            preflight={preflight}
            fitness={fitness}
            loading={loading}
            logs={logs}
            logRef={logRef}
            onPreflight={doPreflight}
            onEvaluate={doEvaluate}
            onAbort={doAbort}
          />
        )}
        {activeTab === 'fitness' && <FitnessTab fitness={fitness} preflight={preflight} />}
        {activeTab === 'archive' && <ArchiveTab archive={archive} onRefresh={refreshArchive} />}
        {activeTab === 'memories' && <MemoriesTab memories={memories} onRefresh={refreshMemories} />}
        {activeTab === 'config' && (
          <ConfigTab config={config} immutable={immutable} loading={loading} onVerify={doVerifyImmutable} />
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Status Tab
// ═══════════════════════════════════════

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  preflight: '预检中',
  evolving: '进化中',
  evaluating: '评估中',
  success: '成功',
  failed: '失败',
  aborted: '已中止',
};

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-slate-700 text-slate-400',
    preflight: 'bg-blue-900/50 text-blue-400',
    evolving: 'bg-emerald-900/50 text-emerald-400 animate-pulse',
    evaluating: 'bg-amber-900/50 text-amber-400',
    success: 'bg-emerald-900/50 text-emerald-400',
    failed: 'bg-red-900/50 text-red-400',
    aborted: 'bg-orange-900/50 text-orange-400',
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${colors[status] || colors.idle}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function StatusTab({
  progress,
  preflight,
  fitness,
  loading,
  logs,
  logRef,
  onPreflight,
  onEvaluate,
  onAbort,
}: {
  progress: ProgressData | null;
  preflight: PreflightResult | null;
  fitness: FitnessResult | null;
  loading: string | null;
  logs: string[];
  logRef: React.RefObject<HTMLDivElement | null>;
  onPreflight: () => void;
  onEvaluate: () => void;
  onAbort: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="grid grid-cols-3 gap-3">
        <ActionButton
          icon="🔍"
          label="预检"
          desc="检查 git 状态、不可变文件、基线适应度"
          loading={loading === 'preflight'}
          disabled={!!loading}
          onClick={onPreflight}
        />
        <ActionButton
          icon="📊"
          label="评估适应度"
          desc="执行 tsc + vitest + 覆盖率"
          loading={loading === 'evaluate'}
          disabled={!!loading}
          onClick={onEvaluate}
        />
        <ActionButton
          icon="⛔"
          label="紧急停止"
          desc="中止所有进化进程"
          loading={loading === 'abort'}
          disabled={!!loading || progress?.status === 'idle'}
          onClick={onAbort}
          danger
        />
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-3">
        <MiniCard label="代数" value={progress?.generation ?? 0} sub={`/ ${progress?.maxGenerations ?? 50}`} />
        <MiniCard
          label="基线适应度"
          value={progress?.baselineFitness?.toFixed(3) ?? '—'}
          sub={fitness ? `当前 ${fitness.score.toFixed(3)}` : ''}
        />
        <MiniCard label="测试" value={fitness?.passedTests ?? '—'} sub={fitness ? `/ ${fitness.totalTests}` : ''} />
        <MiniCard
          label="覆盖率"
          value={fitness ? `${fitness.statementCoverage.toFixed(1)}%` : '—'}
          sub={fitness?.tscPassed ? 'tsc ✅' : fitness ? 'tsc ❌' : ''}
        />
      </div>

      {/* Preflight Result */}
      {preflight && (
        <div
          className={`rounded-xl border p-4 ${
            preflight.ok ? 'border-emerald-800/50 bg-emerald-950/20' : 'border-red-800/50 bg-red-950/20'
          }`}
        >
          <div className="flex items-center gap-2 text-sm font-medium mb-2">
            <span>{preflight.ok ? '✅' : '❌'}</span>
            <span>{preflight.ok ? '预检通过' : '预检失败'}</span>
          </div>
          {preflight.errors.length > 0 && (
            <ul className="space-y-1 text-xs text-red-400">
              {preflight.errors.map((e, i) => (
                <li key={i} className="flex gap-1">
                  <span>•</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Live Log */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
          <span className="text-xs font-medium text-slate-400">📜 进化日志</span>
          <span className="text-[10px] text-slate-600">{logs.length} 条</span>
          <button
            className="ml-auto text-[10px] text-slate-600 hover:text-slate-400 transition"
            onClick={() => {
              /* Logs is local state — handled in parent, but we re-expose via a clear pattern */
            }}
          >
            清空
          </button>
        </div>
        <div ref={logRef} className="h-48 overflow-y-auto p-3 space-y-0.5 font-mono text-[11px]">
          {logs.length === 0 ? (
            <div className="text-slate-600 text-center py-8">等待操作...</div>
          ) : (
            logs.map((line, i) => (
              <div
                key={i}
                className={`${line.startsWith('❌') ? 'text-red-400' : line.startsWith('✅') ? 'text-emerald-400' : 'text-slate-400'}`}
              >
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  desc,
  loading,
  disabled,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  desc: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-left transition-all group ${
        danger
          ? 'border-red-800/40 bg-red-950/20 hover:bg-red-950/40 hover:border-red-700/60'
          : 'border-slate-800 bg-slate-900/50 hover:bg-slate-800/80 hover:border-slate-700'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{loading ? '⏳' : icon}</span>
        <span className={`text-sm font-medium ${danger ? 'text-red-400' : 'text-slate-200'}`}>
          {loading ? '执行中...' : label}
        </span>
      </div>
      <p className="text-[11px] text-slate-500">{desc}</p>
    </button>
  );
}

function MiniCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-bold text-slate-200">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// ═══════════════════════════════════════
// Fitness Tab
// ═══════════════════════════════════════

function FitnessTab({ fitness, preflight }: { fitness: FitnessResult | null; preflight: PreflightResult | null }) {
  if (!fitness && !preflight?.baselineFitness) {
    return (
      <div className="text-center py-20 text-slate-500">
        <div className="text-4xl mb-4">📊</div>
        <p>尚未评估适应度</p>
        <p className="text-xs mt-1">请先在「状态」页执行预检或评估</p>
      </div>
    );
  }

  const data = fitness || preflight?.baselineFitness;
  if (!data) return null;

  const bars: { label: string; value: number; max: number; color: string; unit?: string }[] = [
    { label: '综合适应度', value: data.score, max: 1, color: 'bg-emerald-500' },
    { label: '测试通过率', value: data.testPassRate, max: 1, color: 'bg-blue-500' },
    { label: '语句覆盖率', value: data.statementCoverage, max: 100, color: 'bg-purple-500', unit: '%' },
    {
      label: 'TypeScript',
      value: data.tscPassed ? 1 : 0,
      max: 1,
      color: data.tscPassed ? 'bg-emerald-500' : 'bg-red-500',
    },
  ];

  return (
    <div className="space-y-4">
      {/* Score Ring */}
      <div className="flex items-center gap-6 p-6 rounded-xl border border-slate-800 bg-slate-900/50">
        <div className="relative w-28 h-28">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              className="text-slate-800"
            />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              strokeDasharray={`${data.score * 264} 264`}
              strokeLinecap="round"
              className={data.score > 0.7 ? 'text-emerald-500' : data.score > 0.4 ? 'text-amber-500' : 'text-red-500'}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold text-slate-200">{(data.score * 100).toFixed(1)}</span>
            <span className="text-[10px] text-slate-500">/ 100</span>
          </div>
        </div>
        <div className="flex-1 space-y-1">
          <div className="text-sm font-medium text-slate-300">适应度分解</div>
          <div className="text-xs text-slate-500">
            {data.passedTests} / {data.totalTests} 测试通过 · 覆盖率 {data.statementCoverage.toFixed(1)}%
            {data.tscPassed ? ' · tsc ✅' : ` · tsc ❌ (${data.tscErrors ?? '?'} 错误)`}
          </div>
        </div>
      </div>

      {/* Bar Chart */}
      <div className="space-y-3">
        {bars.map(bar => (
          <div key={bar.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">{bar.label}</span>
              <span className="text-slate-300 font-medium">
                {bar.max === 1
                  ? bar.label === 'TypeScript'
                    ? bar.value
                      ? 'PASS'
                      : 'FAIL'
                    : (bar.value * 100).toFixed(1) + '%'
                  : bar.value.toFixed(1) + (bar.unit || '')}
              </span>
            </div>
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${bar.color}`}
                style={{ width: `${(bar.value / bar.max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Archive Tab
// ═══════════════════════════════════════

function ArchiveTab({ archive, onRefresh }: { archive: ArchiveEntry[]; onRefresh: () => void }) {
  if (archive.length === 0) {
    return (
      <div className="text-center py-20 text-slate-500">
        <div className="text-4xl mb-4">🧬</div>
        <p>尚无进化记录</p>
        <p className="text-xs mt-1">第一次进化迭代完成后将显示在此</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-300">进化历史 ({archive.length})</span>
        <button onClick={onRefresh} className="text-xs text-slate-500 hover:text-slate-300 transition">
          刷新
        </button>
      </div>
      {archive.map(entry => {
        const score = entry.fitness_score ?? entry.fitnessScore ?? 0;
        const statusIcon =
          entry.status === 'merged'
            ? '✅'
            : entry.status === 'rejected'
              ? '❌'
              : entry.status === 'rolledback'
                ? '↩️'
                : '🔄';
        let files: string[] = [];
        try {
          files = entry.modified_files ? JSON.parse(entry.modified_files) : [];
        } catch {
          /* ignore */
        }

        return (
          <div
            key={entry.id}
            className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 hover:border-slate-700 transition"
          >
            <div className="flex items-start gap-3">
              <div className="text-lg mt-0.5">{statusIcon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-slate-200 truncate">
                    Gen {entry.generation}: {entry.description || entry.branch}
                  </span>
                  <span className="text-xs text-slate-500 shrink-0">
                    {new Date(entry.created_at).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span>
                    适应度{' '}
                    <span
                      className={score > 0.7 ? 'text-emerald-400' : score > 0.4 ? 'text-amber-400' : 'text-red-400'}
                    >
                      {score.toFixed(3)}
                    </span>
                  </span>
                  <span>分支 {entry.branch}</span>
                  {files.length > 0 && <span>{files.length} 文件变更</span>}
                </div>
                {files.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {files.slice(0, 5).map(f => (
                      <span key={f} className="px-1.5 py-0.5 bg-slate-800 rounded text-[10px] text-slate-400 font-mono">
                        {f.split('/').pop()}
                      </span>
                    ))}
                    {files.length > 5 && (
                      <span className="px-1.5 py-0.5 text-[10px] text-slate-600">+{files.length - 5} more</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════
// Memories Tab
// ═══════════════════════════════════════

function MemoriesTab({ memories, onRefresh }: { memories: MemoryEntry[]; onRefresh: () => void }) {
  if (memories.length === 0) {
    return (
      <div className="text-center py-20 text-slate-500">
        <div className="text-4xl mb-4">🧠</div>
        <p>尚无进化记忆</p>
        <p className="text-xs mt-1">进化迭代产生的成功/失败模式将记录在此</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-300">进化记忆 ({memories.length})</span>
        <button onClick={onRefresh} className="text-xs text-slate-500 hover:text-slate-300 transition">
          刷新
        </button>
      </div>
      {memories.map((mem, i) => (
        <div key={mem.id ?? i} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-sm ${mem.outcome === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
              {mem.outcome === 'success' ? '✅' : '❌'}
            </span>
            <span className="text-sm font-medium text-slate-200">{mem.pattern}</span>
            <span className="ml-auto text-[10px] text-slate-600">
              {new Date(mem.created_at).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
          <p className="text-xs text-slate-400 mb-2">{mem.description}</p>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            <span>
              模块 <span className="text-slate-400 font-mono">{mem.module}</span>
            </span>
            <span>
              影响{' '}
              <span
                className={
                  mem.fitness_impact > 0
                    ? 'text-emerald-400'
                    : mem.fitness_impact < 0
                      ? 'text-red-400'
                      : 'text-slate-400'
                }
              >
                {mem.fitness_impact > 0 ? '+' : ''}
                {mem.fitness_impact.toFixed(3)}
              </span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════
// Config Tab
// ═══════════════════════════════════════

function ConfigTab({
  config,
  immutable,
  loading,
  onVerify,
}: {
  config: Record<string, unknown> | null;
  immutable: ImmutableResult | null;
  loading: string | null;
  onVerify: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Immutable File Check */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-slate-300">🔒 不可变文件保护</span>
          <button
            onClick={onVerify}
            disabled={!!loading}
            className="px-3 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition disabled:opacity-50"
          >
            {loading === 'verify' ? '校验中...' : '校验完整性'}
          </button>
        </div>
        {immutable && (
          <div className="space-y-2">
            <div className={`text-sm ${immutable.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {immutable.ok ? '✅ 所有不可变文件完整' : `❌ ${immutable.violations.length} 个违规`}
            </div>
            {immutable.violations.length > 0 && (
              <ul className="space-y-1">
                {immutable.violations.map((v, i) => (
                  <li key={i} className="text-xs text-red-400 font-mono">
                    • {v}
                  </li>
                ))}
              </ul>
            )}
            {immutable.manifest && (
              <div className="mt-3">
                <div className="text-xs text-slate-500 mb-2">SHA256 哈希清单</div>
                <div className="space-y-1">
                  {Object.entries(immutable.manifest).map(([file, hash]) => (
                    <div key={file} className="flex items-center gap-2 text-[11px] font-mono">
                      <span className="text-emerald-400">🔐</span>
                      <span className="text-slate-400 truncate flex-1">{file}</span>
                      <span className="text-slate-600 shrink-0">{String(hash).slice(0, 12)}…</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Config JSON */}
      {config && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="text-sm font-medium text-slate-300 mb-3">⚙️ 进化配置</div>
          <pre className="text-[11px] text-slate-400 font-mono overflow-x-auto max-h-96 overflow-y-auto">
            {JSON.stringify(config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
