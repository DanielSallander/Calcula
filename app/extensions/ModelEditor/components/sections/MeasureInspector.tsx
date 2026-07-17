// FILENAME: app/extensions/ModelEditor/components/sections/MeasureInspector.tsx
// PURPOSE: Quick-inspect side pane for the selected measure (Power-BI-style
//          properties pane): every property visible at a single click, the
//          light metadata (name, description, folder, formats, detail rows,
//          hidden) editable in place — committed on blur/change via a full
//          re-save that carries ALL other attributes along — plus the formula
//          (read-only; "Edit formula…" opens the workspace modal) and lineage.
//
//          Commits are SERIALIZED through a promise queue and build on the
//          last SUBMITTED state (baseRef), not the measure prop — the prop
//          lags until applyMeasures lands, and a blur-commit is often followed
//          immediately by the interaction that caused it (clicking Hidden
//          while Description is focused). Drafts reseed when the measure
//          changes externally (drag to a folder, the formula modal), adopting
//          the new value only where the draft was un-diverged so in-progress
//          typing is never clobbered. Mount with key={measure.name}.

import React, { useEffect, useRef, useState } from "react";
import { biModelUpsertMeasure } from "@api";
import type { MeasureLineage, ModelMeasureInfo } from "@api";
import { Badge, styles } from "../editorShared";
import { folderDepth, splitFolderPath } from "../../lib/measureFolders";

/** A measure-property patch: `undefined` = keep the current value. */
interface MeasurePatch {
  name?: string;
  description?: string;
  formatString?: string;
  formatStringExpression?: string;
  detailRows?: string[];
  group?: string | null;
  hidden?: boolean;
}

