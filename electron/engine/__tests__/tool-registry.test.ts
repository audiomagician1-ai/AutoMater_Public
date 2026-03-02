/**
 * Tests for tool-registry.ts — 工具定义 + 角色权限 + Schema 格式化
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOOL_DEFINITIONS,
  getToolsForRole,
  getToolsForLLM,
  parseToolCalls,
  isAsyncTool,
  type AgentRole,
  type ToolDefinition,
} from '../tool-registry';

// Mock MCP and Skill to prevent lazy require from failing
vi.mock('../mcp-client', () => ({
  mcpManager: { getAllTools: () => [] },
}));
vi.mock('../skill-loader', () => ({
  skillManager: {
    getDefinitionsForRole: () => [],
    getAllDefinitions: () => [],
  },
}));

// ═══════════════════════════════════════
// TOOL_DEFINITIONS integrity
// ═══════════════════════════════════════

describe('TOOL_DEFINITIONS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(TOOL_DEFINITIONS)).toBe(true);
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(30);
  });

  it('every tool has name, description, parameters', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe('object');
    }
  });

  it('all tool names are unique', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('required fields exist in properties', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const required: string[] = tool.parameters.required || [];
      const props = tool.parameters.properties || {};
      for (const r of required) {
        expect(props[r], `${tool.name} requires '${r}' but it's not in properties`).toBeDefined();
      }
    }
  });

  it('contains core tools', () => {
    const names = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const core = ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files',
      'run_command', 'git_commit', 'task_complete', 'think', 'web_search'];
    for (const name of core) {
      expect(names.has(name), `missing core tool: ${name}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════
// getToolsForRole
// ═══════════════════════════════════════

describe('getToolsForRole', () => {
  const allRoles: AgentRole[] = ['pm', 'architect', 'developer', 'qa', 'devops', 'researcher', 'meta-agent'];

  for (const role of allRoles) {
    it(`returns tools for ${role}`, () => {
      const tools = getToolsForRole(role);
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(t.type).toBe('function');
        expect(t.function.name).toBeTruthy();
        expect(t.function.parameters).toBeDefined();
      }
    });
  }

  it('developer has more tools than researcher', () => {
    const devTools = getToolsForRole('developer');
    const researchTools = getToolsForRole('researcher');
    expect(devTools.length).toBeGreaterThan(researchTools.length);
  });

  it('researcher cannot write files', () => {
    const tools = getToolsForRole('researcher');
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_command');
  });

  it('pm can read but not write files (except those explicitly allowed)', () => {
    const tools = getToolsForRole('pm');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_command');
  });

  it('developer has think, read, write, edit, run, git', () => {
    const tools = getToolsForRole('developer');
    const names = new Set(tools.map(t => t.function.name));
    expect(names.has('think')).toBe(true);
    expect(names.has('read_file')).toBe(true);
    expect(names.has('write_file')).toBe(true);
    expect(names.has('edit_file')).toBe(true);
    expect(names.has('run_command')).toBe(true);
    expect(names.has('git_commit')).toBe(true);
  });

  it('excludes github tools when gitMode is local', () => {
    const tools = getToolsForRole('developer', 'local');
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('github_create_issue');
    expect(names).not.toContain('github_list_issues');
  });

  it('includes github tools when gitMode is github', () => {
    const tools = getToolsForRole('devops', 'github');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('github_create_issue');
  });
});

// ═══════════════════════════════════════
// getToolsForLLM
// ═══════════════════════════════════════

describe('getToolsForLLM', () => {
  it('returns all tools in OpenAI format', () => {
    const tools = getToolsForLLM();
    expect(tools.length).toBeGreaterThan(30);
    for (const t of tools) {
      expect(t.type).toBe('function');
    }
  });

  it('excludes github tools when gitMode is local', () => {
    const tools = getToolsForLLM('local');
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('github_create_issue');
  });

  it('includes github tools when gitMode is github', () => {
    const tools = getToolsForLLM('github');
    const names = tools.map(t => t.function.name);
    expect(names).toContain('github_create_issue');
  });
});

// ═══════════════════════════════════════
// parseToolCalls
// ═══════════════════════════════════════

describe('parseToolCalls', () => {
  it('parses OpenAI format tool_calls with string arguments', () => {
    const msg = {
      tool_calls: [
        { function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' } },
        { function: { name: 'think', arguments: '{"thought":"analyzing"}' } },
      ],
    };
    const calls = parseToolCalls(msg);
    expect(calls.length).toBe(2);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments.path).toBe('src/main.ts');
    expect(calls[1].name).toBe('think');
  });

  it('handles object arguments (already parsed)', () => {
    const msg = {
      tool_calls: [
        { function: { name: 'write_file', arguments: { path: 'test.ts', content: 'hello' } } },
      ],
    };
    const calls = parseToolCalls(msg);
    expect(calls[0].arguments.path).toBe('test.ts');
  });

  it('returns empty array for no tool_calls', () => {
    expect(parseToolCalls({})).toEqual([]);
    expect(parseToolCalls({ tool_calls: undefined })).toEqual([]);
  });

  it('handles null message', () => {
    expect(parseToolCalls(null as any)).toEqual([]);
  });
});

// ═══════════════════════════════════════
// isAsyncTool
// ═══════════════════════════════════════

describe('isAsyncTool', () => {
  it('identifies async tools (network/browser/git/sandbox)', () => {
    const asyncTools = [
      'web_search', 'fetch_url', 'http_request', 'web_search_boost', 'deep_research',
      'github_create_issue', 'github_list_issues',
      'browser_launch', 'browser_navigate', 'browser_click',
      'sandbox_init', 'sandbox_exec', 'sandbox_read',
      'git_commit', 'git_diff',
      'spawn_agent', 'spawn_parallel', 'spawn_researcher',
      'analyze_image', 'visual_assert',
      'run_blackbox_tests',
    ];
    for (const t of asyncTools) {
      expect(isAsyncTool(t), `${t} should be async`).toBe(true);
    }
  });

  it('identifies sync tools (local file/think)', () => {
    // v17.0: read_file moved to async (stream-based large file reading)
    const syncTools = ['write_file', 'edit_file', 'list_files',
      'search_files', 'think', 'task_complete', 'todo_write', 'todo_read',
      'run_command', 'run_test', 'run_lint'];
    for (const t of syncTools) {
      expect(isAsyncTool(t), `${t} should be sync`).toBe(false);
    }
  });

  it('identifies read_file as async (v17.0 stream-based)', () => {
    expect(isAsyncTool('read_file')).toBe(true);
    expect(isAsyncTool('read_many_files')).toBe(true);
    expect(isAsyncTool('code_graph_query')).toBe(true);
  });

  it('treats MCP and Skill tools as async', () => {
    expect(isAsyncTool('mcp_postgres_query')).toBe(true);
    expect(isAsyncTool('skill_deploy_docker')).toBe(true);
  });
});
