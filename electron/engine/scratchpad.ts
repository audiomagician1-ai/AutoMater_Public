/**
 * Agent Scratchpad — 外部持久化工作记忆 (v19.0)
 *
 * 核心理念: 不依赖 Agent 自觉记录，由 harness 在关键时刻强制写入。
 *
 * 持久化位置: {workspace}/.automater/scratchpad/{agentId}.json
 * 每个 Agent 独立一个文件，结构化 JSON 存储。
 *
 * 两种写入路径:
 *   1. Harness 自动收集: 文件变更、工具错误、终止原因 — 无需 Agent 主动调用
 *   2. Agent 工具调用: scratchpad_write — Agent 主动记录关键决策/发现
 *
 * 压缩锚点: 每次 compressMessageHistory 后，scratchpad 内容作为 system 级消息注入，
 *           确保关键信息永远不会被压缩丢失。
 *
 * @module scratchpad
 * @since v19.0
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('scratchpad');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ScratchpadEntry {
  /** 条目内容 */
  content: string;
  /** 写入时间戳 */
  timestamp: number;
  /** 来源: harness=系统自动收集, agent=Agent 主动记录 */
  source: 'harness' | 'agent';
}

export interface AgentScratchpad {
  /** Agent 标识 */
  agentId: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;

  /** 关键决策记录 (Agent 主动 + harness 自动) */
  decisions: ScratchpadEntry[];
  /** 已变更的文件列表 (harness 自动收集) */
  filesChanged: ScratchpadEntry[];
  /** 遇到并解决的错误 (harness 自动收集) */
  errorsResolved: ScratchpadEntry[];
  /** 当前进度摘要 (Agent 主动更新) */
  progress: ScratchpadEntry[];
  /** 需要记住的关键事实 (Agent 主动记录) */
  keyFacts: ScratchpadEntry[];

  /** 任务清单 — 取代内存 todo, 持久化到磁盘 */
  todos: TodoItemPersist[];
}

export interface TodoItemPersist {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

// ═══════════════════════════════════════
// Scratchpad Directory
// ═══════════════════════════════════════

function scratchpadDir(workspacePath: string): string {
  return path.join(workspacePath, '.automater', 'scratchpad');
}

function scratchpadFile(workspacePath: string, agentId: string): string {
  // 清理 agentId 中的不安全字符
  const safe = agentId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(scratchpadDir(workspacePath), `${safe}.json`);
}

// ═══════════════════════════════════════
// CRUD Operations
// ═══════════════════════════════════════

/** 读取 Agent 的 scratchpad，不存在则返回空结构 */
export function loadScratchpad(workspacePath: string, agentId: string): AgentScratchpad {
  const filePath = scratchpadFile(workspacePath, agentId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as AgentScratchpad;
      // 兼容旧格式: 补齐字段
      return {
        agentId,
        createdAt: data.createdAt || Date.now(),
        updatedAt: data.updatedAt || Date.now(),
        decisions: data.decisions || [],
        filesChanged: data.filesChanged || [],
        errorsResolved: data.errorsResolved || [],
        progress: data.progress || [],
        keyFacts: data.keyFacts || [],
        todos: data.todos || [],
      };
    }
  } catch (err) {
    log.warn('Failed to load scratchpad, creating fresh', { agentId, error: String(err) });
  }
  return createEmpty(agentId);
}

/** 保存 scratchpad 到磁盘 */
export function saveScratchpad(workspacePath: string, pad: AgentScratchpad): void {
  const dir = scratchpadDir(workspacePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    pad.updatedAt = Date.now();
    const filePath = scratchpadFile(workspacePath, pad.agentId);
    fs.writeFileSync(filePath, JSON.stringify(pad, null, 2), 'utf-8');
  } catch (err) {
    log.error('Failed to save scratchpad', { agentId: pad.agentId, error: String(err) });
  }
}

/** 创建空 scratchpad */
function createEmpty(agentId: string): AgentScratchpad {
  return {
    agentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    decisions: [],
    filesChanged: [],
    errorsResolved: [],
    progress: [],
    keyFacts: [],
    todos: [],
  };
}

// ═══════════════════════════════════════
// Harness 自动收集接口
// ═══════════════════════════════════════

