//! FILENAME: app/src/core/theme/darkGridTheme.ts
// PURPOSE: Dark baseline for the Canvas grid renderer (GridTheme). The canvas
//          cannot read CSS variables, so its colors are supplied in JS.
// CONTEXT: Core/pure. Dark counterpart of DEFAULT_THEME in gridRenderer/types.ts.

import type { GridTheme } from "../lib/gridRenderer/types";

/** Dark baseline grid theme. */
export const DARK_GRID_THEME: GridTheme = {
  cellBackground: "#1e1e1e",
  gridLine: "#3a3a3a",
  headerBackground: "#252526",
  headerText: "#cccccc",
  headerBorder: "#3a3a3a",
  selectionBackground: "rgba(16, 185, 129, 0.20)",
  selectionBorder: "#10b981",
  activeCellBorder: "#34d399",
  editingBackground: "#1e1e1e",
  cornerBackground: "#2d2d2d",
  cellText: "#e0e0e0",
  cellTextNumber: "#e0e0e0",
  cellTextError: "#f87171",
  cellFontFamily: "Calibri",
  cellFontSize: 11, // points (Excel default body size); renderer converts to px
  headerHighlight: "#37373d",
  headerHighlightText: "#ffffff",
  resizeHandle: "#34d399",
};
