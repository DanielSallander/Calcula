//! FILENAME: app/extensions/CsvImportExport/components/CsvImportDialog.tsx
// PURPOSE: CSV Import wizard dialog with delimiter options, encoding, preview.
// CONTEXT: Registered as a dialog via DialogExtensions. Opened from Data > Get Data > CSV.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  restoreFocusToGrid,
  showToast,
  addSheet,
  setActiveSheet,
  getSheets,
} from "@api";
import type { CellUpdateInput } from "@api";
import { invokeBackend } from "@api/backend";
import { open } from "@tauri-apps/plugin-dialog";
import {
  parseCsv,
  parseCsvPreview,
  detectDelimiter,
  createDefaultParseOptions,
} from "../lib/csvParser";
import type { CsvParseOptions } from "../lib/csvParser";

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
    width: 620,
    maxHeight: "85vh",
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
    padding: "16px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    overflowY: "auto" as const,
    flex: 1,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "12px 16px",
    borderTop: `1px solid ${v("--border-default")}`,
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
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: v("--text-secondary"),
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  select: {
    padding: "4px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
  },
  input: {
    padding: "4px 8px",
    fontSize: 13,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-primary"),
  },
  fileRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  filePath: {
    flex: 1,
    padding: "4px 8px",
    fontSize: 12,
    borderRadius: 3,
    border: `1px solid ${v("--border-default")}`,
    background: v("--grid-bg"),
    color: v("--text-secondary"),
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
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
  preview: {
    border: `1px solid ${v("--border-default")}`,
    borderRadius: 4,
    overflow: "auto" as const,
    maxHeight: 220,
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
    background: v("--panel-bg"),
    fontWeight: 600,
    textAlign: "left" as const,
    position: "sticky" as const,
    top: 0,
  },
  previewTd: {
    padding: "3px 8px",
    borderBottom: `1px solid ${v("--border-default")}`,
    borderRight: `1px solid ${v("--border-default")}`,
    maxWidth: 200,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  radio: { cursor: "pointer", accentColor: v("--accent-primary") },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  },
};

// ============================================================================
// Delimiter label map
// ============================================================================

const DELIMITERS: { label: string; value: string }[] = [
  { label: "Comma (,)", value: "," },
  { label: "Semicolon (;)", value: ";" },
  { label: "Tab", value: "\t" },
  { label: "Pipe (|)", value: "|" },
  { label: "Auto-detect", value: "auto" },
];

const ENCODINGS: { label: string; value: string }[] = [
  { label: "UTF-8 (auto-detect)", value: "" },
  { label: "UTF-8", value: "utf-8" },
  { label: "ANSI (Windows-1252)", value: "ansi" },
];

type ImportTarget = "current" | "new";

// ============================================================================
// Component
// ============================================================================

