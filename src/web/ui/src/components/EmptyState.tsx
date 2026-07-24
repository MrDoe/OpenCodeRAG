interface EmptyStateProps {
  icon: string;
  message: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center" role="status">
      <span className="text-5xl mb-4" role="img" aria-label={icon}>{icon}</span>
      <p className="text-slate-400 mb-4">{message}</p>
      {action && (
        <button
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded transition-colors"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
