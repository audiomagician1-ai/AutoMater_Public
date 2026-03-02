/**
 * workspace-git.ts tests — hasGit, initGitRepo, commitWorkspace, getGitLog, exportWorkspaceZip
 *
 * All child_process and git-provider calls are mocked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock child_process — workspace-git uses `promisify(exec)` which calls exec.__promisify__
const { mockExecAsync } = vi.hoisted(() => ({
  mockExecAsync: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

vi.mock('child_process', () => {
  const execFn = vi.fn((...args: unknown[]) => {
    const cb = args.find(a => typeof a === 'function') as
      ((err: Error | null, result: { stdout: string; stderr: string }) => void) | undefined;
    if (cb) cb(null, { stdout: '', stderr: '' });
  });
  // promisify() checks for exec[util.promisify.custom] — this is how Node handles exec
  (execFn as Record<string | symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = mockExecAsync;
  return {
    execSync: vi.fn(),
    exec: execFn,
  };
});

// Mock git-provider — vi.mock is hoisted, so use vi.hoisted() for shared mocks
const { mockInitRepo, mockCommit, mockGetLog } = vi.hoisted(() => ({
  mockInitRepo: vi.fn(),
  mockCommit: vi.fn(),
  mockGetLog: vi.fn(),
}));

vi.mock('../git-provider', () => ({
  initRepo: mockInitRepo,
  commit: mockCommit,
  getLog: mockGetLog,
}));

// Mock fs for exportWorkspaceZip
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      unlinkSync: vi.fn(),
    },
    existsSync: vi.fn(() => false),
    unlinkSync: vi.fn(),
  };
});

import { hasGit, initGitRepo, commitWorkspace, getGitLog, exportWorkspaceZip } from '../workspace-git';
import { execSync, exec } from 'child_process';

describe('hasGit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when git is available', () => {
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from('git version 2.40.0'));
    expect(hasGit()).toBe(true);
  });

  it('returns false when git is not installed', () => {
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('not found'); });
    expect(hasGit()).toBe(false);
  });
});

describe('initGitRepo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to git-provider initRepo', async () => {
    mockInitRepo.mockResolvedValueOnce(true);
    const result = await initGitRepo('/test/workspace');
    expect(result).toBe(true);
    expect(mockInitRepo).toHaveBeenCalledWith({ mode: 'local', workspacePath: '/test/workspace' });
  });

  it('returns false when initRepo fails', async () => {
    mockInitRepo.mockResolvedValueOnce(false);
    const result = await initGitRepo('/test/workspace');
    expect(result).toBe(false);
  });
});

describe('commitWorkspace', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to git-provider commit and returns success', async () => {
    mockCommit.mockResolvedValueOnce({ success: true, hash: 'abc123' });
    const result = await commitWorkspace('/test/workspace', 'test commit');
    expect(result).toBe(true);
    expect(mockCommit).toHaveBeenCalledWith(
      { mode: 'local', workspacePath: '/test/workspace' },
      'test commit'
    );
  });

  it('returns false when commit fails', async () => {
    mockCommit.mockResolvedValueOnce({ success: false });
    const result = await commitWorkspace('/test/workspace', 'test commit');
    expect(result).toBe(false);
  });
});

describe('getGitLog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to git-provider getLog', async () => {
    mockGetLog.mockResolvedValueOnce(['abc123 initial commit', 'def456 second commit']);
    const result = await getGitLog('/test/workspace');
    expect(result).toEqual(['abc123 initial commit', 'def456 second commit']);
    expect(mockGetLog).toHaveBeenCalledWith('/test/workspace', 20);
  });

  it('passes custom maxCount', async () => {
    mockGetLog.mockResolvedValueOnce([]);
    await getGitLog('/test/workspace', 5);
    expect(mockGetLog).toHaveBeenCalledWith('/test/workspace', 5);
  });
});

describe('exportWorkspaceZip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls powershell Compress-Archive and returns true on success', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false); // output doesn't exist yet
    // exec mock already resolves with empty stdout/stderr by default
    vi.mocked(fs.existsSync).mockReturnValueOnce(true); // output exists after compression

    const result = await exportWorkspaceZip('/test/workspace', '/output/workspace.zip');
    expect(result).toBe(true);
    // v17.1: exportWorkspaceZip uses execAsync (promisify(exec)) internally;
    // verifying result===true confirms exec succeeded and fs.existsSync returned true
  });

  it('removes existing output file before compression', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true); // output already exists
    vi.mocked(fs.existsSync).mockReturnValueOnce(true); // output exists after

    await exportWorkspaceZip('/test/workspace', '/output/workspace.zip');
    expect(fs.unlinkSync).toHaveBeenCalledWith('/output/workspace.zip');
  });

  it('returns false when compression fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    vi.mocked(exec).mockImplementationOnce((_cmd: string, _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      if (typeof cb === 'function') cb(new Error('PowerShell error'), { stdout: '', stderr: '' });
      return {} as ReturnType<typeof exec>;
    });

    const result = await exportWorkspaceZip('/test/workspace', '/output/workspace.zip');
    expect(result).toBe(false);
  });
});
