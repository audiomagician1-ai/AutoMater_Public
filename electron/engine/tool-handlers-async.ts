/**
 * Tool Handlers — Async execution implementations
 *
 * 异步工具执行路由: GitHub, Web, Browser, Sandbox, Deploy,
 * Supabase, Cloudflare, Sub-Agent, Image 等需要异步 I/O 的工具。
 * 从 tool-executor.ts (1857行) 拆出以提升可维护性。
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import {
  codeSearchAsync, formatSearchResult,
  readManyFiles, formatReadManyResult,
  streamReadFile, queryCodeGraph, getRepoMap,
  codeSearchFiles,
} from './code-search';
import {
  commit as gitCommit, getDiff, getLog as gitLog,
  createIssue, listIssues, closeIssue, addIssueComment, getIssue,
  createBranch, switchBranch, deleteBranch, listBranches, getCurrentBranch,
  gitPull, gitPush, gitFetch,
  createPR, listPRs, getPR, mergePR,
} from './git-provider';
import {
  execInSandboxAsync, execInSandboxPromise, isAsyncHandle, registerProcess, waitForProcess,
  runTestAsync, runLintAsync, getActiveProcess,
  type SandboxConfig,
} from './sandbox-executor';
import { webSearch, fetchUrl, httpRequest, webSearchBoost } from './web-tools';
import {
  launchBrowser, closeBrowser, navigate as browserNavigateFn,
  browserScreenshot, browserSnapshot, browserClick, browserType,
  browserEvaluate, browserWait, browserNetwork,
  browserHover, browserSelectOption, browserPressKey, browserFillForm,
  browserDrag, browserTabs, browserFileUpload, browserConsole,
} from './browser-tools';
import { analyzeImage, compareScreenshots, visualAssert, cacheScreenshot, getCachedScreenshot } from './visual-tools';
import type { ToolCall, ToolResult, ToolContext } from './tool-registry';
import { safeJsonParse } from './safe-json';
import type { AppSettings } from './types';
import { getDb } from '../db';
import { textToImage, editImage } from './image-gen';
import {
  deployWithCompose, composeDown, pm2Start, pm2Status,
  generateComposeYaml, generateDockerfile, generateNginxConfig,
  writeNginxConfig, writeDockerfile, healthCheck, findAvailablePort,
  type ServiceConfig, type ComposeConfig, type PM2AppConfig, type NginxSiteConfig, type DockerfileConfig,
} from './deploy-tools';
import { executeTool, checkExternalReadPermission } from './tool-executor';
import { executeMcpTool, executeSkillTool } from './tool-handlers-external';
import { compressSubAgentResult, compressParallelResults, compressWithLLM } from './sub-agent-compressor';

const log = createLogger('tool-handlers-async');

export async function executeToolAsyncRaw(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  // ── GitHub ──
  if (call.name === 'github_create_issue') {
    const issue = await createIssue(ctx.gitConfig, call.arguments.title, call.arguments.body, call.arguments.labels || []);
    return issue
      ? { success: true, output: `Issue #${issue.number} 已创建: ${issue.html_url}`, action: 'github' }
      : { success: false, output: 'GitHub Issue 创建失败 (可能未配置 GitHub 模式)', action: 'github' };
  }

  if (call.name === 'github_list_issues') {
    const issues = await listIssues(ctx.gitConfig, call.arguments.state || 'open');
    if (issues.length === 0) return { success: true, output: '无 Issues', action: 'github' };
    const list = issues.map(i => `#${i.number} [${i.state}] ${i.title} ${i.labels.join(',')}`).join('\n');
    return { success: true, output: list, action: 'github' };
  }

  // v13.0: GitHub 扩展
  if (call.name === 'github_close_issue') {
    const ok = await closeIssue(ctx.gitConfig, call.arguments.issue_number);
    return ok
      ? { success: true, output: `Issue #${call.arguments.issue_number} 已关闭`, action: 'github' }
      : { success: false, output: `关闭 Issue #${call.arguments.issue_number} 失败 (可能未配置 GitHub 模式)`, action: 'github' };
  }

  if (call.name === 'github_add_comment') {
    const ok = await addIssueComment(ctx.gitConfig, call.arguments.issue_number, call.arguments.body);
    return ok
      ? { success: true, output: `已在 Issue #${call.arguments.issue_number} 添加评论`, action: 'github' }
      : { success: false, output: `评论 Issue #${call.arguments.issue_number} 失败`, action: 'github' };
  }

  // ── Web ──
  if (call.name === 'web_search') {
    const result = await webSearch(call.arguments.query, call.arguments.max_results ?? 8);
    return result.success
      ? { success: true, output: result.content.slice(0, 6000), action: 'web' }
      : { success: false, output: `搜索失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'fetch_url') {
    const result = await fetchUrl(call.arguments.url, call.arguments.max_length ?? 15000);
    return result.success
      ? { success: true, output: result.content, action: 'web' }
      : { success: false, output: `抓取失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'http_request') {
    const result = await httpRequest({
      url: call.arguments.url,
      method: call.arguments.method,
      headers: call.arguments.headers,
      body: call.arguments.body,
      timeout: call.arguments.timeout,
    });
    const headersSummary = Object.entries(result.headers).slice(0, 10).map(([k, v]) => `${k}: ${v}`).join('\n');
    return { success: result.success, output: `HTTP ${result.status}\n--- Headers ---\n${headersSummary}\n--- Body ---\n${result.body}`.slice(0, 8000), action: 'web' };
  }

  // ── v19.0: File Download ──
  if (call.name === 'download_file') {
    const { downloadFile } = await import('./web-tools');
    const result = await downloadFile(
      {
        url: call.arguments.url as string,
        savePath: call.arguments.save_path as string,
        filename: call.arguments.filename as string | undefined,
        timeout: call.arguments.timeout as number | undefined,
        maxSize: call.arguments.max_size as number | undefined,
      },
      ctx.workspacePath,
    );
    if (!result.success) {
      return { success: false, output: `下载失败: ${result.error}`, action: 'web' };
    }
    const sizeMB = (result.size / 1024 / 1024).toFixed(2);
    return { success: true, output: `✅ 已下载文件\n路径: ${result.filePath}\n大小: ${sizeMB} MB\n类型: ${result.mimeType}`, action: 'web' };
  }

  // ── v19.0: Image Search ──
  if (call.name === 'search_images') {
    const { searchImages } = await import('./web-tools');
    const result = await searchImages(call.arguments.query as string, (call.arguments.count as number) ?? 5);
    if (!result.success) {
      return { success: false, output: `图片搜索失败: ${result.error}`, action: 'web' };
    }
    const lines = result.images.map((img: { url: string; thumbnailUrl: string; title: string; source: string; width?: number; height?: number }, i: number) =>
      `[${i + 1}] ${img.title}\n    URL: ${img.url}\n    缩略图: ${img.thumbnailUrl}\n    来源: ${img.source}${img.width ? `\n    尺寸: ${img.width}×${img.height}` : ''}`
    );
    return { success: true, output: `找到 ${result.images.length} 张图片:\n\n${lines.join('\n\n')}`, action: 'web' };
  }

  // ── v8.0: Enhanced Search & Research ──
  if (call.name === 'web_search_boost') {
    const result = await webSearchBoost(call.arguments.query, call.arguments.max_results ?? 15);
    return result.success
      ? { success: true, output: `[${result.provider}]\n${result.content.slice(0, 8000)}`, action: 'web' }
      : { success: false, output: `增强搜索失败: ${result.error}`, action: 'web' };
  }

  if (call.name === 'deep_research') {
    const { deepResearch } = await import('./research-engine');
    const db = getDb();
    const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
    const settings: AppSettings = settingsRow ? safeJsonParse<AppSettings>(settingsRow.value, {} as AppSettings) : {} as AppSettings;

    const abortController = new AbortController();
    const result = await deepResearch(
      {
        question: call.arguments.question,
        context: call.arguments.context,
        depth: call.arguments.depth || 'standard',
      },
      settings,
      abortController.signal,
      (stage: string, detail: string) => log.info(`[research] [${stage}] ${detail}`),
    );

    if (!result.success) {
      return { success: false, output: `研究失败: ${result.error}`, action: 'web' };
    }

    const summary = [
      `## 深度研究完成`,
      `置信度: ${result.confidence}% | 来源: ${result.sources.length} | Token: ${result.tokenUsage.input + result.tokenUsage.output}`,
      `耗时: 分解=${result.timing.decomposition}ms 搜索=${result.timing.search}ms 提取=${result.timing.extraction}ms 分析=${result.timing.synthesis}ms`,
      '',
      result.report,
    ].join('\n');

    return { success: true, output: summary.slice(0, 12000), action: 'web' };
  }

  // ── v8.0: Black-box Test Runner ──
  if (call.name === 'run_blackbox_tests') {
    const { runBlackboxTests } = await import('./blackbox-test-runner');
    const db = getDb();
    const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
    const settings: AppSettings = settingsRow ? safeJsonParse<AppSettings>(settingsRow.value, {} as AppSettings) : {} as AppSettings;

    const abortController = new AbortController();
    const result = await runBlackboxTests(
      {
        workspacePath: ctx.workspacePath,
        projectId: ctx.projectId,
        featureDescription: call.arguments.feature_description,
        acceptanceCriteria: call.arguments.acceptance_criteria,
        codeFiles: call.arguments.code_files,
        maxRounds: call.arguments.max_rounds ?? 5,
        testTypes: call.arguments.test_types,
        appUrl: call.arguments.app_url,
        onProgress: (stage: string, detail: string) => log.info(`[blackbox] [${stage}] ${detail}`),
      },
      settings,
      abortController.signal,
    );

    return {
      success: result.success,
      output: result.markdownReport.slice(0, 10000),
      action: 'shell',
    };
  }

  // ── v17.0: Enhanced File Operations (async) ──
  if (call.name === 'read_file') {
    const inputPath = call.arguments.path || '';
    const normalizedInput = path.normalize(inputPath);
    const offset = Math.max(1, call.arguments.offset ?? 1);
    const limit = Math.min(2000, Math.max(1, call.arguments.limit ?? ctx.permissions?.readFileLineLimit ?? 300));

    let targetPath: string;
    if (path.isAbsolute(normalizedInput)) {
      const perm = checkExternalReadPermission(inputPath, ctx);
      if (!perm.allowed) return { success: false, output: perm.error!, action: 'read' };
      targetPath = normalizedInput;
    } else {
      const check = path.normalize(inputPath);
      if (check.startsWith('..')) return { success: false, output: `路径不安全: ${inputPath}`, action: 'read' };
      targetPath = path.join(ctx.workspacePath, check);
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      return { success: false, output: `文件不存在: ${call.arguments.path}`, action: 'read' };
    }

    try {
      const result = await streamReadFile(targetPath, offset, limit);
      const sizeStr = result.fileSize > 1024 * 1024
        ? `${(result.fileSize / (1024 * 1024)).toFixed(1)}MB`
        : `${(result.fileSize / 1024).toFixed(0)}KB`;
      const header = `[${call.arguments.path}] ${result.totalLines > 0 ? result.totalLines + ' 行' : sizeStr}, 显示 ${result.startLine}-${result.endLine}`;
      const hasMore = result.hasMore ? `\n... 还有更多内容 (用 offset=${result.endLine + 1} 继续)` : '';
      return { success: true, output: `${header}\n${result.content}${hasMore}`, action: 'read' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `读取失败: ${msg}`, action: 'read' };
    }
  }

  if (call.name === 'read_many_files') {
    const patterns: string[] = Array.isArray(call.arguments.patterns)
      ? call.arguments.patterns
      : [call.arguments.patterns || call.arguments.pattern];
    const result = readManyFiles(ctx.workspacePath, patterns, {
      maxFiles: call.arguments.max_files ?? 30,
      maxLinesPerFile: call.arguments.max_lines_per_file ?? 200,
      maxTotalChars: call.arguments.max_total_chars ?? 80000,
    });
    return { success: true, output: formatReadManyResult(result), action: 'read' };
  }

  if (call.name === 'code_graph_query') {
    try {
      const output = await queryCodeGraph(ctx.workspacePath, {
        type: call.arguments.type || 'summary',
        file: call.arguments.file,
        hops: call.arguments.hops ?? 2,
      });
      return { success: true, output, action: 'read' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `依赖图查询失败: ${msg}`, action: 'read' };
    }
  }

  // ── Browser ──
  if (call.name === 'browser_launch') {
    const result = await launchBrowser({ headless: call.arguments.headless });
    return { success: result.success, output: result.success ? '浏览器已启动' : `启动失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_navigate') {
    const result = await browserNavigateFn(call.arguments.url);
    return { success: result.success, output: result.success ? `已导航到: ${result.title}\nURL: ${result.url}` : `导航失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_screenshot') {
    const result = await browserScreenshot(call.arguments.full_page);
    if (result.success) {
      cacheScreenshot('latest', result.base64);
      return { success: true, output: `[browser_screenshot] ${Math.round(result.base64.length / 1024)}KB PNG`, action: 'computer', _imageBase64: result.base64 };
    }
    return { success: false, output: `截图失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_snapshot') {
    const result = await browserSnapshot();
    return { success: result.success, output: result.success ? result.content : `快照失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_click') {
    const result = await browserClick(call.arguments.selector, { button: call.arguments.button });
    return { success: result.success, output: result.success ? `已点击: ${call.arguments.selector}` : `点击失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_type') {
    const result = await browserType(call.arguments.selector, call.arguments.text, { clear: call.arguments.clear });
    return { success: result.success, output: result.success ? `已输入 ${call.arguments.text.length} 字符到 ${call.arguments.selector}` : `输入失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_evaluate') {
    const result = await browserEvaluate(call.arguments.expression);
    return { success: result.success, output: result.success ? result.result : `执行失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_wait') {
    const result = await browserWait({ selector: call.arguments.selector, text: call.arguments.text, timeout: call.arguments.timeout });
    return { success: result.success, output: result.success ? '等待条件已满足' : `等待超时: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_network') {
    const result = await browserNetwork({ urlPattern: call.arguments.url_pattern });
    return { success: result.success, output: result.success ? result.requests : `网络监听失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_close') {
    await closeBrowser();
    return { success: true, output: '浏览器已关闭', action: 'computer' };
  }

  // ── Visual Verification ──
  if (call.name === 'analyze_image') {
    if (!ctx.callVision) return { success: false, output: '视觉分析不可用：未配置 Vision LLM', action: 'computer' };
    const base64 = getCachedScreenshot(call.arguments.image_label || 'latest');
    if (!base64) return { success: false, output: `未找到标签为 "${call.arguments.image_label || 'latest'}" 的截图。请先截图。`, action: 'computer' };
    const result = await analyzeImage(base64, call.arguments.question, ctx.callVision);
    return { success: result.success, output: result.success ? result.analysis : `分析失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'compare_screenshots') {
    if (!ctx.callVision) return { success: false, output: '视觉对比不可用：未配置 Vision LLM', action: 'computer' };
    const beforeBase64 = getCachedScreenshot(call.arguments.before_label);
    const afterBase64 = getCachedScreenshot(call.arguments.after_label || 'latest');
    if (!beforeBase64) return { success: false, output: `未找到 "before" 截图: "${call.arguments.before_label}"`, action: 'computer' };
    if (!afterBase64) return { success: false, output: `未找到 "after" 截图: "${call.arguments.after_label || 'latest'}"`, action: 'computer' };
    const result = await compareScreenshots(beforeBase64, afterBase64, call.arguments.description || '', ctx.callVision);
    return { success: result.success, output: result.success ? `差异分析 (粗略差异: ${result.pixelDiffPercent}%):\n${result.analysis}` : `对比失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'visual_assert') {
    if (!ctx.callVision) return { success: false, output: '视觉断言不可用：未配置 Vision LLM', action: 'computer' };
    const base64 = getCachedScreenshot(call.arguments.image_label || 'latest');
    if (!base64) return { success: false, output: `未找到标签为 "${call.arguments.image_label || 'latest'}" 的截图`, action: 'computer' };
    const result = await visualAssert(base64, call.arguments.assertion, ctx.callVision);
    return { success: result.success, output: result.success ? `视觉断言 ${result.passed ? '✅ PASS' : '❌ FAIL'} (置信度: ${result.confidence}%)\n断言: ${call.arguments.assertion}\n依据: ${result.reasoning}` : `断言失败: ${result.error}`, action: 'computer' };
  }

  // ── v7.0: Browser Enhancements ──
  if (call.name === 'browser_hover') {
    const result = await browserHover(call.arguments.selector);
    return { success: result.success, output: result.success ? `已悬停: ${call.arguments.selector}` : `悬停失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_select_option') {
    const result = await browserSelectOption(call.arguments.selector, call.arguments.values || []);
    return { success: result.success, output: result.success ? `已选择: ${(result.selected || []).join(', ')}` : `选择失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_press_key') {
    const result = await browserPressKey(call.arguments.key);
    return { success: result.success, output: result.success ? `已按键: ${call.arguments.key}` : `按键失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_fill_form') {
    const result = await browserFillForm(call.arguments.fields || []);
    const msg = `已填写 ${result.filled} 个字段${result.errors.length ? `\n失败: ${result.errors.join('; ')}` : ''}`;
    return { success: result.success, output: msg, action: 'computer' };
  }
  if (call.name === 'browser_drag') {
    const result = await browserDrag(call.arguments.source_selector, call.arguments.target_selector);
    return { success: result.success, output: result.success ? `已拖放: ${call.arguments.source_selector} → ${call.arguments.target_selector}` : `拖放失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_tabs') {
    const result = await browserTabs(call.arguments.action, { index: call.arguments.index, url: call.arguments.url });
    if (result.tabs) {
      const lines = result.tabs.map(t => `[${t.index}] ${t.title || '(无标题)'} — ${t.url}`);
      return { success: true, output: `标签页 (${result.tabs.length}):\n${lines.join('\n')}`, action: 'computer' };
    }
    return { success: result.success, output: result.success ? `标签页操作完成: ${call.arguments.action}` : `操作失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_file_upload') {
    const result = await browserFileUpload(call.arguments.selector, call.arguments.file_paths || []);
    return { success: result.success, output: result.success ? `已上传 ${(call.arguments.file_paths || []).length} 个文件` : `上传失败: ${result.error}`, action: 'computer' };
  }
  if (call.name === 'browser_console') {
    const result = await browserConsole(call.arguments.level || 'info');
    if (!result.success) return { success: false, output: `获取失败: ${result.error}`, action: 'computer' };
    return { success: true, output: result.messages?.length ? result.messages.join('\n') : '(无控制台消息)', action: 'computer' };
  }

  // ── v7.0: Docker Sandbox ──
  if (call.name === 'sandbox_init') {
    const { initSandbox, SANDBOX_PRESETS } = await import('./docker-sandbox');
    const imageOrPreset = call.arguments.image || 'node';
    const presetConfig = SANDBOX_PRESETS[imageOrPreset];
    const config = presetConfig
      ? { ...presetConfig, mountWorkspace: call.arguments.mount_workspace, hostWorkspacePath: ctx.workspacePath, env: call.arguments.env }
      : { image: imageOrPreset, mountWorkspace: call.arguments.mount_workspace, hostWorkspacePath: ctx.workspacePath, env: call.arguments.env, memoryLimit: call.arguments.memory_limit || '1g', workDir: '/workspace' };
    const result = await initSandbox(config);
    return result.success
      ? { success: true, output: `🐳 沙箱已创建\n容器 ID: ${result.containerId}\n镜像: ${config.image}\n工作区挂载: ${config.mountWorkspace ? '是' : '否'}`, action: 'shell' }
      : { success: false, output: `沙箱创建失败: ${result.error}`, action: 'shell' };
  }
  if (call.name === 'sandbox_exec') {
    const { execInContainer } = await import('./docker-sandbox');
    const result = await execInContainer(call.arguments.container_id, call.arguments.command, { timeout: call.arguments.timeout });
    return {
      success: result.success,
      output: result.success
        ? `[sandbox] exit=0 ${result.durationMs}ms\n${result.stdout.slice(0, 8000)}`
        : `[sandbox] exit=${result.exitCode}${result.timedOut ? ' TIMEOUT' : ''} ${result.durationMs}ms\n${result.stderr.slice(0, 3000)}${result.stdout ? '\n--- stdout ---\n' + result.stdout.slice(0, 2000) : ''}`,
      action: 'shell',
    };
  }
  if (call.name === 'sandbox_write') {
    const { writeToContainer } = await import('./docker-sandbox');
    const result = await writeToContainer(call.arguments.container_id, call.arguments.path, call.arguments.content);
    return result.success
      ? { success: true, output: `已写入容器文件: ${call.arguments.path} (${Buffer.byteLength(call.arguments.content, 'utf-8')} bytes)`, action: 'write' }
      : { success: false, output: `写入失败: ${result.error}`, action: 'write' };
  }
  if (call.name === 'sandbox_read') {
    const { readFromContainer } = await import('./docker-sandbox');
    const result = await readFromContainer(call.arguments.container_id, call.arguments.path);
    return result.success
      ? { success: true, output: result.content?.slice(0, 8000) || '(空文件)', action: 'read' }
      : { success: false, output: `读取失败: ${result.error}`, action: 'read' };
  }
  if (call.name === 'sandbox_destroy') {
    const { destroySandbox } = await import('./docker-sandbox');
    const result = await destroySandbox(call.arguments.container_id);
    return result.success
      ? { success: true, output: `沙箱已销毁: ${call.arguments.container_id}`, action: 'shell' }
      : { success: false, output: `销毁失败: ${result.error}`, action: 'shell' };
  }

  // ── v7.0: Sub-Agent Framework ──
  if (call.name === 'spawn_agent') {
    const { spawnSubAgent } = await import('./sub-agent-framework');
    const db = getDb();
    const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
    const settings: AppSettings = settingsRow ? safeJsonParse<AppSettings>(settingsRow.value, {} as AppSettings) : {} as AppSettings;

    const result = await spawnSubAgent(
      call.arguments.task,
      {
        preset: call.arguments.preset,
        extraPrompt: call.arguments.extra_prompt,
        maxIterations: call.arguments.max_iterations,
      },
      ctx,
      settings,
      (msg: string) => log.info(msg),
    );

    // v19.0: 压缩子 Agent 结果 — 只返回精华给父 Agent
    const compressed = compressSubAgentResult(
      {
        success: result.success,
        conclusion: result.conclusion,
        filesCreated: result.filesCreated,
        filesModified: result.filesModified,
        iterations: result.iterations,
        cost: result.cost,
        durationMs: result.durationMs,
      },
      {
        maxChars: 3000,
        role: call.arguments.preset || '子Agent',
        originalTask: call.arguments.task,
      },
    );

    return { success: result.success, output: compressed, action: 'shell' };
  }

  if (call.name === 'spawn_parallel') {
    const { spawnParallel } = await import('./sub-agent-framework');
    const db = getDb();
    const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('app_settings') as { value: string } | undefined;
    const settings: AppSettings = settingsRow ? safeJsonParse<AppSettings>(settingsRow.value, {} as AppSettings) : {} as AppSettings;

    const tasks = (call.arguments.tasks || []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      config: { preset: t.preset as string },
      task: t.task as string,
    }));

    const results = await spawnParallel(tasks, ctx, settings, (msg: string) => log.info(msg));

    // v19.0: 批量压缩并行结果
    const compressed = compressParallelResults(
      results.map(r => ({
        id: r.id,
        result: {
          success: r.result.success,
          conclusion: r.result.conclusion,
          filesCreated: r.result.filesCreated,
          filesModified: r.result.filesModified,
          iterations: r.result.iterations,
          cost: r.result.cost,
          durationMs: r.result.durationMs,
        },
      })),
      4000,
    );

    const allSuccess = results.every(r => r.result.success);
    return { success: allSuccess, output: compressed, action: 'shell' };
  }

  // ── v9.0: Image Generation ──
  if (call.name === 'generate_image') {
    const result = await textToImage({
      prompt: call.arguments.prompt,
      negativePrompt: call.arguments.negative_prompt,
      size: call.arguments.size,
      quality: call.arguments.quality,
      style: call.arguments.style,
      savePath: call.arguments.save_path ? path.resolve(ctx.workspacePath, call.arguments.save_path) : undefined,
    });
    if (!result.success) {
      return { success: false, output: `图像生成失败: ${result.error}`, action: 'web' };
    }
    // 缓存生成的图像以便 edit_image 使用
    if (result.images[0]?.base64) {
      cacheScreenshot('generated_latest', result.images[0].base64);
    }
    const summary = [
      `图像生成成功 ✅ (${result.durationMs}ms)`,
      result.images[0]?.revisedPrompt ? `修正后的 prompt: ${result.images[0].revisedPrompt}` : '',
      result.savedPaths.length > 0 ? `已保存: ${result.savedPaths.join(', ')}` : '',
      `图像大小: ${Math.round((result.images[0]?.base64.length || 0) / 1024)}KB base64`,
      `图像已缓存为 'generated_latest'，可用 edit_image 编辑`,
    ].filter(Boolean).join('\n');
    return { success: true, output: summary, action: 'web' };
  }

  if (call.name === 'edit_image') {
    const srcBase64 = getCachedScreenshot(call.arguments.image_label);
    if (!srcBase64) return { success: false, output: `未找到标签为 "${call.arguments.image_label}" 的图像。请先截图或生成图像。`, action: 'web' };
    const maskBase64 = call.arguments.mask_label ? getCachedScreenshot(call.arguments.mask_label) : undefined;
    const result = await editImage({
      imageBase64: srcBase64,
      maskBase64: maskBase64,
      prompt: call.arguments.prompt,
      size: call.arguments.size,
      savePath: call.arguments.save_path ? path.resolve(ctx.workspacePath, call.arguments.save_path) : undefined,
    });
    if (!result.success) {
      return { success: false, output: `图像编辑失败: ${result.error}`, action: 'web' };
    }
    if (result.images[0]?.base64) {
      cacheScreenshot('edited_latest', result.images[0].base64);
    }
    return {
      success: true,
      output: `图像编辑完成 ✅ (${result.durationMs}ms)\n${result.savedPaths.length > 0 ? `已保存: ${result.savedPaths.join(', ')}` : ''}图像已缓存为 'edited_latest'`,
      action: 'web',
    };
  }

  // ── v13.0: Deployment Tools (renamed from v9.0) ──
  if (call.name === 'deploy_compose_up') {
    const services: ServiceConfig[] = (call.arguments.services || []).map((s: Record<string, unknown>) => ({
      name: s.name as string,
      image: s.image as string | undefined,
      build: s.build as string | undefined,
      ports: (s.ports as string[]) || [],
      env: s.env as Record<string, string> | undefined,
      volumes: s.volumes as string[] | undefined,
      dependsOn: s.depends_on as string[] | undefined,
      healthCheck: s.health_check as string | undefined,
      restart: s.restart as ServiceConfig['restart'],
      command: s.command as string | undefined,
    }));
    const result = await deployWithCompose(
      { projectName: call.arguments.project_name, services },
      ctx.workspacePath,
      { buildFirst: call.arguments.build_first, detach: true },
    );
    return {
      success: result.success,
      output: result.success ? result.output : `部署失败: ${result.error}`,
      action: 'shell',
    };
  }

  if (call.name === 'deploy_compose_down') {
    const result = await composeDown(ctx.workspacePath);
    return { success: result.success, output: result.success ? result.output : `停止失败: ${result.error}`, action: 'shell' };
  }

  if (call.name === 'deploy_dockerfile') {
    const dockerConfig: DockerfileConfig = {
      baseImage: call.arguments.base_image,
      installCmd: call.arguments.install_cmd,
      buildCmd: call.arguments.build_cmd,
      startCmd: call.arguments.start_cmd,
      exposePorts: call.arguments.expose_ports,
    };
    const outputPath = path.resolve(ctx.workspacePath, call.arguments.output_path || 'Dockerfile');
    const result = await writeDockerfile(dockerConfig, outputPath);
    return {
      success: result.success,
      output: result.success ? `Dockerfile 已生成: ${result.filePath}` : `生成失败: ${result.error}`,
      action: 'write',
    };
  }

  if (call.name === 'deploy_health_check') {
    const targets = (call.arguments.urls || []).map((u: Record<string, unknown>) => ({
      name: u.name as string,
      url: u.url as string,
      expectedStatus: u.expected_status as number | undefined,
    }));
    const result = await healthCheck(targets, { timeout: call.arguments.timeout });
    const lines = result.services.map(s =>
      `${s.healthy ? '✅' : '❌'} ${s.name}: ${s.url} ${s.healthy ? `(${s.responseTime}ms)` : `— ${s.error}`}`,
    );
    return {
      success: result.success,
      output: `健康检查 ${result.success ? '全部通过 ✅' : '部分失败 ❌'}\n${lines.join('\n')}`,
      action: 'shell',
    };
  }

  // ── v15.0: Extended Deploy Tools (I4) ──
  if (call.name === 'deploy_compose_generate') {
    const services: ServiceConfig[] = (call.arguments.services || []).map((s: Record<string, unknown>) => ({
      name: s.name as string,
      image: s.image as string | undefined,
      build: s.build as string | undefined,
      ports: (s.ports as string[]) || [],
      env: s.env as Record<string, string> | undefined,
      volumes: s.volumes as string[] | undefined,
      dependsOn: s.depends_on as string[] | undefined,
      restart: s.restart as ServiceConfig['restart'],
      command: s.command as string | undefined,
    }));
    const config: ComposeConfig = {
      projectName: call.arguments.project_name,
      services,
      networkName: call.arguments.network_name,
    };
    const yaml = generateComposeYaml(config);
    return { success: true, output: `docker-compose.yml 已生成:\n\n\`\`\`yaml\n${yaml}\n\`\`\``, action: 'read' };
  }

  if (call.name === 'deploy_dockerfile_generate') {
    const config: DockerfileConfig = {
      baseImage: call.arguments.base_image,
      installCmd: call.arguments.install_cmd,
      buildCmd: call.arguments.build_cmd,
      startCmd: call.arguments.start_cmd,
      exposePorts: call.arguments.expose_ports,
      workDir: call.arguments.work_dir,
    };
    const content = generateDockerfile(config);
    return { success: true, output: `Dockerfile 已生成:\n\n\`\`\`dockerfile\n${content}\n\`\`\``, action: 'read' };
  }

  if (call.name === 'deploy_pm2_start') {
    const apps: PM2AppConfig[] = (call.arguments.apps || []).map((a: Record<string, unknown>) => ({
      name: a.name as string,
      script: a.script as string,
      cwd: a.cwd as string | undefined,
      args: a.args as string | undefined,
      instances: a.instances as number | undefined,
      env: a.env as Record<string, string> | undefined,
      maxMemoryRestart: a.max_memory_restart as string | undefined,
      watch: a.watch as boolean | undefined,
    }));
    const result = await pm2Start(apps, ctx.workspacePath);
    return {
      success: result.success,
      output: result.success ? result.output : `PM2 启动失败: ${result.error}`,
      action: 'shell',
    };
  }

  if (call.name === 'deploy_pm2_status') {
    const result = await pm2Status();
    return { success: result.success, output: result.output, action: 'read' };
  }

  if (call.name === 'deploy_nginx_generate') {
    const config: NginxSiteConfig = {
      serverName: call.arguments.server_name,
      upstream: call.arguments.upstream,
      listenPort: call.arguments.listen_port,
      staticRoot: call.arguments.static_root,
      spaMode: call.arguments.spa_mode,
      ssl: call.arguments.ssl_cert_path ? {
        certPath: call.arguments.ssl_cert_path,
        keyPath: call.arguments.ssl_key_path,
      } : undefined,
    };
    const outputDir = call.arguments.output_dir
      ? path.resolve(ctx.workspacePath, call.arguments.output_dir)
      : ctx.workspacePath;
    const result = await writeNginxConfig(config, outputDir);
    return {
      success: result.success,
      output: result.success ? `Nginx 配置已生成: ${result.filePath}` : `生成失败: ${result.error}`,
      action: 'write',
    };
  }

  if (call.name === 'deploy_find_port') {
    try {
      const port = await findAvailablePort(call.arguments.start_port || 3000, call.arguments.end_port || 9999);
      return { success: true, output: `可用端口: ${port}`, action: 'read' };
    } catch (err: unknown) {
      return { success: false, output: `端口检测失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── MCP 外部工具 ──
  if (call.name.startsWith('mcp_')) {
    return executeMcpTool(call);
  }

  // ── Git (async since v6.0) ──
  if (call.name === 'git_commit') {
    const result = await gitCommit(ctx.gitConfig, call.arguments.message);
    return result.success
      ? { success: true, output: `已提交 ${result.hash}${result.pushed ? ' (已 push)' : ''}`, action: 'git' }
      : { success: false, output: '无变更可提交', action: 'git' };
  }
  if (call.name === 'git_diff') {
    const diff = await getDiff(ctx.workspacePath);
    return { success: true, output: diff.slice(0, 8000) || '无未提交变更', action: 'git' };
  }
  if (call.name === 'git_log') {
    const logs = await gitLog(ctx.workspacePath, call.arguments.count ?? 10);
    return { success: true, output: logs.join('\n') || '无提交记录', action: 'git' };
  }

  // ── v14.0: Branch Management ──
  if (call.name === 'git_create_branch') {
    const result = await createBranch(ctx.gitConfig, call.arguments.branch_name, call.arguments.base_branch);
    return result.success
      ? { success: true, output: `已创建并切换到分支: ${call.arguments.branch_name}${call.arguments.base_branch ? ` (基于 ${call.arguments.base_branch})` : ''}`, action: 'git' }
      : { success: false, output: `创建分支失败: ${result.error}`, action: 'git' };
  }
  if (call.name === 'git_switch_branch') {
    const result = await switchBranch(ctx.gitConfig, call.arguments.branch_name);
    return result.success
      ? { success: true, output: `已切换到分支: ${call.arguments.branch_name}`, action: 'git' }
      : { success: false, output: `切换分支失败: ${result.error}`, action: 'git' };
  }
  if (call.name === 'git_list_branches') {
    const branches = await listBranches(ctx.workspacePath);
    if (branches.length === 0) return { success: true, output: '无分支信息', action: 'git' };
    const current = await getCurrentBranch(ctx.workspacePath);
    const lines = branches.map(b => `${b.current ? '* ' : '  '}${b.name}`);
    return { success: true, output: `当前分支: ${current}\n${lines.join('\n')}`, action: 'git' };
  }
  if (call.name === 'git_delete_branch') {
    const result = await deleteBranch(ctx.gitConfig, call.arguments.branch_name, call.arguments.force || false);
    return result.success
      ? { success: true, output: `已删除分支: ${call.arguments.branch_name}`, action: 'git' }
      : { success: false, output: `删除分支失败: ${result.error}`, action: 'git' };
  }

  // ── v14.0: Remote Sync ──
  if (call.name === 'git_pull') {
    const result = await gitPull(ctx.gitConfig, call.arguments.remote || 'origin', call.arguments.branch);
    return result.success
      ? { success: true, output: `Pull 成功:\n${result.output}`, action: 'git' }
      : { success: false, output: `Pull 失败: ${result.error}`, action: 'git' };
  }
  if (call.name === 'git_push') {
    const result = await gitPush(ctx.gitConfig, call.arguments.remote || 'origin', call.arguments.branch, call.arguments.set_upstream || false);
    return result.success
      ? { success: true, output: `Push 成功:\n${result.output}`, action: 'git' }
      : { success: false, output: `Push 失败: ${result.error}`, action: 'git' };
  }
  if (call.name === 'git_fetch') {
    const result = await gitFetch(ctx.gitConfig, call.arguments.remote || 'origin');
    return result.success
      ? { success: true, output: `Fetch 成功:\n${result.output}`, action: 'git' }
      : { success: false, output: `Fetch 失败: ${result.error}`, action: 'git' };
  }

  // ── v14.0: GitHub PR ──
  if (call.name === 'github_create_pr') {
    const pr = await createPR(ctx.gitConfig, call.arguments.title, call.arguments.body, call.arguments.head_branch, call.arguments.base_branch || 'main', call.arguments.draft || false);
    return pr
      ? { success: true, output: `PR #${pr.number} 已创建: ${pr.html_url}\n${pr.draft ? '(草稿)' : ''}\n${pr.head_branch} → ${pr.base_branch}`, action: 'github' }
      : { success: false, output: 'PR 创建失败 (可能未配置 GitHub 模式或分支不存在)', action: 'github' };
  }
  if (call.name === 'github_list_prs') {
    const prs = await listPRs(ctx.gitConfig, call.arguments.state || 'open');
    if (prs.length === 0) return { success: true, output: '无 Pull Requests', action: 'github' };
    const list = prs.map(p => `#${p.number} [${p.state}${p.draft ? '/draft' : ''}] ${p.title} (${p.head_branch} → ${p.base_branch})${p.merged ? ' ✅merged' : ''}`).join('\n');
    return { success: true, output: `Pull Requests (${prs.length}):\n${list}`, action: 'github' };
  }
  if (call.name === 'github_get_pr') {
    const pr = await getPR(ctx.gitConfig, call.arguments.pr_number);
    if (!pr) return { success: false, output: `PR #${call.arguments.pr_number} 未找到`, action: 'github' };
    return {
      success: true,
      output: `#${pr.number} [${pr.state}${pr.draft ? '/draft' : ''}] ${pr.title}\n${pr.head_branch} → ${pr.base_branch}\nMerged: ${pr.merged}\nMergeable: ${pr.mergeable}\nURL: ${pr.html_url}\n\n${pr.body || '(无描述)'}`,
      action: 'github',
    };
  }
  if (call.name === 'github_merge_pr') {
    const result = await mergePR(ctx.gitConfig, call.arguments.pr_number, call.arguments.merge_method || 'squash', call.arguments.commit_title);
    return result.success
      ? { success: true, output: `PR #${call.arguments.pr_number} 已合并 (${call.arguments.merge_method || 'squash'}) SHA: ${result.sha}`, action: 'github' }
      : { success: false, output: `合并 PR #${call.arguments.pr_number} 失败: ${result.error}`, action: 'github' };
  }

  // ── v14.0: GitHub get single issue (proper API call, replaces list+filter hack) ──
  if (call.name === 'github_get_issue') {
    const issue = await getIssue(ctx.gitConfig, call.arguments.issue_number);
    if (!issue) return { success: false, output: `Issue #${call.arguments.issue_number} 未找到`, action: 'github' };
    return {
      success: true,
      output: `#${issue.number} [${issue.state}] ${issue.title}\n标签: ${issue.labels.join(', ') || '无'}\nURL: ${issue.html_url}\n\n${issue.body || '(无描述)'}`,
      action: 'github',
    };
  }

  // ── v14.0: Supabase Tools ──
  if (call.name.startsWith('supabase_')) {
    const { getSecret } = await import('./secret-manager');
    const accessToken = getSecret(ctx.projectId, 'supabase_access_token');
    const projectRef = getSecret(ctx.projectId, 'supabase_project_ref');

    if (!accessToken) {
      return { success: false, output: '❌ Supabase 未配置: 缺少 supabase_access_token (请在密钥管理中添加)', action: 'web' };
    }

    const sbConfig = {
      accessToken,
      projectRef: projectRef || '',
      dbPassword: getSecret(ctx.projectId, 'supabase_db_password') || '',
      workspacePath: ctx.workspacePath,
    };

    const sb = await import('./supabase-tools');

    if (call.name === 'supabase_status') {
      if (!projectRef) return { success: false, output: '❌ 缺少 supabase_project_ref', action: 'web' };
      const status = await sb.getProjectStatus(sbConfig);
      return status
        ? { success: true, output: `Supabase 项目状态:\n状态: ${status.status}\nAPI: ${status.apiUrl}\nDB: ${status.dbHost}\nAnon Key: ${status.anonKey ? status.anonKey.slice(0, 20) + '...' : '(未获取)'}`, action: 'web' }
        : { success: false, output: '获取 Supabase 状态失败', action: 'web' };
    }
    if (call.name === 'supabase_migration_create') {
      const result = await sb.createMigration(sbConfig, call.arguments.name);
      return { success: result.success, output: result.success ? `迁移文件已创建:\n${result.output}` : `创建失败: ${result.error}`, action: 'shell' };
    }
    if (call.name === 'supabase_migration_push') {
      if (!projectRef) return { success: false, output: '❌ 缺少 supabase_project_ref', action: 'web' };
      const result = await sb.pushMigration(sbConfig);
      return { success: result.success, output: result.success ? `迁移推送成功:\n${result.output}` : `推送失败: ${result.error}\n${result.output}`, action: 'shell' };
    }
    if (call.name === 'supabase_db_pull') {
      if (!projectRef) return { success: false, output: '❌ 缺少 supabase_project_ref', action: 'web' };
      const result = await sb.pullSchema(sbConfig);
      return { success: result.success, output: result.success ? `Schema 拉取成功:\n${result.output}` : `拉取失败: ${result.error}`, action: 'shell' };
    }
    if (call.name === 'supabase_deploy_function') {
      if (!projectRef) return { success: false, output: '❌ 缺少 supabase_project_ref', action: 'web' };
      const result = await sb.deployFunction(sbConfig, call.arguments.function_name);
      return { success: result.success, output: result.success ? `Edge Function "${call.arguments.function_name}" 部署成功:\n${result.output}` : `部署失败: ${result.error}`, action: 'shell' };
    }
    if (call.name === 'supabase_gen_types') {
      if (!projectRef) return { success: false, output: '❌ 缺少 supabase_project_ref', action: 'web' };
      const result = await sb.generateTypes(sbConfig, call.arguments.output_path || 'src/types/supabase.ts');
      return { success: result.success, output: result.success ? result.output : `类型生成失败: ${result.error}`, action: 'write' };
    }
    if (call.name === 'supabase_set_secret') {
      if (!projectRef) return { success: false, output: '❌ 缺少 supabase_project_ref', action: 'web' };
      const ok = await sb.setSupabaseSecret(sbConfig, call.arguments.name, call.arguments.value);
      return ok
        ? { success: true, output: `Supabase Secret "${call.arguments.name}" 已设置`, action: 'web' }
        : { success: false, output: `设置 Secret 失败`, action: 'web' };
    }

    return { success: false, output: `未知 Supabase 工具: ${call.name}`, action: 'web' };
  }

  // ── v14.0: Cloudflare Tools ──
  if (call.name.startsWith('cloudflare_')) {
    const { getSecret } = await import('./secret-manager');
    const apiToken = getSecret(ctx.projectId, 'cloudflare_api_token');
    const accountId = getSecret(ctx.projectId, 'cloudflare_account_id');

    if (!apiToken || !accountId) {
      return { success: false, output: '❌ Cloudflare 未配置: 缺少 cloudflare_api_token 或 cloudflare_account_id (请在密钥管理中添加)', action: 'web' };
    }

    const cfConfig = {
      apiToken,
      accountId,
      zoneId: getSecret(ctx.projectId, 'cloudflare_zone_id') || undefined,
      workspacePath: ctx.workspacePath,
    };

    const cf = await import('./cloudflare-tools');

    if (call.name === 'cloudflare_deploy_pages') {
      const result = await cf.deployPages(cfConfig, {
        projectName: call.arguments.project_name,
        directory: call.arguments.directory || 'dist',
        branch: call.arguments.branch,
      });
      return {
        success: result.success,
        output: result.success
          ? `Pages 部署成功 ✅\nURL: ${result.url}\n${result.output}`
          : `部署失败: ${result.error}\n${result.output}`,
        action: 'shell',
      };
    }
    if (call.name === 'cloudflare_deploy_worker') {
      const result = await cf.deployWorker(cfConfig, {
        name: call.arguments.name,
        entryPoint: call.arguments.entry_point,
      });
      return {
        success: result.success,
        output: result.success
          ? `Worker 部署成功 ✅\nURL: ${result.url}\n${result.output}`
          : `部署失败: ${result.error}\n${result.output}`,
        action: 'shell',
      };
    }
    if (call.name === 'cloudflare_set_secret') {
      const ok = await cf.setWorkerSecret(cfConfig, call.arguments.worker_name, call.arguments.key, call.arguments.value);
      return ok
        ? { success: true, output: `Worker Secret "${call.arguments.key}" 已设置 (${call.arguments.worker_name})`, action: 'web' }
        : { success: false, output: `设置 Worker Secret 失败`, action: 'web' };
    }
    if (call.name === 'cloudflare_dns_list') {
      if (!cfConfig.zoneId) return { success: false, output: '❌ 缺少 cloudflare_zone_id (请在密钥管理中添加)', action: 'web' };
      const records = await cf.listDNSRecords(cfConfig);
      if (records.length === 0) return { success: true, output: '无 DNS 记录', action: 'web' };
      const lines = records.map(r => `${r.type.padEnd(6)} ${r.name.padEnd(30)} → ${r.content} ${r.proxied ? '(proxied)' : ''}`);
      return { success: true, output: `DNS 记录 (${records.length}):\n${lines.join('\n')}`, action: 'web' };
    }
    if (call.name === 'cloudflare_dns_create') {
      if (!cfConfig.zoneId) return { success: false, output: '❌ 缺少 cloudflare_zone_id', action: 'web' };
      const result = await cf.createDNSRecord(cfConfig, {
        type: call.arguments.type,
        name: call.arguments.name,
        content: call.arguments.content,
        proxied: call.arguments.proxied ?? true,
      });
      return result.success
        ? { success: true, output: `DNS 记录已创建: ${call.arguments.type} ${call.arguments.name} → ${call.arguments.content} (ID: ${result.id})`, action: 'web' }
        : { success: false, output: `DNS 创建失败: ${result.error}`, action: 'web' };
    }
    if (call.name === 'cloudflare_status') {
      const status = await cf.getDeploymentStatus(cfConfig, call.arguments.project_name);
      return status
        ? { success: true, output: `Cloudflare 部署状态:\n项目: ${call.arguments.project_name}\nURL: ${status.url}\n状态: ${status.status}\n环境: ${status.environment}\n最后部署: ${status.lastDeploy}`, action: 'web' }
        : { success: false, output: `获取部署状态失败`, action: 'web' };
    }

    return { success: false, output: `未知 Cloudflare 工具: ${call.name}`, action: 'web' };
  }

  // ── Skill 外部工具 ──
  if (call.name.startsWith('skill_')) {
    return executeSkillTool(call);
  }

  // ── v17.1: execSync → async 迁移 — glob_files / run_command / run_test / run_lint / search ──
  if (call.name === 'search_files') {
    const searchPattern = call.arguments.pattern;
    const searchInclude = call.arguments.include;
    const includeArr = searchInclude && searchInclude !== '*' ? [searchInclude] : undefined;
    const result = await codeSearchAsync(ctx.workspacePath, searchPattern, {
      include: includeArr,
      maxResults: 50,
      context: 2,
    });
    return { success: true, output: formatSearchResult(result) || '无匹配', action: 'search' };
  }

  if (call.name === 'code_search') {
    const csPattern = call.arguments.pattern;
    const csInclude = call.arguments.include ? (Array.isArray(call.arguments.include) ? call.arguments.include : [call.arguments.include]) : undefined;
    const csExclude = call.arguments.exclude ? (Array.isArray(call.arguments.exclude) ? call.arguments.exclude : [call.arguments.exclude]) : undefined;
    const csResult = await codeSearchAsync(ctx.workspacePath, csPattern, {
      include: csInclude,
      exclude: csExclude,
      maxResults: call.arguments.max_results ?? 50,
      context: call.arguments.context ?? 2,
      caseSensitive: call.arguments.case_sensitive ?? false,
      fixedString: call.arguments.fixed_string ?? false,
      wholeWord: call.arguments.whole_word ?? false,
    });
    return { success: true, output: formatSearchResult(csResult) || '无匹配', action: 'search' };
  }

  if (call.name === 'glob_files') {
    const pattern = call.arguments.pattern;
    try {
      const globResult = await execInSandboxPromise(
        process.platform === 'win32'
          ? `powershell -NoProfile -Command "Get-ChildItem -Recurse -File -Filter '${pattern.replace(/\*\*\//g, '').replace(/\*/g, '*')}' | ForEach-Object { $_.FullName.Substring((Get-Location).Path.Length + 1).Replace('\\\\', '/') }"`
          : `find . -type f -name "${pattern.replace(/\*\*\//g, '')}" | head -50`,
        { workspacePath: ctx.workspacePath, timeoutMs: 10000, maxOutputBytes: 256 * 1024 },
      );
      if (globResult.success) {
        const files = globResult.stdout.trim().split('\n')
          .filter(f => f && !f.includes('node_modules') && !f.includes('.git'))
          .slice(0, 50);
        return { success: true, output: files.length > 0 ? files.join('\n') : '无匹配文件', action: 'search' };
      }
      return { success: true, output: '无匹配文件', action: 'search' };
    } catch {
      return { success: true, output: '无匹配文件', action: 'search' };
    }
  }

  if (call.name === 'run_command') {
    // v16.0: 需要 shellExec 权限
    if (!ctx.permissions?.shellExec) {
      return { success: false, output: '执行命令被拒绝。请在全景页开启「执行命令」权限。', action: 'shell' };
    }
    const sandboxCfg: SandboxConfig = {
      workspacePath: ctx.workspacePath,
      timeoutMs: call.arguments.timeout ? call.arguments.timeout * 1000 : 120_000,
    };

    // 后台模式 (timeout > 60s 或用户显式指定)
    const isBackground = call.arguments.background === true
      || (call.arguments.timeout && call.arguments.timeout > 60);
    if (isBackground) {
      const timeoutMs = sandboxCfg.timeoutMs ?? 120_000;
      const handleOrErr = execInSandboxAsync(call.arguments.command, { ...sandboxCfg, timeoutMs });
      if (!isAsyncHandle(handleOrErr)) {
        return { success: false, output: handleOrErr.stderr || '启动失败', action: 'shell' };
      }
      const processId = `proc-${Date.now().toString(36)}`;
      registerProcess(processId, handleOrErr);
      return {
        success: true,
        output: `后台进程已启动 (PID: ${handleOrErr.pid}, ID: ${processId})\n命令: ${call.arguments.command}\n超时: ${Math.round(timeoutMs / 1000)}s`,
        action: 'shell',
      };
    }

    // 异步执行 (不阻塞主进程)
    const result = await execInSandboxPromise(call.arguments.command, sandboxCfg);
    if (result.success) {
      return { success: true, output: (result.stdout || '(无输出)').slice(0, 8000), action: 'shell' };
    } else if (result.timedOut) {
      return { success: false, output: `命令超时 (${Math.round(result.duration / 1000)}s):\n${result.stderr.slice(0, 2000)}`, action: 'shell' };
    } else {
      return { success: false, output: `命令失败 (exit ${result.exitCode}):\n${result.stderr.slice(0, 3000)}${result.stdout ? '\n--- stdout ---\n' + result.stdout.slice(0, 2000) : ''}`, action: 'shell' };
    }
  }

  if (call.name === 'run_test') {
    const result = await runTestAsync({ workspacePath: ctx.workspacePath });
    const output = result.stdout + (result.stderr ? '\n[stderr] ' + result.stderr : '');
    return { success: result.success, output: `[run_test] exit=${result.exitCode} duration=${result.duration}ms${result.timedOut ? ' TIMEOUT' : ''}\n${output.slice(0, 8000)}`, action: 'shell' };
  }

  if (call.name === 'run_lint') {
    const result = await runLintAsync({ workspacePath: ctx.workspacePath });
    const output = result.stdout + (result.stderr ? '\n[stderr] ' + result.stderr : '');
    return { success: result.success, output: `[run_lint] exit=${result.exitCode} duration=${result.duration}ms${result.timedOut ? ' TIMEOUT' : ''}\n${output.slice(0, 8000)}`, action: 'shell' };
  }

  // v19.0: 等待后台进程完成
  if (call.name === 'wait_for_process') {
    const procId = call.arguments.process_id;
    const timeoutSec = Math.min(600, Math.max(5, call.arguments.timeout_seconds ?? 120));
    const result = await waitForProcess(procId, timeoutSec * 1000);
    if (result.timedOut) {
      return {
        success: false,
        output: `⏰ 进程 ${procId} 等待超时 (${timeoutSec}s)\n\n--- stdout (最后4000字符) ---\n${result.stdout.slice(-4000)}${result.stderr ? '\n\n--- stderr ---\n' + result.stderr.slice(-1000) : ''}`,
        action: 'shell',
      };
    }
    return {
      success: result.success,
      output: `进程 ${procId} 已完成 (exit=${result.exitCode}, ${Math.round(result.duration / 1000)}s)\n\n--- stdout ---\n${result.stdout.slice(-6000)}${result.stderr ? '\n\n--- stderr ---\n' + result.stderr.slice(-2000) : ''}`,
      action: 'shell',
    };
  }

  // Fallback to sync
  return executeTool(call, ctx);
}
