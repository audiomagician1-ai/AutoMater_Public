/**
 * Tool Result Summarizer — 工具输出智能摘要器
 *
 * 对标问题: 大型工具输出（搜索结果、文件内容、测试输出、命令输出）直接塞入 context，
 * 浪费 token 且降低 Agent 理解力。
 *
 * 策略: 根据工具类型进行结构化摘要，保留决策关键信息，裁剪冗余。
 *   - search_files / code_search → 按文件分组，去重，保留最相关匹配
 *   - read_file / read_many_files → 保留 import/export/签名，折叠函数体
 *   - run_command / run_test / run_lint → 提取错误+摘要+退出状态
 *   - web_search → 提取标题+snippet+URL，去重近似结果
 *   - browser_snapshot → 提取交互元素（按钮/链接/输入框），折叠纯文本
 *
 * v1.0 — 2026-03-02
 */

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SummaryOptions {
  /** 最大输出字符数 (token 的 ~1.5x) */
  maxChars?: number;
  /** 工具执行是否成功 */
  success?: boolean;
  /** 当前 context 预算紧张程度: normal/warning/critical/overflow */
  budgetStatus?: 'normal' | 'warning' | 'critical' | 'overflow';
}

export interface SummaryResult {
  /** 摘要后的文本 */
  text: string;
  /** 原始长度 (字符) */
  originalLength: number;
  /** 摘要后长度 (字符) */
  summarizedLength: number;
  /** 压缩率 (0-1, 0=无压缩) */
  compressionRatio: number;
  /** 是否进行了摘要 (false = 原文返回) */
  wasSummarized: boolean;
}

// ═══════════════════════════════════════
// Budget-aware character limits
// ═══════════════════════════════════════

function getCharLimit(toolName: string, options: SummaryOptions): number {
  if (options.maxChars) return options.maxChars;

  // 基准限制 (根据 budget 状态调整)
  const budgetMultiplier: Record<string, number> = {
    normal: 1.0,
    warning: 0.7,
    critical: 0.4,
    overflow: 0.2,
  };
  const mult = budgetMultiplier[options.budgetStatus || 'normal'] ?? 1.0;

  // 不同工具类型的基准字符限制
  const baseLimits: Record<string, number> = {
    // 搜索类 — 结果较碎，压缩收益大
    search_files: 4000,
    code_search: 4000,
    web_search: 3000,
    web_search_boost: 3000,
    deep_research: 8000,  // 研究结果要保留更多
    fetch_url: 4000,

    // 文件读取类 — 代码可压缩
    read_file: 6000,
    read_many_files: 5000,
    repo_map: 6000,
    code_graph_query: 4000,

    // 命令执行类 — 关注错误
    run_command: 4000,
    run_test: 5000,
    run_lint: 4000,

    // 浏览器类 — a11y 树很长
    browser_snapshot: 3000,
    browser_network: 2000,
    browser_console: 2000,
  };

  const base = baseLimits[toolName] ?? 4000;
  return Math.max(500, Math.floor(base * mult));
}

// ═══════════════════════════════════════
// Main Entry
// ═══════════════════════════════════════

/**
 * 对工具输出进行智能摘要
 * 
 * @param toolName 工具名称
 * @param output   工具原始输出
 * @param options  摘要选项
 * @returns        摘要结果
 */
