/**
 * ContextPage — 上下文资产管理器 (v2.0)
 *
 * 显示团队每位成员的上下文状态：
 * - 有快照时：展示完整的 Token 预算条、上下文模块卡片
 * - 无快照时：展示待机状态卡片
 * 条目数量始终与团队人数保持一致。
 */

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';

// ═══════════════════════════════════════
// Types (local definitions for TS)
// ═══════════════════════════════════════
interface ContextSection {
  id: string;
  name: string;
  source: string;
  tokens: number;
  chars: number;
  content: string;
  truncated?: boolean;
  files?: string[];
}

interface ContextSnapshot {
  agentId: string;
  totalTokens: number;
  tokenBudget: number;
  sections: ContextSection[];
  timestamp: number;
  filesIncluded?: number;
  featureId?: string;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  model?: string;
  capabilities?: string;
  system_prompt?: string;
  max_context_tokens?: number;
}

// ═══════════════════════════════════════
// 角色图标 & 颜色映射
// ═══════════════════════════════════════
const ROLE_META: Record<string, { icon: string; color: string; bgGlow: string }> = {
  pm:        { icon: '👔', color: 'text-violet-400',  bgGlow: 'from-violet-500/10' },
  architect: { icon: '🏗️', color: 'text-blue-400',    bgGlow: 'from-blue-500/10' },
  tech_lead: { icon: '🎯', color: 'text-indigo-400',  bgGlow: 'from-indigo-500/10' },
  developer: { icon: '💻', color: 'text-emerald-400', bgGlow: 'from-emerald-500/10' },
  qa:        { icon: '🔍', color: 'text-amber-400',   bgGlow: 'from-amber-500/10' },
  devops:    { icon: '🚀', color: 'text-cyan-400',    bgGlow: 'from-cyan-500/10' },
};
const DEFAULT_ROLE_META = { icon: '🤖', color: 'text-slate-400', bgGlow: 'from-slate-500/10' };

function getRoleMeta(role: string) {
  return ROLE_META[role] ?? DEFAULT_ROLE_META;
}

