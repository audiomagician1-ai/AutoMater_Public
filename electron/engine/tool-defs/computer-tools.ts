/**
 * Computer use, browser automation & visual verification tool definitions.
 */
import type { ToolDef } from './types';

export const COMPUTER_TOOLS: ToolDef[] = [
  // ── Computer Use ──
  {
    name: 'screenshot',
    description: '截取当前屏幕截图。返回 base64 PNG 图像。用于查看桌面应用界面、验证 UI 状态。',
    parameters: {
      type: 'object',
      properties: {
        scale: { type: 'number', description: '缩放比例 (0.5=50%, 1=原始尺寸)，默认 0.75', default: 0.75 },
      },
    },
  },
  {
    name: 'mouse_click',
    description: '在指定屏幕坐标执行鼠标点击。配合 screenshot 使用：先截图分析界面，确定目标坐标，再点击。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标 (像素)' },
        y: { type: 'number', description: '屏幕 Y 坐标 (像素)' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: '鼠标按键，默认 left',
          default: 'left',
        },
        double_click: { type: 'boolean', description: '是否双击，默认 false', default: false },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_move',
    description: '移动鼠标到指定屏幕坐标（不点击）。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 X 坐标' },
        y: { type: 'number', description: '屏幕 Y 坐标' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'keyboard_type',
    description: '在当前焦点窗口键入文本。先用 mouse_click 点击目标输入框，再用此工具输入文本。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要输入的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'keyboard_hotkey',
    description: '按组合键或特殊键。格式: "modifier+key"。示例: "ctrl+s", "alt+f4", "enter", "tab"。',
    parameters: {
      type: 'object',
      properties: { combo: { type: 'string', description: '按键组合，如 "ctrl+s"、"enter"' } },
      required: ['combo'],
    },
  },

  // ── Playwright Browser ──
  {
    name: 'browser_launch',
    description: '启动浏览器实例（使用系统已安装的 Edge/Chrome）。',
    parameters: {
      type: 'object',
      properties: { headless: { type: 'boolean', description: '是否无头模式，默认 false', default: false } },
    },
  },
  {
    name: 'browser_navigate',
    description: '浏览器导航到指定 URL。返回页面标题和实际 URL。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要访问的 URL' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: '截取当前浏览器页面的截图。返回 base64 PNG。',
    parameters: {
      type: 'object',
      properties: { full_page: { type: 'boolean', description: '是否截取整页，默认 false', default: false } },
    },
  },
  {
    name: 'browser_snapshot',
    description: '获取页面可访问性快照（文本 DOM 树）。比截图更省 token。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: '点击页面元素。使用 CSS 选择器或文本内容定位。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器或 Playwright 选择器' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: '在页面输入框中输入文本。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框的 CSS 选择器' },
        text: { type: 'string', description: '要输入的文本' },
        clear: { type: 'boolean', description: '是否先清空再输入，默认 false', default: false },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_evaluate',
    description: '在页面中执行 JavaScript 代码。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JavaScript 表达式或代码块' } },
      required: ['expression'],
    },
  },
  {
    name: 'browser_wait',
    description: '等待页面条件满足（元素出现、文本出现、或等待指定时间）。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '等待的元素 CSS 选择器' },
        text: { type: 'string', description: '等待页面中出现的文本' },
        timeout: { type: 'number', description: '超时毫秒数，默认 10000', default: 10000 },
      },
    },
  },
  {
    name: 'browser_network',
    description: '查看浏览器网络请求（最近 3 秒）。',
    parameters: {
      type: 'object',
      properties: { url_pattern: { type: 'string', description: '过滤 URL 包含的字符串' } },
    },
  },
  {
    name: 'browser_close',
    description: '关闭浏览器实例。在测试完成后调用以释放资源。',
    parameters: { type: 'object', properties: {} },
  },

  // ── Visual Verification ──
  {
    name: 'analyze_image',
    description: '用 AI 视觉分析图像内容。配合 screenshot / browser_screenshot 使用。',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '要分析的图像标签，默认 "latest"', default: 'latest' },
        question: { type: 'string', description: '要分析的问题' },
      },
      required: ['question'],
    },
  },
  {
    name: 'compare_screenshots',
    description: '对比两张截图的差异。用于 UI 回归测试。',
    parameters: {
      type: 'object',
      properties: {
        before_label: { type: 'string', description: '"之前" 截图的标签' },
        after_label: { type: 'string', description: '"之后" 截图的标签，默认 "latest"', default: 'latest' },
        description: { type: 'string', description: '对比的上下文描述' },
      },
      required: ['before_label'],
    },
  },
  {
    name: 'visual_assert',
    description: '视觉断言：验证截图是否满足指定条件。返回 pass/fail 和置信度。',
    parameters: {
      type: 'object',
      properties: {
        image_label: { type: 'string', description: '要验证的图像标签，默认 "latest"', default: 'latest' },
        assertion: { type: 'string', description: '要验证的条件描述' },
      },
      required: ['assertion'],
    },
  },

  // ── Browser Enhancements (v7.0) ──
  {
    name: 'browser_hover',
    description: '悬停在页面元素上（触发 tooltip / dropdown 等）。',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_select_option',
    description: '在下拉框中选择选项。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '下拉框 CSS 选择器' },
        values: { type: 'array', items: { type: 'string' }, description: '要选择的值' },
      },
      required: ['selector', 'values'],
    },
  },
  {
    name: 'browser_press_key',
    description: '按键盘键，如 ArrowDown、Escape、Enter、Tab 等。',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: '按键名（如 ArrowDown, Escape, Enter, Tab, Backspace）' } },
      required: ['key'],
    },
  },
  {
    name: 'browser_fill_form',
    description: '批量填写表单（多个字段一次调用）。支持文本框、复选框、下拉框。',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: '字段 CSS 选择器' },
              value: { type: 'string', description: '填入的值（checkbox 用 true/false）' },
              type: { type: 'string', enum: ['text', 'checkbox', 'select'], description: '字段类型，默认 text' },
            },
            required: ['selector', 'value'],
          },
          description: '表单字段列表',
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'browser_drag',
    description: '拖放操作（从一个元素拖到另一个元素）。',
    parameters: {
      type: 'object',
      properties: {
        source_selector: { type: 'string', description: '源元素 CSS 选择器' },
        target_selector: { type: 'string', description: '目标元素 CSS 选择器' },
      },
      required: ['source_selector', 'target_selector'],
    },
  },
  {
    name: 'browser_tabs',
    description: '管理浏览器标签页。操作: list(列出)、new(新建)、close(关闭)、select(切换)。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'close', 'select'], description: '操作类型' },
        index: { type: 'number', description: '标签页索引（close/select 时使用）' },
        url: { type: 'string', description: '新标签页的 URL（new 时使用）' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_file_upload',
    description: '上传文件到页面的文件输入框。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '文件输入框 CSS 选择器（input[type=file]）' },
        file_paths: { type: 'array', items: { type: 'string' }, description: '要上传的文件路径列表' },
      },
      required: ['selector', 'file_paths'],
    },
  },
  {
    name: 'browser_console',
    description: '获取浏览器控制台日志（用于调试）。',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'all'],
          description: '日志级别过滤，默认 info',
          default: 'info',
        },
      },
    },
  },
];