/** [Harness] 记录文件变更 */
export function recordFileChange(
  workspacePath: string, agentId: string,
  filePath: string, action: 'created' | 'modified' | 'deleted',
): void {
  const pad = loadScratchpad(workspacePath, agentId);
  // 去重: 同一文件只保留最新一条
  pad.filesChanged = pad.filesChanged.filter(e => !e.content.startsWith(`[${action}] ${filePath}`));
  pad.filesChanged.push({
    content: `[${action}] ${filePath}`,
    timestamp: Date.now(),
    source: 'harness',
  });
  // 限制总条目
  if (pad.filesChanged.length > 100) {
    pad.filesChanged = pad.filesChanged.slice(-100);
  }
  saveScratchpad(workspacePath, pad);
}

/** [Harness] 记录工具错误 + 后续解决方案 */
export function recordToolError(
  workspacePath: string, agentId: string,
  toolName: string, errorMsg: string,
): void {
  const pad = loadScratchpad(workspacePath, agentId);
  pad.errorsResolved.push({
    content: `[${toolName}] ${errorMsg.slice(0, 500)}`,
    timestamp: Date.now(),
    source: 'harness',
  });
  // 限制总条目
  if (pad.errorsResolved.length > 50) {
    pad.errorsResolved = pad.errorsResolved.slice(-50);
  }
  saveScratchpad(workspacePath, pad);
}

/** [Harness] 记录错误被解决 (同一工具后续成功了) */
export function recordErrorResolved(
  workspacePath: string, agentId: string,
  toolName: string, resolution: string,
): void {
  const pad = loadScratchpad(workspacePath, agentId);
  // 找最近的未解决错误
  for (let i = pad.errorsResolved.length - 1; i >= 0; i--) {
    if (pad.errorsResolved[i].content.startsWith(`[${toolName}]`) && !pad.errorsResolved[i].content.includes(' → ✅')) {
      pad.errorsResolved[i].content += ` → ✅ ${resolution.slice(0, 200)}`;
      break;
    }
  }
  saveScratchpad(workspacePath, pad);
}

/**
 * v20.0: [Harness] 自动更新进度 — 每次文件写入时记录进度
 * 用于 task_checkpoint: 即使上下文被压缩, 恢复后也能知道 "做到哪了"
 */
export function recordProgress(
  workspacePath: string, agentId: string,
  summary: string,
): void {
  const pad = loadScratchpad(workspacePath, agentId);
  // 进度只保留最新 5 条
  pad.progress.push({
    content: summary,
    timestamp: Date.now(),
    source: 'harness',
  });
  if (pad.progress.length > 5) {
    pad.progress = pad.progress.slice(-5);
  }
  saveScratchpad(workspacePath, pad);
}

/**
 * v20.0: [Harness] 自动提取经验 — 当错误被修复时记录 "错误→修复" 模式到项目记忆
 */
export function extractExperience(
  workspacePath: string,
  agentId: string,
  type: 'qa_reject' | 'error_fixed' | 'feature_done',
  description: string,
): void {
  const pad = loadScratchpad(workspacePath, agentId);
  pad.keyFacts.push({
    content: `[${type}] ${description}`,
    timestamp: Date.now(),
    source: 'harness',
  });
  if (pad.keyFacts.length > 30) {
    pad.keyFacts = pad.keyFacts.slice(-30);
  }
  saveScratchpad(workspacePath, pad);

  // 同时写入项目记忆 (persistent across sessions)
  try {
    const memoryPath = path.join(workspacePath, '.automater', 'project-memory.md');
    const dateStr = new Date().toISOString().split('T')[0];
    const line = `\n- [${dateStr}] [${type}] ${description.slice(0, 200)}\n`;
    if (fs.existsSync(memoryPath)) {
      fs.appendFileSync(memoryPath, line, 'utf-8');
    } else {
      const dir = path.join(workspacePath, '.automater');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(memoryPath, `# 项目记忆\n\n## 自动提取的经验\n${line}`, 'utf-8');
    }
  } catch (err) {
    log.warn('Failed to write experience to project memory', { error: String(err) });
  }
}

/**
 * v20.0: 获取所有 Worker 的 scratchpad 文件变更摘要 (用于跨 Worker 信息共享)
 */
