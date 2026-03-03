# 🧠 记忆与经验进化计划 (Memory & Experience Evolution Plan)

> **版本**: v2.0 (整合版)  
> **日期**: 2026-03-02  
> **输入**: 记忆体系审计 + 2026前沿调研 + 跨项目工程洞察 (`CROSS-PROJECT-INSIGHTS-2026-03.md`)  
> **设计原则**: 复用现有存储 > 新建模块，渐进式 hook > 独立 Agent 进程，硬约束 > 软约束

---

## 一、现有体系审计

### 1.1 六大记忆模块

| 模块 | 文件 | 存储 | 职责 |
|------|------|------|------|
| **3-Layer Memory** | `memory-system.ts` | MD 文件 (global/project/role) | 全局偏好 · 项目踩坑 · 角色经验 |
| **Cross-Project** | `cross-project.ts` | `%APPDATA%/knowledge/` JSON+MD | 跨项目经验池，按技术栈标签分类 |
| **Skill Evolution** | `skill-evolution.ts` | `%APPDATA%/evolved-skills/` JSON+MD | 技能 CRUD · 成熟度推进 · 搜索匹配 |
| **Decision Log** | `decision-log.ts` | `.automater/decision-log.jsonl` + 内存 | 文件声明 · 冲突检测 · Worker 广播 |
| **Scratchpad** | `scratchpad.ts` | `.automater/scratchpad/{agentId}.json` | 持久化工作记忆 (harness 自动 + Agent 主动) |
| **Conversation Backup** | `conversation-backup.ts` | `.automater/backups/` + SQLite | 会话备份/恢复 · Feature 关联 |

### 1.2 经验提取触发点 — 现有 vs 缺失

```
✅ 已有触发                          ❌ 缺失触发
─────────────────────────────        ─────────────────────────────
PM/Arch/Docs → backupConversation    ① 对话结束 → 无自动反思
Developer → scratchpad harness       ② Feature 完成(非QA路径) → 无经验提取
QA 通过 → extractLessons (LLM)       ③ PM 驳回/死循环/超时 → 失败经验无提取
Feature 完成 → broadcastFilesCreated  ④ 跨项目经验 → 仅 finalize 时触发
Finalize → extractFromProjectMemory   ⑤ 技能结晶 → 仅 Agent 手动 skill_acquire
```

### 1.3 关键弱点 (与跨项目洞察交叉验证)

| 弱点 | 严重度 | 洞察来源 |
|------|--------|----------|
| **无 Reflection 循环** — 做完直接 backup，不反思 | 🔴 P0 | memory-plan 审计 + agent-memory "先暂存后合并" |
| **Agent 无 Session Plan** — 直接进 ReAct 循环，不做规划 | 🔴 P0 | agent-swarm G3 "每轮 ReAct 前执行 Session Plan" |
| **QA 反馈不回传** — Developer 重试时不知道具体哪里失败 | 🔴 P0 | agent-swarm G4 "诊断式 retry prompt" |
| **Prompt 软约束** — "请注意…" 被 LLM 忽略 | 🟡 P0 | agent-memory "硬约束 > 软约束" |
| **跨 Feature 记忆为零** — Agent 处理 B 时丢失 A 的理解 | 🔴 P1 | agent-memory G1 + Actant "Instance Memory" |
| **Feature 单层传入** — 50+ feature 全量传 LLM 浪费 token | 🟡 P1 | agent-swarm G5 "两层清单: 索引 + 详情" |
| **跨项目经验仅 finalize 提取** — 未完成项目经验丢失 | 🔴 P1 | memory-plan 审计 |
| **无工作现场快照** — 中断后上下文不可恢复 | 🟡 P1 | agent-memory G9 "task checkpoint" |
| **成本追踪无 feature 粒度** | 🟡 P2 | agent-swarm G10 |
| **无不变量验证** — 多轮循环状态漂移未检测 | 🟡 P2 | Actant G6 "endurance testing" |

---

## 二、前沿参考 (精选)

只保留对实施有直接指导意义的参考，不罗列理论框架。

