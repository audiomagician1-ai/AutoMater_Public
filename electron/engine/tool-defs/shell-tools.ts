/**
 * Shell / test / lint / process tool definitions.
 */
import type { ToolDef } from './types';

export const SHELL_TOOLS: ToolDef[] = [
  {
    name: 'run_command',
    description:
      '在工作区中执行 shell 命令。用于安装依赖(npm install)、运行测试、编译检查等。同步模式超时60秒。background=true 时异步执行(最长30分钟)，返回进程ID供后续查询。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell 命令' },
        background: { type: 'boolean', description: '是否后台执行(长时间进程如dev server/build)，默认false' },
        timeout_seconds: { type: 'number', description: '超时秒数(同步默认60，后台默认1800)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_test',
    description: '在沙箱中运行项目测试 (自动检测 npm test/pytest/cargo test/go test)。超时 180 秒。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'run_lint',
    description: '在沙箱中运行 lint 和类型检查 (自动检测 tsc/eslint/py_compile)。超时 60 秒。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'check_process',
    description: '查询后台进程的状态和输出。使用 run_command(background=true) 启动后台进程后，可用此工具查看进度。',
    parameters: {
      type: 'object',
      properties: { process_id: { type: 'string', description: '后台进程 ID (由 run_command 返回)' } },
      required: ['process_id'],
    },
  },
  {
    name: 'wait_for_process',
    description:
      '等待后台进程完成并返回完整结果。比反复调用 check_process 更高效——一次调用即可阻塞等待直到进程结束或超时。',
    parameters: {
      type: 'object',
      properties: {
        process_id: { type: 'string', description: '后台进程 ID (由 run_command 返回)' },
        timeout_seconds: { type: 'number', description: '最长等待秒数 (默认120, 最大600)' },
      },
      required: ['process_id'],
    },
  },
];
