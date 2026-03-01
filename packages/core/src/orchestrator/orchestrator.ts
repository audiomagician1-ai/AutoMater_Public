/**
 * Orchestrator — 主编排器
 * 
 * 融合 agent-swarm Orchestrator + Actant Agent 生命周期管理:
 * - 三阶段工作流: Init → Iterative Dev → Review
 * - 并行 Worker + Evaluator 循环
 * - 事件驱动 UI 更新
 */

import type {
  Project,
  AgentInstance,
  FeatureIndex,
  FeatureDetail,
  AgentRole,
} from '@agentforge/shared';
import { eventBus, AGENT_TEMPLATES } from '@agentforge/shared';
import type { LLMRouter } from '@agentforge/llm';
import { CostTracker } from '@agentforge/llm';
import { FeatureSelector } from '../feature/feature-selector.js';
import { AgentRunner } from '../agents/agent-runner.js';
import { Evaluator } from '../evaluator/evaluator.js';

export interface OrchestratorConfig {
  workerCount: number;
  maxRetries: number;
  cooldownMs: number;
  maxSessionDurationMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  workerCount: 3,
  maxRetries: 3,
  cooldownMs: 5000,
  maxSessionDurationMs: 300_000,
};

export class Orchestrator {
  private project: Project;
  private config: OrchestratorConfig;
  private llmRouter: LLMRouter;
  private featureSelector: FeatureSelector;
  private agentRunner: AgentRunner;
  private evaluator: Evaluator;
  private costTracker: CostTracker;
  private agents = new Map<string, AgentInstance>();
  private abortController = new AbortController();
  private running = false;

  constructor(params: {
    project: Project;
    llmRouter: LLMRouter;
    config?: Partial<OrchestratorConfig>;
  }) {
    this.project = params.project;
    this.llmRouter = params.llmRouter;
    this.config = { ...DEFAULT_CONFIG, ...params.config };
    this.featureSelector = new FeatureSelector();
    this.agentRunner = new AgentRunner(params.llmRouter);
    this.evaluator = new Evaluator(this.config.maxRetries);
    this.costTracker = new CostTracker(params.project.config.dailyBudgetUsd);
  }

  /** 获取当前状态 */
  getStatus() {
    return {
      running: this.running,
      project: this.project,
      agents: Array.from(this.agents.values()),
      features: this.featureSelector.getStats(),
      cost: {
        totalUsd: this.costTracker.getTotalCost(),
        budgetUsd: this.project.config.dailyBudgetUsd,
        isOverBudget: this.costTracker.isOverBudget(),
      },
    };
  }

  // ═══════════════════════════════════════════
  // Phase 1: Initialization (PM + Architect)
  // ═══════════════════════════════════════════

  /**
   * 运行初始化阶段
   * 
   * 1. PM Agent: 分析需求 → 生成 Feature List
   * 2. Architect Agent: 技术选型 → 骨架代码
   */
  async runInitialization(): Promise<{ features: FeatureIndex[]; success: boolean }> {
    this.running = true;
    eventBus.emit('project:status-changed', {
      projectId: this.project.id,
      from: this.project.status,
      to: 'initializing',
    });

    // --- PM Agent ---
    const pmAgent = this.spawnAgent('pm');
    const pmResult = await this.agentRunner.runSession({
      providerId: this.project.config.llmProviderId,
      model: this.project.config.strongModel,
      agent: pmAgent,
      systemPrompt: this.agentRunner.buildWorkerPrompt({
        role: 'pm',
        projectContext: '',
        features: [],
      }),
      userMessage: `用户需求:\n${this.project.wish}\n\n请分析此需求，拆解为 Feature 清单。输出 JSON 格式的 feature_list。`,
    });

    if (!pmResult.success) {
      return { features: [], success: false };
    }

    // --- 解析 Feature List ---
    let features: FeatureIndex[] = [];
    try {
      const jsonMatch = pmResult.output.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        features = JSON.parse(jsonMatch[1]);
      }
    } catch {
      // PM 输出解析失败，简化处理
      console.error('Failed to parse PM output as feature list');
    }

    this.featureSelector.loadFeatures(features);

