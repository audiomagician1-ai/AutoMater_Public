/**
 * Navigation slice — dual-layer navigation (global + project pages)
 */
import type { StateCreator } from 'zustand';

/** 外层页面 (无需选中项目) */
export type GlobalPageId = 'projects' | 'settings' | 'guide' | 'evolution';
/** 项目内子页面 (需要 currentProjectId) */
export type ProjectPageId =
  | 'overview'
  | 'wish'
  | 'board'
  | 'team'
  | 'docs'
  | 'workflow'
  | 'output'
  | 'logs'
  | 'context'
  | 'timeline'
  | 'sessions'
  | 'git'
  | 'guide';

export interface NavigationSlice {
  insideProject: boolean;
  globalPage: GlobalPageId;
  projectPage: ProjectPageId;
  enterProject: (projectId: string, page?: ProjectPageId) => void;
  exitProject: () => void;
  setGlobalPage: (page: GlobalPageId) => void;
  setProjectPage: (page: ProjectPageId) => void;
  currentProjectId: string | null;
  setCurrentProject: (id: string | null) => void;
  settingsConfigured: boolean;
  setSettingsConfigured: (v: boolean) => void;
}

export const createNavigationSlice: StateCreator<NavigationSlice, [], [], NavigationSlice> = set => ({
  insideProject: false,
  globalPage: 'projects',
  projectPage: 'overview',
  enterProject: (projectId, page = 'overview') =>
    set({
      insideProject: true,
      currentProjectId: projectId,
      projectPage: page,
    }),
  exitProject: () => set({ insideProject: false, globalPage: 'projects' }),
  setGlobalPage: page => set({ globalPage: page, insideProject: false }),
  setProjectPage: page => set({ projectPage: page }),
  currentProjectId: null,
  setCurrentProject: id => set({ currentProjectId: id }),
  settingsConfigured: false,
  setSettingsConfigured: v => set({ settingsConfigured: v }),
});
