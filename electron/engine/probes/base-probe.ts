/**
 * Base Probe — 探针基础设施
 *
 * 提供所有探针共用的文件读取、grep、graph 遍历工具，
 * 以及 LLM 多轮交互的统一执行框架。
 *
 * 每个探针子类只需实现:
 *   - buildPrompt(): 生成系统/用户 prompt
 *   - parseResponse(): 解析 LLM 输出为 ProbeReport
 *
 * @module probes/base-probe
 */

import fs from 'fs';
import path from 'path';
import type { CodeGraph } from '../code-graph';
import { traverseGraph } from '../code-graph';
import { callLLM } from '../llm-client';
import type { AppSettings } from '../types';
import type {
  ProbeConfig,
  ProbeReport,
    Finding,
  ProbeDepEdge,
  ProbeIssue,
  ScanResult,
  ImportLogCallback,
} from '../probe-types';
import { createLogger } from '../logger';

const log = createLogger('probe');

// ═══════════════════════════════════════
// File Toolkit — zero-LLM file operations
// ═══════════════════════════════════════

/**
 * Read a file from workspace, with optional line limit.
 * Returns empty string if file doesn't exist or is too large.
 */
export function readFileContent(
  workspacePath: string,
  relativePath: string,
  maxLines = 200,
): string {
  const absPath = path.join(workspacePath, relativePath.replace(/\//g, path.sep));
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > 256 * 1024) return `[file too large: ${Math.round(stat.size / 1024)}KB]`;
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + `\n... [truncated, ${lines.length - maxLines} more lines]`;
  } catch (err) { /* silent: 文件读取截断时异常,返回原内容 */
    log.debug('Catch at base-probe.ts:54', { error: String(err) });
    return '';
  }
}

/**
 * Read the first N lines of a file — useful for signatures/exports.
 */
export function readFileHead(
  workspacePath: string,
  relativePath: string,
  lines = 100,
): string {
  return readFileContent(workspacePath, relativePath, lines);
}

/**
 * Simple grep: search for a regex pattern across all files, return matches.
 * Returns array of { file, line, match } objects, limited to maxResults.
 */
export function grepFiles(
  workspacePath: string,
  files: string[],
  pattern: RegExp,
  maxResults = 50,
): Array<{ file: string; lineNum: number; line: string }> {
  const results: Array<{ file: string; lineNum: number; line: string }> = [];

  for (const file of files) {
    if (results.length >= maxResults) break;
    const absPath = path.join(workspacePath, file.replace(/\//g, path.sep));
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > 256 * 1024) continue;
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        if (pattern.test(lines[i])) {
          results.push({ file, lineNum: i + 1, line: lines[i].trim() });
        }
      }
    } catch (err) { /* skip */ }
  }

  return results;
}

/**
 * Get exported symbols from a TypeScript/JavaScript file.
 */
export function getExports(workspacePath: string, relativePath: string): string[] {
  const content = readFileContent(workspacePath, relativePath, 500);
  if (!content) return [];
  const exports: string[] = [];
  const exportRegex = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(content)) !== null) {
    exports.push(match[1]);
  }
  // export { ... }
  const reexport = content.match(/export\s*\{([^}]+)\}/g);
  if (reexport) {
    for (const re of reexport) {
      const inner = re.match(/\{([^}]+)\}/)?.[1] || '';
      for (const sym of inner.split(',')) {
        const name = sym.trim().split(/\s+as\s+/)[0].trim();
        if (name && !exports.includes(name)) exports.push(name);
      }
    }
  }
  return exports;
}

/**
 * Follow import graph edges from seed files, collect file snippets.
 * Used by Entry/Module probes to gather context along dependency chains.
 */
export function followImportChain(
  graph: CodeGraph,
  workspacePath: string,
  seeds: string[],
  maxHops: number,
  maxFiles: number,
  headLines = 100,
): Array<{ file: string; distance: number; snippet: string }> {
  const traversed = traverseGraph(graph, seeds, maxHops, maxFiles);
  return traversed.map(t => ({
    file: t.file,
    distance: t.distance,
    snippet: readFileHead(workspacePath, t.file, headLines),
  }));
}

// ═══════════════════════════════════════
// LLM Response Parsing Helpers
// ═══════════════════════════════════════

/**
 * Extract a JSON block from LLM output.
 * Handles ```json ... ``` fencing and loose JSON objects.
 */
