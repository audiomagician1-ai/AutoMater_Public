/**
 * SessionManager — Session 切换/创建/浏览组件
 *
 * 支持:
 *  - 查看当前项目所有 Agent 的 Session 列表
 *  - 切换到历史 Session
 *  - 创建新 Session
 *  - 查看 Session 备份内容
 *  - 备份统计
 *
 * v8.0: 初始创建
 */

import { useState, useEffect, useCallback } from 'react';
import { createLogger } from '../utils/logger';

const log = createLogger('SessionManager');

interface SessionInfo {
  id: string;
  projectId: string | null;
  agentId: string;
  agentRole: string;
  agentSeq: number;
  status: 'active' | 'completed' | 'archived';
  backupPath: string | null;
  createdAt: string;
  completedAt: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
}

interface BackupStats {
  totalSessions: number;
  totalBackupFiles: number;
  totalBackupSizeBytes: number;
  oldestBackup: string | null;
  newestBackup: string | null;
}

interface SessionManagerProps {
  projectId: string | null;
  /** 可选: 只显示某个 Agent 的 Session */
  agentId?: string;
  /** 组件是否可见 */
  visible?: boolean;
  onClose?: () => void;
}

export function SessionManager({ projectId, agentId, visible = true, onClose }: SessionManagerProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [stats, setStats] = useState<BackupStats | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [backupContent, setBackupContent] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await (window as any).automater.session.list(projectId, agentId);
      setSessions(list || []);
    } catch (err) {
      log.error('Failed to load sessions:', err);
    }
    setLoading(false);
  }, [projectId, agentId]);

  const loadStats = useCallback(async () => {
    try {
      const s = await (window as any).automater.session.backupStats();
      setStats(s);
    } catch (err) {
      log.error('Failed to load backup stats:', err);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      loadSessions();
      loadStats();
    }
  }, [visible, loadSessions, loadStats]);

  const handleCreateSession = async (aId: string, role: string) => {
    try {
      await (window as any).automater.session.create(projectId, aId, role);
      await loadSessions();
    } catch (err) {
      log.error('Failed to create session:', err);
    }
  };

  const handleSwitchSession = async (sessionId: string) => {
    try {
      await (window as any).automater.session.switch(sessionId);
      await loadSessions();
    } catch (err) {
      log.error('Failed to switch session:', err);
    }
  };

  const handleViewBackup = async (sessionId: string) => {
    setSelectedSession(sessionId);
    try {
      const backup = await (window as any).automater.session.readBackup(sessionId);
      setBackupContent(backup);
    } catch (err) {
      log.error('Failed to read backup:', err);
      setBackupContent(null);
    }
  };

  const handleCleanup = async () => {
    if (!confirm('确认清理 30 天前的旧备份？')) return;
    try {
      const result = await (window as any).automater.session.cleanup(30);
      alert(`已清理 ${result.deletedFolders} 个旧备份文件夹`);
      await loadStats();
    } catch (err) {
      log.error('Cleanup failed:', err);
    }
  };

  const filteredSessions = sessions.filter(s => {
    if (filter === 'all') return true;
    return s.status === filter;
  });

  // 按 agentId 分组
  const grouped = new Map<string, SessionInfo[]>();
  for (const s of filteredSessions) {
    const key = `${s.agentRole}:${s.agentId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  if (!visible) return null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const roleIcons: Record<string, string> = {
    pm: '🧠', architect: '🏗️', developer: '💻', qa: '🧪',
    devops: '🚀', 'meta-agent': '🤖',
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-lg">📼</span>
          <h2 className="text-sm font-semibold">Session 管理</h2>
          {stats && (
            <span className="text-xs text-slate-400">
              {stats.totalSessions} sessions · {formatBytes(stats.totalBackupSizeBytes)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Filter */}
          <select
            value={filter}
            onChange={e => setFilter(e.target.value as any)}
            className="text-xs bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-300"
          >
            <option value="all">全部</option>
            <option value="active">活跃</option>
            <option value="completed">已完成</option>
          </select>
          <button
            onClick={handleCleanup}
            className="text-xs px-2 py-1 bg-red-900/40 hover:bg-red-900/60 rounded text-red-300"
            title="清理旧备份"
          >
            🗑 清理
          </button>
          <button
            onClick={loadSessions}
            className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded"
          >
            🔄
          </button>
          {onClose && (
            <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Session List */}
        <div className="w-72 border-r border-slate-700 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-slate-400 text-sm">加载中...</div>
          ) : grouped.size === 0 ? (
            <div className="p-4 text-slate-500 text-sm">暂无 Session 记录</div>
          ) : (
            Array.from(grouped.entries()).map(([key, group]) => {
              const first = group[0];
              const icon = roleIcons[first.agentRole] || '🤖';
              return (
                <div key={key} className="border-b border-slate-800">
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-800/50">
                    <span className="text-xs font-medium text-slate-300">
                      {icon} {first.agentId} <span className="text-slate-500">({first.agentRole})</span>
                    </span>
                    <button
                      onClick={() => handleCreateSession(first.agentId, first.agentRole)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                      title="创建新 Session"
                    >
                      + 新建
                    </button>
                  </div>
                  {group.map(s => (
                    <div
                      key={s.id}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-xs hover:bg-slate-800 ${
                        selectedSession === s.id ? 'bg-blue-900/30 border-l-2 border-blue-400' : ''
                      }`}
                      onClick={() => handleViewBackup(s.id)}
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        s.status === 'active' ? 'bg-green-400' : 'bg-slate-500'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-slate-300 truncate">
                          #{s.agentSeq} · {s.messageCount} msgs
                        </div>
                        <div className="text-slate-500">
                          {formatTime(s.createdAt)}
                          {s.totalCost > 0 && ` · $${s.totalCost.toFixed(4)}`}
                        </div>
                      </div>
                      {s.status === 'active' && (
                        <span className="text-green-400 text-[10px] font-medium">LIVE</span>
                      )}
                      {s.status !== 'active' && s.backupPath && (
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            handleSwitchSession(s.id);
                          }}
                          className="text-blue-400 hover:text-blue-300"
                          title="切换到此 Session"
                        >
                          ↩
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>

        {/* Backup Content Preview */}
        <div className="flex-1 overflow-y-auto">
          {!selectedSession ? (
            <div className="flex items-center justify-center h-full text-slate-500 text-sm">
              <div className="text-center">
                <div className="text-3xl mb-2">📼</div>
                <div>选择一个 Session 查看备份详情</div>
              </div>
            </div>
          ) : backupContent ? (
            <div className="p-4 space-y-4">
              {/* Backup Header */}
              <div className="bg-slate-800 rounded-lg p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{backupContent.agentId}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    backupContent.completed ? 'bg-green-900/40 text-green-300' : 'bg-yellow-900/40 text-yellow-300'
                  }`}>
                    {backupContent.completed ? '✅ 完成' : '⚠️ 未完成'}
                  </span>
                </div>
                <div className="text-xs text-slate-400 space-y-0.5">
                  <div>角色: {backupContent.agentRole} {backupContent.featureId ? `· Feature: ${backupContent.featureId}` : ''}</div>
                  <div>模型: {backupContent.model || 'N/A'}</div>
                  <div>消息: {backupContent.messageCount} 条 {backupContent.reactIterations ? `· ReAct: ${backupContent.reactIterations} 轮` : ''}</div>
                  <div>Token: {(backupContent.totalInputTokens + backupContent.totalOutputTokens).toLocaleString()} · 费用: ${backupContent.totalCost.toFixed(4)}</div>
                  <div>时间: {formatTime(backupContent.startedAt)} → {formatTime(backupContent.endedAt)}</div>
                </div>
              </div>

              {/* Messages */}
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-slate-400 uppercase">对话历史</h3>
                {(backupContent.messages || []).map((msg: { role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ function?: { name: string; arguments: string } }> }, i: number) => {
                  const roleColors: Record<string, string> = {
                    system: 'border-purple-700 bg-purple-900/20',
                    user: 'border-blue-700 bg-blue-900/20',
                    assistant: 'border-green-700 bg-green-900/20',
                    tool: 'border-orange-700 bg-orange-900/20',
                  };
                  const roleLabels: Record<string, string> = {
                    system: '📋 System',
                    user: '👤 User',
                    assistant: '🤖 Assistant',
                    tool: '🔧 Tool',
                  };
                  const color = roleColors[msg.role] || 'border-slate-700 bg-slate-800';
                  const label = roleLabels[msg.role] || msg.role;
                  const content = typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content, null, 2);
                  const truncated = content.length > 2000;

                  return (
                    <div key={i} className={`border-l-2 ${color} rounded-r p-2`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-300">{label}</span>
                        {msg.tool_calls && (
                          <span className="text-xs text-orange-400">
                            {msg.tool_calls.length} tool call(s)
                          </span>
                        )}
                        {msg.tool_call_id && (
                          <span className="text-xs text-slate-500 font-mono">{msg.tool_call_id}</span>
                        )}
                      </div>
                      <pre className="text-xs text-slate-400 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                        {truncated ? content.slice(0, 2000) + '\n... [截断]' : content}
                      </pre>
                      {msg.tool_calls && (
                        <div className="mt-1 space-y-1">
                          {msg.tool_calls.map((tc, j) => (
                            <div key={j} className="text-xs text-orange-300 bg-orange-900/10 rounded px-2 py-1">
                              🔧 {tc.function?.name}({typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 100) : JSON.stringify(tc.function?.arguments).slice(0, 100)})
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="p-4 text-slate-500 text-sm">加载备份内容中...</div>
          )}
        </div>
      </div>
    </div>
  );
}
