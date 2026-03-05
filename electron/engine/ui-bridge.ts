/**
 * UI Bridge — 与 Electron 渲染进程的通信层
 *
 * sendToUI, addLog, notify, createStreamCallback
 * 从 orchestrator.ts 拆出 (v2.5)
 */

import { BrowserWindow, Notification } from 'electron';
import { getDb } from '../db';
import { createLogger } from './logger';
import type { StreamCallback } from './llm-client';

const log = createLogger('ui-bridge');

// ═══════════════════════════════════════
// 向渲染进程推送消息
// ═══════════════════════════════════════

export function sendToUI(win: BrowserWindow | null, channel: string, data: unknown) {
  try {
    win?.webContents.send(channel, data);
  } catch (_err) {
    log.debug('sendToUI failed (window likely closed)', { channel });
  }
  // v5.4: agent:log 消息自动持久化到 DB
  if (channel === 'agent:log') {
    const d = data as Record<string, unknown>;
    if (d?.projectId && d?.content) {
      try {
        const db = getDb();
        db.prepare('INSERT INTO agent_logs (project_id, agent_id, type, content) VALUES (?, ?, ?, ?)')
          .run(d.projectId as string, (d.agentId as string) || 'system', 'info', d.content as string);
      } catch (err) { /* silent: DB日志写入失败不应阻塞UI推送 */
        // 静默: 可能在批量日志输出时偶发 busy
        log.debug('// 静默: 可能在批量日志输出时偶发 busy', { error: String(err) });
      }
    }
  }
}

// ═══════════════════════════════════════
// DB 日志写入
// ═══════════════════════════════════════

export function addLog(projectId: string, agentId: string, type: string, content: string) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO agent_logs (project_id, agent_id, type, content) VALUES (?, ?, ?, ?)').run(projectId, agentId, type, content);
  } catch (_err) {
    log.warn('Failed to write agent log to DB', { projectId, agentId, type });
  }
}

// ═══════════════════════════════════════
// 系统原生通知
// ═══════════════════════════════════════

export function notify(title: string, body: string) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    }
  } catch (_err) {
    log.debug('Native notification failed', { title });
  }
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
