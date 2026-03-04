/**
 * Self-Evolution IPC Handlers — 自我进化 IPC 接口
 *
 * 提供 Electron IPC 接口让渲染进程 (管家 UI / 进化仪表板) 触发和监控自我进化。
 *
 * Handlers:
 *  - evolution:preflight      — 执行进化前预检
 *  - evolution:get-progress   — 获取当前进化进度
 *  - evolution:get-config     — 获取进化配置
 *  - evolution:evaluate       — 执行单次适应度评估 (不修改代码)
 *  - evolution:run-iteration  — 执行单次进化迭代 (需提供修改描述和文件变更)
 *  - evolution:abort          — 中止当前进化
 *  - evolution:get-archive    — 获取进化历史
 *  - evolution:get-memories   — 获取进化记忆
 *  - evolution:verify-immutable — 校验不可变文件完整性
 */

import { ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../engine/logger';
import { getDb } from '../db';
import {
  SelfEvolutionEngine,
  ImmutableGuard,
  FitnessEvaluator,
  DEFAULT_IMMUTABLE_FILES,
  DEFAULT_EVOLUTION_CONFIG,
  type FitnessResult,
} from '../engine/self-evolution-engine';

const log = createLogger('ipc:self-evolution');

// ═══════════════════════════════════════
// Engine Singleton
// ═══════════════════════════════════════

let engine: SelfEvolutionEngine | null = null;
let lastBaselineFitness: FitnessResult | null = null;

/**
 * 获取 AgentForge 源码根目录
 * 策略:
 *  1. 环境变量 AGENTFORGE_SOURCE_ROOT
 *  2. 检测常见已知路径
 *  3. 从 app.getAppPath() 推断
 */
function resolveSourceRoot(): string {
  // 1. 环境变量
  if (process.env.AGENTFORGE_SOURCE_ROOT) {
    return process.env.AGENTFORGE_SOURCE_ROOT;
  }

  // 2. 已知开发路径 (开发模式)
  const knownPaths = [
    path.resolve(__dirname, '..', '..'), // electron/ipc → 项目根
    'D:\\EchoAgent\\projects\\AgentForge',
  ];

  for (const p of knownPaths) {
    if (SelfEvolutionEngine.isAgentForgeRoot(p)) {
      return p;
    }
  }

  // 3. 打包后无法自我修改
  throw new Error('Cannot resolve AgentForge source root. Set AGENTFORGE_SOURCE_ROOT env var.');
}

function getOrCreateEngine(): SelfEvolutionEngine {
  if (!engine) {
    const sourceRoot = resolveSourceRoot();
    engine = new SelfEvolutionEngine({ sourceRoot });
    log.info(`Self-evolution engine initialized at: ${sourceRoot}`);
  }
  return engine;
}

// ═══════════════════════════════════════
// DB Persistence Helpers
// ═══════════════════════════════════════

function saveArchiveEntry(entry: {
  id: string;
  parentId: string | null;
  generation: number;
  branch: string;
  fitnessScore: number;
  fitness: FitnessResult;
  description: string;
  modifiedFiles: string[];
  status: string;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `
      INSERT OR REPLACE INTO evolution_archive
        (id, parent_id, generation, branch, fitness_score, fitness_json, description, modified_files, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      entry.id,
      entry.parentId,
      entry.generation,
      entry.branch,
      entry.fitnessScore,
      JSON.stringify(entry.fitness),
      entry.description,
      JSON.stringify(entry.modifiedFiles),
      entry.status,
    );
  } catch (err: unknown) {
    log.warn('Failed to save archive entry to DB', err as Record<string, unknown>);
  }
}

function saveMemoryEntry(entry: {
  pattern: string;
  outcome: string;
  module: string;
  description: string;
  fitnessImpact: number;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `
      INSERT INTO evolution_memories (pattern, outcome, module, description, fitness_impact)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(entry.pattern, entry.outcome, entry.module, entry.description, entry.fitnessImpact);
  } catch (err: unknown) {
    log.warn('Failed to save memory entry to DB', err as Record<string, unknown>);
  }
}

function loadArchive(): {
  id: string;
  generation: number;
  branch: string;
  fitnessScore: number;
  description: string;
  status: string;
  created_at: string;
}[] {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM evolution_archive ORDER BY generation DESC LIMIT 100').all() as never[];
  } catch {
    return [];
  }
}

