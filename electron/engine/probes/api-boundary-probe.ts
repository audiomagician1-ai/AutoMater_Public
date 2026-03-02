/**
 * API Boundary Probe — API 边界探针
 *
 * 从路由/handler 定义出发，追踪到 service/model 层，
 * 理解"系统对外提供什么能力"。
 *
 * @module probes/api-boundary-probe
 */

import { BaseProbe, type ProbeMessage } from './base-probe';

export class APIBoundaryProbe extends BaseProbe {
  protected gatherContext(): string {
    const sections: string[] = [];

    // Grep for API endpoints / handlers
    const patterns = [
      /(?:router|app)\.\s*(?:get|post|put|delete|patch|use)\s*\(/,
      /@(?:Get|Post|Put|Delete|Patch|Controller|RequestMapping)\s*\(/,
      /ipcMain\.handle\s*\(/,
      /export\s+(?:async\s+)?function\s+\w+.*handler/i,
      /registerRoute|addRoute|createRouter/,
    ];

    const allMatches: Array<{ file: string; lineNum: number; line: string }> = [];
    for (const pat of patterns) {
      allMatches.push(...this.grep(pat, 20));
    }

    // Deduplicate by file
    const fileSet = new Set<string>();
    const uniqueMatches = allMatches.filter(m => {
      if (fileSet.has(m.file)) return false;
      fileSet.add(m.file);
      return true;
    });

    // Read handler files
    for (const match of uniqueMatches.slice(0, this.config.maxFilesToRead)) {
      const content = this.readFile(match.file, 200);
      if (content) {
        sections.push(`### ${match.file} (匹配: ${match.line})\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // Also check for seed files explicitly provided
    for (const seed of this.config.seeds) {
      if (!fileSet.has(seed)) {
        const content = this.readFile(seed, 200);
        if (content) {
          sections.push(`### ${seed} (种子文件)\n\`\`\`\n${content}\n\`\`\``);
        }
      }
    }

    if (sections.length === 0) {
      return '(未发现 API 端点/handler 定义)';
    }

    return sections.join('\n\n');
  }

  protected buildMessages(context: string): ProbeMessage[] {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `## 探针任务: API 边界分析 (API Boundary)

你的目标是分析系统的对外接口:
1. **API 端点清单**: 列出所有 HTTP/RPC/IPC/CLI 端点
2. **请求/响应格式**: 每个端点的参数和返回值
3. **数据流向**: 从端点到 service/model 层的调用链
4. **认证/中间件**: 认证机制、中间件链、权限检查
5. **API 分组**: 按业务域对端点分组

以下是从项目中发现的 API 相关代码:

${context}

请输出结构化 JSON。findings 的 type 应为 "api-endpoint"。`,
      },
    ];
  }
}
