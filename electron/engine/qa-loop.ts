/**
 * QA Loop — QA 审查循环
 *
 * TDD 模式: 先跑测试/lint → 再 LLM 审查
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { callLLM } from './llm-client';
import { QA_SYSTEM_PROMPT } from './prompts';
import { readWorkspaceFile } from './file-writer';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface QAResult {
  verdict: 'pass' | 'fail';
  score: number;
  summary: string;
  feedbackText: string;
  inputTokens: number;
  outputTokens: number;
}

// ═══════════════════════════════════════
// QA 审查
// ═══════════════════════════════════════

export async function runQAReview(
  settings: any, signal: AbortSignal,
  feature: any, filesWritten: string[], workspacePath: string
): Promise<QAResult> {
  const filesContent: string[] = [];
  for (const filePath of filesWritten.slice(0, 10)) {
    const content = readWorkspaceFile(workspacePath, filePath);
    if (content) {
      filesContent.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  // ═══ TDD — 先跑测试和 lint ═══
  let testResults = '';
  const hasTestFiles = filesWritten.some(f =>
    f.includes('test') || f.includes('spec') || f.includes('__tests__')
  );
  const fs = require('fs');
  const hasPackageJson = fs.existsSync(require('path').join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(require('path').join(workspacePath, 'requirements.txt'));
  const hasCargoToml = fs.existsSync(require('path').join(workspacePath, 'Cargo.toml'));

  if (hasTestFiles || hasPackageJson || hasRequirements || hasCargoToml) {
    const { runTest: sbRunTest, runLint: sbRunLint } = require('./sandbox-executor');
    const sandboxCfg = { workspacePath, timeoutMs: 120_000 };

    try {
      const testResult = sbRunTest(sandboxCfg);
      testResults += `## 测试执行结果\n`;
      testResults += `状态: ${testResult.success ? '✅ PASS' : '❌ FAIL'} (exit ${testResult.exitCode}, ${testResult.duration}ms)\n`;
      testResults += `\`\`\`\n${(testResult.stdout + testResult.stderr).slice(0, 3000)}\n\`\`\`\n\n`;
    } catch (e: any) {
      testResults += `## 测试执行\n⚠️ 无法运行: ${e.message}\n\n`;
    }

    try {
      const lintResult = sbRunLint(sandboxCfg);
      if (lintResult.stdout && lintResult.stdout !== '未检测到 lint/type-check 配置') {
        testResults += `## Lint/类型检查结果\n`;
        testResults += `状态: ${lintResult.success ? '✅ PASS' : '❌ FAIL'}\n`;
        testResults += `\`\`\`\n${lintResult.stdout.slice(0, 2000)}\n\`\`\`\n\n`;
      }
    } catch { /* non-fatal */ }
  }

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请审查以下 Feature 的实现代码:\n\nFeature ID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n\n${testResults}## 实现的文件\n${filesContent.join('\n\n')}\n\n请给出审查结果（JSON 格式，不要用 markdown 代码块包裹）。${testResults ? '\n注意: 如果测试失败，verdict 应为 fail。' : ''}`,
    },
  ], signal, 4096);

  let verdict: 'pass' | 'fail' = 'pass';
  let score = 80;
  let summary = '';
  let issues: any[] = [];

  try {
    const jsonMatch = result.content.trim().match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      verdict = parsed.verdict === 'fail' ? 'fail' : 'pass';
      score = parsed.score ?? 80;
      summary = parsed.summary ?? '';
      issues = parsed.issues ?? [];
    }
  } catch {
    summary = 'QA 输出格式异常，默认通过';
  }

  let feedbackText = `QA 分数: ${score}/100\n${summary}`;
  if (issues.length > 0) {
    feedbackText += '\n\n问题列表:\n' + issues.map((iss: any, i: number) =>
      `${i + 1}. [${iss.severity}] ${iss.file || ''}: ${iss.description}\n   建议: ${iss.suggestion || 'N/A'}`
    ).join('\n');
  }

  return {
    verdict, score, summary, feedbackText,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
