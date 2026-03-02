/**
 * Worker Phase — Developer ReAct + QA + Lesson Extraction per Feature
 * Extracted from orchestrator.ts for maintainability.
 * @module phases/worker-phase
 */

import {
  BrowserWindow, getDb, createLogger,
  callLLM, calcCost, sendToUI, addLog, notify, sleep,
  spawnAgent, updateAgentStats, checkBudget,
  stopOrchestrator as _stopOrchestrator,
  reactDeveloperLoop, runQAReview, generateTestSkeleton,
  NonRetryableError,
  buildFeatureDocContext, appendProjectMemory, buildLessonExtractionPrompt,
  selectModelTier, resolveModel,
  emitEvent, createCheckpoint,
  claimFiles, releaseFiles, getClaimsSummary, predictAffectedFiles,
  broadcastFilesCreated, getRecentBroadcasts, formatBroadcastContext,
  releaseFeatureLocks,
  commitWorkspace,
  linkFeatureSession, completeFeatureSessionLink, getOrCreateSession, type WorkType,
  resolveMemberModel,
  type AppSettings, type CountResult, type EnrichedFeature, type FeatureRow, type GitProviderConfig,
} from './shared';
import {
  createBranch, switchBranch, gitPush, createPR, addIssueComment, closeIssue, getCurrentBranch,
} from '../git-provider';

const log = createLogger('phase:worker');

// ═══════════════════════════════════════
// Worker Loop (Dev + QA per Feature)
// ═══════════════════════════════════════

