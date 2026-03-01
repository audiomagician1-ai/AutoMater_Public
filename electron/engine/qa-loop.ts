/**
 * QA Loop — QA 审查循环
 *
 * TDD 模式: 先跑测试/lint → 再 LLM 审查
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { callLLM } from './llm-client';
import { QA_SYSTEM_PROMPT } from './prompts';
import { readWorkspaceFile } from './file-writer';
import { runTest as sbRunTest, runLint as sbRunLint, type SandboxConfig } from './sandbox-executor';
import { parseStructuredOutput, QA_VERDICT_SCHEMA } from './output-parser';
import { programmaticQACheck } from './guards';
import fs from 'fs';
import path from 'path';

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
  // ═══ v3.0: 程序化 QA 检查 (不依赖 LLM) ═══
  const fileContents = new Map<string, string>();
  for (const filePath of filesWritten.slice(0, 10)) {
    const content = readWorkspaceFile(workspacePath, filePath);
    if (content !== null) {
      fileContents.set(filePath, content);
    }
  }

  // 检测项目类型
  const hasTestFiles = filesWritten.some(f =>
    f.includes('test') || f.includes('spec') || f.includes('__tests__')
  );
  const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(workspacePath, 'requirements.txt'));
  const hasCargoToml = fs.existsSync(path.join(workspacePath, 'Cargo.toml'));

  let testResults = '';
  let testRan = false;
  let testPassed = true;
  let testOutput = '';
  let lintRan = false;
  let lintPassed = true;
  let lintOutput = '';

  if (hasTestFiles || hasPackageJson || hasRequirements || hasCargoToml) {
    const sandboxCfg: SandboxConfig = { workspacePath, timeoutMs: 120_000 };

    try {
      const testResult = sbRunTest(sandboxCfg);
      testRan = true;
      testPassed = testResult.success;
      testOutput = (testResult.stdout + testResult.stderr).slice(0, 3000);
      testResults += `## 测试执行结果\n`;
      testResults += `状态: ${testResult.success ? '✅ PASS' : '❌ FAIL'} (exit ${testResult.exitCode}, ${testResult.duration}ms)\n`;
      testResults += `\`\`\`\n${testOutput}\n\`\`\`\n\n`;
    } catch (e: any) {
      testResults += `## 测试执行\n⚠️ 无法运行: ${e.message}\n\n`;
    }

    try {
      const lintResult = sbRunLint(sandboxCfg);
      if (lintResult.stdout && lintResult.stdout !== '未检测到 lint/type-check 配置') {
        lintRan = true;
        lintPassed = lintResult.success;
        lintOutput = lintResult.stdout.slice(0, 2000);
        testResults += `## Lint/类型检查结果\n`;
        testResults += `状态: ${lintResult.success ? '✅ PASS' : '❌ FAIL'}\n`;
        testResults += `\`\`\`\n${lintOutput}\n\`\`\`\n\n`;
      }
    } catch { /* non-fatal */ }
  }

  // 程序化检查 — 不可被 LLM 覆盖的硬规则
  const programCheck = programmaticQACheck(
    filesWritten,
    fileContents,
    { ran: testRan, passed: testPassed, output: testOutput },
    { ran: lintRan, passed: lintPassed, output: lintOutput },
  );

  // 如果程序化检查已判定 fail，直接返回 (节省 LLM 调用)
  if (programCheck.programVerdict === 'fail') {
    const programIssues = programCheck.issues.map((iss, i) =>
      `${i + 1}. [${iss.severity}] ${iss.file || ''}: ${iss.description}`
    ).join('\n');

    return {
      verdict: 'fail',
      score: Math.max(0, 100 - programCheck.deductions),
      summary: `程序化检查未通过 (${programCheck.issues.length} issues, -${programCheck.deductions} points)`,
      feedbackText: `QA 程序化检查 (硬规则) 未通过:\n${programIssues}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // 程序化检查通过了，交给 LLM 做更深层审查
  const filesContent: string[] = [];
  for (const [filePath, content] of fileContents) {
    filesContent.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
  }

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'system', content: QA_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请审查以下 Feature 的实现代码:\n\nFeature ID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n\n${testResults}## 实现的文件\n${filesContent.join('\n\n')}\n\n请给出审查结果（JSON 格式，不要用 markdown 代码块包裹）。${testResults ? '\n注意: 如果测试失败，verdict 应为 fail。' : ''}`,
    },
  ], signal, 4096);

  // v3.0: 结构化解析替代 regex
  let verdict: 'pass' | 'fail' = 'fail';  // 默认 fail (不再默认 pass)
  let score = 0;
  let summary = '';
  let issues: any[] = [];

  const parseResult = parseStructuredOutput(result.content, QA_VERDICT_SCHEMA);
  if (parseResult.ok) {
    verdict = parseResult.data.verdict;
    score = parseResult.data.score;
    summary = parseResult.data.summary;
    issues = parseResult.data.issues ?? [];
  } else {
    // 解析失败 → 视为 fail (不再静默 pass)
    summary = `QA 输出解析失败 (${parseResult.error}), 默认 fail`;
    verdict = 'fail';
    score = 0;
  }

  // v3.0: 程序化扣分叠加
  score = Math.max(0, score - programCheck.deductions);
  if (programCheck.issues.length > 0) {
    const programIssueDescs = programCheck.issues.map(iss => ({
      severity: iss.severity,
      file: iss.file || '',
      description: `[程序检查] ${iss.description}`,
      suggestion: '',
    }));
    issues = [...programIssueDescs, ...issues];
  }

  // 硬规则: score < 60 → 强制 fail (不管 LLM 说什么)
  if (score < 60) verdict = 'fail';

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
