//! FILENAME: app/extensions/FloatingRange/components/FloatingRangePropertiesBody.tsx
// PURPOSE: The object pane's Properties tab for a floating grid: its window
//          (rows, columns) and its header strips (column letters, row gutter).
// CONTEXT: Lifted from the old Properties dialog (WP-C D-PANE). The grid's NAME
//          and its TITLE BAR moved to the Format tab's Title card, where the
//          name is the title text (a rename) and the bar is the title's on/off
//          (lib/frObjectFormat.ts) -- one place per fact.
//
//          Every control writes AT ONCE, one `update_floating_range` per change
//          (lib/frPatch.ts: one undo step each): a number on Enter or blur, a
//          strip on click. Nothing is written when the value is the range's
//          own. The ROW and COLUMN counts are the grid's SIZE, so they freeze
//          with its geometry (`frGeometryEditable`: a range its canvas locks);
//          the strips are chrome -- formatting, which a locked page lets
//          through, exactly as the backend does. On a subscribed page (the
//          pane's read-only) nothing is editable.

import React, { useEffect, useReducer, useState } from "react";
import { onRegionChange } from "@api/gridOverlays";
import { FLOATING_RANGE_MAX_COLS, FLOATING_RANGE_MAX_ROWS, type FloatingRangePatch } from "@api/floatingRanges";
import { frGeometryEditable, frObjectEditable, getFloatingRangeById } from "../lib/floatingRangeStore";
import { applyFrPatch } from "../lib/frPatch";

export interface FloatingRangePropertiesBodyProps {
  frId: string;
  /** The page is subscribed: nothing here may change. */
  readOnly: boolean;
  readOnlyReason: string | null;
  /** The write (default: lib/frPatch `applyFrPatch`); a test hands a double. */
  apply?: (frId: string, patch: FloatingRangePatch) => Promise<void>;
}

/** What the tab says when the canvas locks the range (its size is frozen, its strips are not). */
export const FR_PROPERTIES_LOCKED =
  "This range is locked on its canvas, so its rows and columns cannot change. Unlock it (Canvas tab) to change them.";
/** Where the name and the title bar went. */
export const FR_PROPERTIES_NAME_HINT = "The name and the title bar are on the Format tab, under Title.";

const styles: Record<string, React.CSSProperties> = {
  body: { display: "flex", flexDirection: "column", gap: 10, padding: "8px 10px", fontSize: 12 },
  row: { display: "flex", gap: 10 },
  field: { display: "flex", flexDirection: "column", gap: 4, width: 96 },
  label: { color: "var(--text-secondary, #555)" },
  input: {
    width: "100%",
    padding: "3px 6px",
    border: "1px solid var(--border-default, #bbb)",
    borderRadius: 3,
    fontSize: 12,
    boxSizing: "border-box",
  },
  fieldset: { border: "1px solid var(--border-subtle, #e0e0e0)", borderRadius: 4, padding: "6px 8px 8px", margin: 0 },
  legend: { color: "var(--text-secondary, #555)", padding: "0 4px", fontSize: 11 },
  check: { display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" },
  muted: { color: "var(--text-tertiary, #777)", fontSize: 11 },
  error: { color: "#b42318", fontSize: 11 },
};

function clampCount(v: number, max: number): number | null {
  if (!Number.isFinite(v)) return null;
  return Math.max(1, Math.min(max, Math.trunc(v)));
}

/** A count box: a draft while typing, committed on Enter or blur. */
function CountField(props: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  testId: string;
  dataAttr: string;
  onCommit(value: number): void;
}): React.ReactElement {
  const { label, value, max, disabled, testId, dataAttr, onCommit } = props;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const next = clampCount(Number(draft), max);
    if (next === null) {
      setDraft(String(value));
      return;
    }
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <label style={styles.field}>
      <span style={styles.label}>{label}</span>
      <input
        type="number"
        min={1}
        max={max}
        style={styles.input}
        data-testid={testId}
        {...{ [dataAttr]: "" }}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(String(value));
          }
        }}
      />
    </label>
  );
}

