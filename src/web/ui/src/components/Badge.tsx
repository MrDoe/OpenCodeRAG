interface BadgeProps {
  text: string;
  color?: string;
  onDismiss?: () => void;
}

export function Badge({ text, color, onDismiss }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono bg-slate-800 ${color ?? "text-slate-400"}`}
    >
      {text}
      {onDismiss && (
        <button
          className="ml-0.5 text-slate-500 hover:text-white"
          onClick={onDismiss}
          aria-label={`Dismiss ${text} filter`}
        >
          &times;
        </button>
      )}
    </span>
  );
}