export function extractJSON<T>(text: string, label?: string): T | null {
  // Try labeled code fence: ```label\n {...} ```
  if (label) {
    const fenced = text.match(new RegExp('```' + label + '\\s*\\n([\\s\\S]*?)```'));
    if (fenced?.[1]) {
      try { return JSON.parse(fenced[1].trim()) as T; } catch (err) { /* fall through */ }
    }
  }
  // Try generic json fence
  const jsonFence = text.match(/```json\s*\n([\s\S]*?)```/);
  if (jsonFence?.[1]) {
    try { return JSON.parse(jsonFence[1].trim()) as T; } catch (err) { /* fall through */ }
  }
  // Try bare JSON object
  const bare = text.match(/\{[\s\S]*\}/);
  if (bare?.[0]) {
    try { return JSON.parse(bare[0]) as T; } catch (err) { /* fall through */ }
  }
  return null;
}

/**
 * Extract a fenced code block by label.
 */
export function extractBlock(text: string, label: string): string {
  const match = text.match(new RegExp('```' + label + '\\s*\\n([\\s\\S]*?)```'));
  return match?.[1]?.trim() || '';
}

// ═══════════════════════════════════════
// Base Probe Abstract Class
// ═══════════════════════════════════════

export interface ProbeContext {
  config: ProbeConfig;
  scan: ScanResult;
  settings: AppSettings;
  signal?: AbortSignal;
  onProgress?: (status: string, progress: number) => void;
  /** Detailed log callback for streaming LLM output, probe actions, etc. */
  onLog?: ImportLogCallback;
  /** Per-probe timeout in ms (default: 300000 = 5min) */
  timeoutMs?: number;
}

/** LLM message for probe conversations */
export interface ProbeMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Raw structured output expected from a probe LLM call.
 * The LLM should output JSON matching this shape.
 */
export interface ProbeRawOutput {
  findings: Array<{
    type: string;
    id: string;
    name: string;
    description: string;
    files: string[];
    publicAPI?: string[];
    keyTypes?: string[];
    relationships?: Array<{ target: string; type: string }>;
  }>;
  dependencies?: Array<{ source: string; target: string; type: string }>;
  issues?: Array<{ location: string; severity: string; description: string; category?: string }>;
  markdown: string;
  confidence: number;
}

/**
 * Abstract base class for all probes.
 *
 * Subclasses implement:
 *   - gatherContext(): collect file content/snippets for prompt
 *   - buildMessages(): construct LLM messages from gathered context
 *   - (optional) shouldContinue(): decide if another round is needed
 */
export abstract class BaseProbe {
  protected readonly config: ProbeConfig;
  protected readonly scan: ScanResult;
  protected readonly settings: AppSettings;
  protected readonly signal?: AbortSignal;
  protected readonly onProgress?: (status: string, progress: number) => void;
  protected readonly onLog?: ImportLogCallback;
  protected readonly timeoutMs: number;
  protected readonly ws: string;

  /** Accumulate files examined across rounds */
  protected filesExamined = new Set<string>();
  /** Accumulate total tokens used */
  protected totalTokensUsed = 0;

  constructor(ctx: ProbeContext) {
    this.config = ctx.config;
    this.scan = ctx.scan;
    this.settings = ctx.settings;
    this.signal = ctx.signal;
    this.onProgress = ctx.onProgress;
    this.onLog = ctx.onLog;
    this.timeoutMs = ctx.timeoutMs ?? 300_000; // 5min default
    this.ws = ctx.scan.workspacePath;
  }

  /** Send a detailed log entry to the UI */
  protected emitLog(content: string, type: 'info' | 'stream' | 'thinking' | 'error' = 'info', round?: number) {
    this.onLog?.({
      agentId: `probe:${this.config.id}`,
      content,
      type,
      probeId: this.config.id,
      probeType: this.config.type,
      round,
    });
  }

