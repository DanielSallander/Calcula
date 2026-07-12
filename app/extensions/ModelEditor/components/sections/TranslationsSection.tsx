// FILENAME: app/extensions/ModelEditor/components/sections/TranslationsSection.tsx
// PURPOSE: Translations section of the Model Editor window: list the model's
//          cultures (per-locale display-name/description translations for
//          tables, columns, and measures) and add/edit/delete them.
//          DISPLAY-ONLY — field lists and editors swap labels for the active
//          locale; keys, queries, and expressions keep the raw names.

import React, { useMemo, useState } from "react";
import { biModelDeleteCulture, biModelUpsertCulture } from "@api";
import type { ModelCultureInfo, ModelOverview, NameTranslationInfo } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function TranslationsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelCultureInfo | null } | null>(null);

  const handleDelete = async (c: ModelCultureInfo) => {
    if (!window.confirm(`Delete culture '${c.locale}'?`)) return;
    try {
      applyOverview(await biModelDeleteCulture(connectionId, c.locale));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Translations ({overview.cultures.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.cultures.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No cultures defined — a culture translates the model&apos;s table, column, and measure
            display names (and descriptions) for one locale, e.g. sv-SE. Display-only: queries and
            expressions keep the raw names. Create one with New.
          </div>
        )}
        {overview.cultures.map((c) => (
          <div
            key={c.locale}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{c.locale}</strong>
              <span style={styles.muted}>
                {" "}
                — {c.tables.length} table{c.tables.length === 1 ? "" : "s"}, {c.columns.length}{" "}
                column{c.columns.length === 1 ? "" : "s"}, {c.measures.length} measure
                {c.measures.length === 1 ? "" : "s"} translated
              </span>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: c })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(c)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <CultureModal
          connectionId={connectionId}
          overview={overview}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Add/edit modal
// ============================================================================

/** Per-object draft: what the two inputs currently hold. */
type DraftMap = Record<string, { displayName: string; description: string }>;

/** Seed a draft from the culture being edited (case-insensitive object match,
 *  since the engine stores/looks up translation objects case-insensitively). */
function seedDraft(objects: string[], entries: NameTranslationInfo[] | undefined): DraftMap {
  const byObject = new Map<string, NameTranslationInfo>();
  for (const e of entries ?? []) {
    const key = e.object.trim().toLowerCase();
    if (!byObject.has(key)) byObject.set(key, e);
  }
  const draft: DraftMap = {};
  for (const o of objects) {
    const e = byObject.get(o.trim().toLowerCase());
    if (e) {
      draft[o] = { displayName: e.displayName ?? "", description: e.description ?? "" };
    }
  }
  return draft;
}

/** Only rows where the author typed at least one of the two values are sent. */
function collectTranslations(objects: string[], draft: DraftMap): NameTranslationInfo[] {
  const out: NameTranslationInfo[] = [];
  for (const o of objects) {
    const d = draft[o];
    if (!d) continue;
    const displayName = d.displayName.trim();
    const description = d.description.trim();
    if (!displayName && !description) continue;
    out.push({
      object: o,
      displayName: displayName || null,
      description: description || null,
    });
  }
  return out;
}

function CultureModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelCultureInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  // The translatable model objects, in model order.
  const tableObjects = useMemo(() => overview.tables.map((t) => t.name), [overview.tables]);
  const columnObjects = useMemo(
    () => overview.tables.flatMap((t) => t.columns.map((c) => `${t.name}[${c.name}]`)),
    [overview.tables],
  );
  const measureObjects = useMemo(() => overview.measures.map((m) => m.name), [overview.measures]);

  const [locale, setLocale] = useState(original?.locale ?? "");
  const [tablesDraft, setTablesDraft] = useState<DraftMap>(() =>
    seedDraft(tableObjects, original?.tables),
  );
  const [columnsDraft, setColumnsDraft] = useState<DraftMap>(() =>
    seedDraft(columnObjects, original?.columns),
  );
  const [measuresDraft, setMeasuresDraft] = useState<DraftMap>(() =>
    seedDraft(measureObjects, original?.measures),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertCulture({
          connectionId,
          originalLocale: original?.locale ?? null,
          locale: locale.trim(),
          tables: collectTranslations(tableObjects, tablesDraft),
          columns: collectTranslations(columnObjects, columnsDraft),
          measures: collectTranslations(measureObjects, measuresDraft),
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Culture: ${original.locale}` : "New Culture"}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={styles.primaryBtn}
            disabled={busy || !locale.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ ...styles.hint, marginBottom: 8 }}>
        A culture translates DISPLAY names and descriptions for one locale — field lists show the
        translation, while queries and expressions keep the raw names. Leave a row empty to keep
        the untranslated text.
      </div>
      <Field label="Locale" hint="BCP-47 locale id this culture serves.">
        <input
          style={styles.input}
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          placeholder="sv-SE"
        />
      </Field>
      <TranslationGroup
        title="Tables"
        objects={tableObjects}
        draft={tablesDraft}
        onChange={setTablesDraft}
        defaultOpen={true}
      />
      <TranslationGroup
        title="Columns"
        objects={columnObjects}
        draft={columnsDraft}
        onChange={setColumnsDraft}
        defaultOpen={false}
        searchable={true}
      />
      <TranslationGroup
        title="Measures"
        objects={measureObjects}
        draft={measuresDraft}
        onChange={setMeasuresDraft}
        defaultOpen={false}
      />
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

// ============================================================================
// One collapsible group (Tables / Columns / Measures): a row per model object
// with two inputs — translated display name + translated description.
// ============================================================================

function TranslationGroup({
  title,
  objects,
  draft,
  onChange,
  defaultOpen,
  searchable,
}: {
  title: string;
  objects: string[];
  draft: DraftMap;
  onChange: (next: DraftMap) => void;
  defaultOpen: boolean;
  /** Show a filter input above the rows (for wide models' column lists). */
  searchable?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState("");

  const translatedCount = useMemo(
    () =>
      objects.filter((o) => {
        const d = draft[o];
        return !!d && (d.displayName.trim().length > 0 || d.description.trim().length > 0);
      }).length,
    [objects, draft],
  );

  const visibleObjects = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return objects;
    // Match the raw object name OR the typed translation, so an author can
    // find a row again by what they entered.
    return objects.filter(
      (o) =>
        o.toLowerCase().includes(q) ||
        (draft[o]?.displayName ?? "").toLowerCase().includes(q),
    );
  }, [objects, filter, draft]);

  const setCell = (object: string, field: "displayName" | "description", value: string) => {
    const current = draft[object] ?? { displayName: "", description: "" };
    onChange({ ...draft, [object]: { ...current, [field]: value } });
  };

  const rowInput: React.CSSProperties = { ...styles.input, flex: 1, minWidth: 0 };

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          userSelect: "none",
          fontWeight: 600,
          fontSize: 13,
          padding: "4px 0",
        }}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span style={{ fontSize: 10, width: 12 }}>{open ? "▼" : "▶"}</span>
        <span>{title}</span>
        <span style={styles.muted}>
          ({translatedCount} of {objects.length} translated)
        </span>
      </div>
      {open && (
        <div style={{ border: "1px solid #ddd", borderRadius: 3, padding: 6 }}>
          {searchable && (
            <input
              style={{ ...styles.input, marginBottom: 6 }}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${title.toLowerCase()}…`}
            />
          )}
          <div
            style={{
              maxHeight: 200,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {visibleObjects.length === 0 && (
              <div style={{ ...styles.muted, padding: 4 }}>
                {objects.length === 0
                  ? `The model has no ${title.toLowerCase()}.`
                  : "No rows match the filter."}
              </div>
            )}
            {visibleObjects.map((o) => (
              <div key={o} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  title={o}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                  }}
                >
                  {o}
                </span>
                <input
                  style={rowInput}
                  value={draft[o]?.displayName ?? ""}
                  onChange={(e) => setCell(o, "displayName", e.target.value)}
                  placeholder="Translated name"
                />
                <input
                  style={rowInput}
                  value={draft[o]?.description ?? ""}
                  onChange={(e) => setCell(o, "description", e.target.value)}
                  placeholder="Translated description"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
