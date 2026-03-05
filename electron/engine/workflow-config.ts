/**
 * Workflow Config — WORKFLOW.md 加载器 + 配置热更新 (v31.0)
 *
 * 灵感: OpenAI Symphony 的 WORKFLOW.md pattern
 *   - 项目级 `.automater/WORKFLOW.md` 定义自定义 prompt 和配置
 *   - YAML frontmatter 控制行为参数
 *   - Markdown body 按 `## Role: xxx` 分段作为各角色 prompt override
 *   - 支持简单变量插值: {{variable}} 语法
 *   - 文件变更自动检测, 无需重启
 *
 * 优先级: WORKFLOW.md > team_members.system_prompt > 内置 prompts.ts
 *
 * @module workflow-config
 * @since v31.0
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('workflow-config');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface WorkflowFrontmatter {
  /** 项目名称 (覆盖 DB 中的 project.name) */
  name?: string;
  /** 模型覆盖 — 比全局设置优先 */
  models?: {
    strong?: string;
    worker?: string;
    mini?: string;
  };
  /** QA 最大重试次数 (默认 3) */
  maxQARetries?: number;
  /** Developer 最大 ReAct 轮数覆盖 */
  maxIterations?: number;
  /** 开启的插件/技能列表 */
  skills?: string[];
  /** 自定义钩子命令 */
  hooks?: {
    before_run?: string;
    after_run?: string;
    after_feature_done?: string;
    after_qa_fail?: string;
  };
  /** 额外的全局约束 — 附加到每个角色 prompt 末尾 */
  constraints?: string;
  /** 忽略的文件模式 (追加到 .automater 默认忽略) */
  ignorePatterns?: string[];
}

export interface WorkflowRolePrompt {
  role: string;
  prompt: string;
}

export interface WorkflowConfig {
  /** 解析后的 frontmatter 配置 */
  frontmatter: WorkflowFrontmatter;
  /** 按角色分段的 prompt 覆盖 */
  rolePrompts: Map<string, string>;
  /** 全局约束文本 (from frontmatter.constraints) */
  constraints: string;
  /** 源文件路径 */
  filePath: string;
  /** 文件最后修改时间 (用于热更新检测) */
  mtime: number;
}

// ═══════════════════════════════════════
// Cache — 内存缓存 + mtime 检测热更新
// ═══════════════════════════════════════

const configCache = new Map<string, WorkflowConfig>();

/**
 * 获取项目的 WORKFLOW.md 配置。
 * 自动检测文件变更并热更新缓存。
 *
 * @param workspacePath 项目工作区路径
 * @returns 解析后的 WorkflowConfig, 文件不存在则返回 null
 */
export function getWorkflowConfig(workspacePath: string): WorkflowConfig | null {
  if (!workspacePath) return null;

  const filePath = path.join(workspacePath, '.automater', 'WORKFLOW.md');

  try {
    if (!fs.existsSync(filePath)) return null;

    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    // 检查缓存是否有效
    const cached = configCache.get(workspacePath);
    if (cached && cached.mtime === mtime) {
      return cached;
    }

    // 重新解析
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = parseWorkflowMd(raw, filePath, mtime);
    configCache.set(workspacePath, config);
    log.info('Workflow config loaded', {
      path: filePath,
      roles: [...config.rolePrompts.keys()],
      hasHooks: !!config.frontmatter.hooks,
    });
    return config;
  } catch (err) {
    log.warn('Failed to load WORKFLOW.md', { path: filePath, error: String(err) });
    return null;
  }
}

/**
 * 获取 WORKFLOW.md 中某个角色的 prompt 覆盖。
 * 返回 null 表示该角色没有自定义 prompt, 调用方应 fallback。
 */
export function getWorkflowPrompt(workspacePath: string, role: string): string | null {
  const config = getWorkflowConfig(workspacePath);
  if (!config) return null;

  const prompt = config.rolePrompts.get(role.toLowerCase());
  if (!prompt) return null;

  // 附加全局约束
  return config.constraints ? `${prompt}\n\n${config.constraints}` : prompt;
}

/**
 * 获取 WORKFLOW.md 中的 hooks 配置。
 */
export function getWorkflowHooks(workspacePath: string): WorkflowFrontmatter['hooks'] | null {
  const config = getWorkflowConfig(workspacePath);
  return config?.frontmatter.hooks ?? null;
}

/**
 * 使缓存失效 (用于测试或手动刷新)
 */
export function invalidateWorkflowCache(workspacePath: string): void {
  configCache.delete(workspacePath);
}

