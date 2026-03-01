# 临时工作流 (Ephemeral Workflow) 架构设计

> v5.5 | 2026-03-01

## 1. 问题定义

在项目开发过程中，存在一类**具有完整生命周期但不产出永久制品**的工作流：

| 场景 | 触发时机 | 多Agent协作 | 中间产物 | 最终产出 |
|------|----------|-------------|----------|----------|
| 全量回归测试 | 版本发布前 / 重大变更后 | QA + Developer（修复） | 测试报告、失败用例分析 | Pass/Fail 结论 + 修复 patch |
| 全量代码审查 | 里程碑完成 / 技术债清理 | Architect + QA + Developer | 逐文件审查意见、重构建议 | 汇总报告 + 可选 patch |
| 架构复盘 | Sprint 结束 / 性能瓶颈 | PM + Architect | 架构分析、瓶颈诊断 | 复盘报告 + 优化建议 |
| 安全审计 | 合规要求 / 上线前 | Security + QA | 漏洞扫描、合规检查 | 审计报告 + 修复 patch |
| 性能基准 | 版本对比 / 优化验证 | Developer + QA | 基准数据、profiling | 性能报告 |

**共性特征**：
- 有明确的开始和结束（非持续运行）
- 需要多 agent 协作（不是单次 LLM 调用）
- 产生大量中间步骤/数据，但不需要固化到正式产品文档中
- 最终结论需要归档，但过程数据可丢弃

## 2. 2026 先进实践参考

### 2.1 Society Agent (TechRxiv 2026)
- **Persistent Supervisors + Ephemeral Workers**：管理者持久存在，工人按需创建销毁
- **Mind-Tool 文件记忆系统**：持久化演化知识，worker 共享但不占用长期存储
- 关键: **零 token 心跳监控** + **自重配置**

### 2.2 Cursor Scaling Agents (2026)
- **Planner → Worker → Judge** 三层架构
- Planner 持续探索代码库创建任务，Worker 独立执行不互相协调
- **Judge agent** 在每个周期结束时评估是否继续
- 失败教训: 平等 agent + 锁机制 → 20 个 agent 退化成 2-3 个的吞吐量

### 2.3 Gas Town / Polecats (Steve Yegge 2026)
- **Polecats**: 临时 worker agents，spawn → complete task → disappear
- **Git worktrees** 做工作隔离，每个 hook 是独立 worktree
- **Molecules**: 原子任务链，崩溃后可恢复（git 持久化）

### 2.4 Ephemeral Environment Best Practices
- 生命周期绑定到触发事件（PR、release tag、手动触发）
- 自动创建 → 执行 → 归档结论 → 销毁环境
- 短期凭证，runtime 注入，自动轮换

## 3. 架构设计

### 3.1 核心概念: EphemeralMission

```
EphemeralMission {
  id: string           // 唯一标识
  projectId: string    // 所属项目
  type: MissionType    // regression_test | code_review | retrospective | security_audit | perf_benchmark
  status: 'pending' | 'planning' | 'executing' | 'judging' | 'completed' | 'failed' | 'cancelled'
  
  // 三层架构 (Cursor 模式)
  planner: AgentRef      // 规划阶段: 分析范围、拆解任务
  workers: AgentRef[]    // 执行阶段: 并行处理各子任务
  judge: AgentRef        // 评估阶段: 判断是否达标
  
  // 生命周期
  createdAt: timestamp
  startedAt: timestamp
  completedAt: timestamp
  ttlHours: number       // 最大存活时间 (超时自动 fail)
  
  // 产物管理
  workDir: string        // 临时工作目录 (.agentforge/missions/{id}/)
  conclusion: string     // 最终结论 (归档)
  patches: PatchRef[]    // 产出的代码修复 (可选应用到主分支)
  
  // 归档策略
  archivePolicy: 'conclusion_only' | 'conclusion_and_patches' | 'full'
}
```

### 3.2 执行流程

