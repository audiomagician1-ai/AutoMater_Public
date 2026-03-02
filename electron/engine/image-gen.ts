/**
 * Image Generation Module (v1.0)
 *
 * 支持多种图像生成后端:
 *   1. OpenAI DALL-E 3 / DALL-E 2
 *   2. OpenAI-compatible image API (如 Stable Diffusion WebUI + sd-webui-openai-compat)
 *   3. Gemini Imagen (via REST)
 *
 * 核心能力:
 *   - 文生图 (text-to-image)
 *   - 图编辑 (image edit / inpainting) — DALL-E 2 + mask
 *   - 图变体 (image variation) — DALL-E 2
 *   - 批量生成 + 最佳选择
 *
 * 输出: base64 PNG + 本地文件保存
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('image-gen');

// ═══════════════════════════════════════
// Types
// ═══════════════════════════════════════

export type ImageSize = '256x256' | '512x512' | '1024x1024' | '1024x1792' | '1792x1024';
export type ImageQuality = 'standard' | 'hd';
export type ImageStyle = 'vivid' | 'natural';

export interface ImageGenConfig {
  /** 图像生成 API provider */
  provider: 'openai' | 'gemini' | 'custom';
  /** API Key */
  apiKey: string;
  /** Base URL (OpenAI: https://api.openai.com, 自定义兼容 API: http://localhost:xxx) */
  baseUrl: string;
  /** 模型名 (dall-e-3, dall-e-2, gemini-2.0-flash-exp, 等) */
  model?: string;
}

export interface TextToImageRequest {
  /** 生成提示词 (英文效果更好) */
  prompt: string;
  /** 负面提示词 (仅自定义 API 支持) */
  negativePrompt?: string;
  /** 尺寸 */
  size?: ImageSize;
  /** 质量 (DALL-E 3 only) */
  quality?: ImageQuality;
  /** 风格 (DALL-E 3 only) */
  style?: ImageStyle;
  /** 生成数量 (DALL-E 3 最多 1, DALL-E 2 最多 10) */
  n?: number;
  /** 保存到本地路径 (可选) */
  savePath?: string;
}

export interface ImageEditRequest {
  /** 原始图像 base64 PNG */
  imageBase64: string;
  /** 蒙版图像 base64 PNG (透明区域 = 编辑区域) */
  maskBase64?: string;
  /** 编辑提示词 */
  prompt: string;
  /** 尺寸 */
  size?: ImageSize;
  /** 保存路径 */
  savePath?: string;
}

export interface ImageVariationRequest {
  /** 原始图像 base64 PNG */
  imageBase64: string;
  /** 生成数量 */
  n?: number;
  /** 尺寸 */
  size?: ImageSize;
  /** 保存路径 */
  savePath?: string;
}

export interface ImageGenResult {
  success: boolean;
  /** 生成的图像 base64 数组 */
  images: Array<{
    base64: string;
    /** DALL-E 3 会返回修改后的 prompt */
    revisedPrompt?: string;
  }>;
  /** 保存的本地文件路径列表 */
  savedPaths: string[];
  /** 错误信息 */
  error?: string;
  /** 耗时 ms */
  durationMs: number;
}

// ═══════════════════════════════════════
// Module-level config
// ═══════════════════════════════════════

let _config: ImageGenConfig | null = null;

/**
 * 配置图像生成引擎
 */
export function configureImageGen(config: ImageGenConfig): void {
  _config = { ...config };
  log.info(`Image gen configured: provider=${config.provider}, model=${config.model || 'default'}, baseUrl=${config.baseUrl}`);
}

/**
 * 获取当前配置
 */
export function getImageGenConfig(): ImageGenConfig | null {
  return _config ? { ..._config } : null;
}

/**
 * 是否已配置
 */
export function isImageGenAvailable(): boolean {
  return _config !== null && !!_config.apiKey;
}

// ═══════════════════════════════════════
// Text-to-Image
// ═══════════════════════════════════════

/**
 * 文生图
 */
export async function textToImage(req: TextToImageRequest, configOverride?: ImageGenConfig): Promise<ImageGenResult> {
  const config = configOverride || _config;
  if (!config) {
    return { success: false, images: [], savedPaths: [], error: '未配置图像生成引擎。请先调用 configure_image_gen。', durationMs: 0 };
  }

  const start = Date.now();

  try {
    switch (config.provider) {
      case 'openai':
      case 'custom':
        return await _openaiTextToImage(config, req, start);
      case 'gemini':
        return await _geminiTextToImage(config, req, start);
      default:
        return { success: false, images: [], savedPaths: [], error: `不支持的 provider: ${config.provider}`, durationMs: Date.now() - start };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`textToImage failed: ${msg}`);
    return { success: false, images: [], savedPaths: [], error: msg, durationMs: Date.now() - start };
  }
}

