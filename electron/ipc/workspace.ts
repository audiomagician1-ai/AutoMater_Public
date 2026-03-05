/**
 * Workspace IPC — 读取项目工作区的文件树和内容 + 搜索
 *
 * v21.0: workspace:search (项目内搜索) + workspace:search-global (跨项目搜索)
 *        复用 code-search.ts 的 ripgrep 引擎, 与 Agent 工具共享同一搜索能力
 */

import { ipcMain } from 'electron';
import { getDb } from '../db';
import { readDirectoryTree, readWorkspaceFile } from '../engine/file-writer';
import { codeSearchAsync, codeSearchFiles, type SearchResult, type FileSearchResult } from '../engine/code-search';
import { assertProjectId, assertNonEmptyString } from './ipc-validator';
import { createLogger } from '../engine/logger';
const log = createLogger('ipc:workspace');


function getWorkspacePath(projectId: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT workspace_path FROM projects WHERE id = ?').get(projectId) as { workspace_path?: string } | undefined;
  return row?.workspace_path ?? null;
}

/** 获取所有项目的 workspace_path 列表 (跨项目搜索用) */
function getAllWorkspaces(): Array<{ projectId: string; name: string; workspacePath: string }> {
  const db = getDb();
  const rows = db.prepare("SELECT id, name, workspace_path FROM projects WHERE workspace_path IS NOT NULL AND workspace_path != ''").all() as Array<{ id: string; name: string; workspace_path: string }>;
  return rows.map(r => ({ projectId: r.id, name: r.name, workspacePath: r.workspace_path }));
}

export function setupWorkspaceHandlers() {

  // ── 获取文件树 ──
  ipcMain.handle('workspace:tree', (_event, projectId: string) => {
    assertProjectId('workspace:tree', projectId);
    const wsPath = getWorkspacePath(projectId);
    if (!wsPath) return { success: false, tree: [] };
    return { success: true, tree: readDirectoryTree(wsPath) };
  });

  // ── 读取文件内容 ──
  ipcMain.handle('workspace:read-file', (_event, projectId: string, relativePath: string) => {
    assertProjectId('workspace:read-file', projectId);
    assertNonEmptyString('workspace:read-file', 'relativePath', relativePath);
    const wsPath = getWorkspacePath(projectId);
    if (!wsPath) return { success: false, content: '' };
    const content = readWorkspaceFile(wsPath, relativePath);
    if (content === null) return { success: false, content: '' };
    return { success: true, content };
  });

  // ── 获取工作区路径 ──
  ipcMain.handle('workspace:get-path', (_event, projectId: string) => {
    assertProjectId('workspace:get-path', projectId);
    return getWorkspacePath(projectId);
  });

  // ══════════════ 搜索 (v21.0) ══════════════

  /**
   * 项目内搜索 — 文件名 + 内容搜索统一入口
   *
   * mode = 'filename': glob 文件名搜索 (快速, <50ms)
   * mode = 'content':  ripgrep 正则内容搜索 (带上下文)
   */
  ipcMain.handle('workspace:search', async (
    _event,
    projectId: string,
    query: string,
    options?: {
      mode?: 'filename' | 'content';
      include?: string[];
      caseSensitive?: boolean;
      wholeWord?: boolean;
      maxResults?: number;
      context?: number;
    },
  ) => {
    assertProjectId('workspace:search', projectId);
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return { success: true, mode: options?.mode || 'content', matches: [], files: [], totalMatches: 0, durationMs: 0 };
    }

    const wsPath = getWorkspacePath(projectId);
    if (!wsPath) return { success: false, error: '项目无工作区路径' };

    const mode = options?.mode || 'content';
    const maxResults = Math.min(options?.maxResults || 50, 200);

    try {
      if (mode === 'filename') {
        // 文件名搜索: 将用户输入转为 glob (如 "app" → "**/*app*")
        const globPattern = query.includes('*') ? query : `**/*${query}*`;
        const result: FileSearchResult = codeSearchFiles(wsPath, globPattern, { maxResults });
        return {
          success: true,
          mode: 'filename',
          files: result.files,
          totalMatches: result.totalFound,
          truncated: result.truncated,
          durationMs: 0,
        };
      } else {
        // 内容搜索: ripgrep
        const result: SearchResult = await codeSearchAsync(wsPath, query, {
          include: options?.include,
          caseSensitive: options?.caseSensitive ?? false,
          wholeWord: options?.wholeWord ?? false,
          maxResults,
          context: options?.context ?? 1,
          fixedString: !hasRegexChars(query),  // 自动检测: 无特殊字符时用固定字符串搜索 (更安全)
        });
        return {
          success: true,
          mode: 'content',
          matches: result.matches,
          totalMatches: result.totalMatches,
          truncated: result.truncated,
          engine: result.engine,
          durationMs: result.durationMs,
        };
      }
    } catch (err: any) {
      return { success: false, error: err.message || '搜索失败' };
    }
  });

  /**
   * 全局搜索 — 跨所有项目 + 软件本体搜索
   *
   * 遍历所有有 workspace_path 的项目, 每个项目内执行搜索, 合并结果。
   * 每个项目限制少量结果 (默认 10), 避免过慢。
   */
  ipcMain.handle('workspace:search-global', async (
    _event,
    query: string,
    options?: {
      mode?: 'filename' | 'content';
      caseSensitive?: boolean;
      wholeWord?: boolean;
      maxResultsPerProject?: number;
    },
  ) => {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return { success: true, results: [] };
    }

    const workspaces = getAllWorkspaces();
    const mode = options?.mode || 'content';
    const perProject = Math.min(options?.maxResultsPerProject || 10, 30);
    const start = Date.now();

    const results: Array<{
      projectId: string;
      projectName: string;
      matches?: Array<{ file: string; line: number; content: string }>;
      files?: string[];
      matchCount: number;
    }> = [];

    // 并行搜索所有项目 (Promise.allSettled, 某项目失败不影响其他)
    const tasks = workspaces.map(async (ws) => {
      try {
        if (mode === 'filename') {
          const globPattern = query.includes('*') ? query : `**/*${query}*`;
          const r = codeSearchFiles(ws.workspacePath, globPattern, { maxResults: perProject });
          if (r.files.length > 0) {
            return {
              projectId: ws.projectId,
              projectName: ws.name,
              files: r.files,
              matchCount: r.totalFound,
            };
          }
        } else {
          const r = await codeSearchAsync(ws.workspacePath, query, {
            caseSensitive: options?.caseSensitive ?? false,
            wholeWord: options?.wholeWord ?? false,
            maxResults: perProject,
            context: 0,
            fixedString: !hasRegexChars(query),
          });
          if (r.matches.length > 0) {
            return {
              projectId: ws.projectId,
              projectName: ws.name,
              matches: r.matches.map(m => ({ file: m.file, line: m.line, content: m.content })),
              matchCount: r.totalMatches,
            };
          }
        }
        return null;
      } catch (err) {
        log.debug('Catch at workspace.ts:192', { error: String(err) });
        return null;
      }
    });

    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) {
        results.push(s.value);
      }
    }

    return {
      success: true,
      results,
      totalProjects: workspaces.length,
      searchedProjects: results.length,
      durationMs: Date.now() - start,
    };
  });
}

/** 判断字符串是否包含正则特殊字符 */
function hasRegexChars(s: string): boolean {
  return /[.*+?^${}()|[\]\\]/.test(s);
}
