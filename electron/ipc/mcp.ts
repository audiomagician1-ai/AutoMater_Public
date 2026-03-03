/**
 * MCP & Skill IPC Handlers — 管理 MCP 服务器连接 + 技能目录
 *
 * 提供以下 IPC 通道:
 *   mcp:list-servers      — 列出所有已配置的 MCP 服务器及连接状态
 *   mcp:add-server        — 添加 MCP 服务器配置
 *   mcp:update-server     — 更新 MCP 服务器配置
 *   mcp:remove-server     — 移除 MCP 服务器配置
 *   mcp:connect-server    — 连接指定 MCP 服务器
 *   mcp:disconnect-server — 断开指定 MCP 服务器
 *   mcp:list-tools        — 列出所有已发现的 MCP 工具
 *   mcp:test-server       — 测试 MCP 服务器连接
 *   skill:set-directory   — 设置技能目录
 *   skill:reload          — 重新扫描技能目录
 *   skill:list            — 列出所有已加载技能
 *
 * @module ipc/mcp
 * @since v5.0.0
 */

import { ipcMain } from 'electron';
import { getDb } from '../db';
import { mcpManager, type McpServerConfig } from '../engine/mcp-client';
import { skillManager, type SkillScanResult } from '../engine/skill-loader';
import { skillEvolution } from '../engine/skill-evolution';
import { createLogger, toErrorMessage } from '../engine/logger';
import { assertNonEmptyString, assertObject } from './ipc-validator';

const log = createLogger('ipc:mcp');

// ═══════════════════════════════════════
// Persistence Helpers
// ═══════════════════════════════════════

const SETTINGS_KEY_MCP = 'mcp_servers';
const SETTINGS_KEY_SKILL = 'skill_directory';

function loadMcpConfigs(): McpServerConfig[] {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY_MCP) as { value: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.value);
  } catch { /* silent: MCP config JSON parse failed */
    return [];
  }
}

function saveMcpConfigs(configs: McpServerConfig[]): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    SETTINGS_KEY_MCP,
    JSON.stringify(configs),
  );
}

function loadSkillDirectory(): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY_SKILL) as { value: string } | undefined;
  return row?.value || '';
}

function saveSkillDirectory(dirPath: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SETTINGS_KEY_SKILL, dirPath);
}

// ═══════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════