/**
 * 图像编辑 (inpainting)
 * 仅 DALL-E 2 / custom 支持
 */
export async function editImage(req: ImageEditRequest, configOverride?: ImageGenConfig): Promise<ImageGenResult> {
  const config = configOverride || _config;
  if (!config) {
    return { success: false, images: [], savedPaths: [], error: '未配置图像生成引擎', durationMs: 0 };
  }

  const start = Date.now();

  try {
    return await _openaiEditImage(config, req, start);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`editImage failed: ${msg}`);
    return { success: false, images: [], savedPaths: [], error: msg, durationMs: Date.now() - start };
  }
}

/**
 * 图像变体
 * 仅 DALL-E 2 / custom 支持
 */
export async function createVariation(req: ImageVariationRequest, configOverride?: ImageGenConfig): Promise<ImageGenResult> {
  const config = configOverride || _config;
  if (!config) {
    return { success: false, images: [], savedPaths: [], error: '未配置图像生成引擎', durationMs: 0 };
  }

  const start = Date.now();

  try {
    return await _openaiVariation(config, req, start);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`createVariation failed: ${msg}`);
    return { success: false, images: [], savedPaths: [], error: msg, durationMs: Date.now() - start };
  }
}

// ═══════════════════════════════════════
// OpenAI / Compatible API Implementation
// ═══════════════════════════════════════

function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.endsWith('/v1')) u = u.slice(0, -3);
  return u;
}

async function _openaiTextToImage(config: ImageGenConfig, req: TextToImageRequest, start: number): Promise<ImageGenResult> {
  const model = config.model || 'dall-e-3';
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = `${baseUrl}/v1/images/generations`;

  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    size: req.size || '1024x1024',
    response_format: 'b64_json',
    n: model === 'dall-e-3' ? 1 : Math.min(req.n || 1, 10),
  };

  if (model === 'dall-e-3') {
    if (req.quality) body.quality = req.quality;
    if (req.style) body.style = req.style;
  }

  // 自定义 API 支持 negative_prompt
  if (config.provider === 'custom' && req.negativePrompt) {
    body.negative_prompt = req.negativePrompt;
  }

  log.info(`OpenAI image gen: model=${model}, size=${body.size}, prompt="${req.prompt.slice(0, 80)}..."`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI image API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json() as {
    data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };

  const images = await Promise.all(
    data.data.map(async (item) => {
      let base64 = item.b64_json || '';
      // 如果返回 URL 而非 base64，下载转 base64
      if (!base64 && item.url) {
        base64 = await _downloadToBase64(item.url);
      }
      return {
        base64,
        revisedPrompt: item.revised_prompt,
      };
    }),
  );

  const savedPaths = await _saveImages(images.map(i => i.base64), req.savePath);
  const duration = Date.now() - start;

  log.info(`OpenAI image gen complete: ${images.length} images, ${duration}ms`);
  return { success: true, images, savedPaths, durationMs: duration };
}

async function _openaiEditImage(config: ImageGenConfig, req: ImageEditRequest, start: number): Promise<ImageGenResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = `${baseUrl}/v1/images/edits`;

  // DALL-E edit API 需要 multipart form
  const formData = new FormData();
  formData.append('image', _base64ToBlob(req.imageBase64, 'image/png'), 'image.png');
  if (req.maskBase64) {
    formData.append('mask', _base64ToBlob(req.maskBase64, 'image/png'), 'mask.png');
  }
  formData.append('prompt', req.prompt);
  formData.append('size', req.size || '1024x1024');
  formData.append('response_format', 'b64_json');
  formData.append('n', '1');
  if (config.model) formData.append('model', config.model);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI edit API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const images = await Promise.all(
    data.data.map(async (item) => ({
      base64: item.b64_json || (item.url ? await _downloadToBase64(item.url) : ''),
    })),
  );

  const savedPaths = await _saveImages(images.map(i => i.base64), req.savePath);
  return { success: true, images, savedPaths, durationMs: Date.now() - start };
}

