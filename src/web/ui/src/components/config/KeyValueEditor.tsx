import { useState } from "preact/hooks";
import { TagInput } from "./TagInput";

interface KeyValueEditorProps {
  id: string;
  /** `string` renders a text value, `string[]` a chip editor. */
  mode: "string" | "string[]";
  values: Record<string, string | string[]>;
  onChange: (values: Record<string, string | string[]>) => void;
  onBlur?: () => void;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/**
 * Editor for a `Record<string, ...>` setting.
 *
 * Existing entries are edited in place; new entries are added by name. Keys
 * themselves are not editable — renaming is delete + add, which keeps the
 * controlled object free of half-typed keys.
 */
export function KeyValueEditor({
  id,
  mode,
  values,
  onChange,
  onBlur,
  describedBy,
  invalid,
  disabled,
  keyPlaceholder = "Name",
  valuePlaceholder = "Value",
}: KeyValueEditorProps) {
  const [newKey, setNewKey] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const entries = Object.entries(values ?? {});

  const add = () => {
    const key = newKey.trim();
    if (!key) return;
    if (Object.hasOwn(values, key)) {
      setDuplicate(true);
      return;
    }
    onChange({ ...values, [key]: mode === "string[]" ? [] : "" });
    setNewKey("");
    setDuplicate(false);
  };

  const update = (key: string, value: string | string[]) => {
    onChange({ ...values, [key]: value });
  };

  const remove = (key: string) => {
    const next = { ...values };
    delete next[key];
    onChange(next);
  };

  const inputStyle = {
    background: "var(--bg-primary)",
    borderColor: invalid ? "#dc2626" : "var(--border)",
    color: "var(--text-primary)",
  };

  return (
    <div className="space-y-2">
      {entries.length === 0 && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          No entries. Inherited values still apply.
        </p>
      )}

      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start gap-2">
          <code
            className="mt-2 shrink-0 max-w-[10rem] truncate text-xs font-mono"
            style={{ color: "var(--text-secondary)" }}
            title={key}
          >
            {key}
          </code>
          <div className="flex-1 min-w-0">
            {mode === "string[]" ? (
              <TagInput
                id={`${id}-${key}`}
                values={Array.isArray(value) ? value : []}
                onChange={(next) => update(key, next)}
                onBlur={onBlur}
                placeholder={valuePlaceholder}
                disabled={disabled}
              />
            ) : (
              <input
                id={`${id}-${key}`}
                type="text"
                className="w-full rounded border px-2 py-1.5 text-sm font-mono"
                style={inputStyle}
                value={String(value ?? "")}
                placeholder={valuePlaceholder}
                disabled={disabled}
                aria-describedby={describedBy}
                onInput={(event) => update(key, event.currentTarget.value)}
                onBlur={onBlur}
              />
            )}
          </div>
          <button
            type="button"
            className="mt-1.5 shrink-0 rounded px-1.5 py-0.5 text-sm"
            style={{ color: "var(--text-muted)" }}
            onClick={() => remove(key)}
            disabled={disabled}
            aria-label={`Remove ${key}`}
            title={`Remove ${key}`}
          >
            ×
          </button>
        </div>
      ))}

      <div className="flex items-start gap-2 pt-1">
        <input
          id={id}
          type="text"
          className="flex-1 min-w-0 rounded border px-2 py-1.5 text-sm font-mono"
          style={inputStyle}
          value={newKey}
          placeholder={keyPlaceholder}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={duplicate || invalid ? "true" : undefined}
          onInput={(event) => {
            setNewKey(event.currentTarget.value);
            setDuplicate(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={onBlur}
        />
        <button
          type="button"
          className="shrink-0 rounded border px-3 py-1.5 text-sm"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          onClick={add}
          disabled={disabled || newKey.trim() === ""}
        >
          Add
        </button>
      </div>

      {duplicate && (
        <p className="text-xs" style={{ color: "#dc2626" }} role="alert">
          An entry named “{newKey.trim()}” already exists.
        </p>
      )}
    </div>
  );
}
