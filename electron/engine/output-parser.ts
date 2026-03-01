/**
 * Output Parser — LLM 输出的程序化解析 + 结构化验证
 *
 * 核心原则: 不信任 LLM 的输出格式。用多策略提取 + schema 校验替代正则祈祷。
 *
 * 策略栈 (按优先级尝试):
 *  1. 直接 JSON.parse 全文
 *  2. 剥离 Markdown 代码块后解析
 *  3. 贪心括号匹配提取 JSON
 *  4. 行扫描提取 JSON-like 结构
 *  5. 返回 ParseError (不静默 fallback)
 *
 * v3.0: 从 orchestrator/qa-loop 中硬编码的 regex 提取改为此统一模块
 */

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export interface ParseSuccess<T> {
  ok: true;
  data: T;
  /** 使用的解析策略 */
  strategy: ParseStrategy;
  /** 校验警告 (非致命) */
  warnings: string[];
}

export interface ParseFailure {
  ok: false;
  error: string;
  /** 尝试过的策略 */
  strategiesAttempted: ParseStrategy[];
  /** 原始文本 (截断) 用于调试 */
  rawPreview: string;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

export type ParseStrategy = 'direct' | 'markdown_strip' | 'bracket_match' | 'line_scan';

// ═══════════════════════════════════════
// Schema Validation (轻量级, 零依赖)
// ═══════════════════════════════════════

/** 字段校验规则 */
export interface FieldRule {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  /** 枚举约束 */
  enum?: any[];
  /** 数值范围 */
  min?: number;
  max?: number;
  /** 数组元素校验 */
  items?: Record<string, FieldRule>;
  /** 默认值 (缺失时填入) */
  default?: any;
}

export interface SchemaSpec {
  /** 期望的顶层类型 */
  topLevel: 'object' | 'array';
  /** 对象字段规则 (topLevel=object 时) */
  fields?: Record<string, FieldRule>;
  /** 数组元素的字段规则 (topLevel=array 时) */
  arrayItemFields?: Record<string, FieldRule>;
  /** 数组长度约束 */
  minItems?: number;
  maxItems?: number;
}

/**
 * 校验并修复解析后的数据
 * 返回修复后的数据 + 警告列表
 */
function validateAndRepair(data: any, schema: SchemaSpec): { data: any; warnings: string[]; valid: boolean } {
  const warnings: string[] = [];

  // 顶层类型检查
  if (schema.topLevel === 'array') {
    if (!Array.isArray(data)) {
      // 尝试包装: 如果是单个对象, 包装成数组
      if (typeof data === 'object' && data !== null) {
        data = [data];
        warnings.push('Wrapped single object into array');
      } else {
        return { data, warnings: ['Expected array, got ' + typeof data], valid: false };
      }
    }

    // 数组长度约束
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      return { data, warnings: [`Array has ${data.length} items, minimum is ${schema.minItems}`], valid: false };
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      warnings.push(`Array truncated from ${data.length} to ${schema.maxItems} items`);
      data = data.slice(0, schema.maxItems);
    }

    // 校验每个数组元素
    if (schema.arrayItemFields) {
      data = data.map((item: any, i: number) => {
        if (typeof item !== 'object' || item === null) {
          warnings.push(`Item[${i}] is not an object, skipped`);
          return null;
        }
        return repairObject(item, schema.arrayItemFields!, warnings, `[${i}]`);
      }).filter((x: any) => x !== null);
    }
  } else {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { data, warnings: ['Expected object, got ' + (Array.isArray(data) ? 'array' : typeof data)], valid: false };
    }
    if (schema.fields) {
      data = repairObject(data, schema.fields, warnings, '');
    }
  }

  return { data, warnings, valid: true };
}

