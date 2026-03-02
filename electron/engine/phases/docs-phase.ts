/**
 * Docs Phase — 批量子需求拆分 + 测试规格生成
 * @module phases/docs-phase
 */

import {
  BrowserWindow, getDb, createLogger,
  callLLM, calcCost, sendToUI,
  writeDoc, readDoc, buildDesignContext, checkConsistency,
  emitEvent, createCheckpoint,
  resolveMemberModel,
  PM_SPLIT_REQS_PROMPT, QA_TEST_SPEC_PROMPT,
  type AppSettings, type ParsedFeature,
} from './shared';

const log = createLogger('phase:docs');

const BATCH_DOC_SIZE = 5;
const PARALLEL_BATCHES = 3;
const PHASE3_TIMEOUT_MS = 300_000;

/** Simple promise pool for controlled concurrency */
async function promisePool<T>(
  items: T[], concurrency: number, fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) await fn(item);
      }
    })());
  }
  await Promise.all(workers);
}

export async function phaseReqsAndTestSpecs(
  projectId: string, features: ParsedFeature[], settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  const db = getDb();
  const designContext = buildDesignContext(workspacePath, 4000);

  sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `📋 Phase 3: 批量生成 ${features.length} 个 Feature 的子需求和测试规格 (每批 ${BATCH_DOC_SIZE} 个, 最多 ${PARALLEL_BATCHES} 批并行)...` });

  const batches: ParsedFeature[][] = [];
  for (let i = 0; i < features.length; i += BATCH_DOC_SIZE) {
    batches.push(features.slice(i, i + BATCH_DOC_SIZE));
  }

  const batchItems = batches.map((batch, bi) => ({ batch, bi }));
  const totalBatches = batches.length;

  await promisePool(batchItems, Math.min(PARALLEL_BATCHES, totalBatches), async ({ batch, bi }) => {
    if (signal.aborted) return;
    const batchIds = batch.map((f) => f.id || `F${features.indexOf(f) + 1}`);

    // 批量子需求
    try {
      const pmReqId = `pm-req-batch-${bi}-${Date.now().toString(36)}`;
      const batchFeatureDesc = batch.map((f) => {
        const fid = f.id || `F${features.indexOf(f) + 1}`;
        return `### Feature ${fid}\n标题: ${f.title || f.description}\n描述: ${f.description}\n验收标准: ${JSON.stringify(f.acceptance_criteria || f.acceptanceCriteria || [])}\n依赖: ${JSON.stringify(f.dependsOn || f.depends_on || [])}\n备注: ${f.notes || '无'}`;
      }).join('\n\n');

      const reqResult = await callLLM(settings, resolveMemberModel(projectId, 'pm', settings), [
        { role: 'system', content: PM_SPLIT_REQS_PROMPT },
        {
          role: 'user',
          content: `## 设计文档上下文\n${designContext}\n\n## Feature 列表 (${batch.length} 个, 请为每个单独输出子需求文档)\n\n${batchFeatureDesc}\n\n请为以上每个 Feature 分别编写详细子需求文档。用 "---FEATURE: Fxxx---" 分隔每个 Feature 的文档。`,
        },
      ], signal, 16384, 2, undefined, PHASE3_TIMEOUT_MS);

      const reqCost = calcCost(resolveMemberModel(projectId, 'pm', settings), reqResult.inputTokens, reqResult.outputTokens);
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  📄 批次 ${bi + 1}/${totalBatches} 子需求生成完成 ($${reqCost.toFixed(4)})` });

      const sections = splitBatchOutput(reqResult.content, batchIds);
      for (const fid of batchIds) {
        const content = sections[fid] || reqResult.content;
        const reqVer = writeDoc(workspacePath, 'requirement', content, pmReqId, `${fid} 初始子需求`, fid);
        db.prepare("UPDATE features SET requirement_doc_ver = ? WHERE id = ? AND project_id = ?")
          .run(reqVer, fid, projectId);
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ 批次 ${bi + 1} 子需求生成失败: ${errMsg}${errMsg.includes('abort') ? ' (可能是 LLM 响应超时，将继续处理下一批)' : ''}` });
    }

    // 批量测试规格
    try {
      const qaSpecId = `qa-spec-batch-${bi}-${Date.now().toString(36)}`;
      const batchReqDocs = batchIds.map(fid => {
        const content = readDoc(workspacePath, 'requirement', fid);
        return content ? `### Feature ${fid}\n${content}` : null;
      }).filter(Boolean).join('\n\n---\n\n');

      if (batchReqDocs) {
        const specResult = await callLLM(settings, resolveMemberModel(projectId, 'pm', settings), [
          { role: 'system', content: QA_TEST_SPEC_PROMPT },
          {
            role: 'user',
            content: `## 多个 Feature 的子需求文档\n\n${batchReqDocs}\n\n请为以上每个 Feature 分别编写功能测试规格文档。用 "---FEATURE: Fxxx---" 分隔每个 Feature 的文档。`,
          },
        ], signal, 16384, 2, undefined, PHASE3_TIMEOUT_MS);

        const specCost = calcCost(resolveMemberModel(projectId, 'pm', settings), specResult.inputTokens, specResult.outputTokens);
        sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  🧪 批次 ${bi + 1}/${totalBatches} 测试规格生成完成 ($${specCost.toFixed(4)})` });

        const specSections = splitBatchOutput(specResult.content, batchIds);
        for (const fid of batchIds) {
          const content = specSections[fid] || specResult.content;
          const specVer = writeDoc(workspacePath, 'test_spec', content, qaSpecId, `${fid} 初始测试规格`, fid);
          db.prepare("UPDATE features SET test_spec_doc_ver = ? WHERE id = ? AND project_id = ?")
            .run(specVer, fid, projectId);
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `  ⚠️ 批次 ${bi + 1} 测试规格生成失败: ${errMsg}${errMsg.includes('abort') ? ' (可能是 LLM 响应超时，将继续处理下一批)' : ''}` });
    }

    createCheckpoint(projectId, `Phase 3: 批次 ${bi + 1}/${totalBatches} 文档已生成`);
  });

  // 一致性检查
  const featureIds = features.map((f, i) => f.id || `F${String(i + 1).padStart(3, '0')}`);
  const consistency = checkConsistency(workspacePath, featureIds);
  if (!consistency.ok) {
    const issueList = consistency.issues.map(i => `  - [${i.severity}] ${i.description}`).join('\n');
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 文档一致性检查:\n${issueList}` });
  } else {
    sendToUI(win, 'agent:log', { projectId, agentId: 'system', content: `✅ 文档一致性检查通过 (${featureIds.length} features)` });
  }

  emitEvent({ projectId, agentId: 'system', type: 'phase:docs:end', data: { featureCount: features.length } });
  createCheckpoint(projectId, `Phase 3 完成: ${features.length} Feature 文档已生成`);
}

/** Parse batch LLM output, split by Feature ID */
function splitBatchOutput(content: string, featureIds: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < featureIds.length; i++) {
    const fid = featureIds[i];
    const patterns = [
      new RegExp(`---\\s*FEATURE:\\s*${fid}\\s*---([\\s\\S]*?)(?=---\\s*FEATURE:|$)`, 'i'),
      new RegExp(`##\\s*Feature\\s*${fid}\\b([\\s\\S]*?)(?=##\\s*Feature\\s*F\\d|$)`, 'i'),
      new RegExp(`#\\s*${fid}\\b([\\s\\S]*?)(?=#\\s*F\\d|$)`, 'i'),
    ];
    for (const pat of patterns) {
      const match = content.match(pat);
      if (match && match[1]?.trim()) {
        result[fid] = match[1].trim();
        break;
      }
    }
  }
  return result;
}