export function MeasureInspector({
  connectionId,
  measure,
  lineage,
  folders,
  readOnly,
  onApply,
  onEditFormula,
  reportError,
}: {
  connectionId: string;
  measure: ModelMeasureInfo;
  lineage: MeasureLineage | null;
  /** Existing display-folder paths (incl. ancestors) for the folder picker. */
  folders: string[];
  readOnly: boolean;
  /** Install the fresh measure list; newName is set when the commit renamed. */
  onApply: (measures: ModelMeasureInfo[], newName?: string) => void;
  onEditFormula: () => void;
  reportError: (err: unknown) => void;
}): React.ReactElement {
  const [name, setName] = useState(measure.name);
  const [description, setDescription] = useState(measure.description ?? "");
  const [formatString, setFormatString] = useState(measure.formatString ?? "");
  const [formatStringExpression, setFormatStringExpression] = useState(
    measure.formatStringExpression ?? "",
  );
  const [detailRows, setDetailRows] = useState((measure.detailRows ?? []).join(", "));
  const [hidden, setHidden] = useState(measure.isHidden);

  // The base for the NEXT commit — the last submitted (or authoritative) state.
  const baseRef = useRef<ModelMeasureInfo>(measure);
  // Serializes commits so rapid consecutive edits all apply, in order.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  // Re-adopt the authoritative state whenever it lands (refs must not be
  // written during render; user events cannot fire between render and this
  // effect, so commit handlers always see the synced base).
  useEffect(() => {
    baseRef.current = measure;
  }, [measure]);

  // Reseed on external change (render-adjust pattern): adopt each new value
  // only where the draft still matched the previous seed.
  const [seed, setSeed] = useState(measure);
  if (seed !== measure) {
    if (name === seed.name) setName(measure.name);
    if (description === (seed.description ?? "")) setDescription(measure.description ?? "");
    if (formatString === (seed.formatString ?? "")) setFormatString(measure.formatString ?? "");
    if (formatStringExpression === (seed.formatStringExpression ?? ""))
      setFormatStringExpression(measure.formatStringExpression ?? "");
    if (detailRows === (seed.detailRows ?? []).join(", "))
      setDetailRows((measure.detailRows ?? []).join(", "));
    if (hidden === seed.isHidden) setHidden(measure.isHidden);
    setSeed(measure);
  }

  const commit = (patch: MeasurePatch): void => {
    if (readOnly) return;
    queueRef.current = queueRef.current.then(async () => {
      const base = baseRef.current;
      const newName = (patch.name ?? base.name).trim() || base.name;
      const payload = {
        connectionId,
        originalName: base.name,
        name: newName,
        formula: base.formula,
        description:
          patch.description !== undefined
            ? patch.description.trim() || null
            : base.description,
        formatString:
          patch.formatString !== undefined
            ? patch.formatString.trim() || null
            : base.formatString,
        formatStringExpression:
          patch.formatStringExpression !== undefined
            ? patch.formatStringExpression.trim() || null
            : base.formatStringExpression,
        detailRows: patch.detailRows ?? base.detailRows,
        group: patch.group !== undefined ? patch.group : (base.group ?? null),
        hidden: patch.hidden !== undefined ? patch.hidden : null,
      };
      // Optimistic: a queued follow-up commit builds on what was submitted.
      baseRef.current = {
        ...base,
        name: newName,
        description: payload.description,
        formatString: payload.formatString,
        formatStringExpression: payload.formatStringExpression,
        detailRows: payload.detailRows,
        group: patch.group !== undefined ? patch.group : base.group,
        isHidden: patch.hidden !== undefined ? patch.hidden : base.isHidden,
      };
      try {
        const list = await biModelUpsertMeasure(payload);
        onApply(list, newName !== base.name ? newName : undefined);
      } catch (err: unknown) {
        reportError(err);
        // Roll back to the pre-commit state so the drafts don't silently
        // differ from the model.
        baseRef.current = base;
        setName(base.name);
        setDescription(base.description ?? "");
        setFormatString(base.formatString ?? "");
        setFormatStringExpression(base.formatStringExpression ?? "");
        setDetailRows((base.detailRows ?? []).join(", "));
        setHidden(base.isHidden);
      }
    });
  };

  const commitOnEnter = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter") (e.target as HTMLElement).blur();
  };

  const label: React.CSSProperties = { ...styles.label, marginTop: 8 };
  const group = measure.group ?? "";

  return (
    <div
      style={{
        ...styles.card,
        width: 300,
        flexShrink: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>Measure</span>
        {measure.isHidden && <Badge tone="warn">hidden</Badge>}
      </div>

      <label style={label}>Name</label>
      <input
        style={styles.input}
        value={name}
        disabled={readOnly}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={commitOnEnter}
        onBlur={() => {
          const trimmed = name.trim();
          if (!trimmed) {
            setName(baseRef.current.name);
          } else if (trimmed !== baseRef.current.name) {
            void commit({ name: trimmed });
          }
        }}
      />

      <label style={label}>Description</label>
      <textarea
        style={{ ...styles.textarea, fontFamily: "inherit", minHeight: 48 }}
        rows={2}
        value={description}
        disabled={readOnly}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => {
          if (description !== (baseRef.current.description ?? "")) void commit({ description });
        }}
      />

      <label style={label}>Folder</label>
      <select
        style={styles.input}
        value={folders.includes(group) ? group : ""}
        disabled={readOnly}
        onChange={(e) => void commit({ group: e.target.value || null })}
      >
        <option value="">(No folder)</option>
        {folders.map((f) => (
          <option key={f} value={f} title={f}>
            {/* NBSP indentation — regular spaces collapse inside <option>. */}
            {`${"  ".repeat(folderDepth(f))}${splitFolderPath(f).slice(-1)[0]}`}
          </option>
        ))}
      </select>

      <label style={label}>Format</label>
      <input
        style={{ ...styles.input, fontFamily: "Consolas, 'Cascadia Code', monospace" }}
        value={formatString}
        placeholder="#,##0.00"
        disabled={readOnly}
        onChange={(e) => setFormatString(e.target.value)}
        onKeyDown={commitOnEnter}
        onBlur={() => {
          if (formatString !== (baseRef.current.formatString ?? ""))
            void commit({ formatString });
        }}
      />

      <label
        style={label}
        title="Evaluated once per query under the active filters; overrides the static format when it yields a value."
      >
        Dynamic format
      </label>
      <input
        style={{ ...styles.input, fontFamily: "Consolas, 'Cascadia Code', monospace" }}
        value={formatStringExpression}
        placeholder='IF([X] > 1e6, "#,##0,,\"M\"", "#,##0")'
        disabled={readOnly}
        onChange={(e) => setFormatStringExpression(e.target.value)}
        onKeyDown={commitOnEnter}
        onBlur={() => {
          if (formatStringExpression !== (baseRef.current.formatStringExpression ?? ""))
            void commit({ formatStringExpression });
        }}
      />

      <label
        style={label}
        title="Drill-through projection: comma-separated Table[column] references returned when a user drills a cell of this measure."
      >
        Detail rows
      </label>
      <input
        style={{ ...styles.input, fontFamily: "Consolas, 'Cascadia Code', monospace" }}
        value={detailRows}
        placeholder="Sales[order_id], Customer[name]"
        disabled={readOnly}
        onChange={(e) => setDetailRows(e.target.value)}
        onKeyDown={commitOnEnter}
        onBlur={() => {
          if (detailRows !== (baseRef.current.detailRows ?? []).join(", ")) {
            void commit({
              detailRows: detailRows
                .split(",")
                .map((r) => r.trim())
                .filter((r) => r.length > 0),
            });
          }
        }}
      />

      <label
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 10 }}
      >
        <input
          type="checkbox"
          checked={hidden}
          disabled={readOnly}
          onChange={(e) => {
            setHidden(e.target.checked);
            void commit({ hidden: e.target.checked });
          }}
        />
        Hidden (not offered in field lists; still referencable)
      </label>

      <label style={label}>Formula</label>
      <div
        style={{
          fontFamily: "Consolas, 'Cascadia Code', monospace",
          fontSize: 11,
          background: "#f7f8fa",
          border: "1px solid #e5e5e5",
          borderRadius: 3,
          padding: "6px 8px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 120,
          overflowY: "auto",
        }}
      >
        {measure.formula || "(empty — BLANK())"}
      </div>
      <div style={{ marginTop: 6 }}>
        <button style={styles.btn} disabled={readOnly} onClick={onEditFormula}>
          Edit formula…
        </button>
      </div>

      <div style={{ borderTop: "1px solid #eee", marginTop: 12, paddingTop: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Lineage</div>
        {!lineage && <div style={styles.muted}>Loading…</div>}
        {lineage && (
          <>
            {lineage.columns.length > 0 && (
              <div style={{ marginBottom: 3 }}>
                <span style={styles.muted}>Columns: </span>
                {lineage.columns.map((c) => `${c.table}[${c.column}]`).join(", ")}
              </div>
            )}
            {lineage.measures.length > 0 && (
              <div style={{ marginBottom: 3 }}>
                <span style={styles.muted}>Uses measures: </span>
                {lineage.measures.join(", ")}
              </div>
            )}
            {lineage.referencedBy.length > 0 && (
              <div style={{ marginBottom: 3 }}>
                <span style={styles.muted}>Referenced by: </span>
                {lineage.referencedBy.join(", ")}
              </div>
            )}
            {lineage.columns.length === 0 &&
              lineage.measures.length === 0 &&
              lineage.referencedBy.length === 0 && (
                <div style={styles.muted}>No dependencies.</div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
