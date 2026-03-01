/**
 * FileWriter — 解析 LLM 输出中的文件块并写入工作区
 * 
 * LLM 输出格式约定:
 *   <<<FILE:relative/path/to/file>>>
 *   ...file content...
 *   <<<END>>>
 * 
 * 一次 LLM 回复可包含多个 FILE 块
 */

import fs from 'fs';
import path from 'path';

export interface WrittenFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

/**
 * 从 LLM 原始文本中提取所有 FILE 块
 */
export function parseFileBlocks(raw: string): Array<{ path: string; content: string }> {
  const blocks: Array<{ path: string; content: string }> = [];
  const regex = /<<<FILE:(.+?)>>>\n([\s\S]*?)<<<END>>>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const filePath = match[1].trim();
    let content = match[2];
    // 移除尾部多余空行（保留一个换行）
    content = content.replace(/\n+$/, '\n');
    blocks.push({ path: filePath, content });
  }
  return blocks;
}

/**
 * 将解析出的文件块写入工作区目录
 * - 自动创建子目录
 * - 返回写入的文件列表
 */
export function writeFileBlocks(
  workspacePath: string,
  blocks: Array<{ path: string; content: string }>
): WrittenFile[] {
  const written: WrittenFile[] = [];

  for (const block of blocks) {
    // 安全检查：禁止 .. 穿越
    const normalized = path.normalize(block.path);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      console.warn(`[FileWriter] Skipping unsafe path: ${block.path}`);
      continue;
    }

    const absPath = path.join(workspacePath, normalized);
    const dir = path.dirname(absPath);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, block.content, 'utf-8');

    written.push({
      relativePath: normalized.replace(/\\/g, '/'),
      absolutePath: absPath,
      size: Buffer.byteLength(block.content, 'utf-8'),
    });
  }

  return written;
}

/**
 * 递归读取目录树（轻量版，限制深度和数量）
 */
export interface FileNode {
  name: string;
  path: string;      // 相对于 workspace 的路径
  type: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

export function readDirectoryTree(
  workspacePath: string,
  relativePath: string = '',
  maxDepth: number = 6,
  currentDepth: number = 0
): FileNode[] {
  if (currentDepth >= maxDepth) return [];

  const absDir = path.join(workspacePath, relativePath);
  if (!fs.existsSync(absDir)) return [];

  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const nodes: FileNode[] = [];
  
  // 忽略列表
  const ignoreSet = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', 'dist', '.next']);

  for (const entry of entries) {
    if (ignoreSet.has(entry.name)) continue;

    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'dir',
        children: readDirectoryTree(workspacePath, relPath, maxDepth, currentDepth + 1),
      });
    } else {
      const stat = fs.statSync(path.join(absDir, entry.name));
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
      });
    }
  }

  // 排序：目录在前，文件在后，各自按名称排
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/**
 * 安全读取工作区内的文件内容
 */
export function readWorkspaceFile(workspacePath: string, relativePath: string): string | null {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return null;

  const absPath = path.join(workspacePath, normalized);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;

  // 限制大小（1MB）
  const stat = fs.statSync(absPath);
  if (stat.size > 1024 * 1024) return `[文件过大: ${(stat.size / 1024).toFixed(0)} KB, 超过 1MB 限制]`;

  return fs.readFileSync(absPath, 'utf-8');
}