export const CsvImportDialog: React.FC<DialogProps> = ({ onClose }) => {
  const [filePath, setFilePath] = useState("");
  const [rawText, setRawText] = useState("");
  const [delimiterChoice, setDelimiterChoice] = useState("auto");
  const [encoding, setEncoding] = useState("");
  const [textQualifier, setTextQualifier] = useState('"');
  const [hasHeaders, setHasHeaders] = useState(false);
  const [skipRows, setSkipRows] = useState(0);
  const [importTarget, setImportTarget] = useState<ImportTarget>("new");
  const [importing, setImporting] = useState(false);

  // Derived: effective delimiter
  const effectiveDelimiter = useMemo(() => {
    if (delimiterChoice === "auto" && rawText) {
      return detectDelimiter(rawText);
    }
    return delimiterChoice === "auto" ? "," : delimiterChoice;
  }, [delimiterChoice, rawText]);

  // Derived: parse options
  const parseOptions: CsvParseOptions = useMemo(
    () => ({
      delimiter: effectiveDelimiter,
      textQualifier,
      hasHeaders,
      skipRows,
    }),
    [effectiveDelimiter, textQualifier, hasHeaders, skipRows],
  );

  // Derived: preview rows
  const previewData = useMemo(() => {
    if (!rawText) return [];
    return parseCsvPreview(rawText, parseOptions, 20);
  }, [rawText, parseOptions]);

  // Detected delimiter label for display
  const detectedLabel = useMemo(() => {
    if (delimiterChoice !== "auto" || !rawText) return "";
    const d = detectDelimiter(rawText);
    const match = DELIMITERS.find((x) => x.value === d);
    return match ? match.label : JSON.stringify(d);
  }, [delimiterChoice, rawText]);

  // ---- File picker ----
  const handleBrowse = useCallback(async () => {
    const path = await open({
      filters: [
        { name: "CSV Files", extensions: ["csv", "tsv", "txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
      multiple: false,
      directory: false,
    });

    if (path && typeof path === "string") {
      setFilePath(path);
      try {
        const text = await invokeBackend<string>("read_text_file", {
          path,
          encoding: encoding || null,
        });
        setRawText(text);
      } catch (err) {
        showToast({
          message: `Failed to read file: ${err}`,
          type: "error",
          duration: 5000,
        });
      }
    }
  }, [encoding]);

  // Re-read file when encoding changes
  useEffect(() => {
    if (!filePath) return;
    invokeBackend<string>("read_text_file", {
      path: filePath,
      encoding: encoding || null,
    })
      .then(setRawText)
      .catch(() => {});
  }, [filePath, encoding]);

  // ---- Import ----
  const handleImport = useCallback(async () => {
    if (!rawText) return;
    setImporting(true);

    try {
      const allRows = parseCsv(rawText, parseOptions);
      if (allRows.length === 0) {
        showToast({ message: "No data to import.", type: "warning", duration: 3000 });
        setImporting(false);
        return;
      }

      // Determine start row (skip header row if present)
      const dataStartIdx = hasHeaders ? 1 : 0;
      const dataRows = allRows.slice(dataStartIdx);
      const headerRow = hasHeaders ? allRows[0] : null;

      if (importTarget === "new") {
        const sheetsResult = await addSheet();
        const newIdx = sheetsResult.sheets.length - 1;
        await setActiveSheet(newIdx);
        // Dispatch to frontend
        window.dispatchEvent(
          new CustomEvent("sheets:changed", { detail: sheetsResult }),
        );
      }

      await beginUndoTransaction("CSV Import");

      // Build cell updates
      const updates: CellUpdateInput[] = [];
      let writeRow = 0;

      // Write headers if present
      if (headerRow) {
        for (let c = 0; c < headerRow.length; c++) {
          updates.push({ row: writeRow, col: c, value: headerRow[c] });
        }
        writeRow++;
      }

      // Write data rows
      for (const row of dataRows) {
        for (let c = 0; c < row.length; c++) {
          const val = row[c];
          if (val !== "") {
            updates.push({ row: writeRow, col: c, value: val });
          }
        }
        writeRow++;
      }

      // Batch update in chunks to avoid overwhelming the backend
      const CHUNK_SIZE = 5000;
      for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
        const chunk = updates.slice(i, i + CHUNK_SIZE);
        await updateCellsBatch(chunk);
      }

      await commitUndoTransaction();

      window.dispatchEvent(new CustomEvent("grid:refresh"));

      showToast({
        message: `Imported ${dataRows.length} rows from CSV.`,
        type: "success",
        duration: 3000,
      });

      restoreFocusToGrid();
      onClose();
    } catch (err) {
      showToast({
        message: `Import failed: ${err}`,
        type: "error",
        duration: 5000,
      });
    } finally {
      setImporting(false);
    }
  }, [rawText, parseOptions, hasHeaders, importTarget, onClose]);

  // ---- Render ----
  return (
    <div style={S.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.dialog}>
        {/* Header */}
        <div style={S.header}>
          <span style={S.title}>Import CSV</span>
          <button style={S.closeBtn} onClick={onClose} title="Close">X</button>
        </div>

        {/* Body */}
        <div style={S.body}>
          {/* File selection */}
          <div style={S.section}>
            <div style={S.label}>File</div>
            <div style={S.fileRow}>
              <div style={S.filePath}>{filePath || "No file selected"}</div>
              <button style={S.btn} onClick={handleBrowse}>Browse...</button>
            </div>
          </div>

          {/* Options row */}
          <div style={{ ...S.row, flexWrap: "wrap" as const, gap: 16 }}>
            {/* Delimiter */}
            <div style={S.section}>
              <div style={S.label}>Delimiter</div>
              <select
                style={S.select}
                value={delimiterChoice}
                onChange={(e) => setDelimiterChoice(e.target.value)}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              {detectedLabel && (
                <span style={{ fontSize: 11, color: v("--text-secondary") }}>
                  Detected: {detectedLabel}
                </span>
              )}
            </div>

            {/* Encoding */}
            <div style={S.section}>
              <div style={S.label}>Encoding</div>
              <select
                style={S.select}
                value={encoding}
                onChange={(e) => setEncoding(e.target.value)}
              >
                {ENCODINGS.map((enc) => (
                  <option key={enc.value} value={enc.value}>
                    {enc.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Text Qualifier */}
            <div style={S.section}>
              <div style={S.label}>Text Qualifier</div>
              <select
                style={S.select}
                value={textQualifier}
                onChange={(e) => setTextQualifier(e.target.value)}
              >
                <option value={'"'}>&quot; (Double quote)</option>
                <option value="'">' (Single quote)</option>
                <option value="">None</option>
              </select>
            </div>
          </div>

          {/* Checkboxes */}
          <div style={{ ...S.row, gap: 20 }}>
            <label style={S.checkboxRow}>
              <input
                type="checkbox"
                style={S.checkbox}
                checked={hasHeaders}
                onChange={(e) => setHasHeaders(e.target.checked)}
              />
              First row contains headers
            </label>

            <div style={{ ...S.row, gap: 6 }}>
              <span style={{ fontSize: 13 }}>Skip rows:</span>
              <input
                type="number"
                style={{ ...S.input, width: 60 }}
                min={0}
                value={skipRows}
                onChange={(e) => setSkipRows(Math.max(0, parseInt(e.target.value) || 0))}
              />
            </div>
          </div>

          {/* Import target */}
          <div style={S.section}>
            <div style={S.label}>Import To</div>
            <div style={{ ...S.row, gap: 16 }}>
              <label style={S.checkboxRow}>
                <input
                  type="radio"
                  name="importTarget"
                  style={S.radio}
                  checked={importTarget === "new"}
                  onChange={() => setImportTarget("new")}
                />
                New sheet
              </label>
              <label style={S.checkboxRow}>
                <input
                  type="radio"
                  name="importTarget"
                  style={S.radio}
                  checked={importTarget === "current"}
                  onChange={() => setImportTarget("current")}
                />
                Current sheet (at cursor)
              </label>
            </div>
          </div>

          {/* Preview */}
          {previewData.length > 0 && (
            <div style={S.section}>
              <div style={S.label}>
                Preview ({Math.min(previewData.length, 20)} of{" "}
                {rawText.split(/\r?\n/).filter((l) => l.length > 0).length} rows)
              </div>
              <div style={S.preview}>
                <table style={S.previewTable}>
                  <thead>
                    <tr>
                      {previewData[0]?.map((_, ci) => (
                        <th key={ci} style={S.previewTh}>
                          {hasHeaders && previewData[0]
                            ? previewData[0][ci] || `Column ${ci + 1}`
                            : `Column ${ci + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.slice(hasHeaders ? 1 : 0).map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci} style={S.previewTd} title={cell}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          <button style={S.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={{
              ...S.btnPrimary,
              opacity: !rawText || importing ? 0.5 : 1,
            }}
            onClick={handleImport}
            disabled={!rawText || importing}
          >
            {importing ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
};