export function FloatingRangePropertiesBody({
  frId,
  readOnly,
  readOnlyReason,
  apply = applyFrPatch,
}: FloatingRangePropertiesBodyProps): React.ReactElement {
  // The row is replaced on every write (and on undo / a reload), which
  // re-publishes the regions: re-read on every region change.
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onRegionChange(() => refresh()), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The strips' IN-FLIGHT value. The checkboxes are controlled by the stored
  // row, which only changes when `update_floating_range` has answered; without
  // this the re-render that `setBusy(true)` causes put the tick straight back
  // (the row still said `true`), so a click visibly bounced and an automated
  // uncheck read "did not change its state" (live, 2026-10-16).
  const [pending, setPending] = useState<FloatingRangePatch>({});

  const entry = getFloatingRangeById(frId);
  if (!entry) {
    return (
      <div style={styles.body} data-testid="fr-properties-tab">
        <div style={styles.muted}>This floating range no longer exists.</div>
      </div>
    );
  }

  const geometry = frGeometryEditable(frId);
  const sizeDisabled = readOnly || busy || !geometry;
  const chromeDisabled = readOnly || busy;

  const write = (patch: FloatingRangePatch): void => {
    setError(null);
    setBusy(true);
    setPending((p) => ({ ...p, ...patch }));
    void apply(frId, patch)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        // The store row is current by now (applyFrPatch upserts before it
        // resolves), and on a refusal the row's own value is the truth.
        setPending({});
        setBusy(false);
      });
  };

  return (
    <div style={styles.body} data-testid="fr-properties-tab" data-fr-properties-tab="">
      <div style={styles.row}>
        <CountField
          label="Rows"
          value={entry.rows}
          max={FLOATING_RANGE_MAX_ROWS}
          disabled={sizeDisabled}
          testId="fr-properties-rows"
          dataAttr="data-fr-rows-input"
          onCommit={(rowCount) => write({ rowCount })}
        />
        <CountField
          label="Columns"
          value={entry.cols}
          max={FLOATING_RANGE_MAX_COLS}
          disabled={sizeDisabled}
          testId="fr-properties-cols"
          dataAttr="data-fr-cols-input"
          onCommit={(colCount) => write({ colCount })}
        />
      </div>

      <fieldset style={styles.fieldset} disabled={chromeDisabled}>
        <legend style={styles.legend}>Show</legend>
        <label style={styles.check}>
          <input
            type="checkbox"
            data-testid="fr-properties-column-headers"
            data-fr-show-column-headers=""
            checked={pending.showColumnHeaders ?? entry.showColumnHeaders}
            onChange={(e) => write({ showColumnHeaders: e.target.checked })}
          />
          Column headers (A, B, C…)
        </label>
        <label style={styles.check}>
          <input
            type="checkbox"
            data-testid="fr-properties-row-headers"
            data-fr-show-row-headers=""
            checked={pending.showRowHeaders ?? entry.showRowHeaders}
            onChange={(e) => write({ showRowHeaders: e.target.checked })}
          />
          Row gutter (1, 2, 3…)
        </label>
      </fieldset>

      {readOnly ? (
        <div style={styles.muted} data-testid="fr-properties-readonly">
          {readOnlyReason ?? "This page is read-only."}
        </div>
      ) : !geometry ? (
        <div style={styles.muted} data-testid="fr-properties-locked" data-fr-geometry-locked="">
          {frObjectEditable(frId) ? FR_PROPERTIES_LOCKED : (readOnlyReason ?? FR_PROPERTIES_LOCKED)}
        </div>
      ) : null}

      <div style={styles.muted}>
        Hiding a strip makes the range smaller — the cells stay put and the frame shrinks around them.
        Shrinking hides rows and columns without deleting their cells; growing restores them.
      </div>
      <div style={styles.muted} data-testid="fr-properties-name-hint">
        {FR_PROPERTIES_NAME_HINT}
      </div>

      {error ? (
        <div style={styles.error} role="alert" data-testid="fr-properties-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
