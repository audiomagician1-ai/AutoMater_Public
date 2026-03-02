/**
 * Code Search — 高性能代码搜索引擎
 *
 * 基于 ripgrep (rg) 实现，对标 EchoAgent 的 code-search_grep / code-search_read_many_files。
 * 当 ripgrep 不可用时自动降级到 PowerShell Select-String (Windows) 或 grep (Unix)。
 *
 * 工具:
 *   - code_search:       ripgrep 正则内容搜索，支持文件过滤和 .gitignore
 *   - code_search_files: 文件名 glob 搜索
 *   - read_many_files:   批量 glob 读取多文件，拼接返回
 *   - repo_map:          生成代码结构索引（函数/类/接口签名）
 *   - code_graph_query:  查询 import/export 依赖图
 *
 * v1.0 — 2026-03-02
 */

import { execSync, spawnSync, exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { generateRepoMap } from './repo-map';
import { buildCodeGraph, traverseGraph, graphSummary, type CodeGraph } from './code-graph';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
  engine: 'ripgrep' | 'fallback';
  durationMs: number;
}

export interface FileSearchResult {
  files: string[];
  totalFound: number;
  truncated: boolean;
}

export interface ReadManyResult {
  files: Array<{ path: string; content: string; lines: number }>;
  totalFiles: number;
  totalLines: number;
  truncated: boolean;
}

// ═══════════════════════════════════════
// Engine Detection
// ═══════════════════════════════════════

let _rgAvailable: boolean | null = null;
let _rgPath: string = 'rg';

function isRipgrepAvailable(): boolean {
  if (_rgAvailable !== null) return _rgAvailable;
  try {
    const result = spawnSync('rg', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    _rgAvailable = result.status === 0;
    if (_rgAvailable) {
      // 尝试获取完整路径
      if (process.platform === 'win32') {
        const where = spawnSync('where', ['rg'], { encoding: 'utf-8', timeout: 3000 });
        if (where.status === 0 && where.stdout.trim()) {
          _rgPath = where.stdout.trim().split('\n')[0].trim();
        }
      }
    }
  } catch { /* silent: ripgrep执行失败,降级搜索 */
    _rgAvailable = false;
  }
  return _rgAvailable;
}

// ═══════════════════════════════════════
// Core: Content Search
// ═══════════════════════════════════════

/**
 * 在工作区中搜索匹配正则的内容
 *
 * @param workspacePath 工作区根目录
 * @param pattern       正则表达式 (ripgrep 语法)
 * @param options       搜索选项
 */
export function codeSearch(
  workspacePath: string,
  pattern: string,
  options: {
    include?: string[];          // 文件过滤: ['*.ts', '*.py']
    exclude?: string[];          // 排除模式: ['*.test.ts']
    context?: number;            // 上下文行数，默认 2
    maxResults?: number;         // 最多返回结果数，默认 50
    caseSensitive?: boolean;     // 区分大小写，默认 false
    respectGitignore?: boolean;  // 遵守 .gitignore，默认 true
    fixedString?: boolean;       // 固定字符串搜索（非正则），默认 false
    wholeWord?: boolean;         // 全词匹配，默认 false
  } = {},
): SearchResult {
  const start = Date.now();
  const ctx = options.context ?? 2;
  const maxResults = options.maxResults ?? 50;

  if (isRipgrepAvailable()) {
    return ripgrepSearch(workspacePath, pattern, { ...options, context: ctx, maxResults }, start);
  }
  return fallbackSearch(workspacePath, pattern, { ...options, context: ctx, maxResults }, start);
}

function ripgrepSearch(
  workspacePath: string,
  pattern: string,
  options: {
    include?: string[];
    exclude?: string[];
    context: number;
    maxResults: number;
    caseSensitive?: boolean;
    respectGitignore?: boolean;
    fixedString?: boolean;
    wholeWord?: boolean;
  },
  startTime: number,
): SearchResult {
  const args: string[] = [
    '--json',                         // JSON 结构化输出
    '-C', String(options.context),    // 上下文行
    '-m', '5',                        // 每文件最多5行匹配
    '--max-filesize', '1M',           // 跳过 >1MB 文件
  ];

  if (!options.caseSensitive) args.push('-i');
  if (options.fixedString) args.push('-F');
  if (options.wholeWord) args.push('-w');
  if (options.respectGitignore === false) args.push('--no-ignore');

  // 文件类型过滤
  if (options.include && options.include.length > 0) {
    for (const glob of options.include) {
      args.push('-g', glob);
    }
  }

  // 排除模式
  const defaultExcludes = ['node_modules', '.git', 'dist', '__pycache__', '.next', 'coverage'];
  for (const exc of defaultExcludes) {
    args.push('-g', `!${exc}`);
  }
  if (options.exclude) {
    for (const exc of options.exclude) {
      args.push('-g', `!${exc}`);
    }
  }

  args.push('--', pattern, '.');

  try {
    const result = spawnSync(_rgPath, args, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
    });

    // rg exit code 1 = no match (not an error)
    if (result.status !== 0 && result.status !== 1) {
      // 真正的错误，降级
      return fallbackSearch(workspacePath, pattern, options, startTime);
    }

    const stdout = result.stdout || '';
    return parseRipgrepJson(stdout, options.maxResults, startTime);
  } catch { /* silent: ripgrep JSON解析失败 */
    return fallbackSearch(workspacePath, pattern, options, startTime);
  }
}

