import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

const ROLE_INFO: Record<string, { icon: string; title: string }> = {
  pm: { icon: '🧠', title: '产品经理' },
  architect: { icon: '🏗️', title: '架构师' },
  developer: { icon: '💻', title: '开发者' },
  qa: { icon: '🧪', title: 'QA 工程师' },
  reviewer: { icon: '👁️', title: 'Reviewer' },
  devops: { icon: '🚀', title: 'DevOps' },
};

const STATUS_STYLES: Record<string, string> = {
  idle: 'bg-slate-600',
  working: 'bg-emerald-500 animate-pulse',
  waiting: 'bg-amber-500',
  error: 'bg-red-500',
  stopped: 'bg-slate-700',
};

export function TeamPage() {
  const { currentProjectId } = useAppStore();
  const [agents, setAgents] = useState<any[]>([]);

  const loadAgents = async () => {
    if (!currentProjectId) return;
    const data = await window.agentforge.project.getAgents(currentProjectId);
    setAgents(data || []);
  };

  useEffect(() => { loadAgents(); }, [currentProjectId]);
  useEffect(() => {
    const timer = setInterval(loadAgents, 3000);
    return () => clearInterval(timer);
  }, [currentProjectId]);

  if (!currentProjectId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500">
        <p>加载中...</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6 gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">虚拟团队</h2>
        <span className="text-sm text-slate-500">{agents.length} 位成员</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto">
        {agents.map(agent => {
          const info = ROLE_INFO[agent.role] || { icon: '🤖', title: agent.role };
          return (
            <div key={agent.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3 hover:border-slate-700 transition-colors">
              {/* Header */}
              <div className="flex items-center gap-3">
                <span className="text-2xl">{info.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-slate-200 truncate">{info.title}</div>
                  <div className="text-xs text-slate-500 font-mono">{agent.id}</div>
                </div>
                <div className={`w-2.5 h-2.5 rounded-full ${STATUS_STYLES[agent.status] || 'bg-slate-600'}`}
                  title={agent.status}
                />
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-slate-800/50 rounded-lg p-2">
                  <div className="text-sm font-semibold text-slate-200">{agent.session_count}</div>
                  <div className="text-[10px] text-slate-500">会话</div>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-2">
                  <div className="text-sm font-semibold text-slate-200">
                    {((agent.total_input_tokens + agent.total_output_tokens) / 1000).toFixed(1)}k
                  </div>
                  <div className="text-[10px] text-slate-500">tokens</div>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-2">
                  <div className="text-sm font-semibold text-slate-200">${agent.total_cost_usd.toFixed(2)}</div>
                  <div className="text-[10px] text-slate-500">成本</div>
                </div>
              </div>

              {/* Current task */}
              {agent.current_task && (
                <div className="text-xs text-forge-400 truncate">
                  🔨 正在处理: {agent.current_task}
                </div>
              )}
            </div>
          );
        })}
        {agents.length === 0 && (
          <div className="col-span-full text-center py-12 text-slate-600">
            尚无 Agent，开始许愿后 AI 团队将自动上线
          </div>
        )}
      </div>
    </div>
  );
}
