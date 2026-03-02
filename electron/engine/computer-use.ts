/**
 * Computer Use — 截图 + 鼠标 + 键盘控制 (v2.2)
 * 
 * Windows 实现：PowerShell + .NET System.Drawing / System.Windows.Forms
 * 零外部依赖（全部使用 Windows 内置 API）
 * 
 * 参考: Anthropic Computer Use (screenshot → action → screenshot loop)
 * 推荐分辨率: 1024x768 或 1280x720（降低 token 消耗）
 */

import { execSync } from 'child_process'; // SYNC-OK: 所有调用为 PowerShell GUI 操作 (截图/鼠标/键盘), 必须同步等待完成
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createLogger } from './logger';

const log = createLogger('computer-use');

// ═══════════════════════════════════════
// PowerShell Parameter Sanitization
// ═══════════════════════════════════════

/**
 * Sanitize a numeric parameter for PowerShell interpolation.
 * Prevents injection by ensuring the value is a finite number within bounds.
 */
function sanitizeNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

/**
 * Sanitize a string for safe inclusion in PowerShell single-quoted strings.
 * Replaces single-quotes with escaped form.
 */
function sanitizeForPS(str: string): string {
  return str.replace(/'/g, "''");
}

// ═══════════════════════════════════════
// screenshot — 截取屏幕
// ═══════════════════════════════════════

export interface ScreenshotResult {
  success: boolean;
  /** Base64 编码的 PNG 图像 */
  base64: string;
  width: number;
  height: number;
  error?: string;
}

/**
 * 截取整个屏幕（Windows）
 * 返回 base64 PNG 图像，可直接传给 LLM Vision API
 * 
 * @param scale 缩放比例 (0.5 = 缩小到50%，降低token消耗)
 */
export function takeScreenshot(scale: number = 0.75): ScreenshotResult {
  const safeScale = sanitizeNumber(scale, 0.1, 2.0, 0.75);
  const tmpFile = path.join(os.tmpdir(), `automater-screenshot-${Date.now()}.png`);
  const safeTmpPath = tmpFile.replace(/\\/g, '\\\\');

  try {
    // PowerShell: 使用 System.Drawing 截屏
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$scale = ${safeScale}
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = [int]($screen.Width * $scale)
$h = [int]($screen.Height * $scale)
$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$srcRect = New-Object System.Drawing.Rectangle(0, 0, $screen.Width, $screen.Height)
$dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
if ($scale -ne 1) {
  $scaled = New-Object System.Drawing.Bitmap($w, $h)
  $g2 = [System.Drawing.Graphics]::FromImage($scaled)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bitmap, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g2.Dispose()
  $bitmap.Dispose()
  $scaled.Save('${safeTmpPath}', [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
  Write-Output "$w,$h"
} else {
  $bitmap.Save('${safeTmpPath}', [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "$w,$h"
}
$graphics.Dispose()
`.trim();

    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    if (!fs.existsSync(tmpFile)) {
      return { success: false, base64: '', width: 0, height: 0, error: '截图文件未生成' };
    }

    const imageBuffer = fs.readFileSync(tmpFile);
    const base64 = imageBuffer.toString('base64');

    // 解析尺寸
    const [w, h] = output.split(',').map(Number);

    // 清理临时文件
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    return { success: true, base64, width: w || 0, height: h || 0 };
  } catch (err: unknown) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return { success: false, base64: '', width: 0, height: 0, error: (err instanceof Error ? err.message : String(err)) };
  }
}

// ═══════════════════════════════════════
// mouse — 鼠标操作
// ═══════════════════════════════════════

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * 移动鼠标到指定屏幕坐标
 */
export function mouseMove(x: number, y: number): { success: boolean; error?: string } {
  const safeX = sanitizeNumber(x, 0, 10000, 0);
  const safeY = sanitizeNumber(y, 0, 10000, 0);
  try {
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${safeX}, ${safeY})"`,
      { timeout: 5000 }
    );
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 在指定坐标执行鼠标点击
 * 使用 user32.dll SendInput 实现真实点击
 */
export function mouseClick(
  x: number, y: number, button: MouseButton = 'left', doubleClick: boolean = false,
): { success: boolean; error?: string } {
  const safeX = sanitizeNumber(x, 0, 10000, 0);
  const safeY = sanitizeNumber(y, 0, 10000, 0);
  // Whitelist button values to prevent injection
  const validButtons: Record<string, string> = {
    left:   '0x0002, 0x0004',
    right:  '0x0008, 0x0010',
    middle: '0x0020, 0x0040',
  };
  const flags = validButtons[button] || validButtons.left;
  const clickCount = doubleClick ? 2 : 1;

  try {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseInput {
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
"@
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${safeX}, ${safeY})
Start-Sleep -Milliseconds 50
for ($i = 0; $i -lt ${clickCount}; $i++) {
  [MouseInput]::mouse_event(${flags.split(',')[0].trim()}, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [MouseInput]::mouse_event(${flags.split(',')[1].trim()}, 0, 0, 0, [IntPtr]::Zero)
  if ($i -lt ${clickCount - 1}) { Start-Sleep -Milliseconds 80 }
}
`.trim();

    execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
      { timeout: 5000 }
    );
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}

// ═══════════════════════════════════════
// keyboard — 键盘操作
// ═══════════════════════════════════════

/**
 * 键入文本（模拟打字）
 * 使用 SendKeys 实现
 */
export function keyboardType(text: string): { success: boolean; error?: string } {
  // Length limit to prevent resource exhaustion
  if (text.length > 5000) {
    return { success: false, error: 'Text too long (max 5000 chars)' };
  }
  try {
    // 转义 SendKeys 特殊字符
    const escaped = text
      .replace(/([+^%~(){}])/g, '{$1}')
      .replace(/\n/g, '{ENTER}')
      .replace(/\t/g, '{TAB}');

    // Use single-quoted string in PS to prevent variable expansion
    const safeEscaped = sanitizeForPS(escaped);
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${safeEscaped}')"`,
      { timeout: 10000 }
    );
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 按组合键 (如 Ctrl+S, Alt+F4, Enter 等)
 * 
 * 格式: modifier+key 或单个键名
 * 支持: ctrl, alt, shift + 任意键
 * 示例: "ctrl+s", "alt+f4", "enter", "tab", "escape", "f5"
 */
export function keyboardHotkey(combo: string): { success: boolean; error?: string } {
  try {
    // 解析组合键
    const parts = combo.toLowerCase().split('+').map(s => s.trim());
    let sendKeysStr = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!isLast) {
        // modifier 键
        switch (part) {
          case 'ctrl': case 'control': sendKeysStr += '^'; break;
          case 'alt': sendKeysStr += '%'; break;
          case 'shift': sendKeysStr += '+'; break;
          case 'win': sendKeysStr += '^{ESC}'; break; // approximation
          default: sendKeysStr += part; break;
        }
      } else {
        // 最终键
        const keyMap: Record<string, string> = {
          'enter': '{ENTER}', 'return': '{ENTER}',
          'tab': '{TAB}',
          'escape': '{ESC}', 'esc': '{ESC}',
          'backspace': '{BACKSPACE}', 'bs': '{BACKSPACE}',
          'delete': '{DELETE}', 'del': '{DELETE}',
          'home': '{HOME}', 'end': '{END}',
          'pageup': '{PGUP}', 'pagedown': '{PGDN}',
          'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
          'space': ' ',
          'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
          'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
          'f9': '{F9}', 'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
        };
        sendKeysStr += keyMap[part] || part;
      }
    }

    execSync(
      `powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeysStr.replace(/'/g, "''")}')"`,
      { timeout: 5000 }
    );
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}