export function summarizeToolResult(
  toolName: string,
  output: string,
  options: SummaryOptions = {},
): SummaryResult {
  const maxChars = getCharLimit(toolName, options);

  // 短输出直接返回
  if (output.length <= maxChars) {
    return {
      text: output,
      originalLength: output.length,
      summarizedLength: output.length,
      compressionRatio: 0,
      wasSummarized: false,
    };
  }

  // 根据工具类型选择摘要策略
  let summarized: string;

  if (toolName === 'search_files' || toolName === 'code_search' || toolName === 'code_search_files') {
    summarized = summarizeCodeSearchResult(output, maxChars);
  } else if (toolName === 'read_file' || toolName === 'read_many_files') {
    summarized = summarizeFileContent(output, maxChars);
  } else if (toolName === 'run_command' || toolName === 'run_test' || toolName === 'run_lint') {
    summarized = summarizeCommandOutput(output, maxChars, options.success);
  } else if (toolName === 'web_search' || toolName === 'web_search_boost') {
    summarized = summarizeWebSearchResult(output, maxChars);
  } else if (toolName === 'deep_research') {
    summarized = summarizeResearchResult(output, maxChars);
  } else if (toolName === 'fetch_url') {
    summarized = summarizeWebPage(output, maxChars);
  } else if (toolName === 'browser_snapshot') {
    summarized = summarizeBrowserSnapshot(output, maxChars);
  } else if (toolName === 'browser_network' || toolName === 'browser_console') {
    summarized = summarizeBrowserDiagnostics(output, maxChars);
  } else if (toolName === 'repo_map') {
    summarized = summarizeRepoMap(output, maxChars);
  } else {
    // 通用策略: head + errors + tail
    summarized = summarizeGeneric(output, maxChars);
  }

  return {
    text: summarized,
    originalLength: output.length,
    summarizedLength: summarized.length,
    compressionRatio: 1 - (summarized.length / output.length),
    wasSummarized: true,
  };
}

// ═══════════════════════════════════════
// Strategy: Code Search Results
// ═══════════════════════════════════════

function summarizeCodeSearchResult(output: string, maxChars: number): string {
  const lines = output.split('\n');

  // 解析搜索结果块: "文件名:行号: 内容" 格式
  interface Match {
    file: string;
    line: number;
    content: string;
  }

  const matches: Match[] = [];
  const headerLines: string[] = []; // 非匹配行 (如引擎信息, 总计行)

  for (const line of lines) {
    // ripgrep JSON 或格式化输出: "path/to/file.ts:42: matched content"
    const m = line.match(/^(.+?):(\d+):\s*(.*)$/);
    if (m) {
      matches.push({ file: m[1], line: parseInt(m[2], 10), content: m[3].trim() });
    } else if (line.trim()) {
      headerLines.push(line);
    }
  }

  if (matches.length === 0) {
    // 非标准格式，fallback
    return summarizeGeneric(output, maxChars);
  }

  // 按文件分组
  const byFile = new Map<string, Match[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file) || [];
    existing.push(match);
    byFile.set(match.file, existing);
  }

  // 构建摘要
  const parts: string[] = [];

  // 保留 header (总计/引擎信息)
  for (const h of headerLines.slice(0, 3)) {
    parts.push(h);
  }
  parts.push(`📊 ${matches.length} 匹配 / ${byFile.size} 文件`);
  parts.push('');

  let charCount = parts.join('\n').length;
  const perFileBudget = Math.floor((maxChars - charCount) / Math.max(byFile.size, 1));

  for (const [file, fileMatches] of byFile) {
    if (charCount >= maxChars - 100) {
      parts.push(`... [还有 ${byFile.size - parts.filter(p => p.startsWith('📄')).length} 个文件省略]`);
      break;
    }

    const fileHeader = `📄 ${file} (${fileMatches.length} 匹配)`;
    parts.push(fileHeader);
    charCount += fileHeader.length + 1;

    // 每个文件最多显示 perFileBudget 字符的匹配内容
    let fileChars = 0;
    const shownCount = Math.min(fileMatches.length, 5); // 每文件最多5条
    for (let i = 0; i < shownCount; i++) {
      const matchLine = `  L${fileMatches[i].line}: ${fileMatches[i].content.slice(0, 120)}`;
      if (fileChars + matchLine.length > perFileBudget) break;
      parts.push(matchLine);
      fileChars += matchLine.length + 1;
      charCount += matchLine.length + 1;
    }
    if (fileMatches.length > shownCount) {
      const note = `  ... +${fileMatches.length - shownCount} more`;
      parts.push(note);
      charCount += note.length + 1;
    }
    parts.push('');
  }

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: File Content
// ═══════════════════════════════════════