| 系统 | 核心启发 | 落地方式 |
|------|----------|----------|
| **SWE-Exp** (arXiv 2507.23361) | 多层经验银行 + 成功/失败轨迹双提取 → SWE-bench 73% | 扩展 `extractLessons` 为多层提取 |
| **Reflexion** (NeurIPS 2023) | 做→反思→记→重试，最简有效 | `harvestPostSession` hook |
| **agent-memory** (内部) | 写保护 + 容量限制 + FIFO 淘汰 + 硬约束 | 经验条目容量上限 + prompt 改写 |
| **agent-swarm** (内部) | Session Plan + 诊断式 retry + 两层清单 | Sprint 1 直接可做 |
| **Actant** (内部) | 四层记忆进化 + 不变量验证 + spec 驱动 | Instance Memory + invariants test |
| **Voyager** (NeurIPS 2023) | 技能库自动结晶 + 验证 + 复用 | 复用现有 `skill-evolution.ts` |
| **SICA** (NeurIPS 2025) | Agent 编辑自身代码，17-53% 提升 | 远期目标，依赖 quality-gate |

---

## 三、整合差距矩阵

合并两份报告的差距项，消除重复，按**实施依赖顺序**排列：

| # | 差距 | 改动点 | 新增代码 | 改动量 | Sprint |
|---|------|--------|----------|--------|--------|
| D1 | Prompt 硬约束化 | `react-loop.ts` prompt 模板 | 0行 | 改写 | **S1** |
| D2 | QA 诊断注入到 retry | `react-loop.ts` retry 逻辑 | ~10行 | 小 | **S1** |
| D3 | Feature summary 字段 | `types.ts` + DB migration | ~15行 | 小 | **S1** |
| D4 | Post-session 反思 hook | 新 `experience-harvester.ts` + `react-loop.ts` 挂载 | ~150行 | 中 | **S2** |
| D5 | Post-feature 经验提取 (含失败路径) | `experience-harvester.ts` + `worker-phase.ts`/`orchestrator.ts` 挂载 | ~80行 | 中 | **S2** |
| D6 | Agent checkpoint (工作现场快照) | 扩展 `scratchpad.ts` 加 checkpoint 段 | ~60行 | 小 | **S2** |
| D7 | Session Planning 阶段 | `react-loop.ts` 入口新增 planning step | ~80行 | 中 | **S3** |
| D8 | 跨 Feature Instance Memory | 扩展 `memory-system.ts` role memory → 含 instance 经验 | ~100行 | 中 | **S3** |
| D9 | 跨项目经验实时提取 | `experience-harvester.ts` 的 post-feature → `contributeKnowledge` | ~30行 | 小 | **S3** |
| D10 | 经验容量管理 + 淘汰 | `cross-project.ts` + `memory-system.ts` 加 FIFO/淘汰 | ~60行 | 小 | **S3** |
| D11 | Per-feature 成本追踪 | `react-loop.ts` + `event-store.ts` | ~40行 | 小 | **S3** |
| D12 | 技能自动结晶 | `experience-harvester.ts` 中触发 `skillEvolution.acquire` | ~50行 | 小 | **S4** |
| D13 | 不变量验证测试 | 新 `__tests__/invariants.test.ts` | ~200行 | 中 | **S4** |
| D14 | 语义去重 (TF-IDF) | `cross-project.ts` 增强 | ~100行 | 中 | **S4** |

---

## 四、实施路线图

### 设计原则

1. **不引入新的 Agent 角色** — "管家" 功能拆解为 hooks + 定时函数，挂在现有流程中
2. **不新建 SQLite 表** — 经验写入现有 `project-memory.md` / `cross-project _index.json` / `skill-index.json`
3. **不引入新的外部依赖** — TF-IDF 手写，不引 embedding 模型
4. **每个 Sprint 独立可验证** — 不依赖后续 Sprint 的完成

---

### Sprint 1: 零依赖速修 (1-2h)

> 不新增文件，只改现有代码。立竿见影。

#### S1-1: Prompt 硬约束化 (D1)

将 `react-loop.ts` 和 phase prompt 中的软性表述改为硬约束：

```
// Before                          // After
"请注意不要修改..."               → "禁止修改以下文件: ..."
"建议先运行测试"                   → "必须在提交前运行 run_test"
"尽量使用已有的组件"               → "禁止重复实现已有模块中的功能"
```