interface RgJsonLine {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
    submatches?: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

function parseRipgrepJson(stdout: string, maxResults: number, startTime: number): SearchResult {
  const matches: SearchMatch[] = [];
  const contextBuffer = new Map<string, { before: string[]; after: string[] }>();
  let totalMatches = 0;

  const lines = stdout.split('\n').filter(l => l.trim());

  // 分组: 按 file + line_number 整理匹配和上下文
  type PendingMatch = {
    file: string;
    line: number;
    content: string;
    contextBefore: string[];
    contextAfter: string[];
  };

  const pendingByFile = new Map<string, PendingMatch[]>();
  let currentFile = '';
  let lastMatchIdx = -1;

  for (const raw of lines) {
    let parsed: RgJsonLine;
    try { parsed = JSON.parse(raw); } catch { continue; }

    if (parsed.type === 'match' && parsed.data) {
      totalMatches++;
      if (totalMatches > maxResults) continue;

      const file = parsed.data.path?.text || '';
      const lineNum = parsed.data.line_number || 0;
      const text = (parsed.data.lines?.text || '').replace(/\n$/, '');

      const match: PendingMatch = {
        file: file.replace(/\\/g, '/'),
        line: lineNum,
        content: text,
        contextBefore: [],
        contextAfter: [],
      };

      if (!pendingByFile.has(match.file)) pendingByFile.set(match.file, []);
      pendingByFile.get(match.file)!.push(match);
      currentFile = match.file;
      lastMatchIdx = pendingByFile.get(match.file)!.length - 1;

    } else if (parsed.type === 'context' && parsed.data && totalMatches <= maxResults) {
      const file = (parsed.data.path?.text || '').replace(/\\/g, '/');
      const lineNum = parsed.data.line_number || 0;
      const text = (parsed.data.lines?.text || '').replace(/\n$/, '');
      const group = pendingByFile.get(file);
      if (group && group.length > 0) {
        const lastMatch = group[group.length - 1];
        if (lineNum < lastMatch.line) {
          lastMatch.contextBefore.push(text);
        } else {
          lastMatch.contextAfter.push(text);
        }
      }
    }
  }

  // 展平
  for (const [, group] of pendingByFile) {
    for (const m of group) {
      matches.push(m);
    }
  }

  return {
    matches,
    totalMatches,
    truncated: totalMatches > maxResults,
    engine: 'ripgrep',
    durationMs: Date.now() - startTime,
  };
}

function fallbackSearch(
  workspacePath: string,
  pattern: string,
  options: {
    include?: string[];
    context: number;
    maxResults: number;
    caseSensitive?: boolean;
  },
  startTime: number,
): SearchResult {
  try {
    const cmd = buildFallbackCmd(pattern, options);

    const rawOutput = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20000,
    });

    const matches = parseFallbackOutput(rawOutput, workspacePath, options.maxResults);

