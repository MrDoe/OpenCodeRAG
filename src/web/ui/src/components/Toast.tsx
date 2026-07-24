import { toasts } from "../state/store";

export function ToastContainer() {
  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.value.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all duration-300 animate-slide-in ${
            t.type === "success"
              ? "bg-green-600 text-white"
              : t.type === "error"
              ? "bg-red-600 text-white"
              : "bg-brand-600 text-white"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