**验证**: grep "请注意|建议|尽量" 确认替换完成。

#### S1-2: QA 诊断注入到 Developer retry (D2)

在 `worker-phase.ts` 的 QA 失败重试路径中，将 QA 报告注入 Developer 的下一轮 system prompt：

```typescript
// worker-phase.ts, QA 失败后重新调用 reactDeveloperLoop 前:
const retryContext = `## QA 诊断报告 (attempt ${qaAttempt})\n` +
  `**评分**: ${qaScore}/10\n**问题**: ${qaFeedback}\n` +
  `**必须修复以上问题后再提交。禁止忽略 QA 反馈。**`;
// 注入到 feature._qaRetryContext, react-loop 中读取并 append 到 system prompt
```

**验证**: QA 失败后 Developer 的 system prompt 中包含 QA 报告文本。

#### S1-3: Feature summary 字段 (D3)

```typescript
// types.ts FeatureRow 增加:
summary?: string;  // PM 一句话摘要 (<80字), 用于 Agent 上下文中的索引层

// pm-phase.ts 生成 feature 时填写 summary
// context-collector.ts 在 feature 列表注入时, 仅传 id+title+summary, 不传全量 description
```

**验证**: PM 生成的 feature 有 summary 字段，context-collector 输出 token 减少。

---

### Sprint 2: 反思闭环 + 现场快照 (3-5h)

> 核心产出: 1 个新文件 `experience-harvester.ts`，3 处 hook 挂载点。

#### S2-1: 新建 `experience-harvester.ts` (~150行) (D4 + D5)

**不引入新存储格式**，产出直接写入现有的 `project-memory.md` 和 `cross-project`：

```typescript
/**
 * Experience Harvester — 经验收割钩子
 * 
 * 设计哲学 (借鉴 agent-memory):
 *   - 由 harness 强制触发，不依赖 Agent 自觉
 *   - 先收割再去重，宁多勿漏
 *   - 产出写入已有存储 (project-memory / cross-project / role-memory)
 *   - 容量有限: project-memory 的 "## 经验教训" 段落上限 50 条 (FIFO)
 */

import { callLLM, calcCost, resolveModel } from './llm-client';
import { selectModelTier } from './model-selector';
import { appendProjectMemory, appendRoleMemory } from './memory-system';
import { contributeKnowledge } from './cross-project';
import { createLogger } from './logger';
import type { AppSettings } from './types';

const log = createLogger('experience-harvester');

// ═══════════════════════════════════════
// Post-Session: 轻量反思 (每次 react-loop 结束)
// ═══════════════════════════════════════

export async function harvestPostSession(opts: {
  projectId: string;
  agentId: string;
  role: string;
  featureId: string;
  completed: boolean;
  iterations: number;
  filesWritten: string[];
  workspacePath: string;
  settings: AppSettings;
  signal: AbortSignal;
}): Promise<void> {
  // 只有实际做了工作(≥3轮迭代或写过文件)才触发
  if (opts.iterations < 3 && opts.filesWritten.length === 0) return;

  try {
    const model = resolveModel(selectModelTier({ type: 'lesson_extract' }).tier, opts.settings);
    const result = await callLLM(opts.settings, model, [
      { role: 'system', content: '你是经验提取助手。用1-2句话总结这次工作的关键经验(做对了什么/踩了什么坑)。只输出经验，不要其他内容。' },
      { role: 'user', content: `Agent ${opts.agentId} (${opts.role}) 处理 Feature ${opts.featureId}:\n` +
        `- 完成状态: ${opts.completed ? '成功' : '未完成'}\n` +
        `- 迭代次数: ${opts.iterations}\n` +
        `- 写入文件: ${opts.filesWritten.slice(0, 10).join(', ')}` },
    ], opts.signal, 256);

    if (result.content?.trim()) {
      appendProjectMemory(opts.workspacePath,
        `[${opts.featureId}] ${result.content.trim()}`);
    }
  } catch (e) {
    log.warn('Post-session harvest failed (non-fatal)', { error: String(e) });
  }
}

// ═══════════════════════════════════════
// Post-Feature: 多层经验提取 (Feature 完成/失败/驳回)
// ═══════════════════════════════════════

