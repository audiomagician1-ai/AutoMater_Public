/**
 * Skill Tab — 本地技能目录管理
 */
import { useState, useCallback, useEffect } from 'react';

export function SkillTab() {
  const [skillDir, setSkillDir] = useState('');
  const [skillDirInput, setSkillDirInput] = useState('');
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillErrors, setSkillErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [skillLoading, setSkillLoading] = useState(false);

  const refreshSkills = useCallback(async () => {
    const dir = await window.automater.skill.getDirectory();
    setSkillDir(dir);
    setSkillDirInput(dir);
    const list = await window.automater.skill.list();
    setSkills(list);
  }, []);

  useEffect(() => { refreshSkills(); }, [refreshSkills]);

  const handleSetSkillDir = async () => {
    setSkillLoading(true);
    const result = await window.automater.skill.setDirectory(skillDirInput.trim());
    setSkillDir(skillDirInput.trim());
    setSkills(result.skills || []);
    setSkillErrors(result.errors || []);
    setSkillLoading(false);
  };

  const handleReloadSkills = async () => {
    setSkillLoading(true);
    const result = await window.automater.skill.reload();
    setSkills(result.skills || []);
    setSkillErrors(result.errors || []);
    setSkillLoading(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Skill 目录</h3>
        <p className="text-xs text-slate-500 mt-1">指定一个包含 JSON 技能定义文件的目录, Agent 将自动加载其中的工具</p>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400">目录路径</label>
        <div className="flex gap-2">
          <input type="text" value={skillDirInput} onChange={e => setSkillDirInput(e.target.value)}
            placeholder="例: D:\skills 或 /home/user/skills"
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 font-mono placeholder-slate-600 focus:outline-none focus:border-forge-500" />
          <button onClick={handleSetSkillDir} disabled={skillLoading}
            className="px-4 py-2.5 bg-forge-600 hover:bg-forge-500 rounded-lg text-sm font-medium transition-all disabled:opacity-40">
            {skillLoading ? '...' : '应用'}
          </button>
          {skillDir && (
            <button onClick={handleReloadSkills} disabled={skillLoading}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm font-medium transition-all disabled:opacity-40">
              🔄 重新扫描
            </button>
          )}
        </div>
        {skillDir && <p className="text-[10px] text-slate-500">当前目录: {skillDir}</p>}
      </div>

      <details className="group">
        <summary className="text-xs font-medium text-slate-400 cursor-pointer hover:text-slate-200">📖 技能文件格式说明</summary>
        <div className="mt-2 p-3 bg-slate-800/50 rounded-lg text-xs text-slate-400">
          <p className="mb-2">在目录中放置 <code className="text-forge-400">.json</code> 文件, 每个文件定义一个或多个工具:</p>
          <pre className="bg-slate-900 rounded p-2 text-[10px] font-mono overflow-x-auto">{`{
  "name": "my_tool",
  "description": "工具描述",
  "parameters": { "type": "object", "properties": { "input": { "type": "string" } }, "required": ["input"] },
  "execution": { "type": "command", "command": "python", "args": ["script.py", "{{input}}"], "timeout": 30000 }
}`}</pre>
        </div>
      </details>

      {skills.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">已加载技能 ({skills.length})</h4>
          <div className="space-y-1">
            {skills.map((skill, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2 bg-slate-800/50 rounded">
                <span className="text-xs font-mono text-forge-400">{skill.name}</span>
                <span className="text-xs text-slate-500 flex-1 truncate">{skill.description}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {skills.length === 0 && skillDir && !skillLoading && (
        <div className="text-center py-8 text-slate-500">
          <p className="text-2xl mb-2">🧩</p><p className="text-sm">目录中未找到有效的技能文件</p>
        </div>
      )}

      {!skillDir && (
        <div className="text-center py-12 text-slate-500">
          <p className="text-3xl mb-3">🧩</p><p className="text-sm">未设置技能目录</p>
          <p className="text-xs mt-1">输入目录路径并点击 "应用" 以加载本地技能</p>
        </div>
      )}

      {skillErrors.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-semibold text-red-400 uppercase tracking-wider">加载错误</h4>
          {skillErrors.map((err, i) => (
            <div key={i} className="px-3 py-2 bg-red-900/20 border border-red-900/50 rounded text-xs text-red-300">
              <span className="font-mono">{err.file}</span>: {err.error}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