  /**
   * Execute the probe: multi-round LLM exploration.
   * Returns a complete ProbeReport.
   */
  async execute(): Promise<ProbeReport> {
    const t0 = Date.now();
    let round = 0;

    // Per-probe timeout via AbortController
    const probeTimeout = new AbortController();
    const timeoutTimer = setTimeout(() => probeTimeout.abort(), this.timeoutMs);

    try {
      // Gather initial context
      this.onProgress?.(`探索中...`, 0.1);
      this.emitLog(`🔍 开始探测: ${this.config.description}`);
      this.emitLog(`  种子文件: ${this.config.seeds.join(', ') || '(自动选择)'}`);

      const context = this.gatherContext();
      this.emitLog(`  已收集 ${this.filesExamined.size} 个文件作为上下文`);

      // Build initial messages
      const messages = this.buildMessages(context);

      // Choose model: prefer fastModel, fall back to workerModel
      const model = this.settings.fastModel?.trim() || this.settings.workerModel;
      this.emitLog(`  使用模型: ${model}, 最大 ${this.config.maxRounds} 轮`);

      let lastResponse = '';
      const allRoundResponses: string[] = [];

      while (round < this.config.maxRounds) {
        if (this.signal?.aborted || probeTimeout.signal.aborted) {
          const reason = probeTimeout.signal.aborted
            ? `探针超时 (${Math.round(this.timeoutMs / 1000)}s)`
            : '用户中断';
          this.emitLog(`⚠️ ${reason}`, 'error');
          throw new Error(reason);
        }
        round++;

        this.onProgress?.(
          `第 ${round}/${this.config.maxRounds} 轮探索...`,
          0.1 + (round / this.config.maxRounds) * 0.7,
        );
        this.emitLog(`🧠 第 ${round}/${this.config.maxRounds} 轮 LLM 调用...`, 'info', round);

        log.info(`Probe ${this.config.id}: round ${round}/${this.config.maxRounds}`);

        // Stream the LLM output for real-time visibility
        const onChunk = (chunk: string) => {
          this.emitLog(chunk, 'stream', round);
        };

        const result = await callLLM(
          this.settings,
          model,
          messages,
          this.signal,
          this.config.tokenBudget,
          1, // 1 retry for probes
          onChunk, // stream LLM output to UI
        );

        lastResponse = result.content;
        allRoundResponses.push(lastResponse);
        this.totalTokensUsed += (result.inputTokens || 0) + (result.outputTokens || 0);

        this.emitLog(
          `  ✅ 第 ${round} 轮完成: ${result.outputTokens || 0} output tokens`,
          'info', round,
        );

        // Check if we need another round
        if (round < this.config.maxRounds && this.shouldContinue(lastResponse, round)) {
          const followUp = this.buildFollowUp(lastResponse, round);
          if (followUp) {
            this.emitLog(`  📝 需要继续探索，准备第 ${round + 1} 轮...`, 'info', round);
            messages.push({ role: 'assistant', content: lastResponse });
            messages.push({ role: 'user', content: followUp });
          } else {
            break;
          }
        } else {
          break;
        }
      }

      // Parse the final (or accumulated) response into a ProbeReport
      this.onProgress?.('解析结果...', 0.9);
      const report = this.parseReport(allRoundResponses, round, Date.now() - t0);

      this.emitLog(
        `📊 探针完成: ${report.findings.length} 发现, ${report.filesExamined.length} 文件, ${this.totalTokensUsed} tokens, ${Math.round(report.durationMs / 1000)}s`,
      );

      log.info(`Probe ${this.config.id}: done`, {
        rounds: round,
        filesExamined: report.filesExamined.length,
        findings: report.findings.length,
        tokens: this.totalTokensUsed,
        durationMs: report.durationMs,
      });

      return report;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * Gather file content / snippets for the probe's initial prompt.
   * Returns an opaque context string to be embedded in the prompt.
   */
  protected abstract gatherContext(): string;

  /**
   * Build the LLM messages for the first round.
   */
  protected abstract buildMessages(context: string): ProbeMessage[];

  /**
   * After each round, decide if another round is beneficial.
   * Default: single round only.
   */
  protected shouldContinue(_response: string, _round: number): boolean {
    return false;
  }

  /**
   * Build follow-up user message for subsequent rounds.
   * Only called if shouldContinue() returns true.
   */
  protected buildFollowUp(_response: string, _round: number): string | null {
    return null;
  }

  /**
   * Parse LLM output(s) into a structured ProbeReport.
   */
  protected parseReport(responses: string[], rounds: number, durationMs: number): ProbeReport {
    // Use the last response as the primary output
    const lastResp = responses[responses.length - 1] || '';

    // Try to extract structured JSON
    const raw = extractJSON<ProbeRawOutput>(lastResp, 'json');

    const findings: Finding[] = (raw?.findings || []).map(f => ({
      type: (f.type || 'module') as Finding['type'],
      id: f.id || `${this.config.id}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name || '',
      description: f.description || '',
      files: f.files || [],
      publicAPI: f.publicAPI,
      keyTypes: f.keyTypes,
      relationships: f.relationships || [],
    }));

    const dependencies: ProbeDepEdge[] = (raw?.dependencies || []).map(d => ({
      source: d.source,
      target: d.target,
      type: (d.type || 'import') as ProbeDepEdge['type'],
    }));

    const issues: ProbeIssue[] = (raw?.issues || []).map(i => ({
      location: i.location,
      severity: (i.severity || 'info') as ProbeIssue['severity'],
      description: i.description,
      category: i.category,
    }));

    // Extract markdown from response (try fenced, fall back to full text)
    const markdown = raw?.markdown
      || extractBlock(lastResp, 'markdown')
      || lastResp;

    return {
      probeId: this.config.id,
      type: this.config.type,
      findings,
      markdown,
      filesExamined: [...this.filesExamined],
      dependencies,
      issues,
      confidence: raw?.confidence ?? 0.5,
      tokensUsed: this.totalTokensUsed,
      durationMs,
      rounds,
    };
  }

  // ── Helper utilities for subclasses ──

  /** Read a file and track it as examined */
  protected readFile(relativePath: string, maxLines = 200): string {
    this.filesExamined.add(relativePath);
    return readFileContent(this.ws, relativePath, maxLines);
  }

  /** Read file head (signatures/exports) and track */
  protected readHead(relativePath: string, lines = 100): string {
    this.filesExamined.add(relativePath);
    return readFileHead(this.ws, relativePath, lines);
  }

  /** Grep across all code files */
  protected grep(pattern: RegExp, maxResults = 30): Array<{ file: string; lineNum: number; line: string }> {
    const results = grepFiles(this.ws, this.scan.allCodeFiles, pattern, maxResults);
    for (const r of results) this.filesExamined.add(r.file);
    return results;
  }

  /** Follow imports from seeds */
  protected followImports(seeds: string[], hops = 3, maxFiles = 10): Array<{ file: string; distance: number; snippet: string }> {
    const results = followImportChain(this.scan.graph, this.ws, seeds, hops, maxFiles);
    for (const r of results) this.filesExamined.add(r.file);
    return results;
  }

  /** Get exports of a file */
  protected getExportsOf(relativePath: string): string[] {
    this.filesExamined.add(relativePath);
    return getExports(this.ws, relativePath);
  }

  /** Build the common system prompt prefix for all probes */
  protected buildSystemPrompt(): string {
    return `你是一位代码项目架构探针 (Probe Agent)。你的任务是从特定角度深入分析一个代码项目的局部结构。

## 项目概览
- 名称: ${path.basename(this.ws)}
- 技术栈: ${this.scan.snapshot.techStack.join(', ')}
- 文件数: ${this.scan.snapshot.fileCount}
- 代码行数: ~${this.scan.snapshot.totalLOC}

## 输出格式要求
你必须输出一个 JSON 代码块，包含以下结构:

\`\`\`json
{
  "findings": [
    {
      "type": "module|api-endpoint|data-model|pattern|anti-pattern|dependency|config|entry-flow",
      "id": "唯一标识",
      "name": "名称",
      "description": "详细描述",
      "files": ["相关文件路径"],
      "publicAPI": ["导出的公开接口"],
      "keyTypes": ["关键类型定义"],
      "relationships": [{"target": "目标ID", "type": "关系类型"}]
    }
  ],
  "dependencies": [
    {"source": "源文件/模块", "target": "目标文件/模块", "type": "import|dataflow|event|ipc|config|runtime"}
  ],
  "issues": [
    {"location": "文件:行号", "severity": "critical|warning|info", "description": "问题描述", "category": "分类"}
  ],
  "markdown": "## 探针报告\\n\\n可读的分析摘要...",
  "confidence": 0.8
}
\`\`\`

## 注意
- 使用具体的函数名、类型名、文件路径，不要泛泛而谈
- confidence 反映你对分析准确性的自信程度 (0-1)
- files 中使用相对于项目根目录的正斜杠路径`;
  }
}
