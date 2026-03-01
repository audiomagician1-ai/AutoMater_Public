import { useEffect, useState } from 'react';
import { useAppStore } from './stores/app-store';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { WishPage } from './pages/WishPage';
import { BoardPage } from './pages/BoardPage';
import { TeamPage } from './pages/TeamPage';
import { LogsPage } from './pages/LogsPage';
import { OutputPage } from './pages/OutputPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const { currentPage, addLog, updateFeatureStatus, updateAgentStatus, setSettingsConfigured, currentProjectId, startStream, appendStream, endStream } = useAppStore();
  const [stats, setStats] = useState<any>(null);

  // 订阅主进程事件
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(window.agentforge.on('agent:log', (data: any) => {
      addLog({ projectId: data.projectId, agentId: data.agentId, content: data.content });
    }));

    unsubs.push(window.agentforge.on('agent:spawned', (data: any) => {
      addLog({ projectId: data.projectId, agentId: data.agentId, content: `🚀 ${data.role} Agent 已上线` });
      updateAgentStatus(data.agentId, 'idle', null);
    }));

    unsubs.push(window.agentforge.on('feature:status', (data: any) => {
      updateFeatureStatus(data.featureId, data.status);
    }));

    unsubs.push(window.agentforge.on('project:status', (data: any) => {
      addLog({ projectId: data.projectId, agentId: 'system', content: `📌 项目状态: ${data.status}` });
    }));

    unsubs.push(window.agentforge.on('project:features-ready', (data: any) => {
      addLog({ projectId: data.projectId, agentId: 'system', content: `📋 Feature 清单已就绪: ${data.count} 个任务` });
    }));

    unsubs.push(window.agentforge.on('agent:error', (data: any) => {
      addLog({ projectId: data.projectId, agentId: 'system', content: `❌ 错误: ${data.error}` });
    }));

    // ── 流式事件 ──
    unsubs.push(window.agentforge.on('agent:stream-start', (data: any) => {
      startStream(data.agentId, data.label || '');
    }));

    unsubs.push(window.agentforge.on('agent:stream', (data: any) => {
      appendStream(data.agentId, data.chunk);
    }));

    unsubs.push(window.agentforge.on('agent:stream-end', (data: any) => {
      endStream(data.agentId);
    }));

    // 检查设置
    window.agentforge.settings.get().then(s => {
      if (s.apiKey) setSettingsConfigured(true);
    });

    return () => unsubs.forEach(fn => fn());
  }, []);

  // 定时拉取统计
  useEffect(() => {
    if (!currentProjectId) { setStats(null); return; }
    const poll = async () => {
      try { setStats(await window.agentforge.project.getStats(currentProjectId)); } catch {}
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [currentProjectId]);

  const renderPage = () => {
    switch (currentPage) {
      case 'wish': return <WishPage />;
      case 'board': return <BoardPage />;
      case 'team': return <TeamPage />;
      case 'logs': return <LogsPage />;
      case 'output': return <OutputPage />;
      case 'settings': return <SettingsPage />;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100">
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          {renderPage()}
        </main>
      </div>
      <StatusBar stats={stats} />
    </div>
  );
}

