/**
 * 错误消息处理工具
 * v15.0: 增加用户友好的中文错误映射
 */

/**
 * Extract a clean error message string from an unknown thrown value.
 * Use in catch blocks: `catch (err: unknown) { toErrorMessage(err); }`
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * 将技术错误映射为用户友好的中文消息
 * @returns { message: 用户展示文案, suggestion: 建议操作 }
 */
export function humanizeError(err: unknown): { message: string; suggestion?: string } {
  const raw = toErrorMessage(err);
  const lower = raw.toLowerCase();

  // HTTP 状态码
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return { message: 'API Key 无效或已过期', suggestion: '请前往设置页检查并更新 API Key' };
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return { message: '访问被拒绝', suggestion: '请检查 API Key 的权限设置' };
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many')) {
    return { message: '请求过于频繁', suggestion: '请稍等片刻后重试' };
  }
  if (lower.includes('500') || lower.includes('internal server error')) {
    return { message: 'AI 服务暂时不可用', suggestion: '这通常是临时问题，请稍后重试' };
  }
  if (lower.includes('502') || lower.includes('503') || lower.includes('504')) {
    return { message: 'AI 服务暂时不可用', suggestion: '服务器维护中，请几分钟后重试' };
  }
  if (lower.includes('413') || lower.includes('too large')) {
    return { message: '请求内容过长', suggestion: '请精简需求描述或拆分为多个小需求' };
  }

  // 网络错误
  if (lower.includes('enotfound') || lower.includes('dns') || lower.includes('getaddrinfo')) {
    return { message: '无法连接到 AI 服务', suggestion: '请检查网络连接和代理设置' };
  }
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return { message: '连接被拒绝', suggestion: '请检查 API 地址是否正确' };
  }
  if (lower.includes('econnreset') || lower.includes('socket hang up')) {
    return { message: '网络连接中断', suggestion: '网络不稳定，请重试' };
  }
  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return { message: '请求超时', suggestion: '网络较慢或请求过于复杂，请重试' };
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return { message: '网络连接失败', suggestion: '请检查网络连接' };
  }

  // LLM 特定错误
  if (lower.includes('model not found') || lower.includes('model_not_found') || lower.includes('does not exist')) {
    return { message: '模型不存在', suggestion: '请在设置中检查模型名称是否正确' };
  }
  if (lower.includes('context length') || lower.includes('max_tokens') || lower.includes('maximum context')) {
    return { message: '内容超出模型处理限制', suggestion: '项目规模较大，系统会自动压缩后重试' };
  }
  if (lower.includes('invalid_api_key') || lower.includes('api key')) {
    return { message: 'API Key 格式不正确', suggestion: '请检查是否完整复制了 API Key' };
  }
  if (lower.includes('billing') || lower.includes('quota') || lower.includes('insufficient')) {
    return { message: 'API 额度不足', suggestion: '请检查 API 服务商账户余额' };
  }
  if (lower.includes('content_filter') || lower.includes('content_policy')) {
    return { message: '内容被安全策略过滤', suggestion: '请调整需求描述，避免敏感内容' };
  }

  // 文件系统
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return { message: '找不到文件或目录', suggestion: '路径可能已变更，请刷新后重试' };
  }
  if (lower.includes('eacces') || lower.includes('permission denied') || lower.includes('eperm')) {
    return { message: '没有文件访问权限', suggestion: '请检查目录权限或以管理员身份运行' };
  }
  if (lower.includes('enospc') || lower.includes('no space')) {
    return { message: '磁盘空间不足', suggestion: '请清理磁盘空间后重试' };
  }

  // Git 错误
  if (lower.includes('not a git repository')) {
    return { message: '目录不是 Git 仓库', suggestion: '请确认选择的是正确的项目目录' };
  }
  if (lower.includes('authentication failed') && lower.includes('git')) {
    return { message: 'Git 认证失败', suggestion: '请检查 GitHub Token 是否有效' };
  }

  // 通用 — 如果无法映射，美化原始消息
  if (raw.length > 100) {
    return { message: '操作失败', suggestion: raw.slice(0, 100) + '...' };
  }
  return { message: raw };
}

/**
 * 获取用户友好的错误展示文本 (单行)
 */
export function friendlyErrorMessage(err: unknown): string {
  const { message, suggestion } = humanizeError(err);
  return suggestion ? `${message}（${suggestion}）` : message;
}

