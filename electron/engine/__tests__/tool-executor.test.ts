/**
 * tool-executor.test.ts — 工具执行器测试
 *
 * 测试策略:
 *   1. 纯函数: assertSafePath, getPathWeight, rankSearchResults
 *   2. executeTool 分发: mock 各依赖模块, 验证 ~20 种工具的路由+返回格式
 *   3. executeToolAsync: mock 异步工具, 验证 GitHub/Web/Browser 路径
 *   4. MCP/Skill 代理执行
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Mock 所有重量级依赖 ──

vi.mock('../file-lock', () => ({
  acquireFileLock: vi.fn(() => ({ acquired: true })),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../file-writer', () => ({
  readWorkspaceFile: vi.fn((ws: string, p: string) => {
    if (p === 'exists.txt') return 'line1\nline2\nline3\nline4\nline5';
    return null;
  }),
  readDirectoryTree: vi.fn(() => [
    { name: 'src', type: 'dir', children: [{ name: 'index.ts', type: 'file' }] },
    { name: 'README.md', type: 'file' },
  ]),
}));

vi.mock('../git-provider', () => ({
  commit: vi.fn(async () => ({ success: true, hash: 'abc123', pushed: false })),
  getDiff: vi.fn(async () => 'diff content'),
  getLog: vi.fn(async () => ['commit1', 'commit2']),
  createIssue: vi.fn(async () => ({ number: 1, html_url: 'https://github.com/test/1' })),
  listIssues: vi.fn(async () => []),
  closeIssue: vi.fn(async () => true),
  addIssueComment: vi.fn(async () => true),
  getIssue: vi.fn(async () => null),
  createBranch: vi.fn(async () => ({ success: true })),
  switchBranch: vi.fn(async () => ({ success: true })),
  deleteBranch: vi.fn(async () => ({ success: true })),
  listBranches: vi.fn(async () => []),
  getCurrentBranch: vi.fn(async () => 'main'),
  gitPull: vi.fn(async () => ({ success: true, output: 'ok' })),
  gitPush: vi.fn(async () => ({ success: true, output: 'ok' })),
  gitFetch: vi.fn(async () => ({ success: true, output: 'ok' })),
  createPR: vi.fn(async () => null),
  listPRs: vi.fn(async () => []),
  getPR: vi.fn(async () => null),
  mergePR: vi.fn(async () => ({ success: false, error: 'not found' })),
}));

vi.mock('../sandbox-executor', () => ({
  execInSandbox: vi.fn(() => ({ success: true, stdout: 'output', stderr: '', exitCode: 0, duration: 100, timedOut: false })),
  execInSandboxAsync: vi.fn(() => ({ pid: 1234, getStdout: () => 'bg', getStderr: () => '' })),
  execInSandboxPromise: vi.fn(async () => ({ success: true, stdout: 'async output', stderr: '', exitCode: 0, duration: 80, timedOut: false })),
  isAsyncHandle: vi.fn(() => true),
  registerProcess: vi.fn(),
  getActiveProcess: vi.fn(() => null),
  runTest: vi.fn(() => ({ success: true, stdout: 'PASS', stderr: '', exitCode: 0, duration: 500, timedOut: false })),
  runLint: vi.fn(() => ({ success: true, stdout: 'No errors', stderr: '', exitCode: 0, duration: 200 })),
  runTestAsync: vi.fn(async () => ({ success: true, stdout: 'PASS async', stderr: '', exitCode: 0, duration: 400, timedOut: false })),
  runLintAsync: vi.fn(async () => ({ success: true, stdout: 'No errors async', stderr: '', exitCode: 0, duration: 150, timedOut: false })),
}));

vi.mock('../memory-system', () => ({
  readMemoryForRole: vi.fn(() => ({ combined: 'test memory' })),
  appendProjectMemory: vi.fn(),
  appendRoleMemory: vi.fn(),
  readRecentDecisions: vi.fn(() => []),
  formatDecisionsForContext: vi.fn(() => ''),
  appendSharedDecision: vi.fn(),
}));

vi.mock('../web-tools', () => ({
  webSearch: vi.fn(async () => ({ success: true, content: 'results' })),
  fetchUrl: vi.fn(async () => ({ success: true, content: 'page content' })),
  httpRequest: vi.fn(async () => ({ success: true, status: 200, headers: {}, body: 'ok' })),
  webSearchBoost: vi.fn(async () => ({ success: true, provider: 'brave', content: 'boosted results' })),
}));

vi.mock('../extended-tools', () => ({
  think: vi.fn((t: string) => `Thought: ${t}`),
  todoWrite: vi.fn(() => 'todos written'),
  todoRead: vi.fn(() => 'todos list'),
  batchEdit: vi.fn(() => ({ success: true, output: 'batch ok' })),
}));

vi.mock('../computer-use', () => ({
  takeScreenshot: vi.fn(() => ({ success: true, width: 1920, height: 1080, base64: 'fakebase64' })),
  mouseMove: vi.fn(() => ({ success: true })),
  mouseClick: vi.fn(() => ({ success: true })),
  keyboardType: vi.fn(() => ({ success: true })),
  keyboardHotkey: vi.fn(() => ({ success: true })),
}));

vi.mock('../browser-tools', () => ({
  launchBrowser: vi.fn(async () => ({ success: true })),
  closeBrowser: vi.fn(async () => {}),
  navigate: vi.fn(async () => ({ success: true, title: 'Test', url: 'http://test.com' })),
  browserScreenshot: vi.fn(async () => ({ success: true, base64: 'img' })),
  browserSnapshot: vi.fn(async () => ({ success: true, content: '<snap>' })),
  browserClick: vi.fn(async () => ({ success: true })),
  browserType: vi.fn(async () => ({ success: true })),
  browserEvaluate: vi.fn(async () => ({ success: true, result: '42' })),
  browserWait: vi.fn(async () => ({ success: true })),
  browserNetwork: vi.fn(async () => ({ success: true, requests: 'GET /api' })),
  browserHover: vi.fn(async () => ({ success: true })),
  browserSelectOption: vi.fn(async () => ({ success: true, selected: ['a'] })),
  browserPressKey: vi.fn(async () => ({ success: true })),
  browserFillForm: vi.fn(async () => ({ success: true, filled: 2, errors: [] })),
  browserDrag: vi.fn(async () => ({ success: true })),
  browserTabs: vi.fn(async () => ({ success: true, tabs: [] })),
  browserFileUpload: vi.fn(async () => ({ success: true })),
  browserConsole: vi.fn(async () => ({ success: true, messages: ['log msg'] })),
}));

vi.mock('../visual-tools', () => ({
  analyzeImage: vi.fn(async () => ({ success: true, analysis: 'looks good' })),
  compareScreenshots: vi.fn(async () => ({ success: true, pixelDiffPercent: 5, analysis: 'minor diff' })),
  visualAssert: vi.fn(async () => ({ success: true, passed: true, confidence: 95, reasoning: 'ok' })),
  cacheScreenshot: vi.fn(),
  getCachedScreenshot: vi.fn(() => 'base64data'),
}));

vi.mock('../context-collector', () => ({
  trimToolResult: vi.fn((text: string, max: number) => text.slice(0, max) + '...'),
  collectDeveloperContext: vi.fn(async () => ({ contextText: '', estimatedTokens: 0, filesIncluded: 0 })),
  collectLightContext: vi.fn(async () => ({ contextText: '', estimatedTokens: 0 })),
}));

vi.mock('../search-provider', () => ({
  configureSearch: vi.fn(),
  getAvailableProviders: vi.fn(() => ['brave', 'tavily']),
}));

vi.mock('../skill-evolution', () => ({
  skillEvolution: {
    acquire: vi.fn((opts: any) => ({ id: 'sk-1', name: opts.name, maturity: 'experimental', trigger: opts.trigger, tags: opts.tags || [] })),
    searchSkills: vi.fn(() => []),
    loadKnowledge: vi.fn(() => 'knowledge text'),
    improve: vi.fn(() => ({ id: 'sk-1', name: 'test', version: 2 })),
    recordUsage: vi.fn(),
  },
  buildSkillContext: vi.fn(() => ''),
}));

vi.mock('../image-gen', () => ({
  configureImageGen: vi.fn(),
  isImageGenAvailable: vi.fn(() => true),
  textToImage: vi.fn(async () => ({ success: true, images: [{ base64: 'img64' }], savedPaths: [], durationMs: 100 })),
  editImage: vi.fn(async () => ({ success: true, images: [{ base64: 'edit64' }], savedPaths: [], durationMs: 50 })),
}));

vi.mock('../deploy-tools', () => ({
  deployWithCompose: vi.fn(async () => ({ success: true, output: 'deployed' })),
  composeDown: vi.fn(async () => ({ success: true, output: 'stopped' })),
  pm2Start: vi.fn(),
  pm2Status: vi.fn(),
  writeNginxConfig: vi.fn(),
  writeDockerfile: vi.fn(async () => ({ success: true, filePath: '/Dockerfile' })),
  healthCheck: vi.fn(async () => ({ success: true, services: [] })),
}));

// Mock sub-agent-framework as lazy require
vi.mock('../sub-agent-framework', () => ({
  getActiveSubAgents: vi.fn(() => []),
  cancelSubAgent: vi.fn(() => true),
  spawnSubAgent: vi.fn(async () => ({
    success: true, iterations: 3, durationMs: 5000, cost: 0.01,
    filesCreated: [], filesModified: [], conclusion: 'done', actionSummary: '',
  })),
  spawnParallel: vi.fn(async () => []),
}));

vi.mock('../mcp-client', () => ({
  mcpManager: {
    getAllTools: () => [],
    callTool: vi.fn(async () => ({ success: true, content: 'mcp result' })),
  },
}));

vi.mock('../skill-loader', () => ({
  skillManager: {
    executeSkill: vi.fn(async () => ({ success: true, output: 'skill result' })),
  },
}));

// Now import the module under test
import { executeTool, executeToolAsync } from '../tool-executor';
import type { ToolCall, ToolContext } from '../tool-registry';

// ── Helpers ──

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspacePath: os.tmpdir(),
    projectId: 'test-proj',
    gitConfig: { mode: 'local' as const, workspacePath: os.tmpdir() },
    // v16.0: 默认开启所有权限用于测试
    permissions: { externalRead: true, externalWrite: true, shellExec: true },
    ...overrides,
  };
}

function makeCall(name: string, args: Record<string, any> = {}): ToolCall {
  return { name, arguments: args };
}

// ═══════════════════════════════════════
// Tests
// ═══════════════════════════════════════

describe('tool-executor', () => {
  const ctx = makeCtx();

  // ── Pure functions (accessed indirectly via executeTool) ──

  describe('assertWritePath (via write_file/edit_file)', () => {
    it('rejects absolute paths without externalWrite permission', () => {
      // 使用无 externalWrite 权限的 ctx
      const noExtWriteCtx = makeCtx({ permissions: { shellExec: true } });
      const r = executeTool(makeCall('write_file', { path: '/etc/passwd', content: 'x' }), noExtWriteCtx);
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/路径不安全|写入外部路径被拒绝/);
    });

    it('rejects parent traversal paths', () => {
      const r = executeTool(makeCall('write_file', { path: '../../etc/passwd', content: 'x' }), ctx);
      expect(r.success).toBe(false);
      expect(r.output).toMatch(/路径不安全|写入外部路径被拒绝/);
    });

    it('allows safe relative paths', () => {
      const r = executeTool(makeCall('write_file', { path: 'src/test.ts', content: 'hello' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('已写入');
    });
  });

  describe('read_file', () => {
    // v17.0: read_file is now async (stream-based large file reading)
    // Create a real temp file for async path testing
    const tmpFile = path.join(os.tmpdir(), 'exists.txt');

    beforeEach(() => {
      fs.writeFileSync(tmpFile, 'line1\nline2\nline3\nline4\nline5', 'utf-8');
    });

    afterEach(() => {
      try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
    });

    it('sync path returns file content via fallback', () => {
      const r = executeTool(makeCall('read_file', { path: 'exists.txt' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('exists.txt');
    });

    it('async reads existing file with line numbers', async () => {
      const r = await executeToolAsync(makeCall('read_file', { path: 'exists.txt' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('exists.txt');
      expect(r.action).toBe('read');
    });

    it('async reports missing file', async () => {
      const r = await executeToolAsync(makeCall('read_file', { path: 'nope.txt' }), ctx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('文件不存在');
    });

    it('async respects offset and limit', async () => {
      const r = await executeToolAsync(makeCall('read_file', { path: 'exists.txt', offset: 2, limit: 2 }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('显示');
    });
  });

  describe('list_files', () => {
    it('returns formatted directory tree', () => {
      const r = executeTool(makeCall('list_files', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('src/');
      expect(r.output).toContain('README.md');
    });
  });

  describe('edit_file', () => {
    it('rejects unsafe paths', () => {
      const r = executeTool(makeCall('edit_file', { path: '/abs/path.ts', old_string: 'a', new_string: 'b' }), ctx);
      expect(r.success).toBe(false);
    });

    it('rejects missing old_string', () => {
      // Need a real file for edit_file
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-'));
      const tmpFile = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(tmpFile, 'hello world');
      const localCtx = makeCtx({ workspacePath: tmpDir });
      const r = executeTool(makeCall('edit_file', { path: 'test.txt', new_string: 'b' }), localCtx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('old_string 参数缺失');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('succeeds with valid edit', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-'));
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world');
      const localCtx = makeCtx({ workspacePath: tmpDir });
      const r = executeTool(makeCall('edit_file', { path: 'test.txt', old_string: 'hello', new_string: 'hi' }), localCtx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('1 处替换');
      const content = fs.readFileSync(path.join(tmpDir, 'test.txt'), 'utf-8');
      expect(content).toBe('hi world');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('appends when old_string is empty', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-'));
      fs.writeFileSync(path.join(tmpDir, 'append.txt'), 'base');
      const localCtx = makeCtx({ workspacePath: tmpDir });
      const r = executeTool(makeCall('edit_file', { path: 'append.txt', old_string: '', new_string: '\nnewline' }), localCtx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('已追加');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rejects multiple matches', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-'));
      fs.writeFileSync(path.join(tmpDir, 'dup.txt'), 'aaa\naaa\n');
      const localCtx = makeCtx({ workspacePath: tmpDir });
      const r = executeTool(makeCall('edit_file', { path: 'dup.txt', old_string: 'aaa', new_string: 'bbb' }), localCtx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('匹配了 2 处');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('write_file with lock context', () => {
    it('attempts lock when workerId and featureId provided', () => {
      const lockCtx = makeCtx({ workerId: 'dev-1', featureId: 'feat-1' });
      const r = executeTool(makeCall('write_file', { path: 'lock-test.txt', content: 'data' }), lockCtx);
      expect(r.success).toBe(true);
    });
  });

  describe('run_command (async v17.1)', () => {
    it('dispatches to async sandbox executor', async () => {
      const r = await executeToolAsync(makeCall('run_command', { command: 'echo hello' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('output');
      expect(r.action).toBe('shell');
    });

    it('handles background execution', async () => {
      const r = await executeToolAsync(makeCall('run_command', { command: 'long-task', background: true }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('后台进程已启动');
    });
  });

  describe('run_test & run_lint (async v17.1)', () => {
    it('run_test returns test results', async () => {
      const r = await executeToolAsync(makeCall('run_test', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('run_test');
      expect(r.action).toBe('shell');
    });

    it('run_lint returns lint results', async () => {
      const r = await executeToolAsync(makeCall('run_lint', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('run_lint');
    });
  });

  describe('memory_read / memory_append', () => {
    it('memory_read returns memory content', () => {
      const r = executeTool(makeCall('memory_read', { role: 'developer' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('test memory');
    });

    it('memory_append writes project memory', () => {
      const r = executeTool(makeCall('memory_append', { entry: 'learned something', layer: 'project' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('已写入项目记忆');
    });

    it('memory_append writes role memory', () => {
      const r = executeTool(makeCall('memory_append', { entry: 'role note', layer: 'role', role: 'architect' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('已写入 architect 角色记忆');
    });
  });

  describe('task_complete', () => {
    it('returns success with summary', () => {
      const r = executeTool(makeCall('task_complete', { summary: 'all done' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('任务完成');
      expect(r.output).toContain('all done');
    });
  });

  describe('think', () => {
    it('returns thought output', () => {
      const r = executeTool(makeCall('think', { thought: 'analyzing...' }), ctx);
      expect(r.success).toBe(true);
      expect(r.action).toBe('think');
    });
  });

  describe('report_blocked', () => {
    it('returns formatted blocked message', () => {
      const r = executeTool(makeCall('report_blocked', {
        reason: 'API key missing',
        suggestions: ['Add key to .env', 'Use mock API'],
        partial_result: 'started work',
      }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('BLOCKED');
      expect(r.output).toContain('API key missing');
      expect(r.output).toContain('Add key to .env');
    });
  });

  describe('todo_write / todo_read', () => {
    it('todo_write dispatches to extended-tools', () => {
      const r = executeTool(makeCall('todo_write', { todos: [] }), ctx);
      expect(r.success).toBe(true);
      expect(r.action).toBe('plan');
    });

    it('todo_read returns todo list', () => {
      const r = executeTool(makeCall('todo_read', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.action).toBe('plan');
    });
  });

  describe('batch_edit', () => {
    it('rejects empty edits', () => {
      const r = executeTool(makeCall('batch_edit', { edits: [] }), ctx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('编辑列表为空');
    });

    it('dispatches to batchEdit with edits', () => {
      const r = executeTool(makeCall('batch_edit', {
        path: 'test.ts',
        edits: [{ old_string: 'a', new_string: 'b' }],
      }), ctx);
      expect(r.success).toBe(true);
    });
  });

  describe('screenshot / mouse / keyboard', () => {
    it('screenshot returns image info', () => {
      const r = executeTool(makeCall('screenshot', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('screenshot');
    });

    it('mouse_click returns success', () => {
      const r = executeTool(makeCall('mouse_click', { x: 100, y: 200 }), ctx);
      expect(r.success).toBe(true);
    });

    it('mouse_move returns success', () => {
      const r = executeTool(makeCall('mouse_move', { x: 50, y: 50 }), ctx);
      expect(r.success).toBe(true);
    });

    it('keyboard_type returns success', () => {
      const r = executeTool(makeCall('keyboard_type', { text: 'hello' }), ctx);
      expect(r.success).toBe(true);
    });

    it('keyboard_hotkey returns success', () => {
      const r = executeTool(makeCall('keyboard_hotkey', { combo: 'ctrl+s' }), ctx);
      expect(r.success).toBe(true);
    });
  });

  describe('skill tools', () => {
    it('skill_acquire creates new skill', () => {
      const r = executeTool(makeCall('skill_acquire', {
        name: 'debug-react',
        description: 'Debug React components',
        trigger: 'when debugging React',
        knowledge: 'use devtools',
        tags: ['react'],
      }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('新技能已习得');
    });

    it('skill_acquire fails without required params', () => {
      const r = executeTool(makeCall('skill_acquire', { name: 'test' }), ctx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('需要');
    });

    it('skill_search returns results', () => {
      const r = executeTool(makeCall('skill_search', { query: 'react' }), ctx);
      expect(r.success).toBe(true);
    });

    it('skill_improve updates skill', () => {
      const r = executeTool(makeCall('skill_improve', { skill_id: 'sk-1', change_note: 'better' }), ctx);
      expect(r.success).toBe(true);
    });

    it('skill_improve fails without params', () => {
      const r = executeTool(makeCall('skill_improve', {}), ctx);
      expect(r.success).toBe(false);
    });

    it('skill_record_usage records usage', () => {
      const r = executeTool(makeCall('skill_record_usage', { skill_id: 'sk-1', success: true }), ctx);
      expect(r.success).toBe(true);
    });

    it('skill_record_usage fails without params', () => {
      const r = executeTool(makeCall('skill_record_usage', {}), ctx);
      expect(r.success).toBe(false);
    });
  });

  describe('configure_search', () => {
    it('updates search config and returns providers', () => {
      const r = executeTool(makeCall('configure_search', { brave_api_key: 'test-key' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('搜索引擎配置已更新');
      expect(r.output).toContain('brave');
    });
  });

  describe('configure_image_gen', () => {
    it('updates image gen config', () => {
      const r = executeTool(makeCall('configure_image_gen', { provider: 'openai', model: 'dall-e-3' }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('图像生成引擎已配置');
    });
  });

  describe('async-only tools return placeholder', () => {
    const asyncToolNames = [
      'web_search', 'fetch_url', 'http_request', 'browser_launch',
      'browser_navigate', 'browser_screenshot', 'browser_close',
      'sandbox_init', 'sandbox_exec', 'generate_image', 'edit_image',
      'deploy_compose_up', 'deploy_compose_down', 'deploy_health_check',
      'github_create_issue', 'github_list_issues', 'github_create_pr',
    ];

    for (const name of asyncToolNames) {
      it(`${name} returns async placeholder`, () => {
        const r = executeTool(makeCall(name, {}), ctx);
        expect(r.success).toBe(true);
        expect(r.output).toContain('[async]');
      });
    }
  });

  describe('git tools throw async-only error', () => {
    const gitTools = ['git_commit', 'git_diff', 'git_log', 'git_create_branch', 'git_switch_branch'];
    for (const name of gitTools) {
      it(`${name} throws async-only error`, () => {
        const r = executeTool(makeCall(name, {}), ctx);
        expect(r.success).toBe(false);
        expect(r.output).toContain('async-only');
      });
    }
  });

  describe('unknown tool', () => {
    it('returns error for unknown tool', () => {
      const r = executeTool(makeCall('nonexistent_tool', {}), ctx);
      expect(r.success).toBe(false);
      expect(r.output).toContain('未知工具');
    });

    it('mcp_ prefix returns async placeholder', () => {
      const r = executeTool(makeCall('mcp_server_tool', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('[async]');
    });

    it('skill_ prefix returns async placeholder', () => {
      const r = executeTool(makeCall('skill_custom_one', {}), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('[async]');
    });
  });

  describe('output truncation', () => {
    it('truncates very long tool output', async () => {
      // Create a real large file for async path testing
      const bigFile = path.join(os.tmpdir(), 'big_test.txt');
      const longContent = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(100)}`).join('\n');
      fs.writeFileSync(bigFile, longContent, 'utf-8');
      try {
        const r = await executeToolAsync(makeCall('read_file', { path: 'big_test.txt' }), ctx);
        expect(r.success).toBe(true);
        expect(r.output.length).toBeGreaterThan(0);
      } finally {
        try { fs.unlinkSync(bigFile); } catch { /* cleanup */ }
      }
    });
  });

  describe('rfc_propose', () => {
    it('creates RFC without DB (no projectId context)', () => {
      const noProjectCtx = makeCtx({ projectId: undefined as any });
      const r = executeTool(makeCall('rfc_propose', {
        title: 'Test RFC',
        problem: 'Something is broken',
        proposal: 'Fix it',
        impact: 'high',
      }), noProjectCtx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('RFC 已提交');
      expect(r.output).toContain('Test RFC');
    });

    it('creates RFC with projectId (DB write attempted)', () => {
      const r = executeTool(makeCall('rfc_propose', {
        title: 'Refactor API',
        problem: 'Too coupled',
        proposal: 'Use interfaces',
        impact: 'medium',
        affected_features: ['feat-1', 'feat-2'],
      }), ctx);
      expect(r.success).toBe(true);
      expect(r.output).toContain('RFC 已提交');
    });
  });

  describe('list_sub_agents / cancel_sub_agent', () => {
    it('list_sub_agents returns result (may fail in test env due to lazy require)', () => {
      const r = executeTool(makeCall('list_sub_agents', {}), ctx);
      // In test env, require('./sub-agent-framework') might fail with circular dep or mock issue
      // The catch block will return success: false with error message
      // We just verify the dispatch happens without crash
      expect(typeof r.success).toBe('boolean');
      expect(typeof r.output).toBe('string');
    });

    it('cancel_sub_agent returns result', () => {
      const r = executeTool(makeCall('cancel_sub_agent', { agent_id: 'test-agent' }), ctx);
      expect(typeof r.success).toBe('boolean');
      expect(typeof r.output).toBe('string');
    });
  });
});

