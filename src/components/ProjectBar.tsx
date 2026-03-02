/**
 * ProjectBar — 顶部横向项目切换栏
 *
 * 紧贴 Sidebar logo 右侧，横向排列所有项目。
 * 活跃项目 (developing/reviewing/analyzing) 靠前，其余按更新时间降序。
 * 支持鼠标滚轮横向滚动。点击切换到对应项目的当前子页面。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../stores/app-store';

/** 项目排序权重 — 活跃状态权重最高 */
const STATUS_WEIGHT: Record<string, number> = {
  developing: 0,
  reviewing: 1,
  analyzing: 2,
  initializing: 3,
  paused: 4,
  delivered: 5,
  error: 6,
};

const STATUS_DOT: Record<string, string> = {
  developing: 'bg-emerald-400 shadow-emerald-400/60',
  reviewing:  'bg-amber-400 shadow-amber-400/60',
  analyzing:  'bg-cyan-400 shadow-cyan-400/60 animate-pulse',
  initializing: 'bg-blue-400 shadow-blue-400/60 animate-pulse',
  paused:     'bg-slate-500',
  delivered:  'bg-green-500',
  error:      'bg-red-400 shadow-red-400/60',
};

interface ProjectItem {
  id: string;
  name: string;
  status: string;
  updated_at?: string;
}

export function ProjectBar() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const currentProjectId = useAppStore(s => s.currentProjectId);
  const insideProject = useAppStore(s => s.insideProject);
  const enterProject = useAppStore(s => s.enterProject);
  const projectPage = useAppStore(s => s.projectPage);

  // 加载项目列表
  const loadProjects = useCallback(async () => {
    try {
      const list: ProjectItem[] = await window.automater.project.list();
      if (!list) return;
      // 排序: 活跃状态靠前, 同状态按更新时间降序
      const sorted = [...list].sort((a, b) => {
        const wa = STATUS_WEIGHT[a.status] ?? 10;
        const wb = STATUS_WEIGHT[b.status] ?? 10;
        if (wa !== wb) return wa - wb;
        return (b.updated_at || '').localeCompare(a.updated_at || '');
      });
      setProjects(sorted);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadProjects();
    const t = setInterval(loadProjects, 8000);
    return () => clearInterval(t);
  }, [loadProjects]);

  // 监听项目状态变更事件刷新列表
  useEffect(() => {
    const unsub = window.automater.on('project:status', () => { loadProjects(); });
    return unsub;
  }, [loadProjects]);

  // 鼠标滚轮横向滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleClick = (id: string) => {
    if (id === currentProjectId && insideProject) return; // 已选中
    // 进入项目, 保持当前子页面 (如果已在某项目的logs页, 切换后仍显示logs)
    enterProject(id, insideProject ? projectPage : 'overview');
  };

  if (projects.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      className="flex items-center gap-1 px-2 overflow-x-auto scrollbar-none min-w-0 flex-1"
      style={{ scrollBehavior: 'smooth' }}
    >
      {projects.map(p => {
        const isActive = p.id === currentProjectId && insideProject;
        const dotClass = STATUS_DOT[p.status] || 'bg-slate-600';
        const isRunning = ['developing', 'reviewing', 'analyzing', 'initializing'].includes(p.status);

        return (
          <button
            key={p.id}
            onClick={() => handleClick(p.id)}
            className={`
              group relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
              whitespace-nowrap shrink-0 transition-all duration-200
              ${isActive
                ? 'bg-forge-600/25 text-forge-300 ring-1 ring-forge-500/30 shadow-sm shadow-forge-500/10'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'}
            `}
            title={`${p.name} — ${p.status}`}
          >
            {/* 状态点 */}
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 shadow-sm ${dotClass}`} />

            {/* 项目名 */}
            <span className="max-w-[120px] truncate">{p.name}</span>

            {/* 运行中呼吸指示器 */}
            {isRunning && !isActive && (
              <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>
        );
      })}
    </div>
  );
}
