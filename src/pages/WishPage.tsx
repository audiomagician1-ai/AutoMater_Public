import { useState } from 'react';
import { useAppStore } from '../stores/app-store';

export function WishPage() {
  const [wish, setWish] = useState('');
  const [loading, setLoading] = useState(false);
  const { settingsConfigured, setPage, setCurrentProject, addLog, clearLogs } = useAppStore();

  const handleSubmit = async () => {
    if (!wish.trim() || loading) return;

    if (!settingsConfigured) {
      setPage('settings');
      return;
    }

    setLoading(true);
    clearLogs();

    try {
      const result = await window.agentforge.project.create(wish.trim());
      if (result.success) {
        setCurrentProject(result.projectId);
        addLog({ projectId: result.projectId, agentId: 'system', content: `🎯 新项目已创建: ${result.name}` });

        // 启动 Agent 编排
        await window.agentforge.project.start(result.projectId);

        // 跳转到日志页看实时进度
        setPage('logs');
      }
    } catch (err: any) {
      addLog({ projectId: '', agentId: 'system', content: `❌ ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center px-8">
      <div className="max-w-2xl w-full space-y-8">
        {/* Hero */}
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-forge-400 to-purple-400 bg-clip-text text-transparent">
            AgentForge
          </h1>
          <p className="text-slate-400 text-lg">
            告诉我你想做什么，AI 团队会帮你实现
          </p>
        </div>

        {/* Input */}
        <div className="space-y-4">
          <textarea
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            placeholder="描述你的需求...&#10;&#10;例如: 做一个带用户认证的 TODO 应用，支持分类、标签、截止日期、拖拽排序"
            className="w-full h-40 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-slate-100 placeholder-slate-600 resize-none focus:outline-none focus:border-forge-500 focus:ring-1 focus:ring-forge-500 transition-colors"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) handleSubmit();
            }}
          />

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-600">
              Ctrl + Enter 发送
            </span>

            <button
              onClick={handleSubmit}
              disabled={!wish.trim() || loading}
              className={`
                px-6 py-2.5 rounded-lg font-medium transition-all
                ${!wish.trim() || loading
                  ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
                  : 'bg-forge-600 hover:bg-forge-500 text-white shadow-lg shadow-forge-600/20 hover:shadow-forge-500/30'}
              `}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  启动中...
                </span>
              ) : !settingsConfigured ? (
                '⚙️ 请先配置 LLM'
              ) : (
                '🚀 许愿'
              )}
            </button>
          </div>
        </div>

        {/* Tips */}
        {!settingsConfigured && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 text-amber-400 text-sm">
            💡 首次使用请先前往 <button onClick={() => setPage('settings')} className="underline font-medium">设置</button> 配置你的 LLM API Key
          </div>
        )}
      </div>
    </div>
  );
}
