import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  configSnapshot,
  configLoading,
  configError,
  configView,
  configAdvanced,
  configSearch,
  configFieldErrors,
  configSaving,
  configSaveState,
  configSaveMessage,
  configLastImpact,
  loadConfigSnapshot,
  setConfigAdvanced,
  displayValue,
  effectiveValue,
  layerHasValue,
  secretIsSet,
  setDraftValue,
  setFieldError,
  clearDraftOverride,
  revertDraftValue,
  dirtyCount,
  saveLayer,
  resetDrafts,
  clearRuntimeOverride,
  queueProjectRemovals,
} from "../state/config";
import {
  pathKey,
  validateConfigValue,
  type ConfigLayerName,
  type ConfigViewName,
  type SettingField,
  type SettingImpact,
  type SettingSection,
} from "../lib/config-types";
import { SettingRow, settingElementId } from "../components/config/SettingRow";
import { ErrorSummary } from "../components/config/ErrorSummary";
import { ViewSkeleton } from "../components/ViewSkeleton";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";

const TABS: Array<{ id: ConfigViewName; label: string }> = [
  { id: "project", label: "Project" },
  { id: "global", label: "Global" },
  { id: "effective", label: "Effective" },
];

const IMPACT_TEXT: Record<SettingImpact, { tone: "ok" | "warn"; message: string }> = {
  live: { tone: "ok", message: "Applied. The plugin picks up file changes automatically." },
  reindex: { tone: "warn", message: "Saved. Run a reindex for the change to affect the stored index." },
  restart: { tone: "warn", message: "Saved. Restart OpenCode (and this UI) for the change to take effect." },
};

/** Human label for a schema section. */
function sectionLabel(sections: SettingSection[], id: string): string {
  return sections.find((section) => section.id === id)?.label ?? id;
}

