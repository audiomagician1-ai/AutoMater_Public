import { useEffect, useState } from 'react';
import { useAppStore } from './stores/app-store';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ProjectsPage } from './pages/ProjectsPage';
import { OverviewPage } from './pages/OverviewPage';
import { WishPage } from './pages/WishPage';
import { BoardPage } from './pages/BoardPage';
import { TeamPage } from './pages/TeamPage';
import { DocsPage } from './pages/DocsPage';
import { AcceptancePanel } from './components/AcceptancePanel';
import { LogsPage } from './pages/LogsPage';
import { OutputPage } from './pages/OutputPage';
import { SettingsPage } from './pages/SettingsPage';
import { ContextPage } from './pages/ContextPage';
import { WorkflowPage } from './pages/WorkflowPage';
import TimelinePage from './pages/TimelinePage';
import { MetaAgentPanel } from './components/MetaAgentPanel';
import { SessionManager } from './components/SessionManager';
import { GuidePage } from './pages/GuidePage';
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  const {
    insideProject, globalPage, projectPage,
    addLog, updateFeatureStatus, updateAgentStatus, setSettingsConfigured,
    currentProjectId, startStream, appendStream, endStream,
    updateContextSnapshot, incrementNotifications, setShowAcceptancePanel,
  } = useAppStore();
  const updateAgentReactState = useAppStore(s => s.updateAgentReactState);
  const addAgentWorkMessage = useAppStore(s => s.addAgentWorkMessage);
  const [stats, setStats] = useState<any>(null);

  // 订阅主进程事件
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(window.automater.on('agent:log', (data: any) => {
      addLog({ projectId: data.projectId, agentId: data.agentId, content: data.content });
      // v6.0: 解析为结构化工作消息分发到 agentWorkMessages
      if (data.agentId && data.agentId !== 'system') {
        const c: string = data.content || '';
        const msgId = `wm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const ts = Date.now();
        if (c.includes('💭')) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'think', timestamp: ts, content: c.replace(/^.*?💭\s*/, '') });
        } else if (c.includes('🔧')) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'tool-call', timestamp: ts, content: c });
        } else if (c.includes('✅') && (c.includes('task_complete') || c.includes('ReAct 完成') || c.includes('ReAct 循环结束'))) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'output', timestamp: ts, content: c });
        } else if (c.includes('🔬')) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'sub-agent', timestamp: ts, content: c });
        } else if (c.includes('📋') || c.includes('📊') || c.includes('📁') || c.includes('🤖')) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'status', timestamp: ts, content: c });
        } else if (c.includes('⚠️') || c.includes('🛑') || c.includes('❌') || c.includes('🚫')) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'error', timestamp: ts, content: c });
        } else if (c.includes('🔄')) {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'status', timestamp: ts, content: c });
        } else {
          addAgentWorkMessage(data.agentId, { id: msgId, type: 'status', timestamp: ts, content: c });
        }
      }
    }));

    unsubs.push(window.automater.on('agent:spawned', (data: any) => {
      addLog({ projectId: data.projectId, agentId: data.agentId, content: `🚀 ${data.role} Agent 已上线` });
      updateAgentStatus(data.agentId, 'idle', null);
    }));

    unsubs.push(window.automater.on('agent:status', (data: any) => {
      updateAgentStatus(data.agentId, data.status, data.currentTask ?? null, data.featureTitle);
    }));

    unsubs.push(window.automater.on('feature:status', (data: any) => {
      updateFeatureStatus(data.featureId, data.status);
    }));

    unsubs.push(window.automater.on('project:status', (data: any) => {
      addLog({ projectId: data.projectId, agentId: 'system', content: `📌 项目状态: ${data.status}` });
    }));

    unsubs.push(window.automater.on('project:features-ready', (data: any) => {
      addLog({ projectId: data.projectId, agentId: 'system', content: `📋 Feature 清单已就绪: ${data.count} 个任务` });
    }));

    unsubs.push(window.automater.on('agent:error', (data: any) => {
      addLog({ projectId: data.projectId, agentId: 'system', content: `❌ 错误: ${data.error}` });
    }));

    // 工具调用事件 (v0.9 ReAct)
    unsubs.push(window.automater.on('agent:tool-call', (data: any) => {
      const icon = data.success ? '✅' : '❌';
      addLog({
        projectId: data.projectId,
        agentId: data.agentId,
        content: `🔧 ${data.tool}(${data.args}) → ${icon} ${data.outputPreview}`,
      });
      // v6.0: 结构化工具调用消息
      if (data.agentId) {
        addAgentWorkMessage(data.agentId, {
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool-result',
          timestamp: Date.now(),
          content: data.outputPreview || '',
          tool: {
            name: data.tool,
            args: data.args,
            success: data.success,
            outputPreview: data.outputPreview,
          },
        });
      }
    }));

    // 上下文快照事件 (v1.1)
    unsubs.push(window.automater.on('agent:context-snapshot', (data: any) => {
      if (data.snapshot) {
        updateContextSnapshot(data.snapshot);
      }
    }));

    // Agent ReAct 状态事件 (v1.1)
    unsubs.push(window.automater.on('agent:react-state', (data: any) => {
      if (data.state) {
        updateAgentReactState(data.state);
      }
    }));

    // 流式事件
    unsubs.push(window.automater.on('agent:stream-start', (data: any) => {
      startStream(data.agentId, data.label || '');
    }));
    unsubs.push(window.automater.on('agent:stream', (data: any) => {
      appendStream(data.agentId, data.chunk);
    }));
    unsubs.push(window.automater.on('agent:stream-end', (data: any) => {
      endStream(data.agentId);
    }));

    // v4.4: 用户验收通知
    unsubs.push(window.automater.on('project:awaiting-acceptance', (data: any) => {
      incrementNotifications();
      setShowAcceptancePanel(true);
      addLog({
        projectId: data.projectId,
        agentId: 'system',
        content: '🔔 项目已进入用户验收阶段，请前往全景页审查并做出决定',
      });
      // Electron native notification (renderer can use Notification API)
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('AutoMater — 需要您的验收', {
          body: '项目开发已完成，等待您的验收决定',
          icon: undefined,
        });
      } else if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission();
      }
    }));

    // 检查设置
    window.automater.settings.get().then(s => {
      if (s.apiKey) setSettingsConfigured(true);
      // v5.2: 应用保存的缩放倍率 (默认 1.5)
      const zoom = s.zoomFactor ?? 1.5;
      window.automater.zoom.set(zoom);
    });

    // v5.2: 监听主进程下发的缩放变化, 持久化到设置
    const unsubZoom = window.automater.on('zoom:changed', (factor: number) => {
      window.automater.settings.get().then(s => {
        window.automater.settings.save({ ...s, zoomFactor: factor });
      });
    });

    return () => {
      unsubs.forEach(fn => fn());
      unsubZoom();
    };
  }, []);

  // 定时拉取统计
  useEffect(() => {
    if (!currentProjectId) { setStats(null); return; }
    const poll = async () => {
      try { setStats(await window.automater.project.getStats(currentProjectId)); } catch {}
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [currentProjectId]);

  const renderContent = () => {
    if (!insideProject) {
      // 外层: 项目列表 / 设置
      switch (globalPage) {
        case 'settings': return <ErrorBoundary key="settings"><SettingsPage /></ErrorBoundary>;
        case 'guide':    return <ErrorBoundary key="guide"><GuidePage /></ErrorBoundary>;
        case 'projects':
        default: return <ErrorBoundary key="projects"><ProjectsPage /></ErrorBoundary>;
      }
    }
    // 内层: 项目子页 — 每个页面独立 ErrorBoundary, key 确保页面切换时重置状态
    switch (projectPage) {
      case 'overview': return <ErrorBoundary key="overview"><OverviewPage /></ErrorBoundary>;
      case 'wish':     return <ErrorBoundary key="wish"><WishPage /></ErrorBoundary>;
      case 'board':    return <ErrorBoundary key="board"><BoardPage /></ErrorBoundary>;
      case 'team':     return <ErrorBoundary key="team"><TeamPage /></ErrorBoundary>;
      case 'docs':     return <ErrorBoundary key="docs"><DocsPage /></ErrorBoundary>;
      case 'workflow': return <ErrorBoundary key="workflow"><WorkflowPage /></ErrorBoundary>;
      case 'output':   return <ErrorBoundary key="output"><OutputPage /></ErrorBoundary>;
      case 'logs':     return <ErrorBoundary key="logs"><LogsPage /></ErrorBoundary>;
      case 'context':  return <ErrorBoundary key="context"><ContextPage /></ErrorBoundary>;
      case 'timeline': return <ErrorBoundary key="timeline"><TimelinePage /></ErrorBoundary>;
      case 'sessions': return <ErrorBoundary key="sessions"><SessionManager projectId={currentProjectId} visible={true} /></ErrorBoundary>;
      case 'guide':    return <ErrorBoundary key="guide-proj"><GuidePage /></ErrorBoundary>;
      default:         return <ErrorBoundary key="overview-default"><OverviewPage /></ErrorBoundary>;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100">
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          {renderContent()}
        </main>
        {insideProject && <MetaAgentPanel />}
      </div>
      {insideProject && <StatusBar stats={stats} />}
      {insideProject && <AcceptancePanel />}
    </div>
  );
}