export async function harvestPostFeature(opts: {
  projectId: string;
  featureId: string;
  result: 'passed' | 'failed' | 'pm_rejected' | 'timeout';
  qaAttempts?: number;
  filesWritten?: string[];
  reason?: string;       // PM 驳回原因 / 超时描述
  workspacePath: string;
  projectName: string;
  settings: AppSettings;
  signal: AbortSignal;
}): Promise<void> {
  try {
    const model = resolveModel(selectModelTier({ type: 'lesson_extract' }).tier, opts.settings);
    const result = await callLLM(opts.settings, model, [
      { role: 'system', content: '你是经验提取助手。从以下 Feature 结果中提取经验。输出 JSON 数组，每条 {summary, scope}。' +
        '\nscope: "project"(仅本项目有效) 或 "global"(跨项目通用)。' +
        '\n最多 3 条，每条 summary ≤80字。只输出 JSON。' },
      { role: 'user', content: `Feature ${opts.featureId} 结果: ${opts.result}\n` +
        (opts.qaAttempts ? `QA 尝试: ${opts.qaAttempts}次\n` : '') +
        (opts.reason ? `原因: ${opts.reason}\n` : '') +
        (opts.filesWritten ? `文件: ${opts.filesWritten.slice(0, 15).join(', ')}` : '') },
    ], opts.signal, 512);

    const lessons = parseJsonArray(result.content);
    for (const lesson of lessons) {
      appendProjectMemory(opts.workspacePath, `[${opts.featureId}:${opts.result}] ${lesson.summary}`);
      if (lesson.scope === 'global') {
        contributeKnowledge(opts.projectName, [{
          summary: lesson.summary,
          content: `[${opts.result}] ${lesson.summary}`,
        }]);
      }
    }
  } catch (e) {
    log.warn('Post-feature harvest failed (non-fatal)', { error: String(e) });
  }
}

function parseJsonArray(text: string): Array<{ summary: string; scope: string }> {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch { return []; }
}
```

#### S2-2: 挂载 hook (D4 + D5)

```typescript
// react-loop.ts L830 附近, backupConversation 之后:
import { harvestPostSession } from './experience-harvester';
// ...
backupConversation({ ... });
harvestPostSession({
  projectId, agentId: workerId, role: 'developer',
  featureId: feature.id, completed, iterations: iteration,
  filesWritten: [...filesWritten], workspacePath, settings, signal,
}).catch(() => {}); // fire-and-forget, 不阻塞主流程

// worker-phase.ts, Feature 完成后 (broadcastFilesCreated 之后):
import { harvestPostFeature } from './experience-harvester';
// ...
harvestPostFeature({
  projectId, featureId: feature.id,
  result: featureStatus === 'passed' ? 'passed' : 'failed',
  qaAttempts, filesWritten, workspacePath, projectName, settings, signal,
}).catch(() => {});

// orchestrator.ts / change-manager.ts, PM 驳回路径:
harvestPostFeature({
  projectId, featureId, result: 'pm_rejected',
  reason: rejectReason, workspacePath, projectName, settings, signal,
}).catch(() => {});
```

#### S2-3: Agent checkpoint 扩展 (D6)

在现有 `scratchpad.ts` 的 `AgentScratchpad` 中增加 checkpoint 段：

```typescript
// scratchpad.ts 扩展 AgentScratchpad:
interface AgentScratchpad {
  // ... existing fields ...
  /** 工作现场快照: 当前 feature + 进度 + 待处理项 (覆盖式, 只保留最新) */
  checkpoint: {
    featureId: string;
    step: string;         // 当前执行到的步骤
    pendingActions: string[];
    timestamp: number;
  } | null;
}