/** 清空所有缓存 */
export function clearWorkflowCache(): void {
  configCache.clear();
}

// ═══════════════════════════════════════
// Parser — YAML frontmatter + Markdown sections
// ═══════════════════════════════════════

/**
 * 解析 WORKFLOW.md 文件内容。
 *
 * 格式:
 * ```
 * ---
 * name: My Project
 * models:
 *   strong: claude-sonnet-4
 * maxQARetries: 5
 * hooks:
 *   before_run: npm install
 * constraints: |
 *   - 所有代码必须使用 TypeScript
 * ---
 *
 * ## Role: PM
 * 你是一位产品经理...
 *
 * ## Role: Architect
 * 你是一位架构师...
 *
 * ## Role: Developer
 * 你是一位开发者...
 *
 * ## Role: QA
 * 你是一位 QA 工程师...
 * ```
 */
export function parseWorkflowMd(raw: string, filePath: string, mtime: number): WorkflowConfig {
  const { frontmatter, body } = extractFrontmatter(raw);
  const rolePrompts = extractRoleSections(body);

  return {
    frontmatter,
    rolePrompts,
    constraints: frontmatter.constraints ?? '',
    filePath,
    mtime,
  };
}

/**
 * 提取 YAML frontmatter (--- 分隔)。
 * 使用简单的行解析而非引入 yaml 库, 保持零依赖。
 */
export function extractFrontmatter(raw: string): { frontmatter: WorkflowFrontmatter; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: raw };
  }

  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex < 0) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = trimmed.slice(4, endIndex); // skip opening ---\n
  const body = trimmed.slice(endIndex + 4); // skip closing ---\n

  try {
    const frontmatter = parseSimpleYaml(yamlBlock);
    return { frontmatter, body };
  } catch (err) {
    log.warn('Failed to parse WORKFLOW.md frontmatter', { error: String(err) });
    return { frontmatter: {}, body: raw };
  }
}

/**
 * 简易 YAML 解析器 — 只支持 WORKFLOW.md 需要的子集。
 * 支持: 字符串、数字、布尔值、数组、一层嵌套对象、多行字符串 (|)。
 * 不支持: 锚点、流式语法、复杂嵌套。
 */
