/**
 * meta-agent-admin.ts — 元Agent 管理工具执行器 (团队/工作流/项目/进化)
 *
 * 从 meta-agent.ts 拆分 (v30.2)
 */

import { BrowserWindow } from 'electron';
import { getDb } from '../db';
import { createLogger } from '../engine/logger';
import { SelfEvolutionEngine, ImmutableGuard, FitnessEvaluator } from '../engine/self-evolution-engine';
import {
  EvolutionMutator,
  EVOLUTION_SCOPES,
  type EvolutionScopeLevel,
  type MutationStrategy,
} from '../engine/evolution-mutator';
import type { WorkflowPresetRow, WorkflowStage } from '../engine/types';
import fs from 'fs';
import path from 'path';

const log = createLogger('ipc:meta-agent:admin');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface AdminToolResult {
  success: boolean;
  output: string;
}

// ═══════════════════════════════════════
// Admin Tool Executor (v22.0)
// ═══════════════════════════════════════

export function executeAdminTool(
  toolName: string,
  args: Record<string, unknown>,
  projectId: string,
  _win: BrowserWindow | null,
): AdminToolResult {
  const db = getDb();

  try {
    switch (toolName) {
      case 'admin_list_members': {
        const rows = db
          .prepare('SELECT * FROM team_members WHERE project_id = ? ORDER BY created_at ASC')
          .all(projectId) as Array<Record<string, unknown>>;
        if (rows.length === 0)
          return { success: true, output: '当前项目没有团队成员。可以使用 admin_add_member 添加。' };
        const lines = rows.map((r, i) => {
          const caps = (() => {
            try {
              return JSON.parse((r.capabilities as string) || '[]');
            } catch (err) {
              log.debug('Catch at meta-agent-admin:caps-parse', { error: String(err) });
              return [];
            }
          })();
          return [
            `### ${i + 1}. ${r.name} (${r.role})`,
            `- **ID**: \`${r.id}\``,
            `- **模型**: ${r.model || '(项目默认)'}`,
            `- **能力**: ${caps.length > 0 ? caps.join(', ') : '(未设置)'}`,
            `- **上下文限制**: ${r.max_context_tokens || 256000} tokens`,
            r.max_iterations ? `- **最大迭代**: ${r.max_iterations} 轮` : '',
            `- **提示词**: ${r.system_prompt ? `${(r.system_prompt as string).slice(0, 80)}...` : '(角色默认)'}`,
          ]
            .filter(Boolean)
            .join('\n');
        });
        return { success: true, output: `## 团队成员 (${rows.length} 人)\n\n${lines.join('\n\n')}` };
      }

      case 'admin_add_member': {
        const role = args.role as string;
        const name = args.name as string;
        if (!role || !name) return { success: false, output: '错误: role 和 name 为必填。' };
        const id = 'tm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        db.prepare(
          `INSERT INTO team_members (id, project_id, role, name, model, capabilities, system_prompt, context_files, max_context_tokens)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          projectId,
          role,
          name,
          (args.model as string) || null,
          JSON.stringify(args.capabilities || []),
          (args.system_prompt as string) || null,
          JSON.stringify([]),
          (args.max_context_tokens as number) || 256000,
        );
        if (args.max_iterations) {
          db.prepare('UPDATE team_members SET max_iterations = ? WHERE id = ?').run(args.max_iterations as number, id);
        }
        return { success: true, output: `✅ 已添加成员: **${name}** (${role})，ID: \`${id}\`` };
      }

      case 'admin_update_member': {
        const memberId = args.member_id as string;
        if (!memberId) return { success: false, output: '错误: member_id 为必填。' };
        const current = db.prepare('SELECT * FROM team_members WHERE id = ?').get(memberId) as
          | Record<string, unknown>
          | undefined;
        if (!current) return { success: false, output: `错误: 成员 ${memberId} 不存在。` };

        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        const changes: string[] = [];

        if (args.name !== undefined) {
          sets.push('name = ?');
          vals.push(args.name as string);
          changes.push(`名字: ${current.name} → ${args.name}`);
        }
        if (args.role !== undefined) {
          sets.push('role = ?');
          vals.push(args.role as string);
          changes.push(`角色: ${current.role} → ${args.role}`);
        }
        if (args.model !== undefined) {
          sets.push('model = ?');
          vals.push(args.model as string);
          changes.push(`模型: ${current.model || '默认'} → ${args.model || '默认'}`);
        }
        if (args.system_prompt !== undefined) {
          sets.push('system_prompt = ?');
          vals.push(args.system_prompt as string);
          changes.push('提示词: 已更新');
        }
        if (args.capabilities !== undefined) {
          sets.push('capabilities = ?');
          vals.push(JSON.stringify(args.capabilities));
          changes.push('能力标签: 已更新');
        }
        if (args.max_context_tokens !== undefined) {
          sets.push('max_context_tokens = ?');
          vals.push(args.max_context_tokens as number);
          changes.push(`上下文限制: ${current.max_context_tokens} → ${args.max_context_tokens}`);
        }
        if (args.max_iterations !== undefined) {
          sets.push('max_iterations = ?');
          vals.push(args.max_iterations as number);
          changes.push(`最大迭代: → ${args.max_iterations}`);
        }

        if (sets.length === 0) return { success: true, output: '未提供任何修改字段。' };
        vals.push(memberId);
        db.prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return {
          success: true,
          output: `✅ 已更新成员 **${current.name}** (\`${memberId}\`):\n${changes.map(c => `- ${c}`).join('\n')}`,
        };
      }

      case 'admin_remove_member': {
        const memberId = args.member_id as string;
        if (!memberId) return { success: false, output: '错误: member_id 为必填。' };
        const target = db.prepare('SELECT name, role FROM team_members WHERE id = ?').get(memberId) as
          | { name: string; role: string }
          | undefined;
        if (!target) return { success: false, output: `错误: 成员 ${memberId} 不存在。` };
        db.prepare('DELETE FROM team_members WHERE id = ?').run(memberId);
        return {
          success: true,
          output: `✅ 已移除成员: **${target.name}** (${target.role})，ID: \`${memberId}\`。⚠️ 此操作不可撤销。`,
        };
      }

      case 'admin_list_workflows': {
        const existing = db
          .prepare('SELECT id FROM workflow_presets WHERE project_id = ? AND is_builtin = 1')
          .all(projectId) as Array<{ id: string }>;
        if (existing.length === 0) {
          const builtinPresets = [
            { id: 'builtin-full-dev', name: '完整开发', icon: '🚀' },
            { id: 'builtin-fast-iterate', name: '快速迭代', icon: '⚡' },
            { id: 'builtin-quality-hardening', name: '质量加固', icon: '🔬' },
          ];
          for (const bp of builtinPresets) {
            const pid = `${bp.id}-${projectId}`;
            db.prepare(
              'INSERT OR IGNORE INTO workflow_presets (id, project_id, name, description, icon, stages, is_active, is_builtin) VALUES (?, ?, ?, ?, ?, ?, 0, 1)',
            ).run(pid, projectId, bp.name, '', bp.icon, '[]');
          }
        }
        const rows = db
          .prepare('SELECT * FROM workflow_presets WHERE project_id = ? ORDER BY is_builtin DESC, created_at ASC')
          .all(projectId) as WorkflowPresetRow[];
        if (rows.length === 0) return { success: true, output: '当前项目没有工作流预设。' };

        const lines = rows.map(r => {
          let stages: WorkflowStage[] = [];
          try {
            stages = JSON.parse(r.stages);
          } catch (err) {
            log.debug('Catch at meta-agent-admin:stages-parse', { error: String(err) });
            stages = [];
          }
          const active = r.is_active === 1 ? ' ⭐ **当前激活**' : '';
          const builtin = r.is_builtin === 1 ? ' (内置)' : ' (自定义)';
          const stageList =
            stages.length > 0
              ? stages.map(s => `  ${s.icon || '·'} ${s.label}${s.skippable ? ' (可跳过)' : ''}`).join('\n')
              : '  (无阶段)';
          return `### ${r.icon || '📋'} ${r.name}${builtin}${active}\n- **ID**: \`${r.id}\`\n- **描述**: ${r.description || '(无)'}\n- **阶段** (${stages.length}):\n${stageList}`;
        });
        return { success: true, output: `## 工作流预设 (${rows.length} 个)\n\n${lines.join('\n\n')}` };
      }

      case 'admin_activate_workflow': {
        const presetId = args.preset_id as string;
        if (!presetId) return { success: false, output: '错误: preset_id 为必填。' };
        const target = db
          .prepare('SELECT name FROM workflow_presets WHERE id = ? AND project_id = ?')
          .get(presetId, projectId) as { name: string } | undefined;
        if (!target) return { success: false, output: `错误: 工作流 ${presetId} 不存在于当前项目。` };
        db.prepare("UPDATE workflow_presets SET is_active = 0, updated_at = datetime('now') WHERE project_id = ?").run(
          projectId,
        );
        db.prepare(
          "UPDATE workflow_presets SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND project_id = ?",
        ).run(presetId, projectId);
        return { success: true, output: `✅ 已激活工作流: **${target.name}** (\`${presetId}\`)` };
      }

      case 'admin_update_workflow': {
        const presetId = args.preset_id as string;
        if (!presetId) return { success: false, output: '错误: preset_id 为必填。' };
        const current = db.prepare('SELECT * FROM workflow_presets WHERE id = ?').get(presetId) as
          | WorkflowPresetRow
          | undefined;
        if (!current) return { success: false, output: `错误: 工作流 ${presetId} 不存在。` };

        const sets: string[] = [];
        const vals: Array<string | number | null> = [];
        const changes: string[] = [];

        if (args.name !== undefined) {
          sets.push('name = ?');
          vals.push(args.name as string);
          changes.push(`名称: ${current.name} → ${args.name}`);
        }
        if (args.description !== undefined) {
          sets.push('description = ?');
          vals.push(args.description as string);
          changes.push('描述: 已更新');
        }
        if (args.icon !== undefined) {
          sets.push('icon = ?');
          vals.push(args.icon as string);
          changes.push(`图标: ${current.icon} → ${args.icon}`);
        }
        if (args.stages !== undefined) {
          const newStages = args.stages as WorkflowStage[];
          sets.push('stages = ?');
          vals.push(JSON.stringify(newStages));
          let oldStages: WorkflowStage[] = [];
          try {
            oldStages = JSON.parse(current.stages);
          } catch (err) {
            log.debug('Catch at meta-agent-admin:old-stages-parse', { error: String(err) });
          }
          changes.push(`阶段: ${oldStages.length} → ${newStages.length} 个`);
        }
        sets.push("updated_at = datetime('now')");
        vals.push(presetId);

        if (changes.length === 0) return { success: true, output: '未提供任何修改字段。' };
        db.prepare(`UPDATE workflow_presets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        return {
          success: true,
          output: `✅ 已更新工作流 **${current.name}** (\`${presetId}\`):\n${changes.map(c => `- ${c}`).join('\n')}`,
        };
      }

      case 'admin_update_project': {
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
          | Record<string, unknown>
          | undefined;
        if (!project) return { success: false, output: '错误: 项目不存在。' };

        const changes: string[] = [];
        if (args.name !== undefined) {
          db.prepare("UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?").run(
            args.name as string,
            projectId,
          );
          changes.push(`名称: ${project.name} → ${args.name}`);
        }
        if (args.wish !== undefined) {
          db.prepare("UPDATE projects SET wish = ?, updated_at = datetime('now') WHERE id = ?").run(
            args.wish as string,
            projectId,
          );
          changes.push('需求描述: 已更新');
        }
        if (args.permissions) {
          const perms = args.permissions as Record<string, boolean>;
          const sets: string[] = [];
          const vals: Array<number | string> = [];
          if (perms.externalRead !== undefined) {
            sets.push('allow_external_read = ?');
            vals.push(perms.externalRead ? 1 : 0);
            changes.push(`外部读取: ${perms.externalRead ? '允许' : '禁止'}`);
          }
          if (perms.externalWrite !== undefined) {
            sets.push('allow_external_write = ?');
            vals.push(perms.externalWrite ? 1 : 0);
            changes.push(`外部写入: ${perms.externalWrite ? '允许' : '禁止'}`);
          }
          if (perms.shellExec !== undefined) {
            sets.push('allow_shell_exec = ?');
            vals.push(perms.shellExec ? 1 : 0);
            changes.push(`Shell 执行: ${perms.shellExec ? '允许' : '禁止'}`);
          }
          if (sets.length > 0) {
            vals.push(projectId);
            db.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
              ...vals,
            );
          }
        }
        if (changes.length === 0) return { success: true, output: '未提供任何修改字段。' };
        return { success: true, output: `✅ 项目配置已更新:\n${changes.map(c => `- ${c}`).join('\n')}` };
      }

      case 'admin_get_available_stages': {
        const stages = [
          { id: 'pm_analysis', label: 'PM 需求分析', icon: '🧠' },
          { id: 'pm_triage', label: 'PM 分诊', icon: '🔀' },
          { id: 'architect', label: '架构 + 设计', icon: '🏗️' },
          { id: 'docs_gen', label: '文档生成', icon: '📋' },
          { id: 'dev_implement', label: '开发实现', icon: '💻' },
          { id: 'qa_review', label: 'QA 审查', icon: '🧪' },
          { id: 'pm_acceptance', label: 'PM 验收', icon: '📝', skippable: true },
          { id: 'devops_build', label: 'DevOps 构建', icon: '🚀', skippable: true },
          { id: 'incremental_doc_sync', label: '增量文档同步', icon: '📄', skippable: true },
          { id: 'static_analysis', label: '静态分析', icon: '🔍' },
          { id: 'security_audit', label: '安全审计', icon: '🔒' },
          { id: 'perf_benchmark', label: '性能基准', icon: '⚡' },
          { id: 'finalize', label: '交付 / 报告', icon: '🎯' },
        ];
        const lines = stages.map(s => `- \`${s.id}\` — ${s.icon} ${s.label}${s.skippable ? ' (可跳过)' : ''}`);
        return { success: true, output: `## 可用工作流阶段\n\n${lines.join('\n')}` };
      }

      default:
        return { success: false, output: `未知的管理工具: ${toolName}` };
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `管理工具执行错误: ${errMsg}` };
  }
}

