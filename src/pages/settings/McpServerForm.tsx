/**
 * MCP 服务器配置表单 (新增/编辑)
 */
import { useState } from 'react';

function parseKvLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function parseHeaderLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

export function McpServerForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: McpServerStatus;
  onSubmit: (config: Partial<McpServerConfig>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [transport, setTransport] = useState<'stdio' | 'sse'>(initial?.transport || 'stdio');
  const [command, setCommand] = useState(initial?.command || '');
  const [args, setArgs] = useState((initial?.args || []).join(' '));
  const [cwd, setCwd] = useState(initial?.cwd || '');
  const [envText, setEnvText] = useState(
    Object.entries(initial?.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')
  );
  const [url, setUrl] = useState(initial?.url || '');
  const [headersText, setHeadersText] = useState(
    Object.entries(initial?.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
  );

  const handleSubmit = () => {
    const config: Partial<McpServerConfig> = {
      name: name.trim() || 'Unnamed',
      transport,
      enabled: initial?.enabled ?? true,
    };
    if (transport === 'stdio') {
      config.command = command.trim();
      config.args = args.trim() ? args.trim().split(/\s+/) : [];
      config.cwd = cwd.trim() || undefined;
      config.env = parseKvLines(envText);
    } else {
      config.url = url.trim();
      config.headers = parseHeaderLines(headersText);
    }
    onSubmit(config);
  };

  const inputCls = "w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500";

  return (
    <div className="space-y-3 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-slate-400">名称</label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="My MCP Server" className={inputCls} />
      </div>
      <div className="flex gap-2">
        {(['stdio', 'sse'] as const).map(t => (
          <button key={t} onClick={() => setTransport(t)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${transport === t ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
            {t === 'stdio' ? '📟 Stdio' : '🌐 SSE'}
          </button>
        ))}
      </div>
      {transport === 'stdio' ? (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">命令</label>
            <input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx, python, node..." className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">参数 (空格分隔)</label>
            <input value={args} onChange={e => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-xxx" className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">工作目录 (可选)</label>
            <input value={cwd} onChange={e => setCwd(e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">环境变量 (每行 KEY=VALUE)</label>
            <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={3} className={inputCls + " font-mono text-xs resize-none"} />
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">SSE URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:3001/sse" className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">Headers (每行 Key: Value)</label>
            <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={3} className={inputCls + " font-mono text-xs resize-none"} />
          </div>
        </>
      )}
      <div className="flex gap-2 pt-2">
        <button onClick={handleSubmit} className="px-4 py-2 bg-forge-600 hover:bg-forge-500 rounded text-sm font-medium transition-all">
          {initial ? '更新' : '添加'}
        </button>
        <button onClick={onCancel} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm font-medium transition-all">取消</button>
      </div>
    </div>
  );
}
