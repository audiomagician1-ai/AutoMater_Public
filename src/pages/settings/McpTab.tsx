/**
 * MCP Tab — MCP 服务器管理
 */
import { useState, useCallback, useEffect } from 'react';
import { McpServerForm } from './McpServerForm';

export function McpTab() {
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpTools, setMcpTools] = useState<McpToolSummary[]>([]);

  const refreshMcpServers = useCallback(async () => {
    const servers = await window.automater.mcp.listServers();
    setMcpServers(servers);
    const tools = await window.automater.mcp.listTools();
    setMcpTools(tools);
  }, []);

  useEffect(() => { refreshMcpServers(); }, [refreshMcpServers]);

  const handleAddMcp = async (config: Partial<McpServerConfig>) => {
    await window.automater.mcp.addServer(config as Omit<McpServerConfig, 'id'>);
    setShowMcpForm(false);
    await refreshMcpServers();
  };

  const handleUpdateMcp = async (config: Partial<McpServerConfig>) => {
    if (editingMcpId) {
      await window.automater.mcp.updateServer(editingMcpId, config);
      setEditingMcpId(null);
      await refreshMcpServers();
    }
  };

  const handleRemoveMcp = async (id: string) => {
    await window.automater.mcp.removeServer(id);
    await refreshMcpServers();
  };

  const handleToggleMcpConnection = async (server: McpServerStatus) => {
    setMcpConnecting(server.id);
    try {
      if (server.connected) {
        await window.automater.mcp.disconnectServer(server.id);
      } else {
        await window.automater.mcp.connectServer(server.id);
      }
    } catch { /* silent: toggle MCP connection */ }
    setMcpConnecting(null);
    await refreshMcpServers();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">MCP 服务器</h3>
          <p className="text-xs text-slate-500 mt-1">
            通过 Model Context Protocol 连接外部工具服务器, 让 Agent 使用更多工具
          </p>
        </div>
        <button onClick={() => { setShowMcpForm(true); setEditingMcpId(null); }}
          className="px-3 py-1.5 bg-forge-600 hover:bg-forge-500 rounded text-sm font-medium transition-all">
          + 添加服务器
        </button>
      </div>

      {showMcpForm && !editingMcpId && (
        <McpServerForm onSubmit={handleAddMcp} onCancel={() => setShowMcpForm(false)} />
      )}

      {mcpServers.length === 0 && !showMcpForm && (
        <div className="text-center py-12 text-slate-500">
          <p className="text-3xl mb-3">🔌</p>
          <p className="text-sm">暂无 MCP 服务器</p>
          <p className="text-xs mt-1">点击 "添加服务器" 连接外部工具</p>
        </div>
      )}

      {mcpServers.map(server => (
        <div key={server.id} className="border border-slate-700 rounded-lg overflow-hidden">
          {editingMcpId === server.id ? (
            <McpServerForm initial={server} onSubmit={handleUpdateMcp} onCancel={() => setEditingMcpId(null)} />
          ) : (
            <div className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full ${server.connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                  <div>
                    <span className="text-sm font-medium text-slate-200">{server.name}</span>
                    <span className="text-xs text-slate-500 ml-2">
                      {server.transport === 'stdio' ? server.command : server.url}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {server.connected && <span className="text-xs text-emerald-400">{server.toolCount} 工具</span>}
                  <button onClick={() => handleToggleMcpConnection(server)} disabled={mcpConnecting === server.id}
                    className={`px-3 py-1 rounded text-xs font-medium transition-all disabled:opacity-40 ${
                      server.connected ? 'bg-red-900/50 text-red-300 hover:bg-red-900' : 'bg-emerald-900/50 text-emerald-300 hover:bg-emerald-900'
                    }`}>
                    {mcpConnecting === server.id ? '...' : server.connected ? '断开' : '连接'}
                  </button>
                  <button onClick={() => setEditingMcpId(server.id)} className="px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-700">编辑</button>
                  <button onClick={() => handleRemoveMcp(server.id)} className="px-2 py-1 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30">删除</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {mcpTools.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">已发现的 MCP 工具 ({mcpTools.length})</h4>
          <div className="grid grid-cols-2 gap-2">
            {mcpTools.map((tool, i) => (
              <div key={i} className="px-3 py-2 bg-slate-800/50 rounded text-xs">
                <span className="font-mono text-forge-400">{tool.name}</span>
                <p className="text-slate-500 mt-0.5 line-clamp-1">{tool.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
