/**
 * MetaAgentSettings — 元Agent管家管理页面 (Modal)
 *
 * 两个 Tab:
 *   1. 基本设置 — 名字、称呼、性格、系统提示词、上下文配置
 *   2. 记忆管理 — 分类浏览/搜索/新增/编辑/删除记忆
 *
 * v7.0: 初始创建
 */

import { useState, useEffect } from 'react';
import { createLogger } from '../utils/logger';
import { confirm as showConfirm } from '../stores/toast-store';

const log = createLogger('MetaAgentSettings');

type Tab = 'config' | 'modes' | 'memory' | 'daemon';
type MemoryCategory = 'identity' | 'user_profile' | 'lessons' | 'facts' | 'conversation_summary';

const CATEGORY_LABELS: Record<MemoryCategory, { label: string; icon: string; desc: string }> = {
  identity: { label: '自我认知', icon: '🤖', desc: '管家的身份、角色、性格特征' },
  user_profile: { label: '用户画像', icon: '👤', desc: '对用户的偏好、习惯、称呼的了解' },
  lessons: { label: '经验教训', icon: '📝', desc: '从对话和项目中积累的经验（大容量）' },
  facts: { label: '重要事实', icon: '📌', desc: '需要长期记住的重要事件、决策、约定' },
  conversation_summary: { label: '对话摘要', icon: '💬', desc: '历史对话的压缩摘要' },
};

interface Props {
  onClose: () => void;
}

