//! FILENAME: app/extensions/FillSeries/components/SeriesDialog.tsx
// PURPOSE: Excel's Series dialog (Home > Fill > Series...): Series in Rows /
//          Columns; Type Linear / Growth / Date / AutoFill; Date unit Day /
//          Weekday / Month / Year; Trend; Step value; Stop value.
// CONTEXT: Opened by the fill.series command (index.ts) with Excel's default
//          direction for the selection's shape. OK runs lib/runSeries.ts and
//          stays open with the reason when the series cannot be written (a bad
//          number, a protected cell), as Excel's dialog does.
//          Enablement follows Excel: Date unit only for Date; Trend only for
//          Linear and Growth (and with Trend the Step value is not used);
//          AutoFill takes neither a step nor a stop.

import React, { useCallback, useState } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import { restoreFocusToGrid } from "@api";
import { runSeries } from "../lib/runSeries";
import {
  parseSeriesNumber,
  type DateUnit,
  type SeriesIn,
  type SeriesType,
} from "../lib/seriesPlan";

const styles = {
  backdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1050,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dialog: {
    background: "var(--panel-bg, #1e1e1e)",
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 420,
    display: "flex",
    flexDirection: "column" as const,
    color: "var(--text-primary, #cccccc)",
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px 8px",
    borderBottom: "1px solid var(--border-default, #3c3c3c)",
  },
  title: { fontSize: 14, fontWeight: 600 },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary, #999)",
    fontSize: 18,
    cursor: "pointer",
    padding: "2px 6px",
    lineHeight: 1,
  },
  body: { padding: "12px 16px", display: "flex", flexDirection: "column" as const, gap: 12 },
  columns: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 },
  fieldset: {
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 4,
    padding: "6px 10px 8px",
    margin: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  legend: { padding: "0 4px", fontSize: 12, color: "var(--text-secondary, #999)" },
  radioRow: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer" },
  inputs: { display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" as const },
  input: {
    width: 90,
    padding: "3px 6px",
    background: "var(--input-bg, #2a2a2a)",
    color: "var(--text-primary, #ccc)",
    border: "1px solid var(--border-default, #3c3c3c)",
    borderRadius: 3,
    fontSize: 13,
  },
  error: { color: "var(--text-error, #f48771)", fontSize: 12 },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "8px 16px 12px",
    borderTop: "1px solid var(--border-default, #3c3c3c)",
  },
  btn: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "1px solid var(--border-default, #3c3c3c)",
    background: "var(--button-bg, #333)",
    color: "var(--text-primary, #ccc)",
    cursor: "pointer",
    fontSize: 13,
  },
  btnPrimary: {
    padding: "5px 16px",
    borderRadius: 4,
    border: "none",
    background: "var(--accent-bg, #0078d4)",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  },
};