    return { features, success: features.length > 0 };
  }

  // ═══════════════════════════════════════════
  // Phase 2: Iterative Execution (Workers)
  // ═══════════════════════════════════════════

  /**
   * 启动并行 Worker 循环
   * 
   * 参考 agent-swarm Orchestrator.run_workers():
   * Selector选任务 → 锁定 → 注入prompt → Worker → Evaluator → 重试/下一个
   */
  async runWorkers(): Promise<void> {
    this.running = true;
    eventBus.emit('project:status-changed', {
      projectId: this.project.id,
      from: this.project.status,
      to: 'developing',
    });

    const workerPromises: Promise<void>[] = [];

    for (let i = 0; i < this.config.workerCount; i++) {
      const workerId = `developer-${String(i + 1).padStart(3, '0')}`;
      workerPromises.push(this.workerLoop(workerId));
    }

    await Promise.all(workerPromises);
    this.running = false;
  }

  /**
   * 单个 Worker 循环 (from agent-swarm _worker_loop)
   */
  private async workerLoop(workerId: string): Promise<void> {
    const agent = this.spawnAgent('developer', workerId);
    let sessionCount = 0;

    while (!this.abortController.signal.aborted) {
      sessionCount++;

      // Step 1: Select & Lock
      const selected = this.featureSelector.selectAndLock(workerId);

      if (!selected) {
        if (this.featureSelector.allDone()) {
          eventBus.emit('agent:message', {
            agentId: workerId,
            content: 'All features completed!',
            type: 'log',
          });
          break;
        }
        // 等待
        await this.sleep(this.config.cooldownMs * 3);
        continue;
      }

      const featureIds = selected.map(f => f.id);

      eventBus.emit('agent:message', {
        agentId: workerId,
        content: `Session #${sessionCount}: Working on ${featureIds.join(', ')}`,
        type: 'log',
      });

      // Step 2: Load details (在完整实现中从文件加载)
      const details: FeatureDetail[] = selected.map(f => ({
        ...f,
        title: f.description,
        acceptanceCriteria: [],
        testCommands: [],
        affectedFiles: [],
        estimatedTime: '30min',
        completedAt: null,
        implementationSummary: null,
      }));

      // Step 3: Execute + Evaluate + Retry
      let attempt = 0;
      let retryContext: string | undefined;

      while (attempt < this.config.maxRetries && !this.abortController.signal.aborted) {
        attempt++;

        const prompt = this.agentRunner.buildWorkerPrompt({
          role: 'developer',
          projectContext: `Project: ${this.project.name}\nWish: ${this.project.wish}`,
          features: details,
          retryContext,
        });

        const result = await this.agentRunner.runSession({
          providerId: this.project.config.llmProviderId,
          model: this.project.config.workerModel,
          agent,
          systemPrompt: prompt,
          userMessage: `请实现以下 features: ${featureIds.join(', ')}。完成后明确标注每个 feature ID + "COMPLETED"。`,
        });

        // 记录成本
        this.costTracker.record({
          agentId: workerId,
          featureIds,
          model: this.project.config.workerModel,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });

        // Evaluate
        const evalResult = this.evaluator.evaluate({
          featureIds,
          features: details,
          agentId: workerId,
          sessionSuccess: result.success,
          output: result.output,
          attempt,
        });

        if (evalResult.verdict === 'pass') {
          this.featureSelector.markPassed(evalResult.passedIds, workerId);
          break;
        }

        if (evalResult.shouldRetry && evalResult.retryPrompt) {
          retryContext = evalResult.retryPrompt;
          continue;
        }

        // 不重试，解锁
        this.featureSelector.unlock(evalResult.failedIds);
        break;
      }

      // Cooldown
      await this.sleep(this.config.cooldownMs);
    }

    eventBus.emit('agent:stopped', { agentId: workerId, reason: 'loop_ended' });
  }

  // ═══════════════════════════════════════════
  // Agent 管理
  // ═══════════════════════════════════════════

  private spawnAgent(role: AgentRole, id?: string): AgentInstance {
    const agentId = id ?? `${role}-${Date.now()}`;
    const agent: AgentInstance = {
      id: agentId,
      projectId: this.project.id,
      role,
      status: 'idle',
      currentTask: null,
      sessionCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      createdAt: new Date().toISOString(),
      lastActiveAt: null,
    };

    this.agents.set(agentId, agent);
    eventBus.emit('agent:spawned', { agentId, role, projectId: this.project.id });
    return agent;
  }

  /** 停止所有 Worker */
  stop(): void {
    this.abortController.abort();
    this.running = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