/** 校验 + 修复单个对象的字段 */
function repairObject(
  obj: Record<string, any>,
  fields: Record<string, FieldRule>,
  warnings: string[],
  path: string,
): Record<string, any> {
  const result = { ...obj };

  for (const [key, rule] of Object.entries(fields)) {
    const fullPath = path ? `${path}.${key}` : key;
    const value = result[key];

    // 缺失处理
    if (value === undefined || value === null) {
      if (rule.default !== undefined) {
        result[key] = rule.default;
        continue;
      }
      if (rule.required) {
        warnings.push(`Missing required field: ${fullPath}`);
      }
      continue;
    }

    // 类型修复
    if (rule.type === 'string' && typeof value !== 'string') {
      result[key] = String(value);
      warnings.push(`${fullPath}: coerced ${typeof value} to string`);
    }
    if (rule.type === 'number' && typeof value !== 'number') {
      const num = Number(value);
      if (!isNaN(num)) {
        result[key] = num;
        warnings.push(`${fullPath}: coerced to number`);
      }
    }
    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      result[key] = Boolean(value);
      warnings.push(`${fullPath}: coerced to boolean`);
    }
    if (rule.type === 'array' && !Array.isArray(value)) {
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            result[key] = parsed;
            warnings.push(`${fullPath}: parsed string as JSON array`);
          }
        } catch {
          result[key] = [value];
          warnings.push(`${fullPath}: wrapped string in array`);
        }
      }
    }

    // 枚举约束
    if (rule.enum && !rule.enum.includes(result[key])) {
      if (rule.default !== undefined) {
        warnings.push(`${fullPath}: "${result[key]}" not in enum ${JSON.stringify(rule.enum)}, using default "${rule.default}"`);
        result[key] = rule.default;
      } else {
        warnings.push(`${fullPath}: "${result[key]}" not in enum ${JSON.stringify(rule.enum)}`);
      }
    }

    // 数值范围
    if (rule.type === 'number' && typeof result[key] === 'number') {
      if (rule.min !== undefined && result[key] < rule.min) {
        result[key] = rule.min;
        warnings.push(`${fullPath}: clamped to min ${rule.min}`);
      }
      if (rule.max !== undefined && result[key] > rule.max) {
        result[key] = rule.max;
        warnings.push(`${fullPath}: clamped to max ${rule.max}`);
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════
// JSON Extraction Strategies
// ═══════════════════════════════════════

/** 策略 1: 直接 parse */
function tryDirectParse(raw: string): any | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

/** 策略 2: 剥离 Markdown 代码块 */
function tryMarkdownStrip(raw: string): any | null {
  // 匹配 ```json ... ``` 或 ``` ... ```
  const codeBlockRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(raw)) !== null) {
    const inner = match[1].trim();
    try {
      return JSON.parse(inner);
    } catch { /* try next block */ }
  }
  return null;
}