    return {
      matches,
      totalMatches: matches.length,
      truncated: false,
      engine: 'fallback',
      durationMs: Date.now() - startTime,
    };
  } catch { /* silent: grep搜索异常 */
    return { matches: [], totalMatches: 0, truncated: false, engine: 'fallback', durationMs: Date.now() - startTime };
  }
}

/** 构建 fallback 搜索命令 (PowerShell / grep) */
function buildFallbackCmd(
  pattern: string,
  options: { include?: string[]; context: number; maxResults: number; caseSensitive?: boolean },
): string {
  const escapedPattern = pattern.replace(/'/g, "''");

  if (process.platform === 'win32') {
    const includeFilter = options.include && options.include.length > 0
      ? ` -Include ${options.include.map(i => `'${i}'`).join(',')}`
      : '';
    const caseFlag = options.caseSensitive ? '' : ' -CaseSensitive:$false';
    return `powershell -NoProfile -Command "Get-ChildItem -Recurse -File${includeFilter} | Where-Object { $_.FullName -notmatch 'node_modules|.git|dist|__pycache__|.next' } | Select-String -Pattern '${escapedPattern}'${caseFlag} -Context ${options.context},${options.context} | Select-Object -First ${options.maxResults} | Out-String -Width 300"`;
  } else {
    const includeFlag = options.include && options.include.length > 0
      ? options.include.map(i => `--include="${i}"`).join(' ')
      : '';
    const caseFlag = options.caseSensitive ? '' : '-i';
    return `grep -rn ${caseFlag} ${includeFlag} -C ${options.context} "${pattern.replace(/"/g, '\\"')}" . | grep -v node_modules | grep -v '.git/' | head -${options.maxResults * 5}`;
  }
}

/** 异步 fallback 搜索 — 不阻塞主进程 */
async function fallbackSearchAsync(
  workspacePath: string,
  pattern: string,
  options: {
    include?: string[];
    context: number;
    maxResults: number;
    caseSensitive?: boolean;
  },
  startTime: number,
): Promise<SearchResult> {
  try {
    const cmd = buildFallbackCmd(pattern, options);

    const { stdout: rawOutput } = await execAsync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20000,
    });

    const matches = parseFallbackOutput(rawOutput, workspacePath, options.maxResults);

    return {
      matches,
      totalMatches: matches.length,
      truncated: false,
      engine: 'fallback',
      durationMs: Date.now() - startTime,
    };
  } catch { /* silent: grep搜索异常 */
    return { matches: [], totalMatches: 0, truncated: false, engine: 'fallback', durationMs: Date.now() - startTime };
  }
}

/**
 * 异步代码搜索 — 不阻塞主进程
 * ripgrep 路径仍同步 (<50ms), fallback 路径改为 async
 */
export async function codeSearchAsync(
  workspacePath: string,
  pattern: string,
  options: {
    include?: string[];
    exclude?: string[];
    context?: number;
    maxResults?: number;
    caseSensitive?: boolean;
    respectGitignore?: boolean;
    fixedString?: boolean;
    wholeWord?: boolean;
  } = {},
): Promise<SearchResult> {
  const start = Date.now();
  const ctx = options.context ?? 2;
  const maxResults = options.maxResults ?? 50;

  if (isRipgrepAvailable()) {
    // ripgrep is fast (<50ms), sync is acceptable
    return ripgrepSearch(workspacePath, pattern, { ...options, context: ctx, maxResults }, start);
  }
  return fallbackSearchAsync(workspacePath, pattern, { ...options, context: ctx, maxResults }, start);
}

function parseFallbackOutput(raw: string, workspacePath: string, maxResults: number): SearchMatch[] {
  const lines = raw.trim().split('\n');
  const matches: SearchMatch[] = [];

  for (const line of lines) {
    if (matches.length >= maxResults) break;
    // Windows Select-String: "path:lineNum:content" 或 Unix grep: "./path:lineNum:content"
    const m = line.match(/^(?:\s*>?\s*)?(.+?):(\d+):(.*)$/);
    if (!m) continue;

    let filepath = m[1].trim().replace(workspacePath, '').replace(/^[\\/]+/, '').replace(/\\/g, '/');
    matches.push({
      file: filepath,
      line: parseInt(m[2], 10),
      content: m[3],
      contextBefore: [],
      contextAfter: [],
    });
  }

  return matches;
}

