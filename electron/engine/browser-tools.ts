/**
 * Browser Tools — Playwright 浏览器自动化 (v2.3)
 * 
 * 使用 playwright-core（不含浏览器二进制）+ 系统已安装的 Chrome/Edge
 * 单例管理：一次只能有一个浏览器实例，超时或空闲自动 cleanup
 * 
 * 用于 QA Agent 的 E2E 黑盒测试、网页交互验证
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-core';

// ═══════════════════════════════════════
// 单例浏览器管理
// ═══════════════════════════════════════

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;
let _lastActivity = 0;

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 分钟无操作自动关闭

// 自动清理定时器
let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanupTimer() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    if (_browser && Date.now() - _lastActivity > IDLE_TIMEOUT) {
      closeBrowser().catch(() => {});
    }
  }, 30_000);
}

function touch() {
  _lastActivity = Date.now();
}

// ═══════════════════════════════════════
// browser_launch — 启动浏览器
// ═══════════════════════════════════════

export async function launchBrowser(opts?: {
  headless?: boolean;
  viewport?: { width: number; height: number };
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (_browser?.isConnected()) {
      return { success: true }; // 已有浏览器实例
    }

    // 查找系统浏览器：优先 Edge → Chrome
    const channel = process.platform === 'win32' ? 'msedge' : 'chrome';

    _browser = await chromium.launch({
      channel,
      headless: opts?.headless ?? false, // 默认有头模式（可以截图看到）
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    _context = await _browser.newContext({
      viewport: opts?.viewport || { width: 1280, height: 720 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    _page = await _context.newPage();
    touch();
    startCleanupTimer();

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_close — 关闭浏览器
// ═══════════════════════════════════════

export async function closeBrowser(): Promise<{ success: boolean }> {
  try {
    if (_page) { await _page.close().catch(() => {}); _page = null; }
    if (_context) { await _context.close().catch(() => {}); _context = null; }
    if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
    if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null; }
    return { success: true };
  } catch {
    _page = null; _context = null; _browser = null;
    return { success: true };
  }
}

/** 获取当前 page，如果没有则自动 launch */
async function getPage(): Promise<Page> {
  if (!_page || !_browser?.isConnected()) {
    await launchBrowser();
  }
  if (!_page) throw new Error('浏览器未就绪');
  touch();
  return _page;
}

// ═══════════════════════════════════════
// browser_navigate — 导航到 URL
// ═══════════════════════════════════════

export async function navigate(url: string): Promise<{ success: boolean; title: string; url: string; error?: string }> {
  try {
    const page = await getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    return { success: true, title, url: page.url() };
  } catch (err: any) {
    return { success: false, title: '', url: '', error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_screenshot — 截取页面截图
// ═══════════════════════════════════════

export async function browserScreenshot(fullPage: boolean = false): Promise<{
  success: boolean; base64: string; error?: string;
}> {
  try {
    const page = await getPage();
    const buffer = await page.screenshot({ fullPage, type: 'png' });
    return { success: true, base64: buffer.toString('base64') };
  } catch (err: any) {
    return { success: false, base64: '', error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_snapshot — 可访问性快照 (文本 DOM)
// ═══════════════════════════════════════

export async function browserSnapshot(): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    const page = await getPage();
    const snapshot = await (page as any).accessibility.snapshot();
    const text = formatAccessibilityTree(snapshot, 0);
    return { success: true, content: text.slice(0, 8000) };
  } catch (err: any) {
    return { success: false, content: '', error: err.message };
  }
}

function formatAccessibilityTree(node: any, depth: number): string {
  if (!node) return '';
  const indent = '  '.repeat(depth);
  let line = `${indent}[${node.role}]`;
  if (node.name) line += ` "${node.name}"`;
  if (node.value) line += ` value="${node.value}"`;
  let result = line + '\n';
  if (node.children) {
    for (const child of node.children) {
      result += formatAccessibilityTree(child, depth + 1);
    }
  }
  return result;
}

// ═══════════════════════════════════════
// browser_click — 点击元素
// ═══════════════════════════════════════

export async function browserClick(
  selector: string,
  options?: { button?: 'left' | 'right' | 'middle' },
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    await page.click(selector, { button: options?.button || 'left', timeout: 10000 });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_type — 在元素中输入文本
// ═══════════════════════════════════════

export async function browserType(
  selector: string,
  text: string,
  options?: { clear?: boolean },
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    if (options?.clear) {
      await page.fill(selector, text, { timeout: 10000 });
    } else {
      await page.type(selector, text, { timeout: 10000 });
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_evaluate — 执行 JS 代码
// ═══════════════════════════════════════

export async function browserEvaluate(
  expression: string,
): Promise<{ success: boolean; result: string; error?: string }> {
  try {
    const page = await getPage();
    const result = await page.evaluate(expression);
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { success: true, result: (output || '(undefined)').slice(0, 5000) };
  } catch (err: any) {
    return { success: false, result: '', error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_wait — 等待条件
// ═══════════════════════════════════════

export async function browserWait(
  options: { selector?: string; text?: string; timeout?: number },
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    const timeout = options.timeout || 10000;

    if (options.selector) {
      await page.waitForSelector(options.selector, { timeout });
    } else if (options.text) {
      await page.waitForFunction(
        (t: string) => document.body.innerText.includes(t),
        options.text,
        { timeout },
      );
    } else {
      await page.waitForTimeout(Math.min(timeout, 5000));
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════
// browser_network — 查看网络请求
// ═══════════════════════════════════════

export async function browserNetwork(
  options?: { urlPattern?: string },
): Promise<{ success: boolean; requests: string; error?: string }> {
  try {
    const page = await getPage();

    // 收集接下来 5 秒的请求
    const requests: Array<{ method: string; url: string; status: number }> = [];

    const handler = (response: any) => {
      const req = response.request();
      const url = req.url();
      if (options?.urlPattern && !url.includes(options.urlPattern)) return;
      // 跳过静态资源
      const resType = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(resType)) return;

      requests.push({
        method: req.method(),
        url: url.length > 100 ? url.slice(0, 100) + '...' : url,
        status: response.status(),
      });
    };

    page.on('response', handler);
    await page.waitForTimeout(3000);
    page.off('response', handler);

    if (requests.length === 0) {
      return { success: true, requests: '(3秒内无网络请求)' };
    }

    const lines = requests.slice(0, 30).map(
      r => `${r.method} ${r.status} ${r.url}`
    );
    return { success: true, requests: lines.join('\n') };
  } catch (err: any) {
    return { success: false, requests: '', error: err.message };
  }
}