```
用户/Agent触发 → 创建 Mission
  ↓
Phase 1: PLANNING (Planner Agent)
  - 分析范围 (哪些文件/模块/features)
  - 拆解为原子任务 (MissionTask[])
  - 评估资源需求 (token 预算)
  ↓
Phase 2: EXECUTING (Worker Agents, 并行)
  - 每个 worker 领取一个 MissionTask
  - 独立执行，结果写入 workDir
  - 失败可重试 (max 2 次)
  ↓
Phase 3: JUDGING (Judge Agent)
  - 汇总所有 worker 结果
  - 判断是否达标 (pass/fail/partial)
  - 生成结论报告
  - 如果 partial → 可回到 Phase 2 补充执行
  ↓
Phase 4: ARCHIVING
  - conclusion → 归档到项目记忆
  - patches → 提供给用户选择是否应用
  - workDir → 按 archivePolicy 处理 (删除或保留)
  - Mission 标记为 completed
```

### 3.3 与正式流水线的隔离

| 方面 | 正式流水线 (Orchestrator) | 临时工作流 (EphemeralMission) |
|------|--------------------------|------------------------------|
| 产出 | features, 设计文档, 代码 | 结论报告, 可选 patches |
| 状态 | 永久 (DB features 表) | 临时 (missions 表, 可清理) |
| 工作目录 | `workspace_path/` | `.agentforge/missions/{id}/` |
| 文档 | 设计文档/需求文档 (永久) | 任务报告 (可丢弃) |
| 对项目状态的影响 | 直接修改 features 状态 | 不修改，仅建议 |

### 3.4 数据库设计

```sql
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- regression_test, code_review, etc.
  status TEXT NOT NULL DEFAULT 'pending',
  config TEXT DEFAULT '{}',        -- JSON: scope, budget, ttl, etc.
  plan TEXT,                       -- JSON: planner 输出的任务清单
  conclusion TEXT,                 -- 最终结论 (归档)
  patches TEXT DEFAULT '[]',       -- JSON: [{file, diff, applied}]
  token_usage INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, running, passed, failed, skipped
  agent_id TEXT,
  input TEXT,                      -- JSON: 任务输入
  output TEXT,                     -- JSON: 任务结果
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);
```

### 3.5 预定义 Mission 类型

#### 全量回归测试 (regression_test)
- **Planner**: 扫描所有 features + test specs → 生成测试任务清单
- **Workers**: 每个 worker 执行一组测试 (读代码 + test spec → 判断是否通过)
- **Judge**: 汇总测试结果 → pass rate → 如果 <95% 则 fail
- **Patches**: 对失败的测试生成修复建议

#### 全量代码审查 (code_review)
- **Planner**: 扫描工作区文件 → 按模块/功能分组
- **Workers**: 每个 worker 审查一个模块 (代码质量, 安全, 规范)
- **Judge**: 汇总问题严重程度 → 评分 → 是否阻塞
- **Patches**: 自动修复简单问题 (formatting, naming, etc.)

#### 架构复盘 (retrospective)
- **Planner**: 收集项目当前架构、设计决策、已知痛点
- **Workers**: 分析各维度 (性能, 扩展性, 可维护性, 安全)
- **Judge**: 综合评估 → 改进优先级排序 → 输出复盘报告

## 4. UI 集成

在 WorkflowPage 或独立的 MissionsPage 中:
- 「发起任务」按钮 → 选择类型 → 配置范围 → 启动
- 实时进度卡片 (类似导入分析的 phase cards)
- 完成后显示结论 + 可选应用 patches
- 历史 mission 列表 (可清理)

## 5. Token 效率考量

- Planner 使用 strongModel (需要全局理解)
- Workers 使用 workerModel (执行具体任务)
- Judge 使用 strongModel (需要综合判断)
- 每个 mission 有独立 token 预算 (防止失控)
- 中间结果用文件存储而非上下文传递 (节省 token)
