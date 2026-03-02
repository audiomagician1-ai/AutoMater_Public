/**
 * Frontend Logger — 统一的前端日志工具
 *
 * 替代散落各组件的 console.log / console.error。
 * 生产环境可配置为静默或只输出 error 级别。
 *
 * v12.3: 代码质量审计产物
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 当前最低输出级别 — 生产模式可调为 'warn' 或 'error' */
const MIN_LEVEL: LogLevel = import.meta.env.DEV ? 'debug' : 'warn';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
}

function formatPrefix(module: string, level: LogLevel): string {
  const ts = new Date().toISOString().slice(11, 23);
  return `[${ts}][${level.toUpperCase()}][${module}]`;
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * 创建带模块名前缀的 logger 实例
 *
 * @example
 * const log = createLogger('SessionManager');
 * log.error('Failed to load sessions:', err);
 */
export function createLogger(module: string): Logger {
  return {
    debug: (...args) => shouldLog('debug') && console.debug(formatPrefix(module, 'debug'), ...args),
    info: (...args) => shouldLog('info') && console.log(formatPrefix(module, 'info'), ...args),
    warn: (...args) => shouldLog('warn') && console.warn(formatPrefix(module, 'warn'), ...args),
    error: (...args) => shouldLog('error') && console.error(formatPrefix(module, 'error'), ...args),
  };
}
