/**
 * ContextPage — 上下文资产管理器 (v2.0)
 *
 * 显示团队每位成员的上下文状态：
 * - 有快照时：展示完整的 Token 预算条、上下文模块卡片
 * - 无快照时：展示待机状态卡片
 * 条目数量始终与团队人数保持一致。
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/app-store';
import { toast } from '../stores/toast-store';

// Types: ContextSection, ContextSnapshot, TeamMember are global (src/types/api.d.ts)

// ═══════════════════════════════════════
// 角色图标 & 颜色映射
// ═══════════════════════════════════════
const ROLE_META: Record<string, { icon: string; color: string; bgGlow: string }> = {
  'meta-agent': { icon: '🤖', color: 'text-forge-400', bgGlow: 'from-forge-500/10' },
  pm: { icon: '👔', color: 'text-violet-400', bgGlow: 'from-violet-500/10' },
  architect: { icon: '🏗️', color: 'text-blue-400', bgGlow: 'from-blue-500/10' },
  tech_lead: { icon: '🎯', color: 'text-indigo-400', bgGlow: 'from-indigo-500/10' },
  developer: { icon: '💻', color: 'text-emerald-400', bgGlow: 'from-emerald-500/10' },
  qa: { icon: '🔍', color: 'text-amber-400', bgGlow: 'from-amber-500/10' },
  devops: { icon: '🚀', color: 'text-cyan-400', bgGlow: 'from-cyan-500/10' },
};

const META_AGENT_MEMBER_ID = '__meta-agent__';
const DEFAULT_ROLE_META = { icon: '🤖', color: 'text-slate-400', bgGlow: 'from-slate-500/10' };

function getRoleMeta(role: string) {
  return ROLE_META[role] ?? DEFAULT_ROLE_META;
}

// ═══════════════════════════════════════
// Source 颜色映射
// ═══════════════════════════════════════
const SOURCE_COLORS: Record<string, { bg: string; bar: string; text: string; border: string }> = {
  'project-config': {
    bg: 'bg-violet-500/10',
    bar: 'bg-violet-500',
    text: 'text-violet-400',
    border: 'border-violet-500/30',
  },
  architecture: { bg: 'bg-blue-500/10', bar: 'bg-blue-500', text: 'text-blue-400', border: 'border-blue-500/30' },
  'file-tree': {
    bg: 'bg-emerald-500/10',
    bar: 'bg-emerald-500',
    text: 'text-emerald-400',
    border: 'border-emerald-500/30',
  },
  'repo-map': { bg: 'bg-amber-500/10', bar: 'bg-amber-500', text: 'text-amber-400', border: 'border-amber-500/30' },
  dependency: { bg: 'bg-cyan-500/10', bar: 'bg-cyan-500', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  'keyword-match': { bg: 'bg-pink-500/10', bar: 'bg-pink-500', text: 'text-pink-400', border: 'border-pink-500/30' },
  plan: { bg: 'bg-orange-500/10', bar: 'bg-orange-500', text: 'text-orange-400', border: 'border-orange-500/30' },
  'qa-feedback': { bg: 'bg-red-500/10', bar: 'bg-red-500', text: 'text-red-400', border: 'border-red-500/30' },
};
const DEFAULT_COLOR = {
  bg: 'bg-slate-500/10',
  bar: 'bg-slate-500',
  text: 'text-slate-400',
  border: 'border-slate-500/30',
};
function getColor(source: string) {
  return SOURCE_COLORS[source] ?? DEFAULT_COLOR;
}

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
          Token 预算:{' '}
          <span className={isOverBudget ? 'text-red-400 font-bold' : 'text-slate-200'}>
            {formatTokens(snapshot.totalTokens)}
          </span>
          {' / '}
          {formatTokens(snapshot.tokenBudget)}
        </span>
        <span
          className={`font-mono ${isOverBudget ? 'text-red-400' : usedRatio > 0.8 ? 'text-amber-400' : 'text-emerald-400'}`}
        >
          {(usedRatio * 100).toFixed(0)}%
        </span>
      </div>

      <div className="relative h-6 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
        <div className="absolute inset-0 flex">
          {snapshot.sections.map(sec => {
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
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
            style={{ left: `${(1 / usedRatio) * 100}%` }}
          />
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
// ContextSectionCard — 模块卡片（点击选中，不再内联展开）
// ═══════════════════════════════════════
function ContextSectionCard({
  section,
  tokenBudget,
  isActive,
  onSelect,
}: {
  section: ContextSection;
  tokenBudget: number;
  isActive?: boolean;
  onSelect?: () => void;
}) {
  const color = getColor(section.source);
  const ratio = ((section.tokens / tokenBudget) * 100).toFixed(1);

  return (
    <div
      className={`rounded-lg border ${isActive ? 'border-cyan-500/50 bg-cyan-500/5 ring-1 ring-cyan-500/20' : `${color.border} ${color.bg}`} overflow-hidden transition-all cursor-pointer hover:bg-white/5`}
      onClick={onSelect}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <span className="text-lg text-slate-500">{isActive ? '◆' : '▶'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${isActive ? 'text-cyan-400' : color.text} truncate`}>
              {section.name}
            </span>
            {section.truncated && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium shrink-0">
                截断
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {section.source} · {section.files?.length ? `${section.files.length} 文件` : '内联'}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs font-mono text-slate-300">
            {formatTokens(section.tokens)} <span className="text-slate-500">tokens</span>
          </div>
          <div className="text-[10px] text-slate-500">
            {formatBytes(section.chars)} · {ratio}%
          </div>
        </div>
        <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden shrink-0">
          <div
            className={`h-full ${color.bar} transition-all duration-300`}
            style={{ width: `${Math.min(parseFloat(ratio), 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// ContentPreviewPanel — 右侧内容预览面板
// ═══════════════════════════════════════
function ContentPreviewPanel({ section }: { section: ContextSection }) {
  const color = getColor(section.source);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 标题栏 */}
      <div className={`px-4 py-3 border-b border-slate-800 shrink-0 ${color.bg}`}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-sm ${color.bar}`} />
          <span className={`text-sm font-medium ${color.text}`}>{section.name}</span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
          <span>{section.source}</span>
          <span>{formatTokens(section.tokens)} tokens</span>
          <span>{formatBytes(section.chars)}</span>
          {section.truncated && <span className="text-amber-400">⚠ 截断</span>}
        </div>
      </div>

      {/* 文件列表（如有） */}
      {section.files && section.files.length > 0 && (
        <div className="px-4 py-2 border-b border-slate-800/50 shrink-0">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
            包含文件 ({section.files.length})
          </div>
          <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
            {section.files.map(f => (
              <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 内容预览 */}
      <div className="flex-1 overflow-y-auto p-4">
        <pre className="text-[11px] text-slate-400 font-mono whitespace-pre-wrap break-all leading-relaxed">
          {section.content || '(无内容)'}
        </pre>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// MemberContextCard — 单个团队成员的上下文面板
// ═══════════════════════════════════════
function MemberContextCard({
  member,
  snapshot,
  agentStatus,
  isSelected,
  onSelect,
}: {
  member: TeamMember;
  snapshot: ContextSnapshot | null;
  agentStatus?: { status: string; currentTask: string | null; featureTitle?: string } | null;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const meta = getRoleMeta(member.role);
  const caps = (() => {
    try {
      return JSON.parse(member.capabilities || '[]');
    } catch {
      return [];
    }
  })();
  const isWorking = agentStatus?.status === 'working';

  return (
    <div
      className={`rounded-xl border transition-all cursor-pointer ${
        isSelected
          ? 'border-forge-500/50 bg-forge-500/5 ring-1 ring-forge-500/20'
          : isWorking
            ? 'border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-400/50'
            : 'border-slate-800 bg-slate-900/30 hover:border-slate-700 hover:bg-slate-900/50'
      }`}
      onClick={onSelect}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          {/* 头像区 */}
          <div
            className={`w-8 h-8 rounded-lg bg-gradient-to-br ${meta.bgGlow} to-transparent flex items-center justify-center text-base border border-slate-700/50 shrink-0 ${isWorking ? 'ring-1 ring-emerald-500/30' : ''}`}
          >
            {meta.icon}
          </div>
          {/* 基本信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`font-medium text-xs ${meta.color} truncate`}>{member.name}</span>
              <span className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-500 uppercase shrink-0">
                {member.role}
              </span>
            </div>
            {isWorking && agentStatus.featureTitle ? (
              <div className="text-[9px] text-emerald-400 truncate mt-0.5">🔨 {agentStatus.featureTitle}</div>
            ) : (
              <div className="flex gap-1 mt-0.5 overflow-hidden">
                {caps.slice(0, 2).map((c: string) => (
                  <span key={c} className="text-[9px] px-1 py-0.5 rounded bg-slate-800/50 text-slate-500 truncate">
                    {c}
                  </span>
                ))}
                {caps.length > 2 && <span className="text-[9px] text-slate-600">+{caps.length - 2}</span>}
              </div>
            )}
          </div>
          {/* 状态指示 */}
          <div className="shrink-0">
            {isWorking ? (
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[10px] text-emerald-400 font-medium">工作中</span>
              </div>
            ) : snapshot ? (
              <div className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                <span className="text-[10px] text-blue-400 font-mono">{formatTokens(snapshot.totalTokens)}</span>
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
// MetaAgentBaselinePanel — 管家 Agent 的上下文配置预览
// ═══════════════════════════════════════
function MetaAgentBaselinePanel() {
  const meta = getRoleMeta('meta-agent');
  const [config, setConfig] = useState<MetaAgentConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.automater.metaAgent
      .getConfig()
      .then(c => setConfig(c))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const budget = config?.contextTokenLimit || 512000;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {/* 成员信息头 */}
      <div className="flex items-center gap-3">
        <div
          className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.bgGlow} to-transparent flex items-center justify-center text-2xl border border-slate-700/30`}
        >
          {meta.icon}
        </div>
        <div>
          <h2 className={`text-base font-bold ${meta.color}`}>{config?.name || '元Agent · 管家'}</h2>
          <p className="text-[10px] text-slate-500">META-AGENT · 全局管家 · 上下文配置概览</p>
        </div>
      </div>

      {loading && (
        <div className="text-center text-sm text-slate-500 py-4">
          <div className="inline-block w-4 h-4 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin mr-2" />
          正在加载管家配置...
        </div>
      )}

      {config && (
        <>
          {/* Token 预算概览 */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">
                上下文 Token 上限: <span className="text-slate-200 font-mono">{formatTokens(budget)}</span>
              </span>
              <span className="text-[10px] text-slate-500">管家对话使用独立上下文窗口</span>
            </div>
            <div className="h-5 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
              <div className="h-full bg-forge-500/30" style={{ width: '0%' }} />
            </div>
            <div className="text-[10px] text-slate-500">管家当前待机，无活跃上下文快照。发起对话后将产生快照。</div>
          </div>

          {/* 配置详情 */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-slate-300">上下文配置参数</h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Token 上限', value: formatTokens(config.contextTokenLimit) },
                { label: '历史消息条数', value: String(config.contextHistoryLimit) },
                { label: '最大回复 Token', value: formatTokens(config.maxResponseTokens) },
                { label: 'ReAct 最大轮次', value: String(config.maxReactIterations) },
                { label: '记忆注入条数', value: String(config.memoryInjectLimit) },
                { label: 'read_file 行数上限', value: String(config.readFileLineLimit) },
              ].map(item => (
                <div key={item.label} className="bg-slate-900/30 rounded-lg border border-slate-800 px-3 py-2">
                  <div className="text-[10px] text-slate-500">{item.label}</div>
                  <div className="text-xs font-mono text-slate-200 mt-0.5">{item.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 模式配置 */}
          {config.modeConfigs && Object.keys(config.modeConfigs).length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-slate-300">模式覆盖配置</h3>
              {Object.entries(config.modeConfigs).map(([mode, mc]) => (
                <div key={mode} className="bg-slate-900/30 rounded-lg border border-slate-800 px-3 py-2">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">
                    {mode === 'chat' ? '💬 闲聊' : mode === 'deep' ? '🔬 深度' : mode === 'admin' ? '⚙️ 管理' : mode}
                  </div>
                  <div className="flex gap-3 flex-wrap text-[10px]">
                    {mc.maxReactIterations !== undefined && (
                      <span className="text-slate-400">
                        轮次: <span className="text-slate-200 font-mono">{mc.maxReactIterations}</span>
                      </span>
                    )}
                    {mc.contextHistoryLimit !== undefined && (
                      <span className="text-slate-400">
                        历史: <span className="text-slate-200 font-mono">{mc.contextHistoryLimit}条</span>
                      </span>
                    )}
                    {mc.maxResponseTokens !== undefined && (
                      <span className="text-slate-400">
                        回复: <span className="text-slate-200 font-mono">{formatTokens(mc.maxResponseTokens)}</span>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 其他标志 */}
          <div className="flex flex-wrap gap-2 text-[10px]">
            <span
              className={`px-2 py-1 rounded-lg border ${config.autoMemory ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800/50 text-slate-500'}`}
            >
              {config.autoMemory ? '✅' : '❌'} 自动记忆
            </span>
            <span
              className={`px-2 py-1 rounded-lg border ${config.allowGitAccess ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800/50 text-slate-500'}`}
            >
              {config.allowGitAccess ? '✅' : '❌'} Git 访问
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// BaselinePanel — 待机时展示基线上下文预览（可展开查看内容）
// ═══════════════════════════════════════
function BaselinePanel({ member, projectId }: { member: TeamMember; projectId: string }) {
  const meta = getRoleMeta(member.role);
  const [baseline, setBaseline] = useState<ContextSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ContextSection | null>(null);

  // 加载基线上下文
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    const budget = member.max_context_tokens ?? 128000;
    window.automater.context
      .previewBaseline(projectId, member.role, budget)
      .then((res: { success: boolean; snapshot?: ContextSnapshot; error?: string }) => {
        if (res.success && res.snapshot) {
          setBaseline(res.snapshot);
        } else {
          setError(res.error || '加载失败');
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId, member.id, member.role, member.max_context_tokens]);

  const budget = member.max_context_tokens ?? 128000;
  const used = baseline?.totalTokens ?? 0;
  const remaining = budget - used;
  const usedRatio = budget > 0 ? used / budget : 0;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* 模块列表列 */}
      <div
        className={`${preview ? 'w-1/2' : 'flex-1'} overflow-y-auto px-4 py-4 space-y-4 border-r border-slate-800/50 transition-all`}
      >
        {/* 成员信息头 */}
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.bgGlow} to-transparent flex items-center justify-center text-2xl border border-slate-700/30`}
          >
            {meta.icon}
          </div>
          <div>
            <h2 className={`text-base font-bold ${meta.color}`}>{member.name}</h2>
            <p className="text-[10px] text-slate-500">{member.role.toUpperCase()} · 待机中 · 基线上下文预览</p>
          </div>
        </div>

        {/* 容量概览 */}
        <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">
              基线占用: <span className="text-slate-200 font-mono">{formatTokens(used)}</span>
              {' / '}
              <span className="font-mono">{formatTokens(budget)}</span>
            </span>
            <span className={`font-mono ${usedRatio > 0.5 ? 'text-amber-400' : 'text-emerald-400'}`}>
              剩余 {formatTokens(remaining)} ({((1 - usedRatio) * 100).toFixed(0)}%)
            </span>
          </div>
          <div className="relative h-5 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
            <div className="absolute inset-0 flex">
              {baseline?.sections.map(sec => {
                const width = (sec.tokens / budget) * 100;
                if (width < 0.3) return null;
                const color = getColor(sec.source);
                return (
                  <div
                    key={sec.id}
                    className={`${color.bar} h-full relative group`}
                    style={{ width: `${Math.min(width, 100)}%` }}
                    title={`${sec.name}: ${formatTokens(sec.tokens)} tokens`}
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
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {baseline?.sections.map(sec => {
              const color = getColor(sec.source);
              return (
                <div key={sec.id} className="flex items-center gap-1 text-[10px]">
                  <div className={`w-2 h-2 rounded-sm ${color.bar}`} />
                  <span className="text-slate-400">{sec.name}</span>
                  <span className={`${color.text} font-mono`}>{formatTokens(sec.tokens)}</span>
                </div>
              );
            })}
            <div className="flex items-center gap-1 text-[10px]">
              <div className="w-2 h-2 rounded-sm bg-slate-700" />
              <span className="text-slate-500">可用空间</span>
              <span className="text-slate-400 font-mono">{formatTokens(remaining)}</span>
            </div>
          </div>
        </div>

        {/* 加载中/错误 */}
        {loading && (
          <div className="text-center text-sm text-slate-500 py-4">
            <div className="inline-block w-4 h-4 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin mr-2" />
            正在计算基线上下文...
          </div>
        )}
        {error && <div className="text-center text-sm text-red-400 py-4">❌ {error}</div>}

        {/* 基线上下文模块列表 */}
        {baseline && baseline.sections.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-slate-300">固定加载模块 ({baseline.sections.length})</h3>
              <span className="text-[10px] text-slate-500">任务分配前已固定占用 · 点击查看内容</span>
            </div>
            {baseline.sections.map((sec: ContextSection) => (
              <ContextSectionCard
                key={sec.id}
                section={sec}
                tokenBudget={budget}
                isActive={preview?.id === sec.id}
                onSelect={() => setPreview(preview?.id === sec.id ? null : sec)}
              />
            ))}
          </div>
        )}

        {/* 空项目提示 */}
        {baseline && baseline.sections.length === 0 && !loading && (
          <div className="text-center text-sm text-slate-600 py-8">
            📭 项目工作区暂无上下文资源（未检测到架构文档、代码文件等）
          </div>
        )}
      </div>

      {/* 右侧: 内容预览面板 */}
      {preview && (
        <div className="w-1/2 overflow-hidden flex flex-col bg-slate-950/50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">内容预览</span>
            <button
              onClick={() => setPreview(null)}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-1.5 py-0.5 rounded hover:bg-slate-800"
            >
              ✕
            </button>
          </div>
          <ContentPreviewPanel section={preview} />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════
// Agent status matching helper
// ═══════════════════════════════════════
function findAgentStatusForMember(
  member: TeamMember,
  agentStatuses: Map<string, { status: string; currentTask: string | null; featureTitle?: string }>,
) {
  // Match by role prefix: pm-xxx → pm, arch-xxx → architect, dev-xxx → developer, qa-xxx → qa
  const rolePrefixes: Record<string, string[]> = {
    'meta-agent': ['meta-agent'],
    pm: ['pm-'],
    architect: ['arch-'],
    developer: ['dev-'],
    qa: ['qa-'],
    devops: ['devops-'],
    reviewer: ['review-'],
  };
  const prefixes = rolePrefixes[member.role] || [];
  for (const [agentId, status] of agentStatuses) {
    if (prefixes.some(p => agentId.startsWith(p)) && status.status === 'working') {
      return status;
    }
  }
  return null;
}

// ═══════════════════════════════════════
// ContextPage — 主页面
// ═══════════════════════════════════════
export function ContextPage() {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const contextSnapshots = useAppStore(s => s.contextSnapshots);
  const agentStatuses = useAppStore(s => s.agentStatuses);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [previewSection, setPreviewSection] = useState<ContextSection | null>(null);
  const [loading, setLoading] = useState(false);

  // 加载团队成员
  useEffect(() => {
    if (!currentProjectId) return;
    window.automater.team
      .list(currentProjectId)
      .then(data => {
        setMembers((data || []) as TeamMember[]);
      })
      .catch(() => {});
  }, [currentProjectId]);

  // 从后端拉取缓存的快照
  useEffect(() => {
    if (!currentProjectId) return;
    setLoading(true);
    window.automater.project
      .getContextSnapshots(currentProjectId)
      .then(data => {
        const store = useAppStore.getState();
        for (const [, snap] of Object.entries(data)) {
          store.updateContextSnapshot(currentProjectId, snap as ContextSnapshot);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentProjectId]);

  // 虚拟管家成员 — 始终在最前面
  const metaAgentVirtualMember: TeamMember = useMemo(
    () => ({
      id: META_AGENT_MEMBER_ID,
      project_id: currentProjectId || '',
      role: 'meta-agent',
      name: '元Agent · 管家',
      model: null,
      capabilities: JSON.stringify(['对话', '工具调用', '记忆', '需求创建']),
      system_prompt: null,
      context_files: '[]',
      max_context_tokens: 512000,
      created_at: '',
      llm_config: null,
      mcp_servers: null,
      skills: null,
      max_iterations: null,
    }),
    [currentProjectId],
  );

  // 按角色排序: pm → architect → tech_lead → developer → qa → devops → 其他
  const sortedMembers = useMemo(() => {
    const ROLE_ORDER = ['pm', 'architect', 'tech_lead', 'developer', 'qa', 'devops'];
    const sorted = [...members].sort((a, b) => {
      const ia = ROLE_ORDER.indexOf(a.role);
      const ib = ROLE_ORDER.indexOf(b.role);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    // 管家 agent 始终在最前面
    return [metaAgentVirtualMember, ...sorted];
  }, [members, metaAgentVirtualMember]);

  // 选中的成员
  const selected = sortedMembers.find(m => m.id === selectedMemberId) ?? sortedMembers[0] ?? null;
  const isMetaAgentSelected = selected?.id === META_AGENT_MEMBER_ID;
  // 尝试匹配 context snapshot — snapshot 的 agentId 可能是成员名或成员id
  const selectedSnapshot = useMemo(() => {
    if (!selected) return null;
    // 管家 agent: 按 'meta-agent' 前缀匹配
    if (isMetaAgentSelected) {
      if (contextSnapshots.has('meta-agent')) return contextSnapshots.get('meta-agent');
      for (const [aid, snap] of contextSnapshots) {
        if (aid.startsWith('meta-agent')) return snap;
      }
      return null;
    }
    // 1. 精确匹配 member.id
    if (contextSnapshots.has(selected.id)) return contextSnapshots.get(selected.id);
    // 2. 按名称匹配
    if (contextSnapshots.has(selected.name)) return contextSnapshots.get(selected.name);
    // 3. 模糊匹配: 遍历所有快照找 agentId 含有成员名
    for (const [aid, snap] of contextSnapshots) {
      if (aid.includes(selected.name) || aid.includes(selected.role)) return snap;
    }
    return null;
  }, [selected, isMetaAgentSelected, contextSnapshots]);

  // 统计
  const totalActive = useMemo(() => {
    let count = 0;
    for (const m of sortedMembers) {
      if (contextSnapshots.has(m.id) || contextSnapshots.has(m.name)) count++;
      else {
        for (const [aid] of contextSnapshots) {
          if (aid.includes(m.name) || aid.includes(m.role)) {
            count++;
            break;
          }
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
    return <div className="flex items-center justify-center h-full text-slate-500">请先选择一个项目</div>;
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
              团队 {members.length} 人 + 管家 · {totalActive} 活跃 · 总 Token: {formatTokens(totalTokens)}
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
          {sortedMembers.map((member, idx) => {
            // 查找匹配快照
            let snap: ContextSnapshot | null = null;
            if (member.id === META_AGENT_MEMBER_ID) {
              // 管家 agent: 按 'meta-agent' 前缀匹配
              if (contextSnapshots.has('meta-agent')) snap = contextSnapshots.get('meta-agent') ?? null;
              else {
                for (const [aid, s] of contextSnapshots) {
                  if (aid.startsWith('meta-agent')) {
                    snap = s;
                    break;
                  }
                }
              }
            } else if (contextSnapshots.has(member.id)) snap = contextSnapshots.get(member.id) ?? null;
            else if (contextSnapshots.has(member.name)) snap = contextSnapshots.get(member.name) ?? null;
            else {
              for (const [aid, s] of contextSnapshots) {
                if (aid.includes(member.name) || aid.includes(member.role)) {
                  snap = s;
                  break;
                }
              }
            }
            return (
              <React.Fragment key={member.id}>
                {idx === 1 && members.length > 0 && <div className="border-t border-slate-800/50 my-1" />}
                <MemberContextCard
                  member={member}
                  snapshot={snap}
                  agentStatus={findAgentStatusForMember(member, agentStatuses)}
                  isSelected={selected?.id === member.id}
                  onSelect={() => {
                    setSelectedMemberId(member.id);
                    setPreviewSection(null);
                  }}
                />
              </React.Fragment>
            );
          })}
        </div>

        {/* 右侧: 选中成员的详情 — 分为模块列表 + 内容预览两栏 */}
        {selected && selectedSnapshot ? (
          <div className="flex-1 flex overflow-hidden">
            {/* 中间列: 模块列表 */}
            <div
              className={`${previewSection ? 'w-1/2' : 'flex-1'} overflow-y-auto px-4 py-4 space-y-4 border-r border-slate-800/50 transition-all`}
            >
              {/* Token 预算条 */}
              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-4">
                <TokenBudgetBar snapshot={selectedSnapshot} />
              </div>

              {/* Feature 信息 + 压缩按钮 */}
              <div className="bg-slate-900/30 rounded-lg border border-slate-800 px-3 py-2.5 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">当前任务</div>
                  <div className="text-xs text-slate-300 mt-0.5 truncate">
                    <span className="font-mono text-forge-400">{selectedSnapshot.featureId}</span>
                    <span className="mx-1.5 text-slate-600">·</span>
                    <span className="font-mono text-emerald-400">{selectedSnapshot.agentId}</span>
                  </div>
                </div>
                {selectedSnapshot.totalTokens > selectedSnapshot.tokenBudget * 0.7 && (
                  <button
                    className="px-2 py-1 text-[10px] rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-colors shrink-0"
                    title="压缩上下文"
                    onClick={() => toast.info('上下文压缩将在下次 Agent 执行时自动触发')}
                  >
                    🗜️ 压缩
                  </button>
                )}
              </div>

              {/* 模块卡片列表 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-medium text-slate-300">
                    上下文模块 ({selectedSnapshot.sections.length})
                  </h2>
                  <span className="text-[10px] text-slate-500">点击预览内容</span>
                </div>
                {selectedSnapshot.sections.map((sec: ContextSection) => (
                  <ContextSectionCard
                    key={sec.id}
                    section={sec}
                    tokenBudget={selectedSnapshot.tokenBudget}
                    isActive={previewSection?.id === sec.id}
                    onSelect={() => setPreviewSection(previewSection?.id === sec.id ? null : sec)}
                  />
                ))}
              </div>
            </div>

            {/* 右侧列: 内容预览面板 */}
            {previewSection && (
              <div className="w-1/2 overflow-hidden flex flex-col bg-slate-950/50">
                {/* 关闭按钮 */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">内容预览</span>
                  <button
                    onClick={() => setPreviewSection(null)}
                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-1.5 py-0.5 rounded hover:bg-slate-800"
                  >
                    ✕
                  </button>
                </div>
                <ContentPreviewPanel section={previewSection} />
              </div>
            )}
          </div>
        ) : selected && isMetaAgentSelected ? (
          <MetaAgentBaselinePanel />
        ) : selected ? (
          <BaselinePanel member={selected} projectId={currentProjectId} />
        ) : null}
      </div>
    </div>
  );
}
