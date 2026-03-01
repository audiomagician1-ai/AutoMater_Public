import { useEffect } from 'react';
import { useAppStore } from './stores/app-store';
import { Sidebar } from './components/Sidebar';
import { WishPage } from './pages/WishPage';
import { BoardPage } from './pages/BoardPage';
import { TeamPage } from './pages/TeamPage';
import { LogsPage } from './pages/LogsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const { currentPage, addLog, updateFeatureStatus, updateAgentStatus, setSettingsConfigured } = useAppStore();

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

    // 检查设置
    window.agentforge.settings.get().then(s => {
      if (s.apiKey) setSettingsConfigured(true);
    });

    return () => unsubs.forEach(fn => fn());
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'wish': return <WishPage />;
      case 'board': return <BoardPage />;
      case 'team': return <TeamPage />;
      case 'logs': return <LogsPage />;
      case 'settings': return <SettingsPage />;
    }
  };

  return (
    <div className="flex h-screen w-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        {renderPage()}
      </main>
    </div>
  );
}
