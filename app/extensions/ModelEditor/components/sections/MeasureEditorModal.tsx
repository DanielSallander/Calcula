// FILENAME: app/extensions/ModelEditor/components/sections/MeasureEditorModal.tsx
// PURPOSE: Modal for ONE model measure (add or edit) inside the Model Editor
//          window. Hosts the shared ExpressionWorkspace (Monaco front and
//          centre, flanked by the tables & columns tree and the function
//          reference), validates through the engine parser (positioned
//          markers) and installs the edit via bi_model_upsert_measure on save.
//
// LAYOUT:
//   ┌ Name ───────────┐ ┌ Description ────────────────────────────┐
//   ├─────────────────────────────────────────────────────────────┤
//   │              ExpressionWorkspace (shared)                    │
//   ├─────────────────────────────────────────────────────────────┤
//   │ ▸ More options (Folder, Format, Dynamic format, Detail rows) │
//   └─────────────────────────────────────────────────────────────┘

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ModelMeasureInfo, ModelOverview } from "@api";
import { biModelUpsertMeasure, biModelValidateMeasure } from "@api";
import { Field, Modal, styles } from "../editorShared";
import { NUMBER_FORMAT_PRESETS } from "../../../_shared/components/NumberFormatModal";
import {
  folderDepth,
  folderPathsWithAncestors,
  normalizeFolderPath,
  splitFolderPath,
} from "../../lib/measureFolders";
import {
  ExpressionWorkspace,
  type ExpressionWorkspaceHandle,
} from "./ExpressionWorkspace";

/** Best-effort preview of a number-format code applied to a sample value.
 *  Covers the common cases (decimals, thousands grouping, %, currency prefix);
 *  the authoritative formatting still happens in the engine. */
function previewFormat(value: number, fmt: string): string {
  const f = fmt.trim();
  if (!f) return String(value); // General
  const isPercent = f.includes("%");
  const n = isPercent ? value * 100 : value;
  const dot = f.indexOf(".");
  const decimals = dot >= 0 ? (f.slice(dot + 1).match(/[0#]/g)?.length ?? 0) : 0;
  const grouping = f.replace(/\[[^\]]*\]/g, "").includes(",");
  let prefix = "";
  const cur = /\[\$([^\]]+)\]/.exec(f);
  if (cur) prefix = `${cur[1].split("-")[0].trim()} `;
  else if (f.includes("$")) prefix = "$";
  const body = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  }).format(n);
  return `${prefix}${body}${isPercent ? "%" : ""}`;
}