export function MetaAgentSettings({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('config');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── Config state ──
  const [config, setConfig] = useState<MetaAgentConfig>({
    name: '元Agent管家',
    userNickname: '',
    personality: '专业、友好、高效',
    systemPrompt: '',
    contextHistoryLimit: 20,
    contextTokenLimit: 512000,
    maxResponseTokens: 128000,
    maxReactIterations: 50,
    readFileLineLimit: 1000,
    autoMemory: true,
    memoryInjectLimit: 30,
    greeting: '',
    modeConfigs: {
      work: { maxReactIterations: 50, maxResponseTokens: 128000 },
      chat: { maxReactIterations: 5, maxResponseTokens: 32000, contextHistoryLimit: 30 },
      deep: { maxReactIterations: 80, maxResponseTokens: 128000, contextHistoryLimit: 40 },
      admin: { maxReactIterations: 30, maxResponseTokens: 64000, contextHistoryLimit: 20 },
    },
  });

  // ── Memory state ──
  const [memories, setMemories] = useState<MetaAgentMemoryRecord[]>([]);
  const [memoryFilter, setMemoryFilter] = useState<MemoryCategory | 'all'>('all');
  const [memorySearch, setMemorySearch] = useState('');
  const [memoryStats, setMemoryStats] = useState<{ total: number; byCategory: Record<string, number> } | null>(null);
  const [editingMemory, setEditingMemory] = useState<MetaAgentMemoryRecord | null>(null);
  const [addingMemory, setAddingMemory] = useState(false);
  const [newMemory, setNewMemory] = useState({ category: 'facts' as MemoryCategory, content: '', importance: 5 });

  // Load config on mount
  useEffect(() => {
    window.automater.metaAgent.getConfig().then(setConfig).catch(e => log.error('init fetch failed', e));
    loadMemories();
    window.automater.metaAgent.getMemoryStats().then(setMemoryStats).catch(e => log.error('init fetch failed', e));
  }, []);

  const loadMemories = async () => {
    try {
      const cat = memoryFilter === 'all' ? undefined : memoryFilter;
      let mems: MetaAgentMemoryRecord[];
      if (memorySearch.trim()) {
        mems = await window.automater.metaAgent.searchMemories(memorySearch.trim(), 100);
        if (cat) mems = mems.filter(m => m.category === cat);
      } else {
        mems = await window.automater.metaAgent.listMemories(cat, 200);
      }
      setMemories(mems);
    } catch (err) {
      log.error('Failed to load memories:', err);
    }
  };

  useEffect(() => { loadMemories(); }, [memoryFilter, memorySearch]);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const result = await window.automater.metaAgent.saveConfig(config);
      if (result.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (err) {
      log.error('Save config failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleAddMemory = async () => {
    if (!newMemory.content.trim()) return;
    try {
      await window.automater.metaAgent.addMemory({
        category: newMemory.category,
        content: newMemory.content.trim(),
        source: 'manual',
        importance: newMemory.importance,
      });
      setNewMemory({ category: 'facts', content: '', importance: 5 });
      setAddingMemory(false);
      loadMemories();
      window.automater.metaAgent.getMemoryStats().then(setMemoryStats);
    } catch (err) {
      log.error('Add memory failed:', err);
    }
  };

  const handleUpdateMemory = async (mem: MetaAgentMemoryRecord) => {
    try {
      await window.automater.metaAgent.updateMemory(mem.id, {
        content: mem.content,
        importance: mem.importance,
        category: mem.category,
      });
      setEditingMemory(null);
      loadMemories();
    } catch (err) {
      log.error('Update memory failed:', err);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      await window.automater.metaAgent.deleteMemory(id);
      loadMemories();
      window.automater.metaAgent.getMemoryStats().then(setMemoryStats);
    } catch (err) {
      log.error('Delete memory failed:', err);
    }
  };

  const handleClearCategory = async (category: MemoryCategory) => {
    try {
      await window.automater.metaAgent.clearMemories(category);
      loadMemories();
      window.automater.metaAgent.getMemoryStats().then(setMemoryStats);
    } catch (err) {
      log.error('Clear memories failed:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[720px] max-h-[85vh] bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl shadow-black/40 flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">🤖</span>
            <div>
              <h2 className="text-base font-semibold text-slate-100">管家设置</h2>
              <p className="text-[11px] text-slate-500">配置元Agent的行为、记忆与个性</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-3 flex gap-1 shrink-0">
          <button
            onClick={() => setTab('config')}
            className={`px-4 py-2 rounded-t-lg text-xs font-medium transition-all ${
              tab === 'config'
                ? 'bg-slate-800 text-forge-400 border-b-2 border-forge-500'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
            }`}
          >
            ⚙️ 基本设置
          </button>
          <button
            onClick={() => setTab('modes')}
            className={`px-4 py-2 rounded-t-lg text-xs font-medium transition-all ${
              tab === 'modes'
                ? 'bg-slate-800 text-forge-400 border-b-2 border-forge-500'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
            }`}
          >
            🎛️ 模式参数
          </button>
          <button
            onClick={() => setTab('memory')}
            className={`px-4 py-2 rounded-t-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
              tab === 'memory'
                ? 'bg-slate-800 text-forge-400 border-b-2 border-forge-500'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
            }`}
          >
            🧠 记忆管理
            {memoryStats && (
              <span className="px-1.5 py-0.5 rounded-full bg-slate-700 text-[10px] text-slate-400">{memoryStats.total}</span>
            )}
          </button>
          <button
            onClick={() => setTab('daemon')}
            className={`px-4 py-2 rounded-t-lg text-xs font-medium transition-all ${
              tab === 'daemon'
                ? 'bg-slate-800 text-forge-400 border-b-2 border-forge-500'
                : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'
            }`}
          >
            💓 自主行为
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {tab === 'config' ? (
            <ConfigTab config={config} setConfig={setConfig} onSave={handleSaveConfig} saving={saving} saved={saved} />
          ) : tab === 'modes' ? (
            <ModeConfigTab config={config} setConfig={setConfig} onSave={handleSaveConfig} saving={saving} saved={saved} />
          ) : tab === 'memory' ? (
            <MemoryTab
              memories={memories}
              memoryFilter={memoryFilter}
              setMemoryFilter={setMemoryFilter}
              memorySearch={memorySearch}
              setMemorySearch={setMemorySearch}
              memoryStats={memoryStats}
              editingMemory={editingMemory}
              setEditingMemory={setEditingMemory}
              addingMemory={addingMemory}
              setAddingMemory={setAddingMemory}
              newMemory={newMemory}
              setNewMemory={setNewMemory}
              onAdd={handleAddMemory}
              onUpdate={handleUpdateMemory}
              onDelete={handleDeleteMemory}
              onClearCategory={handleClearCategory}
            />
          ) : (
            <DaemonTab />
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Config Tab
// ═══════════════════════════════════════

function ConfigTab({ config, setConfig, onSave, saving, saved }: {
  config: MetaAgentConfig;
  setConfig: (c: MetaAgentConfig) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const update = (key: keyof MetaAgentConfig, value: string | number | boolean) => setConfig({ ...config, [key]: value });

  return (
    <div className="space-y-5">
      {/* Identity Section */}
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">身份设定</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="管家名字" desc="在面板标题和对话中使用">
            <input
              value={config.name}
              onChange={e => update('name', e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              placeholder="元Agent管家"
            />
          </Field>
          <Field label="对用户的称呼" desc="称呼用户时使用（留空则不特别称呼）">
            <input
              value={config.userNickname}
              onChange={e => update('userNickname', e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              placeholder="老板 / Tim / 你..."
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="性格描述" desc="一句话定义管家的性格基调">
            <input
              value={config.personality}
              onChange={e => update('personality', e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              placeholder="专业、友好、高效"
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="自定义开场白" desc="管家的第一句话（留空使用默认）">
            <input
              value={config.greeting}
              onChange={e => update('greeting', e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              placeholder="你好！我是元Agent管家。告诉我你的需求..."
            />
          </Field>
        </div>
      </section>

      {/* System Prompt Section */}
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">系统提示词</h3>
        <Field label="自定义系统提示词" desc="完全覆盖默认提示词（留空使用内置智能提示词，已包含意图识别和记忆注入）">
          <textarea
            value={config.systemPrompt}
            onChange={e => update('systemPrompt', e.target.value)}
            rows={8}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono leading-relaxed focus:outline-none focus:border-forge-500 transition-colors resize-y"
            placeholder="留空 = 使用内置默认（推荐）&#10;&#10;如需自定义，请包含完整的系统指令..."
          />
        </Field>
      </section>

      {/* Context Config */}
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">上下文配置</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="历史消息条数" desc="每次对话带入的历史消息上限">
            <input
              type="number"
              value={config.contextHistoryLimit}
              onChange={e => update('contextHistoryLimit', parseInt(e.target.value) || 20)}
              min={2} max={200}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
          <Field label="上下文 Token 上限" desc="总上下文窗口大小">
            <input
              type="number"
              value={config.contextTokenLimit}
              onChange={e => update('contextTokenLimit', parseInt(e.target.value) || 512000)}
              min={4096} max={2000000} step={1024}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
          <Field label="最大回复 Token" desc="每次回复的 token 上限">
            <input
              type="number"
              value={config.maxResponseTokens}
              onChange={e => update('maxResponseTokens', parseInt(e.target.value) || 128000)}
              min={1024} max={256000} step={1024}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="工具迭代轮数" desc="ReAct 循环最大轮数（每轮可调用工具）">
            <input
              type="number"
              value={config.maxReactIterations}
              onChange={e => update('maxReactIterations', Math.max(1, Math.min(200, parseInt(e.target.value) || 50)))}
              min={1} max={200}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
          <Field label="文件默认读取行数" desc="read_file 工具默认读取行数（最大 2000）">
            <input
              type="number"
              value={config.readFileLineLimit}
              onChange={e => update('readFileLineLimit', Math.max(50, Math.min(2000, parseInt(e.target.value) || 1000)))}
              min={50} max={2000} step={50}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
        </div>
      </section>

      {/* Memory Config */}
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">记忆配置</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="自动记忆" desc="对话时自动提取值得记住的信息">
            <div className="flex items-center gap-3 mt-1">
              <button
                onClick={() => update('autoMemory', !config.autoMemory)}
                className={`relative w-10 h-5 rounded-full transition-colors ${config.autoMemory ? 'bg-forge-600' : 'bg-slate-700'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${config.autoMemory ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
              <span className="text-xs text-slate-400">{config.autoMemory ? '已开启' : '已关闭'}</span>
            </div>
          </Field>
          <Field label="记忆注入上限" desc="每次对话最多注入多少条记忆">
            <input
              type="number"
              value={config.memoryInjectLimit}
              onChange={e => update('memoryInjectLimit', parseInt(e.target.value) || 30)}
              min={0} max={200}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
        </div>
      </section>

      {/* Save Button */}
      <div className="flex justify-end pt-2">
        <button
          onClick={onSave}
          disabled={saving}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${
            saved
              ? 'bg-emerald-600 text-white'
              : 'bg-forge-600 hover:bg-forge-500 text-white disabled:bg-slate-700 disabled:text-slate-500'
          }`}
        >
          {saved ? '✓ 已保存' : saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Mode Config Tab — 每模式独立参数
// ═══════════════════════════════════════

const MODE_DEFS: Array<{ key: string; icon: string; label: string; desc: string; color: string }> = [
  { key: 'work',  icon: '🔧', label: '工作模式',     desc: '指挥调度 · 派发任务给团队', color: 'border-amber-500/40' },
  { key: 'chat',  icon: '💬', label: '闲聊模式',     desc: '自由对话 · 不触发工作流', color: 'border-blue-500/40' },
  { key: 'deep',  icon: '🔬', label: '深度讨论模式', desc: '深入分析 · 可输出文件/派发任务', color: 'border-purple-500/40' },
  { key: 'admin', icon: '🛠️', label: '管理模式',     desc: '修改团队/工作流/项目配置', color: 'border-rose-500/40' },
];

function ModeConfigTab({ config, setConfig, onSave, saving, saved }: {
  config: MetaAgentConfig;
  setConfig: (c: MetaAgentConfig) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
}) {
  const modeConfigs = config.modeConfigs || {};

  const updateMode = (mode: string, key: string, value: number | undefined) => {
    const cur = modeConfigs[mode] || {};
    const updated = { ...cur, [key]: value };
    // 如果值为 undefined 或 NaN，删除该键
    if (value === undefined || Number.isNaN(value)) {
      delete (updated as Record<string, unknown>)[key];
    }
    setConfig({
      ...config,
      modeConfigs: { ...modeConfigs, [mode]: updated },
    });
  };

  const getVal = (mode: string, key: string, fallback: number): number => {
    const v = (modeConfigs[mode] as Record<string, unknown> | undefined)?.[key];
    return typeof v === 'number' ? v : fallback;
  };

  // 全局默认值 (用于 placeholder)
  const globalDefaults = {
    maxReactIterations: config.maxReactIterations || 50,
    contextHistoryLimit: config.contextHistoryLimit || 20,
    maxResponseTokens: config.maxResponseTokens || 128000,
    contextTokenLimit: config.contextTokenLimit || 512000,
  };

  return (
    <div className="space-y-5">
      <div className="bg-slate-800/30 rounded-lg px-4 py-3">
        <p className="text-[11px] text-slate-400 leading-relaxed">
          每个对话模式可以有独立的 ReAct 迭代、上下文和输出限制。未设置的参数将使用「基本设置」中的全局默认值。
        </p>
      </div>

      {MODE_DEFS.map(({ key, icon, label, desc, color }) => (
        <section key={key} className={`border-l-2 ${color} pl-4`}>
          <h3 className="text-xs font-semibold text-slate-200 mb-1 flex items-center gap-2">
            <span>{icon}</span> {label}
          </h3>
          <p className="text-[10px] text-slate-600 mb-3">{desc}</p>

          <div className="grid grid-cols-2 gap-3">
            <Field label="ReAct 迭代轮数" desc={`全局默认: ${globalDefaults.maxReactIterations}`}>
              <input
                type="number"
                value={getVal(key, 'maxReactIterations', key === 'work' ? 50 : key === 'chat' ? 5 : key === 'deep' ? 80 : 30)}
                onChange={e => updateMode(key, 'maxReactIterations', parseInt(e.target.value) || undefined)}
                min={1} max={200}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              />
            </Field>
            <Field label="最大回复 Token" desc={`全局默认: ${globalDefaults.maxResponseTokens.toLocaleString()}`}>
              <input
                type="number"
                value={getVal(key, 'maxResponseTokens', key === 'chat' ? 32000 : key === 'admin' ? 64000 : 128000)}
                onChange={e => updateMode(key, 'maxResponseTokens', parseInt(e.target.value) || undefined)}
                min={1024} max={256000} step={1024}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              />
            </Field>
            <Field label="历史消息条数" desc={`全局默认: ${globalDefaults.contextHistoryLimit}`}>
              <input
                type="number"
                value={getVal(key, 'contextHistoryLimit', key === 'deep' ? 40 : key === 'chat' ? 30 : 20)}
                onChange={e => updateMode(key, 'contextHistoryLimit', parseInt(e.target.value) || undefined)}
                min={2} max={200}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              />
            </Field>
            <Field label="上下文 Token 上限" desc={`全局默认: ${globalDefaults.contextTokenLimit.toLocaleString()}`}>
              <input
                type="number"
                value={getVal(key, 'contextTokenLimit', globalDefaults.contextTokenLimit)}
                onChange={e => updateMode(key, 'contextTokenLimit', parseInt(e.target.value) || undefined)}
                min={4096} max={2000000} step={1024}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              />
            </Field>
          </div>
        </section>
      ))}

      {/* Save Button */}
      <div className="flex justify-end pt-2">
        <button
          onClick={onSave}
          disabled={saving}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${
            saved
              ? 'bg-emerald-600 text-white'
              : 'bg-forge-600 hover:bg-forge-500 text-white disabled:bg-slate-700 disabled:text-slate-500'
          }`}
        >
          {saved ? '✓ 已保存' : saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Memory Tab
// ═══════════════════════════════════════

function MemoryTab({
  memories, memoryFilter, setMemoryFilter, memorySearch, setMemorySearch,
  memoryStats, editingMemory, setEditingMemory, addingMemory, setAddingMemory,
  newMemory, setNewMemory, onAdd, onUpdate, onDelete, onClearCategory,
}: {
  memories: MetaAgentMemoryRecord[];
  memoryFilter: MemoryCategory | 'all';
  setMemoryFilter: (f: MemoryCategory | 'all') => void;
  memorySearch: string;
  setMemorySearch: (s: string) => void;
  memoryStats: { total: number; byCategory: Record<string, number> } | null;
  editingMemory: MetaAgentMemoryRecord | null;
  setEditingMemory: (m: MetaAgentMemoryRecord | null) => void;
  addingMemory: boolean;
  setAddingMemory: (a: boolean) => void;
  newMemory: { category: MemoryCategory; content: string; importance: number };
  setNewMemory: (m: { category: MemoryCategory; content: string; importance: number }) => void;
  onAdd: () => void;
  onUpdate: (m: MetaAgentMemoryRecord) => void;
  onDelete: (id: string) => void;
  onClearCategory: (cat: MemoryCategory) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Stats Bar */}
      {memoryStats && (
        <div className="flex items-center gap-2 flex-wrap">
          {(Object.entries(CATEGORY_LABELS) as [MemoryCategory, typeof CATEGORY_LABELS[MemoryCategory]][]).map(([key, { label, icon }]) => (
            <button
              key={key}
              onClick={() => setMemoryFilter(memoryFilter === key ? 'all' : key)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                memoryFilter === key
                  ? 'bg-forge-600/20 text-forge-400 ring-1 ring-forge-500/30'
                  : 'bg-slate-800 text-slate-400 hover:text-slate-300 hover:bg-slate-700'
              }`}
            >
              <span>{icon}</span>
              <span>{label}</span>
              <span className="text-[10px] text-slate-500 ml-0.5">{memoryStats.byCategory[key] || 0}</span>
            </button>
          ))}
          <span className="text-[10px] text-slate-600 ml-auto">共 {memoryStats.total} 条记忆</span>
        </div>
      )}

      {/* Search + Add */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            value={memorySearch}
            onChange={e => setMemorySearch(e.target.value)}
            placeholder="搜索记忆..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 pl-8 text-xs text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs">🔍</span>
        </div>
        <button
          onClick={() => setAddingMemory(true)}
          className="px-3 py-2 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs font-medium transition-all shrink-0"
        >
          + 新增
        </button>
        {memoryFilter !== 'all' && (
          <button
            onClick={async () => {
              const { confirmed } = await showConfirm({
                title: '清空记忆',
                message: `确定清空所有「${CATEGORY_LABELS[memoryFilter].label}」类记忆？此操作不可撤销。`,
                confirmText: '清空',
                danger: true,
              });
              if (confirmed) onClearCategory(memoryFilter);
            }}
            className="px-3 py-2 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-400 text-xs transition-all shrink-0"
          >
            清空此类
          </button>
        )}
      </div>

      {/* Add Memory Form */}
      {addingMemory && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-slate-300">新增记忆</h4>
            <button onClick={() => setAddingMemory(false)} className="text-slate-500 hover:text-slate-300 text-xs">取消</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-slate-500 mb-1 block">分类</label>
              <select
                value={newMemory.category}
                onChange={e => setNewMemory({ ...newMemory, category: e.target.value as MemoryCategory })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500"
              >
                {(Object.entries(CATEGORY_LABELS) as [MemoryCategory, typeof CATEGORY_LABELS[MemoryCategory]][]).map(([key, { label, icon }]) => (
                  <option key={key} value={key}>{icon} {label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-slate-500 mb-1 block">重要性 (1-10)</label>
              <input
                type="number"
                value={newMemory.importance}
                onChange={e => setNewMemory({ ...newMemory, importance: Math.max(1, Math.min(10, parseInt(e.target.value) || 5)) })}
                min={1} max={10}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500"
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-slate-500 mb-1 block">内容</label>
            <textarea
              value={newMemory.content}
              onChange={e => setNewMemory({ ...newMemory, content: e.target.value })}
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500 resize-y"
              placeholder="输入记忆内容..."
              autoFocus
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={onAdd}
              disabled={!newMemory.content.trim()}
              className="px-4 py-1.5 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs font-medium transition-all disabled:bg-slate-700 disabled:text-slate-500"
            >
              保存记忆
            </button>
          </div>
        </div>
      )}

      {/* Memory List */}
      <div className="space-y-2">
        {memories.length === 0 ? (
          <div className="py-8 text-center text-slate-600 text-xs">
            {memorySearch ? '未找到匹配的记忆' : '暂无记忆。点击"+ 新增"添加，或开启自动记忆让管家在对话中自动积累。'}
          </div>
        ) : (
          memories.map(mem => (
            <div
              key={mem.id}
              className="bg-slate-800/40 border border-slate-800 rounded-xl px-4 py-3 group hover:border-slate-700 transition-colors"
            >
              {editingMemory?.id === mem.id ? (
                // Editing mode
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={editingMemory.category}
                      onChange={e => setEditingMemory({ ...editingMemory, category: e.target.value as MemoryCategory })}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-forge-500"
                    >
                      {(Object.entries(CATEGORY_LABELS) as [MemoryCategory, typeof CATEGORY_LABELS[MemoryCategory]][]).map(([key, { label, icon }]) => (
                        <option key={key} value={key}>{icon} {label}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      value={editingMemory.importance}
                      onChange={e => setEditingMemory({ ...editingMemory, importance: Math.max(1, Math.min(10, parseInt(e.target.value) || 5)) })}
                      min={1} max={10}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-forge-500"
                    />
                  </div>
                  <textarea
                    value={editingMemory.content}
                    onChange={e => setEditingMemory({ ...editingMemory, content: e.target.value })}
                    rows={3}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500 resize-y"
                    autoFocus
                  />
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setEditingMemory(null)} className="px-3 py-1 text-xs text-slate-500 hover:text-slate-300">取消</button>
                    <button onClick={() => onUpdate(editingMemory)} className="px-3 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs">保存</button>
                  </div>
                </div>
              ) : (
                // Display mode
                <div className="flex items-start gap-3">
                  <span className="text-sm mt-0.5 shrink-0">{CATEGORY_LABELS[mem.category]?.icon || '📎'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">{mem.content}</p>
                    <div className="flex items-center gap-2 mt-1.5 text-[10px] text-slate-600">
                      <span>{CATEGORY_LABELS[mem.category]?.label || mem.category}</span>
                      <span>·</span>
                      <span>重要性 {mem.importance}</span>
                      <span>·</span>
                      <span>{mem.source === 'auto' ? '自动' : mem.source === 'manual' ? '手动' : '系统'}</span>
                      <span>·</span>
                      <span>{new Date(mem.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => setEditingMemory({ ...mem })}
                      className="w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:text-forge-400 hover:bg-slate-700 transition-colors"
                      title="编辑"
                    >
                      <span className="text-[10px]">✏️</span>
                    </button>
                    <button
                      onClick={() => onDelete(mem.id)}
                      className="w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:text-red-400 hover:bg-slate-700 transition-colors"
                      title="删除"
                    >
                      <span className="text-[10px]">🗑️</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// Helper: Field wrapper
// ═══════════════════════════════════════

function Field({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-slate-400 font-medium block mb-1">{label}</label>
      {desc && <p className="text-[10px] text-slate-600 mb-1.5">{desc}</p>}
      {children}
    </div>
  );
}

// ═══════════════════════════════════════
// Daemon Tab — 心跳/事件钩子/定时任务
// ═══════════════════════════════════════

function DaemonTab() {
  const [status, setStatus] = useState<MetaAgentDaemonStatus | null>(null);
  const [config, setConfig] = useState<MetaAgentDaemonConfig | null>(null);
  const [logs, setLogs] = useState<MetaAgentHeartbeatLog[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [triggering, setTriggering] = useState(false);

  // New cron job form
  const [showAddCron, setShowAddCron] = useState(false);
  const [newCron, setNewCron] = useState({ name: '', schedule: 'daily:09:00', prompt: '' });

  useEffect(() => {
    window.automater.metaAgent.getDaemonStatus().then(s => {
      setStatus(s);
      setConfig(s.config);
      setLogs(s.recentLogs);
    }).catch(console.error);
  }, []);

  const refreshLogs = () => {
    window.automater.metaAgent.getDaemonLogs(30).then(setLogs).catch(console.error);
    window.automater.metaAgent.getDaemonStatus().then(s => setStatus(s)).catch(console.error);
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const result = await window.automater.metaAgent.saveDaemonConfig(config);
      if (result.success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        refreshLogs();
      }
    } catch (err) { log.error('Daemon config save failed', err); }
    finally { setSaving(false); }
  };

  const handleToggle = async () => {
    if (!config) return;
    const newEnabled = !config.enabled;
    setConfig({ ...config, enabled: newEnabled });
    await window.automater.metaAgent.saveDaemonConfig({ enabled: newEnabled });
    refreshLogs();
  };

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await window.automater.metaAgent.triggerHeartbeat();
      setTimeout(refreshLogs, 3000); // Wait for LLM response
    } catch (err) { log.error('Heartbeat trigger failed', err); }
    finally { setTriggering(false); }
  };

  const handleAddCron = () => {
    if (!config || !newCron.name.trim() || !newCron.prompt.trim()) return;
    const job = {
      id: `cron-${Date.now().toString(36)}`,
      name: newCron.name.trim(),
      schedule: newCron.schedule,
      prompt: newCron.prompt.trim(),
      enabled: true,
    };
    setConfig({ ...config, cronJobs: [...config.cronJobs, job] });
    setNewCron({ name: '', schedule: 'daily:09:00', prompt: '' });
    setShowAddCron(false);
  };

  const handleRemoveCron = (id: string) => {
    if (!config) return;
    setConfig({ ...config, cronJobs: config.cronJobs.filter(j => j.id !== id) });
  };

  const handleToggleCron = (id: string) => {
    if (!config) return;
    setConfig({
      ...config,
      cronJobs: config.cronJobs.map(j => j.id === id ? { ...j, enabled: !j.enabled } : j),
    });
  };

  if (!config) return <div className="text-center py-8 text-slate-600 text-xs">加载中...</div>;

  return (
    <div className="space-y-5">
      {/* Master Switch + Status */}
      <section className="flex items-center justify-between bg-slate-800/30 rounded-xl px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            💓 管家守护进程
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
              config.enabled && status?.running ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-700 text-slate-500'
            }`}>
              {config.enabled && status?.running ? '运行中' : '已停止'}
            </span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            让管家持续监控项目进度，主动通知你需要关注的事情
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleTrigger}
            disabled={triggering || !config.enabled}
            className="px-3 py-1.5 text-[11px] rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-all disabled:opacity-40"
          >
            {triggering ? '检查中...' : '立即检查'}
          </button>
          <button
            onClick={handleToggle}
            className={`relative w-11 h-6 rounded-full transition-colors ${config.enabled ? 'bg-forge-600' : 'bg-slate-700'}`}
          >
            <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all ${config.enabled ? 'left-[26px]' : 'left-1'}`} />
          </button>
        </div>
      </section>

      {/* Heartbeat Config */}
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">💓 心跳检查</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="检查间隔(分钟)" desc="每隔多久审视一次项目状态">
            <input
              type="number"
              value={config.heartbeatIntervalMin}
              onChange={e => setConfig({ ...config, heartbeatIntervalMin: Math.max(5, parseInt(e.target.value) || 30) })}
              min={5} max={1440}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
          <Field label="活跃开始" desc="只在此时间后运行">
            <input
              value={config.activeHoursStart}
              onChange={e => setConfig({ ...config, activeHoursStart: e.target.value })}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              placeholder="08:00"
            />
          </Field>
          <Field label="活跃结束" desc="此时间后停止运行">
            <input
              value={config.activeHoursEnd}
              onChange={e => setConfig({ ...config, activeHoursEnd: e.target.value })}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
              placeholder="24:00"
            />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="每日 Token 预算" desc="心跳+钩子+定时任务的每日总 token 上限">
            <input
              type="number"
              value={config.dailyTokenBudget}
              onChange={e => setConfig({ ...config, dailyTokenBudget: parseInt(e.target.value) || 50000 })}
              min={1000} max={1000000} step={5000}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-forge-500 transition-colors"
            />
          </Field>
          {status && (
            <div className="mt-1 text-[10px] text-slate-600">
              今日已用: {status.todayTokens.toLocaleString()} / {config.dailyTokenBudget.toLocaleString()} tokens
            </div>
          )}
        </div>
      </section>

      {/* Event Hooks */}
      <section>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">🪝 事件钩子</h3>
        <p className="text-[10px] text-slate-600 mb-3">关键事件发生时，管家自动判断是否需要通知你</p>
        <div className="space-y-2">
          {([
            ['onFeatureFailed', 'Feature 失败', 'QA 审查未通过时通知'],
            ['onProjectComplete', '项目完成', '项目开发完成时通知'],
            ['onProjectStalled', '项目停滞', '项目长时间无进展时通知'],
            ['onError', '严重错误', '出现严重错误时通知'],
          ] as const).map(([key, label, desc]) => (
            <div key={key} className="flex items-center justify-between bg-slate-800/30 rounded-lg px-4 py-2.5">
              <div>
                <span className="text-xs text-slate-300">{label}</span>
                <span className="text-[10px] text-slate-600 ml-2">{desc}</span>
              </div>
              <button
                onClick={() => setConfig({ ...config, hooks: { ...config.hooks, [key]: !config.hooks[key] } })}
                className={`relative w-9 h-5 rounded-full transition-colors ${config.hooks[key] ? 'bg-forge-600' : 'bg-slate-700'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${config.hooks[key] ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Cron Jobs */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">⏰ 定时任务</h3>
          <button
            onClick={() => setShowAddCron(true)}
            className="text-[10px] px-2.5 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-all"
          >
            + 新增
          </button>
        </div>

        {showAddCron && (
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 space-y-3 mb-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="任务名称">
                <input
                  value={newCron.name}
                  onChange={e => setNewCron({ ...newCron, name: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500"
                  placeholder="每日进度报告"
                />
              </Field>
              <Field label="执行时间" desc="daily:HH:MM / hourly / every:Nm">
                <input
                  value={newCron.schedule}
                  onChange={e => setNewCron({ ...newCron, schedule: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500"
                  placeholder="daily:09:00"
                />
              </Field>
            </div>
            <Field label="执行指令" desc="发给管家的任务描述">
              <textarea
                value={newCron.prompt}
                onChange={e => setNewCron({ ...newCron, prompt: e.target.value })}
                rows={3}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-forge-500 resize-y"
                placeholder="请检查所有项目的进度，生成一份简短的日报..."
              />
            </Field>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowAddCron(false)} className="px-3 py-1 text-xs text-slate-500 hover:text-slate-300">取消</button>
              <button
                onClick={handleAddCron}
                disabled={!newCron.name.trim() || !newCron.prompt.trim()}
                className="px-3 py-1 rounded-lg bg-forge-600 hover:bg-forge-500 text-white text-xs disabled:opacity-40"
              >
                添加
              </button>
            </div>
          </div>
        )}

        {config.cronJobs.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-slate-600">暂无定时任务。可添加日报、周报、定时检查等。</div>
        ) : (
          <div className="space-y-2">
            {config.cronJobs.map(job => (
              <div key={job.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-4 py-2.5">
                <button
                  onClick={() => handleToggleCron(job.id)}
                  className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${job.enabled ? 'bg-forge-600' : 'bg-slate-700'}`}
                >
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${job.enabled ? 'left-[16px]' : 'left-0.5'}`} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-300 truncate">{job.name}</div>
                  <div className="text-[10px] text-slate-600">{job.schedule} · {job.prompt.slice(0, 40)}...</div>
                </div>
                <button
                  onClick={() => handleRemoveCron(job.id)}
                  className="text-[10px] text-slate-600 hover:text-red-400 transition-colors shrink-0"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Save + Logs */}
      <div className="flex justify-between items-center pt-2">
        <button
          onClick={refreshLogs}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          🔄 刷新日志
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${
            saved
              ? 'bg-emerald-600 text-white'
              : 'bg-forge-600 hover:bg-forge-500 text-white disabled:bg-slate-700 disabled:text-slate-500'
          }`}
        >
          {saved ? '✓ 已保存' : saving ? '保存中...' : '保存设置'}
        </button>
      </div>

      {/* Recent Logs */}
      {logs.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">📋 最近活动</h3>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={l.id || i} className="flex items-start gap-2 text-[11px] px-3 py-1.5 rounded bg-slate-800/30">
                <span className="shrink-0 mt-0.5">
                  {l.type === 'heartbeat' ? '💓' : l.type === 'hook' ? '🪝' : '⏰'}
                </span>
                <span className={`shrink-0 w-12 ${
                  l.result === 'ok' ? 'text-slate-600' : l.result === 'notified' ? 'text-amber-400' : 'text-red-400'
                }`}>
                  {l.result === 'ok' ? '静默' : l.result === 'notified' ? '已通知' : '错误'}
                </span>
                <span className="text-slate-400 flex-1 truncate">{l.message.slice(0, 80)}</span>
                <span className="text-slate-600 shrink-0">{l.tokens_used}t</span>
                {l.created_at && (
                  <span className="text-slate-700 shrink-0">{new Date(l.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}