/**
 * Black-Box Test Runner — 自主黑盒测试 + 迭代修复循环
 *
 * 完整闭环:
 *   1. Plan    — QA Agent 基于需求/代码生成测试场景
 *   2. Execute — 在沙箱/浏览器中运行测试
 *   3. Capture — 收集失败信息 (截图 + console + network + 错误栈)
 *   4. Fix     — Developer Agent 分析失败并生成修复
 *   5. Verify  — 重新运行失败用例验证修复
 *   6. Report  — 生成完整测试报告
 *
 * 迭代策略:
 *   - 最多 N 轮 (默认 5)
 *   - 每轮只修复当前最严重的失败
 *   - 全部通过或达到轮次限制时停止
 *   - 回归检测: 修复后重跑全部已通过用例
 *
 * 依赖:
 *   - sub-agent-framework (spawn coder/tester)
 *   - browser-tools (E2E 测试)
 *   - docker-sandbox (后端测试)
 *   - qa-loop (生成测试骨架)
 *
 * @module blackbox-test-runner
 * @since v8.0.0
 */

import { callLLM } from './llm-client';
import { createLogger } from './logger';
import type { AppSettings, LLMMessage } from './types';

const log = createLogger('blackbox-test');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 单个测试用例 */
export interface TestCase {
  id: string;
  name: string;
  description: string;
  /** 测试类型 */
  type: 'unit' | 'integration' | 'e2e' | 'api';
  /** 测试命令 (unit/integration) 或步骤描述 (e2e) */
  command?: string;
  /** E2E 测试的浏览器操作步骤 */
  steps?: E2EStep[];
  /** 期望结果 */
  expected: string;
}

/** E2E 测试步骤 */
export interface E2EStep {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'screenshot' | 'assert_text' | 'assert_element';
  target?: string; // URL / selector / text
  value?: string;  // 输入值 / 期望文本
  timeout?: number;
}

/** 单个测试结果 */
export interface TestCaseResult {
  testId: string;
  name: string;
  passed: boolean;
  /** 错误信息 */
  error?: string;
  /** stdout */
  stdout?: string;
  /** stderr */
  stderr?: string;
  /** E2E 截图 (base64) */
  screenshotBase64?: string;
  /** 浏览器控制台日志 */
  consoleLogs?: string[];
  /** 网络请求记录 */
  networkErrors?: string[];
  /** 执行耗时 ms */
  durationMs: number;
}

/** 修复尝试记录 */
export interface FixAttempt {
  round: number;
  failedTest: string;
  fixDescription: string;
  filesChanged: string[];
  fixSucceeded: boolean;
}

/** 最终测试报告 */
export interface BlackboxTestReport {
  success: boolean;
  /** 总测试数 */
  totalTests: number;
  /** 通过数 */
  passed: number;
  /** 失败数 */
  failed: number;
  /** 迭代轮次 */
  rounds: number;
  /** 所有测试结果 (最终状态) */
  results: TestCaseResult[];
  /** 修复历史 */
  fixes: FixAttempt[];
  /** 可读报告 (Markdown) */
  markdownReport: string;
  /** 总耗时 ms */
  durationMs: number;
  /** token 消耗 */
  tokenUsage: { input: number; output: number };
}

/** 运行配置 */
export interface BlackboxTestConfig {
  /** 项目工作区路径 */
  workspacePath: string;
  /** 项目 ID */
  projectId?: string;
  /** 测试对象描述 (feature 需求) */
  featureDescription: string;
  /** 验收标准 */
  acceptanceCriteria?: string;
  /** 已写的代码文件列表 */
  codeFiles?: string[];
  /** 最大修复轮次 (默认 5) */
  maxRounds?: number;
  /** 测试类型过滤 */
  testTypes?: Array<'unit' | 'integration' | 'e2e' | 'api'>;
  /** 应用入口 URL (E2E 测试用) */
  appUrl?: string;
  /** 是否在沙箱中运行 (默认 true) */
  useSandbox?: boolean;
  /** 进度回调 */
  onProgress?: (stage: string, detail: string) => void;
}

type ProgressFn = (stage: string, detail: string) => void;

// ═══════════════════════════════════════
// Phase 1: Test Plan Generation
// ═══════════════════════════════════════

