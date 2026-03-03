/**
 * MessageAttachments v28.0 — 消息气泡中的附件展示
 */

import { useState } from 'react';

interface Attachment {
  type: 'image' | 'file';
  name: string;
  data: string;
  mimeType: string;
}

export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {attachments.map((att, idx) =>
        att.type === 'image' ? <ImageAttachment key={idx} att={att} /> : <FileAttachment key={idx} att={att} />,
      )}
    </div>
  );
}

function ImageAttachment({ att }: { att: Attachment }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <button
        onClick={() => setExpanded(true)}
        className="relative group rounded-lg overflow-hidden border border-slate-700 hover:border-forge-500 transition-colors"
      >
        <img src={att.data} alt={att.name} className="max-w-[200px] max-h-[150px] object-cover" />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
          <span className="text-white/0 group-hover:text-white/80 text-xs transition-colors">🔍 查看</span>
        </div>
      </button>

      {/* Lightbox */}
      {expanded && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img src={att.data} alt={att.name} className="max-w-full max-h-[90vh] object-contain rounded-lg" />
            <div className="absolute top-2 right-2 flex gap-1.5">
              <button
                onClick={() => setExpanded(false)}
                className="w-8 h-8 rounded-full bg-black/60 text-white hover:bg-black/80 flex items-center justify-center text-lg transition-colors"
              >
                ×
              </button>
            </div>
            <div className="absolute bottom-2 left-2 text-[10px] text-white/60 bg-black/40 px-2 py-0.5 rounded">
              {att.name}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function FileAttachment({ att }: { att: Attachment }) {
  return (
    <div className="flex items-center gap-1.5 bg-slate-800/60 border border-slate-700 rounded-lg px-2.5 py-1.5 max-w-[200px]">
      <span className="text-sm shrink-0">📄</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] text-slate-300 truncate">{att.name}</div>
        <div className="text-[8px] text-slate-600">{att.mimeType}</div>
      </div>
    </div>
  );
}