function summarizeFileContent(output: string, maxChars: number): string {
  const lines = output.split('\n');
  if (lines.length <= 50) return output.slice(0, maxChars);

  const important: string[] = [];
  const rest: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // 保留: import, export, function/class/interface 签名, 关键注释, 类型定义
    if (/^(import |export |\/\*\*|\/\/ ={3,}|\/\/ -{3,})/.test(trimmed) ||
        /^(export )?(default )?(function|class|interface|type|enum|const|let|var)\s/.test(trimmed) ||
        /^(describe|it|test|beforeEach|afterEach)\(/.test(trimmed) ||
        /^#/.test(trimmed) || // markdown headers
        /^\*/.test(trimmed) || // JSDoc
        trimmed === '{' || trimmed === '}' || trimmed === '') {
      important.push(line);
    } else {
      rest.push(line);
    }
  }

  // 先放重要行，预算剩余放其他行
  const parts: string[] = [];
  let charCount = 0;
  const importantBudget = Math.floor(maxChars * 0.7);
  const restBudget = maxChars - importantBudget;

  for (const line of important) {
    if (charCount + line.length + 1 > importantBudget) {
      parts.push(`... [省略 ${important.length - parts.length} 行签名/导入]`);
      break;
    }
    parts.push(line);
    charCount += line.length + 1;
  }

  if (rest.length > 0) {
    parts.push('');
    parts.push(`--- 函数体/实现 (${rest.length} 行, 已折叠) ---`);
    // 放少量 rest 行作为样本
    let restChars = 0;
    for (const line of rest.slice(0, 20)) {
      if (restChars + line.length + 1 > restBudget) break;
      parts.push(line);
      restChars += line.length + 1;
    }
    if (rest.length > 20) {
      parts.push(`... +${rest.length - 20} 行实现代码`);
    }
  }

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: Command / Test / Lint Output
// ═══════════════════════════════════════

function summarizeCommandOutput(output: string, maxChars: number, success?: boolean): string {
  const lines = output.split('\n');

  // 分类行
  const errorLines: string[] = [];
  const warningLines: string[] = [];
  const summaryLines: string[] = [];
  const otherLines: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/error|fail|❌|✗|✘|panic|fatal|exception/i.test(line)) {
      errorLines.push(line);
    } else if (/warn|⚠|deprecat/i.test(line)) {
      warningLines.push(line);
    } else if (/pass|✓|✔|✅|succ|total|summar|test files|tests |duration|exit/i.test(line)) {
      summaryLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  const parts: string[] = [];
  let charCount = 0;

  // 1. 总结行 (最高优先)
  if (summaryLines.length > 0) {
    parts.push('── 摘要 ──');
    for (const line of summaryLines.slice(0, 10)) {
      parts.push(line);
      charCount += line.length + 1;
    }
    parts.push('');
  }

  // 2. 错误行
  if (errorLines.length > 0) {
    parts.push(`── 错误 (${errorLines.length}) ──`);
    const errorBudget = Math.floor((maxChars - charCount) * (success === false ? 0.6 : 0.3));
    let errorChars = 0;
    for (const line of errorLines) {
      if (errorChars + line.length + 1 > errorBudget) {
        parts.push(`... +${errorLines.length - parts.filter(p => !p.startsWith('──')).length} 错误行`);
        break;
      }
      parts.push(line);
      errorChars += line.length + 1;
    }
    charCount += errorChars;
    parts.push('');
  }

  // 3. 警告行 (预算允许时)
  if (warningLines.length > 0 && charCount < maxChars * 0.7) {
    parts.push(`── 警告 (${warningLines.length}) ──`);
    for (const line of warningLines.slice(0, 5)) {
      if (charCount + line.length + 1 > maxChars * 0.85) break;
      parts.push(line);
      charCount += line.length + 1;
    }
    if (warningLines.length > 5) parts.push(`... +${warningLines.length - 5} 警告`);
    parts.push('');
  }

  // 4. 其他输出 (仅在预算充裕时)
  if (otherLines.length > 0 && charCount < maxChars * 0.6) {
    const remaining = maxChars - charCount - 50;
    let otherChars = 0;
    for (const line of otherLines) {
      if (otherChars + line.length + 1 > remaining) break;
      parts.push(line);
      otherChars += line.length + 1;
    }
    if (otherLines.length > 0 && otherChars < otherLines.join('\n').length) {
      parts.push(`... [${otherLines.length} 行输出, 已折叠]`);
    }
  }

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: Web Search Results
// ═══════════════════════════════════════

function summarizeWebSearchResult(output: string, maxChars: number): string {
  const lines = output.split('\n');

  // 尝试解析搜索结果块: 标题 + URL + snippet
  interface SearchEntry {
    title: string;
    url: string;
    snippet: string;
  }
  const entries: SearchEntry[] = [];
  let currentEntry: Partial<SearchEntry> = {};
  const headerLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentEntry.title) {
        entries.push({
          title: currentEntry.title || '',
          url: currentEntry.url || '',
          snippet: currentEntry.snippet || '',
        });
        currentEntry = {};
      }
      continue;
    }

    // URL 检测
    if (/^https?:\/\//.test(trimmed)) {
      currentEntry.url = trimmed;
    }
    // 标题检测 (通常是第一个非 URL 非空行)
    else if (!currentEntry.title && trimmed.length < 200 && !/^\d+\./.test(trimmed)) {
      currentEntry.title = trimmed;
    }
    // 数字编号的标题: "1. Title"
    else if (/^\d+\.\s/.test(trimmed) && !currentEntry.title) {
      currentEntry.title = trimmed;
    }
    // 其余为 snippet
    else {
      currentEntry.snippet = (currentEntry.snippet ? currentEntry.snippet + ' ' : '') + trimmed;
    }

    // header 信息 (非搜索结果块)
    if (entries.length === 0 && !currentEntry.title && /搜索|search|results?|found/i.test(trimmed)) {
      headerLines.push(trimmed);
    }
  }
  // 最后一个条目
  if (currentEntry.title) {
    entries.push({
      title: currentEntry.title || '',
      url: currentEntry.url || '',
      snippet: currentEntry.snippet || '',
    });
  }

  if (entries.length === 0) return summarizeGeneric(output, maxChars);

  // 去重 (相同 URL 或高度相似标题)
  const deduped: SearchEntry[] = [];
  const seenUrls = new Set<string>();
  for (const entry of entries) {
    const urlKey = entry.url.replace(/^https?:\/\/(www\.)?/, '').split('?')[0];
    if (urlKey && seenUrls.has(urlKey)) continue;
    if (urlKey) seenUrls.add(urlKey);
    deduped.push(entry);
  }

  const parts: string[] = [];
  for (const h of headerLines.slice(0, 2)) parts.push(h);
  parts.push(`📊 ${deduped.length} 结果 (原始 ${entries.length})`);
  parts.push('');

  let charCount = parts.join('\n').length;
  const perEntryBudget = Math.floor((maxChars - charCount) / Math.max(deduped.length, 1));

  for (let i = 0; i < deduped.length; i++) {
    if (charCount >= maxChars - 50) {
      parts.push(`... +${deduped.length - i} 结果省略`);
      break;
    }
    const e = deduped[i];
    const snippetMax = Math.max(perEntryBudget - e.title.length - (e.url?.length || 0) - 20, 50);
    const snippet = e.snippet.length > snippetMax ? e.snippet.slice(0, snippetMax) + '...' : e.snippet;
    const block = `${i + 1}. ${e.title}${e.url ? `\n   ${e.url}` : ''}${snippet ? `\n   ${snippet}` : ''}`;
    parts.push(block);
    charCount += block.length + 1;
  }

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: Research Result
// ═══════════════════════════════════════