async function generateTestPlan(
  config: BlackboxTestConfig,
  settings: AppSettings,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ tests: TestCase[]; inputTokens: number; outputTokens: number }> {
  onProgress?.('plan', '生成测试计划...');

  const codeContext = config.codeFiles && config.codeFiles.length > 0
    ? `\n相关代码文件: ${config.codeFiles.join(', ')}`
    : '';

  const testTypesHint = config.testTypes
    ? `\n只生成以下类型: ${config.testTypes.join(', ')}`
    : '';

  const prompt = `You are a QA engineer. Generate comprehensive black-box test cases for the following feature.

## Feature
${config.featureDescription}

## Acceptance Criteria
${config.acceptanceCriteria || '(none specified)'}
${codeContext}
${testTypesHint}
${config.appUrl ? `\nApp URL for E2E: ${config.appUrl}` : ''}

## Instructions
1. Create test cases that verify the feature works correctly
2. Include positive tests, negative tests, and edge cases
3. For E2E tests, provide step-by-step browser actions
4. For unit/integration tests, provide the test command
5. Max 10 test cases, prioritize most critical scenarios

## Output Format (JSON, no markdown code block)
{
  "tests": [
    {
      "id": "T001",
      "name": "test name",
      "description": "what this tests",
      "type": "unit|integration|e2e|api",
      "command": "npm test -- --grep 'pattern'",
      "steps": [
        {"action": "navigate", "target": "http://localhost:3000"},
        {"action": "click", "target": "#submit-btn"},
        {"action": "assert_text", "target": ".result", "value": "Success"}
      ],
      "expected": "what should happen"
    }
  ]
}`;

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'user', content: prompt },
  ], signal, 4096);

  let tests: TestCase[];
  try {
    const cleaned = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    tests = (parsed.tests || []).slice(0, 10).map((t: Record<string, unknown>, i: number) => ({
      id: (t.id as string) || `T${String(i + 1).padStart(3, '0')}`,
      name: (t.name as string) || `Test ${i + 1}`,
      description: (t.description as string) || '',
      type: (t.type as string) || 'unit',
      command: t.command as string,
      steps: t.steps as E2EStep[] | undefined,
      expected: (t.expected as string) || '',
    }));
  } catch {
    tests = [{
      id: 'T001',
      name: 'Basic functionality test',
      description: 'Verify basic feature works',
      type: 'unit',
      command: 'npm test',
      expected: 'All tests pass',
    }];
  }

  onProgress?.('plan', `已生成 ${tests.length} 个测试用例:\n${tests.map(t => `  [${t.id}] ${t.name} (${t.type})`).join('\n')}`);
  return { tests, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ═══════════════════════════════════════
// Phase 2: Test Execution
// ═══════════════════════════════════════

async function executeTestCase(
  test: TestCase,
  config: BlackboxTestConfig,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<TestCaseResult> {
  const start = Date.now();

  try {
    switch (test.type) {
      case 'unit':
      case 'integration':
        return await executeCommandTest(test, config, start);

      case 'api':
        return await executeApiTest(test, config, start);

      case 'e2e':
        return await executeE2ETest(test, config, start);

      default:
        return {
          testId: test.id,
          name: test.name,
          passed: false,
          error: `未知测试类型: ${test.type}`,
          durationMs: Date.now() - start,
        };
    }
  } catch (err: unknown) {
    return {
      testId: test.id,
      name: test.name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/** 执行命令行测试 (unit/integration) */
async function executeCommandTest(
  test: TestCase,
  config: BlackboxTestConfig,
  start: number,
): Promise<TestCaseResult> {
  const command = test.command || 'npm test';

  if (config.useSandbox !== false) {
    // 优先使用 Docker Sandbox
    try {
      const { isDockerAvailable, initSandbox, execInContainer, destroySandbox } = await import('./docker-sandbox');

      if (isDockerAvailable()) {
        const init = await initSandbox({
          image: 'node:20-slim',
          mountWorkspace: true,
          hostWorkspacePath: config.workspacePath,
          memoryLimit: '1g',
        });

        if (init.success && init.containerId) {
          try {
            // 安装依赖 (如果需要)
            await execInContainer(init.containerId, 'cd /workspace && npm install --silent 2>/dev/null || true', { timeout: 120 });

            // 运行测试
            const result = await execInContainer(init.containerId, `cd /workspace && ${command}`, { timeout: 180 });

            return {
              testId: test.id,
              name: test.name,
              passed: result.success,
              stdout: result.stdout.slice(0, 5000),
              stderr: result.stderr.slice(0, 3000),
              error: result.success ? undefined : `Exit code: ${result.exitCode}`,
              durationMs: Date.now() - start,
            };
          } finally {
            await destroySandbox(init.containerId);
          }
        }
      }
    } catch {
      // Docker 不可用, fallback
    }
  }

  // Fallback: 直接执行 (通过 sandbox-executor)
  const { execInSandbox } = await import('./sandbox-executor');
  type SandboxConfig = import('./sandbox-executor').SandboxConfig;
  const sandboxCfg: SandboxConfig = { workspacePath: config.workspacePath, timeoutMs: 180000 };
  const result = execInSandbox(command, sandboxCfg);

  return {
    testId: test.id,
    name: test.name,
    passed: result.success,
    stdout: result.stdout.slice(0, 5000),
    stderr: result.stderr.slice(0, 3000),
    error: result.success ? undefined : `Exit code: ${result.exitCode}${result.timedOut ? ' (TIMEOUT)' : ''}`,
    durationMs: Date.now() - start,
  };
}

/** 执行 API 测试 */
async function executeApiTest(
  test: TestCase,
  config: BlackboxTestConfig,
  start: number,
): Promise<TestCaseResult> {
  if (!test.command) {
    return {
      testId: test.id,
      name: test.name,
      passed: false,
      error: 'API 测试未指定 command (应为 curl 命令或 URL)',
      durationMs: Date.now() - start,
    };
  }

  // 如果是 URL, 做 GET 请求
  if (test.command.startsWith('http')) {
    try {
      const res = await fetch(test.command, {
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();
      return {
        testId: test.id,
        name: test.name,
        passed: res.ok,
        stdout: `HTTP ${res.status}\n${body.slice(0, 3000)}`,
        error: res.ok ? undefined : `HTTP ${res.status}`,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        testId: test.id,
        name: test.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  // 否则当作 shell 命令执行
  return executeCommandTest(test, config, start);
}

/** 执行 E2E 浏览器测试 */
async function executeE2ETest(
  test: TestCase,
  config: BlackboxTestConfig,
  start: number,
): Promise<TestCaseResult> {
  if (!test.steps || test.steps.length === 0) {
    // 如果没有步骤但有命令, 当作命令测试
    if (test.command) return executeCommandTest(test, config, start);
    return {
      testId: test.id,
      name: test.name,
      passed: false,
      error: 'E2E 测试未提供 steps 或 command',
      durationMs: Date.now() - start,
    };
  }

  const consoleLogs: string[] = [];
  const networkErrors: string[] = [];

  try {
    const browser = await import('./browser-tools');

    // 启动浏览器
    const launch = await browser.launchBrowser({ headless: true });
    if (!launch.success) {
      return { testId: test.id, name: test.name, passed: false, error: `浏览器启动失败: ${launch.error}`, durationMs: Date.now() - start };
    }

    try {
      for (const step of test.steps) {
        switch (step.action) {
          case 'navigate': {
            const nav = await browser.navigate(step.target || config.appUrl || 'http://localhost:3000');
            if (!nav.success) throw new Error(`导航失败: ${nav.error}`);
            break;
          }
          case 'click': {
            if (!step.target) throw new Error('click 步骤缺少 target');
            const click = await browser.browserClick(step.target);
            if (!click.success) throw new Error(`点击失败 ${step.target}: ${click.error}`);
            break;
          }
          case 'type': {
            if (!step.target || !step.value) throw new Error('type 步骤缺少 target 或 value');
            const type = await browser.browserType(step.target, step.value);
            if (!type.success) throw new Error(`输入失败 ${step.target}: ${type.error}`);
            break;
          }
          case 'wait': {
            await browser.browserWait({
              selector: step.target,
              text: step.value,
              timeout: step.timeout || 10000,
            });
            break;
          }
          case 'screenshot': {
            await browser.browserScreenshot();
            break;
          }
          case 'assert_text': {
            if (!step.target || !step.value) throw new Error('assert_text 缺少 target 或 value');
            const snapshot = await browser.browserSnapshot();
            if (snapshot.success && !snapshot.content.includes(step.value)) {
              throw new Error(`文本断言失败: 在 ${step.target} 中未找到 "${step.value}"`);
            }
            break;
          }
          case 'assert_element': {
            if (!step.target) throw new Error('assert_element 缺少 target');
            const eval_ = await browser.browserEvaluate(`!!document.querySelector('${step.target.replace(/'/g, "\\'")}')`);
            if (!eval_.success || eval_.result === 'false') {
              throw new Error(`元素断言失败: 未找到 ${step.target}`);
            }
            break;
          }
        }
      }

      // 收集控制台和网络信息
      const consoleResult = await browser.browserConsole('error');
      if (consoleResult.success && consoleResult.messages) {
        consoleLogs.push(...consoleResult.messages);
      }

      // 最终截图
      const finalScreenshot = await browser.browserScreenshot();

      return {
        testId: test.id,
        name: test.name,
        passed: true,
        consoleLogs: consoleLogs.length > 0 ? consoleLogs : undefined,
        screenshotBase64: finalScreenshot.success ? finalScreenshot.base64 : undefined,
        durationMs: Date.now() - start,
      };

    } finally {
      await browser.closeBrowser();
    }

  } catch (err: unknown) {
    return {
      testId: test.id,
      name: test.name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      consoleLogs: consoleLogs.length > 0 ? consoleLogs : undefined,
      networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
      durationMs: Date.now() - start,
    };
  }
}

// ═══════════════════════════════════════
// Phase 3: Fix Generation
// ═══════════════════════════════════════

interface FixPlan {
  description: string;
  filesToModify: string[];
  suggestedChanges: string;
  inputTokens: number;
  outputTokens: number;
}

async function generateFix(
  failedResult: TestCaseResult,
  test: TestCase,
  config: BlackboxTestConfig,
  allResults: TestCaseResult[],
  settings: AppSettings,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<FixPlan> {
  onProgress?.('fix', `分析失败: ${test.name}`);

  // 读取相关代码文件
  let codeContext = '';
  if (config.codeFiles && config.codeFiles.length > 0) {
    const fs = await import('fs');
    const path = await import('path');
    for (const file of config.codeFiles.slice(0, 5)) {
      try {
        const absPath = path.join(config.workspacePath, file);
        const content = fs.readFileSync(absPath, 'utf-8');
        codeContext += `\n### ${file}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\`\n`;
      } catch { /* skip */ }
    }
  }

  const prompt = `You are a senior developer fixing a test failure. Analyze the failure and suggest precise code changes.

## Failed Test
Name: ${test.name}
Type: ${test.type}
Description: ${test.description}
Expected: ${test.expected}

## Error Output
${failedResult.error || '(no error message)'}
${failedResult.stdout ? `\nSTDOUT:\n${failedResult.stdout.slice(0, 2000)}` : ''}
${failedResult.stderr ? `\nSTDERR:\n${failedResult.stderr.slice(0, 2000)}` : ''}
${failedResult.consoleLogs?.length ? `\nConsole Errors:\n${failedResult.consoleLogs.join('\n')}` : ''}

## Other Test Results
${allResults.filter(r => r.testId !== failedResult.testId).map(r => `${r.passed ? '✅' : '❌'} ${r.name}`).join('\n')}

## Code Context
${codeContext || '(no code files provided)'}

## Instructions
1. Identify the root cause of the failure
2. Suggest specific, minimal code changes to fix it
3. Don't break other passing tests
4. Output JSON (no markdown code block)

## Output Format
{
  "description": "what the fix does",
  "files_to_modify": ["path/to/file.ts"],
  "suggested_changes": "Detailed description of changes to make in each file"
}`;

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'user', content: prompt },
  ], signal, 4096);

  try {
    const cleaned = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      description: parsed.description || 'Fix attempt',
      filesToModify: parsed.files_to_modify || [],
      suggestedChanges: parsed.suggested_changes || result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch {
    return {
      description: 'Fix analysis (unparsed)',
      filesToModify: [],
      suggestedChanges: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

// ═══════════════════════════════════════
// Phase 4: Apply Fix (via Sub-Agent)
// ═══════════════════════════════════════

async function applyFix(
  fix: FixPlan,
  test: TestCase,
  config: BlackboxTestConfig,
  settings: AppSettings,
  signal: AbortSignal,
  onProgress?: ProgressFn,
): Promise<{ success: boolean; filesChanged: string[]; error?: string }> {
  onProgress?.('fix', `应用修复: ${fix.description.slice(0, 80)}`);

  try {
    const { spawnSubAgent } = await import('./sub-agent-framework');
    type SubAgentConfig = import('./sub-agent-framework').SubAgentConfig;
    type ToolContext = import('./tool-registry').ToolContext;

    const ctx: ToolContext = {
      workspacePath: config.workspacePath,
      projectId: config.projectId || '',
      gitConfig: { mode: 'local', workspacePath: config.workspacePath } as any,
    };

    const task = `修复以下测试失败:

## 失败的测试
${test.name}: ${test.description}
期望: ${test.expected}

## 修复方案
${fix.suggestedChanges}

## 需要修改的文件
${fix.filesToModify.join(', ')}

## 规则
1. 只做最小必要修改
2. 不要破坏其他功能
3. 修改后验证语法正确`;

    const agentConfig: SubAgentConfig = {
      preset: 'coder',
      extraPrompt: '你正在修复一个黑盒测试失败。只做最小必要修改，不要重构或优化其他代码。',
      maxIterations: 8,
    };

    const result = await spawnSubAgent(task, agentConfig, ctx, settings);

    return {
      success: result.success,
      filesChanged: [...result.filesCreated, ...result.filesModified],
      error: result.success ? undefined : result.conclusion,
    };
  } catch (err: unknown) {
    return {
      success: false,
      filesChanged: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ═══════════════════════════════════════
// Main Entry — runBlackboxTests
// ═══════════════════════════════════════

/**
 * 运行完整的黑盒测试 + 迭代修复循环。
 *
 * 流程:
 *   1. LLM 生成测试计划
 *   2. 执行所有测试用例
 *   3. 如果有失败: 分析 → 修复 → 重跑
 *   4. 重复直到全部通过或达到轮次限制
 *   5. 生成最终报告
 */
export async function runBlackboxTests(
  config: BlackboxTestConfig,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<BlackboxTestReport> {
  const totalStart = Date.now();
  const maxRounds = config.maxRounds ?? 5;
  const onProgress = config.onProgress;
  let totalInput = 0;
  let totalOutput = 0;

  onProgress?.('start', `开始黑盒测试 (最多 ${maxRounds} 轮修复)`);

  // ── Phase 1: Generate Test Plan ──
  const plan = await generateTestPlan(config, settings, signal, onProgress);
  totalInput += plan.inputTokens;
  totalOutput += plan.outputTokens;

  if (plan.tests.length === 0) {
    return makeReport([], [], 0, totalStart, { input: totalInput, output: totalOutput },
      '⚠️ 无法生成测试用例');
  }

  const fixes: FixAttempt[] = [];
  let currentResults: TestCaseResult[] = [];

  for (let round = 0; round <= maxRounds; round++) {
    onProgress?.('round', `=== 测试轮次 ${round}/${maxRounds} ===`);

    // ── Phase 2: Execute Tests (严格串行, 避免 Docker/Browser 资源竞争) ──
    onProgress?.('execute', `执行 ${plan.tests.length} 个测试用例 (串行)...`);

    currentResults = [];
    for (const test of plan.tests) {
      if (signal.aborted) break;
      onProgress?.('execute', `运行: ${test.name}`);
      const result = await executeTestCase(test, config, settings, signal);
      currentResults.push(result);
    }

    // ── Check Results ──
    const passCount = currentResults.filter(r => r.passed).length;
    const failCount = currentResults.filter(r => !r.passed).length;
    onProgress?.('results', `通过: ${passCount}/${currentResults.length} | 失败: ${failCount}`);

    // 全部通过!
    if (failCount === 0) {
      onProgress?.('success', '🎉 所有测试通过!');
      return makeReport(currentResults, fixes, round, totalStart,
        { input: totalInput, output: totalOutput });
    }

    // 达到最大轮次
    if (round >= maxRounds) {
      onProgress?.('limit', `达到最大修复轮次 (${maxRounds})`);
      break;
    }

    // ── Phase 3-4: Fix ──
    // 选择最严重的失败进行修复 (优先 unit > integration > e2e)
    const typeOrder: Record<string, number> = { unit: 0, integration: 1, api: 2, e2e: 3 };
    const failedResults = currentResults
      .filter(r => !r.passed)
      .sort((a, b) => {
        const testA = plan.tests.find(t => t.id === a.testId);
        const testB = plan.tests.find(t => t.id === b.testId);
        return (typeOrder[testA?.type || 'e2e'] || 3) - (typeOrder[testB?.type || 'e2e'] || 3);
      });

    const targetFail = failedResults[0];
    const targetTest = plan.tests.find(t => t.id === targetFail.testId);
    if (!targetTest) break;

    onProgress?.('fix', `尝试修复: ${targetTest.name}`);

    // 生成修复方案
    const fixPlan = await generateFix(
      targetFail, targetTest, config, currentResults,
      settings, signal, onProgress,
    );
    totalInput += fixPlan.inputTokens;
    totalOutput += fixPlan.outputTokens;

    // 应用修复
    const fixResult = await applyFix(fixPlan, targetTest, config, settings, signal, onProgress);

    fixes.push({
      round: round + 1,
      failedTest: targetTest.name,
      fixDescription: fixPlan.description,
      filesChanged: fixResult.filesChanged,
      fixSucceeded: fixResult.success,
    });

    if (!fixResult.success) {
      onProgress?.('fix', `修复失败: ${fixResult.error}`);
      // 继续下一轮 (可能尝试不同的修复策略)
    } else {
      onProgress?.('fix', `修复已应用, 修改了: ${fixResult.filesChanged.join(', ')}`);
    }
  }

  return makeReport(currentResults, fixes, maxRounds, totalStart,
    { input: totalInput, output: totalOutput });
}

// ═══════════════════════════════════════
// Report Generation
// ═══════════════════════════════════════

function makeReport(
  results: TestCaseResult[],
  fixes: FixAttempt[],
  rounds: number,
  startTime: number,
  tokenUsage: { input: number; output: number },
  note?: string,
): BlackboxTestReport {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const success = failed === 0 && total > 0;

  // ── Markdown Report ──
  const lines: string[] = [
    `# 黑盒测试报告`,
    '',
    `| 指标 | 值 |`,
    `|------|-----|`,
    `| 总测试 | ${total} |`,
    `| 通过 ✅ | ${passed} |`,
    `| 失败 ❌ | ${failed} |`,
    `| 修复轮次 | ${rounds} |`,
    `| 总耗时 | ${Math.round((Date.now() - startTime) / 1000)}s |`,
    `| Token 消耗 | ${tokenUsage.input + tokenUsage.output} |`,
    '',
  ];

  if (note) {
    lines.push(`> ${note}\n`);
  }

  // 测试结果详情
  lines.push('## 测试结果\n');
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    lines.push(`### ${icon} ${r.name} (${r.testId})`);
    if (!r.passed && r.error) {
      lines.push(`**错误:** ${r.error}`);
    }
    if (r.stdout && !r.passed) {
      lines.push(`\`\`\`\n${r.stdout.slice(0, 500)}\n\`\`\``);
    }
    lines.push('');
  }

  // 修复历史
  if (fixes.length > 0) {
    lines.push('## 修复历史\n');
    for (const f of fixes) {
      lines.push(`### Round ${f.round}: ${f.failedTest}`);
      lines.push(`- 描述: ${f.fixDescription}`);
      lines.push(`- 修改: ${f.filesChanged.join(', ') || '(无)'}`);
      lines.push(`- 结果: ${f.fixSucceeded ? '✅ 修复成功' : '❌ 修复失败'}`);
      lines.push('');
    }
  }

  return {
    success,
    totalTests: total,
    passed,
    failed,
    rounds,
    results,
    fixes,
    markdownReport: lines.join('\n'),
    durationMs: Date.now() - startTime,
    tokenUsage,
  };
}