export function getOtherWorkersChanges(
  workspacePath: string,
  currentAgentId: string,
): string {
  const dir = scratchpadDir(workspacePath);
  try {
    if (!fs.existsSync(dir)) return '';
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const sections: string[] = [];

    for (const file of files) {
      const agentId = file.replace('.json', '');
      if (agentId === currentAgentId.replace(/[^a-zA-Z0-9_\-]/g, '_')) continue;

      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
        const pad = JSON.parse(raw) as AgentScratchpad;
        // 只取最近的变更
        const recentFiles = pad.filesChanged.slice(-10);
        const recentDecisions = pad.decisions.slice(-3);
        if (recentFiles.length === 0 && recentDecisions.length === 0) continue;

        const lines: string[] = [`### ${pad.agentId} 的最新变更`];
        if (recentFiles.length > 0) {
          lines.push(...recentFiles.map(e => `- ${e.content}`));
        }
        if (recentDecisions.length > 0) {
          lines.push('决策:');
          lines.push(...recentDecisions.map(e => `- ${e.content}`));
        }
        sections.push(lines.join('\n'));
      } catch (err) { continue; }
    }

    if (sections.length === 0) return '';
    return `## 🔄 其他 Worker 的最新变更\n\n${sections.join('\n\n')}`;
  } catch (err) { return ''; }
}

// ═══════════════════════════════════════
// Agent 工具接口 (scratchpad_write / scratchpad_read)
// ═══════════════════════════════════════

/**
 * Agent 主动写入 scratchpad
 * category: 写入的分类
 * content: 写入的内容
 */
export function agentScratchpadWrite(
  workspacePath: string, agentId: string,
  category: 'decision' | 'progress' | 'key_fact',
  content: string,
): string {
  const pad = loadScratchpad(workspacePath, agentId);
  const entry: ScratchpadEntry = { content, timestamp: Date.now(), source: 'agent' };

  switch (category) {
    case 'decision':
      pad.decisions.push(entry);
      if (pad.decisions.length > 30) pad.decisions = pad.decisions.slice(-30);
      break;
    case 'progress':
      // progress 只保留最新 5 条
      pad.progress.push(entry);
      if (pad.progress.length > 5) pad.progress = pad.progress.slice(-5);
      break;
    case 'key_fact':
      pad.keyFacts.push(entry);
      if (pad.keyFacts.length > 20) pad.keyFacts = pad.keyFacts.slice(-20);
      break;
  }
  saveScratchpad(workspacePath, pad);
  return `✅ 已记录到 scratchpad [${category}]: ${content.slice(0, 80)}...`;
}

/**
 * Agent 读取自己的 scratchpad (全量)
 */
export function agentScratchpadRead(workspacePath: string, agentId: string): string {
  const pad = loadScratchpad(workspacePath, agentId);
  return formatScratchpadForContext(pad);
}

// ═══════════════════════════════════════
// Todo 持久化 (替代内存 Map)
// ═══════════════════════════════════════

export function todoWritePersist(workspacePath: string, agentId: string, todos: TodoItemPersist[]): string {
  const pad = loadScratchpad(workspacePath, agentId);
  pad.todos = todos;
  saveScratchpad(workspacePath, pad);
  const pending = todos.filter(t => t.status === 'pending').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const completed = todos.filter(t => t.status === 'completed').length;
  return `任务列表已更新 (${todos.length} 项: ${completed} 完成, ${inProgress} 进行中, ${pending} 待办) [已持久化]`;
}

export function todoReadPersist(workspacePath: string, agentId: string): string {
  const pad = loadScratchpad(workspacePath, agentId);
  const todos = pad.todos;
  if (!todos || todos.length === 0) return '(无任务列表)';

  const icons: Record<string, string> = { completed: '✅', in_progress: '🔄', pending: '⬜' };
  const lines = todos.map((t, i) =>
    `${icons[t.status] || '⬜'} [${i}] ${t.content}${t.priority === 'high' ? ' 🔴' : t.priority === 'low' ? ' 🟢' : ''}`
  );
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const pending = todos.length - inProgress - completed;
  return `任务列表 (${completed}/${todos.length} 完成, ${inProgress} 进行中, ${pending} 待办):\n${lines.join('\n')}`;
}

