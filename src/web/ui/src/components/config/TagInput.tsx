import { useState } from "preact/hooks";

interface TagInputProps {
  id: string;
  values: string[];
  onChange: (values: string[]) => void;
  onBlur?: () => void;
  describedBy?: string;
  invalid?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

/** Chip editor for a `string[]` setting. Enter or comma commits, Backspace removes. */
export function TagInput({
  id,
  values,
  onChange,
  onBlur,
  describedBy,
  invalid,
  placeholder,
  disabled,
}: TagInputProps) {
  const [pending, setPending] = useState("");

  const add = (raw: string) => {
    const parts = raw
      .split(/[\n,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    for (const part of parts) {
      if (!next.includes(part)) next.push(part);
    }
    onChange(next);
    setPending("");
  };

  const remove = (value: string) => {
    onChange(values.filter((entry) => entry !== value));
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5 min-h-10"
      style={{
        background: "var(--bg-secondary)",
        borderColor: invalid ? "#dc2626" : "var(--border)",
      }}
    >
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-mono"
          style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
        >
          <span className="max-w-[22rem] truncate" title={value}>
            {value}
          </span>
          <button
            type="button"
            className="shrink-0 rounded px-0.5"
            style={{ color: "var(--text-muted)" }}
            onClick={() => remove(value)}
            aria-label={`Remove ${value}`}
            disabled={disabled}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        className="flex-1 min-w-[8rem] bg-transparent border-0 p-0 text-sm outline-none"
        style={{ color: "var(--text-primary)" }}
        value={pending}
        placeholder={values.length === 0 ? placeholder : "Add…"}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid ? "true" : undefined}
        onInput={(event) => setPending(event.currentTarget.value)}
        onPaste={(event) => {
          const text = event.clipboardData?.getData("text") ?? "";
          if (/[\n,]/.test(text)) {
            event.preventDefault();
            add(`${pending}${text}`);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(pending);
          } else if (event.key === "Backspace" && pending === "" && values.length > 0) {
            event.preventDefault();
            remove(values[values.length - 1]!);
          }
        }}
        onBlur={() => {
          if (pending.trim()) add(pending);
          onBlur?.();
        }}
      />
    </div>
  );
}
