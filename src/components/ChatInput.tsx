/**
 * ChatInput v29.0 — 可复用的聊天输入组件
 *
 * 支持:
 * - 文本输入 (Enter发送, Shift+Enter换行)
 * - 📎 附件按钮 (图片/文件)
 * - 拖拽上传 (输入栏 + 父组件委托整面板拖拽)
 * - 粘贴上传 (图片, textarea + 父组件委托整面板粘贴)
 * - 附件预览条 (图片缩略图 + 文件图标)
 * - useImperativeHandle 暴露 addFilesFromDrop / addImageFromClipboard 供父组件调用
 */

import {
  useState,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
  type DragEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';

export interface ChatAttachment {
  type: 'image' | 'file';
  name: string;
  data: string; // base64 data URL for images, file path for files
  mimeType: string;
  size?: number;
}

/** 父组件可通过 ref 调用的方法 */
export interface ChatInputHandle {
  /** 从 DragEvent.dataTransfer.files 添加附件 (Electron file.path) */
  addFilesFromDrop: (files: FileList) => Promise<void>;
  /** 从 ClipboardEvent.clipboardData.items 添加图片 */
  addImageFromClipboard: (items: DataTransferItemList) => void;
  /** 聚焦输入框 */
  focus: () => void;
}

interface ChatInputProps {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  sending?: boolean;
  placeholder?: string;
  /** 紧凑模式 (MetaAgentPanel侧边栏用) */
  compact?: boolean;
  disabled?: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, sending, placeholder, compact, disabled },
  ref,
) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addAttachments = useCallback(async (filePaths: string[]) => {
    const newAtts: ChatAttachment[] = [];
    for (const fp of filePaths) {
      try {
        const result = await window.automater.dialog.readFileBase64(fp);
        if (result.success && result.name && result.type && result.data && result.mimeType) {
          newAtts.push({
            type: result.type,
            name: result.name,
            data: result.data,
            mimeType: result.mimeType,
            size: result.size,
          });
        }
      } catch {
        /* skip failed files */
      }
    }
    if (newAtts.length > 0) {
      setAttachments(prev => [...prev, ...newAtts].slice(0, 10)); // max 10
    }
  }, []);

  /** 从 FileList 提取 Electron file.path 并添加附件 */
  const addFilesFromDrop = useCallback(
    async (files: FileList) => {
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i] as File & { path?: string };
        if (f.path) paths.push(f.path);
      }
      if (paths.length > 0) {
        await addAttachments(paths);
      }
    },
    [addAttachments],
  );

  /** 从 DataTransferItemList 提取第一张图片并添加为附件 */
  const addImageFromClipboard = useCallback((items: DataTransferItemList) => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const att: ChatAttachment = {
            type: 'image',
            name: `clipboard-${Date.now()}.png`,
            data: dataUrl,
            mimeType: item.type,
            size: blob.size,
          };
          setAttachments(prev => [...prev, att].slice(0, 10));
        };
        reader.readAsDataURL(blob);
        return; // Only handle first image
      }
    }
  }, []);

  // 暴露给父组件的命令式方法
  useImperativeHandle(
    ref,
    () => ({
      addFilesFromDrop,
      addImageFromClipboard,
      focus: () => textareaRef.current?.focus(),
    }),
    [addFilesFromDrop, addImageFromClipboard],
  );

  const handlePickFiles = async () => {
    try {
      const result = await window.automater.dialog.openFiles({
        title: '选择图片或文件',
        multiple: true,
      });
      if (!result.canceled && result.filePaths.length > 0) {
        await addAttachments(result.filePaths);
      }
    } catch {
      /* dialog cancelled or error */
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSend = () => {
    if ((!input.trim() && attachments.length === 0) || sending || disabled) return;
    onSend(input.trim(), [...attachments]);
    setInput('');
    setAttachments([]);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  const handleInputChange = (value: string) => {
    setInput(value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const maxH = compact ? 100 : 160;
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, maxH)}px`;
    }
  };

  // Drag & drop
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      await addFilesFromDrop(files);
    }
  };

  // Paste image from clipboard
  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // 检查是否有图片
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        addImageFromClipboard(items);
        return;
      }
    }
  };

  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const sz = compact ? 'text-xs' : 'text-sm';
  const pad = compact ? 'px-2 py-1.5' : 'px-3 py-2';

  return (
    <div
      className={`shrink-0 border-t border-slate-800 ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className="mb-1.5 border-2 border-dashed border-forge-500/50 rounded-lg bg-forge-600/5 py-3 text-center">
          <span className="text-xs text-forge-400">拖放文件到这里</span>
        </div>
      )}

      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {attachments.map((att, idx) => (
            <div
              key={idx}
              className="relative group flex items-center gap-1.5 bg-slate-800/80 border border-slate-700 rounded-lg px-2 py-1 max-w-[180px]"
            >
              {att.type === 'image' ? (
                <img src={att.data} alt={att.name} className="w-8 h-8 rounded object-cover shrink-0" />
              ) : (
                <span className="text-sm shrink-0">📄</span>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-slate-300 truncate">{att.name}</div>
                {att.size && <div className="text-[8px] text-slate-600">{formatFileSize(att.size)}</div>}
              </div>
              <button
                onClick={() => handleRemoveAttachment(idx)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-700 text-slate-400 hover:bg-red-600 hover:text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                title="移除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex gap-1.5 items-end">
        {/* 📎 Attach button */}
        <button
          onClick={handlePickFiles}
          disabled={sending || disabled}
          className={`shrink-0 ${compact ? 'w-7 h-7' : 'w-8 h-8'} rounded-lg flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-800 transition-all disabled:opacity-30`}
          title="添加图片或文件"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={compact ? '13' : '15'}
            height={compact ? '13' : '15'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder || '发消息...'}
          rows={1}
          className={`flex-1 bg-slate-800 border border-slate-700 rounded-xl ${pad} ${sz} text-slate-100 placeholder-slate-600 focus:outline-none focus:border-forge-500 transition-colors resize-none overflow-hidden`}
          style={{ minHeight: compact ? '32px' : '36px' }}
          disabled={sending || disabled}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!hasContent || sending || disabled}
          className={`shrink-0 ${compact ? 'px-2 py-1.5' : 'px-3 py-2'} rounded-xl bg-forge-600 hover:bg-forge-500 text-white ${sz} transition-all disabled:bg-slate-800 disabled:text-slate-600`}
        >
          {sending ? (compact ? '·' : '...') : '↑'}
        </button>
      </div>
    </div>
  );
});
