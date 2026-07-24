interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center" role="alert">
      <span className="text-4xl mb-3">⚠️</span>
      <p className="text-slate-400 mb-4">{message}</p>
      {onRetry && (
        <button
          className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded transition-colors"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