/** Preset dropdown + custom code + live preview for a measure's number format. */
function FormatField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const isPreset = NUMBER_FORMAT_PRESETS.some((p) => p.value === value);
  const [custom, setCustom] = useState(!isPreset && value !== "");
  const sample = value.includes("%") ? 0.1235 : 1234.567;
  return (
    <Field label="Format (optional)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={{ ...styles.input, maxWidth: 340 }}
          value={custom ? "__custom__" : value}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {NUMBER_FORMAT_PRESETS.map((p) => (
            <option key={p.value || "general"} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {custom && (
          <input
            style={{ ...styles.input, flex: 1, minWidth: 120, fontFamily: "monospace" }}
            value={value}
            placeholder="#,##0.00"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <span style={{ ...styles.muted, fontSize: 12, whiteSpace: "nowrap" }}>
          Preview: <strong style={{ color: "#222" }}>{previewFormat(sample, value)}</strong>
        </span>
      </div>
    </Field>
  );
}

/** Folder (measure-group) picker: choose an existing folder, none, or type a
 *  new one. Groups measures into folders in the measures list; the group ships
 *  with the model when it is published as a package. */
function FolderField({
  value,
  onChange,
  groups,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: string[];
}): React.ReactElement {
  const known = groups.includes(value);
  const [custom, setCustom] = useState(value !== "" && !known);
  // If a name typed as "new" turns out to be a real folder (e.g. it was added
  // in another window while this modal was open), stop showing it as new so the
  // dropdown reflects the actual selection. Converges: once custom is false the
  // condition is false too.
  if (custom && value !== "" && known) {
    setCustom(false);
  }
  return (
    <Field label="Folder (optional)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={{ ...styles.input, maxWidth: 340 }}
          value={custom ? "__new__" : value}
          onChange={(e) => {
            if (e.target.value === "__new__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          <option value="">(No folder)</option>
          {groups.map((g) => (
            <option key={g} value={g} title={g}>
              {/* NBSP indentation — regular spaces collapse inside <option>,
                  which would flatten the hierarchy and make same-named leaf
                  folders (Sales\Internal vs Marketing\Internal) identical. */}
              {`${"  ".repeat(folderDepth(g))}${splitFolderPath(g).slice(-1)[0]}`}
            </option>
          ))}
          <option value="__new__">New folder…</option>
        </select>
        {custom && (
          <input
            style={{ ...styles.input, flex: 1, minWidth: 160 }}
            value={value}
            placeholder="e.g. Sales\KPIs"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </Field>
  );
}

export function MeasureEditorModal({
  connectionId,
  existing,
  overview,
  onClose,
  onSaved,
}: {
  connectionId: string;
  existing: ModelMeasureInfo | null;
  /** The current model — feeds the editor's function/table/column/measure
   *  autocomplete + hover + signature help. */
  overview: ModelOverview;
  onClose: () => void;
  onSaved: (measures: ModelMeasureInfo[]) => void;
}): React.ReactElement {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [formatString, setFormatString] = useState(existing?.formatString ?? "");
  const [formatStringExpression, setFormatStringExpression] = useState(
    existing?.formatStringExpression ?? "",
  );
  const [detailRows, setDetailRows] = useState(
    (existing?.detailRows ?? []).join(", "),
  );
  const [group, setGroup] = useState(normalizeFolderPath(existing?.group ?? ""));
  const [formula, setFormula] = useState(existing?.formula ?? "");

  // The secondary attributes live in a collapsible "More options" section under
  // the editor. Open it up-front when editing a measure that already sets any of
  // them, so those values are not hidden behind a click.
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      (existing?.group ?? "") ||
        (existing?.formatString ?? "") ||
        (existing?.formatStringExpression ?? "") ||
        (existing?.detailRows?.length ?? 0),
    ),
  );

  // Existing folders in this model (including intermediate/nested ones) — offered
  // in the folder dropdown so the user can file this measure into a folder that
  // already exists.
  const existingGroups = useMemo(
    () => folderPathsWithAncestors(overview.measures.map((m) => m.group)),
    [overview.measures],
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceRef = useRef<ExpressionWorkspaceHandle>(null);

  const handleValidate = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const result = await biModelValidateMeasure(
        connectionId,
        name,
        formula,
        existing?.name ?? null,
      );
      if (result.ok) {
        workspaceRef.current?.setMarker(null, null);
        setStatus("Formula is valid.");
      } else {
        workspaceRef.current?.setMarker(result.position, result.message);
        setError(result.message ?? "Invalid formula");
      }
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [connectionId, name, formula, existing]);

  const handleSave = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const measures = await biModelUpsertMeasure({
        connectionId,
        originalName: existing?.name ?? null,
        name,
        formula,
        description: description.trim() || null,
        formatString: formatString.trim() || null,
        formatStringExpression: formatStringExpression.trim() || null,
        detailRows: detailRows
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r.length > 0),
        group: group.trim() || null,
      });
      // The parent applies the fresh measure list and notifies the main
      // window (which recalcs CUBE) — the grid lives in the other window.
      onSaved(measures);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [
    connectionId,
    existing,
    name,
    formula,
    description,
    formatString,
    formatStringExpression,
    detailRows,
    group,
    onSaved,
  ]);

  return (
    <Modal
      title={existing ? `Edit Measure: ${existing.name}` : "New Measure"}
      width={1280}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btn} onClick={() => void handleValidate()}>
            Validate
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => void handleSave()}
            // An empty formula is allowed — it saves as a BLANK() placeholder.
            disabled={busy || !name.trim() || !connectionId}
          >
            {busy ? "Saving…" : "Save Measure"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        Model measures are part of the connection&apos;s model — they persist in this workbook and
        ship when the model is published as a package.
      </div>
      {existing && !existing.hasSource && (
        <div
          style={{
            fontSize: 12,
            padding: "6px 8px",
            marginBottom: 8,
            backgroundColor: "#fff3cd",
            borderRadius: 4,
          }}
        >
          This formula was reconstructed from the stored model (no original text). If you save
          without changing it, the stored definition is kept as-is; edit it only if you intend to
          redefine the measure.
        </div>
      )}

      {/* Identity row — Name and Description stay on top. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Revenue"
          />
        </Field>
        <Field label="Description (optional)" flex={2}>
          <input
            style={styles.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>

      {/* Workspace: editor front-and-centre, flanked by the two blades. */}
      <ExpressionWorkspace
        ref={workspaceRef}
        overview={overview}
        value={formula}
        onChange={setFormula}
        label="Formula"
        hint="Reference measures as [Name], columns as Table[column]. Drag from the tree to insert."
        hintTitle="Leave empty for a BLANK() placeholder. Reference other measures as [Name], columns as Table[column]; add notes with /* … */ or // comments. Use GVAR for a query-scoped value — e.g. GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)."
      />

      {/* Secondary attributes — hidden by default, expandable on click. */}
      <div style={{ border: "1px solid #e5e5e5", borderRadius: 4, marginBottom: 8 }}>
        <button
          onClick={() => setAdvancedOpen((o) => !o)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 10px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
            color: "#444",
            textAlign: "left",
          }}
        >
          <span style={{ color: "#888", width: 10 }}>{advancedOpen ? "▾" : "▸"}</span>
          More options
          {!advancedOpen && (
            <span style={{ ...styles.hint, fontWeight: 400 }}>
              Folder, Format, Dynamic format, Detail rows
            </span>
          )}
        </button>
        {advancedOpen && (
          <div style={{ padding: "4px 12px 8px", borderTop: "1px solid #f0f0f0" }}>
            <FolderField value={group} onChange={setGroup} groups={existingGroups} />
            <FormatField value={formatString} onChange={setFormatString} />
            <Field
              label="Dynamic format (optional)"
              hint='An expression evaluated once per query under the active filters, returning the format string — e.g. IF([SelectedCurrency] = "EUR", "#,##0.00 €", "$#,##0.00"). Overrides the static format when it yields a value.'
            >
              <input
                style={styles.input}
                value={formatStringExpression}
                onChange={(e) => setFormatStringExpression(e.target.value)}
                placeholder='IF(SUM(fact[amount]) > 1000000, "#,##0,,\"M\"", "#,##0")'
              />
            </Field>
            <Field
              label="Detail rows (optional)"
              hint="Drill-through projection: comma-separated Table[column] references returned when a user drills a cell of this measure. Fact-table columns become the detail columns; other tables' columns are looked up beside each row. Leave empty for the default projection."
            >
              <input
                style={styles.input}
                value={detailRows}
                onChange={(e) => setDetailRows(e.target.value)}
                placeholder="Sales[order_id], Sales[amount], Customer[name]"
              />
            </Field>
          </div>
        )}
      </div>

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: 8, fontSize: 12 }}>{status}</div>}
    </Modal>
  );
}