// react-loop.ts 每 5 轮迭代更新一次 checkpoint:
if (iteration % 5 === 0 && workspacePath) {
  const pad = loadScratchpad(workspacePath, workerId);
  pad.checkpoint = { featureId: feature.id, step: `iteration-${iteration}`,
    pendingActions: guardState.filesWritten.size > 0 ? ['verify changes'] : ['start implementation'],
    timestamp: Date.now() };
  saveScratchpad(workspacePath, pad);
}
```

**验证**: 运行测试项目，检查 project-memory.md 出现 `[F-xxx:passed]` / `[F-xxx:failed]` 格式的经验条目。

---

### Sprint 3: 上下文工程 + Instance Memory (5-8h)

> 核心改进: Agent 不再每次从零开始。

#### S3-1: Session Planning 阶段 (D7)

在 `reactDeveloperLoop` 入口，ReAct 循环开始前插入一个轻量 planning step：

```typescript
// react-loop.ts, reactDeveloperLoop 入口处:
const planPrompt = `你将开始实现 Feature "${feature.title}"。
在开始编码前，用 3-5 条简短列出你的实施计划:
1. 需要读取/理解哪些文件
2. 主要修改哪些文件
3. 预期的验证方式
只输出计划，不要开始实现。`;

// 将 planning output 作为第一轮 user message 注入
// Agent 回复的 plan 会自动进入 conversation history，后续迭代可参考
```

**关键**: 不需要额外 LLM 调用 — plan 是 ReAct 循环的**第一轮迭代**的 user prompt，Agent 在回复中自然输出计划，然后第二轮开始执行。

#### S3-2: 跨 Feature Instance Memory (D8)

扩展现有 `readMemoryForRole` 机制。在 `context-collector.ts` 的 `collectDeveloperContext` 中注入最近 N 条 feature 经验：

```typescript
// context-collector.ts, collectDeveloperContext 中:
// 读取 project-memory.md 的最近 10 条经验 (已有的 readProjectMemory)
// + 读取 role memory 的 developer 经验 (已有的 readRoleMemory)
// 新增: 从 project-memory 中提取最近 5 条 [F-xxx] 开头的条目，作为 "instance memory"
const instanceMemory = extractRecentFeatureLessons(projectMemory, 5);
if (instanceMemory) {
  sections.push(`## 近期 Feature 经验\n${instanceMemory}`);
}
```

不新建模块，只新增一个 `extractRecentFeatureLessons(text: string, limit: number): string` 纯函数。

#### S3-3: 跨项目经验实时提取 (D9)

已在 S2 的 `harvestPostFeature` 中实现——当 `scope === 'global'` 时自动调用 `contributeKnowledge`。此处补充: 在 `experience-harvester.ts` 中加入容量控制：

```typescript
// experience-harvester.ts 新增:
export function trimProjectMemory(workspacePath: string, maxLessons: number = 50): void {
  const content = readProjectMemory(workspacePath);
  const lines = content.split('\n');
  const lessonLines = lines.filter(l => l.match(/^- \[.*?\]/));
  if (lessonLines.length > maxLessons) {
    // 保留最新 maxLessons 条，删除最旧的
    const toRemove = lessonLines.slice(0, lessonLines.length - maxLessons);
    let trimmed = content;
    for (const line of toRemove) trimmed = trimmed.replace(line + '\n', '');
    writeProjectMemory(workspacePath, trimmed);
  }
}
```

#### S3-4: Per-feature 成本追踪 (D11)

在 `react-loop.ts` 的 `updateAgentStats` 调用处，同时写入 `event-store`：

```typescript
emitEvent({
  projectId, agentId: workerId, featureId: feature.id,
  type: 'cost:llm',
  data: { model, inputTokens, outputTokens, cost },
});
```

前端可通过 `event-store` 查询 per-feature 累计成本。

---

### Sprint 4: 技能结晶 + 质量保障 (持续)

| # | 改动 | 说明 | 工作量 |
|---|------|------|--------|
| D12 | 技能自动结晶 | `harvestPostFeature` 中，当 `result === 'passed'` 且涉及 pattern match 时，调用 `buildSkillExtractionPrompt` → `skillEvolution.acquire` | 2h |
| D13 | 不变量验证测试 | 新建 `__tests__/invariants.test.ts`: Agent 循环后 features 状态一致性、session 不泄漏、scratchpad 不无限增长 | 3h |
| D14 | 语义去重 | `cross-project.ts` 的 `contributeKnowledge` 中加 TF-IDF cosine similarity (手写 ~80行) | 2h |
| — | finalize-phase 升级 | 将 `extractFromProjectMemory` 替换为 `harvestPostProject`，使用 LLM 智能提取而非简单分段 | 1h |

---

## 五、架构全景 (改进后)

```
用户需求 → PM 分析 → Architect 设计 → Docs 生成 → Worker 开发/QA
                                                        │
              ┌─────── react-loop 内部 ─────────┐      │
              │ ① Session Plan (首轮)            │      │
              │ ② ReAct 循环 (tools + LLM)       │      │
              │ ③ Scratchpad harness (自动)       │      │
              │ ④ Checkpoint (每5轮)             │      │
              │ ⑤ backupConversation (结束)       │      │
              │ ⑥ harvestPostSession (结束)  ← NEW│      │
              └─────────────────────────────────┘      │
                                                        │
              Feature 完成 ──→ harvestPostFeature ← NEW │
                    │              ├→ appendProjectMemory │
                    │              ├→ contributeKnowledge (scope=global)
                    │              └→ skillEvolution.acquire (auto)
                    │                                    │
              Project Finalize ──→ harvestPostProject     │
                    │              └→ 全量智能提取         │
                    │                                    │
              ┌─────▼────────────────────────────────────▼───┐
              │              Memory Layer                     │
              │                                              │
              │  project-memory.md (instance 经验, FIFO 50条) │
              │  role/{role}.md (角色经验)                     │
              │  global-memory.md (用户偏好)                   │
              │  knowledge/_index.json (跨项目, 标签匹配)      │
              │  evolved-skills/ (技能库, 成熟度追踪)           │
              └──────────────────────────────────────────────┘
                        │ 读取
              ┌─────────▼──────────────────────┐
              │ context-collector.ts            │
              │  + Instance Memory (近5条经验)   │← NEW
              │  + Feature 索引层 (summary)      │← NEW
              │  + Cross-project 经验注入        │
              │  + Skill 上下文注入              │
              └────────────────────────────────┘