// ═══════════════════════════════════════
// Format: 结构化搜索结果 → 文本
// ═══════════════════════════════════════

export function formatSearchResult(result: SearchResult): string {
  if (result.matches.length === 0) return '无匹配';

  const parts: string[] = [];

  // 按文件分组
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of result.matches) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file)!.push(m);
  }

  for (const [file, fileMatches] of byFile) {
    parts.push(`\n📄 ${file}`);
    for (const m of fileMatches) {
      if (m.contextBefore.length > 0) {
        for (const ctx of m.contextBefore) {
          parts.push(`    ${ctx}`);
        }
      }
      parts.push(`  ${String(m.line).padStart(5)}│ ${m.content}`);
      if (m.contextAfter.length > 0) {
        for (const ctx of m.contextAfter) {
          parts.push(`    ${ctx}`);
        }
      }
    }
  }

  const footer = [
    `\n[${result.engine}] ${result.totalMatches} 匹配, ${byFile.size} 文件, ${result.durationMs}ms`,
  ];
  if (result.truncated) footer.push(`(结果已截断至 ${result.matches.length} 条)`);

  return parts.join('\n') + '\n' + footer.join(' ');
}

// ═══════════════════════════════════════
// Core: File Name Search
// ═══════════════════════════════════════

/**
 * 按 glob 模式搜索文件名
 */
export function codeSearchFiles(
  workspacePath: string,
  pattern: string,
  options: {
    maxResults?: number;
    respectGitignore?: boolean;
  } = {},
): FileSearchResult {
  const maxResults = options.maxResults ?? 50;

  if (isRipgrepAvailable()) {
    try {
      const args = [
        '--files',
        '-g', pattern,
        '--max-count', String(maxResults + 1),
        '.',  // 显式指定搜索目录，防止 rg 从 stdin 读取
      ];
      if (options.respectGitignore === false) args.push('--no-ignore');

      // 默认排除
      args.push('-g', '!node_modules', '-g', '!.git', '-g', '!dist');

      const result = spawnSync(_rgPath, args, {
        cwd: workspacePath,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });

      const files = (result.stdout || '').trim().split('\n')
        .filter(f => f.trim())
        .map(f => f.replace(/\\/g, '/'));

      return {
        files: files.slice(0, maxResults),
        totalFound: files.length,
        truncated: files.length > maxResults,
      };
    } catch { /* silent: 文件列表搜索异常 */
      // fallthrough to fallback
    }
  }

  // fallback: 用 Node.js 递归搜索
  return fallbackFileSearch(workspacePath, pattern, maxResults);
}

function fallbackFileSearch(workspacePath: string, pattern: string, maxResults: number): FileSearchResult {
  const ignoreSet = new Set(['node_modules', '.git', '__pycache__', 'dist', '.next', 'coverage', '.cache']);
  const results: string[] = [];

  // 将 glob 转成简易正则
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(regexStr, 'i');

  function walk(dir: string, relative: string): void {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (ignoreSet.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.example') continue;

      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (regex.test(rel) || regex.test(entry.name)) {
          results.push(rel);
        }
      }
    }
  }

  walk(workspacePath, '');
  return { files: results, totalFound: results.length, truncated: false };
}

// ═══════════════════════════════════════
// Core: Read Many Files
// ═══════════════════════════════════════

/**
 * 批量 glob 读取多文件，拼接返回
 *
 * @param workspacePath 工作区根
 * @param patterns      glob 模式列表 (如 ['src/**\/*.ts', 'package.json'])
 * @param options       选项
 */
