/**
 * IPC 输入校验工具 — 轻量运行时参数验证
 *
 * 所有 ipcMain.handle 回调接收的参数来自渲染进程 IPC 序列化，
 * 属于不可信输入。此模块提供基本断言防御。
 *
 * v17.1 — 2026-03-02
 */

export class IpcValidationError extends Error {
  constructor(handler: string, message: string) {
    super(`[IPC:${handler}] ${message}`);
    this.name = 'IpcValidationError';
  }
}

// ═══════════════════════════════════════
// Primitive assertions
// ═══════════════════════════════════════

export function assertString(handler: string, name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new IpcValidationError(handler, `"${name}" must be string, got ${typeof value}`);
  }
}

export function assertNonEmptyString(handler: string, name: string, value: unknown): asserts value is string {
  assertString(handler, name, value);
  if (value.trim().length === 0) {
    throw new IpcValidationError(handler, `"${name}" must be non-empty string`);
  }
}

export function assertNumber(handler: string, name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new IpcValidationError(handler, `"${name}" must be number, got ${typeof value}`);
  }
}

export function assertBoolean(handler: string, name: string, value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new IpcValidationError(handler, `"${name}" must be boolean, got ${typeof value}`);
  }
}

export function assertObject(handler: string, name: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IpcValidationError(handler, `"${name}" must be object, got ${value === null ? 'null' : typeof value}`);
  }
}

export function assertArray(handler: string, name: string, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new IpcValidationError(handler, `"${name}" must be array, got ${typeof value}`);
  }
}

// ═══════════════════════════════════════
// Optional / nullable helpers
// ═══════════════════════════════════════

export function assertOptionalString(handler: string, name: string, value: unknown): asserts value is string | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new IpcValidationError(handler, `"${name}" must be string or undefined, got ${typeof value}`);
  }
}

export function assertOptionalNumber(handler: string, name: string, value: unknown): asserts value is number | undefined {
  if (value !== undefined && value !== null && (typeof value !== 'number' || Number.isNaN(value))) {
    throw new IpcValidationError(handler, `"${name}" must be number or undefined, got ${typeof value}`);
  }
}

// ═══════════════════════════════════════
// Domain-specific: projectId / featureId
// ═══════════════════════════════════════

/** 断言有效的项目 ID (UUID 或 nanoid 格式) */
export function assertProjectId(handler: string, value: unknown): asserts value is string {
  assertNonEmptyString(handler, 'projectId', value);
  if (value.length > 64) {
    throw new IpcValidationError(handler, `projectId too long (${value.length} chars)`);
  }
}

/** 断言有效的 feature ID */
export function assertFeatureId(handler: string, value: unknown): asserts value is string {
  assertNonEmptyString(handler, 'featureId', value);
}

// ═══════════════════════════════════════
// Convenience: validate handler wrapper
// ═══════════════════════════════════════

/**
 * 包装 IPC handler，自动捕获验证错误并返回结构化错误
 *
 * ```ts
 * ipcMain.handle('project:create', safeHandler('project:create', async (_e, name, options) => {
 *   assertNonEmptyString('project:create', 'name', name);
 *   // ... handler logic
 * }));
 * ```
 */
export function safeHandler<T extends unknown[], R>(
  handlerName: string,
  fn: (event: Electron.IpcMainInvokeEvent, ...args: T) => R,
): (event: Electron.IpcMainInvokeEvent, ...args: T) => R | Promise<{ error: string }> {
  return (event: Electron.IpcMainInvokeEvent, ...args: T) => {
    try {
      const result = fn(event, ...args);
      // If the handler returns a promise, catch async validation errors too
      if (result instanceof Promise) {
        return (result as Promise<unknown>).catch((err: unknown) => {
          if (err instanceof IpcValidationError) {
            return { error: err.message };
          }
          throw err;
        }) as R;
      }
      return result;
    } catch (err) {
      if (err instanceof IpcValidationError) {
        return { error: err.message } as unknown as R;
      }
      throw err;
    }
  };
}
