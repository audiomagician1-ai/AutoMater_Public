/**
 * Doc Manager — 项目文档生命周期管理
 *
 * 职责:
 *  1. 文档读写 — 标准化路径 (.automater/docs/)
 *  2. 版本追踪 — 每次写入自动在 changelog 追加 diff 摘要
 *  3. 一致性校验 — 检查设计文档、需求文档、测试用例的互引用完整性
 *  4. 全文拼接 — 为 LLM 上下文提供 "当前设计文档全文" 快照
 *
 * 目录约定:
 *   .automater/
 *   ├── docs/
 *   │   ├── design.md          — PM 总体设计文档
 *   │   ├── reqs/
 *   │   │   ├── REQ-001.md     — 子需求文档 (1:1 对应 Feature)
 *   │   │   └── REQ-002.md
 *   │   ├── tests/
 *   │   │   ├── TEST-001.md    — 功能测试规格 (1:1 对应子需求)
 *   │   │   └── TEST-002.md
 *   │   └── changelog.jsonl    — 文档变更日志
 *   └── AGENTS.md
 *
 * @module doc-manager
 */

import fs from 'fs';
import path from 'path';

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

/** 文档类型枚举 */
export type DocType = 'design' | 'requirement' | 'test_spec';

/** 文档元信息 */
export interface DocMeta {
  type: DocType;
  id: string;
  path: string;
  version: number;
  updatedAt: string;
  sizeBytes: number;
}

/** 文档变更记录 */
export interface DocChangeEntry {
  timestamp: string;
  type: DocType;
  id: string;
  version: number;
  action: 'create' | 'update';
  /** 变更摘要 (人可读, ≤200 chars) */
  summary: string;
  /** 变更代理 ID */
  agentId: string;
}

/** 一致性检查结果 */
export interface ConsistencyReport {
  ok: boolean;
  issues: ConsistencyIssue[];
}

export interface ConsistencyIssue {
  severity: 'error' | 'warning';
  description: string;
  /** 涉及的文档 */
  documents: string[];
}

// ═══════════════════════════════════════
// Path Helpers
// ═══════════════════════════════════════

