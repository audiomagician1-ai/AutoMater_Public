/**
 * Structured Logger — 统一日志系统
 *
 * 设计目标:
 *   1. 替代散落各模块的 console.log / console.error / catch { }
 *   2. 结构化输出: 每条日志携带 module、level、timestamp
 *   3. 生产环境零依赖 (不引入 winston/pino)
 *   4. 支持 child logger (携带固定 module 前缀)
 *   5. 支持 silent 模式 (单元测试)
 *
 * 使用方式:
 *   import { createLogger } from './logger';
 *   const log = createLogger('orchestrator');
 *   log.info('Pipeline started', { projectId });
 *   log.warn('Slow LLM response', { latencyMs: 8000 });
 *   log.error('Tool execution failed', err, { tool: 'run_command' });
 *
 * @module logger
 */

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  error?: string;
  stack?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, err?: unknown, data?: Record<string, unknown>): void;
  /** Create a child logger with an additional sub-module prefix */
  child(subModule: string): Logger;
}

// ═══════════════════════════════════════
// Configuration
// ═══════════════════════════════════════

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: '\x1b[36m',  // cyan
  info: '\x1b[32m',   // green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** Global minimum log level. Adjustable at runtime. */
let globalMinLevel: LogLevel = process.env.NODE_ENV === 'test' ? 'error' : 'debug';

/** Set global minimum log level */
export function setLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

// ═══════════════════════════════════════
// Error Normalization
// ═══════════════════════════════════════

/**
 * Extract a clean error message string from an unknown thrown value.
 * Use in catch blocks: `catch (err: unknown) { log.error('msg', toErrorMessage(err)); }`
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return json;
  } catch { /* fall through */ }
  return String(err);
}

/**
 * Extract a clean error message and stack from an unknown thrown value.
 * Handles: Error instances, strings, objects with message property, and anything else.
 */
function normalizeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err && typeof err === 'object' && 'message' in err) {
    return { message: String((err as { message: unknown }).message) };
  }
  try {
    return { message: JSON.stringify(err) };
  } catch {
    return { message: String(err) };
  }
}

// ═══════════════════════════════════════
// Output Formatting
// ═══════════════════════════════════════

function formatEntry(entry: LogEntry): string {
  const time = entry.timestamp.slice(11, 23); // HH:mm:ss.SSS
  const style = LEVEL_STYLE[entry.level];
  const levelTag = entry.level.toUpperCase().padEnd(5);

  let line = `${DIM}${time}${RESET} ${style}${levelTag}${RESET} [${entry.module}] ${entry.message}`;

  if (entry.data && Object.keys(entry.data).length > 0) {
    const compact = JSON.stringify(entry.data);
    // Only inline if short enough; otherwise newline
    if (compact.length <= 120) {
      line += ` ${DIM}${compact}${RESET}`;
    } else {
      line += `\n  ${DIM}${compact}${RESET}`;
    }
  }

  if (entry.error) {
    line += `\n  ${LEVEL_STYLE.error}Error: ${entry.error}${RESET}`;
  }
  if (entry.stack) {
    // Show only first 3 frames to reduce noise
    const frames = entry.stack.split('\n').slice(1, 4).map(f => `    ${f.trim()}`).join('\n');
    line += `\n${DIM}${frames}${RESET}`;
  }

  return line;
}

// ═══════════════════════════════════════
// Logger Factory
// ═══════════════════════════════════════

/**
 * Create a structured logger for a specific module.
 *
 * @param moduleName - The module identifier (e.g., 'orchestrator', 'react-loop')
 * @returns A Logger instance with debug/info/warn/error methods
 */
export function createLogger(moduleName: string): Logger {
  function emit(level: LogLevel, message: string, err?: unknown, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalMinLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: moduleName,
      message,
    };

    if (data) entry.data = data;

    if (err !== undefined && err !== null) {
      const normalized = normalizeError(err);
      entry.error = normalized.message;
      if (normalized.stack && level === 'error') {
        entry.stack = normalized.stack;
      }
    }

    const formatted = formatEntry(entry);

    switch (level) {
      case 'debug': console.debug(formatted); break;
      case 'info':  console.info(formatted); break;
      case 'warn':  console.warn(formatted); break;
      case 'error': console.error(formatted); break;
    }
  }

  return {
    debug: (message, data) => emit('debug', message, undefined, data),
    info: (message, data) => emit('info', message, undefined, data),
    warn: (message, data) => emit('warn', message, undefined, data),
    error: (message, err?, data?) => emit('error', message, err, data),
    child: (subModule) => createLogger(`${moduleName}:${subModule}`),
  };
}