export async function workerLoop(
  projectId: string, workerId: string, qaId: string, settings: AppSettings,
  win: BrowserWindow | null, signal: AbortSignal,
  workspacePath: string | null, gitConfig: GitProviderConfig,
  permissions?: import('../tool-registry').AgentPermissions,
) {
  const db = getDb();
  const maxQARetries = 3;

  while (!signal.aborted) {
    const budget = checkBudget(projectId, settings);
    if (!budget.ok) {
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `💰 预算已用尽! ($${budget.spent.toFixed(2)} / $${budget.budget}) — 自动暂停` });
      notify('⚠️ AutoMater 预算告警', `已花费 $${budget.spent.toFixed(2)}，超过预算 $${budget.budget}`);
      _stopOrchestrator(projectId);
      break;
    }

    const lockedFeature = (await import('../agent-manager')).lockNextFeature(projectId, workerId);
    if (!lockedFeature) {
      const inProgress = db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('in_progress', 'reviewing')").get(projectId) as CountResult;
      if (inProgress.c > 0) { await sleep(3000); continue; }
      sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: '✅ 没有更多任务，下班了' });
      db.prepare("UPDATE agents SET status = 'idle', current_task = NULL, last_active_at = datetime('now') WHERE id = ? AND project_id = ?").run(workerId, projectId);
      sendToUI(win, 'agent:status', { projectId, agentId: workerId, status: 'idle', currentTask: null });
      break;
    }

    const feature: EnrichedFeature = { ...lockedFeature };

    db.prepare("UPDATE agents SET status = 'working', current_task = ?, last_active_at = datetime('now') WHERE id = ? AND project_id = ?")
      .run(feature.id, workerId, projectId);
    sendToUI(win, 'agent:status', { projectId, agentId: workerId, status: 'working', currentTask: feature.id, featureTitle: feature.title || feature.description });
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'in_progress', agentId: workerId });
    sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔨 开始: ${feature.id} — ${feature.title || feature.description}` });

    // Inject doc context
    if (workspacePath) {
      const docContext = buildFeatureDocContext(workspacePath, feature.id);
      if (docContext) { feature._docContext = docContext; }
    }

    // File conflict detection
    if (workspacePath) {
      const plannedFiles = predictAffectedFiles(feature);
      const conflicts = claimFiles(workspacePath, workerId, feature.id, plannedFiles);
      if (conflicts.length > 0) {
        const conflictMsg = conflicts.map(c => `⚠️ ${c.otherWorkerId}(${c.otherFeatureId}) 正在修改: ${c.overlappingFiles.join(', ')}`).join('\n');
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔒 文件冲突检测:\n${conflictMsg}\n将注意避免冲突修改` });
        feature._conflictWarning = `注意: 以下文件正被其他 Worker 修改，请协调避免冲突:\n${conflictMsg}`;
      }
      const otherClaims = getClaimsSummary(workspacePath, workerId);
      if (otherClaims) { feature._otherWorkerClaims = otherClaims; }
    }

    // Worker broadcast context injection
    const recentWork = getRecentBroadcasts(600_000, workerId);
    if (recentWork.length > 0) { feature._teamContext = formatBroadcastContext(recentWork); }

    let passed = false;
    let qaFeedback = '';

    // v14.0: Issue-driven branch — create/switch before dev starts
    const featureRow = db.prepare('SELECT github_branch, github_issue_number FROM features WHERE id = ? AND project_id = ?').get(feature.id, projectId) as { github_branch: string | null; github_issue_number: number | null } | undefined;
    const issueBranch = featureRow?.github_branch;
    const issueNumber = featureRow?.github_issue_number;
    if (issueBranch && workspacePath && gitConfig.mode === 'github') {
      try {
        const currentBr = await getCurrentBranch(workspacePath);
        if (currentBr !== issueBranch) {
          const brResult = await createBranch(gitConfig, issueBranch);
          if (brResult.success) {
            sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🌿 已创建分支: ${issueBranch}` });
          } else {
            // Branch may already exist, try switching
            const swResult = await switchBranch(gitConfig, issueBranch);
            if (swResult.success) {
              sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🌿 已切换到分支: ${issueBranch}` });
            } else {
              sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ 分支操作失败: ${brResult.error || swResult.error}（将在当前分支继续）` });
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ 分支创建失败 (非致命): ${errMsg}` });
      }
    }

    // TDD mode — QA generates test skeleton first
    const localQaId = `qa-${workerId}`;  // 固定 ID: 每个 worker 对应一个 QA
    if (settings.tddMode && workspacePath) {
      try {
        spawnAgent(projectId, localQaId, 'qa', win);
        sendToUI(win, 'agent:log', { projectId, agentId: localQaId, content: `📝 TDD: 为 ${feature.id} 生成测试骨架...` });
        sendToUI(win, 'agent:status', { projectId, agentId: localQaId, status: 'working', currentTask: feature.id, featureTitle: `TDD: ${feature.title || ''}` });

        const tddSession = getOrCreateSession(projectId, localQaId, 'qa');
        const tddLinkId = linkFeatureSession({ featureId: feature.id, sessionId: tddSession.id, projectId, agentId: localQaId, agentRole: 'qa', workType: 'qa-tdd', expectedOutput: `为 ${feature.id} 生成 TDD 测试骨架` });

        const tddResult = await generateTestSkeleton(settings, signal, feature, workspacePath, projectId);
        if (tddResult.files.length > 0) {
          const tddFiles = tddResult.files.map(f => f.path).join(', ');
          sendToUI(win, 'agent:log', { projectId, agentId: localQaId, content: `  ✅ TDD 测试骨架已写入: ${tddFiles}` });
          feature._tddTests = tddResult.files.map(f => f.path);
          feature._tddContext = `[TDD 模式] 以下测试文件已预先生成，你的目标是让这些测试全部通过:\n${tddFiles}\n请先阅读测试文件了解验收标准，然后编写实现代码。`;
          completeFeatureSessionLink(tddLinkId, `TDD 测试骨架: ${tddFiles}`, true);
        } else {
          completeFeatureSessionLink(tddLinkId, '未生成测试文件', false);
        }
        db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(localQaId, projectId);
        sendToUI(win, 'agent:status', { projectId, agentId: localQaId, status: 'idle' });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToUI(win, 'agent:log', { projectId, agentId: localQaId, content: `  ⚠️ TDD 测试骨架生成失败 (将继续正常开发): ${errMsg}` });
      }
    }
    let lastErrorMsg = '';

    for (let qaAttempt = 1; qaAttempt <= maxQARetries && !signal.aborted; qaAttempt++) {
      const devSession = getOrCreateSession(projectId, workerId, 'developer');
      const devWorkType: WorkType = qaAttempt === 1 ? 'dev-implement' : 'dev-rework';
      const devLinkId = linkFeatureSession({
        featureId: feature.id, sessionId: devSession.id, projectId,
        agentId: workerId, agentRole: 'developer', workType: devWorkType,
        expectedOutput: qaAttempt === 1
          ? `实现 ${feature.id}: ${(feature.title || feature.description || '').slice(0, 80)}`
          : `重做 ${feature.id} (第${qaAttempt}次, QA反馈: ${(qaFeedback || '').slice(0, 60)})`,
      });

      try {
        const reactResult = await reactDeveloperLoop(projectId, workerId, settings, win, signal, workspacePath, gitConfig, feature, qaFeedback, permissions);
        if (!reactResult.completed) {
          // v18.0: 区分「达到轮数上限」和「其他终止」
          const isMaxIter = reactResult.terminationReason === 'max_iterations';
          if (isMaxIter) {
            // 保存续跑快照 — 标记 feature 为 paused，用户可手动继续
            const snapshot = JSON.stringify({
              workerId,
              qaAttempt,
              qaFeedback,
              filesWritten: reactResult.filesWritten,
              iterations: reactResult.iterations,
              cost: reactResult.totalCost,
              terminationReason: reactResult.terminationReason,
              timestamp: new Date().toISOString(),
            });
            db.prepare("UPDATE features SET status = 'paused', resume_snapshot = ? WHERE id = ? AND project_id = ?")
              .run(snapshot, feature.id, projectId);
            sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'paused' });
            sendToUI(win, 'agent:log', {
              projectId, agentId: workerId,
              content: `⏸️ ${feature.id} 达到最大工作轮数 (${reactResult.iterations} 轮)，已暂停。可在看板页点击「继续」按钮恢复执行。`,
            });
            completeFeatureSessionLink(devLinkId, `暂停: 达到 ${reactResult.iterations} 轮上限`, false);
            break; // 不重试，等待用户手动恢复
          }

          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ ${feature.id} ReAct 未完成 (${qaAttempt}/${maxQARetries})` });
          completeFeatureSessionLink(devLinkId, `ReAct 未完成 (iter=${reactResult.iterations})`, false);
          if (qaAttempt >= maxQARetries) break;
          continue;
        }

        completeFeatureSessionLink(devLinkId, `完成: ${reactResult.filesWritten.length} 文件, ${reactResult.iterations} 迭代, $${reactResult.totalCost.toFixed(4)}`, true);

        // v20.0: Feature 级成本异常预警 (P3-3) — 成本超过 $1 或 30 轮迭代
        if (reactResult.totalCost > 1.0 || reactResult.iterations > 30) {
          sendToUI(win, 'agent:log', {
            projectId, agentId: workerId,
            content: `💰 ${feature.id} 成本预警: $${reactResult.totalCost.toFixed(4)}, ${reactResult.iterations} 迭代, ${reactResult.totalInputTokens + reactResult.totalOutputTokens} tokens`,
          });
          addLog(projectId, workerId, 'warning',
            `[${feature.id}] 成本异常: $${reactResult.totalCost.toFixed(4)}, ${reactResult.iterations} 迭代`);
        }

        if (reactResult.filesWritten.length > 0 && workspacePath) {
          sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: 'reviewing', agentId: localQaId });
          db.prepare("UPDATE features SET status = 'reviewing' WHERE id = ? AND project_id = ?").run(feature.id, projectId);
          db.prepare("UPDATE agents SET status = 'working', current_task = ? WHERE id = ? AND project_id = ?").run(feature.id, localQaId, projectId);
          sendToUI(win, 'agent:status', { projectId, agentId: localQaId, status: 'working', currentTask: feature.id, featureTitle: feature.title || feature.description });
          sendToUI(win, 'agent:log', { projectId, agentId: localQaId, content: `🔍 审查 ${feature.id}...` });

          const qaSession = getOrCreateSession(projectId, localQaId, 'qa');
          const qaLinkId = linkFeatureSession({ featureId: feature.id, sessionId: qaSession.id, projectId, agentId: localQaId, agentRole: 'qa', workType: 'qa-review', expectedOutput: `审查 ${feature.id} 的 ${reactResult.filesWritten.length} 个文件` });

          const qaResult = await runQAReview(settings, signal, feature, reactResult.filesWritten, workspacePath, projectId);
          const qaCost = calcCost(resolveMemberModel(projectId, 'qa', settings), qaResult.inputTokens, qaResult.outputTokens);
          updateAgentStats(localQaId, projectId, qaResult.inputTokens, qaResult.outputTokens, qaCost);
          db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(localQaId, projectId);

          if (qaResult.verdict === 'pass') {
            passed = true;
            completeFeatureSessionLink(qaLinkId, `QA 通过 (分数: ${qaResult.score})`, true);
            sendToUI(win, 'agent:log', { projectId, agentId: localQaId, content: `✅ ${feature.id} QA 通过! (分数: ${qaResult.score}, $${qaCost.toFixed(4)})` });
            notify('✅ Feature 完成', `${feature.id}: ${(feature.title || '').slice(0, 40)} — QA 分数 ${qaResult.score}`);

            if (qaAttempt > 1 && qaFeedback && workspacePath) {
              await extractLessons(projectId, localQaId, feature, qaFeedback, reactResult.filesWritten, qaResult.score, qaAttempt, settings, signal, workspacePath);
            }
            broadcastFilesCreated(workerId, feature.id, reactResult.filesWritten);
            break;
          } else {
            qaFeedback = qaResult.feedbackText;
            completeFeatureSessionLink(qaLinkId, `QA 未通过 (分数: ${qaResult.score}): ${(qaResult.summary || '').slice(0, 100)}`, false);
            sendToUI(win, 'agent:log', { projectId, agentId: localQaId, content: `❌ ${feature.id} QA 未通过 (${qaResult.score}): ${qaResult.summary}` });
            sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔄 ${feature.id} 重做 (${qaAttempt}/${maxQARetries})` });
            db.prepare("UPDATE features SET status = 'in_progress' WHERE id = ? AND project_id = ?").run(feature.id, projectId);

            // v20.0: 自动经验提取 (P2-1) — QA reject 时记录失败原因到项目记忆
            if (workspacePath) {
              try {
                const { extractExperience } = await import('../scratchpad');
                extractExperience(workspacePath, workerId, 'qa_reject',
                  `${feature.id} QA 未通过 (${qaResult.score}): ${(qaResult.summary || '').slice(0, 150)}`);
              } catch { /* silent */ }
            }
          }
        } else {
          passed = true;
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `✅ ${feature.id} 完成 (无文件, $${reactResult.totalCost.toFixed(4)})` });
          break;
        }
      } catch (err: unknown) {
        if (signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        lastErrorMsg = errMsg || 'Unknown error';
        completeFeatureSessionLink(devLinkId, `错误: ${lastErrorMsg.slice(0, 150)}`, false);
        if (err instanceof NonRetryableError) {
          lastErrorMsg = `[NonRetryable:${err.statusCode}] ${err.message}`;
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🛑 ${feature.id} 不可重试错误: ${err.message}` });
          addLog(projectId, workerId, 'error', `[${feature.id}] NonRetryable: ${err.message}`);
          break;
        }
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `❌ ${feature.id} 错误: ${errMsg}` });
        addLog(projectId, workerId, 'error', `[${feature.id}] ${errMsg}`);
        if (qaAttempt >= maxQARetries) break;
        await sleep(2000);
      }
    }

    if (signal.aborted) break;

    // Release claims and locks
    if (workspacePath) { releaseFiles(workspacePath, workerId, feature.id); }
    releaseFeatureLocks(workerId, feature.id);

    const newStatus = passed ? 'qa_passed' : 'failed';
    db.prepare("UPDATE features SET status = ?, locked_by = NULL, last_error = ?, last_error_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE NULL END WHERE id = ? AND project_id = ?")
      .run(newStatus, passed ? null : lastErrorMsg, newStatus, feature.id, projectId);
    sendToUI(win, 'feature:status', { projectId, featureId: feature.id, status: newStatus, agentId: workerId });
    db.prepare("UPDATE agents SET current_task = NULL WHERE id = ? AND project_id = ?").run(workerId, projectId);
    emitEvent({ projectId, agentId: workerId, featureId: feature.id, type: passed ? 'feature:qa_passed' : 'feature:failed', data: { title: feature.title, status: newStatus } });

    const completedCount = (db.prepare("SELECT COUNT(*) as c FROM features WHERE project_id = ? AND status IN ('qa_passed','passed','failed')").get(projectId) as CountResult).c;
    if (completedCount % 3 === 0) createCheckpoint(projectId, `${completedCount} Features 已处理`);
    if (passed && workspacePath) await commitWorkspace(workspacePath, `feat: ${feature.id} — ${(feature.title || '').slice(0, 50)}`);

    // v14.0: Post-completion GitHub automation (push → PR → Issue comment/close)
    if (passed && issueBranch && gitConfig.mode === 'github') {
      try {
        // 1. Push the feature branch
        const pushResult = await gitPush(gitConfig, 'origin', issueBranch, true);
        if (pushResult.success) {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `📤 已推送分支: ${issueBranch}` });
        } else {
          sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ Push 失败: ${pushResult.error}` });
        }

        // 2. Create PR
        if (pushResult.success) {
          const prTitle = `[AutoMater] ${feature.title || feature.id}`;
          const prBody = [
            `## 自动提交 by AutoMater`,
            '',
            `**Feature**: ${feature.id}`,
            issueNumber ? `**Issue**: Closes #${issueNumber}` : '',
            '',
            `### 描述`,
            feature.description || feature.title || '(无描述)',
            '',
            `> 🤖 此 PR 由 AutoMater 自动创建`,
          ].filter(Boolean).join('\n');

          const pr = await createPR(gitConfig, prTitle, prBody, issueBranch, 'main', false);
          if (pr) {
            sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `🔀 PR #${pr.number} 已创建: ${pr.html_url}` });
            // 记录 PR 号
            db.prepare('UPDATE features SET github_pr_number = ? WHERE id = ? AND project_id = ?').run(pr.number, feature.id, projectId);
          } else {
            sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ PR 创建失败` });
          }

          // 3. Comment + close Issue
          if (issueNumber) {
            const commentBody = pr
              ? `🤖 **AutoMater** 已完成此 Issue 的开发！\n\n✅ QA 通过\n🔀 PR: #${pr.number}\n🌿 分支: \`${issueBranch}\`\n\n请审查 PR 后合并。`
              : `🤖 **AutoMater** 已完成此 Issue 的开发！\n\n✅ QA 通过\n🌿 分支: \`${issueBranch}\` 已推送\n\n请手动创建 PR 审查。`;
            await addIssueComment(gitConfig, issueNumber, commentBody);
            // 不自动关闭 Issue — 让 PR 合并时通过 "Closes #N" 自动关闭
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToUI(win, 'agent:log', { projectId, agentId: workerId, content: `⚠️ GitHub 自动化失败 (非致命): ${errMsg}` });
        addLog(projectId, workerId, 'warn', `GitHub automation failed for ${feature.id}: ${errMsg}`);
      }
    }

    // v14.0: Switch back to main branch after feature completion
    if (issueBranch && workspacePath && gitConfig.mode === 'github') {
      try {
        await switchBranch(gitConfig, 'main');
      } catch { /* silent: 分支切回main失败不影响主流程 */
        // Non-fatal: might not have a main branch
      }
    }

    await sleep(500);
  }
}

