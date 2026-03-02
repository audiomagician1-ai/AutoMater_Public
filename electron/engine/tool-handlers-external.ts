/**
 * Tool Handlers — External tool execution (MCP + Skill)
 *
 * MCP 外部工具代理 + Skill 进化系统工具实现。
 * 从 tool-executor.ts (1857行) 拆出以提升可维护性。
 */

import { createLogger } from './logger';
import { skillEvolution } from './skill-evolution';
import type { ToolCall, ToolResult, ToolContext } from './tool-registry';

const log = createLogger('tool-handlers-external');

// ═══════════════════════════════════════
// MCP & Skill Proxy Execution
// ═══════════════════════════════════════

/**
 * 执行 MCP 外部工具。
 *
 * 工具名格式: mcp_{serverId}_{originalName}
 * 通过 mcpManager 路由到正确的服务器连接。
 */
export async function executeMcpTool(call: ToolCall): Promise<ToolResult> {
  try {
    const { mcpManager } = await import('./mcp-client');

    // 解析 serverId 和 原始工具名
    // 格式: mcp_{serverId}_{toolName}
    const withoutPrefix = call.name.slice(4); // 去掉 "mcp_"
    const underscoreIdx = withoutPrefix.indexOf('_');
    if (underscoreIdx === -1) {
      return { success: false, output: `Invalid MCP tool name format: ${call.name}` };
    }

    // serverId 可能包含下划线 (mcp_XXXX_YYYY 格式), 需要更智能地解析
    // 策略: 遍历所有已连接服务器，找到匹配的 tool
    const allTools = mcpManager.getAllTools();
    const matchedTool = allTools.find(t => `mcp_${t.serverId}_${t.name}` === call.name);

    if (!matchedTool) {
      return { success: false, output: `MCP tool not found: ${call.name}. Available: ${allTools.map(t => t.name).join(', ')}` };
    }

    const result = await mcpManager.callTool(matchedTool.name, matchedTool.serverId, call.arguments);

    const toolResult: ToolResult = {
      success: result.success,
      output: result.content.slice(0, 10_000),
      action: 'web',
    };

    // 如果包含图片，附加 _imageBase64
    if (result.imageBase64) {
      toolResult._imageBase64 = result.imageBase64;
    }

    return toolResult;
  } catch (err: unknown) {
    return { success: false, output: `MCP tool execution error: ${(err instanceof Error ? err.message : String(err))}` };
  }
}

/**
 * 执行 Skill 外部工具。
 *
 * 工具名格式: skill_{originalName}
 * 通过 skillManager 查找并执行。
 */
export async function executeSkillTool(call: ToolCall): Promise<ToolResult> {
  try {
    const { skillManager } = await import('./skill-loader');
    const result = await skillManager.executeSkill(call.name, call.arguments);
    return {
      success: result.success,
      output: result.output.slice(0, 10_000),
      action: 'shell',
    };
  } catch (err: unknown) {
    return { success: false, output: `Skill execution error: ${(err instanceof Error ? err.message : String(err))}` };
  }
}

// ═══════════════════════════════════════
// Skill Evolution Tool Implementations (v5.1)
// ═══════════════════════════════════════

export function executeSkillAcquire(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    const args = call.arguments;

    if (!args.name || !args.description || !args.trigger || !args.knowledge) {
      return { success: false, output: 'skill_acquire 需要 name, description, trigger, knowledge 参数' };
    }

    const skill = skillEvolution.acquire({
      name: args.name,
      description: args.description,
      trigger: args.trigger,
      tags: args.tags || [],
      knowledge: args.knowledge,
      execution: { type: 'prompt', promptTemplate: args.knowledge },
      source: {
        type: 'agent_acquired',
        projectId: ctx.projectId,
        agentId: (call.arguments._agentId as string) || 'unknown',
        timestamp: new Date().toISOString(),
      },
    });

    return {
      success: true,
      output: `✅ 新技能已习得:\n  ID: ${skill.id}\n  名称: ${skill.name}\n  成熟度: ${skill.maturity}\n  触发: ${skill.trigger}\n  标签: ${skill.tags.join(', ') || '无'}\n\n技能将在匹配的未来任务中自动推荐。使用 ≥3 次且成功率 ≥70% 后自动晋升为 proven。`,
      action: 'write',
    };
  } catch (err: unknown) {
    return { success: false, output: `技能习得失败: ${(err instanceof Error ? err.message : String(err))}` };
  }
}

export function executeSkillSearch(call: ToolCall): ToolResult {
  try {
    const query = call.arguments.query || '';
    const maxResults = call.arguments.max_results ?? 3;

    const matches = skillEvolution.searchSkills(query, { maxResults });

    if (matches.length === 0) {
      return { success: true, output: `未找到与 "${query}" 相关的技能。你可以在发现可复用模式时用 skill_acquire 习得新技能。`, action: 'read' };
    }

    const sections: string[] = [`找到 ${matches.length} 个相关技能:`];

    for (const match of matches) {
      const knowledge = skillEvolution.loadKnowledge(match.skill.id);
      sections.push([
        `\n### ${match.skill.id}: ${match.skill.name}`,
        `成熟度: ${match.skill.maturity} | 使用: ${match.skill.usedCount}次 | 成功率: ${Math.round(match.skill.successRate * 100)}%`,
        `触发: ${match.skill.trigger}`,
        `匹配: ${match.matchReason} (相关度: ${match.relevance}%)`,
        knowledge ? `\n${knowledge.slice(0, 1500)}` : '',
      ].join('\n'));
    }

    return { success: true, output: sections.join('\n'), action: 'read' };
  } catch (err: unknown) {
    return { success: false, output: `技能搜索失败: ${(err instanceof Error ? err.message : String(err))}` };
  }
}

export function executeSkillImprove(call: ToolCall): ToolResult {
  try {
    const args = call.arguments;

    if (!args.skill_id || !args.change_note) {
      return { success: false, output: 'skill_improve 需要 skill_id 和 change_note 参数' };
    }

    const skill = skillEvolution.improve(args.skill_id, {
      knowledge: args.knowledge,
      trigger: args.trigger,
      changeNote: args.change_note,
      author: args._agentId ? `agent:${args._agentId}` : 'agent:unknown',
    });

    if (!skill) {
      return { success: false, output: `技能 ${args.skill_id} 不存在` };
    }

    return {
      success: true,
      output: `✅ 技能已改进:\n  ID: ${skill.id}\n  名称: ${skill.name}\n  版本: v${skill.version}\n  变更: ${args.change_note}`,
      action: 'write',
    };
  } catch (err: unknown) {
    return { success: false, output: `技能改进失败: ${(err instanceof Error ? err.message : String(err))}` };
  }
}

export function executeSkillRecordUsage(call: ToolCall, ctx: ToolContext): ToolResult {
  try {
    const args = call.arguments;

    if (!args.skill_id || args.success === undefined) {
      return { success: false, output: 'skill_record_usage 需要 skill_id 和 success 参数' };
    }

    skillEvolution.recordUsage(
      args.skill_id,
      ctx.projectId,
      args.success,
      args.feedback,
      args._agentId as string | undefined,
    );

    return {
      success: true,
      output: `已记录技能 ${args.skill_id} 使用结果: ${args.success ? '✅ 成功' : '❌ 失败'}${args.feedback ? ` (反馈: ${args.feedback})` : ''}`,
      action: 'write',
    };
  } catch (err: unknown) {
    return { success: false, output: `记录使用失败: ${(err instanceof Error ? err.message : String(err))}` };
  }
}
