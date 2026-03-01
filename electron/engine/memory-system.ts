/**
 * Memory System — 3-layer Agent 记忆系统 (v1.2)
 *
 * 三层结构 (参照 Factory Droids):
 * 1. Global Memory — %APPDATA%/agentforge/global-memory.md
 *    用户偏好/coding style/通用经验，跨项目共享
 * 2. Project Memory — {workspace}/.agentforge/project-memory.md
 *    架构决策/踩坑记录/项目约定
 * 3. Agent Role Memory — {workspace}/.agentforge/memories/{role}.md
 *    per-role 经验 (pm/developer/qa/architect)
 *
 * 所有记忆用 Markdown 存储，Agent 可通过工具读写。
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

// ═══════════════════════════════════════
// 路径辅助
// ═══════════════════════════════════════

/** Global memory 路径: %APPDATA%/agentforge/global-memory.md */
function getGlobalMemoryPath(): string {
  return path.join(app.getPath('userData'), 'global-memory.md');
}

/** Project memory 基目录: {workspace}/.agentforge/ */
function getProjectMemoryDir(workspacePath: string): string {
  return path.join(workspacePath, '.agentforge');
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
  } catch { /* ignore */ }
  return '';
}

export function readProjectMemory(workspacePath: string): string {
  try {
    const p = getProjectMemoryPath(workspacePath);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch { /* ignore */ }
  return '';
}

export function readRoleMemory(workspacePath: string, role: string): string {
  try {
    const p = getRoleMemoryPath(workspacePath, role);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch { /* ignore */ }
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
  fs.writeFileSync(p, `# Global Memory — AgentForge 全局记忆
> 跨项目共享的用户偏好和通用经验。Agent 和用户均可编辑。

## 用户偏好
- (在此添加你的编码风格偏好、命名规范等)

## 通用经验
- (AgentForge 会自动积累跨项目经验)
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
