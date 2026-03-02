/**
 * Web search, fetch, HTTP & download tool definitions.
 */
import type { ToolDef } from './types';

export const WEB_TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    description: '搜索互联网。用于查找文档、API 用法、错误解决方案、最佳实践等。返回 Markdown 格式的搜索结果。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（建议用英文，结果更全面）' },
        max_results: { type: 'number', description: '最大结果数，默认 8', default: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: '抓取网页内容并转为 Markdown 纯文本。用于阅读文档页面、API 参考、博客文章等。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL（必须 http:// 或 https:// 开头）' },
        max_length: { type: 'number', description: '最大返回字符数，默认 15000', default: 15000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'http_request',
    description: '发送任意 HTTP 请求。用于测试 API 接口、调用 webhook、验证服务端响应等。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '请求 URL' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP 方法，默认 GET',
          default: 'GET',
        },
        headers: { type: 'object', description: '请求头 (key-value 对象)' },
        body: { type: 'string', description: '请求体（JSON 字符串或文本）' },
        timeout: { type: 'number', description: '超时毫秒数，默认 30000，最大 60000', default: 30000 },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_file',
    description: '从 URL 下载文件（二进制安全）到 workspace。支持图片、PDF、压缩包等任意格式。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的文件 URL' },
        save_path: { type: 'string', description: '保存路径（相对 workspace 或绝对路径）' },
        filename: { type: 'string', description: '可选文件名' },
        timeout: { type: 'number', description: '下载超时 ms，默认 60000', default: 60000 },
        max_size: { type: 'number', description: '最大文件大小 bytes，默认 50MB', default: 52428800 },
      },
      required: ['url', 'save_path'],
    },
  },
  {
    name: 'search_images',
    description: '搜索网络图片。返回图片 URL 列表。配合 download_file 可实现「搜索 → 下载」。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '图片搜索关键词' },
        count: { type: 'number', description: '返回数量，默认 5，最大 20', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search_boost',
    description:
      '增强搜索：并行查询多个搜索引擎 (Brave/SearXNG/Serper/Jina)，结果去重合并，多引擎交叉验证的结果排名更高。用于重要查询。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        max_results: { type: 'number', description: '最大结果数，默认 15', default: 15 },
      },
      required: ['query'],
    },
  },
  {
    name: 'deep_research',
    description:
      '深度研究：对复杂问题进行多轮搜索、源页面深度提取、LLM 综合分析、事实交叉验证。输出完整研究报告。\n适合：技术选型调研、竞品分析、最佳实践研究、复杂 bug 根因分析。\n深度: quick(1轮) / standard(2轮) / deep(3轮+fact-check)。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '研究问题（越具体越好）' },
        context: { type: 'string', description: '额外上下文（项目背景、技术栈等）' },
        depth: {
          type: 'string',
          enum: ['quick', 'standard', 'deep'],
          description: '研究深度，默认 standard',
          default: 'standard',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'configure_search',
    description:
      '配置搜索引擎 API Keys。配置后搜索质量将大幅提升。\n推荐: Brave Search (免费 2000次/月)、Serper.dev (免费 2500次/月)。\nSearXNG 适合完全离线 LAN 部署。',
    parameters: {
      type: 'object',
      properties: {
        brave_api_key: { type: 'string', description: 'Brave Search API Key' },
        searxng_url: { type: 'string', description: 'SearXNG 实例 URL (如 http://localhost:8888)' },
        tavily_api_key: { type: 'string', description: 'Tavily API Key' },
        serper_api_key: { type: 'string', description: 'Serper.dev API Key' },
      },
    },
  },
];
