/**
 * QA Loop — QA 审查循环
 *
 * v5.5 增强: 始终尝试 test/lint 执行 (不再仅在检测到测试文件时才跑)
 * 流程: 程序化检查 → test/lint 执行 → LLM 深度审查
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { callLLM } from './llm-client';
import { QA_SYSTEM_PROMPT } from './prompts';
import { readWorkspaceFile } from './file-writer';
import { runTest as sbRunTest, runLint as sbRunLint, type SandboxConfig } from './sandbox-executor';
import { parseStructuredOutput, QA_VERDICT_SCHEMA } from './output-parser';
import { programmaticQACheck } from './guards';
import { getTeamPrompt } from './agent-manager';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('qa-loop');

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
// Helpers
// ═══════════════════════════════════════

/** Detect if workspace has any test infrastructure */
function detectTestInfra(workspacePath: string): { hasTests: boolean; hasLint: boolean; framework: string } {
  const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(workspacePath, 'requirements.txt'));
  const hasPyproject = fs.existsSync(path.join(workspacePath, 'pyproject.toml'));
  const hasCargoToml = fs.existsSync(path.join(workspacePath, 'Cargo.toml'));
  const hasGoMod = fs.existsSync(path.join(workspacePath, 'go.mod'));
  const hasTsConfig = fs.existsSync(path.join(workspacePath, 'tsconfig.json'));

  let framework = 'unknown';
  if (hasPackageJson) framework = 'node';
  else if (hasRequirements || hasPyproject) framework = 'python';
  else if (hasCargoToml) framework = 'rust';
  else if (hasGoMod) framework = 'go';

  const hasLint = hasTsConfig ||
    fs.existsSync(path.join(workspacePath, '.eslintrc.json')) ||
    fs.existsSync(path.join(workspacePath, '.eslintrc.js')) ||
    fs.existsSync(path.join(workspacePath, 'eslint.config.js'));

  return {
    hasTests: hasPackageJson || hasRequirements || hasPyproject || hasCargoToml || hasGoMod,
    hasLint,
    framework,
  };
}

// ═══════════════════════════════════════
// QA 审查
// ═══════════════════════════════════════