function summarizeResearchResult(output: string, maxChars: number): string {
  // 研究结果已经是结构化的，保留大部分内容但压缩引用和源信息
  if (output.length <= maxChars) return output;

  const lines = output.split('\n');
  const parts: string[] = [];
  let charCount = 0;
  let inSourceSection = false;

  for (const line of lines) {
    // 检测引用/来源章节
    if (/^(##?\s*(来源|引用|参考|sources|references|citations))/i.test(line.trim())) {
      inSourceSection = true;
      parts.push(line);
      charCount += line.length + 1;
      continue;
    }

    if (inSourceSection) {
      // 来源章节只保留 URL 行
      if (/https?:\/\//.test(line)) {
        if (charCount + line.length + 1 < maxChars - 100) {
          parts.push(line);
          charCount += line.length + 1;
        }
      }
      continue;
    }

    if (charCount + line.length + 1 > maxChars - 200) {
      parts.push('... [研究报告后续内容已折叠]');
      break;
    }
    parts.push(line);
    charCount += line.length + 1;
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════
// Strategy: Web Page Content
// ═══════════════════════════════════════

function summarizeWebPage(output: string, maxChars: number): string {
  const lines = output.split('\n');

  // 过滤掉纯空行、CSS/JS 碎片、导航菜单等
  const meaningful: string[] = [];
  const navigation: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过 CSS/JS 碎片
    if (/^[{}[\]();]$/.test(trimmed)) continue;
    if (/^(var |let |const |function|\.[\w-]+\s*\{|@media)/.test(trimmed)) continue;
    // 跳过极短的导航链接行
    if (trimmed.length < 5 && !/[.!?。！？]$/.test(trimmed)) {
      navigation.push(trimmed);
      continue;
    }
    meaningful.push(line);
  }

  // 对有意义的行进行头部+尾部保留
  if (meaningful.join('\n').length <= maxChars) {
    return meaningful.join('\n');
  }

  const headBudget = Math.floor(maxChars * 0.75);
  const tailBudget = maxChars - headBudget - 50;

  const head: string[] = [];
  let headChars = 0;
  for (const line of meaningful) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
  }

  const tail: string[] = [];
  let tailChars = 0;
  for (let i = meaningful.length - 1; i >= 0; i--) {
    if (tailChars + meaningful[i].length + 1 > tailBudget) break;
    tail.unshift(meaningful[i]);
    tailChars += meaningful[i].length + 1;
  }

  return [
    ...head,
    '',
    `... [省略 ${meaningful.length - head.length - tail.length} 行]`,
    '',
    ...tail,
  ].join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: Browser Snapshot (a11y tree)
// ═══════════════════════════════════════

function summarizeBrowserSnapshot(output: string, maxChars: number): string {
  const lines = output.split('\n');

  // 按优先级分类 a11y 元素
  const interactive: string[] = [];  // 按钮、链接、输入框
  const headings: string[] = [];     // 标题
  const structure: string[] = [];    // 其他
  const pure_text: string[] = [];    // 纯文本

  for (const line of lines) {
    const trimmed = line.trim();
    if (/\b(button|link|textbox|combobox|checkbox|radio|slider|tab|menuitem)\b/i.test(trimmed)) {
      interactive.push(line);
    } else if (/\b(heading|banner|navigation|main|complementary)\b/i.test(trimmed)) {
      headings.push(line);
    } else if (/\b(group|list|listitem|region|article|section)\b/i.test(trimmed)) {
      structure.push(line);
    } else if (trimmed) {
      pure_text.push(line);
    }
  }

  const parts: string[] = [];
  parts.push(`🌐 页面元素: ${interactive.length} 交互 / ${headings.length} 标题 / ${structure.length} 结构 / ${pure_text.length} 文本`);
  parts.push('');

  let charCount = parts.join('\n').length;

  // 1. 交互元素 (最高优先)
  if (interactive.length > 0) {
    parts.push('── 交互元素 ──');
    for (const line of interactive) {
      if (charCount + line.length + 1 > maxChars * 0.5) {
        parts.push(`... +${interactive.length - parts.filter(p => !p.startsWith('──') && !p.startsWith('🌐')).length} 交互元素`);
        break;
      }
      parts.push(line);
      charCount += line.length + 1;
    }
    parts.push('');
  }

  // 2. 标题/结构 
  if (headings.length > 0 && charCount < maxChars * 0.7) {
    parts.push('── 页面结构 ──');
    for (const line of headings.slice(0, 15)) {
      if (charCount + line.length + 1 > maxChars * 0.8) break;
      parts.push(line);
      charCount += line.length + 1;
    }
    parts.push('');
  }

  // 3. 结构元素 (如有预算)
  if (structure.length > 0 && charCount < maxChars * 0.85) {
    for (const line of structure.slice(0, 10)) {
      if (charCount + line.length + 1 > maxChars - 50) break;
      parts.push(line);
      charCount += line.length + 1;
    }
  }

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: Browser Diagnostics (network/console)
// ═══════════════════════════════════════

function summarizeBrowserDiagnostics(output: string, maxChars: number): string {
  const lines = output.split('\n');

  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  for (const line of lines) {
    if (/error|ERR|fail|404|500|403|401/i.test(line)) {
      errors.push(line);
    } else if (/warn/i.test(line)) {
      warnings.push(line);
    } else {
      info.push(line);
    }
  }

  const parts: string[] = [];
  parts.push(`📊 ${errors.length} 错误 / ${warnings.length} 警告 / ${info.length} 信息`);

  let charCount = parts[0].length;

  if (errors.length > 0) {
    parts.push('');
    parts.push('── 错误 ──');
    for (const line of errors.slice(0, 20)) {
      if (charCount + line.length > maxChars * 0.6) break;
      parts.push(line);
      charCount += line.length + 1;
    }
  }

  if (warnings.length > 0 && charCount < maxChars * 0.7) {
    parts.push('');
    parts.push('── 警告 ──');
    for (const line of warnings.slice(0, 10)) {
      if (charCount + line.length > maxChars * 0.85) break;
      parts.push(line);
      charCount += line.length + 1;
    }
  }

  // 信息行只在预算充裕时显示
  if (info.length > 0 && charCount < maxChars * 0.5) {
    parts.push('');
    for (const line of info.slice(0, 15)) {
      if (charCount + line.length > maxChars - 50) break;
      parts.push(line);
      charCount += line.length + 1;
    }
    if (info.length > 15) parts.push(`... +${info.length - 15} 行信息`);
  }

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Strategy: Repo Map
// ═══════════════════════════════════════

function summarizeRepoMap(output: string, maxChars: number): string {
  const lines = output.split('\n');

  // Repo map 保留文件结构但折叠函数列表
  const parts: string[] = [];
  let charCount = 0;
  let functionsInCurrentFile = 0;
  const MAX_FUNCTIONS_PER_FILE = 10;

  for (const line of lines) {
    // 检测文件头部行 (通常有特定格式)
    const isFileHeader = /^[─═│┌└├┬┤]/.test(line) || /^\S.*\.(ts|js|py|go|rs|java|cpp|c|h)/.test(line.trim());

    if (isFileHeader) {
      functionsInCurrentFile = 0;
    } else {
      functionsInCurrentFile++;
    }

    if (functionsInCurrentFile > MAX_FUNCTIONS_PER_FILE) {
      if (functionsInCurrentFile === MAX_FUNCTIONS_PER_FILE + 1) {
        parts.push('    ... (更多函数省略)');
        charCount += 25;
      }
      continue;
    }

    if (charCount + line.length + 1 > maxChars - 50) {
      parts.push(`... [repo map 后续内容省略]`);
      break;
    }

    parts.push(line);
    charCount += line.length + 1;
  }

  return parts.join('\n');
}

// ═══════════════════════════════════════
// Strategy: Generic (fallback)
// ═══════════════════════════════════════

function summarizeGeneric(output: string, maxChars: number): string {
  const lines = output.split('\n');

  // 分离: 错误行、摘要行、其他
  const errorLines: string[] = [];
  const otherLines: string[] = [];

  for (const line of lines) {
    if (/error|fail|exception|panic|fatal/i.test(line)) {
      errorLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  // 预算: 错误 30%, 头部 50%, 尾部 20%
  const errorBudget = errorLines.length > 0 ? Math.floor(maxChars * 0.3) : 0;
  const headBudget = Math.floor((maxChars - errorBudget) * 0.7);
  const tailBudget = maxChars - errorBudget - headBudget;

  const head: string[] = [];
  let headChars = 0;
  for (const line of otherLines) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
  }

  const tail: string[] = [];
  let tailChars = 0;
  for (let i = otherLines.length - 1; i >= 0; i--) {
    if (tailChars + otherLines[i].length + 1 > tailBudget) break;
    tail.unshift(otherLines[i]);
    tailChars += otherLines[i].length + 1;
  }

  const parts = [...head, '', `... [省略 ${otherLines.length - head.length - tail.length} 行]`, ''];

  if (errorLines.length > 0) {
    parts.push('── 错误 ──');
    let errorChars = 0;
    for (const line of errorLines) {
      if (errorChars + line.length + 1 > errorBudget) {
        parts.push(`... +${errorLines.length} 错误行`);
        break;
      }
      parts.push(line);
      errorChars += line.length + 1;
    }
    parts.push('');
  }

  parts.push(...tail);

  return parts.join('\n').slice(0, maxChars);
}

// ═══════════════════════════════════════
// Batch summarizer for message history
// ═══════════════════════════════════════

/**
 * 对消息历史中所有 tool result 进行批量摘要
 * 适用于 context 预算紧张时对历史 tool outputs 进行压缩
 *
 * @param messages  LLM 消息列表 (会被原地修改)
 * @param budgetStatus 当前预算状态
 * @returns 压缩统计
 */
export function summarizeHistoryToolOutputs(
  messages: Array<{ role: string; content: string | unknown; tool_call_id?: string }>,
  budgetStatus: 'normal' | 'warning' | 'critical' | 'overflow' = 'warning',
): { toolsSummarized: number; charsSaved: number } {
  let toolsSummarized = 0;
  let charsSaved = 0;

  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (msg.content.length < 500) continue; // 短输出跳过

    // 从 tool_call_id 或内容推测工具名
    const toolName = guessToolName(msg.content);
    const result = summarizeToolResult(toolName, msg.content, { budgetStatus });

    if (result.wasSummarized) {
      const saved = msg.content.length - result.text.length;
      msg.content = result.text;
      toolsSummarized++;
      charsSaved += saved;
    }
  }

  return { toolsSummarized, charsSaved };
}

/**
 * 从工具输出内容推测工具名 (当 tool_call_id 不可用时)
 */
function guessToolName(content: string): string {
  const prefix = content.slice(0, 500).toLowerCase();

  if (/^\d+\.\s.*https?:\/\//.test(content)) return 'web_search';
  if (/ripgrep|rg |matches?.*files?/i.test(prefix)) return 'code_search';
  if (/^(button|link|heading|textbox|navigation)/im.test(prefix)) return 'browser_snapshot';
  if (/exit[= ]?\d|pass|fail.*test/i.test(prefix)) return 'run_test';
  if (/\[run_command\]|\[run_test\]|\[run_lint\]/i.test(prefix)) return prefix.includes('test') ? 'run_test' : 'run_command';
  if (/^import |^export |^(function|class|interface|const|let|var)\s/m.test(content.slice(0, 300))) return 'read_file';
  if (/^\s*[├│└─]/.test(prefix)) return 'repo_map';
  if (/\berror\b.*\bline\b.*\bcol\b/i.test(prefix)) return 'run_lint';
  if (/^https?:\/\/|^<html|^<!DOCTYPE/i.test(prefix)) return 'fetch_url';
  if (/研究|synthesis|query decomposition|findings/i.test(prefix)) return 'deep_research';

  return 'unknown';
}
