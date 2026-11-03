import { useEffect, useRef, useState } from "preact/hooks";
import {
  formatConfigValue,
  provenanceLabel,
  type SettingField,
} from "../../lib/config-types";
import { TagInput } from "./TagInput";
import { KeyValueEditor } from "./KeyValueEditor";

const PROVENANCE_COLORS: Record<string, string> = {
  runtime: "#d97706",
  project: "#0891b2",
  global: "#7c3aed",
  default: "var(--text-muted)",
};

export interface SettingRowProps {
  field: SettingField;
  /** Resolved value for the control (draft > layer > effective). */
  value: unknown;
  /** Effective view: where the value comes from. */
  provenance?: string;
  /** Layer views: the layer explicitly writes this setting. */
  isSetHere?: boolean;
  /** A secret is stored in this layer. */
  secretSet?: boolean;
  /** Effective view: a runtime override currently wins. */
  runtimeOverridden?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** Called when the user wants to edit a global-only setting on its own tab. */
  onEditElsewhere?: () => void;
  error?: string;
  onChange: (value: unknown) => void;
  onClearOverride?: () => void;
  /** Drop a pending edit without staging a removal (secret fields). */
  onRevert?: () => void;
}

/** HTML id for a setting row — stable across renders, usable with getElementById. */
export function settingElementId(path: readonly string[]): string {
  return `setting-${path.join(".")}`;
}

/**
 * One configuration setting: label, description, provenance, control, and
 * inline validation. All controls are controlled by the parent's draft state.
 */
