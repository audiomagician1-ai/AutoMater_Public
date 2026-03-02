/**
 * Onboarding — 可跳过的新手引导向导
 * v15.0: 首次启动弹出 3 步欢迎向导
 */
import { useState } from 'react';
import { toast } from '../stores/toast-store';

interface OnboardingProps {
  onComplete: () => void;
  onSkip: () => void;
  onGoToSettings: () => void;
}

const STEPS = [
  {
    icon: '🚀',
    title: '欢迎来到 AutoMater',
    subtitle: '智械母机 — 让 AI 团队帮你写代码',
    description: '告诉 AI 你想要什么，7 位虚拟团队成员会像真正的开发团队一样协作完成。从需求分析、架构设计到编码测试，全程自动化。',
    visual: '💭 → 👔 → 🏗️ → 💻 → 🔍 → ✅',
  },
  {
    icon: '🔑',
    title: '配置 AI 服务',
    subtitle: '只需一个 API Key 即可开始',
    description: '你需要一个 AI 服务商的 API Key（推荐 OpenAI 或 Anthropic）。选择服务商后填入 Key，系统会自动配置最佳模型组合。',
    visual: '🟢 OpenAI  |  🟣 Anthropic',
    action: '前往配置',
  },
  {
    icon: '✨',
    title: '开始创造',
    subtitle: '一切准备就绪',
    description: '创建项目，输入你的需求（比如"做一个待办清单应用"），然后让 AI 团队帮你实现！\n\n你可以随时在侧边栏的 📖 教程页面查看详细指南。',
    visual: '📝 许个愿 → 🤖 AI 开发 → 📦 成品交付',
  },
];

export function Onboarding({ onComplete, onSkip, onGoToSettings }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const handleNext = () => {
    if (current.action && step === 1) {
      onGoToSettings();
      return;
    }
    if (isLast) {
      onComplete();
      toast.success('🎉 欢迎使用 AutoMater！');
      return;
    }
    setStep(s => s + 1);
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[9997] flex items-center justify-center animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-[520px] shadow-2xl animate-scale-in overflow-hidden">
        {/* Progress */}
        <div className="flex gap-1 px-6 pt-5">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-forge-500' : 'bg-slate-800'
              }`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="px-8 py-8 text-center">
          <div className="text-5xl mb-4 animate-float">{current.icon}</div>
          <h2 className="text-xl font-bold text-slate-100 mb-1">{current.title}</h2>
          <p className="text-sm text-forge-400 mb-4">{current.subtitle}</p>
          <p className="text-sm text-slate-400 leading-relaxed whitespace-pre-line max-w-md mx-auto">
            {current.description}
          </p>
          {current.visual && (
            <div className="mt-5 py-3 px-4 bg-slate-800/50 rounded-xl text-sm text-slate-300 font-mono">
              {current.visual}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-8 pb-6">
          <button
            onClick={onSkip}
            className="text-xs text-slate-500 hover:text-slate-400 transition-colors"
          >
            跳过引导
          </button>
          <div className="flex items-center gap-3">
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="px-4 py-2 text-sm rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
              >
                上一步
              </button>
            )}
            <button
              onClick={handleNext}
              className="px-5 py-2.5 text-sm font-medium rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors shadow-lg shadow-forge-600/20"
            >
              {current.action ? `🔑 ${current.action}` : isLast ? '🚀 开始使用' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
