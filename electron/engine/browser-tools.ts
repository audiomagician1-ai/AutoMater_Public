/**
 * Browser Tools — Playwright 浏览器自动化 (v2.3)
 * 
 * 使用 playwright-core（不含浏览器二进制）+ 系统已安装的 Chrome/Edge
 * 单例管理：一次只能有一个浏览器实例，超时或空闲自动 cleanup
 * 
 * 用于 QA Agent 的 E2E 黑盒测试、网页交互验证
 */

import { chromium, type Browser, type Page, type BrowserContext, type Response as PwResponse } from 'playwright-core';
import type { A11yTreeNode } from './types';

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
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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
  } catch { /* silent: browser cleanup error — force-null refs */
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
  } catch (err: unknown) {
    return { success: false, title: '', url: '', error: err instanceof Error ? err.message : String(err) };
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
  } catch (err: unknown) {
    return { success: false, base64: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// browser_snapshot — 可访问性快照 (文本 DOM)
// ═══════════════════════════════════════

export async function browserSnapshot(): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    const page = await getPage();
    const snapshot = await (page as unknown as { accessibility: { snapshot(): Promise<A11yTreeNode> } }).accessibility.snapshot();
    const text = formatAccessibilityTree(snapshot, 0);
    return { success: true, content: text.slice(0, 8000) };
  } catch (err: unknown) {
    return { success: false, content: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function formatAccessibilityTree(node: A11yTreeNode, depth: number): string {
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
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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
  } catch (err: unknown) {
    return { success: false, result: '', error: err instanceof Error ? err.message : String(err) };
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
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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

    const handler = (response: PwResponse) => {
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
  } catch (err: unknown) {
    return { success: false, requests: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ═══════════════════════════════════════
// v7.0: 新增浏览器 API — 补齐与 EchoAgent 的差距
// ═══════════════════════════════════════

// ── browser_hover ──

export async function browserHover(
  selector: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    touch();
    await page.hover(selector, { timeout: 5000 });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── browser_select_option ──

export async function browserSelectOption(
  selector: string,
  values: string[],
): Promise<{ success: boolean; selected?: string[]; error?: string }> {
  try {
    const page = await getPage();
    touch();
    const selected = await page.selectOption(selector, values, { timeout: 5000 });
    return { success: true, selected };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── browser_press_key ──

export async function browserPressKey(
  key: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    touch();
    await page.keyboard.press(key);
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── browser_fill_form ──

export async function browserFillForm(
  fields: Array<{ selector: string; value: string; type?: 'text' | 'checkbox' | 'select' }>,
): Promise<{ success: boolean; filled: number; errors: string[]; }> {
  const page = await getPage();
  touch();
  let filled = 0;
  const errors: string[] = [];

  for (const field of fields) {
    try {
      const fieldType = field.type || 'text';
      if (fieldType === 'checkbox') {
        const checked = await page.isChecked(field.selector);
        const shouldCheck = field.value === 'true';
        if (checked !== shouldCheck) {
          await page.click(field.selector, { timeout: 3000 });
        }
      } else if (fieldType === 'select') {
        await page.selectOption(field.selector, field.value, { timeout: 3000 });
      } else {
        await page.fill(field.selector, field.value, { timeout: 3000 });
      }
      filled++;
    } catch (err: unknown) {
      errors.push(`${field.selector}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { success: errors.length === 0, filled, errors };
}

// ── browser_drag ──

export async function browserDrag(
  sourceSelector: string,
  targetSelector: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    touch();
    await page.dragAndDrop(sourceSelector, targetSelector, { timeout: 5000 });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── browser_tabs ──

export async function browserTabs(
  action: 'list' | 'new' | 'close' | 'select',
  opts?: { index?: number; url?: string },
): Promise<{ success: boolean; tabs?: Array<{ index: number; url: string; title: string }>; error?: string }> {
  try {
    if (!_context) {
      return { success: false, error: '浏览器未启动' };
    }
    touch();
    const pages = _context.pages();

    if (action === 'list') {
      const tabs = await Promise.all(pages.map(async (p, i) => ({
        index: i,
        url: p.url(),
        title: await p.title().catch(() => ''),
      })));
      return { success: true, tabs };
    }

    if (action === 'new') {
      const newPage = await _context.newPage();
      if (opts?.url) await newPage.goto(opts.url, { timeout: 15000 });
      _page = newPage;
      return { success: true };
    }

    if (action === 'close') {
      const idx = opts?.index ?? pages.indexOf(_page!);
      if (idx >= 0 && idx < pages.length) {
        await pages[idx].close();
        _page = _context.pages()[0] || null;
      }
      return { success: true };
    }

    if (action === 'select') {
      const idx = opts?.index ?? 0;
      if (idx >= 0 && idx < pages.length) {
        _page = pages[idx];
        await _page.bringToFront();
      }
      return { success: true };
    }

    return { success: false, error: `未知操作: ${action}` };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── browser_file_upload ──

export async function browserFileUpload(
  selector: string,
  filePaths: string[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const page = await getPage();
    touch();
    await page.setInputFiles(selector, filePaths, { timeout: 5000 });
    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── browser_console ──

export async function browserConsole(
  level: 'error' | 'warning' | 'info' | 'all',
): Promise<{ success: boolean; messages?: string[]; error?: string }> {
  try {
    const page = await getPage();
    touch();

    const messages: string[] = [];
    const handler = (msg: { type(): string; text(): string }) => {
      const msgType = msg.type();
      if (level === 'all'
        || (level === 'error' && msgType === 'error')
        || (level === 'warning' && (msgType === 'warning' || msgType === 'error'))
        || (level === 'info' && msgType !== 'debug')
      ) {
        messages.push(`[${msgType}] ${msg.text()}`);
      }
    };

    page.on('console', handler);
    await page.waitForTimeout(2000);
    page.off('console', handler);

    return { success: true, messages: messages.slice(0, 50) };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