```

**不引入的设计** (有意识地排除):

| 被排除的设计 | 原因 |
|-------------|------|
| 独立的 Steward Agent 进程 | 增加架构复杂度，用 hooks + 函数替代即可 |
| 新的 `experiences` SQLite 表 | 已有 project-memory.md + cross-project _index.json 足够，避免数据分散 |
| ExperienceRecord 统一格式 | 过度抽象——每个存储有自己的自然格式就好 |
| embedding-based 语义搜索 | 引入 native 模型增加部署复杂度，TF-IDF 够用 |
| ACP 协议 / 组件市场 / Monorepo 分包 | AgentForge 单机 Electron 架构不需要 |

---

## 六、与自我迭代的关系

```
Self-Evolution (自我迭代)
    │
    ├─ Quality Gate (✅ 已有: tsc + vitest + pre-commit)
    │
    ├─ Experience Memory (🔧 本计划)
    │      S1: 硬约束 + QA诊断 + Feature摘要
    │      S2: 反思hook + 现场快照
    │      S3: Session Plan + Instance Memory
    │      S4: 技能结晶 + 不变量测试
    │
    └─ Fitness Evaluation (⬜ 待实现 — 见 SELF-EVOLUTION-PLAN.md)
```

---

## 七、参考

| # | 来源 | 关键启发 |
|---|------|----------|
| 1 | Reflexion (NeurIPS 2023) | 反思闭环 |
| 2 | SWE-Exp (arXiv 2507.23361) | 多层经验银行 |
| 3 | SICA (NeurIPS 2025) | Agent 自我改进 |
| 4 | Self-Evolving Agents Survey (arXiv 2508.07407) | MASE 统一框架 |
| 5 | agent-memory (内部) | 写保护 + 硬约束 + 容量 FIFO |
| 6 | agent-swarm (内部) | Session Plan + 诊断 retry + 两层清单 |
| 7 | Actant (内部) | 四层记忆进化 + 不变量测试 |
| 8 | Voyager (NeurIPS 2023) | 技能库自动结晶 |
| 9 | PreFlect (arXiv 2602.07187) | 前瞻式反思 (远期) |

---

> **执行建议**: Sprint 1 (硬约束 + QA诊断 + Feature摘要) 零依赖，1-2h 可完成。Sprint 2 (反思hook) 是最高 ROI 项，~150 行新代码 + 3 处挂载。两个 Sprint 做完后 AgentForge 的记忆能力有质的飞跃。
