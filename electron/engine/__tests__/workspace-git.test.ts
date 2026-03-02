/**
 * workspace-git.ts tests — hasGit, initGitRepo, commitWorkspace, getGitLog, exportWorkspaceZip
 *
 * All child_process and git-provider calls are mocked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

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
import { execSync } from 'child_process';

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
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValueOnce(true); // output exists after compression

    const result = await exportWorkspaceZip('/test/workspace', '/output/workspace.zip');
    expect(result).toBe(true);
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('Compress-Archive'), expect.any(Object));
  });

  it('removes existing output file before compression', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(true); // output already exists
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValueOnce(true); // output exists after

    await exportWorkspaceZip('/test/workspace', '/output/workspace.zip');
    expect(fs.unlinkSync).toHaveBeenCalledWith('/output/workspace.zip');
  });

  it('returns false when compression fails', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('PowerShell error'); });

    const result = await exportWorkspaceZip('/test/workspace', '/output/workspace.zip');
    expect(result).toBe(false);
  });
});
