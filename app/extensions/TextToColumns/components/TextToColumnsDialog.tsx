//! FILENAME: app/extensions/TextToColumns/components/TextToColumnsDialog.tsx
// PURPOSE: 3-step wizard dialog for the Text to Columns feature.
// CONTEXT: Registered as a dialog via DialogExtensions. Opened from the Data menu.

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  detectDataRegion,
  getViewportCells,
  indexToCol,
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api";
import type { CellUpdateInput } from "@api";
import {
  DialogBody,
  DialogPane,
  DialogSidePane,
  DialogFieldGrid,
  dialogWidth,
  dialogHeight,
} from "@api/dialogLayout";
import { useDialogWindow } from "@api/dialogWindow";
import {
  parseAll,
  getMaxColumns,
  applyFormats,
  createDefaultConfig,
} from "../lib/parser";
import type {
  TextToColumnsConfig,
  DelimitedConfig,
  ColumnFormat,
} from "../lib/parser";

// ============================================================================
// Styles
// ============================================================================

const v = (name: string) => `var(${name})`;

const S = {
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
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    // 560px starved the one dimension this wizard needs: the fixed-width ruler
    // showed 62 characters of an 80-132 character record, and the split preview
    // 9 characters per field at six columns — while ~350px of height went
    // unused. A DECLARED height (not just a max) is what lets the previews take
    // `flex: 1`; against `maxHeight` alone they would size to content and the
    // window would jump between steps.
    width: dialogWidth(900),
    height: dialogHeight(600),
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: `1px solid ${v("--border-default")}`,
    flexShrink: 0,
  },
  title: { fontWeight: 600, fontSize: 15 },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: v("--text-secondary"),
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 14,
    lineHeight: 1,
  },
  body: {
    // Just the region between the header and the footer now. The padding and
    // the 12px gap moved INTO each step's pane, because step 2 delimited splits
    // this region into two panes and only the left one may scroll.
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden" as const,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
    flexShrink: 0,
  },
  btn: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    border: `1px solid ${v("--border-default")}`,
  },
  btnPrimary: {
    padding: "6px 20px",
    fontSize: 13,
    borderRadius: 4,
    cursor: "pointer",
    minWidth: 80,
    background: v("--accent-primary"),
    color: "#ffffff",
    border: `1px solid ${v("--accent-primary")}`,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: v("--text-secondary"),
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  radioRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
    padding: "2px 0",
  },
  radio: { cursor: "pointer", accentColor: v("--accent-primary") },
  checkbox: {
    width: 16,
    height: 16,
    cursor: "pointer",
    accentColor: v("--accent-primary"),
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
  },
  inlineRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap" as const,
  },
  input: {
    width: 30,
    padding: "2px 4px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    textAlign: "center" as const,
  },
  select: {
    padding: "2px 6px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
  },
  // Preview table
  preview: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    overflow: "auto" as const,
    // Was maxHeight 200 — at ~22px a row that showed 9 of the 20 rows the
    // parser had already computed. Fill the pane instead and let it scroll.
    flex: 1,
    minHeight: 0,
  },
  previewTable: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 12,
    fontFamily: "Consolas, monospace",
  },
  previewTh: {
    padding: "4px 8px",
    borderBottom: `1px solid ${v("--border-default")}`,
    borderRight: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    fontWeight: 600,
    textAlign: "left" as const,
    position: "sticky" as const,
    top: 0,
    cursor: "pointer",
    fontSize: 11,
    userSelect: "none" as const,
  },
  previewTd: {
    padding: "3px 8px",
    borderBottom: `1px solid ${v("--border-default")}`,
    borderRight: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap" as const,
    maxWidth: 150,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Raw (unsplit) source lines — step 1's whole job is reading them, and they
  // are the longest strings in the flow, so they get previewTd WITHOUT its
  // 150px cap and ellipsis. Widening the dialog cannot lift a hard cap.
  rawPreviewTd: {
    padding: "3px 8px",
    borderBottom: `1px solid ${v("--border-default")}`,
    whiteSpace: "nowrap" as const,
  },
  // Fixed width ruler
  rulerContainer: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    overflow: "auto" as const,
    // Was maxHeight 200; fills its pane now, same reason as S.preview.
    flex: 1,
    minHeight: 0,
    fontFamily: "Consolas, monospace",
    fontSize: 12,
    position: "relative" as const,
    cursor: "crosshair",
  },
  rulerRow: {
    background: v("--grid-bg"),
    borderBottom: `1px solid ${v("--border-default")}`,
    position: "relative" as const,
    height: 20,
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
  },
  rulerNumber: {
    display: "inline-block",
    width: "8.4px",
    textAlign: "center" as const,
    fontSize: 9,
    color: v("--text-secondary"),
  },
  dataRow: {
    position: "relative" as const,
    height: 18,
    whiteSpace: "nowrap" as const,
    lineHeight: "18px",
  },
  breakLine: {
    position: "absolute" as const,
    top: 0,
    bottom: 0,
    width: 1,
    background: v("--accent-primary"),
    cursor: "col-resize",
    zIndex: 2,
  },
  breakArrow: {
    position: "absolute" as const,
    top: -2,
    left: -4,
    width: 0,
    height: 0,
    borderLeft: "4px solid transparent",
    borderRight: "4px solid transparent",
    borderTop: `5px solid ${v("--accent-primary")}`,
  },
  // Destination row
  destRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
  },
  destInput: {
    padding: "3px 6px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
    width: 120,
  },
  // Confirm dialog
  confirmBackdrop: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 1060,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmDialog: {
    background: v("--panel-bg"),
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 8,
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
    width: 380,
    display: "flex",
    flexDirection: "column" as const,
    color: v("--text-primary"),
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontSize: 13,
    padding: "20px",
    gap: 16,
  },
  // Format selector
  formatRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    padding: "4px 0",
  },
};

