/**
 * Repository Map — 轻量级代码结构索引
 *
 * 参考 Aider 的 repo-map 设计：用正则 (非 AST 依赖) 提取
 * 函数签名、类定义、export、interface、type 等关键符号，
 * 生成紧凑的项目结构摘要，常驻 Agent 上下文。
 *
 * 支持: TypeScript/JavaScript, Python, Go, Rust, Java/C#
 *
 * v1.0: 初始实现
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
const log = createLogger('repo-map');


// ═══════════════════════════════════════
// Public Interface
// ═══════════════════════════════════════

export interface RepoMapEntry {
  file: string;          // 相对路径
  symbols: string[];     // 提取的符号行 (函数签名、class、export 等)
}

/**
 * 为工作区生成 Repository Map
 * 返回紧凑的 "文件 → 符号列表" 文本，适合直接注入 prompt
 */
export function generateRepoMap(
  workspacePath: string,
  maxFiles: number = 80,
  maxSymbolsPerFile: number = 20,
  maxTotalLines: number = 200,
): string {
  const entries = collectEntries(workspacePath, maxFiles, maxSymbolsPerFile);
  if (entries.length === 0) return '';

  const lines: string[] = ['## Repository Map (代码结构索引)'];
  let totalLines = 1;

  for (const entry of entries) {
    if (totalLines >= maxTotalLines) {
      lines.push(`\n... [已截断, 共 ${entries.length} 文件]`);
      break;
    }
    lines.push(`\n### ${entry.file}`);
    totalLines++;
    for (const sym of entry.symbols) {
      if (totalLines >= maxTotalLines) break;
      lines.push(`  ${sym}`);
      totalLines++;
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════
// Internal
// ═══════════════════════════════════════

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'dist', 'build', '.next',
  'coverage', '.cache', 'target', 'vendor', '.automater',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.cs', '.rb',
  '.c', '.cpp', '.h', '.hpp', '.swift', '.kt',
  '.vue', '.svelte',
]);

function collectEntries(
  workspacePath: string,
  maxFiles: number,
  maxSymbols: number,
): RepoMapEntry[] {
  const files = collectCodeFiles(workspacePath, '', maxFiles);
  const entries: RepoMapEntry[] = [];

  for (const file of files) {
    const absPath = path.join(workspacePath, file);
    let content: string;
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > 256 * 1024) continue; // skip files > 256KB
      content = fs.readFileSync(absPath, 'utf-8');
    } catch (err) { continue; }

    const ext = path.extname(file).toLowerCase();
    const symbols = extractSymbols(content, ext, maxSymbols);
    if (symbols.length > 0) {
      entries.push({ file, symbols });
    }
  }

  return entries;
}

function collectCodeFiles(
  workspacePath: string,
  relative: string,
  maxFiles: number,
): string[] {
  const result: string[] = [];
  const absDir = path.join(workspacePath, relative);
  if (!fs.existsSync(absDir)) return result;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (err) { return result; }

  for (const entry of entries) {
    if (result.length >= maxFiles) break;
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

    const rel = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      result.push(...collectCodeFiles(workspacePath, rel, maxFiles - result.length));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        result.push(rel);
      }
    }
  }

  return result;
}

/**
 * 从文件内容中提取关键符号 (正则方式, 无需 AST 库)
 */
function extractSymbols(content: string, ext: string, maxSymbols: number): string[] {
  const lines = content.split('\n');
  const symbols: string[] = [];

  for (const line of lines) {
    if (symbols.length >= maxSymbols) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

    let matched = false;

    switch (ext) {
      case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      case '.vue': case '.svelte':
        matched = matchTSJS(trimmed);
        break;
      case '.py':
        matched = matchPython(trimmed);
        break;
      case '.go':
        matched = matchGo(trimmed);
        break;
      case '.rs':
        matched = matchRust(trimmed);
        break;
      case '.java': case '.cs': case '.kt':
        matched = matchJavaLike(trimmed);
        break;
      default:
        matched = matchGeneric(trimmed);
    }

    if (matched) {
      // 清理: 截断太长的行, 去掉函数体
      let sym = trimmed;
      if (sym.length > 120) sym = sym.slice(0, 117) + '...';
      // 如果行以 { 结尾，保留签名不保留 {
      sym = sym.replace(/\s*\{$/, '');
      symbols.push(sym);
    }
  }

  return symbols;
}

function matchTSJS(line: string): boolean {
  return (
    /^export\s+(default\s+)?(function|class|interface|type|const|let|enum|abstract)/.test(line) ||
    /^(export\s+)?(async\s+)?function\s+\w+/.test(line) ||
    /^(export\s+)?(class|interface|type|enum)\s+\w+/.test(line) ||
    /^import\s+.*\s+from\s+/.test(line) ||
    /^(export\s+)?const\s+\w+\s*[:=]/.test(line) && !line.includes("'") && line.length < 100
  );
}

function matchPython(line: string): boolean {
  return (
    /^(async\s+)?def\s+\w+/.test(line) ||
    /^class\s+\w+/.test(line) ||
    /^from\s+\S+\s+import\s+/.test(line) ||
    /^import\s+\S+/.test(line)
  );
}

function matchGo(line: string): boolean {
  return (
    /^func\s+(\(\w+\s+\*?\w+\)\s+)?\w+/.test(line) ||
    /^type\s+\w+\s+(struct|interface)/.test(line) ||
    /^package\s+\w+/.test(line)
  );
}

function matchRust(line: string): boolean {
  return (
    /^(pub\s+)?(async\s+)?fn\s+\w+/.test(line) ||
    /^(pub\s+)?(struct|enum|trait|impl|mod|type)\s+\w+/.test(line) ||
    /^use\s+/.test(line)
  );
}

function matchJavaLike(line: string): boolean {
  return (
    /^(public|private|protected|static|abstract|override|internal)\s+/.test(line) &&
    (/\s+(class|interface|enum|void|int|string|boolean|fun)\s+/.test(line.toLowerCase()) ||
     /\s+\w+\s*\(/.test(line)) ||
    /^(package|import)\s+/.test(line)
  );
}

function matchGeneric(line: string): boolean {
  return (
    /^(export|function|class|interface|type|def|fn|pub|struct|enum|impl|module)\s+/.test(line)
  );
}