export function readManyFiles(
  workspacePath: string,
  patterns: string[],
  options: {
    maxFiles?: number;          // 最多读取文件数，默认 30
    maxLinesPerFile?: number;   // 每文件最多行数，默认 200
    maxTotalChars?: number;     // 总字符数上限，默认 80000
  } = {},
): ReadManyResult {
  const maxFiles = options.maxFiles ?? 30;
  const maxLinesPerFile = options.maxLinesPerFile ?? 200;
  const maxTotalChars = options.maxTotalChars ?? 80000;

  // 收集所有匹配文件
  const allFiles = new Set<string>();
  for (const pattern of patterns) {
    const found = codeSearchFiles(workspacePath, pattern, { maxResults: maxFiles });
    for (const f of found.files) {
      allFiles.add(f);
      if (allFiles.size >= maxFiles) break;
    }
    if (allFiles.size >= maxFiles) break;
  }

  const result: ReadManyResult = {
    files: [],
    totalFiles: allFiles.size,
    totalLines: 0,
    truncated: false,
  };

  let totalChars = 0;

  for (const relPath of allFiles) {
    if (result.files.length >= maxFiles) { result.truncated = true; break; }

    const absPath = path.join(workspacePath, relPath);
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;

      // 跳过二进制文件（简单启发式）
      if (isBinaryFile(absPath)) continue;

      const raw = fs.readFileSync(absPath, 'utf-8');
      const lines = raw.split('\n');
      const truncatedLines = lines.slice(0, maxLinesPerFile);
      const content = truncatedLines
        .map((line, i) => `${String(i + 1).padStart(4)}| ${line}`)
        .join('\n');

      const linesTruncated = lines.length > maxLinesPerFile;
      const suffix = linesTruncated ? `\n... [截断: 共 ${lines.length} 行, 仅显示 ${maxLinesPerFile} 行]` : '';

      const fileContent = content + suffix;

      if (totalChars + fileContent.length > maxTotalChars) {
        result.truncated = true;
        break;
      }

      result.files.push({
        path: relPath,
        content: fileContent,
        lines: lines.length,
      });
      result.totalLines += lines.length;
      totalChars += fileContent.length;

    } catch { continue; }
  }

  return result;
}

function isBinaryFile(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  const binaryExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.wasm',
    '.mp3', '.mp4', '.avi', '.mov', '.wav',
    '.ttf', '.woff', '.woff2', '.eot', '.otf',
    '.sqlite', '.db', '.lock',
  ]);
  return binaryExts.has(ext);
}

export function formatReadManyResult(result: ReadManyResult): string {
  if (result.files.length === 0) return '无匹配文件';

  const parts: string[] = [];
  for (const file of result.files) {
    parts.push(`\n${'═'.repeat(60)}`);
    parts.push(`📄 ${file.path} (${file.lines} 行)`);
    parts.push('─'.repeat(60));
    parts.push(file.content);
  }

  const footer = `\n[${result.files.length}/${result.totalFiles} 文件, ${result.totalLines} 行${result.truncated ? ', 已截断' : ''}]`;
  return parts.join('\n') + footer;
}

// ═══════════════════════════════════════
// Core: Streaming Large File Read
// ═══════════════════════════════════════

/**
 * 流式读取大文件指定行范围 — 不受 1MB 限制
 *
 * 用 readline 逐行扫描，跳过 offset 之前的行，只保留 limit 行。
 * 内存占用 = O(limit) 而非 O(fileSize)。
 */
