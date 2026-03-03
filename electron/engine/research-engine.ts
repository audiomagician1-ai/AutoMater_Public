/**
 * Research Engine — 深度研究分析引擎
 *
 * 深度研究引擎能力:
 *   1. Query Decomposition — 将复杂问题拆解为多个可搜索的子查询
 *   2. Parallel Search     — 并行搜索多个子查询 (使用 search-provider)
 *   3. Source Extraction   — 对高价值结果深度提取 (readUrl)
 *   4. Synthesis           — LLM 综合分析，交叉验证
 *   5. Fact-Check          — 关键结论交叉搜索验证
 *
 * 单次调用即可完成一轮完整的深度研究。
 * 支持流式进度回调 (onProgress)。
 *
 * @module research-engine
 * @since v8.0.0
 */

import { search, readUrl, type SearchResult, type SearchResponse } from './search-provider';
import { callLLM } from './llm-client';
import { createLogger } from './logger';
import type { AppSettings } from './types';

const _log = createLogger('research-engine');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ResearchRequest {
  /** 主问题 / 研究目标 */
  question: string;
  /** 额外上下文 (项目背景等) */
  context?: string;
  /** 最大搜索轮次 (默认 2) */
  maxRounds?: number;
  /** 每轮最大搜索查询数 (默认 4) */
  maxQueries?: number;
  /** 是否深度提取 top N 页面内容 (默认 3) */
  deepReadCount?: number;
  /** 是否执行 fact-check 交叉验证 (默认 true) */
  factCheck?: boolean;
  /** 研究深度: quick(快速1轮) / standard(标准2轮) / deep(3轮+fact-check) */
  depth?: 'quick' | 'standard' | 'deep';
}

export interface ResearchResult {
  success: boolean;
  /** 最终研究报告 (Markdown) */
  report: string;
  /** 使用的来源列表 */
  sources: ResearchSource[];
  /** 关键发现摘要 */
  keyFindings: string[];
  /** 置信度 (0-100) */
  confidence: number;
  /** 各阶段耗时 */
  timing: {
    decomposition: number;
    search: number;
    extraction: number;
    synthesis: number;
    factCheck: number;
    total: number;
  };
  /** token 消耗 */
  tokenUsage: { input: number; output: number };
  error?: string;
}

export interface ResearchSource {
  url: string;
  title: string;
  relevance: 'high' | 'medium' | 'low';
  /** 是否深度提取过内容 */
  deepRead: boolean;
}

type ProgressCallback = (stage: string, detail: string) => void;

// ═══════════════════════════════════════
// Query Decomposition
// ═══════════════════════════════════════

interface DecomposedQuery {
  subQueries: string[];
  searchStrategy: string;
}

