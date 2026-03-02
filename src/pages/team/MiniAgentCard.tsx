/**
 * MiniAgentCard — 左侧精简成员卡片 (v6.0)
 */

import { useAppStore } from '../../stores/app-store';
import { ROLE_INFO, STATUS_STYLES, formatTokens } from './types';

export function MiniAgentCard({
  agent,
  isSelected,
  onClick,
}: {
  agent: TeamMember & { status?: string; current_task?: string };
  isSelected: boolean;
  onClick: () => void;
}) {
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const compKey = currentProjectId ? `${currentProjectId}:${agent.id}` : agent.id;
  const reactState = useAppStore(s => s.agentReactStates.get(compKey));
  const liveStatus = useAppStore(s => s.agentStatuses.get(compKey));
  const msgCount = useAppStore(s => s.agentWorkMessages.get(compKey)?.length ?? 0);
  const info = ROLE_INFO[agent.role] || { icon: '🤖', title: agent.role };
  const isWorking = agent.status === 'working' || liveStatus?.status === 'working';
  const latestIter = reactState?.iterations?.length
    ? reactState.iterations[reactState.iterations.length - 1]
    : undefined;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl p-3 transition-all flex items-center gap-3 ${
        isSelected
          ? 'bg-forge-600/20 border border-forge-500/40 shadow-lg shadow-forge-500/5'
          : 'bg-slate-900 border border-slate-800 hover:border-slate-700'
      }`}
    >
      <div className="relative shrink-0">
        <span className="text-xl">{info.icon}</span>
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${
            isWorking ? 'bg-emerald-500 animate-pulse' : STATUS_STYLES[agent.status ?? ''] || 'bg-slate-600'
          }`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-200 truncate">{info.title}</div>
        {isWorking && (liveStatus?.featureTitle || agent.current_task) && (
          <div className="text-[10px] text-emerald-400 truncate mt-0.5">
            {liveStatus?.featureTitle || agent.current_task}
          </div>
        )}
        {!isWorking && latestIter && (
          <div className="text-[10px] text-slate-500 mt-0.5">
            {formatTokens(latestIter.totalContextTokens)} ctx · ${latestIter.cumulativeCost.toFixed(3)}
          </div>
        )}
      </div>
      {msgCount > 0 && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono shrink-0 ${
            isSelected ? 'bg-forge-500/30 text-forge-300' : 'bg-slate-800 text-slate-500'
          }`}
        >
          {msgCount}
        </span>
      )}
    </button>
  );
}