export function setupMcpHandlers(): void {
  // ── MCP Servers ──

  ipcMain.handle('mcp:list-servers', () => {
    const configs = loadMcpConfigs();
    const statuses = mcpManager.getConnectionStatuses();
    const statusMap = new Map(statuses.map(s => [s.serverId, s]));

    return configs.map(c => ({
      ...c,
      connected: statusMap.get(c.id)?.connected ?? false,
      toolCount: statusMap.get(c.id)?.toolCount ?? 0,
    }));
  });

  ipcMain.handle('mcp:add-server', (_event, config: Omit<McpServerConfig, 'id'>) => {
    assertObject('mcp:add-server', 'config', config);
    assertNonEmptyString('mcp:add-server', 'name', (config as Record<string, unknown>).name);
    const configs = loadMcpConfigs();
    const id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newConfig: McpServerConfig = { ...config, id };
    configs.push(newConfig);
    saveMcpConfigs(configs);
    log.info('MCP server added', { id, name: config.name });
    return { success: true, id };
  });

  ipcMain.handle('mcp:update-server', (_event, id: string, updates: Partial<McpServerConfig>) => {
    assertNonEmptyString('mcp:update-server', 'id', id);
    assertObject('mcp:update-server', 'updates', updates);
    const configs = loadMcpConfigs();
    const index = configs.findIndex(c => c.id === id);
    if (index === -1) return { success: false, error: 'Server not found' };

    configs[index] = { ...configs[index], ...updates, id };
    saveMcpConfigs(configs);
    log.info('MCP server updated', { id });
    return { success: true };
  });

  ipcMain.handle('mcp:remove-server', async (_event, id: string) => {
    assertNonEmptyString('mcp:remove-server', 'id', id);
    // 先断开连接
    await mcpManager.disconnectServer(id);

    const configs = loadMcpConfigs();
    const filtered = configs.filter(c => c.id !== id);
    saveMcpConfigs(filtered);
    log.info('MCP server removed', { id });
    return { success: true };
  });

  ipcMain.handle('mcp:connect-server', async (_event, id: string) => {
    assertNonEmptyString('mcp:connect-server', 'id', id);
    const configs = loadMcpConfigs();
    const config = configs.find(c => c.id === id);
    if (!config) return { success: false, error: 'Server config not found' };

    const result = await mcpManager.connectServer(config);
    return result;
  });

  ipcMain.handle('mcp:disconnect-server', async (_event, id: string) => {
    assertNonEmptyString('mcp:disconnect-server', 'id', id);
    await mcpManager.disconnectServer(id);
    return { success: true };
  });

  ipcMain.handle('mcp:list-tools', () => {
    return mcpManager.getAllTools();
  });

  ipcMain.handle('mcp:test-server', async (_event, config: McpServerConfig) => {
    assertObject('mcp:test-server', 'config', config);
    try {
      const result = await mcpManager.connectServer(config);
      if (result.success) {
        // 测试完立刻断开
        await mcpManager.disconnectServer(config.id);
      }
      return result;
    } catch (err: unknown) {
      return { success: false, tools: [], error: toErrorMessage(err) };
    }
  });

  // ── Skill Directory ──

  ipcMain.handle('skill:get-directory', () => {
    return loadSkillDirectory();
  });

  ipcMain.handle('skill:set-directory', (_event, dirPath: string) => {
    assertNonEmptyString('skill:set-directory', 'dirPath', dirPath);
    saveSkillDirectory(dirPath);
    if (dirPath) {
      const result = skillManager.loadFromDirectory(dirPath);
      log.info('Skill directory set', { path: dirPath, loaded: result.skills.length });
      return { success: true, ...formatScanResult(result) };
    }
    return { success: true, loaded: 0, errors: [] };
  });

  ipcMain.handle('skill:reload', () => {
    const result = skillManager.reload();
    return { success: true, ...formatScanResult(result) };
  });

  ipcMain.handle('skill:list', () => {
    const defs = skillManager.getAllDefinitions();
    return defs.map(d => ({
      name: d.name,
      description: d.description,
    }));
  });

  // ── Skill Evolution (v5.1) ──

  ipcMain.handle('skill-evolution:get-index', () => {
    return skillEvolution.getIndex();
  });

  ipcMain.handle('skill-evolution:get-overview', () => {
    return skillEvolution.getOverview();
  });

  ipcMain.handle('skill-evolution:get-skill', (_event, skillId: string) => {
    assertNonEmptyString('skill-evolution:get-skill', 'skillId', skillId);
    return skillEvolution.loadSkill(skillId);
  });

  ipcMain.handle('skill-evolution:get-knowledge', (_event, skillId: string) => {
    assertNonEmptyString('skill-evolution:get-knowledge', 'skillId', skillId);
    return skillEvolution.loadKnowledge(skillId);
  });

  ipcMain.handle('skill-evolution:deprecate', (_event, skillId: string, reason: string) => {
    assertNonEmptyString('skill-evolution:deprecate', 'skillId', skillId);
    assertNonEmptyString('skill-evolution:deprecate', 'reason', reason);
    const ok = skillEvolution.deprecate(skillId, reason);
    return { success: ok };
  });

  ipcMain.handle('skill-evolution:get-ranked', () => {
    return skillEvolution.getRankedSkills();
  });
}

function formatScanResult(result: SkillScanResult) {
  return {
    loaded: result.skills.length,
    skills: result.skills.map(s => ({
      name: s.definition.name,
      description: s.definition.description,
      sourceFile: s.sourceFile,
    })),
    errors: result.errors,
  };
}

// ═══════════════════════════════════════
// Startup: 自动连接 + 加载
// ═══════════════════════════════════════

/**
 * 应用启动时调用: 自动连接 enabled 的 MCP 服务器, 加载技能目录。
 * 失败不阻塞启动。
 */
export async function initMcpAndSkills(): Promise<void> {
  // 1. 加载技能目录 (静态外部 skills)
  const skillDir = loadSkillDirectory();
  if (skillDir) {
    try {
      const result = skillManager.loadFromDirectory(skillDir);
      log.info('Skills auto-loaded on startup', { count: result.skills.length });
    } catch (err: unknown) {
      log.warn('Failed to load skill directory on startup', { error: toErrorMessage(err) });
    }
  }

  // 2. 初始化技能进化系统 (自主习得的 skills)
  try {
    skillEvolution.ensureInitialized();
    const overview = skillEvolution.getOverview();
    log.info('Skill evolution initialized', { total: overview.total, byMaturity: overview.byMaturity });
  } catch (err: unknown) {
    log.warn('Failed to initialize skill evolution', { error: toErrorMessage(err) });
  }

  // 2. 自动连接 enabled 的 MCP 服务器
  const configs = loadMcpConfigs();
  const enabledConfigs = configs.filter(c => c.enabled);

  for (const config of enabledConfigs) {
    try {
      const result = await mcpManager.connectServer(config);
      if (result.success) {
        log.info('MCP server auto-connected', { id: config.id, name: config.name, tools: result.tools.length });
      } else {
        log.warn('MCP server auto-connect failed', { id: config.id, error: result.error });
      }
    } catch (err: unknown) {
      log.warn('MCP server auto-connect error', { id: config.id, error: toErrorMessage(err) });
    }
  }
}

/**
 * 应用退出前调用: 断开所有 MCP 连接。
 */
export async function shutdownMcpAndSkills(): Promise<void> {
  await mcpManager.disconnectAll();
  log.info('All MCP connections closed');
}
