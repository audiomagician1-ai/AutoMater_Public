/**
 * MCP Client — Model Context Protocol 客户端
 *
 * 支持两种传输方式:
 *   1. stdio: 启动子进程，通过 stdin/stdout 通信 (JSON-RPC 2.0)
 *   2. SSE (streamable HTTP): 通过 HTTP 长连接接收服务器事件
 *
 * 生命周期: connect() → listTools() → callTool() → disconnect()
 *
 * 协议参考: https://modelcontextprotocol.io/specification/2025-03-26
 *
 * @module mcp-client
 * @since v5.0.0
 */

import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from './logger';

const log = createLogger('mcp-client');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** MCP 服务器配置（持久化到 settings） */
export interface McpServerConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 传输方式 */
  transport: 'stdio' | 'sse';
  /** stdio: 启动命令 (如 "npx", "python") */
  command?: string;
  /** stdio: 命令参数 */
  args?: string[];
  /** stdio: 环境变量 (追加到当前进程环境) */
  env?: Record<string, string>;
  /** stdio: 工作目录 */
  cwd?: string;
  /** SSE: 服务端 URL (如 http://localhost:3000/mcp) */
  url?: string;
  /** SSE: 自定义请求头 (如 Authorization) */
  headers?: Record<string, string>;
  /** 是否启用 */
  enabled: boolean;
  /** 允许哪些角色使用此服务器的工具 (空数组=全部角色) */
  allowedRoles?: string[];
}

/** MCP 工具定义 (从服务器发现) */
export interface McpToolInfo {
  /** 工具名 (服务端原始名) */
  name: string;
  /** 描述 */
  description: string;
  /** JSON Schema for input */
  inputSchema: Record<string, any>;
  /** 所属 MCP 服务器 ID */
  serverId: string;
}

/** MCP 工具调用结果 */
export interface McpToolCallResult {
  success: boolean;
  content: string;
  /** 是否包含图片 (base64) */
  imageBase64?: string;
  /** 原始结果 (content array) */
  rawContent?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

/** JSON-RPC 2.0 消息 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// ═══════════════════════════════════════
// MCP Connection (per-server)
// ═══════════════════════════════════════

/**
 * 单个 MCP 服务器连接。
 *
 * 封装传输层细节，提供统一的 connect/listTools/callTool/disconnect 接口。
 */
export class McpConnection {
  private config: McpServerConfig;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private inputBuffer = '';
  private connected = false;
  private sessionUrl: string | null = null;

  /** 发现的工具列表 (connect 后填充) */
  tools: McpToolInfo[] = [];

  constructor(config: McpServerConfig) {
    this.config = config;
  }

  /** 当前是否已连接 */
  get isConnected(): boolean {
    return this.connected;
  }

  /** 服务器配置 */
  get serverConfig(): McpServerConfig {
    return this.config;
  }

  // ── 连接 ──

  async connect(timeoutMs = 30_000): Promise<void> {
    if (this.config.transport === 'stdio') {
      await this.connectStdio(timeoutMs);
    } else {
      await this.connectSse(timeoutMs);
    }
    this.connected = true;

    // 初始化握手
    await this.initialize();

    // 发现工具
    await this.refreshTools();
  }

  /** 断开连接并清理资源 */
  async disconnect(): Promise<void> {
    this.connected = false;
    this.tools = [];

    // 清理所有 pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    if (this.process) {
      try {
        this.process.stdin?.end();
        this.process.kill('SIGTERM');
      } catch { /* 进程可能已退出 */ }
      this.process = null;
    }

    log.info('Disconnected from MCP server', { serverId: this.config.id });
  }

