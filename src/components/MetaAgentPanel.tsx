/**
 * MetaAgentPanel — 全局右侧可伸缩元Agent对话面板
 *
 * 收起时: 窄条 (40px) 带 🤖 图标按钮
 * 展开时: 1/5 宽度 (~280px) 带完整对话
 *
 * v5.4: 使用 Zustand store 持久化消息 + 真实 LLM 后端
 * v7.0: 名字后加管理入口按钮 + 动态名字/开场白
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore, type MetaAgentMessage } from '../stores/app-store';
import { MetaAgentSettings } from './MetaAgentSettings';
import { AgentWorkFeed } from './AgentWorkFeed';
import { friendlyErrorMessage } from '../utils/errors';
import { renderMarkdown } from '../utils/markdown';

const EMPTY_WORK_MSGS: readonly unknown[] = [];

/* ── 附件类型 ── */
interface Attachment {
  type: 'image' | 'file';
  name: string;
  data: string;
  mimeType: string;
  preview?: string;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i.test(mime);
}

const MAX_ATTACH_SIZE = 20 * 1024 * 1024;

export function MetaAgentPanel() {
  const open = useAppStore(s => s.metaAgentPanelOpen);
  const toggle = useAppStore(s => s.toggleMetaAgentPanel);
  const currentProjectId = useAppStore(s => s.currentProjectId);
  const messagesMap = useAppStore(s => s.metaAgentMessages);
  const addMessage = useAppStore(s => s.addMetaAgentMessage);
  const updateLastAssistant = useAppStore(s => s.updateLastAssistantMessage);
  const settingsOpen = useAppStore(s => s.metaAgentSettingsOpen);
  const setSettingsOpen = useAppStore(s => s.setMetaAgentSettingsOpen);

  const chatKey = currentProjectId || '_global';
  const messages = messagesMap.get(chatKey) || [];

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [agentName, setAgentName] = useState('元Agent · 管家');
  const [greeting, setGreeting] = useState('你好！我是元Agent管家。告诉我你的需求，或问我任何项目相关的问题。');
  const [showToolActivity, setShowToolActivity] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const metaAgentWorkMsgsRaw = useAppStore(s => s.agentWorkMessages.get('meta-agent'));
  const metaAgentWorkMsgs = metaAgentWorkMsgsRaw ?? EMPTY_WORK_MSGS;

  // Load config to get agent name and greeting
  useEffect(() => {
    window.automater.metaAgent.getConfig().then((config: MetaAgentConfig) => {
      if (config.name) setAgentName(config.name);
      if (config.greeting) setGreeting(config.greeting);
    }).catch(() => {});
  }, [settingsOpen]); // Refresh when settings close

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── 文件处理 ── */
  const processFiles = useCallback(async (files: FileList | File[]) => {
    const newAtts: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_ATTACH_SIZE) continue;
      try {
        const dataUri = await readFileAsBase64(file);
        const isImg = isImageMime(file.type);
        newAtts.push({ type: isImg ? 'image' : 'file', name: file.name, data: dataUri, mimeType: file.type || 'application/octet-stream', preview: isImg ? dataUri : undefined });
      } catch { /* skip */ }
    }
    if (newAtts.length) setAttachments(prev => [...prev, ...newAtts].slice(0, 5));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) { if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); } }
    if (files.length) { e.preventDefault(); processFiles(files); }
  }, [processFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) processFiles(e.dataTransfer.files); }, [processFiles]);
  const removeAttachment = useCallback((idx: number) => { setAttachments(prev => prev.filter((_, i) => i !== idx)); }, []);

  const greetingMessage: MetaAgentMessage = {
    id: 'greeting',
    role: 'assistant',
    content: greeting,
    timestamp: Date.now(),
  };

  const handleSend = async () => {
    if ((!input.trim() && attachments.length === 0) || sending) return;
    const text = input.trim() || (attachments.length ? `[发送了 ${attachments.length} 个附件]` : '');
    const curAtts = [...attachments];
    const userMsg: MetaAgentMessage = {
      id: String(Date.now()), role: 'user', content: text, timestamp: Date.now(),
      attachments: curAtts.length ? curAtts.map(a => ({ type: a.type, name: a.name, data: a.data, mimeType: a.mimeType })) : undefined,
    };
    addMessage(chatKey, userMsg);
    setInput(''); setAttachments([]); setSending(true);

    addMessage(chatKey, { id: String(Date.now() + 1), role: 'assistant', content: '思考中...', timestamp: Date.now() });

    try {
      const history = messages.slice(-20).map(m => {
        if (m.attachments?.length) {
          const blocks: Array<Record<string, unknown>> = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const att of m.attachments) { if (att.type === 'image') blocks.push({ type: 'image_url', image_url: { url: att.data } }); }
          return { role: m.role as string, content: blocks };
        }
        return { role: m.role as string, content: m.content as string | Array<Record<string, unknown>> };
      });
      const ipcAtts = curAtts.length ? curAtts.map(a => ({ type: a.type, name: a.name, data: a.data, mimeType: a.mimeType })) : undefined;
      const result = await window.automater.metaAgent.chat(currentProjectId, text || '[附件]', history, ipcAtts);
      updateLastAssistant(chatKey, result.reply);
      if (result.wishCreated) window.dispatchEvent(new CustomEvent('meta-agent:wish-created'));
    } catch (err: unknown) {
      updateLastAssistant(chatKey, `❌ 错误: ${friendlyErrorMessage(err) || '未知'}`);
    } finally {
      setSending(false);
    }
  };

  const displayMessages = messages.length === 0 ? [greetingMessage] : messages;

  return (
    <>
      <div
        className={`h-full border-l border-slate-800 flex flex-col bg-slate-950 transition-all duration-300 ease-in-out relative ${
          open ? 'w-[280px]' : 'w-[40px]'
        } flex-shrink-0`}
        onDragOver={open ? handleDragOver : undefined}
        onDragLeave={open ? handleDragLeave : undefined}
        onDrop={open ? handleDrop : undefined}
      >
        {/* Toggle button bar */}
        <div className="h-10 flex items-center border-b border-slate-800 shrink-0">
          <button
            onClick={toggle}
            className="flex-1 h-full flex items-center justify-center gap-1.5 hover:bg-slate-900 transition-colors"
            title={open ? '收起管家面板' : '展开管家面板'}
          >
            {open ? (
              <>
                <span className="text-xs">🤖</span>
                <span className="text-[11px] text-slate-400 font-medium flex-1 text-left truncate">{agentName}</span>
              </>
            ) : (
              <span className="text-sm" title={agentName}>🤖</span>
            )}
          </button>
          {open && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); setSettingsOpen(true); }}
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 rounded-lg transition-all mr-0.5"
                title="管家设置"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
              <button
                onClick={toggle}
                className="w-8 h-8 flex items-center justify-center text-slate-600 hover:text-slate-400 transition-colors mr-1"
                title="收起"
              >
                <span className="text-xs">▸</span>
              </button>
            </>
          )}
        </div>

        {open && (
          <>
            {/* Drag overlay */}
            {dragOver && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-forge-600/20 border-2 border-dashed border-forge-500 rounded-lg pointer-events-none">
                <div className="text-forge-300 text-sm font-medium">松开以添加附件</div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
              {displayMessages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[90%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-forge-600/20 text-forge-200 rounded-br-sm whitespace-pre-wrap'
                        : 'bg-slate-800/80 text-slate-300 rounded-bl-sm'
                    }`}
                  >
                    {/* v19.0: 附件预览 */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        {msg.attachments.map((att, i) => att.type === 'image'
                          ? <img key={i} src={att.data} alt={att.name} className="max-w-[120px] max-h-[80px] rounded border border-slate-600 object-cover" />
                          : <div key={i} className="flex items-center gap-1 bg-slate-700/50 rounded px-1.5 py-0.5"><span className="text-[10px]">📎</span><span className="text-[10px] text-slate-400 truncate max-w-[100px]">{att.name}</span></div>
                        )}
                      </div>
                    )}
                    {msg.role === 'assistant'
                      ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                      : msg.content
                    }
                    {msg.triggeredWish && (
                      <div className="mt-0.5 text-[9px] text-emerald-400">✅ 已创建需求</div>
                    )}
                    <div className={`text-[8px] mt-0.5 ${msg.role === 'user' ? 'text-forge-400/40 text-right' : 'text-slate-600'}`}>
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* v6.1: Tool activity indicator — 管家使用工具时的实时展示 */}
            {(sending || metaAgentWorkMsgs.length > 0) && (
              <div className="shrink-0 border-t border-slate-800">
                <button
                  onClick={() => setShowToolActivity(!showToolActivity)}
                  className="w-full flex items-center gap-2 px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-800/50 transition-colors"
                >
                  {sending && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                  <span>🧠 工具活动 ({metaAgentWorkMsgs.length})</span>
                  <span className={`ml-auto transition-transform ${showToolActivity ? 'rotate-180' : ''}`}>▾</span>
                </button>
                {showToolActivity && (
                  <div style={{ maxHeight: '160px' }} className="overflow-y-auto">
                    <AgentWorkFeed agentId="meta-agent" compact maxHeight="160px" />
                  </div>
                )}
              </div>
            )}

            {/* v19.0: 附件预览条 */}
            {attachments.length > 0 && (
              <div className="shrink-0 px-2 py-1 border-t border-slate-800 flex gap-1 overflow-x-auto">
                {attachments.map((att, i) => (
                  <div key={i} className="relative group flex-shrink-0">
                    {att.preview
                      ? <img src={att.preview} alt={att.name} className="w-10 h-10 rounded border border-slate-600 object-cover" />
                      : <div className="w-10 h-10 rounded border border-slate-600 bg-slate-800 flex items-center justify-center" title={att.name}><span className="text-[10px]">📄</span></div>}
                    <button onClick={() => removeAttachment(i)} className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-600 rounded-full text-[8px] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                  </div>
                ))}
              </div>
            )}

            {/* Input */}
            <div className="shrink-0 px-2 py-1.5 border-t border-slate-800">
              <input ref={fileInputRef} type="file" multiple accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.py,.css,.html,.yml,.yaml" className="hidden" onChange={e => { if (e.target.files?.length) processFiles(e.target.files); e.target.value = ''; }} />
              <div className="flex gap-1">
                <button onClick={() => fileInputRef.current?.click()} className="px-1.5 py-1.5 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-forge-400 transition-all shrink-0" title="添加图片或文件" disabled={sending}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                </button>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  onPaste={handlePaste}
                  placeholder={attachments.length ? `${attachments.length}个附件 — 输入消息...` : '发消息...'}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors"
                  disabled={sending}
                />
                <button
                  onClick={handleSend}
                  disabled={(!input.trim() && !attachments.length) || sending}
                  className="px-2 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs transition-all disabled:bg-slate-800 disabled:text-slate-600 shrink-0"
                >
                  {sending ? '·' : '↑'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Settings Modal */}
      {settingsOpen && <MetaAgentSettings onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

