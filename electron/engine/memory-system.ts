/**
 * Memory System — 3-layer Agent 记忆系统 (v1.2)
 *
 * 三层结构 (参照 Factory Droids):
 * 1. Global Memory — %APPDATA%/automater/global-memory.md
 *    用户偏好/coding style/通用经验，跨项目共享
 * 2. Project Memory — {workspace}/.automater/project-memory.md
 *    架构决策/踩坑记录/项目约定
 * 3. Agent Role Memory — {workspace}/.automater/memories/{role}.md
 *    per-role 经验 (pm/developer/qa/architect)
 *
 * 所有记忆用 Markdown 存储，Agent 可通过工具读写。
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { createLogger } from './logger';
const log = createLogger('memory-system');


// ═══════════════════════════════════════
// 路径辅助
// ═══════════════════════════════════════

/** Global memory 路径: %APPDATA%/automater/global-memory.md */
function getGlobalMemoryPath(): string {
  return path.join(app.getPath('userData'), 'global-memory.md');
}

/** Project memory 基目录: {workspace}/.automater/ */
function getProjectMemoryDir(workspacePath: string): string {
  return path.join(workspacePath, '.automater');
}

function getProjectMemoryPath(workspacePath: string): string {
  return path.join(getProjectMemoryDir(workspacePath), 'project-memory.md');
}

function getRoleMemoryPath(workspacePath: string, role: string): string {
  return path.join(getProjectMemoryDir(workspacePath), 'memories', `${role}.md`);
}

// ═══════════════════════════════════════
// 读取记忆
// ═══════════════════════════════════════

export function readGlobalMemory(): string {
  try {
    const p = getGlobalMemoryPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    log.debug('Global memory read failed', { error: String(err) });
  }
  return '';
}

export function readProjectMemory(workspacePath: string): string {
  try {
    const p = getProjectMemoryPath(workspacePath);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    log.debug('Project memory read failed', { error: String(err) });
  }
  return '';
}

export function readRoleMemory(workspacePath: string, role: string): string {
  try {
    const p = getRoleMemoryPath(workspacePath, role);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    log.debug('Role memory read failed', { error: String(err) });
  }
  return '';
}

/**
 * 读取 Agent 需要的完整记忆上下文。
 * 按角色返回不同组合:
 * - PM: global + project
 * - Architect: global + project
 * - Developer: global + project + developer role memory
 * - QA: global + project + qa role memory
 */
export function readMemoryForRole(
  workspacePath: string,
  role: string
): { global: string; project: string; role: string; combined: string } {
  const global = readGlobalMemory();
  const project = readProjectMemory(workspacePath);
  const roleMem = readRoleMemory(workspacePath, role);

  const sections: string[] = [];
  if (global) sections.push(`## 全局记忆 (Global Memory)\n${global}`);
  if (project) sections.push(`## 项目记忆 (Project Memory)\n${project}`);
  if (roleMem) sections.push(`## 角色记忆 (${role})\n${roleMem}`);

  return {
    global,
    project,
    role: roleMem,
    combined: sections.join('\n\n'),
  };
}

// ═══════════════════════════════════════
// 写入记忆
// ═══════════════════════════════════════

