//! FILENAME: app/extensions/CsvImportExport/components/CsvExportDialog.tsx
// PURPOSE: CSV Export dialog with delimiter, encoding, and range options.
// CONTEXT: Registered as a dialog via DialogExtensions. Opened from Data menu.

import React, { useState, useCallback } from "react";
import type { DialogProps } from "@api/uiTypes";
import {
  getViewportCells,
  showToast,
  restoreFocusToGrid,
} from "@api";
import { getGridBounds } from "@api/lib";
import { invokeBackend } from "@api/backend";
import { save } from "@tauri-apps/plugin-dialog";
import { exportToCsv, createDefaultExportOptions } from "../lib/csvExporter";

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
    width: 440,
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
    gap: 14,
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
    flex: 1,
  },
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  radio: { cursor: "pointer", accentColor: v("--accent-primary") },
  radioRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    cursor: "pointer",
    fontSize: 13,
  },
};

const DELIMITERS: { label: string; value: string }[] = [
  { label: "Comma (,)", value: "," },
  { label: "Semicolon (;)", value: ";" },
  { label: "Tab", value: "\t" },
  { label: "Pipe (|)", value: "|" },
];

const ENCODINGS: { label: string; value: string }[] = [
  { label: "UTF-8", value: "utf-8" },
  { label: "UTF-8 with BOM", value: "utf-8-bom" },
  { label: "ANSI (Windows-1252)", value: "ansi" },
];

// ============================================================================
// Component
// ============================================================================

export const CsvExportDialog: React.FC<DialogProps> = ({ onClose }) => {
  const [delimiter, setDelimiter] = useState(",");
  const [encoding, setEncoding] = useState("utf-8");
  const [textQualifier, setTextQualifier] = useState('"');
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      // Get grid bounds to know the data extent
      const [maxRow, maxCol] = await getGridBounds();
      if (maxRow === 0 && maxCol === 0) {
        showToast({ message: "No data to export.", type: "warning", duration: 3000 });
        setExporting(false);
        return;
      }

      // Fetch all cells in the used range
      const cells = await getViewportCells(0, 0, maxRow - 1, maxCol - 1);

      // Build 2D array from sparse cell data
      const data: string[][] = [];
      for (let r = 0; r < maxRow; r++) {
        const row: string[] = [];
        for (let c = 0; c < maxCol; c++) {
          row.push("");
        }
        data.push(row);
      }

      for (const cell of cells) {
        if (cell.row < maxRow && cell.col < maxCol) {
          data[cell.row][cell.col] = cell.display ?? "";
        }
      }

      // Trim trailing empty rows
      while (data.length > 0 && data[data.length - 1].every((c) => c === "")) {
        data.pop();
      }

      // Generate CSV text
      const csvText = exportToCsv(data, {
        delimiter,
        textQualifier,
        lineEnding: "\r\n",
      });

      // Choose file extension based on delimiter
      const ext = delimiter === "\t" ? "tsv" : "csv";
      const filterName = delimiter === "\t" ? "Tab-Separated Values" : "CSV File";

      // Save dialog
      const path = await save({
        filters: [
          { name: filterName, extensions: [ext] },
          { name: "All Files", extensions: ["*"] },
        ],
        defaultPath: `export.${ext}`,
      });

      if (path) {
        await invokeBackend("write_text_file", {
          path,
          content: csvText,
          encoding: encoding || null,
        });

        showToast({
          message: `Exported ${data.length} rows to CSV.`,
          type: "success",
          duration: 3000,
        });

        restoreFocusToGrid();
        onClose();
      }
    } catch (err) {
      showToast({
        message: `Export failed: ${err}`,
        type: "error",
        duration: 5000,
      });
    } finally {
      setExporting(false);
    }
  }, [delimiter, encoding, textQualifier, onClose]);

  return (
    <div style={S.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={S.dialog}>
        {/* Header */}
        <div style={S.header}>
          <span style={S.title}>Export to CSV</span>
          <button style={S.closeBtn} onClick={onClose} title="Close">X</button>
        </div>

        {/* Body */}
        <div style={S.body}>
          {/* Delimiter */}
          <div style={S.section}>
            <div style={S.label}>Delimiter</div>
            <select
              style={S.select}
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value)}
            >
              {DELIMITERS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
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

        {/* Footer */}
        <div style={S.footer}>
          <button style={S.btn} onClick={onClose}>Cancel</button>
          <button
            style={{ ...S.btnPrimary, opacity: exporting ? 0.5 : 1 }}
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? "Exporting..." : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
};