  /** 刷新工具列表 */
  async refreshTools(): Promise<McpToolInfo[]> {
    const result = await this.request('tools/list', {});
    const serverTools: McpToolInfo[] = (result.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      serverId: this.config.id,
    }));
    this.tools = serverTools;
    log.info('Discovered MCP tools', { serverId: this.config.id, count: serverTools.length });
    return serverTools;
  }

  /** 调用 MCP 工具 */
  async callTool(toolName: string, args: Record<string, any>, timeoutMs = 120_000): Promise<McpToolCallResult> {
    try {
      const result = await this.request('tools/call', {
        name: toolName,
        arguments: args,
      }, timeoutMs);

      const contentArray: Array<{ type: string; text?: string; data?: string; mimeType?: string }> =
        result.content || [];

      // 拼合文本内容
      const textParts = contentArray
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text || '');
      const text = textParts.join('\n');

      // 检查是否含图片
      const imagePart = contentArray.find((c: any) => c.type === 'image');
      const imageBase64 = imagePart?.data;

      const isError = result.isError === true;

      return {
        success: !isError,
        content: text || (isError ? 'Tool execution failed' : 'No output'),
        imageBase64,
        rawContent: contentArray,
      };
    } catch (err: any) {
      return {
        success: false,
        content: `MCP tool call failed: ${err.message}`,
      };
    }
  }

  // ── Stdio 传输 ──

  private connectStdio(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config.command) {
        return reject(new Error('stdio transport requires "command"'));
      }

      const env = { ...process.env, ...(this.config.env || {}) };
      const child = spawn(this.config.command!, this.config.args || [], {
        cwd: this.config.cwd || undefined,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.process = child;

      const timer = setTimeout(() => {
        reject(new Error(`stdio connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn "${this.config.command}": ${err.message}`));
      });

      child.on('exit', (code, signal) => {
        if (this.connected) {
          log.warn('MCP server process exited', { serverId: this.config.id, code, signal });
          this.connected = false;
        }
      });

      child.stderr?.on('data', (chunk) => {
        log.debug('MCP server stderr', { serverId: this.config.id, text: chunk.toString().slice(0, 500) });
      });

      // 用 stdout 接收 JSON-RPC 响应
      child.stdout?.on('data', (chunk) => {
        this.handleStdioData(chunk.toString());
      });

      // stdio 子进程一旦 spawn 成功就算连接建立
      child.on('spawn', () => {
        clearTimeout(timer);
        log.info('MCP stdio process spawned', { serverId: this.config.id, command: this.config.command });
        resolve();
      });
    });
  }

  /** 处理 stdio 输出 (可能有多条消息或分片消息) */
  private handleStdioData(chunk: string): void {
    this.inputBuffer += chunk;

    // MCP stdio 协议: 每条消息以 \n 分隔
    let newlineIndex: number;
    while ((newlineIndex = this.inputBuffer.indexOf('\n')) !== -1) {
      const line = this.inputBuffer.slice(0, newlineIndex).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.handleResponse(msg);
      } catch (err) {
        log.debug('Non-JSON line from MCP server', { line: line.slice(0, 200) });
      }
    }
  }

  // ── SSE (Streamable HTTP) 传输 ──

  private async connectSse(timeoutMs: number): Promise<void> {
    if (!this.config.url) {
      throw new Error('SSE transport requires "url"');
    }

    // SSE/Streamable HTTP: 先发一个 initialize 请求来验证连接
    // 实际的请求在 request() 中完成
    this.sessionUrl = this.config.url;
    log.info('MCP SSE transport configured', { serverId: this.config.id, url: this.config.url });
  }

  // ── 初始化握手 ──

  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'AgentForge',
        version: '5.0.0',
      },
    });

    log.info('MCP handshake complete', {
      serverId: this.config.id,
      serverName: result.serverInfo?.name,
      serverVersion: result.serverInfo?.version,
      protocolVersion: result.protocolVersion,
    });

    // 发送 initialized 通知 (无需等待响应)
    this.notify('notifications/initialized', {});
  }

  // ── JSON-RPC 请求/响应 ──

  /** 发送请求并等待响应 */
  private request(method: string, params: Record<string, any>, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    const rpcMsg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      if (this.config.transport === 'stdio') {
        this.sendStdio(rpcMsg);
      } else {
        this.sendHttp(rpcMsg).catch((err) => {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(err);
        });
      }
    });
  }

  /** 发送通知 (fire-and-forget, 无 id) */
  private notify(method: string, params: Record<string, any>): void {
    const msg = { jsonrpc: '2.0' as const, method, params };

    if (this.config.transport === 'stdio') {
      this.sendStdioRaw(JSON.stringify(msg));
    } else {
      // HTTP POST fire-and-forget
      this.sendHttpRaw(JSON.stringify(msg)).catch((err) => {
        log.debug('MCP notification send failed', { method, error: err.message });
      });
    }
  }

  private sendStdio(msg: JsonRpcRequest): void {
    this.sendStdioRaw(JSON.stringify(msg));
  }

  private sendStdioRaw(json: string): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP stdio stream not writable');
    }
    this.process.stdin.write(json + '\n');
  }

  /** HTTP transport: POST JSON-RPC 并同步处理响应 */
  private async sendHttp(msg: JsonRpcRequest): Promise<void> {
    const response = await this.sendHttpRaw(JSON.stringify(msg));

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      // 单条 JSON 响应
      const body = await response.json() as JsonRpcResponse;
      this.handleResponse(body);
    } else if (contentType.includes('text/event-stream')) {
      // SSE 流式响应
      await this.consumeSseStream(response);
    }
  }

  private async sendHttpRaw(json: string): Promise<Response> {
    const url = this.sessionUrl || this.config.url!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.config.headers || {}),
    };

    return fetch(url, {
      method: 'POST',
      headers,
      body: json,
    });
  }

  /** 消费 SSE 流并分发到 pending requests */
  private async consumeSseStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let sseBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // SSE 格式: "data: {...}\n\n"
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop() || '';

        for (const event of events) {
          const dataLine = event.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;

          try {
            const json = JSON.parse(dataLine.slice(6)) as JsonRpcResponse;
            this.handleResponse(json);
          } catch {
            log.debug('Failed to parse SSE data', { data: dataLine.slice(0, 200) });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** 分发 JSON-RPC 响应到对应的 pending request */
  private handleResponse(msg: JsonRpcResponse): void {
    if (!msg.id && msg.id !== 0) return; // 通知类消息, 忽略

    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      log.debug('Received response for unknown request', { id: msg.id });
      return;
    }

    this.pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }
}