/** 获取 .automater/docs 根目录, 不存在则创建 */
function docsRoot(workspacePath: string): string {
  const dir = path.join(workspacePath, '.automater', 'docs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 获取设计文档路径 */
function designDocPath(workspacePath: string): string {
  return path.join(docsRoot(workspacePath), 'design.md');
}

/** 获取子需求文档路径 */
function reqDocPath(workspacePath: string, featureId: string): string {
  const dir = path.join(docsRoot(workspacePath), 'reqs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${featureId}.md`);
}

/** 获取测试规格文档路径 */
function testSpecPath(workspacePath: string, featureId: string): string {
  const dir = path.join(docsRoot(workspacePath), 'tests');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${featureId}.md`);
}

/** 获取变更日志路径 */
function changelogPath(workspacePath: string): string {
  return path.join(docsRoot(workspacePath), 'changelog.jsonl');
}

// ═══════════════════════════════════════
// Core Read/Write
// ═══════════════════════════════════════

/**
 * 读取文档内容。不存在返回 null。
 */
export function readDoc(workspacePath: string, type: DocType, id: string = ''): string | null {
  const filePath = resolveDocPath(workspacePath, type, id);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * 写入文档, 自动追加 changelog。
 *
 * @returns 写入后的版本号 (从 1 开始递增)
 */
export function writeDoc(
  workspacePath: string,
  type: DocType,
  content: string,
  agentId: string,
  summary: string,
  id: string = '',
): number {
  const filePath = resolveDocPath(workspacePath, type, id);
  const isUpdate = fs.existsSync(filePath);
  const version = isUpdate ? getDocVersion(workspacePath, type, id) + 1 : 1;

  // 确保父目录存在
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');

  // 追加变更日志
  const entry: DocChangeEntry = {
    timestamp: new Date().toISOString(),
    type,
    id: id || 'design',
    version,
    action: isUpdate ? 'update' : 'create',
    summary: summary.slice(0, 200),
    agentId,
  };
  appendChangelog(workspacePath, entry);

  return version;
}

/**
 * 解析文档类型 + ID → 文件系统路径
 */
function resolveDocPath(workspacePath: string, type: DocType, id: string): string {
  switch (type) {
    case 'design':
      return designDocPath(workspacePath);
    case 'requirement':
      if (!id) throw new Error('requirement doc requires a feature ID');
      return reqDocPath(workspacePath, id);
    case 'test_spec':
      if (!id) throw new Error('test_spec doc requires a feature ID');
      return testSpecPath(workspacePath, id);
    default:
      throw new Error(`Unknown doc type: ${type}`);
  }
}

// ═══════════════════════════════════════
// Version Tracking
// ═══════════════════════════════════════

/**
 * 从 changelog 读取文档的最新版本号。不存在返回 0。
 */
export function getDocVersion(workspacePath: string, type: DocType, id: string = ''): number {
  const logPath = changelogPath(workspacePath);
  if (!fs.existsSync(logPath)) return 0;

  const docId = id || 'design';
  let maxVersion = 0;

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as DocChangeEntry;
      if (entry.type === type && entry.id === docId && entry.version > maxVersion) {
        maxVersion = entry.version;
      }
    } catch {
      // 跳过损坏的行
    }
  }
  return maxVersion;
}

/**
 * 获取完整的变更日志
 */
export function getChangelog(workspacePath: string): DocChangeEntry[] {
  const logPath = changelogPath(workspacePath);
  if (!fs.existsSync(logPath)) return [];

  return fs.readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as DocChangeEntry; }
      catch { return null; }
    })
    .filter((e): e is DocChangeEntry => e !== null);
}

function appendChangelog(workspacePath: string, entry: DocChangeEntry): void {
  const logPath = changelogPath(workspacePath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

// ═══════════════════════════════════════
// Listing & Metadata
// ═══════════════════════════════════════

/**
 * 列出某类文档的所有元信息
 */
export function listDocs(workspacePath: string, type: DocType): DocMeta[] {
  const results: DocMeta[] = [];

  if (type === 'design') {
    const dp = designDocPath(workspacePath);
    if (fs.existsSync(dp)) {
      const stat = fs.statSync(dp);
      results.push({
        type: 'design',
        id: 'design',
        path: dp,
        version: getDocVersion(workspacePath, 'design'),
        updatedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      });
    }
    return results;
  }

  const dir = type === 'requirement'
    ? path.join(docsRoot(workspacePath), 'reqs')
    : path.join(docsRoot(workspacePath), 'tests');

  if (!fs.existsSync(dir)) return results;

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const id = file.replace('.md', '');
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    results.push({
      type,
      id,
      path: filePath,
      version: getDocVersion(workspacePath, type, id),
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    });
  }

  return results;
}

// ═══════════════════════════════════════
// Context Assembly
// ═══════════════════════════════════════

/**
 * 构建完整的设计文档上下文 — 供 PM/QA 在后续阶段使用
 *
 * 返回格式化的 Markdown 字符串, 包含:
 *  - 设计文档摘要
 *  - 所有子需求的标题列表
 *  - 所有测试规格的标题列表
 *
 * @param maxLength 最大字符数 (超出则截断并附注)
 */
export function buildDesignContext(workspacePath: string, maxLength: number = 8000): string {
  const sections: string[] = [];

  // 设计文档
  const design = readDoc(workspacePath, 'design');
  if (design) {
    const designTruncated = design.length > maxLength * 0.6
      ? design.slice(0, Math.floor(maxLength * 0.6)) + '\n\n...(设计文档已截断)'
      : design;
    sections.push(`## 📐 总体设计文档\n\n${designTruncated}`);
  }

  // 子需求列表
  const reqs = listDocs(workspacePath, 'requirement');
  if (reqs.length > 0) {
    const reqList = reqs.map(r => {
      const content = readDoc(workspacePath, 'requirement', r.id);
      const firstLine = content?.split('\n').find(l => l.startsWith('#'))?.replace(/^#+\s*/, '') || r.id;
      return `- **${r.id}**: ${firstLine} (v${r.version})`;
    }).join('\n');
    sections.push(`## 📋 子需求文档 (${reqs.length} 份)\n\n${reqList}`);
  }

  // 测试规格列表
  const tests = listDocs(workspacePath, 'test_spec');
  if (tests.length > 0) {
    const testList = tests.map(t => {
      const content = readDoc(workspacePath, 'test_spec', t.id);
      const firstLine = content?.split('\n').find(l => l.startsWith('#'))?.replace(/^#+\s*/, '') || t.id;
      return `- **${t.id}**: ${firstLine} (v${t.version})`;
    }).join('\n');
    sections.push(`## 🧪 测试规格文档 (${tests.length} 份)\n\n${testList}`);
  }

  const result = sections.join('\n\n');
  if (result.length > maxLength) {
    return result.slice(0, maxLength) + '\n\n...(上下文已截断)';
  }
  return result;
}

/**
 * 获取单个 Feature 的完整文档上下文 (需求文档 + 测试规格)
 */
export function buildFeatureDocContext(workspacePath: string, featureId: string): string {
  const sections: string[] = [];

  const req = readDoc(workspacePath, 'requirement', featureId);
  if (req) {
    sections.push(`## 📋 需求文档 (${featureId})\n\n${req}`);
  }

  const spec = readDoc(workspacePath, 'test_spec', featureId);
  if (spec) {
    sections.push(`## 🧪 测试规格 (${featureId})\n\n${spec}`);
  }

  return sections.join('\n\n');
}

// ═══════════════════════════════════════
// Consistency Check
// ═══════════════════════════════════════

/**
 * 检查文档体系一致性:
 *  - 每个 Feature 是否有对应的需求文档
 *  - 每个需求文档是否有对应的测试规格
 *  - 设计文档是否存在
 *
 * @param featureIds 当前项目的所有 Feature ID
 */
export function checkConsistency(workspacePath: string, featureIds: string[]): ConsistencyReport {
  const issues: ConsistencyIssue[] = [];

  // 设计文档检查
  if (!readDoc(workspacePath, 'design')) {
    issues.push({
      severity: 'error',
      description: '总体设计文档缺失 (.automater/docs/design.md)',
      documents: ['design.md'],
    });
  }

  // 逐 Feature 检查
  const reqDocs = new Set(listDocs(workspacePath, 'requirement').map(d => d.id));
  const testDocs = new Set(listDocs(workspacePath, 'test_spec').map(d => d.id));

  for (const fid of featureIds) {
    if (!reqDocs.has(fid)) {
      issues.push({
        severity: 'warning',
        description: `Feature ${fid} 缺少子需求文档`,
        documents: [`reqs/${fid}.md`],
      });
    }

    if (!testDocs.has(fid)) {
      issues.push({
        severity: 'warning',
        description: `Feature ${fid} 缺少测试规格文档`,
        documents: [`tests/${fid}.md`],
      });
    }
  }

  // 孤立文档检查 — 需求/测试文档没有对应 Feature
  const featureSet = new Set(featureIds);
  for (const rid of reqDocs) {
    if (!featureSet.has(rid)) {
      issues.push({
        severity: 'warning',
        description: `需求文档 ${rid} 没有对应的 Feature (可能已删除)`,
        documents: [`reqs/${rid}.md`],
      });
    }
  }

  return {
    ok: issues.filter(i => i.severity === 'error').length === 0,
    issues,
  };
}
