/**
 * Smell Detection Probe — 异常模式/技术债探针
 *
 * 扫描 TODO/FIXME/HACK、超大文件、循环依赖、反模式，
 * 理解"哪里是雷区"。
 *
 * @module probes/smell-probe
 */

import fs from 'fs';
import path from 'path';
import { BaseProbe, type ProbeMessage } from './base-probe';

export class SmellProbe extends BaseProbe {
  protected gatherContext(): string {
    const sections: string[] = [];

    // 1. Grep for TODO/FIXME/HACK markers
    const markerResults = this.grep(
      /(?:TODO|FIXME|HACK|XXX|TEMP|UNSAFE|DEPRECATED|WORKAROUND)\s*[:：]/i,
      30,
    );
    if (markerResults.length > 0) {
      sections.push(`## 代码标记 (TODO/FIXME/HACK)\n${markerResults.map(r =>
        `- ${r.file}:${r.lineNum} → ${r.line}`,
      ).join('\n')}`);
    }

    // 2. Find large files (>500 lines)
    const largeFiles: Array<{ file: string; lines: number }> = [];
    for (const file of this.scan.allCodeFiles) {
      const absPath = path.join(this.ws, file.replace(/\//g, path.sep));
      try {
        const stat = fs.statSync(absPath);
        const estimatedLines = Math.ceil(stat.size / 40);
        if (estimatedLines > 500) {
          largeFiles.push({ file, lines: estimatedLines });
        }
      } catch (_err) { /* skip: stat failed for this file */ }
    }
    largeFiles.sort((a, b) => b.lines - a.lines);
    if (largeFiles.length > 0) {
      sections.push(`## 超大文件 (>500 行)\n${largeFiles.slice(0, 15).map(f =>
        `- ${f.file}: ~${f.lines} 行`,
      ).join('\n')}`);
    }

    // 3. Circular dependencies from code graph
    const circularPairs: string[] = [];
    for (const [file, node] of this.scan.graph.nodes) {
      for (const imp of node.imports) {
        const target = this.scan.graph.nodes.get(imp);
        if (target?.imports.includes(file)) {
          const pair = [file, imp].sort().join(' ↔ ');
          if (!circularPairs.includes(pair)) circularPairs.push(pair);
        }
      }
    }
    if (circularPairs.length > 0) {
      sections.push(`## 循环依赖\n${circularPairs.slice(0, 10).map(p => `- ${p}`).join('\n')}`);
    }

    // 4. Grep for anti-patterns
    const antiPatterns = [
      { name: 'any 类型', pattern: /:\s*any\b/ },
      { name: '空 catch', pattern: /catch\s*\([^)]*\)\s*\{\s*\}/ },
      { name: 'eslint-disable', pattern: /eslint-disable/ },
      { name: '@ts-ignore', pattern: /@ts-(?:ignore|nocheck|expect-error)/ },
    ];

    for (const ap of antiPatterns) {
      const matches = this.grep(ap.pattern, 10);
      if (matches.length > 0) {
        sections.push(`## ${ap.name} (${matches.length} 处)\n${matches.slice(0, 5).map(m =>
          `- ${m.file}:${m.lineNum}`,
        ).join('\n')}${matches.length > 5 ? `\n  ... +${matches.length - 5} more` : ''}`);
      }
    }

    // 5. Read a few of the largest files' heads for God class detection
    for (const lf of largeFiles.slice(0, 3)) {
      const head = this.readHead(lf.file, 60);
      if (head) {
        sections.push(`### ${lf.file} (头部, ~${lf.lines} 行)\n\`\`\`\n${head}\n\`\`\``);
      }
    }

    return sections.join('\n\n') || '(未发现明显的代码异味)';
  }

  protected buildMessages(context: string): ProbeMessage[] {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `## 探针任务: 代码异味/技术债检测 (Smell Detection)

你的目标是识别项目中的技术债和风险区域:
1. **God 文件/类**: 超大文件中的职责是否合理，是否需要拆分
2. **循环依赖**: 循环依赖的影响和修复建议
3. **代码标记**: TODO/FIXME/HACK 的优先级和影响
4. **反模式**: any 类型、空 catch、ts-ignore 的风险评估
5. **整体健康度**: 代码质量评分和改进建议

以下是从项目中检测到的异常模式:

${context}

请输出结构化 JSON。findings 的 type 应为 "anti-pattern"。
issues 字段应详细列出每个发现的位置、严重度和修复建议。
confidence 反映你对分析全面性的自信程度。`,
      },
    ];
  }
}