// ═══════════════════════════════════════
// Lesson Extraction Helper
// ═══════════════════════════════════════

async function extractLessons(
  projectId: string, qaId: string, feature: EnrichedFeature | FeatureRow, qaFeedback: string,
  filesWritten: string[], qaScore: number, qaAttempt: number,
  settings: AppSettings, signal: AbortSignal, workspacePath: string,
): Promise<void> {
  try {
    const lessonPrompt = buildLessonExtractionPrompt(feature.id, qaFeedback, filesWritten, `QA pass on attempt ${qaAttempt}, score ${qaScore}`);
    const lessonModel = resolveModel(selectModelTier({ type: 'lesson_extract' }).tier, settings);
    const lessonResult = await callLLM(settings, lessonModel, [
      { role: 'system', content: '你是经验提取助手，只输出经验条目。' },
      { role: 'user', content: lessonPrompt },
    ], signal, 1024);

    const lessonCost = calcCost(lessonModel, lessonResult.inputTokens, lessonResult.outputTokens);
    updateAgentStats(qaId, projectId, lessonResult.inputTokens, lessonResult.outputTokens, lessonCost);

    const lessons = lessonResult.content.trim();
    if (lessons) {
      appendProjectMemory(workspacePath, `### Lessons from ${feature.id} (QA attempt ${qaAttempt})\n${lessons}`);
      sendToUI(null, 'agent:log', { projectId, agentId: 'system', content: `📝 经验已记录:\n${lessons.slice(0, 200)}` });
      addLog(projectId, 'system', 'lesson', `[${feature.id}] ${lessons}`);
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    sendToUI(null, 'agent:log', { projectId, agentId: 'system', content: `⚠️ 经验提取失败: ${errMsg}` });
  }
}
