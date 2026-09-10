// FILENAME: app/extensions/ModelEditor/components/sections/ColumnSelectionBar.tsx
// PURPOSE: Edit a property across N selected columns in one batched write, and
//          show the command that will do it.
// CONTEXT: "Hide 40 of 200 columns before shipping a model" was forty modals —
//          the single most-cited chore in this window, and inexpressible in the
//          CLI too because its globs match names only.
//
//          It prints its own command for three reasons, all load-bearing:
//          the user sees the blast radius before pressing Apply; the run is
//          demonstrably ONE batch rather than N writes; and a person who has
//          never opened the command line learns the grammar from the GUI they
//          already use.

import React, { useState } from "react";
import { styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { FONT, ME, RADIUS, SPACE } from "../theme";
import { buildSetColumnsCommand, shared, unquotableNames } from "../../lib/bulkEdit";
import type { ColumnTarget } from "../../lib/bulkEdit";

export interface SelectableColumn {
  name: string;
  isHidden: boolean;
  formatString: string | null;
  isCalculated: boolean;
}

/** The value shown for a property across the selection. */
function sharedLabel<T>(s: ReturnType<typeof shared<SelectableColumn, T>>, render: (v: T) => string): string {
  if (s.kind === "mixed") return "(mixed)";
  if (s.kind === "none") return "";
  return render(s.value);
}

export function ColumnSelectionBar({
  ctx,
  table,
  selected,
  columns,
  onDone,
}: {
  ctx: SectionCtx;
  table: string;
  selected: string[];
  columns: SelectableColumn[];
  onDone: () => void;
}): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const picked = columns.filter((c) => selected.includes(c.name));
  if (picked.length < 2) return null;

  const sharedHidden = shared(picked, (c) => c.isHidden);
  const sharedFormat = shared(picked, (c) => c.formatString ?? "");

  // A name the grammar cannot express would be silently mistargeted, so it is
  // reported and the run is refused rather than partly applied to the wrong
  // objects.
  const unquotable = unquotableNames(picked.map((c) => c.name));

  const targets: ColumnTarget[] = picked.map((c) => ({ table, column: c.name }));

  const pendingPatch: Record<string, string | boolean> = {};
  if (format !== null) pendingPatch.format = format;
  const preview = buildSetColumnsCommand(targets, pendingPatch);

  const apply = async (patch: Record<string, string | boolean>): Promise<void> => {
    const text = buildSetColumnsCommand(targets, patch);
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await ctx.runCommand(text);
      setFormat(null);
      onDone();
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || ctx.readOnly || unquotable.length > 0;

  return (
    <div
      data-testid="column-selection-bar"
      style={{
        ...styles.card,
        marginTop: SPACE.sm,
        border: `1px solid ${ME.accent}`,
        background: ME.accentSoft,
        display: "flex",
        flexDirection: "column",
        gap: SPACE.sm,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap" }}>
        <strong style={{ fontSize: FONT.base }}>{picked.length} columns selected</strong>

        <label style={{ display: "flex", alignItems: "center", gap: SPACE.xs, fontSize: FONT.sm }}>
          <input
            type="checkbox"
            data-testid="bulk-hidden"
            disabled={disabled}
            // A mixed selection shows the indeterminate state rather than
            // guessing one, so clicking it is an unambiguous "make them all X".
            ref={(el) => {
              if (el) el.indeterminate = sharedHidden.kind === "mixed";
            }}
            checked={sharedHidden.kind === "same" ? sharedHidden.value : false}
            onChange={(e) => void apply({ hidden: e.target.checked })}
          />
          Hidden
          {sharedHidden.kind === "mixed" && (
            <span style={{ color: ME.text3 }}>(mixed)</span>
          )}
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: SPACE.xs, fontSize: FONT.sm }}>
          Format
          <input
            style={{ ...styles.input, width: 140, fontSize: FONT.sm }}
            data-testid="bulk-format"
            disabled={disabled}
            placeholder={sharedLabel(sharedFormat, (v) => v || "(none)")}
            value={format ?? ""}
            onChange={(e) => setFormat(e.target.value)}
          />
        </label>

        <div style={{ flex: 1 }} />
        <button
          style={styles.primaryBtn}
          data-testid="bulk-apply"
          disabled={disabled || preview === null}
          onClick={() => void apply(pendingPatch)}
        >
          {busy ? "Applying…" : `Apply to ${picked.length}`}
        </button>
        <button style={styles.btn} disabled={busy} onClick={onDone}>
          Clear
        </button>
      </div>

      {preview && (
        <div
          data-testid="bulk-command-preview"
          style={{
            fontFamily: ME.mono,
            fontSize: FONT.sm,
            background: ME.surface,
            borderRadius: RADIUS.control,
            padding: `${SPACE.sm}px ${SPACE.md}px`,
            color: ME.text2,
            overflowX: "auto",
            whiteSpace: "nowrap",
          }}
        >
          ❯ {preview}
        </div>
      )}

      <div style={styles.hint}>
        One command, one undo step — all of it applies or none of it does.
      </div>

      {unquotable.length > 0 && (
        <div style={{ color: ME.dangerFg, fontSize: FONT.sm }}>
          {unquotable.length} selected column name(s) contain both a quote and a bracket, which
          this grammar cannot express — deselect them and edit those individually.
        </div>
      )}
      {error && <div style={{ color: ME.dangerFg, fontSize: FONT.sm }}>{error}</div>}
    </div>
  );
}