export function Config() {
  const snapshot = configSnapshot.value;
  const loading = configLoading.value;
  const error = configError.value;
  const view = configView.value;
  const query = configSearch.value.trim().toLowerCase();
  const advanced = configAdvanced.value;
  const [activeSection, setActiveSection] = useState<string>("");

  useEffect(() => {
    void loadConfigSnapshot();
  }, []);

  const sections = snapshot?.schema.sections ?? [];
  const allFields = useMemo(() => sections.flatMap((section) => section.fields), [sections]);
  const layer: ConfigLayerName | null = view === "effective" ? null : view;
  const layerExists = layer ? snapshot?.layers[layer]?.exists === true : false;
  const layerError = layer ? snapshot?.layers[layer]?.error : undefined;
  const dirty = layer && snapshot ? dirtyCount(layer, allFields) : 0;
  const totalDirty = snapshot
    ? dirtyCount("project", allFields) + dirtyCount("global", allFields)
    : 0;

  // Warn before leaving the app with unsaved edits.
  useEffect(() => {
    if (totalDirty === 0) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [totalDirty]);

  // Scroll spy for the section navigation.
  useEffect(() => {
    if (!snapshot) return;
    const main = document.getElementById("main-content");
    if (!main) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = sections[0]?.id ?? "";
      for (const section of sections) {
        const element = document.getElementById(`section-${section.id}`);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= 140) current = section.id;
      }
      setActiveSection(current);
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(update);
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      main.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [snapshot, view, advanced, query, sections]);

  if (loading && !snapshot) return <ViewSkeleton type="card" />;
  if (error && !snapshot) {
    return <ErrorState message={error} onRetry={() => void loadConfigSnapshot()} />;
  }
  if (!snapshot) {
    return <EmptyState icon="⚙" message="No configuration available." />;
  }

  const runtimePaths = allFields
    .filter((field) => snapshot.provenance[pathKey(field.path)] === "runtime")
    .map((field) => pathKey(field.path));

  const matches = (section: SettingSection, field: SettingField): boolean => {
    if (!query) {
      return advanced || !field.advanced;
    }
    const haystack = `${section.label} ${field.label} ${field.path.join(".")} ${field.description ?? ""}`.toLowerCase();
    return query.split(/\s+/).every((token) => haystack.includes(token));
  };

  const visibleSections = sections
    .map((section) => ({ section, fields: section.fields.filter((field) => matches(section, field)) }))
    .filter(({ fields, section }) => fields.length > 0 || (!query && section.fields.length === 0));

  const advancedCount = allFields.filter((field) => field.advanced).length;
  const labels = Object.fromEntries(allFields.map((field) => [pathKey(field.path), field.label]));
  const currentPath = layer ? snapshot.layers[layer].path : "<effective configuration>";

  const scrollToSection = (id: string) => {
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollToField = (field: SettingField) => {
    setTimeout(() => {
      const row = document.getElementById(settingElementId(field.path));
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      row?.querySelector<HTMLElement>("input, select, textarea, button[role='switch']")?.focus();
    }, 0);
  };

  const discard = () => {
    if (!layer) return;
    resetDrafts(layer);
    configFieldErrors.value = {};
    configSaveState.value = "idle";
    configSaveMessage.value = null;
  };

  const reload = () => {
    if (totalDirty > 0 && !window.confirm("Discard unsaved changes and reload the configuration from disk?")) {
      return;
    }
    // A reload replaces the snapshot, so the previous save result no longer
    // describes what is on screen.
    configSaveMessage.value = null;
    configLastImpact.value = null;
    void loadConfigSnapshot(false);
  };

  const save = async () => {
    if (!layer) return;
    await saveLayer(layer, allFields);
  };

  const impact = configSaveState.value === "saved" ? configLastImpact.value : null;
  const impactInfo = impact ? IMPACT_TEXT[impact] : null;

  return (
    <div className="pb-24">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Configuration</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            Edit the project and machine-global layers, then inspect the merged result.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <label htmlFor="config-search" className="sr-only">
              Search settings
            </label>
            <input
              id="config-search"
              type="search"
              className="w-56 rounded-lg border px-2.5 py-1.5 text-sm"
              style={{ background: "var(--bg-secondary)", borderColor: "var(--border)", color: "var(--text-primary)" }}
              placeholder="Search settings…"
              value={configSearch.value}
              onInput={(event) => configSearch.value = event.currentTarget.value}
            />
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={advanced}
            className="inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
            onClick={() => setConfigAdvanced(!advanced)}
            title={advanced ? "Hide rarely used settings" : `Show all ${advancedCount} advanced settings`}
          >
            <span
              className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full"
              style={{ background: advanced ? "var(--accent)" : "var(--bg-tertiary)" }}
            >
              <span
                className="inline-block h-3 w-3 rounded-full bg-white transition-transform"
                style={{ transform: advanced ? "translateX(14px)" : "translateX(2px)" }}
              />
            </span>
            Advanced
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {advancedCount}
            </span>
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-2" style={{ borderColor: "var(--border)" }}>
        <div
          role="tablist"
          aria-label="Configuration layer"
          className="flex gap-1 rounded-lg p-1"
          style={{ background: "var(--bg-secondary)" }}
        >
          {TABS.map((tab) => {
            const active = view === tab.id;
            const tabDirty = tab.id === "effective" ? 0 : dirtyCount(tab.id, allFields);
            return (
              <button
                key={tab.id}
                id={`config-tab-${tab.id}`}
                role="tab"
                type="button"
                aria-selected={active}
                aria-controls="config-panel"
                className="rounded-md px-3 py-1.5 text-sm transition-colors"
                style={
                  active
                    ? { background: "var(--bg-primary)", color: "var(--text-primary)", boxShadow: "0 1px 2px rgba(0,0,0,0.12)" }
                    : { color: "var(--text-muted)" }
                }
                onClick={() => {
                  configView.value = tab.id;
                  configFieldErrors.value = {};
                }}
              >
                {tab.label}
                {tabDirty > 0 && (
                  <span
                    className="ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={{ background: "var(--accent)", color: "#fff" }}
                  >
                    {tabDirty}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs font-mono" style={{ color: "var(--text-muted)" }} title={currentPath}>
          {currentPath}
        </p>
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          onClick={reload}
          disabled={loading || configSaving.value}
        >
          {loading ? "Reloading…" : "Reload"}
        </button>
      </div>

      {/* Warnings from the server: invalid JSON, shadowed provider keys, unknown sections. */}
      {snapshot.warnings.map((warning) => {
        const isError = warning.code === "invalid-json";
        return (
          <div
            key={`${warning.code}-${warning.paths?.join(",") ?? ""}`}
            className="mb-3 rounded-lg border p-3 text-sm"
            role={isError ? "alert" : "status"}
            style={{
              borderColor: isError ? "#dc2626" : "#d97706",
              background: isError
                ? "color-mix(in srgb, #dc2626 8%, transparent)"
                : "color-mix(in srgb, #d97706 8%, transparent)",
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p style={{ color: isError ? "#dc2626" : "#b45309" }}>{warning.message}</p>
                {warning.paths && warning.paths.length > 0 && (
                  <p className="mt-1 text-xs font-mono break-all" style={{ color: "var(--text-muted)" }}>
                    {warning.paths.join(", ")}
                  </p>
                )}
              </div>
              {warning.code === "provider-shadowed" && warning.paths && (
                <button
                  type="button"
                  className="shrink-0 rounded border px-2 py-1 text-xs"
                  style={{ borderColor: "#d97706", color: "#b45309" }}
                  onClick={() => {
                    queueProjectRemovals(warning.paths ?? []);
                    configView.value = "project";
                  }}
                >
                  Remove from project
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* Runtime overrides shadow the file values. */}
      {runtimePaths.length > 0 && (
        <div
          className="mb-3 flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3 text-sm"
          style={{ borderColor: "#d97706", background: "color-mix(in srgb, #d97706 8%, transparent)" }}
          role="status"
        >
          <div>
            <p style={{ color: "#b45309" }}>
              {runtimePaths.length} setting{runtimePaths.length === 1 ? " is" : "s are"} overridden at runtime and shadow the
              file value.
            </p>
            <p className="mt-1 text-xs font-mono break-all" style={{ color: "var(--text-muted)" }}>
              {runtimePaths.join(", ")}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: "#d97706", color: "#b45309" }}
              onClick={() => configView.value = "effective"}
            >
              Review
            </button>
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
              onClick={() => runtimePaths.forEach((dotted) => void clearRuntimeOverride(dotted.split(".")))}
            >
              Clear all
            </button>
          </div>
        </div>
      )}

      {layerError && (
        <div
          className="mb-3 rounded-lg border p-3 text-sm"
          role="alert"
          style={{ borderColor: "#dc2626", background: "color-mix(in srgb, #dc2626 8%, transparent)", color: "#dc2626" }}
        >
          This layer cannot be parsed: {layerError}. Fix the file on disk before editing it here.
        </div>
      )}

      {impactInfo && (
        <div
          className="mb-3 rounded-lg border p-3 text-sm"
          role="status"
          style={{
            borderColor: impactInfo.tone === "ok" ? "var(--accent)" : "#d97706",
            background:
              impactInfo.tone === "ok"
                ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                : "color-mix(in srgb, #d97706 8%, transparent)",
            color: impactInfo.tone === "ok" ? "var(--text-primary)" : "#b45309",
          }}
        >
          {impactInfo.message}
        </div>
      )}

      <ErrorSummary errors={configFieldErrors.value} labels={labels} />

      {query && visibleSections.length === 0 && (
        <p className="mb-4 text-sm" style={{ color: "var(--text-muted)" }}>
          No settings match “{configSearch.value}”.
        </p>
      )}

      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-6">
        <nav aria-label="Configuration sections" className="mb-3 lg:mb-0">
          <div className="flex gap-1 overflow-x-auto pb-2 lg:sticky lg:top-0 lg:max-h-[calc(100vh-14rem)] lg:flex-col lg:overflow-y-auto lg:pb-0">
            {visibleSections.map(({ section, fields }) => {
              const active = activeSection === section.id;
              const sectionDirty = layer ? dirtyCount(layer, fields) : 0;
              return (
                <button
                  key={section.id}
                  type="button"
                  className="shrink-0 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors lg:w-full"
                  style={
                    active
                      ? { background: "color-mix(in srgb, var(--accent) 14%, transparent)", color: "var(--accent)" }
                      : { color: "var(--text-secondary)" }
                  }
                  aria-current={active ? "true" : undefined}
                  onClick={() => scrollToSection(section.id)}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate">{section.label}</span>
                    {sectionDirty > 0 && (
                      <span className="text-[10px] font-medium" style={{ color: "var(--accent)" }}>
                        {sectionDirty}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>

        <div id="config-panel" role="tabpanel" aria-labelledby={`config-tab-${view}`} className="min-w-0">
          {visibleSections.map(({ section, fields }) => (
            <section
              key={section.id}
              id={`section-${section.id}`}
              className="mb-5 scroll-mt-4 rounded-lg border"
              style={{ borderColor: "var(--border)", background: "var(--bg-card)" }}
            >
              <header className="border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
                <h2 className="text-base font-semibold">{section.label}</h2>
                {section.description && (
                  <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                    {section.description}
                  </p>
                )}
              </header>
              <div className="px-4">
                {fields.map((field) => {
                  const key = pathKey(field.path);
                  const globalOnly = field.scope === "global";
                  const disabledOnProject = layer === "project" && globalOnly;
                  return (
                    <SettingRow
                      key={key}
                      field={field}
                      value={
                        layer ? displayValue(snapshot, layer, field) : effectiveValue(snapshot, field)
                      }
                      provenance={layer ? undefined : snapshot.provenance[key]}
                      isSetHere={layer ? layerHasValue(snapshot, layer, field) : undefined}
                      secretSet={
                        layer
                          ? secretIsSet(snapshot, layer, field)
                          : effectiveValue(snapshot, field) === "***"
                      }
                      runtimeOverridden={!layer && snapshot.provenance[key] === "runtime"}
                      readOnly={!layer}
                      disabled={disabledOnProject}
                      disabledReason={disabledOnProject ? "Global only" : undefined}
                      onEditElsewhere={
                        disabledOnProject
                          ? () => {
                              configView.value = "global";
                              scrollToField(field);
                            }
                          : undefined
                      }
                      error={configFieldErrors.value[key]}
                      onClearOverride={
                        layer
                          ? () => {
                              clearDraftOverride(layer, field);
                              setFieldError(key, undefined);
                            }
                          : () => void clearRuntimeOverride(field.path)
                      }
                      onRevert={() => {
                        if (layer) revertDraftValue(layer, field);
                      }}
                      onChange={(value) => {
                        if (!layer) return;
                        setDraftValue(layer, field, value);
                        setFieldError(key, validateConfigValue(field, value));
                      }}
                    />
                  );
                })}
                {fields.length === 0 && (
                  <p className="py-4 text-sm" style={{ color: "var(--text-muted)" }}>
                    No settings match the current search.
                  </p>
                )}
              </div>
            </section>
          ))}

          <RawJson
            title={layer ? `Raw JSON — ${layer} layer` : "Raw JSON — effective configuration"}
            path={currentPath}
            value={layer ? snapshot.layers[layer].values : snapshot.config}
            exists={layer ? layerExists : true}
            note={
              layer
                ? "Secret values are omitted from this preview. A saved secret is reported as set."
                : "Secrets are shown as *** — their values never leave the server."
            }
          />

          {snapshot.runtimeOverrides.values && Object.keys(snapshot.runtimeOverrides.values).length > 0 && (
            <RawJson
              title="Raw JSON — runtime overrides"
              path={snapshot.runtimeOverrides.path}
              value={snapshot.runtimeOverrides.values}
              exists
              note="Created by the TUI settings dialog. A file save clears matching entries."
            />
          )}
        </div>
      </div>

      {layer && (
        <div
          className="sticky bottom-0 z-10 -mx-6 mt-4 flex flex-wrap items-center gap-3 border-t px-6 py-3"
          style={{ borderColor: "var(--border)", background: "var(--bg-primary)" }}
          role="region"
          aria-label="Save configuration changes"
        >
          <p className="text-sm" aria-live="polite" style={{ color: configSaveState.value === "error" ? "#dc2626" : "var(--text-secondary)" }}>
            {configSaveState.value === "error"
              ? configSaveMessage.value
              : dirty > 0
                ? `${dirty} unsaved change${dirty === 1 ? "" : "s"} in the ${layer} layer`
                : configSaveMessage.value ?? "No unsaved changes"}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
              style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
              onClick={discard}
              disabled={configSaving.value || dirty === 0}
            >
              Discard
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: "var(--accent)" }}
              onClick={() => void save()}
              disabled={configSaving.value || dirty === 0}
            >
              {configSaving.value ? "Saving…" : `Save ${layer}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Read-only JSON preview for one layer. */
function RawJson({
  title,
  path,
  value,
  exists,
  note,
}: {
  title: string;
  path: string;
  value: unknown;
  exists: boolean;
  note: string;
}) {
  const json = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const ref = useRef<HTMLDetailsElement | null>(null);
  return (
    <details ref={ref} className="mb-5 rounded-lg border" style={{ borderColor: "var(--border)", background: "var(--bg-card)" }}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        <span className="flex flex-wrap items-center gap-2">
          <span>{title}</span>
          <code className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
            {path}
          </code>
        </span>
      </summary>
      <div className="border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
        {!exists ? (
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            This file does not exist yet. Saving a setting creates it.
          </p>
        ) : (
          <>
            <pre
              className="max-h-96 overflow-auto rounded p-3 text-xs"
              style={{ background: "var(--bg-code)", color: "var(--text-secondary)" }}
            >
              {json}
            </pre>
            <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
              {note}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
