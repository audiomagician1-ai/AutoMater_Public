/**
 * EmptyState — 统一的空状态组件
 * v15.0: 统一各页面空状态设计
 */

interface EmptyStateProps {
  icon: string;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center animate-page-enter">
      <div className="text-5xl mb-4 animate-float">{icon}</div>
      <h3 className="text-sm font-semibold text-slate-300 mb-1.5">{title}</h3>
      {description && (
        <p className="text-xs text-slate-500 max-w-xs leading-relaxed">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-4 py-2 text-xs font-medium rounded-lg bg-forge-600 hover:bg-forge-500 text-white transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}