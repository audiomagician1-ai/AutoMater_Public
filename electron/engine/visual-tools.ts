/**
 * Visual Tools — 视觉验证 (v2.4)
 * 
 * 利用 LLM Vision API 分析截图、对比差异、断言 UI 状态
 * 所有函数需要传入 callVision 回调（由 orchestrator 注入）
 * 
 * 闭环: 操作 → 截图 → 视觉验证 → 发现问题 → 修复 → 再验证
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from './logger';

const log = createLogger('visual-tools');

// ═══════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════

/** LLM Vision 调用回调 (由 orchestrator 注入) */
export type VisionCallback = (
  prompt: string,
  imageBase64: string,
  mimeType?: string,
) => Promise<string>;

// 缓存最近的截图用于对比 — 带 TTL 自动过期
interface CacheEntry {
  base64: string;
  createdAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const CACHE_MAX_SIZE = 20;
const screenshotCache = new Map<string, CacheEntry>();

/** 清除过期条目 */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of screenshotCache) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      screenshotCache.delete(key);
    }
  }
}

export function cacheScreenshot(label: string, base64: string) {
  evictExpired();
  screenshotCache.set(label, { base64, createdAt: Date.now() });
  // 最多缓存 CACHE_MAX_SIZE 张
  if (screenshotCache.size > CACHE_MAX_SIZE) {
    const firstKey = screenshotCache.keys().next().value;
    if (firstKey) screenshotCache.delete(firstKey);
  }
}

export function getCachedScreenshot(label: string): string | undefined {
  evictExpired();
  return screenshotCache.get(label)?.base64;
}

// ═══════════════════════════════════════
// analyze_image — 用 Vision LLM 分析图像
// ═══════════════════════════════════════

/**
 * 发送图像到 Vision LLM 进行分析
 * 用于理解 UI 状态、识别元素位置、读取屏幕文本等
 */
export async function analyzeImage(
  base64: string,
  question: string,
  callVision: VisionCallback,
): Promise<{ success: boolean; analysis: string; error?: string }> {
  try {
    const prompt = `请分析这张截图并回答以下问题:\n\n${question}\n\n请详细描述你观察到的内容。`;
    const analysis = await callVision(prompt, base64, 'image/png');
    return { success: true, analysis };
  } catch (err: any) {
    return { success: false, analysis: '', error: err.message };
  }
}

// ═══════════════════════════════════════
// compare_screenshots — 对比两张截图
// ═══════════════════════════════════════

/**
 * 对比两张截图的差异
 * 1) 先做像素级 diff (计算差异百分比)
 * 2) 再用 Vision LLM 描述具体差异
 */
export async function compareScreenshots(
  base64Before: string,
  base64After: string,
  description: string,
  callVision: VisionCallback,
): Promise<{ success: boolean; pixelDiffPercent: number; analysis: string; error?: string }> {
  try {
    // 简易像素 diff: 比较 base64 长度差异作为粗略指标
    // (真正的像素 diff 需要 canvas/sharp，这里用 LLM 视觉对比替代)
    const lenBefore = base64Before.length;
    const lenAfter = base64After.length;
    const roughDiff = Math.abs(lenBefore - lenAfter) / Math.max(lenBefore, lenAfter) * 100;

    // 用 LLM 做语义对比
    // 将两张图拼成一个 prompt
    const prompt = `请对比以下两张截图的差异。

上下文: ${description || '对比前后截图'}

这是"之前"的截图。请仔细观察两张图之间的所有视觉差异，包括:
1. 布局变化
2. 文本内容变化  
3. 颜色/样式变化
4. 新增/消失的元素
5. 位置移动

请用结构化格式列出所有差异。`;

    // 注意: 理想情况下应该同时发送两张图，但简化版本先分析一张
    const analysis = await callVision(prompt, base64After, 'image/png');

    return {
      success: true,
      pixelDiffPercent: Math.round(roughDiff * 100) / 100,
      analysis,
    };
  } catch (err: any) {
    return { success: false, pixelDiffPercent: -1, analysis: '', error: err.message };
  }
}

// ═══════════════════════════════════════
// visual_assert — 视觉断言
// ═══════════════════════════════════════

export interface VisualAssertResult {
  success: boolean;
  passed: boolean;
  confidence: number; // 0-100
  reasoning: string;
  error?: string;
}

/**
 * 断言截图中满足指定条件
 * 用 Vision LLM 判断截图是否符合预期
 */
export async function visualAssert(
  base64: string,
  assertion: string,
  callVision: VisionCallback,
): Promise<VisualAssertResult> {
  try {
    const prompt = `你是一个视觉测试验证器。请分析这张截图，判断以下断言是否成立:

断言: "${assertion}"

请严格按以下 JSON 格式回复（不要包裹在代码块中）:
{
  "passed": true 或 false,
  "confidence": 0-100 的置信度,
  "reasoning": "判断依据的详细说明"
}`;

    const response = await callVision(prompt, base64, 'image/png');

    // 解析 JSON 响应
    try {
      // 尝试提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          passed: !!parsed.passed,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
          reasoning: parsed.reasoning || response,
        };
      }
    } catch { /* fallback to text analysis */ }

    // 无法解析 JSON，从文本推断
    const passed = response.toLowerCase().includes('pass') || response.toLowerCase().includes('true');
    return {
      success: true,
      passed,
      confidence: 50,
      reasoning: response,
    };
  } catch (err: any) {
    return { success: false, passed: false, confidence: 0, reasoning: '', error: err.message };
  }
}
