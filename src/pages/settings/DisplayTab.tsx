/**
 * Display Tab — 界面缩放设置
 */
import { useState, useEffect } from 'react';

export function DisplayTab() {
  const [zoomFactor, setZoomFactor] = useState(1.5);

  useEffect(() => {
    window.automater.settings.get().then(s => {
      setZoomFactor(s.zoomFactor ?? 1.5);
    });
    const unsubZoom = window.automater.on('zoom:changed', (factor: number) => {
      setZoomFactor(factor);
    });
    return () => unsubZoom();
  }, []);

  const handleZoomChange = async (factor: number) => {
    const clamped = Math.round(Math.min(3.0, Math.max(0.5, factor)) * 10) / 10;
    setZoomFactor(clamped);
    window.automater.zoom.set(clamped);
    const current = await window.automater.settings.get();
    await window.automater.settings.save({ ...current, zoomFactor: clamped });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">界面缩放</h3>
        <p className="text-xs text-slate-500 mt-1">
          调整界面大小, 也可使用 <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-[10px] font-mono">Ctrl +</kbd> / <kbd className="px-1.5 py-0.5 bg-slate-800 rounded text-[10px] font-mono">Ctrl -</kbd> 快捷键
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-slate-400">缩放倍率</label>
          <span className="text-sm font-mono text-forge-400 font-semibold">{Math.round(zoomFactor * 100)}%</span>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => handleZoomChange(zoomFactor - 0.1)} disabled={zoomFactor <= 0.5}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-lg font-bold transition-all disabled:opacity-30">−</button>
          <input type="range" min="0.5" max="3.0" step="0.1" value={zoomFactor}
            onChange={e => handleZoomChange(parseFloat(e.target.value))}
            className="flex-1 h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-forge-500" />
          <button onClick={() => handleZoomChange(zoomFactor + 0.1)} disabled={zoomFactor >= 3.0}
            className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-lg font-bold transition-all disabled:opacity-30">+</button>
        </div>
        <div className="flex gap-2 pt-1">
          {[{ label: '100%', value: 1.0 }, { label: '125%', value: 1.25 }, { label: '150%', value: 1.5 }, { label: '175%', value: 1.75 }, { label: '200%', value: 2.0 }].map(preset => (
            <button key={preset.value} onClick={() => handleZoomChange(preset.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                Math.abs(zoomFactor - preset.value) < 0.05 ? 'bg-forge-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
              }`}>{preset.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