/** 策略 3: 贪心括号匹配 (寻找最外层 [] 或 {}) */
function tryBracketMatch(raw: string, targetBracket: '[' | '{'): any | null {
  const openBr = targetBracket;
  const closeBr = targetBracket === '[' ? ']' : '}';

  const startIdx = raw.indexOf(openBr);
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < raw.length; i++) {
    const ch = raw[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === openBr) depth++;
    else if (ch === closeBr) {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(startIdx, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 策略 4: 行扫描 — 逐行拼接尝试 parse */
function tryLineScan(raw: string, targetBracket: '[' | '{'): any | null {
  const lines = raw.split('\n');
  const openBr = targetBracket;
  let collecting = false;
  let buffer = '';
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!collecting) {
      if (trimmed.startsWith(openBr)) {
        collecting = true;
        buffer = '';
      } else {
        continue;
      }
    }

    buffer += line + '\n';

    // 简单深度追踪 (不完美但足够 fallback)
    for (const ch of trimmed) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }

    if (depth <= 0 && collecting) {
      try {
        return JSON.parse(buffer.trim());
      } catch {
        // reset and continue
        collecting = false;
        buffer = '';
        depth = 0;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════
// Public API
// ═══════════════════════════════════════

/**
 * 从 LLM 原始输出中提取并校验 JSON
 *
 * @param raw LLM 的原始文本输出
 * @param schema 校验规则 (定义期望的结构)
 * @returns 解析结果 (成功含修复后的数据, 失败含诊断信息)
 */
export function parseStructuredOutput<T = any>(raw: string, schema: SchemaSpec): ParseResult<T> {
  const strategies: ParseStrategy[] = [];
  const targetBracket = schema.topLevel === 'array' ? '[' as const : '{' as const;

  // 策略 1: 直接 parse
  strategies.push('direct');
  let parsed = tryDirectParse(raw);
  if (parsed !== null) {
    const validated = validateAndRepair(parsed, schema);
    if (validated.valid) {
      return { ok: true, data: validated.data as T, strategy: 'direct', warnings: validated.warnings };
    }
  }

  // 策略 2: 剥离 Markdown 代码块
  strategies.push('markdown_strip');
  parsed = tryMarkdownStrip(raw);
  if (parsed !== null) {
    const validated = validateAndRepair(parsed, schema);
    if (validated.valid) {
      return { ok: true, data: validated.data as T, strategy: 'markdown_strip', warnings: validated.warnings };
    }
  }

  // 策略 3: 贪心括号匹配
  strategies.push('bracket_match');
  parsed = tryBracketMatch(raw, targetBracket);
  if (parsed !== null) {
    const validated = validateAndRepair(parsed, schema);
    if (validated.valid) {
      return { ok: true, data: validated.data as T, strategy: 'bracket_match', warnings: validated.warnings };
    }
  }

  // 策略 4: 行扫描
  strategies.push('line_scan');
  parsed = tryLineScan(raw, targetBracket);
  if (parsed !== null) {
    const validated = validateAndRepair(parsed, schema);
    if (validated.valid) {
      return { ok: true, data: validated.data as T, strategy: 'line_scan', warnings: validated.warnings };
    }
  }

  return {
    ok: false,
    error: `Failed to extract valid ${schema.topLevel} from LLM output after ${strategies.length} strategies`,
    strategiesAttempted: strategies,
    rawPreview: raw.slice(0, 500),
  };
}

// ═══════════════════════════════════════
// Pre-built Schemas for AgentForge
// ═══════════════════════════════════════

/** PM Feature 清单 schema */
export const PM_FEATURE_SCHEMA: SchemaSpec = {
  topLevel: 'array',
  minItems: 1,
  maxItems: 50,
  arrayItemFields: {
    id:          { type: 'string',  required: true, default: '' },
    category:    { type: 'string',  required: false, default: 'core', enum: ['infrastructure', 'core', 'ui', 'api', 'testing', 'docs'] },
    priority:    { type: 'number',  required: false, default: 1, min: 0, max: 2 },
    title:       { type: 'string',  required: true },
    description: { type: 'string',  required: true },
    dependsOn:   { type: 'array',   required: false, default: [] },
    acceptance_criteria: { type: 'array', required: false, default: [] },
    notes:       { type: 'string',  required: false, default: '' },
  },
};

/** QA 审查结果 schema */
export const QA_VERDICT_SCHEMA: SchemaSpec = {
  topLevel: 'object',
  fields: {
    verdict:   { type: 'string',  required: true, enum: ['pass', 'fail'], default: 'fail' },
    score:     { type: 'number',  required: true, default: 0, min: 0, max: 100 },
    summary:   { type: 'string',  required: true, default: '' },
    issues:    { type: 'array',   required: false, default: [] },
  },
};

/** Planner 步骤 schema */
export const PLAN_STEPS_SCHEMA: SchemaSpec = {
  topLevel: 'array',
  minItems: 1,
  maxItems: 15,
  arrayItemFields: {
    description: { type: 'string', required: true },
    tool:        { type: 'string', required: false },
  },
};