// ═══════════════════════════════════════
// MCP Manager (全局单例)
// ═══════════════════════════════════════

/**
 * MCP 服务器连接池管理器。
 *
 * 负责:
 * - 维护所有 MCP 连接的生命周期
 * - 聚合所有已发现的工具
 * - 将 MCP 工具代理调用转发到正确的连接
 */
class McpManager {
  private connections = new Map<string, McpConnection>();

  /** 连接一台 MCP 服务器 */
  async connectServer(config: McpServerConfig): Promise<{ success: boolean; tools: McpToolInfo[]; error?: string }> {
    // 先断开旧连接 (如果存在)
    await this.disconnectServer(config.id);

    const conn = new McpConnection(config);
    try {
      await conn.connect();
      this.connections.set(config.id, conn);
      return { success: true, tools: conn.tools };
    } catch (err: any) {
      log.error('Failed to connect MCP server', { serverId: config.id, error: err.message });
      return { success: false, tools: [], error: err.message };
    }
  }

  /** 断开一台 MCP 服务器 */
  async disconnectServer(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (conn) {
      await conn.disconnect();
      this.connections.delete(serverId);
    }
  }

  /** 断开所有 MCP 服务器 */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.keys()).map(id => this.disconnectServer(id));
    await Promise.allSettled(promises);
  }

  /** 获取所有已发现的 MCP 工具 */
  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const conn of this.connections.values()) {
      if (conn.isConnected) {
        tools.push(...conn.tools);
      }
    }
    return tools;
  }

  /** 获取指定服务器的工具 */
  getServerTools(serverId: string): McpToolInfo[] {
    return this.connections.get(serverId)?.tools || [];
  }

  /** 调用 MCP 工具 (自动路由到正确的服务器) */
  async callTool(toolName: string, serverId: string, args: Record<string, any>): Promise<McpToolCallResult> {
    const conn = this.connections.get(serverId);
    if (!conn || !conn.isConnected) {
      return { success: false, content: `MCP server "${serverId}" is not connected` };
    }
    return conn.callTool(toolName, args);
  }

  /** 检查指定服务器是否已连接 */
  isServerConnected(serverId: string): boolean {
    return this.connections.get(serverId)?.isConnected ?? false;
  }

  /** 获取所有连接状态 */
  getConnectionStatuses(): Array<{ serverId: string; connected: boolean; toolCount: number }> {
    const statuses: Array<{ serverId: string; connected: boolean; toolCount: number }> = [];
    for (const [id, conn] of this.connections) {
      statuses.push({
        serverId: id,
        connected: conn.isConnected,
        toolCount: conn.tools.length,
      });
    }
    return statuses;
  }
}

/** 全局 MCP 管理器实例 */
export const mcpManager = new McpManager();