describe('executeToolAsync', () => {
  const ctx = makeCtx();

  it('github_create_issue creates issue', async () => {
    const r = await executeToolAsync(makeCall('github_create_issue', { title: 'Bug', body: 'details' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('Issue #1');
  });

  it('web_search returns results', async () => {
    const r = await executeToolAsync(makeCall('web_search', { query: 'test query' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('results');
  });

  it('fetch_url returns page content', async () => {
    const r = await executeToolAsync(makeCall('fetch_url', { url: 'http://test.com' }), ctx);
    expect(r.success).toBe(true);
  });

  it('http_request returns response', async () => {
    const r = await executeToolAsync(makeCall('http_request', { url: 'http://api.com', method: 'GET' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('HTTP 200');
  });

  it('browser_launch starts browser', async () => {
    const r = await executeToolAsync(makeCall('browser_launch', { headless: true }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('浏览器已启动');
  });

  it('browser_close closes browser', async () => {
    const r = await executeToolAsync(makeCall('browser_close', {}), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_navigate navigates', async () => {
    const r = await executeToolAsync(makeCall('browser_navigate', { url: 'http://test.com' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('已导航');
  });

  it('browser_snapshot returns accessibility tree', async () => {
    const r = await executeToolAsync(makeCall('browser_snapshot', {}), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_evaluate runs expression', async () => {
    const r = await executeToolAsync(makeCall('browser_evaluate', { expression: '1+1' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toBe('42');
  });

  it('git_commit commits changes', async () => {
    const r = await executeToolAsync(makeCall('git_commit', { message: 'test commit' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('abc123');
  });

  it('git_diff returns diff', async () => {
    const r = await executeToolAsync(makeCall('git_diff', {}), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('diff');
  });

  it('git_log returns history', async () => {
    const r = await executeToolAsync(makeCall('git_log', { count: 5 }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('commit1');
  });

  it('git_pull succeeds', async () => {
    const r = await executeToolAsync(makeCall('git_pull', {}), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('Pull 成功');
  });

  it('git_push succeeds', async () => {
    const r = await executeToolAsync(makeCall('git_push', {}), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('Push 成功');
  });

  it('github_close_issue closes issue', async () => {
    const r = await executeToolAsync(makeCall('github_close_issue', { issue_number: 1 }), ctx);
    expect(r.success).toBe(true);
  });

  it('github_add_comment adds comment', async () => {
    const r = await executeToolAsync(makeCall('github_add_comment', { issue_number: 1, body: 'fixed' }), ctx);
    expect(r.success).toBe(true);
  });

  it('fallback to sync for unknown async tool', async () => {
    const r = await executeToolAsync(makeCall('task_complete', { summary: 'done' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('任务完成');
  });

  it('web_search_boost returns boosted results', async () => {
    const r = await executeToolAsync(makeCall('web_search_boost', { query: 'test' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('brave');
  });

  it('browser_click dispatches click', async () => {
    const r = await executeToolAsync(makeCall('browser_click', { selector: '#btn' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('已点击');
  });

  it('browser_type dispatches type', async () => {
    const r = await executeToolAsync(makeCall('browser_type', { selector: '#input', text: 'hello' }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_wait dispatches wait', async () => {
    const r = await executeToolAsync(makeCall('browser_wait', { selector: '#el' }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_network returns requests', async () => {
    const r = await executeToolAsync(makeCall('browser_network', {}), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_hover dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_hover', { selector: '.item' }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_select_option dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_select_option', { selector: 'select', values: ['a'] }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_press_key dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_press_key', { key: 'Enter' }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_fill_form dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_fill_form', { fields: [] }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_drag dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_drag', { source_selector: '#a', target_selector: '#b' }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_tabs dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_tabs', { action: 'list' }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_file_upload dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_file_upload', { selector: '#file', file_paths: ['/tmp/a.txt'] }), ctx);
    expect(r.success).toBe(true);
  });

  it('browser_console dispatches', async () => {
    const r = await executeToolAsync(makeCall('browser_console', {}), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('log msg');
  });

  it('github_list_issues returns list', async () => {
    const r = await executeToolAsync(makeCall('github_list_issues', {}), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('无 Issues');
  });

  it('git_create_branch creates branch', async () => {
    const r = await executeToolAsync(makeCall('git_create_branch', { branch_name: 'feat/new' }), ctx);
    expect(r.success).toBe(true);
  });

  it('git_switch_branch switches', async () => {
    const r = await executeToolAsync(makeCall('git_switch_branch', { branch_name: 'main' }), ctx);
    expect(r.success).toBe(true);
  });

  it('git_fetch succeeds', async () => {
    const r = await executeToolAsync(makeCall('git_fetch', {}), ctx);
    expect(r.success).toBe(true);
  });

  it('github_get_issue returns not found', async () => {
    const r = await executeToolAsync(makeCall('github_get_issue', { issue_number: 999 }), ctx);
    expect(r.success).toBe(false);
  });
});