function loadMemories(): {
  pattern: string;
  outcome: string;
  module: string;
  description: string;
  fitness_impact: number;
  created_at: string;
}[] {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM evolution_memories ORDER BY id DESC LIMIT 200').all() as never[];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════
// IPC Handlers
// ═══════════════════════════════════════

export function setupSelfEvolutionHandlers(): void {
  // ── Preflight check ──
  ipcMain.handle('evolution:preflight', async () => {
    try {
      const eng = getOrCreateEngine();
      const result = await eng.preflight();
      if (result.baselineFitness) {
        lastBaselineFitness = result.baselineFitness;
      }
      return { success: true, ...result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Preflight failed', err);
      return { success: false, ok: false, errors: [msg] };
    }
  });

  // ── Get progress ──
  ipcMain.handle('evolution:get-progress', async () => {
    if (!engine) {
      return {
        status: 'idle' as const,
        generation: 0,
        maxGenerations: DEFAULT_EVOLUTION_CONFIG.maxGenerations,
        currentBranch: '',
        baselineFitness: 0,
        currentFitness: 0,
        archive: loadArchive(),
        memories: [],
        updatedAt: Date.now(),
        logs: [],
      };
    }
    return engine.getProgress();
  });

  // ── Get config ──
  ipcMain.handle('evolution:get-config', async () => {
    if (!engine) {
      return DEFAULT_EVOLUTION_CONFIG;
    }
    return engine.getConfig();
  });

  // ── Evaluate fitness (read-only, no code changes) ──
  ipcMain.handle('evolution:evaluate', async () => {
    try {
      const sourceRoot = resolveSourceRoot();
      const evaluator = new FitnessEvaluator(
        sourceRoot,
        DEFAULT_EVOLUTION_CONFIG.fitnessWeights,
        DEFAULT_EVOLUTION_CONFIG.timeouts,
      );
      const result = evaluator.evaluate(lastBaselineFitness?.statementCoverage || 0);
      return { success: true, fitness: result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Fitness evaluation failed', err);
      return { success: false, error: msg };
    }
  });

  // ── Run single iteration ──
  ipcMain.handle(
    'evolution:run-iteration',
    async (
      _event,
      description: string,
      fileChanges: { path: string; content: string; action: 'write' | 'delete' }[],
    ) => {
      try {
        const eng = getOrCreateEngine();

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
              fs.writeFileSync(absPath, change.content, 'utf-8');
              modifiedFiles.push(change.path);
            }
          }
          return modifiedFiles;
        });

        // Persist to DB
        if (result.entry) {
          saveArchiveEntry(result.entry);
        }

        return { success: result.success, entry: result.entry, error: result.error, rolledBack: result.rolledBack };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Evolution iteration failed', err as Record<string, unknown>);
        return { success: false, error: msg, rolledBack: true };
      }
    },
  );

  // ── Abort ──
  ipcMain.handle('evolution:abort', async () => {
    if (engine) {
      engine.abort();
      return { success: true };
    }
    return { success: false, error: 'No evolution engine running' };
  });

  // ── Get archive (from DB) ──
  ipcMain.handle('evolution:get-archive', async () => {
    return { success: true, archive: loadArchive() };
  });

  // ── Get memories (from DB) ──
  ipcMain.handle('evolution:get-memories', async () => {
    return { success: true, memories: loadMemories() };
  });

  // ── Verify immutable files ──
  ipcMain.handle('evolution:verify-immutable', async () => {
    try {
      const sourceRoot = resolveSourceRoot();
      const guard = new ImmutableGuard(sourceRoot, DEFAULT_IMMUTABLE_FILES);
      guard.captureBaseline();
      const result = guard.verify();
      return { success: true, ...result, manifest: guard.getManifest() };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, ok: false, violations: [msg] };
    }
  });

  log.info('Self-evolution IPC handlers registered');
}
