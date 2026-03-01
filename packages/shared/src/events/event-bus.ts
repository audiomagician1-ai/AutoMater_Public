/**
 * 事件总线 — 进程内 Agent 间通信
 * 
 * 设计原则 (from agent-swarm):
 * - 事件驱动，松耦合
 * - 类型安全
 */

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

export interface ForgeEvent {
  /** 项目生命周期 */
  'project:created': { projectId: string };
  'project:status-changed': { projectId: string; from: string; to: string };
  
  /** Agent 生命周期 */
  'agent:spawned': { agentId: string; role: string; projectId: string };
  'agent:status-changed': { agentId: string; from: string; to: string };
  'agent:message': { agentId: string; content: string; type: 'log' | 'output' | 'error' };
  'agent:stopped': { agentId: string; reason: string };
  
  /** Feature 流转 */
  'feature:locked': { featureId: string; agentId: string };
  'feature:status-changed': { featureId: string; from: string; to: string };
  'feature:completed': { featureId: string; agentId: string };
  
  /** Evaluator */
  'eval:pass': { featureIds: string[]; agentId: string };
  'eval:fail': { featureIds: string[]; agentId: string; reason: string };
  'eval:retry': { featureIds: string[]; agentId: string; attempt: number };
  
  /** 成本 */
  'cost:record': { agentId: string; costUsd: number; totalUsd: number };
  'cost:budget-warning': { currentUsd: number; budgetUsd: number };
  
  /** 用户交互 */
  'user:approval-required': { requestId: string; type: string; description: string };
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<K extends keyof ForgeEvent>(event: K, handler: EventHandler<ForgeEvent[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    
    // 返回 unsubscribe 函数
    return () => {
      this.handlers.get(event)?.delete(handler as EventHandler);
    };
  }

  async emit<K extends keyof ForgeEvent>(event: K, data: ForgeEvent[K]): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    
    const promises = Array.from(handlers).map(handler => {
      try {
        return Promise.resolve(handler(data));
      } catch (err) {
        console.error(`EventBus handler error for ${event}:`, err);
        return Promise.resolve();
      }
    });
    
    await Promise.all(promises);
  }

  off<K extends keyof ForgeEvent>(event: K, handler: EventHandler<ForgeEvent[K]>): void {
    this.handlers.get(event)?.delete(handler as EventHandler);
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** 全局事件总线实例 */
export const eventBus = new EventBus();
