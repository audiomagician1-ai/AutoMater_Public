/**
 * 全局键盘快捷键 Hook
 * v15.0: Ctrl+N 新建项目, Ctrl+数字 切页, Escape 关闭弹窗
 */
import { useEffect } from 'react';
import { useAppStore } from '../stores/app-store';

export function useKeyboardShortcuts() {
  const insideProject = useAppStore(s => s.insideProject);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable;

      // Escape — 关闭 MetaAgent 面板、设置面板
      if (e.key === 'Escape') {
        if (s.metaAgentSettingsOpen) {
          s.setMetaAgentSettingsOpen(false);
          e.preventDefault();
          return;
        }
        if (s.metaAgentPanelOpen) {
          s.toggleMetaAgentPanel();
          e.preventDefault();
          return;
        }
        if (s.showAcceptancePanel) {
          s.setShowAcceptancePanel(false);
          e.preventDefault();
          return;
        }
      }

      // 以下快捷键在输入框中不触发
      if (isInput) return;

      // Ctrl+N — 回到项目列表页（创建新项目）
      if (ctrl && e.key === 'n') {
        e.preventDefault();
        s.exitProject();
        return;
      }

      // Ctrl+M — 切换 MetaAgent 面板
      if (ctrl && e.key === 'm') {
        e.preventDefault();
        if (s.insideProject) s.toggleMetaAgentPanel();
        return;
      }

      // Ctrl+, — 打开设置
      if (ctrl && e.key === ',') {
        e.preventDefault();
        s.setGlobalPage('settings');
        return;
      }

      // 数字快捷键 (项目内) — 1-9 切换子页面
      if (s.insideProject && !ctrl && e.key >= '1' && e.key <= '9') {
        const pages: Array<import('../stores/app-store').ProjectPageId> = [
          'overview', 'wish', 'board', 'team', 'docs', 'workflow', 'output', 'logs', 'context',
        ];
        const idx = parseInt(e.key) - 1;
        if (idx < pages.length) {
          e.preventDefault();
          s.setProjectPage(pages[idx]);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [insideProject]);
}