// ============================================================================
// Constants
// ============================================================================

const MAX_PREVIEW_ROWS = 20;
const CHAR_WIDTH = 8.4; // monospace char width in pixels

const FORMAT_OPTIONS: { value: ColumnFormat; label: string }[] = [
  { value: "general", label: "General" },
  { value: "text", label: "Text" },
  { value: "date:MDY", label: "Date (MDY)" },
  { value: "date:DMY", label: "Date (DMY)" },
  { value: "date:YMD", label: "Date (YMD)" },
  { value: "skip", label: "Do not import (skip)" },
];

// ============================================================================
// Types
// ============================================================================

interface SourceData {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  /** Raw display values for each row in the source column. */
  values: string[];
}

// ============================================================================
// Component
// ============================================================================

export function TextToColumnsDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  // A wizard that now declares a size should also be movable and resizable.
  // minWidth is set high enough that a drag cannot crush the two panes of
  // step 2 delimited into unreadable slivers.
  const win = useDialogWindow({ minWidth: 640, minHeight: 420 });

  // Wizard state
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loaded, setLoaded] = useState(false);
  const [source, setSource] = useState<SourceData | null>(null);
  const [config, setConfig] = useState<TextToColumnsConfig>(createDefaultConfig);
  const [selectedPreviewCol, setSelectedPreviewCol] = useState(0);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // Load source data on mount
  // --------------------------------------------------------------------------
  useEffect(() => {
    async function load() {
      const sel = data as Record<string, unknown> | undefined;
      const startRow = (sel?.startRow as number) ?? 0;
      const startCol = (sel?.startCol as number) ?? 0;
      const endRow = (sel?.endRow as number) ?? startRow;
      const endCol = (sel?.endCol as number) ?? startCol;

      // Validate single-column selection
      if (startCol !== endCol) {
        setError("Text to Columns requires a single-column selection.");
        setLoaded(true);
        return;
      }

      // If single cell, auto-detect data region
      let sRow = startRow;
      let eRow = endRow;
      const col = startCol;

      if (sRow === eRow) {
        const detected = await detectDataRegion(sRow, col);
        if (detected) {
          sRow = detected[0];
          eRow = detected[2];
        }
      }

      // Fetch cell values for the source column
      const cells = await getViewportCells(sRow, col, eRow, col);
      const values: string[] = [];
      for (let r = sRow; r <= eRow; r++) {
        const cell = cells.find((c) => c.row === r && c.col === col);
        values.push(cell?.display ?? "");
      }

      // Filter out trailing empty rows
      while (values.length > 0 && values[values.length - 1] === "") {
        values.pop();
      }

      if (values.length === 0) {
        setError("No data found in the selected column.");
        setLoaded(true);
        return;
      }

      setSource({
        startRow: sRow,
        startCol: col,
        endRow: sRow + values.length - 1,
        endCol: col,
        values,
      });
      setLoaded(true);
    }
    load();
  }, []);

  // --------------------------------------------------------------------------
  // Parsed preview (recomputed whenever config or source changes)
  // --------------------------------------------------------------------------
  const previewRows = useMemo(() => {
    if (!source) return [];
    const subset = source.values.slice(0, MAX_PREVIEW_ROWS);
    return parseAll(subset, config);
  }, [source, config]);

  const maxCols = useMemo(() => getMaxColumns(previewRows), [previewRows]);

  // --------------------------------------------------------------------------
  // Keyboard handling
  // --------------------------------------------------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (confirmOverwrite) return;
      if (error) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.stopPropagation();
          onClose();
        }
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [error, confirmOverwrite, onClose]);

  // --------------------------------------------------------------------------
  // Click outside to close
  // --------------------------------------------------------------------------
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      // The wizard box carries the window hook's ref; the error box still
      // carries dialogRef. Consult whichever is mounted, or a click anywhere
      // on the backdrop would stop closing one of the two.
      const box = win.ref.current ?? dialogRef.current;
      if (box && !box.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose, win.ref],
  );

  // --------------------------------------------------------------------------
  // Config setters
  // --------------------------------------------------------------------------
  const setMode = useCallback((mode: "delimited" | "fixedWidth") => {
    setConfig((prev) => ({ ...prev, mode }));
  }, []);

  const setDelimProp = useCallback(
    <K extends keyof DelimitedConfig>(key: K, value: DelimitedConfig[K]) => {
      setConfig((prev) => ({
        ...prev,
        delimited: { ...prev.delimited, [key]: value },
      }));
    },
    [],
  );

  const setColumnFormat = useCallback((colIdx: number, fmt: ColumnFormat) => {
    setConfig((prev) => {
      const formats = [...prev.columnFormats];
      while (formats.length <= colIdx) formats.push("general");
      formats[colIdx] = fmt;
      return { ...prev, columnFormats: formats };
    });
  }, []);

  // --------------------------------------------------------------------------
  // Fixed width break management
  // --------------------------------------------------------------------------
  const addBreak = useCallback((pos: number) => {
    setConfig((prev) => {
      const breaks = [...prev.fixedWidthBreaks];
      if (!breaks.includes(pos) && pos > 0) {
        breaks.push(pos);
        breaks.sort((a, b) => a - b);
      }
      return { ...prev, fixedWidthBreaks: breaks };
    });
  }, []);

  const removeBreak = useCallback((pos: number) => {
    setConfig((prev) => ({
      ...prev,
      fixedWidthBreaks: prev.fixedWidthBreaks.filter((b) => b !== pos),
    }));
  }, []);

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------
  const handleFinish = useCallback(async () => {
    if (!source) return;

    // Parse all source values
    const allParsed = parseAll(source.values, config);
    const totalCols = getMaxColumns(allParsed);

    // Apply formats and compute final column count
    const finalRows = allParsed.map((row) => {
      // Pad row to maxCols for consistent format application
      while (row.length < totalCols) row.push("");
      return applyFormats(row, config.columnFormats);
    });

    const resultColCount = finalRows.length > 0 ? Math.max(...finalRows.map((r) => r.length)) : 0;
    if (resultColCount === 0) {
      onClose();
      return;
    }

    // Check for data collision in destination columns beyond the source
    if (resultColCount > 1) {
      const checkStartCol = source.startCol + 1;
      const checkEndCol = source.startCol + resultColCount - 1;
      const existingCells = await getViewportCells(
        source.startRow,
        checkStartCol,
        source.endRow,
        checkEndCol,
      );
      const hasData = existingCells.some(
        (c) => c.display !== "" && c.col >= checkStartCol && c.col <= checkEndCol,
      );
      if (hasData && !confirmOverwrite) {
        setConfirmOverwrite(true);
        return;
      }
    }

    // Execute the write
    try {
      await beginUndoTransaction("Text to Columns");

      const updates: CellUpdateInput[] = [];

      for (let rowIdx = 0; rowIdx < finalRows.length; rowIdx++) {
        const row = finalRows[rowIdx];
        const absRow = source.startRow + rowIdx;

        for (let colIdx = 0; colIdx < resultColCount; colIdx++) {
          const absCol = source.startCol + colIdx;
          const value = row[colIdx] ?? "";

          // For "text" format columns, prefix with ' to force text interpretation
          const fmt = config.columnFormats[colIdx] ?? "general";
          let cellValue = value;
          if (fmt === "text" && value !== "") {
            cellValue = "'" + value;
          }

          updates.push({ row: absRow, col: absCol, value: cellValue });
        }
      }

      await updateCellsBatch(updates);
      await commitUndoTransaction();

      // Refresh grid - dispatch grid:refresh to refetch cell data and redraw canvas
      window.dispatchEvent(new CustomEvent("grid:refresh"));

      onClose();
    } catch (err) {
      console.error("[TextToColumns] Execution error:", err);
      // Close the transaction — left open, later edits silently join it —
      // and show the BACKEND's reason, which names the refusing cell; a
      // generic message hid exactly the part the user can act on.
      try { await cancelUndoTransaction(); } catch { /* already closed */ }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [source, config, confirmOverwrite, onClose]);

  // --------------------------------------------------------------------------
  // Render: Loading
  // --------------------------------------------------------------------------
  if (!loaded) return null;

  // --------------------------------------------------------------------------
  // Render: Error state
  // --------------------------------------------------------------------------
  if (error) {
    return (
      <div style={S.backdrop} onMouseDown={handleBackdropClick}>
        <div ref={dialogRef} style={S.confirmDialog}>
          <div>{error}</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={S.btnPrimary} onClick={onClose}>OK</button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Overwrite confirmation
  // --------------------------------------------------------------------------
  if (confirmOverwrite) {
    return (
      <div style={S.confirmBackdrop}>
        <div style={S.confirmDialog}>
          <div>There's already data here. Do you want to replace it?</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              style={S.btn}
              onClick={() => {
                setConfirmOverwrite(false);
              }}
            >
              Cancel
            </button>
            <button
              style={S.btnPrimary}
              onClick={() => {
                setConfirmOverwrite(false);
                // Re-trigger finish after confirmation; use a microtask
                // so that confirmOverwrite is cleared first
                setTimeout(() => handleFinish(), 0);
              }}
            >
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Render: Main wizard
  // --------------------------------------------------------------------------
  return (
    <div style={S.backdrop} onMouseDown={handleBackdropClick}>
      {/* position:relative anchors the hook's eight resize handles to THIS box —
          without it they are absolute against the fixed backdrop and land at the
          viewport edges, silently. */}
      <div ref={win.ref} style={{ ...S.dialog, position: "relative", ...win.style }}>
        {/* Header — also the drag handle */}
        <div style={S.header} onMouseDown={win.onHeaderMouseDown}>
          <span style={S.title}>
            Convert Text to Columns Wizard - Step {step} of 3
          </span>
          <button style={S.closeBtn} onClick={onClose}>X</button>
        </div>

        {/* Body */}
        <div style={S.body}>
          {step === 1 && (
            <Step1
              mode={config.mode}
              onSetMode={setMode}
              values={source?.values ?? []}
            />
          )}
          {step === 2 && config.mode === "delimited" && (
            <Step2Delimited
              config={config.delimited}
              onSetProp={setDelimProp}
              previewRows={previewRows}
              maxCols={maxCols}
            />
          )}
          {step === 2 && config.mode === "fixedWidth" && (
            <Step2FixedWidth
              values={source?.values ?? []}
              breaks={config.fixedWidthBreaks}
              onAddBreak={addBreak}
              onRemoveBreak={removeBreak}
            />
          )}
          {step === 3 && (
            <Step3Format
              previewRows={previewRows}
              maxCols={maxCols}
              formats={config.columnFormats}
              selectedCol={selectedPreviewCol}
              onSelectCol={setSelectedPreviewCol}
              onSetFormat={setColumnFormat}
              sourceCol={source?.startCol ?? 0}
              sourceRow={source?.startRow ?? 0}
            />
          )}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          <button style={S.btn} onClick={onClose}>Cancel</button>
          {step > 1 && (
            <button
              style={S.btn}
              onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
            >
              &lt; Back
            </button>
          )}
          {step < 3 ? (
            <button
              style={S.btnPrimary}
              onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
            >
              Next &gt;
            </button>
          ) : (
            <button style={S.btnPrimary} onClick={handleFinish}>
              Finish
            </button>
          )}
        </div>

        {win.resizeHandles}
      </div>
    </div>
  );
}

// ============================================================================
// Step 1: Choose Data Type
// ============================================================================

function Step1(props: {
  mode: "delimited" | "fixedWidth";
  onSetMode: (mode: "delimited" | "fixedWidth") => void;
  values: string[];
}) {
  const { mode, onSetMode, values } = props;

  // Full width, not a split: the two radios are one row of the grid and the
  // raw preview — the thing you are actually reading here — takes the rest.
  return (
    <DialogPane scroll={false} style={{ gap: 12 }}>
      <div style={S.sectionLabel}>Choose the file type that best describes your data</div>
      <DialogFieldGrid maxColumns={2} rowGap={8}>
        <label style={S.radioRow}>
          <input
            type="radio"
            name="ttc-mode"
            style={S.radio}
            checked={mode === "delimited"}
            onChange={() => onSetMode("delimited")}
          />
          <div>
            <div style={{ fontWeight: 500 }}>Delimited</div>
            <div style={{ fontSize: 11, color: v("--text-secondary") }}>
              Characters such as commas or tabs separate each field.
            </div>
          </div>
        </label>
        <label style={S.radioRow}>
          <input
            type="radio"
            name="ttc-mode"
            style={S.radio}
            checked={mode === "fixedWidth"}
            onChange={() => onSetMode("fixedWidth")}
          />
          <div>
            <div style={{ fontWeight: 500 }}>Fixed width</div>
            <div style={{ fontSize: 11, color: v("--text-secondary") }}>
              Fields are aligned in columns with spaces between each field.
            </div>
          </div>
        </label>
      </DialogFieldGrid>

      <div style={S.sectionLabel}>Preview of selected data</div>
      <RawPreview values={values} />
    </DialogPane>
  );
}

// ============================================================================
// Step 2: Delimited Configuration
// ============================================================================

function Step2Delimited(props: {
  config: DelimitedConfig;
  onSetProp: <K extends keyof DelimitedConfig>(key: K, val: DelimitedConfig[K]) => void;
  previewRows: string[][];
  maxCols: number;
}) {
  const { config, onSetProp, previewRows, maxCols } = props;

  // The one step where a split pays: you toggle a delimiter and watch the split
  // change, so the preview must stay in view — and stacking the five delimiters
  // fills the narrow column better than the wrap-prone row did.
  return (
    <DialogBody>
      <DialogPane width={300} style={{ gap: 12 }}>
        <div style={S.sectionLabel}>Delimiters</div>
        <div style={{ ...S.inlineRow, flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
          <label style={S.checkboxRow}>
            <input
              type="checkbox"
              style={S.checkbox}
              checked={config.tab}
              onChange={(e) => onSetProp("tab", e.target.checked)}
            />
            Tab
          </label>
          <label style={S.checkboxRow}>
            <input
              type="checkbox"
              style={S.checkbox}
              checked={config.semicolon}
              onChange={(e) => onSetProp("semicolon", e.target.checked)}
            />
            Semicolon
          </label>
          <label style={S.checkboxRow}>
            <input
              type="checkbox"
              style={S.checkbox}
              checked={config.comma}
              onChange={(e) => onSetProp("comma", e.target.checked)}
            />
            Comma
          </label>
          <label style={S.checkboxRow}>
            <input
              type="checkbox"
              style={S.checkbox}
              checked={config.space}
              onChange={(e) => onSetProp("space", e.target.checked)}
            />
            Space
          </label>
          <label style={S.checkboxRow}>
            <input
              type="checkbox"
              style={S.checkbox}
              checked={config.other.length > 0}
              onChange={(e) => {
                if (!e.target.checked) onSetProp("other", "");
              }}
            />
            Other:
            <input
              type="text"
              style={S.input}
              maxLength={1}
              value={config.other}
              onChange={(e) => onSetProp("other", e.target.value)}
            />
          </label>
        </div>

        <label style={S.checkboxRow}>
          <input
            type="checkbox"
            style={S.checkbox}
            checked={config.treatConsecutiveAsOne}
            onChange={(e) => onSetProp("treatConsecutiveAsOne", e.target.checked)}
          />
          Treat consecutive delimiters as one
        </label>

        <div style={{ ...S.inlineRow, gap: 8 }}>
          <span>Text qualifier:</span>
          <select
            style={S.select}
            value={config.textQualifier}
            onChange={(e) => onSetProp("textQualifier", e.target.value)}
          >
            <option value={'"'}>&quot; (double quote)</option>
            <option value={"'"}>&apos; (single quote)</option>
            <option value="">(none)</option>
          </select>
        </div>
      </DialogPane>

      <DialogSidePane flexible>
        <div style={S.sectionLabel}>Data preview</div>
        <SplitPreview rows={previewRows} maxCols={maxCols} />
      </DialogSidePane>
    </DialogBody>
  );
}

// ============================================================================
// Step 2: Fixed Width Configuration
// ============================================================================

function Step2FixedWidth(props: {
  values: string[];
  breaks: number[];
  onAddBreak: (pos: number) => void;
  onRemoveBreak: (pos: number) => void;
}) {
  const { values, breaks, onAddBreak, onRemoveBreak } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  // Find the maximum line length for the ruler
  const maxLen = useMemo(() => {
    let max = 0;
    const subset = values.slice(0, MAX_PREVIEW_ROWS);
    for (const v of subset) {
      if (v.length > max) max = v.length;
    }
    return Math.max(max, 20);
  }, [values]);

  // Handle click on ruler or data area to add/remove breaks
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + (containerRef.current?.scrollLeft ?? 0);
      const charPos = Math.round(x / CHAR_WIDTH);

      if (charPos <= 0 || charPos >= maxLen) return;

      // Check if clicking near an existing break
      const nearBreak = breaks.find((b) => Math.abs(b - charPos) <= 0);
      if (nearBreak !== undefined) {
        onRemoveBreak(nearBreak);
      } else {
        onAddBreak(charPos);
      }
    },
    [breaks, maxLen, onAddBreak, onRemoveBreak],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left + (containerRef.current?.scrollLeft ?? 0);
      const charPos = Math.round(x / CHAR_WIDTH);

      // Remove break closest to click position
      const nearBreak = breaks.find((b) => Math.abs(b - charPos) <= 1);
      if (nearBreak !== undefined) {
        onRemoveBreak(nearBreak);
      }
    },
    [breaks, onRemoveBreak],
  );

  // Build ruler numbers
  const rulerChars = useMemo(() => {
    const chars: string[] = [];
    for (let i = 0; i <= maxLen; i++) {
      if (i % 10 === 0) {
        const num = String(i);
        for (let j = 0; j < num.length; j++) {
          chars.push(num[j]);
        }
        i += num.length - 1;
      } else {
        chars.push(i % 5 === 0 ? "+" : ".");
      }
    }
    return chars;
  }, [maxLen]);

  const previewLines = values.slice(0, MAX_PREVIEW_ROWS);

  // Full width, single pane: you place breaks by clicking the record itself, so
  // every pixel of width is another character you can aim at.
  return (
    <DialogPane scroll={false} style={{ gap: 12 }}>
      <div style={S.sectionLabel}>
        Click on the ruler to set column breaks. Double-click a break to remove it.
      </div>
      <div
        ref={containerRef}
        style={S.rulerContainer}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        {/* Ruler row */}
        <div style={S.rulerRow}>
          {rulerChars.map((ch, i) => (
            <span key={i} style={S.rulerNumber}>{ch}</span>
          ))}
          {/* Break lines on ruler */}
          {breaks.map((pos) => (
            <div
              key={`b-${pos}`}
              style={{
                ...S.breakLine,
                left: pos * CHAR_WIDTH,
              }}
            >
              <div style={S.breakArrow} />
            </div>
          ))}
        </div>

        {/* Data rows with break lines */}
        {previewLines.map((line, idx) => (
          <div key={idx} style={S.dataRow}>
            {line.split("").map((ch, ci) => (
              <span
                key={ci}
                style={{
                  display: "inline-block",
                  width: CHAR_WIDTH,
                  textAlign: "center",
                }}
              >
                {ch}
              </span>
            ))}
            {/* Break lines overlaid on data */}
            {breaks.map((pos) => (
              <div
                key={`bl-${pos}`}
                style={{
                  ...S.breakLine,
                  left: pos * CHAR_WIDTH,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </DialogPane>
  );
}

// ============================================================================
// Step 3: Column Format & Destination
// ============================================================================

function Step3Format(props: {
  previewRows: string[][];
  maxCols: number;
  formats: ColumnFormat[];
  selectedCol: number;
  onSelectCol: (col: number) => void;
  onSetFormat: (col: number, fmt: ColumnFormat) => void;
  sourceCol: number;
  /** 0-based row of the source range's top-left cell. The destination box
   *  needs BOTH coordinates: it used to build the row number out of the
   *  COLUMN index, so it named the right cell only when startRow===startCol. */
  sourceRow: number;
}) {
  const { previewRows, maxCols, formats, selectedCol, onSelectCol, onSetFormat, sourceCol, sourceRow } = props;
  const currentFormat = formats[selectedCol] ?? "general";

  // Full width, NOT a split: this step's controls are one row — a select and a
  // read-only destination box. Parked in a 600px-tall column they would float
  // in emptiness, so they sit inline above a preview that takes the rest.
  return (
    <DialogPane scroll={false} style={{ gap: 12 }}>
      <div style={S.sectionLabel}>Column data format</div>
      <div style={{ fontSize: 12, color: v("--text-secondary"), marginBottom: 4 }}>
        Click a column in the preview to select it, then choose its format.
      </div>

      <div style={{ ...S.inlineRow, gap: 24 }}>
        <div style={S.formatRow}>
          <span>Format for column {selectedCol + 1}:</span>
          <select
            style={S.select}
            value={currentFormat}
            onChange={(e) => onSetFormat(selectedCol, e.target.value as ColumnFormat)}
          >
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div style={S.destRow}>
          <span>Destination:</span>
          <input
            type="text"
            style={S.destInput}
            readOnly
            value={`$${indexToCol(sourceCol)}$${sourceRow + 1}`}
            title="The split data will be written starting from this cell."
          />
        </div>
      </div>

      <div style={S.sectionLabel}>Data preview</div>
      <div style={S.preview}>
        <table style={S.previewTable}>
          <thead>
            <tr>
              {Array.from({ length: maxCols }, (_, i) => {
                const fmt = formats[i] ?? "general";
                const fmtLabel = FORMAT_OPTIONS.find((o) => o.value === fmt)?.label ?? "General";
                const isSelected = i === selectedCol;
                return (
                  <th
                    key={i}
                    style={{
                      ...S.previewTh,
                      background: isSelected ? v("--accent-primary") : v("--grid-bg"),
                      color: isSelected ? "#fff" : "inherit",
                    }}
                    onClick={() => onSelectCol(i)}
                  >
                    {fmtLabel}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, ri) => (
              <tr key={ri}>
                {Array.from({ length: maxCols }, (_, ci) => {
                  const fmt = formats[ci] ?? "general";
                  const isSkipped = fmt === "skip";
                  const isSelected = ci === selectedCol;
                  return (
                    <td
                      key={ci}
                      style={{
                        ...S.previewTd,
                        opacity: isSkipped ? 0.35 : 1,
                        textDecoration: isSkipped ? "line-through" : "none",
                        background: isSelected
                          ? "rgba(var(--accent-primary-rgb, 50, 120, 200), 0.08)"
                          : "transparent",
                      }}
                      onClick={() => onSelectCol(ci)}
                    >
                      {row[ci] ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DialogPane>
  );
}

// ============================================================================
// Shared: Raw data preview (Step 1)
// ============================================================================

function RawPreview(props: { values: string[] }) {
  const { values } = props;
  const subset = values.slice(0, MAX_PREVIEW_ROWS);

  return (
    <div style={S.preview}>
      <table style={S.previewTable}>
        <tbody>
          {subset.map((val, i) => (
            <tr key={i}>
              {/* rawPreviewTd, not previewTd: a 150px cap with an ellipsis
                  would survive any amount of widening. */}
              <td style={S.rawPreviewTd}>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// Shared: Split preview table (Step 2 delimited)
// ============================================================================

function SplitPreview(props: { rows: string[][]; maxCols: number }) {
  const { rows, maxCols } = props;

  return (
    <div style={S.preview}>
      <table style={S.previewTable}>
        <thead>
          <tr>
            {Array.from({ length: maxCols }, (_, i) => (
              <th key={i} style={S.previewTh}>Column {i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {Array.from({ length: maxCols }, (_, ci) => (
                <td key={ci} style={S.previewTd}>{row[ci] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