export async function runQAReview(
  settings: any, signal: AbortSignal,
  feature: any, filesWritten: string[], workspacePath: string,
  projectId?: string
): Promise<QAResult> {
  // ═══ v3.0: 程序化 QA 检查 (不依赖 LLM) ═══
  const fileContents = new Map<string, string>();
  for (const filePath of filesWritten.slice(0, 10)) {
    const content = readWorkspaceFile(workspacePath, filePath);
    if (content !== null) {
      fileContents.set(filePath, content);
    }
  }

  // ═══ v5.5: 始终尝试 test + lint (不再仅在有测试文件时) ═══
  const infra = detectTestInfra(workspacePath);
  let testResults = '';
  let testRan = false;
  let testPassed = true;
  let testOutput = '';
  let lintRan = false;
  let lintPassed = true;
  let lintOutput = '';

  const sandboxCfg: SandboxConfig = { workspacePath, timeoutMs: 120_000 };

  // Always attempt test execution if any test framework is detected
  if (infra.hasTests) {
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
  }

  // Always attempt lint/type-check if any lint tool is detected
  if (infra.hasLint || infra.hasTests) {
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
    } catch (err) {
      log.warn('Lint execution failed during QA', { error: String(err) });
    }
  }

  // 程序化检查 — 不可被 LLM 覆盖的硬规则
  const programCheck = programmaticQACheck(
    filesWritten,
    fileContents,
    { ran: testRan, passed: testPassed, output: testOutput },
    { ran: lintRan, passed: lintPassed, output: lintOutput },
  );

  // v5.5: 测试失败是硬性失败 — 不依赖 LLM 判断
  if (testRan && !testPassed) {
    const failMsg = [
      `测试执行失败 (硬性规则):`,
      testOutput.slice(0, 2000),
      '',
      ...(programCheck.issues.length > 0 ? [
        '程序化检查问题:',
        ...programCheck.issues.map((iss, i) => `${i + 1}. [${iss.severity}] ${iss.file || ''}: ${iss.description}`),
      ] : []),
    ].join('\n');

    return {
      verdict: 'fail',
      score: Math.max(0, 30 - programCheck.deductions),
      summary: '测试执行失败 — 必须修复后重新提交',
      feedbackText: failMsg,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

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

  // v4.0: 从 team_members 读取自定义 prompt, fallback 到内置 prompt
  const qaPrompt = (projectId ? getTeamPrompt(projectId, 'qa') : null) ?? QA_SYSTEM_PROMPT;

  // v5.5: 增强 prompt — 包含测试/lint 执行结果 + 明确的评分标准
  const testContext = testResults
    ? `\n## 自动化测试/Lint 执行结果\n${testResults}\n重要: 如果测试或lint未通过, verdict 必须为 fail。`
    : '\n注意: 该项目未检测到自动化测试框架, 请特别注意代码逻辑正确性。';

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'system', content: qaPrompt },
    {
      role: 'user',
      content: `请审查以下 Feature 的实现代码:\n\nFeature ID: ${feature.id}\n标题: ${feature.title}\n描述: ${feature.description}\n验收标准: ${feature.acceptance_criteria}\n${testContext}\n## 实现的文件\n${filesContent.join('\n\n')}\n\n请给出审查结果（JSON 格式，不要用 markdown 代码块包裹）。`,
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

  // v5.5: lint 失败也强制扣分
  if (lintRan && !lintPassed) {
    score = Math.max(0, score - 15);
    issues.unshift({
      severity: 'major',
      file: '',
      description: '[程序检查] Lint/类型检查失败 — 代码有编译错误或 lint 违规',
      suggestion: '修复 lint/type-check 报告的所有错误',
    });
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

// ═══════════════════════════════════════
// TDD Mode: 测试骨架生成 (G14)
// ═══════════════════════════════════════

/**
 * TDD 模式: 在 Developer 编码之前, 由 QA 先生成测试骨架。
 * Developer 的任务变为"让这些测试通过"。
 *
 * @returns 生成的测试文件列表 (相对路径) 和内容
 */
export async function generateTestSkeleton(
  settings: any,
  signal: AbortSignal,
  feature: any,
  workspacePath: string,
  projectId?: string,
): Promise<{ files: Array<{ path: string; content: string }>; tokensUsed: number }> {
  const qaPrompt = (projectId ? getTeamPrompt(projectId, 'qa') : null) ?? QA_SYSTEM_PROMPT;
  const infra = detectTestInfra(workspacePath);

  let framework = 'jest';
  let testExt = '.test.ts';
  let testDir = '__tests__';
  switch (infra.framework) {
    case 'python':
      framework = 'pytest';
      testExt = '_test.py';
      testDir = 'tests';
      break;
    case 'rust':
      framework = 'cargo test';
      testExt = '.rs';
      testDir = 'tests';
      break;
    case 'go':
      framework = 'go test';
      testExt = '_test.go';
      testDir = '';
      break;
  }

  // 读取 feature 的子需求文档 (如有)
  const reqDocPath = path.join(workspacePath, `.agentforge/docs/requirements/${feature.id}.md`);
  let reqDoc = '';
  if (fs.existsSync(reqDocPath)) {
    reqDoc = fs.readFileSync(reqDocPath, 'utf-8').slice(0, 3000);
  }

  // 读取 feature 的测试规格 (如有)
  const testSpecPath = path.join(workspacePath, `.agentforge/docs/test_specs/${feature.id}.md`);
  let testSpec = '';
  if (fs.existsSync(testSpecPath)) {
    testSpec = fs.readFileSync(testSpecPath, 'utf-8').slice(0, 3000);
  }

  const prompt = `你是 QA 工程师, 负责为以下 Feature 在 Developer 编码之前生成测试骨架 (TDD 模式)。

Feature: ${feature.id}
标题: ${feature.title || feature.description}
描述: ${feature.description}
验收标准: ${feature.acceptance_criteria || '无'}

${reqDoc ? `## 子需求文档\n${reqDoc}\n` : ''}
${testSpec ? `## 测试规格\n${testSpec}\n` : ''}

项目使用 ${framework} 测试框架。

## 要求
1. 为每个验收标准生成至少一个测试用例
2. 测试应该有清晰的 describe/it 描述
3. 断言先写好，实现体标注为 TODO 或使用 placeholder
4. 测试文件名使用 ${testExt} 后缀
5. 测试应该是可运行的（导入路径可以用预期路径）

## 输出格式
输出 JSON 数组, 每个元素包含:
- path: 测试文件的相对路径 (如 "${testDir ? testDir + '/' : ''}feature-name${testExt}")
- content: 完整的测试文件内容

直接输出 JSON, 不要用 markdown 代码块包裹。`;

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'system', content: qaPrompt },
    { role: 'user', content: prompt },
  ], signal, 8192);

  let files: Array<{ path: string; content: string }> = [];
  try {
    const cleaned = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    files = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    log.warn('Failed to parse TDD test skeleton output', { raw: result.content.slice(0, 200) });
    // Fallback: 将整个输出作为单个测试文件
    if (result.content.includes('import') || result.content.includes('describe') || result.content.includes('def test_')) {
      files = [{
        path: `${testDir ? testDir + '/' : ''}${(feature.id || 'feature').toLowerCase()}${testExt}`,
        content: result.content,
      }];
    }
  }

  // 写入测试文件到工作区
  for (const file of files) {
    if (!file.path || !file.content) continue;
    const fullPath = path.join(workspacePath, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');
    log.info('TDD: wrote test skeleton', { path: file.path });
  }

  return { files, tokensUsed: result.inputTokens + result.outputTokens };
}