// ═══════════════════════════════════════
// 上下文注入 — 压缩后的锚点消息
// ═══════════════════════════════════════

/**
 * 格式化 scratchpad 为上下文注入文本
 * 用于压缩后作为 system/user 锚点消息注入
 */
export function formatScratchpadForContext(pad: AgentScratchpad): string {
  const sections: string[] = [];

  // 进度摘要
  if (pad.progress.length > 0) {
    const latest = pad.progress.slice(-3);
    sections.push(`## 📊 当前进度\n${latest.map(e => `- ${e.content}`).join('\n')}`);
  }

  // Todo
  if (pad.todos.length > 0) {
    const todoLines = pad.todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      return `${icon} ${t.content}`;
    });
    sections.push(`## 📋 任务清单\n${todoLines.join('\n')}`);
  }

  // 关键决策 (最近 10 条)
  if (pad.decisions.length > 0) {
    const recent = pad.decisions.slice(-10);
    sections.push(`## 🎯 关键决策\n${recent.map(e => `- ${e.content}`).join('\n')}`);
  }

  // 关键事实
  if (pad.keyFacts.length > 0) {
    const recent = pad.keyFacts.slice(-10);
    sections.push(`## 💡 关键事实\n${recent.map(e => `- ${e.content}`).join('\n')}`);
  }

  // 文件变更摘要 (只列最新 20 个)
  if (pad.filesChanged.length > 0) {
    const recent = pad.filesChanged.slice(-20);
    sections.push(`## 📁 已变更文件 (${pad.filesChanged.length} 个)\n${recent.map(e => `- ${e.content}`).join('\n')}`);
  }

  // 错误记录 (只列最近 5 条)
  if (pad.errorsResolved.length > 0) {
    const recent = pad.errorsResolved.slice(-5);
    sections.push(`## ⚠️ 近期错误\n${recent.map(e => `- ${e.content}`).join('\n')}`);
  }

  if (sections.length === 0) {
    return '(scratchpad 为空 — 尚无记录)';
  }

  return `# 🧠 Agent 工作记忆 (Scratchpad)\n\n${sections.join('\n\n')}`;
}

/**
 * 生成压缩后注入的锚点消息 (LLMMessage 格式)
 * 只在 scratchpad 有内容时才生成
 */
export function buildScratchpadAnchor(
  workspacePath: string, agentId: string,
): { role: 'user'; content: string } | null {
  if (!workspacePath) return null;
  const pad = loadScratchpad(workspacePath, agentId);
  const totalEntries = pad.decisions.length + pad.filesChanged.length +
    pad.errorsResolved.length + pad.progress.length +
    pad.keyFacts.length + pad.todos.length;
  if (totalEntries === 0) return null;

  return {
    role: 'user',
    content: formatScratchpadForContext(pad) + '\n\n---\n*以上为持久化工作记忆，来自上下文压缩前的累计记录。请基于此继续工作。*',
  };
}

// ═══════════════════════════════════════
// Observation Masking — 旧工具输出结构化摘要
// ═══════════════════════════════════════

/**
 * 将旧 tool 输出替换为一行结构化摘要 (Observation Masking)
 *
 * 与 compressToolOutputs 的区别:
 *   - compressToolOutputs: 暴力截断 (前 N 字符)
 *   - maskOldToolOutputs: 结构化摘要 (提取文件名、错误、关键信息)
 *
 * 在 compressMessageHistorySmart 之前调用，减少 summarizer 的输入量。
 */
export function maskOldToolOutputs(
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>,
  keepRecent: number = 8,
): { maskedCount: number; estimatedTokensSaved: number } {
  const cutoff = Math.max(1, messages.length - keepRecent);
  let maskedCount = 0;
  let tokensSaved = 0;

  for (let i = 1; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;

    const content = msg.content as string;
    if (content.length <= 200) continue; // 短内容不需要 mask

    const masked = generateObservationMask(content);
    if (masked.length < content.length * 0.7) {
      tokensSaved += Math.ceil((content.length - masked.length) / 1.5);
      msg.content = masked;
      maskedCount++;
    }
  }

  return { maskedCount, estimatedTokensSaved: tokensSaved };
}

