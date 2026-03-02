/**
 * Data Model Probe — 数据模型探针
 *
 * 收集所有类型/schema/ORM 定义，识别核心实体和关系，
 * 理解"系统操作什么数据"。
 *
 * @module probes/data-model-probe
 */

import { BaseProbe, type ProbeMessage } from './base-probe';

export class DataModelProbe extends BaseProbe {
  protected gatherContext(): string {
    const sections: string[] = [];

    // Grep for type/schema definitions
    const patterns = [
      /(?:export\s+)?(?:interface|type)\s+\w+\s*(?:extends|=|\{)/,
      /(?:@Entity|@Table|@Column|@Model|schema\.define|createTable)/,
      /CREATE\s+TABLE|ALTER\s+TABLE/i,
      /(?:export\s+)?(?:class)\s+\w+.*(?:Entity|Model|Schema|Table)/,
      /\.prepare\s*\(\s*['"`](?:CREATE|INSERT|SELECT|UPDATE)/i,
      /(?:mongoose\.model|Schema\(|defineModel|prisma\.)/,
    ];

    const allMatches: Array<{ file: string; lineNum: number; line: string }> = [];
    for (const pat of patterns) {
      allMatches.push(...this.grep(pat, 15));
    }

    // Deduplicate by file, prioritize files with most type matches
    const fileCounts = new Map<string, number>();
    for (const m of allMatches) {
      fileCounts.set(m.file, (fileCounts.get(m.file) || 0) + 1);
    }
    const sortedFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([f]) => f);

    // Read files with most type definitions
    for (const file of sortedFiles.slice(0, this.config.maxFilesToRead)) {
      const content = this.readFile(file, 250);
      if (content) {
        sections.push(`### ${file} (${fileCounts.get(file)} 个类型定义)\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // Also check seed files
    for (const seed of this.config.seeds) {
      if (!fileCounts.has(seed)) {
        const content = this.readFile(seed, 250);
        if (content) {
          sections.push(`### ${seed} (种子文件)\n\`\`\`\n${content}\n\`\`\``);
        }
      }
    }

    if (sections.length === 0) {
      return '(未发现明确的数据模型/类型定义文件)';
    }

    return sections.join('\n\n');
  }

  protected buildMessages(context: string): ProbeMessage[] {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `## 探针任务: 数据模型分析 (Data Model)

你的目标是分析系统的数据模型:
1. **核心实体**: 列出所有核心业务实体 (interface/type/class/table)
2. **字段与类型**: 每个实体的关键字段及其类型
3. **实体关系**: 实体间的关系 (1:1, 1:N, N:M, 继承, 组合)
4. **数据库 Schema**: 如果有 DB migration/ORM 定义，描述表结构
5. **验证规则**: 字段验证、约束、默认值

以下是从项目中发现的数据模型相关代码:

${context}

请输出结构化 JSON。findings 的 type 应为 "data-model"，keyTypes 字段要尽量完整。`,
      },
    ];
  }
}