export async function streamReadFile(
  filePath: string,
  offset: number = 1,    // 从第几行开始（1-based）
  limit: number = 300,
): Promise<{
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  hasMore: boolean;
  fileSize: number;
}> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`不是文件: ${filePath}`);
  }

  // 快速路径: 小文件（<1MB）直接全量读
  if (stat.size < 1024 * 1024) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const allLines = raw.split('\n');
    const start = Math.max(0, offset - 1);
    const end = Math.min(start + limit, allLines.length);
    const numbered = allLines.slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(6)}| ${line}`)
      .join('\n');

    return {
      content: numbered,
      totalLines: allLines.length,
      startLine: start + 1,
      endLine: end,
      hasMore: end < allLines.length,
      fileSize: stat.size,
    };
  }

  // 大文件路径: 流式 readline
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const startIdx = Math.max(0, offset - 1);
    let currentLine = 0;
    let collected = 0;
    const lines: string[] = [];

    rl.on('line', (line) => {
      currentLine++;
      if (currentLine > startIdx && collected < limit) {
        lines.push(`${String(currentLine).padStart(6)}| ${line}`);
        collected++;
        if (collected >= limit) {
          rl.close();
          stream.destroy();
        }
      }
    });

    rl.on('close', () => {
      // currentLine 此时可能不是总行数（因为提前关闭了流）
      // 但如果 collected < limit，则说明读完了整个文件
      const totalEstimate = collected < limit ? currentLine : -1;

      resolve({
        content: lines.join('\n'),
        totalLines: totalEstimate >= 0 ? totalEstimate : currentLine, // 如果提前截断, totalLines 是当前位置的近似值
        startLine: startIdx + 1,
        endLine: startIdx + collected,
        hasMore: collected >= limit,
        fileSize: stat.size,
      });
    });

    rl.on('error', reject);
    stream.on('error', reject);

    // 安全超时
    setTimeout(() => {
      rl.close();
      stream.destroy();
      resolve({
        content: lines.join('\n'),
        totalLines: currentLine,
        startLine: startIdx + 1,
        endLine: startIdx + collected,
        hasMore: true,
        fileSize: stat.size,
      });
    }, 10000);
  });
}

// ═══════════════════════════════════════
// Core: Code Graph Query (wraps code-graph.ts)
// ═══════════════════════════════════════

// 缓存 code graph 实例
let _cachedGraph: CodeGraph | null = null;
let _cachedGraphWorkspace = '';
let _cachedGraphTime = 0;
const GRAPH_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

/**
 * 查询代码依赖图
 */
export async function queryCodeGraph(
  workspacePath: string,
  query: {
    type: 'depends_on' | 'depended_by' | 'related' | 'summary';
    file?: string;          // 目标文件 (相对路径)
    hops?: number;          // 遍历跳数，默认 2
  },
): Promise<string> {
  const graph = await getOrBuildGraph(workspacePath);

  switch (query.type) {
    case 'summary':
      return graphSummary(graph);

    case 'depends_on': {
      if (!query.file) return '需要指定 file 参数';
      const node = graph.nodes.get(query.file.replace(/\\/g, '/'));
      if (!node) return `文件 ${query.file} 不在依赖图中`;
      const imports = node.imports;
      if (imports.length === 0) return `${query.file} 没有 import 依赖`;
      return `${query.file} 依赖 ${imports.length} 个文件:\n${imports.map(f => `  → ${f}`).join('\n')}`;
    }

    case 'depended_by': {
      if (!query.file) return '需要指定 file 参数';
      const node = graph.nodes.get(query.file.replace(/\\/g, '/'));
      if (!node) return `文件 ${query.file} 不在依赖图中`;
      const importedBy = node.importedBy;
      if (importedBy.length === 0) return `${query.file} 没有被其他文件 import`;
      return `${query.file} 被 ${importedBy.length} 个文件依赖:\n${importedBy.map(f => `  ← ${f}`).join('\n')}`;
    }

    case 'related': {
      if (!query.file) return '需要指定 file 参数';
      const hops = query.hops ?? 2;
      const related = traverseGraph(graph, [query.file.replace(/\\/g, '/')], hops);
      if (related.length === 0) return `${query.file} 没有相关文件`;
      return `${query.file} 的 ${hops}-hop 关联文件 (${related.length} 个):\n${related.map(f => `  ↔ ${f}`).join('\n')}`;
    }

    default:
      return `未知查询类型: ${query.type}`;
  }
}

async function getOrBuildGraph(workspacePath: string): Promise<CodeGraph> {
  const now = Date.now();
  if (_cachedGraph && _cachedGraphWorkspace === workspacePath && (now - _cachedGraphTime) < GRAPH_CACHE_TTL) {
    return _cachedGraph;
  }
  _cachedGraph = await buildCodeGraph(workspacePath);
  _cachedGraphWorkspace = workspacePath;
  _cachedGraphTime = now;
  return _cachedGraph;
}

// ═══════════════════════════════════════
// Core: Repo Map (wraps repo-map.ts)
// ═══════════════════════════════════════

/**
 * 生成代码结构索引
 */
export function getRepoMap(
  workspacePath: string,
  options: {
    maxFiles?: number;
    maxSymbolsPerFile?: number;
    maxTotalLines?: number;
  } = {},
): string {
  return generateRepoMap(
    workspacePath,
    options.maxFiles ?? 80,
    options.maxSymbolsPerFile ?? 20,
    options.maxTotalLines ?? 300,
  );
}