export function writeGlobalMemory(content: string): void {
  const p = getGlobalMemoryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

export function writeProjectMemory(workspacePath: string, content: string): void {
  const p = getProjectMemoryPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

export function writeRoleMemory(workspacePath: string, role: string, content: string): void {
  const p = getRoleMemoryPath(workspacePath, role);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
}

// ═══════════════════════════════════════
// 追加记忆条目 (append 模式)
// ═══════════════════════════════════════

function appendToFile(filePath: string, entry: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19);
  const line = `\n- [${timestamp}] ${entry}\n`;
  fs.appendFileSync(filePath, line, 'utf-8');
}

export function appendGlobalMemory(entry: string): void {
  appendToFile(getGlobalMemoryPath(), entry);
}

export function appendProjectMemory(workspacePath: string, entry: string): void {
  appendToFile(getProjectMemoryPath(workspacePath), entry);
}

export function appendRoleMemory(workspacePath: string, role: string, entry: string): void {
  appendToFile(getRoleMemoryPath(workspacePath, role), entry);
}

// ═══════════════════════════════════════
// Auto Lessons Learned — QA fail→fix 经验提取
// ═══════════════════════════════════════

export interface LessonLearned {
  featureId: string;
  qaAttempt: number;
  qaFeedback: string;
  fixSummary: string;
  lesson: string;
}

/**
 * 从 QA 反馈和修复摘要中提取经验教训 (同步方式写入)
 * 返回的 lesson 文本会写入 project memory
 */
export function recordLessonLearned(
  workspacePath: string,
  lesson: LessonLearned
): void {
  const entry = [
    `**Feature ${lesson.featureId}** (QA attempt ${lesson.qaAttempt})`,
    `  - 问题: ${lesson.qaFeedback.slice(0, 200)}`,
    `  - 修复: ${lesson.fixSummary.slice(0, 200)}`,
    `  - 经验: ${lesson.lesson}`,
  ].join('\n');

  appendProjectMemory(workspacePath, entry);
}

/**
 * 使用 LLM 从 QA 反馈 + fix diff 自动提取经验教训。
 * 返回提取的 lesson 文本（由调用方决定是否写入）。
 * 这是一个纯函数 — 不做 LLM 调用，只格式化 prompt。
 */
export function buildLessonExtractionPrompt(
  featureId: string,
  qaFeedback: string,
  fixedFiles: string[],
  fixSummary: string
): string {
  return `你是一个经验总结助手。请从以下 QA 失败→修复过程中提取 1-3 条简短、可复用的经验教训。

## Feature: ${featureId}
## QA 反馈 (问题)
${qaFeedback.slice(0, 500)}

## 修复涉及文件
${fixedFiles.join(', ')}

## 修复摘要
${fixSummary.slice(0, 500)}

请输出 1-3 条经验（每条一行，以"- "开头），每条不超过 80 字。只输出经验，不要其他内容。
示例:
- 在 TypeScript 项目中修改 import 路径后要同时更新所有引用
- 新增 API endpoint 后必须同时添加对应的路由注册`;
}

// ═══════════════════════════════════════
// 初始化 — 确保默认 memory 文件存在
// ═══════════════════════════════════════

export function ensureGlobalMemory(): void {
  const p = getGlobalMemoryPath();
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `# Global Memory — AutoMater 全局记忆
> 跨项目共享的用户偏好和通用经验。Agent 和用户均可编辑。

## 用户偏好
- (在此添加你的编码风格偏好、命名规范等)

## 通用经验
- (AutoMater 会自动积累跨项目经验)
`, 'utf-8');
}

export function ensureProjectMemory(workspacePath: string): void {
  const p = getProjectMemoryPath(workspacePath);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `# Project Memory — 项目记忆
> 本项目的架构决策、踩坑记录、约定。Agent 在每次开发时自动读取。

## 架构决策

## 踩过的坑

## 经验教训 (Auto Lessons Learned)
`, 'utf-8');
}

// ═══════════════════════════════════════
// v1.2: Shared Decision Log — Worker 间共享决策日志
// ═══════════════════════════════════════

export interface SharedDecision {
  timestamp: string;
  agentId: string;
  featureId: string;
  type: 'file_created' | 'interface_defined' | 'library_chosen' | 'convention' | 'other';
  description: string;
}

function getDecisionLogPath(workspacePath: string): string {
  return path.join(getProjectMemoryDir(workspacePath), 'shared-decisions.jsonl');
}

/** 追加一条共享决策 */
export function appendSharedDecision(workspacePath: string, decision: Omit<SharedDecision, 'timestamp'>): void {
  const p = getDecisionLogPath(workspacePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry: SharedDecision = { ...decision, timestamp: new Date().toISOString() };
  fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf-8');
}

/** 读取最近 N 条共享决策 */
export function readRecentDecisions(workspacePath: string, limit: number = 30): SharedDecision[] {
  const p = getDecisionLogPath(workspacePath);
  if (!fs.existsSync(p)) return [];
  try {
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
    const decisions: SharedDecision[] = [];
    for (const line of lines.slice(-limit)) {
      try { decisions.push(JSON.parse(line)); } catch (err) { /* skip bad lines */ }
    }
    return decisions;
  } catch (err) { return []; }
}

/** 格式化决策日志为上下文文本 */
export function formatDecisionsForContext(decisions: SharedDecision[], excludeAgent?: string): string {
  if (decisions.length === 0) return '';
  // 过滤掉当前 agent 自己的决策（避免重复）
  const relevant = excludeAgent
    ? decisions.filter(d => d.agentId !== excludeAgent)
    : decisions;
  if (relevant.length === 0) return '';

  const lines = relevant.map(d => {
    const time = d.timestamp.slice(11, 19);
    return `- [${time}] ${d.agentId} (${d.featureId}): [${d.type}] ${d.description}`;
  });
  return `## 其他 Worker 的决策 (Shared Decision Log)\n${lines.join('\n')}`;
}