/**
 * 对单条 tool output 生成结构化摘要
 */
function generateObservationMask(content: string): string {
  const lines = content.split('\n');

  // 检测内容类型并做不同处理
  // 1. 文件内容 (read_file output)
  if (lines.some(l => /^\s*\d+\|/.test(l))) {
    return maskFileContent(content);
  }

  // 2. 搜索结果 (多个文件:行号 pattern)
  if (lines.filter(l => /^\S+:\d+:/.test(l)).length > 3) {
    return maskSearchResults(content);
  }

  // 3. 命令输出 (含 exit code 或错误)
  if (content.includes('exit code') || content.includes('Exit code') || content.includes('FAIL') || content.includes('ERROR')) {
    return maskCommandOutput(content);
  }

  // 4. 目录树
  if (lines.filter(l => /^[\s│├└─]+/.test(l) || /^\s+\S+\/$/.test(l)).length > lines.length * 0.5) {
    return maskDirectoryTree(content);
  }

  // 5. 通用: 保留首尾 + 统计
  return maskGeneric(content);
}

function maskFileContent(content: string): string {
  const lines = content.split('\n');
  const totalLines = lines.length;
  // 保留前 5 行 + 后 3 行
  const head = lines.slice(0, 5).join('\n');
  const tail = lines.slice(-3).join('\n');
  return `[文件内容: ${totalLines} 行]\n${head}\n... [${totalLines - 8} 行已折叠]\n${tail}`;
}

function maskSearchResults(content: string): string {
  const lines = content.split('\n');
  const matchLines = lines.filter(l => /^\S+:\d+:/.test(l));
  const files = new Set(matchLines.map(l => l.split(':')[0]));
  return `[搜索结果: ${matchLines.length} 处匹配, 涉及 ${files.size} 个文件]\n${matchLines.slice(0, 5).join('\n')}${matchLines.length > 5 ? `\n... 及其他 ${matchLines.length - 5} 处匹配` : ''}`;
}

function maskCommandOutput(content: string): string {
  const lines = content.split('\n');
  // 提取错误行
  const errorLines = lines.filter(l => /error|ERROR|fail|FAIL|warning|WARN/i.test(l));
  const exitMatch = content.match(/exit code[:\s]*(\d+)/i);
  const exitCode = exitMatch ? exitMatch[1] : '?';
  const head = lines.slice(0, 3).join('\n');
  const errSummary = errorLines.length > 0
    ? `\n关键错误:\n${errorLines.slice(0, 5).join('\n')}`
    : '';
  return `[命令输出: ${lines.length} 行, exit=${exitCode}]\n${head}${errSummary}${errorLines.length > 5 ? `\n... 及其他 ${errorLines.length - 5} 条错误` : ''}`;
}

function maskDirectoryTree(content: string): string {
  const lines = content.split('\n');
  const fileCount = lines.filter(l => !l.endsWith('/')).length;
  const dirCount = lines.filter(l => l.endsWith('/') || l.includes('/')).length;
  return `[目录树: ~${fileCount} 文件, ~${dirCount} 目录]\n${lines.slice(0, 8).join('\n')}\n... [剩余 ${lines.length - 8} 行已折叠]`;
}

function maskGeneric(content: string): string {
  const lines = content.split('\n');
  if (lines.length <= 10) return content; // 短内容不 mask
  const head = lines.slice(0, 4).join('\n');
  const tail = lines.slice(-3).join('\n');
  return `[输出: ${lines.length} 行, ${content.length} 字符]\n${head}\n... [${lines.length - 7} 行已折叠]\n${tail}`;
}

// ═══════════════════════════════════════
// 清理
// ═══════════════════════════════════════

/** 清理指定 Agent 的 scratchpad */
export function clearScratchpad(workspacePath: string, agentId: string): void {
  const filePath = scratchpadFile(workspacePath, agentId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    log.warn('Failed to clear scratchpad', { agentId, error: String(err) });
  }
}

/** 列出工作区内所有 scratchpad 文件 */
export function listScratchpads(workspacePath: string): string[] {
  const dir = scratchpadDir(workspacePath);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch (err) {
    log.debug('Catch at scratchpad.ts:589', { error: String(err) });
    return [];
  }
}
