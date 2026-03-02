/**
 * Module Deep Dive Probe — 模块纵深探针
 *
 * 从模块中心文件 (hub / 社区检测中心) 出发，深入分析模块内部：
 * 职责、公开 API、关键数据结构、内部依赖关系。
 *
 * @module probes/module-probe
 */

import { BaseProbe, type ProbeMessage } from './base-probe';

export class ModuleProbe extends BaseProbe {
  protected gatherContext(): string {
    const sections: string[] = [];

    for (const seed of this.config.seeds) {
      // Read the module's main file (index.ts or largest file)
      const content = this.readFile(seed, 250);
      if (!content) continue;

      const exports = this.getExportsOf(seed);
      sections.push(`### 模块文件: ${seed}\n导出: ${exports.join(', ') || '(无)'}\n\`\`\`\n${content}\n\`\`\``);

      // grep for exports from this module across the project
      const basename = seed.split('/').pop()?.replace(/\.\w+$/, '') || '';
      if (basename && basename !== 'index') {
        const usages = this.grep(
          new RegExp(`from\\s+['"].*${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`),
          10,
        );
        if (usages.length > 0) {
          sections.push(`### 谁引用了 ${seed}:\n${usages.map(u => `  ${u.file}:${u.lineNum} → ${u.line}`).join('\n')}`);
        }
      }

      // Follow imports from this seed (2 hops, inward)
      const chain = this.followImports([seed], 2, 6);
      for (const item of chain.slice(0, 4)) {
        const head = this.readHead(item.file, 80);
        if (head) {
          const itemExports = this.getExportsOf(item.file);
          sections.push(`### ${item.file} (距离: ${item.distance})\n导出: ${itemExports.join(', ') || '(无)'}\n\`\`\`\n${head}\n\`\`\``);
        }
      }
    }

    return sections.join('\n\n');
  }

  protected buildMessages(context: string): ProbeMessage[] {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `## 探针任务: 模块纵深分析 (Module Deep Dive)

你的目标是深入分析一个模块的内部结构:
1. **模块职责**: 一句话说清楚这个模块做什么
2. **公开 API**: 列出所有 export 的函数/类/类型/常量
3. **关键数据结构**: 核心 interface/type/class
4. **内部架构**: 内部文件如何分工协作
5. **依赖关系**: 依赖哪些外部模块，被谁依赖

以下是模块的代码内容:

${context}

请输出结构化 JSON。findings 的 type 应为 "module"，每个发现代表一个子模块或关键组件。
确保 publicAPI 和 keyTypes 字段尽量完整。`,
      },
    ];
  }
}