async function decomposeQuery(
  question: string,
  context: string,
  maxQueries: number,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<{ result: DecomposedQuery; inputTokens: number; outputTokens: number }> {

  const prompt = `You are a research query planner. Decompose the user's research question into ${maxQueries} optimal search queries.

## Rules
- Each query should target a DIFFERENT aspect of the question
- Use English for technical queries (better results)
- Include both broad and specific queries
- If the question is already narrow, add related/comparative queries
- Return ONLY a JSON object, no markdown

## Output Format
{
  "sub_queries": ["query1", "query2", ...],
  "strategy": "brief explanation of search strategy"
}

## Context
${context || '(none)'}

## Question
${question}`;

  const result = await callLLM(settings, settings.workerModel || settings.strongModel, [
    { role: 'user', content: prompt },
  ], signal, 1024);

  let decomposed: DecomposedQuery;
  try {
    const cleaned = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    decomposed = {
      subQueries: (parsed.sub_queries || parsed.subQueries || [question]).slice(0, maxQueries),
      searchStrategy: parsed.strategy || '',
    };
  } catch { /* silent: 搜索策略LLM解析失败 */
    // LLM 解析失败 → 用原始问题
    decomposed = {
      subQueries: [question, `${question} best practices`, `${question} examples`].slice(0, maxQueries),
      searchStrategy: 'fallback: using original question',
    };
  }

  return { result: decomposed, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ═══════════════════════════════════════
// Parallel Search
// ═══════════════════════════════════════

async function parallelSearch(
  queries: string[],
  onProgress?: ProgressCallback,
): Promise<{ allResults: SearchResult[]; responses: SearchResponse[] }> {
  onProgress?.('search', `并行搜索 ${queries.length} 个查询...`);

  const promises = queries.map(async (q, i) => {
    onProgress?.('search', `[${i + 1}/${queries.length}] 搜索: ${q.slice(0, 60)}`);
    return search(q, 8);
  });

  const responses = await Promise.allSettled(promises);
  const allResults: SearchResult[] = [];
  const validResponses: SearchResponse[] = [];

  for (const settled of responses) {
    if (settled.status === 'fulfilled' && settled.value.success) {
      allResults.push(...settled.value.results);
      validResponses.push(settled.value);
    }
  }

  // 去重 (按 URL)
  const seen = new Set<string>();
  const unique = allResults.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  onProgress?.('search', `搜索完成: ${unique.length} 条唯一结果 (来自 ${validResponses.length} 个引擎)`);
  return { allResults: unique, responses: validResponses };
}

// ═══════════════════════════════════════
// Deep Source Extraction
// ═══════════════════════════════════════

async function deepExtract(
  results: SearchResult[],
  count: number,
  onProgress?: ProgressCallback,
): Promise<Map<string, string>> {
  const topResults = results.slice(0, count);
  onProgress?.('extraction', `深度提取 ${topResults.length} 个页面...`);

  const extractions = new Map<string, string>();

  const promises = topResults.map(async (r) => {
    try {
      const read = await readUrl(r.url, 15000);
      if (read.success && read.content.length > 100) {
        extractions.set(r.url, read.content);
        onProgress?.('extraction', `✓ 已提取: ${r.title.slice(0, 50)}`);
      }
    } catch { /* silent: 单页提取失败,继续下一页 */
      // 单个提取失败不影响整体
    }
  });

  await Promise.allSettled(promises);
  onProgress?.('extraction', `深度提取完成: ${extractions.size}/${topResults.length} 成功`);
  return extractions;
}

// ═══════════════════════════════════════
// Synthesis — LLM 综合分析
// ═══════════════════════════════════════

interface SynthesisResult {
  report: string;
  keyFindings: string[];
  confidence: number;
  followUpQueries: string[];
  inputTokens: number;
  outputTokens: number;
}

async function synthesize(
  question: string,
  context: string,
  searchResults: SearchResult[],
  deepContent: Map<string, string>,
  round: number,
  previousFindings: string,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<SynthesisResult> {

  // 构建搜索结果摘要
  const resultsText = searchResults.slice(0, 15).map((r, i) => {
    const deep = deepContent.get(r.url);
    const content = deep ? deep.slice(0, 3000) : r.snippet;
    return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${content}`;
  }).join('\n\n---\n\n');

  const prompt = `You are a research analyst. Synthesize the search results into a comprehensive answer.

## Research Question
${question}

## Context
${context || '(none)'}

${previousFindings ? `## Previous Round Findings\n${previousFindings}\n` : ''}

## Search Results (Round ${round})
${resultsText.slice(0, 25000)}

## Instructions
1. Synthesize a comprehensive answer from the sources
2. Cross-reference facts across sources — note contradictions
3. Cite sources by [number] reference
4. Rate your confidence (0-100) based on source agreement and coverage
5. If gaps remain, suggest follow-up queries

## Output Format (JSON, no markdown code block)
{
  "report": "Detailed research report in Markdown...",
  "key_findings": ["finding 1", "finding 2", ...],
  "confidence": 75,
  "follow_up_queries": ["query if more research needed", ...]
}`;

  const result = await callLLM(settings, settings.strongModel, [
    { role: 'user', content: prompt },
  ], signal, 8192);

  try {
    const cleaned = result.content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      report: parsed.report || result.content,
      keyFindings: parsed.key_findings || [],
      confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
      followUpQueries: parsed.follow_up_queries || [],
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch { /* silent: synthesis LLM call failed */
    return {
      report: result.content,
      keyFindings: [],
      confidence: 40,
      followUpQueries: [],
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }
}

// ═══════════════════════════════════════
// Fact-Check — 关键结论验证
// ═══════════════════════════════════════

async function factCheck(
  keyFindings: string[],
  onProgress?: ProgressCallback,
): Promise<{ verified: number; total: number; details: string }> {
  if (keyFindings.length === 0) return { verified: 0, total: 0, details: '' };

  onProgress?.('fact-check', `验证 ${keyFindings.length} 个关键发现...`);

  const checkPromises = keyFindings.slice(0, 5).map(async (finding) => {
    const checkQuery = `verify: ${finding.slice(0, 100)}`;
    const result = await search(checkQuery, 3);
    const hasSupport = result.success && result.results.length > 0;
    return { finding, supported: hasSupport };
  });

  const checks = await Promise.allSettled(checkPromises);
  let verified = 0;
  const details: string[] = [];

  for (const check of checks) {
    if (check.status === 'fulfilled') {
      if (check.value.supported) {
        verified++;
        details.push(`✅ ${check.value.finding.slice(0, 80)}`);
      } else {
        details.push(`⚠️ ${check.value.finding.slice(0, 80)} (未找到佐证)`);
      }
    }
  }

  onProgress?.('fact-check', `验证完成: ${verified}/${keyFindings.length} 有佐证`);
  return { verified, total: keyFindings.length, details: details.join('\n') };
}

// ═══════════════════════════════════════
// Main Entry — deepResearch
// ═══════════════════════════════════════

/**
 * 执行深度研究。
 *
 * 完整流程:
 *   1. 将问题拆解为子查询
 *   2. 并行搜索
 *   3. 深度提取高价值页面
 *   4. LLM 综合分析
 *   5. (可选) 根据低置信结论进行第二轮搜索
 *   6. (可选) Fact-check 交叉验证
 *   7. 输出最终报告
 */
export async function deepResearch(
  request: ResearchRequest,
  settings: AppSettings,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<ResearchResult> {
  const totalStart = Date.now();
  const timing = { decomposition: 0, search: 0, extraction: 0, synthesis: 0, factCheck: 0, total: 0 };
  let totalInput = 0;
  let totalOutput = 0;

  // 解析深度
  const depth = request.depth || 'standard';
  const maxRounds = request.maxRounds ?? (depth === 'quick' ? 1 : depth === 'deep' ? 3 : 2);
  const maxQueries = request.maxQueries ?? (depth === 'quick' ? 2 : 4);
  const deepReadCount = request.deepReadCount ?? (depth === 'quick' ? 1 : 3);
  const doFactCheck = request.factCheck ?? (depth === 'deep');

  const allSources: ResearchSource[] = [];
  let currentReport = '';
  let currentFindings: string[] = [];
  let currentFollowUp: string[] = [];
  let currentConfidence = 0;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      onProgress?.('round', `=== 研究轮次 ${round}/${maxRounds} ===`);

      // ── Phase 1: Query Decomposition ──
      const decompStart = Date.now();
      let queries: string[];

      if (round === 1) {
        const decomp = await decomposeQuery(
          request.question, request.context || '', maxQueries, settings, signal,
        );
        queries = decomp.result.subQueries;
        totalInput += decomp.inputTokens;
        totalOutput += decomp.outputTokens;
        onProgress?.('decomposition', `已拆解为 ${queries.length} 个子查询:\n${queries.map((q, i) => `  ${i + 1}. ${q}`).join('\n')}`);
      } else {
        // 后续轮次: 优先使用前一轮的 follow-up queries (比 keyFindings 更精准)
        queries = currentFollowUp.length > 0
          ? currentFollowUp.slice(0, maxQueries)
          : currentFindings.length > 0
            ? currentFindings.slice(0, maxQueries).map(f => `${f} latest information`)
            : [request.question + ' additional details'];
        onProgress?.('decomposition', `追加查询: ${queries.length} 个`);
      }
      timing.decomposition += Date.now() - decompStart;

      // ── Phase 2: Parallel Search ──
      const searchStart = Date.now();
      const { allResults } = await parallelSearch(queries, onProgress);
      timing.search += Date.now() - searchStart;

      if (allResults.length === 0) {
        onProgress?.('search', `第 ${round} 轮搜索无结果`);
        if (round === 1) {
          return makeFailResult('搜索无结果。请检查搜索引擎配置或换一个问法。', timing, totalStart);
        }
        break; // 后续轮次无结果不算失败
      }

      // 记录来源
      for (const r of allResults) {
        if (!allSources.find(s => s.url === r.url)) {
          allSources.push({
            url: r.url,
            title: r.title,
            relevance: allSources.length < 5 ? 'high' : allSources.length < 10 ? 'medium' : 'low',
            deepRead: false,
          });
        }
      }

      // ── Phase 3: Deep Extraction ──
      const extractStart = Date.now();
      const deepContent = await deepExtract(allResults, deepReadCount, onProgress);
      timing.extraction += Date.now() - extractStart;

      // 标记已深度提取的来源
      for (const [url] of deepContent) {
        const source = allSources.find(s => s.url === url);
        if (source) source.deepRead = true;
      }

      // ── Phase 4: LLM Synthesis ──
      const synthStart = Date.now();
      onProgress?.('synthesis', `第 ${round} 轮综合分析中...`);

      const synthesis = await synthesize(
        request.question, request.context || '',
        allResults, deepContent,
        round, round > 1 ? currentReport : '',
        settings, signal,
      );
      timing.synthesis += Date.now() - synthStart;
      totalInput += synthesis.inputTokens;
      totalOutput += synthesis.outputTokens;

      currentReport = synthesis.report;
      currentFindings = synthesis.keyFindings;
      currentFollowUp = synthesis.followUpQueries;
      currentConfidence = synthesis.confidence;

      onProgress?.('synthesis', `置信度: ${synthesis.confidence}% | 关键发现: ${synthesis.keyFindings.length} 条`);

      // 如果置信度足够高, 提前结束
      if (synthesis.confidence >= 85 && round < maxRounds) {
        onProgress?.('round', `置信度 ${synthesis.confidence}% >= 85%, 提前结束多轮搜索`);
        break;
      }

      // 如果没有 follow-up queries, 也不必继续
      if (synthesis.followUpQueries.length === 0 && round < maxRounds) {
        onProgress?.('round', `无追加查询, 结束多轮搜索`);
        break;
      }
    }

    // ── Phase 5: Fact-Check ──
    if (doFactCheck && currentFindings.length > 0) {
      const fcStart = Date.now();
      const fc = await factCheck(currentFindings, onProgress);
      timing.factCheck = Date.now() - fcStart;

      // 调整置信度
      if (fc.total > 0) {
        const verifyRate = fc.verified / fc.total;
        if (verifyRate < 0.5) {
          currentConfidence = Math.max(20, currentConfidence - 20);
          currentReport += `\n\n## ⚠️ 事实核查\n验证率: ${Math.round(verifyRate * 100)}% (${fc.verified}/${fc.total})\n${fc.details}\n\n> 置信度因低验证率下调至 ${currentConfidence}%`;
        } else {
          currentReport += `\n\n## ✅ 事实核查\n验证率: ${Math.round(verifyRate * 100)}% (${fc.verified}/${fc.total})\n${fc.details}`;
        }
      }
    }

    // ── Build Final Report ──
    const sourcesSection = allSources
      .filter(s => s.relevance !== 'low')
      .map((s, i) => `${i + 1}. [${s.title.slice(0, 60)}](${s.url})${s.deepRead ? ' 📖' : ''}`)
      .join('\n');

    const finalReport = [
      currentReport,
      '',
      `## 参考来源 (${allSources.length} 条)`,
      sourcesSection,
    ].join('\n');

    timing.total = Date.now() - totalStart;

    return {
      success: true,
      report: finalReport,
      sources: allSources,
      keyFindings: currentFindings,
      confidence: currentConfidence,
      timing,
      tokenUsage: { input: totalInput, output: totalOutput },
    };

  } catch (err: unknown) {
    timing.total = Date.now() - totalStart;
    return makeFailResult(
      err instanceof Error ? err.message : String(err),
      timing, totalStart,
    );
  }
}

function makeFailResult(error: string, timing: ResearchResult['timing'], totalStart: number): ResearchResult {
  timing.total = Date.now() - totalStart;
  return {
    success: false,
    report: '',
    sources: [],
    keyFindings: [],
    confidence: 0,
    timing,
    tokenUsage: { input: 0, output: 0 },
    error,
  };
}
