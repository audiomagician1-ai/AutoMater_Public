/**
 * UI Bridge — 与 Electron 渲染进程的通信层
 *
 * sendToUI, addLog, notify, createStreamCallback
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { BrowserWindow, Notification } from 'electron';
import { getDb } from '../db';
import type { StreamCallback } from './llm-client';

// ═══════════════════════════════════════
// 向渲染进程推送消息
// ═══════════════════════════════════════

export function sendToUI(win: BrowserWindow | null, channel: string, data: any) {
  try { win?.webContents.send(channel, data); } catch { /* closed */ }
}

// ═══════════════════════════════════════
// DB 日志写入
// ═══════════════════════════════════════

export function addLog(projectId: string, agentId: string, type: string, content: string) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO agent_logs (project_id, agent_id, type, content) VALUES (?, ?, ?, ?)').run(projectId, agentId, type, content);
  } catch { /* ignore during shutdown */ }
}

// ═══════════════════════════════════════
// 系统原生通知
// ═══════════════════════════════════════

export function notify(title: string, body: string) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    }
  } catch { /* non-fatal */ }
}

// ═══════════════════════════════════════
// 流式回调工厂
// ═══════════════════════════════════════

/**
 * 创建流式回调: 每攒 N 个字符向 UI 推送一次 agent:stream 事件
 * 返回 [onChunk callback, getAccumulated]
 */
export function createStreamCallback(
  win: BrowserWindow | null,
  projectId: string,
  agentId: string,
  flushInterval: number = 80
): [StreamCallback, () => string] {
  let accumulated = '';
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (buffer.length > 0) {
      sendToUI(win, 'agent:stream', { projectId, agentId, chunk: buffer });
      buffer = '';
    }
    timer = null;
  };

  const onChunk = (chunk: string) => {
    accumulated += chunk;
    buffer += chunk;
    if (chunk.includes('\n') || buffer.length > 200) {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, flushInterval);
    }
  };

  return [onChunk, () => { flush(); return accumulated; }];
}