const TYPES: Array<{ value: SeriesType; label: string }> = [
  { value: "linear", label: "Linear" },
  { value: "growth", label: "Growth" },
  { value: "date", label: "Date" },
  { value: "autofill", label: "AutoFill" },
];
const UNITS: Array<{ value: DateUnit; label: string }> = [
  { value: "day", label: "Day" },
  { value: "weekday", label: "Weekday" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

function Radio(props: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  testId: string;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <label style={{ ...styles.radioRow, opacity: props.disabled ? 0.4 : 1 }}>
      <input
        type="radio"
        name={props.name}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onSelect}
        data-testid={props.testId}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function SeriesDialog({ isOpen, onClose, data }: DialogProps): React.ReactElement | null {
  const win = useDialogWindow({ minWidth: 380, minHeight: 260 });
  const [seriesIn, setSeriesIn] = useState<SeriesIn>(
    (data?.seriesIn as SeriesIn | undefined) === "rows" ? "rows" : "columns",
  );
  const [type, setType] = useState<SeriesType>("linear");
  const [unit, setUnit] = useState<DateUnit>("day");
  const [trend, setTrend] = useState(false);
  const [stepText, setStepText] = useState("1");
  const [stopText, setStopText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trendAllowed = type === "linear" || type === "growth";
  const stepUsed = type !== "autofill" && !(trend && trendAllowed);
  const stopUsed = type !== "autofill" && !(trend && trendAllowed);

  const handleOk = useCallback(async () => {
    const step = stepUsed ? parseSeriesNumber(stepText) : 1;
    if (stepUsed && step === null) {
      setError("Step value must be a number.");
      return;
    }
    const stop = stopUsed && stopText.trim() !== "" ? parseSeriesNumber(stopText) : null;
    if (stopUsed && stopText.trim() !== "" && stop === null) {
      setError("Stop value must be a number, or empty.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const problem = await runSeries({
        seriesIn,
        type,
        dateUnit: unit,
        step: step ?? 1,
        stop,
        trend: trend && trendAllowed,
      });
      if (problem) {
        setError(problem);
        return;
      }
      onClose();
      restoreFocusToGrid();
    } finally {
      setBusy(false);
    }
  }, [stepUsed, stopUsed, stepText, stopText, seriesIn, type, unit, trend, trendAllowed, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void handleOk();
      }
    },
    [handleOk],
  );

  if (!isOpen) return null;

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div
        ref={win.ref}
        role="dialog"
        aria-modal="true"
        aria-label="Series"
        data-testid="series-dialog"
        style={{ ...styles.dialog, position: "relative", ...win.style }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div style={styles.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={styles.title}>Series</span>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <div style={styles.body}>
          <div style={styles.columns}>
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Series in</legend>
              <Radio name="seriesIn" label="Rows" testId="series-in-rows" checked={seriesIn === "rows"} onSelect={() => setSeriesIn("rows")} />
              <Radio name="seriesIn" label="Columns" testId="series-in-columns" checked={seriesIn === "columns"} onSelect={() => setSeriesIn("columns")} />
            </fieldset>
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Type</legend>
              {TYPES.map((t) => (
                <Radio
                  key={t.value}
                  name="seriesType"
                  label={t.label}
                  testId={`series-type-${t.value}`}
                  checked={type === t.value}
                  onSelect={() => setType(t.value)}
                />
              ))}
            </fieldset>
            <fieldset style={styles.fieldset}>
              <legend style={styles.legend}>Date unit</legend>
              {UNITS.map((u) => (
                <Radio
                  key={u.value}
                  name="seriesUnit"
                  label={u.label}
                  testId={`series-unit-${u.value}`}
                  checked={unit === u.value}
                  disabled={type !== "date"}
                  onSelect={() => setUnit(u.value)}
                />
              ))}
            </fieldset>
          </div>
          <label style={{ ...styles.radioRow, opacity: trendAllowed ? 1 : 0.4 }}>
            <input
              type="checkbox"
              checked={trend && trendAllowed}
              disabled={!trendAllowed}
              onChange={(e) => setTrend(e.target.checked)}
              data-testid="series-trend"
            />
            <span>Trend</span>
          </label>
          <div style={styles.inputs}>
            <label style={{ ...styles.radioRow, opacity: stepUsed ? 1 : 0.4 }}>
              <span>Step value:</span>
              <input
                style={styles.input}
                value={stepText}
                disabled={!stepUsed}
                onChange={(e) => setStepText(e.target.value)}
                data-testid="series-step"
                autoFocus
              />
            </label>
            <label style={{ ...styles.radioRow, opacity: stopUsed ? 1 : 0.4 }}>
              <span>Stop value:</span>
              <input
                style={styles.input}
                value={stopText}
                disabled={!stopUsed}
                onChange={(e) => setStopText(e.target.value)}
                data-testid="series-stop"
              />
            </label>
          </div>
          {error && (
            <div style={styles.error} role="alert" data-testid="series-error">
              {error}
            </div>
          )}
        </div>
        <div style={styles.footer}>
          <button style={styles.btnPrimary} onClick={() => void handleOk()} disabled={busy} data-testid="series-ok">
            OK
          </button>
          <button style={styles.btn} onClick={onClose} data-testid="series-cancel">
            Cancel
          </button>
        </div>
        {win.resizeHandles}
      </div>
    </div>
  );
}