// ═══════════════════════════════════════
// v29.2: Evolution Admin Tool Execution (Async)
// ═══════════════════════════════════════

/** 自我进化引擎单例 (惰性初始化) */
let _evolutionEngine: SelfEvolutionEngine | null = null;

function getEvolutionEngine(): SelfEvolutionEngine {
  if (!_evolutionEngine) {
    const candidates = [path.resolve(__dirname, '..', '..'), process.env.AUTOMATER_SOURCE_ROOT || ''].filter(Boolean);

    let sourceRoot = '';
    for (const c of candidates) {
      if (SelfEvolutionEngine.isAutoMaterRoot(c)) {
        sourceRoot = c;
        break;
      }
    }
    if (!sourceRoot) {
      throw new Error('无法定位 AutoMater 源码根目录。请设置 AUTOMATER_SOURCE_ROOT 环境变量。');
    }
    _evolutionEngine = new SelfEvolutionEngine({ sourceRoot });
    log.info(`Evolution engine initialized: ${sourceRoot}`);
  }
  return _evolutionEngine;
}

/**
 * 执行自我进化管理工具 (异步)
 * 返回 null 表示不是进化工具，应交给通用 admin 处理
 */
export async function executeEvolutionAdminTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<AdminToolResult | null> {
  try {
    switch (toolName) {
      case 'admin_evolution_status': {
        const eng = getEvolutionEngine();
        const progress = eng.getProgress();
        const version = SelfEvolutionEngine.getVersion(eng.getConfig().sourceRoot);
        const archiveSummary = eng.getArchiveSummary();
        const memorySummary = eng.getMemorySummary();

        const lines = [
          `## 🧬 自我进化引擎状态`,
          '',
          `- **状态**: ${progress.status}`,
          `- **当前版本**: v${version}`,
          `- **进化代数**: ${progress.generation} / ${progress.maxGenerations}`,
          `- **基线适应度**: ${progress.baselineFitness.toFixed(4)}`,
          `- **当前适应度**: ${progress.currentFitness.toFixed(4)}`,
          `- **当前分支**: ${progress.currentBranch || '(无)'}`,
          `- **进化历史**: ${progress.archive.length} 条`,
          `- **进化记忆**: ${progress.memories.length} 条`,
          '',
        ];

        if (archiveSummary) {
          lines.push(archiveSummary, '');
        }
        if (memorySummary) {
          lines.push(memorySummary, '');
        }

        if (progress.logs.length > 0) {
          lines.push('## 最近日志');
          lines.push(...progress.logs.slice(-10));
        }

        return { success: true, output: lines.join('\n') };
      }

      case 'admin_evolution_preflight': {
        const eng = getEvolutionEngine();
        const result = await eng.preflight();

        if (result.ok) {
          const bf = result.baselineFitness!;
          return {
            success: true,
            output: [
              '## ✅ 进化预检通过',
              '',
              '所有安全检查通过，可以开始进化迭代。',
              '',
              `### 基线适应度`,
              `- **综合得分**: ${bf.score.toFixed(4)}`,
              `- **tsc**: ${bf.tscPassed ? '✅ 通过' : `❌ ${bf.tscErrors} 个错误`}`,
              `- **测试**: ${bf.passedTests}/${bf.totalTests} 通过 (${(bf.testPassRate * 100).toFixed(1)}%)`,
              `- **覆盖率**: ${bf.statementCoverage}%`,
              `- **耗时**: tsc ${bf.durations.tsc}ms, vitest ${bf.durations.vitest}ms`,
            ].join('\n'),
          };
        } else {
          return {
            success: false,
            output: [
              '## ❌ 进化预检失败',
              '',
              '以下问题需要先修复:',
              ...result.errors.map((e: string) => `- ⚠️ ${e}`),
            ].join('\n'),
          };
        }
      }

      case 'admin_evolution_evaluate': {
        const eng = getEvolutionEngine();
        const config = eng.getConfig();
        const evaluator = new FitnessEvaluator(config.sourceRoot, config.fitnessWeights, config.timeouts);
        const baseline = eng.getProgress().baselineFitness;
        const result = evaluator.evaluate(baseline > 0 ? baseline * 100 : 0);

        return {
          success: true,
          output: [
            '## 📊 适应度评估结果',
            '',
            `- **综合得分**: ${result.score.toFixed(4)}`,
            `- **tsc**: ${result.tscPassed ? '✅ 通过' : `❌ ${result.tscErrors} 个错误`}`,
            `- **测试**: ${result.passedTests}/${result.totalTests} 通过 (${(result.testPassRate * 100).toFixed(1)}%), ${result.failedTests} 失败`,
            `- **覆盖率**: ${result.statementCoverage}% (基线 ${result.baselineCoverage}%)`,
            `- **耗时**: tsc ${result.durations.tsc}ms, vitest ${result.durations.vitest}ms, 总计 ${result.durations.total}ms`,
            '',
            '### 详细输出',
            '```',
            result.details,
            '```',
          ].join('\n'),
        };
      }

      case 'admin_evolution_run': {
        const description = (args.description as string) || '';
        const fileChanges = (args.file_changes as Array<{ path: string; content?: string; action?: string }>) || [];

        if (!description) {
          return { success: false, output: '错误: description 为必填。请描述本次进化的目标。' };
        }
        if (fileChanges.length === 0) {
          return { success: false, output: '错误: file_changes 不能为空。请提供要修改的文件列表。' };
        }

        const eng = getEvolutionEngine();
        const result = await eng.runSingleIteration(description, async (workingDir: string) => {
          const modifiedFiles: string[] = [];
          for (const change of fileChanges) {
            const absPath = path.resolve(workingDir, change.path);
            if (change.action === 'delete') {
              if (fs.existsSync(absPath)) {
                fs.unlinkSync(absPath);
                modifiedFiles.push(change.path);
              }
            } else {
              const dir = path.dirname(absPath);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(absPath, change.content || '', 'utf-8');
              modifiedFiles.push(change.path);
            }
          }
          return modifiedFiles;
        });

        // 持久化到 DB
        if (result.entry) {
          try {
            const db = getDb();
            db.prepare(
              `
              INSERT OR REPLACE INTO evolution_archive
                (id, parent_id, generation, branch, fitness_score, fitness_json, description, modified_files, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            ).run(
              result.entry.id,
              result.entry.parentId,
              result.entry.generation,
              result.entry.branch,
              result.entry.fitnessScore,
              JSON.stringify(result.entry.fitness),
              result.entry.description,
              JSON.stringify(result.entry.modifiedFiles),
              result.entry.status,
            );
          } catch (dbErr: unknown) {
            log.warn('Failed to persist evolution entry', dbErr as Record<string, unknown>);
          }
        }

        if (result.success) {
          const e = result.entry!;
          return {
            success: true,
            output: [
              `## ✅ 进化迭代 Gen-${e.generation} 成功！`,
              '',
              `**描述**: ${e.description}`,
              `**适应度**: ${e.fitnessScore.toFixed(4)}`,
              `**修改文件**: ${e.modifiedFiles.join(', ')}`,
              `**分支**: ${e.branch}`,
              `**状态**: 已合并到基线`,
              '',
              '### 适应度详情',
              `- tsc: ${e.fitness.tscPassed ? '✅' : '❌'}`,
              `- 测试: ${e.fitness.passedTests}/${e.fitness.totalTests}`,
              `- 覆盖率: ${e.fitness.statementCoverage}%`,
            ].join('\n'),
          };
        } else {
          return {
            success: false,
            output: [
              `## ❌ 进化迭代失败`,
              '',
              `**错误**: ${result.error || '适应度未达标'}`,
              `**回滚**: ${result.rolledBack ? '✅ 已自动回滚到快照' : '否'}`,
              result.entry ? `**适应度**: ${result.entry.fitnessScore.toFixed(4)}` : '',
              result.entry ? `**状态**: ${result.entry.status}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          };
        }
      }

      case 'admin_evolution_verify': {
        const eng = getEvolutionEngine();
        const config = eng.getConfig();
        const guard = new ImmutableGuard(config.sourceRoot, config.immutableFiles);
        guard.captureBaseline();
        const result = guard.verify();
        const manifest = guard.getManifest();

        if (result.ok) {
          const lines = [
            '## ✅ 不可变文件完整性校验通过',
            '',
            '所有受保护文件 SHA256 一致:',
            ...Object.entries(manifest).map(([file, hash]) => `- \`${file}\`: ${hash.slice(0, 16)}...`),
          ];
          return { success: true, output: lines.join('\n') };
        } else {
          return {
            success: false,
            output: [
              '## 🚨 不可变文件完整性校验失败！',
              '',
              '以下文件被修改（应恢复原始版本）:',
              ...result.violations.map(v => `- ⚠️ ${v}`),
            ].join('\n'),
          };
        }
      }

      case 'admin_evolution_auto_run': {
        const eng = getEvolutionEngine();
        const config = eng.getConfig();
        const sourceRoot = config.sourceRoot;

        const generations = Math.min(Math.max(Number(args.generations) || 3, 1), 10);
        const scopeLevel = (args.scope as EvolutionScopeLevel) || 'conservative';
        const preferredStrategy = args.strategy as MutationStrategy | undefined;
        const maxFiles = Math.min(Math.max(Number(args.max_files) || 2, 1), 5);
        const allowedScope = EVOLUTION_SCOPES[scopeLevel]
          ? [...EVOLUTION_SCOPES[scopeLevel]]
          : [...EVOLUTION_SCOPES.conservative];

        const mutator = new EvolutionMutator(sourceRoot);
        const results: string[] = [
          `## 🧬 自主进化启动`,
          '',
          `- **代数**: ${generations}`,
          `- **范围**: ${scopeLevel} (${allowedScope.length} 个目标模式)`,
          `- **策略**: ${preferredStrategy || '自动选择'}`,
          `- **每代最大文件数**: ${maxFiles}`,
          '',
        ];

        const preflight = await eng.preflight();
        if (!preflight.ok) {
          return {
            success: false,
            output:
              results.join('\n') +
              `\n❌ 预检失败: ${preflight.errors.join(', ')}\n\n请先确保 git 工作区干净且 tsc 通过。`,
          };
        }
        results.push(`✅ 预检通过 — 基线适应度 ${preflight.baselineFitness?.score.toFixed(4) ?? 'N/A'}`);

        let accepted = 0;
        let rejected = 0;
        let errors = 0;

        for (let gen = 1; gen <= generations; gen++) {
          results.push(`\n### 第 ${gen}/${generations} 代`);

          try {
            const progress = eng.getProgress();
            const proposal = await mutator.generateMutation({
              sourceRoot,
              fitness: preflight.baselineFitness || {
                score: progress.baselineFitness,
                tscPassed: true,
                tscErrors: 0,
                testPassRate: 1,
                totalTests: 0,
                passedTests: 0,
                failedTests: 0,
                statementCoverage: 0,
                baselineCoverage: 0,
                durations: { tsc: 0, vitest: 0, total: 0 },
                details: '',
              },
              memories: progress.memories,
              archive: progress.archive,
              allowedScope,
              preferredStrategy,
              maxFiles,
            });

            results.push(`**策略**: ${proposal.strategy} | **描述**: ${proposal.description}`);
            results.push(`**变更**: ${proposal.fileChanges.map(f => f.path).join(', ')}`);
            results.push(`**Token**: ${proposal.tokenUsage.input} in / ${proposal.tokenUsage.output} out`);

            const iterResult = await eng.runSingleIteration(proposal.description, async (workingDir: string) => {
              const modified: string[] = [];
              for (const change of proposal.fileChanges) {
                const absPath = path.resolve(workingDir, change.path);
                if (change.action === 'delete') {
                  if (fs.existsSync(absPath)) {
                    fs.unlinkSync(absPath);
                    modified.push(change.path);
                  }
                } else {
                  fs.mkdirSync(path.dirname(absPath), { recursive: true });
                  fs.writeFileSync(absPath, change.content, 'utf-8');
                  modified.push(change.path);
                }
              }
              return modified;
            });

            if (iterResult.success) {
              accepted++;
              results.push(`✅ **已接受** — 适应度 ${iterResult.entry?.fitnessScore.toFixed(4) ?? 'N/A'}`);

              if (iterResult.entry) {
                try {
                  const db = getDb();
                  db.prepare(
                    `INSERT OR REPLACE INTO evolution_archive (id, parent_id, generation, branch, fitness_score, fitness_json, description, modified_files, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  ).run(
                    iterResult.entry.id,
                    iterResult.entry.parentId,
                    iterResult.entry.generation,
                    iterResult.entry.branch,
                    iterResult.entry.fitnessScore,
                    JSON.stringify(iterResult.entry.fitness),
                    iterResult.entry.description,
                    JSON.stringify(iterResult.entry.modifiedFiles),
                    iterResult.entry.status,
                  );
                } catch (err) {
                  log.debug('DB save failure', { error: String(err) });
                }
              }
            } else if (iterResult.rolledBack) {
              errors++;
              results.push(`↩️ **已回滚** — ${iterResult.error || '安全检查失败'}`);
            } else {
              rejected++;
              results.push(`❌ **已拒绝** — 适应度 ${iterResult.entry?.fitnessScore.toFixed(4) ?? 'N/A'} (未达标)`);
            }

            if (proposal.rationale) {
              try {
                const db = getDb();
                db.prepare(
                  'INSERT INTO evolution_memories (pattern, outcome, module, description, fitness_impact) VALUES (?, ?, ?, ?, ?)',
                ).run(
                  proposal.strategy,
                  iterResult.success ? 'success' : 'failure',
                  proposal.fileChanges.map(f => f.path).join(', '),
                  proposal.description,
                  iterResult.entry ? iterResult.entry.fitnessScore - (preflight.baselineFitness?.score || 0) : 0,
                );
              } catch (err) {
                log.debug('DB save failure', { error: String(err) });
              }
            }
          } catch (genErr: unknown) {
            errors++;
            const errMsg = genErr instanceof Error ? genErr.message : String(genErr);
            results.push(`❌ **异常**: ${errMsg}`);
            log.error(`Auto-evolution gen ${gen} error`, genErr);

            if (errMsg.includes('LLM') || errMsg.includes('API') || errMsg.includes('settings')) {
              results.push(`\n⛔ LLM 调用失败，终止剩余迭代。`);
              break;
            }
          }
        }

        results.push(
          '',
          '---',
          `## 📊 自主进化结果`,
          `- ✅ 接受: ${accepted}`,
          `- ❌ 拒绝: ${rejected}`,
          `- ↩️ 错误/回滚: ${errors}`,
          `- 总计: ${generations} 代`,
        );

        const finalProgress = eng.getProgress();
        results.push(`- 当前适应度: ${finalProgress.baselineFitness.toFixed(4)}`);
        results.push(`- 累计进化代数: ${finalProgress.generation}`);

        return { success: accepted > 0, output: results.join('\n') };
      }

      default:
        return null; // 不是进化工具，返回 null 交给通用处理
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `进化工具执行错误: ${errMsg}` };
  }
}