export function parseSimpleYaml(yamlStr: string): WorkflowFrontmatter {
  const result: Record<string, unknown> = {};
  const lines = yamlStr.split('\n');
  let currentKey = '';
  let currentIndent = 0;
  let nestedObj: Record<string, string> | null = null;
  let multilineKey = '';
  let multilineLines: string[] = [];
  let isMultiline = false;
  let arrayKey = '';
  let arrayItems: string[] = [];

  const flushMultiline = () => {
    if (multilineKey) {
      result[multilineKey] = multilineLines.join('\n').trim();
      multilineKey = '';
      multilineLines = [];
      isMultiline = false;
    }
  };

  const flushNested = () => {
    if (currentKey && nestedObj) {
      result[currentKey] = { ...nestedObj };
      nestedObj = null;
      currentKey = '';
    }
  };

  const flushArray = () => {
    if (arrayKey) {
      result[arrayKey] = [...arrayItems];
      arrayKey = '';
      arrayItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trimEnd();

    // Skip empty lines and comments
    if (trimmedLine === '' || trimmedLine.trimStart().startsWith('#')) {
      if (isMultiline) multilineLines.push('');
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Multiline continuation
    if (isMultiline) {
      if (indent > currentIndent || trimmedLine.trimStart() === '') {
        multilineLines.push(trimmedLine);
        continue;
      } else {
        flushMultiline();
      }
    }

    // Array item
    if (trimmedLine.trimStart().startsWith('- ') && indent > 0) {
      if (arrayKey) {
        arrayItems.push(trimmedLine.trimStart().slice(2).trim());
        continue;
      }
      // Detect start of array — can happen after a key with empty value
      // which may have been misidentified as nested object start
      if (currentKey) {
        // If nestedObj was created but is still empty, convert to array
        if (nestedObj !== null && Object.keys(nestedObj).length === 0) {
          nestedObj = null;
        }
        if (nestedObj === null) {
          arrayKey = currentKey;
          arrayItems = [trimmedLine.trimStart().slice(2).trim()];
          currentKey = '';
          continue;
        }
      }
    }

    // Nested key: value
    if (indent > 0 && nestedObj !== null) {
      const nestedMatch = trimmedLine.trimStart().match(/^(\w+)\s*:\s*(.*)$/);
      if (nestedMatch) {
        nestedObj[nestedMatch[1]] = String(parseYamlValue(nestedMatch[2]));
        continue;
      }
    }

    // Flush pending contexts when back to top level
    if (indent === 0) {
      flushNested();
      flushArray();
    }

    // Top-level key: value
    const topMatch = trimmedLine.match(/^(\w+)\s*:\s*(.*)$/);
    if (topMatch) {
      const [, key, rawValue] = topMatch;
      const value = rawValue.trim();

      if (value === '' || value === '|') {
        // Could be nested object, multiline, or array — peek next line
        if (value === '|') {
          isMultiline = true;
          multilineKey = key;
          multilineLines = [];
          currentIndent = indent;
        } else {
          currentKey = key;
          currentIndent = indent;
          nestedObj = {};
        }
      } else {
        result[key] = parseYamlValue(value);
      }
    }
  }

  // Flush remaining
  flushMultiline();
  flushNested();
  flushArray();

  return result as unknown as WorkflowFrontmatter;
}

function parseYamlValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  // Remove quotes
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * 按 `## Role: xxx` 标题提取角色 prompt 段落。
 * 每个段落从 `## Role: xxx` 开始到下一个 `## Role:` 或文件末尾。
 */
export function extractRoleSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  // Match ## Role: xxx (case-insensitive, allowing extra whitespace)
  const pattern = /^##\s+Role:\s*(.+)$/gim;
  const matches: Array<{ role: string; index: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    matches.push({ role: match[1].trim().toLowerCase(), index: match.index + match[0].length });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? body.lastIndexOf('\n##', matches[i + 1].index) : body.length;
    const content = body.slice(start, end).trim();
    if (content.length > 10) {
      sections.set(matches[i].role, content);
    }
  }

  return sections;
}

// ═══════════════════════════════════════
// Variable interpolation — {{variable}} 语法
// ═══════════════════════════════════════

/**
 * 在 prompt 文本中插值变量。
 *
 * 支持的变量:
 *   {{project_name}} — 项目名
 *   {{feature_id}} — 当前 Feature ID
 *   {{feature_title}} — 当前 Feature 标题
 *   {{date}} — 当前日期
 *   {{attempt}} — QA 重试次数
 *   自定义键值对
 */
export function interpolatePrompt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`;
  });
}

// ═══════════════════════════════════════
// Default WORKFLOW.md template
// ═══════════════════════════════════════

/**
 * 生成默认的 WORKFLOW.md 模板。
 * 在项目创建时写入 .automater/WORKFLOW.md。
 */
export function generateDefaultWorkflow(projectName: string): string {
  return `---
# AutoMater Workflow Configuration
# 编辑此文件自定义项目行为, 修改后立即生效 (热更新)
name: ${projectName}

# 模型覆盖 (可选, 不设置则使用全局配置)
# models:
#   strong: claude-sonnet-4
#   worker: gpt-4o-mini

# QA 最大重试次数 (默认 3)
# maxQARetries: 3

# Developer 最大 ReAct 轮数 (默认由全局设置控制)
# maxIterations: 50

# 钩子命令 — 在关键节点自动执行
# hooks:
#   before_run: npm install
#   after_feature_done: npm test
#   after_qa_fail: echo "QA failed"

# 全局约束 — 附加到每个角色 prompt 末尾
# constraints: |
#   - 所有代码必须使用 TypeScript strict 模式
#   - 禁止使用 any 类型
---

# Workflow — ${projectName}

下面可以按角色自定义 prompt。如果某个角色段落被删除或留空, 将使用内置默认 prompt。

<!-- 取消注释并编辑以下段落来自定义角色 prompt -->

<!--
## Role: PM
你是一位资深产品经理...

## Role: Architect
你是一位资深架构师...

## Role: Developer
你是一位全栈开发工程师...

## Role: QA
你是一位严格的 QA 工程师...
-->
`;
}

/**
 * 确保项目有 WORKFLOW.md。如果不存在则写入默认模板。
 * 幂等操作 — 已存在的文件不会被覆盖。
 */
export function ensureWorkflowFile(workspacePath: string, projectName: string): string {
  const dir = path.join(workspacePath, '.automater');
  const filePath = path.join(dir, 'WORKFLOW.md');

  if (fs.existsSync(filePath)) return filePath;

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = generateDefaultWorkflow(projectName);
    fs.writeFileSync(filePath, content, 'utf-8');
    log.info('Created default WORKFLOW.md', { path: filePath });
  } catch (err) {
    log.warn('Failed to create WORKFLOW.md', { path: filePath, error: String(err) });
  }

  return filePath;
}
