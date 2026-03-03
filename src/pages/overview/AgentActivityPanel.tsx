import { useState, useMemo, useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/app-store';
import { AgentWorkFeed } from '../../components/AgentWorkFeed';

const AGENT_ROLE_TAB_INFO: Record<string, { icon: string; label: string }> = {
  pm: { icon: '🧠', label: 'PM' },
  arch: { icon: '🏗️', label: '架构' },
  dev: { icon: '💻', label: '开发' },
  qa: { icon: '🧪', label: 'QA' },
  devops: { icon: '🚀', label: 'Ops' },
  meta: { icon: '🤖', label: '管家' },
};

/** 从复合键 `projectId:agentId` 中解出 agentId */
function agentIdFromKey(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(idx + 1) : key;
}

function getAgentTabInfo(agentId: string): { icon: string; label: string } {
  const prefix = agentId.split('-')[0];
  return AGENT_ROLE_TAB_INFO[prefix] || { icon: '🤖', label: agentId };
}

export function AgentActivityPanel() {
  const agentStatuses = useAppStore(s => s.agentStatuses);
  const agentWorkMessages = useAppStore(s => s.agentWorkMessages);
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const [expanded, setExpanded] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const activeAgents = useMemo(() => {
    const agents: Array<{ id: string; compKey: string; isWorking: boolean; msgCount: number }> = [];
    const seen = new Set<string>();

    // 只显示当前项目的 agent
    for (const [ck, status] of agentStatuses.entries()) {
      if (currentProjectId && !ck.startsWith(currentProjectId + ':')) continue;
      const aid = agentIdFromKey(ck);
      if (status.status === 'working') {
        agents.push({ id: aid, compKey: ck, isWorking: true, msgCount: (agentWorkMessages.get(ck) || []).length });
        seen.add(ck);
      }
    }

    for (const [ck, msgs] of agentWorkMessages.entries()) {
      if (currentProjectId && !ck.startsWith(currentProjectId + ':')) continue;
      if (!seen.has(ck) && msgs.length > 0) {
        const aid = agentIdFromKey(ck);
        const status = agentStatuses.get(ck);
        agents.push({ id: aid, compKey: ck, isWorking: status?.status === 'working', msgCount: msgs.length });
        seen.add(ck);
      }
    }

    return agents;
  }, [agentStatuses, agentWorkMessages, currentProjectId]);

  // 稳定化 activeAgents 的 id 列表，避免引用变化触发无限循环
  const agentIdsKey = activeAgents.map(a => a.id).join(',');
  const prevAgentIdsRef = useRef(agentIdsKey);

  useEffect(() => {
    // 只在 agent 列表变化或 selectedAgent 不在列表中时才更新
    const needsUpdate = !selectedAgent || !activeAgents.find(a => a.id === selectedAgent);
    if (!needsUpdate) {
      prevAgentIdsRef.current = agentIdsKey;
      return;
    }
    const working = activeAgents.find(a => a.isWorking);
    if (working) setSelectedAgent(working.id);
    else if (activeAgents.length > 0) setSelectedAgent(activeAgents[0].id);
    prevAgentIdsRef.current = agentIdsKey;
  }, [agentIdsKey]); // 只依赖稳定的字符串 key，不依赖 selectedAgent

  const workingCount = activeAgents.filter(a => a.isWorking).length;
  const totalMsgs = activeAgents.reduce((sum, a) => sum + a.msgCount, 0);

  if (activeAgents.length === 0) return null;

  return (
    <section className="bg-slate-900/60 backdrop-blur-sm border border-slate-800/80 rounded-xl overflow-hidden transition-all duration-300">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-800/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          {workingCount > 0 && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
          )}
          <h3 className="text-sm font-medium text-slate-300">🧠 Agent 实时活动</h3>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {workingCount > 0 && <span className="text-emerald-400">{workingCount} 个工作中</span>}
          <span>{totalMsgs} 条消息</span>
        </div>
        <span className={`ml-auto text-slate-500 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {expanded && (
        <div className="border-t border-slate-800">
          <div className="flex items-center gap-1 px-3 py-2 overflow-x-auto border-b border-slate-800/50">
            {activeAgents.map(agent => {
              const tab = getAgentTabInfo(agent.id);
              const isSelected = selectedAgent === agent.id;
              return (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-all ${
                    isSelected
                      ? 'bg-forge-600/20 text-forge-300 border border-forge-500/30'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
                  }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {agent.isWorking && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                  <span className="text-[10px] text-slate-600">{agent.msgCount}</span>
                </button>
              );
            })}
          </div>

          {selectedAgent && (
            <div style={{ height: '320px' }}>
              <AgentWorkFeed agentId={selectedAgent} compact maxHeight="320px" />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
