/**
 * Entry Probe — 入口追踪探针
 *
 * 从项目入口文件出发，沿 import 图深度优先展开，
 * 理解"系统是怎么跑起来的"——启动流程、初始化顺序、核心依赖链。
 *
 * @module probes/entry-probe
 */

import { BaseProbe, type ProbeMessage } from './base-probe';

export class EntryProbe extends BaseProbe {
  protected gatherContext(): string {
    const seeds = this.config.seeds.filter(s =>
      this.scan.graph.nodes.has(s),
    );

    if (seeds.length === 0) return '(无有效入口文件)';

    const sections: string[] = [];

    for (const seed of seeds) {
      // Read the entry file fully (up to 300 lines)
      const content = this.readFile(seed, 300);
      sections.push(`### 入口文件: ${seed}\n\`\`\`\n${content}\n\`\`\``);

      // Follow import chain 3-5 hops
      const hops = this.config.graphHops || 3;
      const chain = this.followImports([seed], hops, this.config.maxFilesToRead);

      for (const item of chain.slice(0, 8)) {
        const head = this.readHead(item.file, 100);
        if (head) {
          sections.push(`### ${item.file} (距离: ${item.distance} 跳)\n\`\`\`\n${head}\n\`\`\``);
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
        content: `## 探针任务: 入口追踪 (Entry Trace)

你的目标是从项目入口文件出发，沿 import 链追踪，理解:
1. **启动流程**: 系统从什么文件启动，经过哪些初始化步骤
2. **初始化顺序**: 各个子系统 / 模块的加载和初始化顺序
3. **核心依赖链**: 入口文件直接和间接依赖的关键模块
4. **数据/控制流**: 用户请求从入口到业务逻辑的流转路径

以下是从入口文件沿 import 链收集的代码片段:

${context}

请分析以上代码，输出结构化 JSON (参考系统 prompt 中的格式)。
findings 中重点描述入口流程发现的模块和数据流。`,
      },
    ];
  }

  protected shouldContinue(response: string, round: number): boolean {
    // Entry probe can do 2 rounds if first round discovered interesting unexplored paths
    if (round >= 2) return false;
    return response.includes('[需要进一步探索]') || response.includes('further exploration');
  }

  protected buildFollowUp(response: string, _round: number): string | null {
    // If the LLM mentioned files it wants to see, read them
    const fileRequests = response.match(/\[想看: ([^\]]+)\]/);
    if (!fileRequests) return null;

    const files = fileRequests[1].split(',').map(f => f.trim());
    const sections: string[] = [];
    for (const file of files.slice(0, 5)) {
      const content = this.readFile(file, 150);
      if (content) {
        sections.push(`### ${file}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    if (sections.length === 0) return null;
    return `以下是你请求查看的文件:\n\n${sections.join('\n\n')}\n\n请更新你的分析，输出完整的 JSON 结果。`;
  }
}