// ═══════════════════════════════════════
// Source 颜色映射
// ═══════════════════════════════════════
const SOURCE_COLORS: Record<string, { bg: string; bar: string; text: string; border: string }> = {
  'project-config': { bg: 'bg-violet-500/10', bar: 'bg-violet-500', text: 'text-violet-400', border: 'border-violet-500/30' },
  'architecture':   { bg: 'bg-blue-500/10',   bar: 'bg-blue-500',   text: 'text-blue-400',   border: 'border-blue-500/30' },
  'file-tree':      { bg: 'bg-emerald-500/10', bar: 'bg-emerald-500', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  'repo-map':       { bg: 'bg-amber-500/10',   bar: 'bg-amber-500',   text: 'text-amber-400',   border: 'border-amber-500/30' },
  'dependency':     { bg: 'bg-cyan-500/10',    bar: 'bg-cyan-500',    text: 'text-cyan-400',    border: 'border-cyan-500/30' },
  'keyword-match':  { bg: 'bg-pink-500/10',    bar: 'bg-pink-500',    text: 'text-pink-400',    border: 'border-pink-500/30' },
  'plan':           { bg: 'bg-orange-500/10',   bar: 'bg-orange-500',  text: 'text-orange-400',  border: 'border-orange-500/30' },
  'qa-feedback':    { bg: 'bg-red-500/10',     bar: 'bg-red-500',     text: 'text-red-400',     border: 'border-red-500/30' },
};
const DEFAULT_COLOR = { bg: 'bg-slate-500/10', bar: 'bg-slate-500', text: 'text-slate-400', border: 'border-slate-500/30' };
function getColor(source: string) { return SOURCE_COLORS[source] ?? DEFAULT_COLOR; }

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatBytes(chars: number): string {
  if (chars >= 1024 * 1024) return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
  if (chars >= 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${chars} B`;
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

// ═══════════════════════════════════════
// TokenBudgetBar — 堆叠条形图
// ═══════════════════════════════════════
function TokenBudgetBar({ snapshot }: { snapshot: ContextSnapshot }) {
  const usedRatio = Math.min(snapshot.totalTokens / snapshot.tokenBudget, 1);
  const isOverBudget = snapshot.totalTokens > snapshot.tokenBudget;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">
          Token 预算: <span className={isOverBudget ? 'text-red-400 font-bold' : 'text-slate-200'}>
            {formatTokens(snapshot.totalTokens)}
          </span>
          {' / '}
          {formatTokens(snapshot.tokenBudget)}
        </span>
        <span className={`font-mono ${isOverBudget ? 'text-red-400' : usedRatio > 0.8 ? 'text-amber-400' : 'text-emerald-400'}`}>
          {(usedRatio * 100).toFixed(0)}%
        </span>
      </div>

      <div className="relative h-6 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
        <div className="absolute inset-0 flex">
          {snapshot.sections.map((sec) => {
            const width = (sec.tokens / snapshot.tokenBudget) * 100;
            if (width < 0.5) return null;
            const color = getColor(sec.source);
            return (
              <div
                key={sec.id}
                className={`${color.bar} h-full transition-all duration-500 relative group`}
                style={{ width: `${Math.min(width, 100)}%` }}
                title={`${sec.name}: ${formatTokens(sec.tokens)} tokens (${width.toFixed(1)}%)`}
              >
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-50">
                  <div className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] whitespace-nowrap shadow-xl">
                    <span className="font-medium">{sec.name}</span>
                    <br />
                    {formatTokens(sec.tokens)} tokens · {width.toFixed(1)}%
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {isOverBudget && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10" style={{ left: `${(1 / usedRatio) * 100}%` }} />
        )}
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {snapshot.sections.map(sec => {
          const color = getColor(sec.source);
          return (
            <div key={sec.id} className="flex items-center gap-1 text-[10px]">
              <div className={`w-2 h-2 rounded-sm ${color.bar}`} />
              <span className="text-slate-400">{sec.name}</span>
              <span className={`${color.text} font-mono`}>{formatTokens(sec.tokens)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// ContextSectionCard — 可展开/折叠的模块卡片
// ═══════════════════════════════════════
function ContextSectionCard({ section, tokenBudget }: { section: ContextSection; tokenBudget: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = getColor(section.source);
  const ratio = (section.tokens / tokenBudget * 100).toFixed(1);

  return (
    <div className={`rounded-lg border ${color.border} ${color.bg} overflow-hidden transition-all`}>
      <button
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-lg">{expanded ? '▼' : '▶'}</span>
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${color.text}`}>{section.name}</span>
            {section.truncated && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">截断</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {section.source} · {section.files?.length ? `${section.files.length} 文件` : '内联'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs font-mono text-slate-300">{formatTokens(section.tokens)} <span className="text-slate-500">tokens</span></div>
          <div className="text-[10px] text-slate-500">{formatBytes(section.chars)} · {ratio}%</div>
        </div>
        <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden shrink-0">
          <div className={`h-full ${color.bar} transition-all duration-300`} style={{ width: `${Math.min(parseFloat(ratio), 100)}%` }} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800">
          {section.files && section.files.length > 0 && (
            <div className="px-4 py-2 border-b border-slate-800/50">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">包含文件</div>
              <div className="flex flex-wrap gap-1">
                {section.files.map(f => (
                  <span key={f} className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">{f}</span>
                ))}
              </div>
            </div>
          )}
          <div className="px-4 py-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">内容预览</div>
            <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto bg-slate-900/50 rounded p-3 border border-slate-800 leading-relaxed">
              {section.content.length > 5000 ? section.content.slice(0, 5000) + '\n\n... [显示截断至 5000 字符]' : section.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// MemberContextCard — 单个团队成员的上下文面板
// ═══════════════════════════════════════
function MemberContextCard({ member, snapshot, isSelected, onSelect }: {
  member: TeamMember;
  snapshot: ContextSnapshot | null;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const meta = getRoleMeta(member.role);
  const caps = (() => { try { return JSON.parse(member.capabilities || '[]'); } catch { return []; } })();

  return (
    <div
      className={`rounded-xl border transition-all cursor-pointer ${
        isSelected
          ? 'border-forge-500/50 bg-forge-500/5 ring-1 ring-forge-500/20'
          : 'border-slate-800 bg-slate-900/30 hover:border-slate-700 hover:bg-slate-900/50'
      }`}
      onClick={onSelect}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          {/* 头像区 */}
          <div className={`w-8 h-8 rounded-lg bg-gradient-to-br ${meta.bgGlow} to-transparent flex items-center justify-center text-base border border-slate-700/50 shrink-0`}>
            {meta.icon}
          </div>
          {/* 基本信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`font-medium text-xs ${meta.color} truncate`}>{member.name}</span>
              <span className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500 uppercase shrink-0">{member.role}</span>
            </div>
            <div className="flex gap-1 mt-0.5 overflow-hidden">
              {caps.slice(0, 2).map((c: string) => (
                <span key={c} className="text-[9px] px-1 py-0.5 rounded bg-slate-800/50 text-slate-500 truncate">{c}</span>
              ))}
              {caps.length > 2 && <span className="text-[9px] text-slate-600">+{caps.length - 2}</span>}
            </div>
          </div>
          {/* 状态指示 */}
          <div className="shrink-0">
            {snapshot ? (
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[10px] text-emerald-400 font-mono">{formatTokens(snapshot.totalTokens)}</span>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />
                <span className="text-[10px] text-slate-500">待机</span>
              </div>
            )}
          </div>
        </div>

        {/* 迷你进度条 (只在有快照时显示) */}
        {snapshot && (
          <div className="mt-1.5 ml-[42px]">
            <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="flex h-full">
                {snapshot.sections.map(sec => {
                  const width = (sec.tokens / snapshot.tokenBudget) * 100;
                  if (width < 0.3) return null;
                  return (
                    <div key={sec.id} className={`${getColor(sec.source).bar} h-full`} style={{ width: `${width}%` }} />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// StandbyPanel — 成员待机状态详情
// ═══════════════════════════════════════
function StandbyPanel({ member }: { member: TeamMember }) {
  const meta = getRoleMeta(member.role);
  const caps = (() => { try { return JSON.parse(member.capabilities || '[]'); } catch { return []; } })();

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col items-center justify-center gap-6">
      <div className={`w-24 h-24 rounded-2xl bg-gradient-to-br ${meta.bgGlow} to-transparent flex items-center justify-center text-5xl border border-slate-700/30`}>
        {meta.icon}
      </div>
      <div className="text-center">
        <h2 className={`text-xl font-bold ${meta.color}`}>{member.name}</h2>
        <p className="text-sm text-slate-500 mt-1">{member.role.toUpperCase()} · 待机中</p>
      </div>
      <div className="max-w-md w-full space-y-4">
        <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">能力标签</div>
          <div className="flex flex-wrap gap-2">
            {caps.map((c: string) => (
              <span key={c} className={`text-xs px-2.5 py-1 rounded-lg border border-slate-700 ${meta.color} bg-slate-800/50`}>{c}</span>
            ))}
          </div>
        </div>
        <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">上下文配额</div>
          <div className="text-2xl font-bold text-slate-300 font-mono">{formatTokens(member.max_context_tokens ?? 128000)}</div>
          <div className="text-xs text-slate-500 mt-1">最大上下文 token 数</div>
        </div>
        <div className="text-center text-sm text-slate-600 py-4">
          🔮 当任务分配到此成员时，上下文将自动填充
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// ContextPage — 主页面
// ═══════════════════════════════════════
export function ContextPage() {
  const { currentProjectId, contextSnapshots } = useAppStore();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 加载团队成员
  useEffect(() => {
    if (!currentProjectId) return;
    window.agentforge.team.list(currentProjectId).then(data => {
      setMembers((data || []) as TeamMember[]);
    }).catch(() => {});
  }, [currentProjectId]);

  // 从后端拉取缓存的快照
  useEffect(() => {
    if (!currentProjectId) return;
    setLoading(true);
    window.agentforge.project.getContextSnapshots(currentProjectId).then(data => {
      const store = useAppStore.getState();
      for (const [, snap] of Object.entries(data)) {
        store.updateContextSnapshot(snap as ContextSnapshot);
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [currentProjectId]);

  // 按角色排序: pm → architect → tech_lead → developer → qa → devops → 其他
  const ROLE_ORDER = ['pm', 'architect', 'tech_lead', 'developer', 'qa', 'devops'];
  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const ia = ROLE_ORDER.indexOf(a.role);
      const ib = ROLE_ORDER.indexOf(b.role);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [members]);

  // 选中的成员
  const selected = sortedMembers.find(m => m.id === selectedMemberId) ?? sortedMembers[0] ?? null;
  // 尝试匹配 context snapshot — snapshot 的 agentId 可能是成员名或成员id
  const selectedSnapshot = useMemo(() => {
    if (!selected) return null;
    // 1. 精确匹配 member.id
    if (contextSnapshots.has(selected.id)) return contextSnapshots.get(selected.id)!;
    // 2. 按名称匹配
    if (contextSnapshots.has(selected.name)) return contextSnapshots.get(selected.name)!;
    // 3. 模糊匹配: 遍历所有快照找 agentId 含有成员名
    for (const [aid, snap] of contextSnapshots) {
      if (aid.includes(selected.name) || aid.includes(selected.role)) return snap;
    }
    return null;
  }, [selected, contextSnapshots]);

  // 统计
  const totalActive = useMemo(() => {
    let count = 0;
    for (const m of sortedMembers) {
      if (contextSnapshots.has(m.id) || contextSnapshots.has(m.name)) count++;
      else {
        for (const [aid] of contextSnapshots) {
          if (aid.includes(m.name) || aid.includes(m.role)) { count++; break; }
        }
      }
    }
    return count;
  }, [sortedMembers, contextSnapshots]);

  const totalTokens = useMemo(() => {
    let sum = 0;
    for (const [, snap] of contextSnapshots) sum += snap.totalTokens;
    return sum;
  }, [contextSnapshots]);

  // 空状态
  if (!currentProjectId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500">
        请先选择一个项目
      </div>
    );
  }

  if (members.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-500">
        <div className="text-5xl">🧠</div>
        <div className="text-lg font-medium text-slate-400">上下文资产管理器</div>
        <div className="text-sm text-center max-w-md">
          当项目创建团队后，这里会展示每位成员的上下文状态。
          <br />
          <span className="text-slate-600">就像游戏性能 Profiler 一样，帮你理解和优化 LLM 的"内存"使用。</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-100">🧠 上下文资产管理器</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              团队 {members.length} 人 · {totalActive} 人活跃 · 总 Token: {formatTokens(totalTokens)}
            </p>
          </div>
          {selectedSnapshot && (
            <div className="flex gap-4 text-xs">
              <div className="text-center">
                <div className="text-slate-400">模块数</div>
                <div className="text-lg font-bold text-slate-200">{selectedSnapshot.sections.length}</div>
              </div>
              <div className="text-center">
                <div className="text-slate-400">Tokens</div>
                <div className="text-lg font-bold text-slate-200">{formatTokens(selectedSnapshot.totalTokens)}</div>
              </div>
              <div className="text-center">
                <div className="text-slate-400">文件数</div>
                <div className="text-lg font-bold text-slate-200">{selectedSnapshot.filesIncluded}</div>
              </div>
              <div className="text-center">
                <div className="text-slate-400">快照</div>
                <div className="text-sm font-mono text-slate-400">{timeAgo(selectedSnapshot.timestamp)}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 左侧: 团队成员列表 */}
        <div className="w-72 shrink-0 border-r border-slate-800 overflow-y-auto p-2 space-y-1">
          {sortedMembers.map(member => {
            // 查找匹配快照
            let snap: ContextSnapshot | null = null;
            if (contextSnapshots.has(member.id)) snap = contextSnapshots.get(member.id)!;
            else if (contextSnapshots.has(member.name)) snap = contextSnapshots.get(member.name)!;
            else {
              for (const [aid, s] of contextSnapshots) {
                if (aid.includes(member.name) || aid.includes(member.role)) { snap = s; break; }
              }
            }
            return (
              <MemberContextCard
                key={member.id}
                member={member}
                snapshot={snap}
                isSelected={selected?.id === member.id}
                onSelect={() => setSelectedMemberId(member.id)}
              />
            );
          })}
        </div>

        {/* 右侧: 选中成员的详情 */}
        {selected && selectedSnapshot ? (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            {/* Token 预算条 */}
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
              <TokenBudgetBar snapshot={selectedSnapshot} />
            </div>

            {/* Feature 信息 */}
            <div className="bg-slate-900/30 rounded-lg border border-slate-800 px-4 py-3">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">当前任务</div>
              <div className="text-sm text-slate-300 mt-1">
                <span className="font-mono text-forge-400">{selectedSnapshot.featureId}</span>
                <span className="mx-2 text-slate-600">·</span>
                Agent: <span className="font-mono text-emerald-400">{selectedSnapshot.agentId}</span>
              </div>
            </div>

            {/* 模块卡片列表 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-slate-300">上下文模块 ({selectedSnapshot.sections.length})</h2>
                <span className="text-[10px] text-slate-500">按注入顺序排列 · 点击展开查看内容</span>
              </div>
              {selectedSnapshot.sections.map((sec: ContextSection) => (
                <ContextSectionCard key={sec.id} section={sec} tokenBudget={selectedSnapshot.tokenBudget} />
              ))}
            </div>
          </div>
        ) : selected ? (
          <StandbyPanel member={selected} />
        ) : null}
      </div>
    </div>
  );
}