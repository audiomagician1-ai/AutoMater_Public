/**
 * safe-json.ts — 防御性 JSON 解析工具
 *
 * 所有从外部 / 数据库 / LLM 返回值读取的 JSON 都应使用此模块，
 * 防止 SyntaxError 导致未处理异常。
 *
 * v1.0 — 2026-03-02
 */

/**
 * 安全解析 JSON 字符串。
 * 解析失败时返回 fallback 而非抛异常。
 *
 * @param text       待解析文本
 * @param fallback   解析失败时的默认值
 * @param label      可选日志标签，用于诊断
 */
export function safeJsonParse<T>(text: string, fallback: T, label?: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    if (label) {
      console.warn(`[safeJsonParse] ${label}: invalid JSON, using fallback`, text?.slice(0, 200));
    }
    return fallback;
  }
}

/**
 * 安全解析 tool_call.function.arguments。
 * OpenAI/Anthropic 有时返回字符串、有时返回对象。
 */
export function safeParseToolArgs(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== 'string') return args;
  return safeJsonParse<Record<string, unknown>>(args, {}, 'tool_args');
}
