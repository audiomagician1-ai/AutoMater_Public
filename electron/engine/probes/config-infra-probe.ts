/**
 * Config & Infrastructure Probe — 配置/基础设施探针
 *
 * 分析构建配置、环境变量、中间件、部署配置，
 * 理解"系统怎么部署和配置"。
 *
 * @module probes/config-infra-probe
 */

import { BaseProbe, type ProbeMessage } from './base-probe';

export class ConfigInfraProbe extends BaseProbe {
  protected gatherContext(): string {
    const sections: string[] = [];

    // Read key config files from Phase 0 snapshot
    if (this.scan.snapshot.keyFileContents) {
      sections.push(`## 配置文件内容\n${this.scan.snapshot.keyFileContents}`);
    }

    // Grep for config/middleware/plugin patterns
    const patterns = [
      /(?:app|server)\.use\s*\(/,
      /(?:register|plugin|middleware)\s*\(/,
      /process\.env\.\w+/,
      /(?:config|env)\s*(?:\.\w+)+/,
      /docker-compose|Dockerfile|\.env/,
    ];

    const allMatches: Array<{ file: string; lineNum: number; line: string }> = [];
    for (const pat of patterns) {
      allMatches.push(...this.grep(pat, 10));
    }

    // Deduplicate
    const seen = new Set<string>();
    for (const match of allMatches) {
      if (seen.has(match.file)) continue;
      seen.add(match.file);
      if (seen.size > this.config.maxFilesToRead) break;

      const content = this.readFile(match.file, 150);
      if (content) {
        sections.push(`### ${match.file}\n\`\`\`\n${content}\n\`\`\``);
      }
    }

    // Also check seed files (config/, .env files, etc.)
    for (const seed of this.config.seeds) {
      if (!seen.has(seed)) {
        const content = this.readFile(seed, 150);
        if (content) {
          sections.push(`### ${seed}\n\`\`\`\n${content}\n\`\`\``);
        }
      }
    }

    return sections.join('\n\n') || '(未发现配置/基础设施文件)';
  }

  protected buildMessages(context: string): ProbeMessage[] {
    return [
      { role: 'system', content: this.buildSystemPrompt() },
      {
        role: 'user',
        content: `## 探针任务: 配置与基础设施分析 (Config & Infrastructure)

你的目标是分析系统的配置和基础设施:
1. **环境配置**: 环境变量、配置文件、多环境支持
2. **中间件链**: 中间件/插件注册点和执行顺序
3. **构建流程**: 构建工具、打包配置、编译选项
4. **部署配置**: Docker、CI/CD、部署脚本
5. **外部服务依赖**: 数据库、消息队列、第三方 API

以下是从项目中发现的配置/基础设施相关内容:

${context}

请输出结构化 JSON。findings 的 type 应为 "config"。`,
      },
    ];
  }
}
