/**
 * File system & code search tool definitions.
 */
import type { ToolDef } from './types';

export const FS_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    description:
      '读取文件指定行范围的内容。返回带行号的文本。⚡ 最佳实践: 先用 search_files/code_search 定位目标行号，再用 offset+limit 只读需要的部分（如 offset=142, limit=40 只读 30-50 行）。不带 offset 时默认从第 1 行开始，默认只读 200 行。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对于工作区，或绝对路径需要 externalRead 权限）' },
        offset: { type: 'number', description: '起始行号 (从1开始)。⚡ 建议: 用 search_files 获取行号后设置此参数' },
        limit: { type: 'number', description: '读取行数，默认200，最大500。⚡ 通常 30-80 行足够理解一个函数/类' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '创建新文件或完全覆盖已有文件。自动创建目录。仅用于创建新文件，修改已有文件请用 edit_file。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        content: { type: 'string', description: '完整的文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      '对已有文件进行精确的文本替换编辑。使用 old_string/new_string 模式，只修改需要改的部分，无需重写整个文件。如果 old_string 为空则追加到文件末尾。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        old_string: {
          type: 'string',
          description: '要被替换的原始文本（必须精确匹配，包含缩进）。为空则追加到文件末尾。',
        },
        new_string: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_files',
    description: '列出工作区的文件目录树。用于了解项目结构。',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: '相对目录路径，默认为根目录', default: '' },
        max_depth: { type: 'number', description: '最大深度，默认3', default: 3 },
      },
    },
  },
  {
    name: 'glob_files',
    description: '按 glob 模式查找文件路径。例如 "**/*.ts" 查找所有 TypeScript 文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 模式，如 "src/**/*.ts", "*.json", "**/*test*"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'search_files',
    description: '在工作区文件中搜索文本/正则。基于 ripgrep（自动降级）。返回匹配行及上下文。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（支持正则语法）' },
        include: { type: 'string', description: '文件类型过滤 (如 *.ts, *.py)', default: '*' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'code_search',
    description:
      '高性能代码搜索 (ripgrep)。支持正则、多文件类型过滤、排除模式、大小写控制、全词匹配等高级选项。搜索大型代码库时优先使用此工具。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式搜索模式' },
        include: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '文件过滤 glob 模式，如 "*.ts" 或 ["*.ts", "*.tsx"]',
        },
        exclude: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '排除 glob 模式，如 "*.test.ts" 或 ["*.test.*", "*.spec.*"]',
        },
        context: { type: 'number', description: '上下文行数(前后各N行)，默认2' },
        max_results: { type: 'number', description: '最大结果数，默认50' },
        case_sensitive: { type: 'boolean', description: '区分大小写，默认false' },
        fixed_string: { type: 'boolean', description: '固定字符串搜索(非正则)，默认false' },
        whole_word: { type: 'boolean', description: '全词匹配，默认false' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'code_search_files',
    description: '按 glob 模式搜索文件名（基于 ripgrep --files）。比 glob_files 更快，且遵守 .gitignore。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob 模式，如 "*.ts"、"**/*config*"' },
        max_results: { type: 'number', description: '最大结果数，默认50' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_many_files',
    description: '按 glob 模式批量读取多个文件的内容。一次返回多个文件的带行号内容。适合快速了解多个相关文件。',
    parameters: {
      type: 'object',
      properties: {
        patterns: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Glob 模式（字符串或数组），如 "src/**/*.ts" 或 ["src/types.ts", "src/config.ts"]',
        },
        max_files: { type: 'number', description: '最多读取文件数，默认30' },
        max_lines_per_file: { type: 'number', description: '每文件最多行数，默认200' },
      },
      required: ['patterns'],
    },
  },
  {
    name: 'repo_map',
    description: '生成项目代码结构索引 — 提取所有函数签名、类定义、接口、export 等关键符号。快速了解整体项目架构。',
    parameters: {
      type: 'object',
      properties: {
        max_files: { type: 'number', description: '最多扫描文件数，默认80' },
        max_symbols: { type: 'number', description: '每文件最多符号数，默认20' },
        max_lines: { type: 'number', description: '总输出行数上限，默认300' },
      },
    },
  },
  {
    name: 'code_graph_query',
    description:
      '查询代码 import/export 依赖图。支持: summary(总览), depends_on(查依赖), depended_by(查被谁依赖), related(N跳关联文件)。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['summary', 'depends_on', 'depended_by', 'related'], description: '查询类型' },
        file: { type: 'string', description: '目标文件的相对路径（depends_on/depended_by/related 必填）' },
        hops: { type: 'number', description: 'related 查询的跳数，默认2' },
      },
      required: ['type'],
    },
  },
  {
    name: 'batch_edit',
    description:
      '对同一文件执行多次 str_replace 编辑（按顺序依次应用）。一次调用修改多处，减少轮次。每个编辑的 old_string 必须精确匹配。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对于工作区的文件路径' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: '要替换的原始文本（空字符串=追加到文件末尾）' },
              new_string: { type: 'string', description: '替换后的新文本' },
            },
            required: ['old_string', 'new_string'],
          },
          description: '编辑操作列表（按顺序应用）',
        },
      },
      required: ['path', 'edits'],
    },
  },
];