async function _openaiVariation(config: ImageGenConfig, req: ImageVariationRequest, start: number): Promise<ImageGenResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const url = `${baseUrl}/v1/images/variations`;

  const formData = new FormData();
  formData.append('image', _base64ToBlob(req.imageBase64, 'image/png'), 'image.png');
  formData.append('n', String(Math.min(req.n || 1, 10)));
  formData.append('size', req.size || '1024x1024');
  formData.append('response_format', 'b64_json');
  if (config.model) formData.append('model', config.model);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI variation API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json() as { data: Array<{ b64_json?: string; url?: string }> };
  const images = await Promise.all(
    data.data.map(async (item) => ({
      base64: item.b64_json || (item.url ? await _downloadToBase64(item.url) : ''),
    })),
  );

  const savedPaths = await _saveImages(images.map(i => i.base64), req.savePath);
  return { success: true, images, savedPaths, durationMs: Date.now() - start };
}

// ═══════════════════════════════════════
// Gemini Imagen Implementation
// ═══════════════════════════════════════

async function _geminiTextToImage(config: ImageGenConfig, req: TextToImageRequest, start: number): Promise<ImageGenResult> {
  const model = config.model || 'gemini-2.0-flash-exp';
  const baseUrl = normalizeBaseUrl(config.baseUrl || 'https://generativelanguage.googleapis.com');
  // Gemini Imagen: POST /v1beta/models/{model}:generateContent
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

  const body = {
    contents: [{ parts: [{ text: req.prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  log.info(`Gemini image gen: model=${model}, prompt="${req.prompt.slice(0, 80)}..."`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inlineData?: { mimeType: string; data: string };
        }>;
      };
    }>;
  };

  const images: Array<{ base64: string; revisedPrompt?: string }> = [];
  let revisedText = '';

  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData?.data) {
        images.push({ base64: part.inlineData.data, revisedPrompt: revisedText || undefined });
      }
      if (part.text) {
        revisedText = part.text;
      }
    }
  }

  if (images.length === 0) {
    return { success: false, images: [], savedPaths: [], error: 'Gemini 未返回图像数据。可能因安全过滤被拒绝。', durationMs: Date.now() - start };
  }

  const savedPaths = await _saveImages(images.map(i => i.base64), req.savePath);
  const duration = Date.now() - start;

  log.info(`Gemini image gen complete: ${images.length} images, ${duration}ms`);
  return { success: true, images, savedPaths, durationMs: duration };
}

// ═══════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════

/**
 * 下载 URL 图像并转 base64
 */
async function _downloadToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载图像失败: ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

/**
 * base64 → Blob (用于 FormData)
 */
function _base64ToBlob(base64: string, mimeType: string): Blob {
  const buf = Buffer.from(base64, 'base64');
  return new Blob([buf], { type: mimeType });
}

/**
 * 保存图像到本地
 */
async function _saveImages(base64List: string[], basePath?: string): Promise<string[]> {
  if (!basePath) return [];

  const saved: string[] = [];
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath) || '.png';
  const name = path.basename(basePath, ext);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* exists */ }

  for (let i = 0; i < base64List.length; i++) {
    if (!base64List[i]) continue;
    const filePath = base64List.length === 1
      ? path.join(dir, `${name}${ext}`)
      : path.join(dir, `${name}_${i + 1}${ext}`);
    try {
      fs.writeFileSync(filePath, Buffer.from(base64List[i], 'base64'));
      saved.push(filePath);
      log.info(`Image saved: ${filePath} (${Math.round(Buffer.from(base64List[i], 'base64').length / 1024)}KB)`);
    } catch (err: unknown) {
      log.warn(`Failed to save image: ${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return saved;
}

// ═══════════════════════════════════════
// Prompt Enhancement (Optional Helper)
// ═══════════════════════════════════════

/**
 * 增强用户提示词 — 加入细节使图像生成更高质量
 * 这是一个可选的 helper，agent 可以直接使用或 LLM 自己优化 prompt
 */
export function enhancePrompt(userPrompt: string, context?: {
  type?: 'ui' | 'icon' | 'illustration' | 'photo' | 'diagram';
  colorScheme?: string;
  additionalDetails?: string;
}): string {
  const parts = [userPrompt];

  if (context?.type) {
    const typeHints: Record<string, string> = {
      ui: 'Clean modern UI mockup, professional design, high resolution.',
      icon: 'Flat design icon, clean lines, minimal style, suitable for app/web.',
      illustration: 'Digital illustration, detailed, professional quality.',
      photo: 'Photorealistic, high quality, professional photography.',
      diagram: 'Clear technical diagram, labeled, professional, white background.',
    };
    parts.push(typeHints[context.type] || '');
  }

  if (context?.colorScheme) {
    parts.push(`Color scheme: ${context.colorScheme}.`);
  }

  if (context?.additionalDetails) {
    parts.push(context.additionalDetails);
  }

  return parts.filter(Boolean).join(' ');
}
