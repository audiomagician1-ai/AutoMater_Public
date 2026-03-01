/**
 * AgentRunner — 单个 Agent 的会话执行器
 * 
 * 负责:
 * 1. 加载 Prompt 模板
 * 2. 注入上下文 (Feature 详情、项目状态、重试信息)
 * 3. 调用 LLM 并收集输出
 * 4. 解析结构化结果
 */

import type { AgentRole, AgentInstance, ChatMessage, LLMResponse, FeatureDetail } from '@agentforge/shared';
import { AGENT_TEMPLATES, eventBus } from '@agentforge/shared';
import type { LLMRouter } from '@agentforge/llm';

export interface SessionConfig {
  /** LLM Provider ID */
  providerId: string;
  /** 模型名称 */
  model: string;
  /** Agent 实例 */
  agent: AgentInstance;
  /** 系统 Prompt (已注入上下文) */
  systemPrompt: string;
  /** 用户消息 */
  userMessage: string;
  /** 最大 tokens */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
}

export interface SessionResult {
  success: boolean;
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export class AgentRunner {
  private llmRouter: LLMRouter;
  private promptTemplates = new Map<string, string>();

  constructor(llmRouter: LLMRouter) {
    this.llmRouter = llmRouter;
  }

  /** 注册 Prompt 模板 */
  registerPrompt(role: AgentRole, template: string): void {
    this.promptTemplates.set(role, template);
  }

  /**
   * 构建 Worker Prompt (参考 agent-swarm orchestrator._build_worker_prompt)
   * 
   * 注入顺序:
   * 1. 角色 Prompt 模板
   * 2. 项目上下文 (CLAUDE.md)
   * 3. 预选 Feature 信息
   * 4. 重试上下文 (如有)
   */
  buildWorkerPrompt(params: {
    role: AgentRole;
    projectContext: string;
    features: FeatureDetail[];
    retryContext?: string;
  }): string {
    const template = this.promptTemplates.get(params.role) ?? '';

    const featureSection = params.features.map(f => `
## Feature: ${f.id} — ${f.title}
- **Description**: ${f.description}
- **Priority**: P${f.priority}
- **Acceptance Criteria**:
${f.acceptanceCriteria.map(c => `  - ${c}`).join('\n')}
- **Test Commands**:
${f.testCommands.map(c => `  - \`${c}\``).join('\n')}
- **Affected Files**:
${f.affectedFiles.map(c => `  - ${c}`).join('\n')}
`).join('\n---\n');

    let prompt = template;
    prompt += '\n\n# Project Context\n' + params.projectContext;
    prompt += '\n\n# Assigned Features\n' + featureSection;

    if (params.retryContext) {
      prompt += '\n\n# Retry Context (Previous Attempt Failed)\n' + params.retryContext;
    }

    return prompt;
  }

  /** 执行一次 Agent 会话 */
  async runSession(config: SessionConfig): Promise<SessionResult> {
    const { agent } = config;

    eventBus.emit('agent:status-changed', {
      agentId: agent.id,
      from: agent.status,
      to: 'working',
    });

    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: config.userMessage },
      ];

      const response = await this.llmRouter.chat({
        providerId: config.providerId,
        model: config.model,
        messages,
        temperature: config.temperature ?? 0.3,
        maxTokens: config.maxTokens ?? 4096,
      });

      eventBus.emit('agent:message', {
        agentId: agent.id,
        content: response.content,
        type: 'output',
      });

      return {
        success: true,
        output: response.content,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      eventBus.emit('agent:message', {
        agentId: agent.id,
        content: errorMsg,
        type: 'error',
      });

      return {
        success: false,
        output: '',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * 流式执行 Agent 会话
   * 实时推送 delta 到事件总线
   */
  async *runSessionStream(config: SessionConfig): AsyncIterable<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: config.userMessage },
    ];

    const stream = this.llmRouter.chatStream({
      providerId: config.providerId,
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.3,
      maxTokens: config.maxTokens ?? 4096,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.delta) {
        yield chunk.delta;
      }
    }
  }
}