export function SettingRow({
  field,
  value,
  provenance,
  isSetHere,
  secretSet,
  runtimeOverridden,
  readOnly,
  disabled,
  disabledReason,
  onEditElsewhere,
  error,
  onChange,
  onClearOverride,
  onRevert,
}: SettingRowProps) {
  const rowId = settingElementId(field.path);
  const controlId = `${rowId}-control`;
  const descriptionId = field.description ? `${rowId}-description` : undefined;
  const errorId = error ? `${rowId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  const disabledNow = readOnly === true || disabled === true;

  return (
    <div
      id={rowId}
      className="py-3.5 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:gap-6 md:items-start border-b last:border-b-0"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={controlId}
            className="text-sm font-medium"
            style={{ color: disabledNow && !readOnly ? "var(--text-muted)" : "var(--text-primary)" }}
          >
            {field.label}
          </label>
          {field.secret && (
            <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              secret
            </span>
          )}
          {isSetHere && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{ background: "color-mix(in srgb, var(--accent) 18%, transparent)", color: "var(--accent)" }}
            >
              Set here
            </span>
          )}
          {isSetHere && !readOnly && onClearOverride && (
            <button
              type="button"
              className="text-[11px] underline underline-offset-2"
              style={{ color: "var(--text-muted)" }}
              onClick={onClearOverride}
              title="Remove this layer's value so the setting is inherited again"
            >
              Reset
            </button>
          )}
          {provenance && (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium font-mono"
              style={{
                color: PROVENANCE_COLORS[provenance] ?? "var(--text-muted)",
                border: `1px solid ${PROVENANCE_COLORS[provenance] ?? "var(--border)"}`,
              }}
              title={`Effective value comes from the ${provenanceLabel(provenance).toLowerCase()} layer`}
            >
              {provenanceLabel(provenance)}
            </span>
          )}
          {disabled && disabledReason && (
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {disabledReason}
            </span>
          )}
          {onEditElsewhere && (
            <button
              type="button"
              className="text-[11px] underline underline-offset-2"
              style={{ color: "var(--accent)" }}
              onClick={onEditElsewhere}
            >
              Edit in Global
            </button>
          )}
        </div>

        {field.description && (
          <p id={descriptionId} className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {field.description}
          </p>
        )}
        {field.advanced && !readOnly && (
          <code className="mt-1 inline-block text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            {field.path.join(".")}
          </code>
        )}
      </div>

      <div className="min-w-0">
        {readOnly ? (
          <ReadOnlyValue field={field} value={value} secretSet={secretSet} runtimeOverridden={runtimeOverridden} onClearOverride={onClearOverride} />
        ) : (
          <Control
            id={controlId}
            field={field}
            value={value}
            secretSet={secretSet}
            disabled={disabledNow}
            describedBy={describedBy}
            invalid={error !== undefined}
            onChange={onChange}
            onClearOverride={onClearOverride}
            onRevert={onRevert}
          />
        )}

        {error && (
          <p id={errorId} role="alert" className="mt-1 text-xs" style={{ color: "#dc2626" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

interface ControlProps {
  id: string;
  field: SettingField;
  value: unknown;
  secretSet?: boolean;
  disabled: boolean;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
  onClearOverride?: () => void;
  onRevert?: () => void;
}

function Control({
  id,
  field,
  value,
  secretSet,
  disabled,
  describedBy,
  invalid,
  onChange,
  onClearOverride,
  onRevert,
}: ControlProps) {
  const borderColor = invalid ? "#dc2626" : "var(--border)";
  const commonStyle = {
    background: "var(--bg-secondary)",
    borderColor,
    color: "var(--text-primary)",
    opacity: disabled ? 0.6 : 1,
  };

  switch (field.type) {
    case "boolean": {
      const checked = value === true;
      return (
        <div className="flex items-center gap-2">
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={field.label}
            aria-describedby={describedBy}
            disabled={disabled}
            className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
            style={{
              background: checked ? "var(--accent)" : "var(--bg-tertiary)",
              border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
              opacity: disabled ? 0.6 : 1,
            }}
            onClick={() => onChange(!checked)}
          >
            <span
              className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
              style={{ transform: checked ? "translateX(24px)" : "translateX(3px)" }}
            />
          </button>
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {checked ? "Enabled" : "Disabled"}
          </span>
        </div>
      );
    }

    case "number":
      return (
        <NumberControl
          id={id}
          field={field}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          invalid={invalid}
          onChange={onChange}
        />
      );

    case "enum": {
      const selected = typeof value === "string" ? value : "";
      return (
        <select
          id={id}
          className="w-full rounded border px-2.5 py-1.5 text-sm"
          style={commonStyle}
          value={selected}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid ? "true" : undefined}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            onChange(raw === "" ? undefined : raw);
          }}
        >
          <option value="">Inherit</option>
          {(field.enumValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    case "string[]":
      return (
        <TagInput
          id={id}
          values={Array.isArray(value) ? (value as string[]) : []}
          onChange={(next) => onChange(next)}
          describedBy={describedBy}
          invalid={invalid}
          placeholder={field.placeholder ?? "Add value…"}
          disabled={disabled}
        />
      );

    case "stringMap":
    case "stringArrayMap": {
      const map = value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, string | string[]>)
        : {};
      return (
        <KeyValueEditor
          id={id}
          mode={field.type === "stringArrayMap" ? "string[]" : "string"}
          values={map}
          onChange={(next) => onChange(next)}
          describedBy={describedBy}
          invalid={invalid}
          disabled={disabled}
          keyPlaceholder={field.type === "stringArrayMap" ? "Language" : "Extension"}
        />
      );
    }

    case "json":
      return (
        <JsonControl
          id={id}
          value={value}
          disabled={disabled}
          describedBy={describedBy}
          invalid={invalid}
          onChange={onChange}
        />
      );

    case "string":
    default: {
      if (field.secret) {
        return (
          <div className="flex items-center gap-2">
            <input
              id={id}
              type="password"
              className="w-full rounded border px-2.5 py-1.5 text-sm font-mono"
              style={commonStyle}
              value={typeof value === "string" ? value : ""}
              placeholder={secretSet ? "•••••••• (set — type to replace)" : "(not set)"}
              autoComplete="new-password"
              disabled={disabled}
              aria-describedby={describedBy}
              aria-invalid={invalid ? "true" : undefined}
              onInput={(event) => {
                const raw = event.currentTarget.value;
                if (raw === "") {
                  // Emptying a replacement field keeps the stored secret;
                  // removing it is the explicit Clear action.
                  if (secretSet) onRevert?.();
                  else onChange(undefined);
                  return;
                }
                onChange(raw);
              }}
            />
            {secretSet && onClearOverride && (
              <button
                type="button"
                className="shrink-0 rounded border px-2 py-1.5 text-xs"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
                onClick={onClearOverride}
                disabled={disabled}
              >
                Clear
              </button>
            )}
          </div>
        );
      }
      if (field.multiline) {
        return (
          <textarea
            id={id}
            className="w-full rounded border px-2.5 py-1.5 text-sm font-mono"
            style={{ ...commonStyle, minHeight: "6rem" }}
            rows={5}
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder ?? "Inherit"}
            disabled={disabled}
            aria-describedby={describedBy}
            aria-invalid={invalid ? "true" : undefined}
            onInput={(event) => {
              const raw = event.currentTarget.value;
              onChange(raw === "" ? undefined : raw);
            }}
          />
        );
      }
      return (
        <input
          id={id}
          type="text"
          className="w-full rounded border px-2.5 py-1.5 text-sm font-mono"
          style={commonStyle}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder ?? "Inherit"}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid ? "true" : undefined}
          onInput={(event) => {
            const raw = event.currentTarget.value;
            onChange(raw === "" ? undefined : raw);
          }}
        />
      );
    }
  }
}

/** Number setting with local text state so partial input never resets the caret. */
function NumberControl({
  id,
  field,
  value,
  disabled,
  describedBy,
  invalid,
  onChange,
}: {
  id: string;
  field: SettingField;
  value: unknown;
  disabled: boolean;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const format = (input: unknown) => (typeof input === "number" ? String(input) : "");
  const [text, setText] = useState(() => format(value));
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      type="number"
      className="w-full rounded border px-2.5 py-1.5 text-sm"
      style={{
        background: "var(--bg-secondary)",
        borderColor: invalid ? "#dc2626" : "var(--border)",
        color: "var(--text-primary)",
        opacity: disabled ? 0.6 : 1,
      }}
      value={text}
      min={field.minimum}
      max={field.maximum}
      step={field.step ?? 1}
      placeholder={field.placeholder ?? "Inherit"}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-invalid={invalid ? "true" : undefined}
      onInput={(event) => {
        dirty.current = true;
        const raw = event.currentTarget.value;
        setText(raw);
        if (raw !== "" && Number.isFinite(Number(raw))) onChange(Number(raw));
      }}
      onBlur={(event) => {
        const raw = event.currentTarget.value;
        dirty.current = false;
        if (raw.trim() === "") {
          onChange(undefined);
          return;
        }
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
    />
  );
}

/** JSON-typed setting: textarea committed on blur so half-typed JSON is never saved. */
function JsonControl({
  id,
  value,
  disabled,
  describedBy,
  invalid,
  onChange,
}: {
  id: string;
  value: unknown;
  disabled: boolean;
  describedBy?: string;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const format = (input: unknown) => (input === undefined ? "" : JSON.stringify(input, null, 2));
  const [text, setText] = useState(() => format(value));
  const [parseError, setParseError] = useState<string | null>(null);
  const dirty = useRef(false);

  // Adopt external resets (a save reloads the snapshot) but never clobber a
  // field the user is currently typing in.
  useEffect(() => {
    if (!dirty.current) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (raw: string) => {
    if (raw.trim() === "") {
      setParseError(null);
      dirty.current = false;
      onChange(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      setParseError(null);
      dirty.current = false;
      onChange(parsed);
    } catch (err) {
      setParseError((err as Error).message);
    }
  };

  return (
    <div>
      <textarea
        id={id}
        className="w-full rounded border px-2.5 py-1.5 text-xs font-mono"
        style={{
          background: "var(--bg-secondary)",
          borderColor: parseError || invalid ? "#dc2626" : "var(--border)",
          color: "var(--text-primary)",
          minHeight: "6rem",
          opacity: disabled ? 0.6 : 1,
        }}
        rows={5}
        value={text}
        spellcheck={false}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={parseError || invalid ? "true" : undefined}
        onInput={(event) => {
          dirty.current = true;
          setText(event.currentTarget.value);
          setParseError(null);
        }}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
      {parseError && (
        <p className="mt-1 text-xs" style={{ color: "#dc2626" }} role="alert">
          Invalid JSON: {parseError}
        </p>
      )}
    </div>
  );
}

function ReadOnlyValue({
  field,
  value,
  secretSet,
  runtimeOverridden,
  onClearOverride,
}: {
  field: SettingField;
  value: unknown;
  secretSet?: boolean;
  runtimeOverridden?: boolean;
  onClearOverride?: () => void;
}) {
  const text = field.secret && secretSet ? "••••••••" : formatConfigValue(value);
  return (
    <div className="flex items-start gap-2">
      <span
        className="min-w-0 break-words text-sm font-mono"
        style={{ color: value === undefined ? "var(--text-muted)" : "var(--text-secondary)" }}
      >
        {text}
      </span>
      {runtimeOverridden && onClearOverride && (
        <button
          type="button"
          className="ml-auto shrink-0 rounded border px-2 py-0.5 text-[11px]"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          onClick={onClearOverride}
          title="Delete the runtime override so the file value applies again"
        >
          Clear override
        </button>
      )}
    </div>
  );
}
