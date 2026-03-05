/**
 * meta-agent-types.ts — 元Agent 类型定义 + 默认配置
 *
 * 从 meta-agent.ts 拆分 (v30.2)
 */

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 单模式参数覆盖 */
export interface ModeConfig {
  maxReactIterations?: number; // ReAct 最大迭代轮数
  contextHistoryLimit?: number; // 对话历史保留条数
  maxResponseTokens?: number; // 回复最大 token
  contextTokenLimit?: number; // 上下文 token 上限
}

export interface MetaAgentConfig {
  name: string; // 管家名字 (默认 "元Agent管家")
  userNickname: string; // 对用户的称呼 (默认 "你")
  personality: string; // 性格描述 (简短)
  systemPrompt: string; // 完整系统提示词 (可覆盖默认)
  contextHistoryLimit: number; // 对话历史保留条数 (默认 20)
  contextTokenLimit: number; // 上下文 token 上限 (默认 512000)
  maxResponseTokens: number; // 回复最大 token (默认 128000)
  maxReactIterations: number; // ReAct 工具循环最大迭代轮数 (默认 50)
  readFileLineLimit: number; // read_file 工具默认行数上限 (默认 1000, 最大2000)
  autoMemory: boolean; // 是否自动积累记忆 (默认 true)
  memoryInjectLimit: number; // 每次对话注入记忆条数上限 (默认 30)
  greeting: string; // 自定义开场白
  /** v23.0: 允许管家访问 git 历史/仓库信息 (默认关闭, 防止信息泄露) */
  allowGitAccess: boolean;
  /** v22.0: 各模式独立参数覆盖 (未设置的字段取全局值) */
  modeConfigs: Record<string, ModeConfig>;
}

export interface MetaAgentMemory {
  id: string;
  category: 'identity' | 'user_profile' | 'lessons' | 'facts' | 'conversation_summary';
  content: string;
  source: 'auto' | 'manual' | 'system';
  importance: number; // 1-10, 越高越重要
  /** v29.0: 记忆所属项目 — NULL 为全局记忆 */
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════
// Default Config
// ═══════════════════════════════════════

export const DEFAULT_CONFIG: MetaAgentConfig = {
  name: '元Agent管家',
  userNickname: '',
  personality: '专业、友好、高效',
  systemPrompt: '', // 空 = 使用内置默认
  contextHistoryLimit: 20,
  contextTokenLimit: 512000,
  maxResponseTokens: 128000,
  maxReactIterations: 50,
  readFileLineLimit: 1000,
  autoMemory: true,
  memoryInjectLimit: 30,
  greeting: '', // 空 = 使用内置默认
  allowGitAccess: false, // v23.0: 默认禁止管家访问 git 信息
  modeConfigs: {
    work: { maxReactIterations: 50, maxResponseTokens: 128000 },
    chat: { maxReactIterations: 5, maxResponseTokens: 32000, contextHistoryLimit: 30 },
    deep: { maxReactIterations: 80, maxResponseTokens: 128000, contextHistoryLimit: 40 },
    admin: { maxReactIterations: 30, maxResponseTokens: 64000, contextHistoryLimit: 20 },
  },
};

/** 根据模式取合并后的参数 */
export function getModeParam(config: MetaAgentConfig, mode: string, key: keyof ModeConfig): number {
  const modeOverride = config.modeConfigs?.[mode];
  if (modeOverride && modeOverride[key] !== undefined && modeOverride[key] !== null) {
    return modeOverride[key]!;
  }
  // 回退到全局值
  switch (key) {
    case 'maxReactIterations':
      return config.maxReactIterations;
    case 'contextHistoryLimit':
      return config.contextHistoryLimit;
    case 'maxResponseTokens':
      return config.maxResponseTokens;
    case 'contextTokenLimit':
      return config.contextTokenLimit;
    default:
      return (config[key as keyof MetaAgentConfig] as number) ?? 50;
  }
}
