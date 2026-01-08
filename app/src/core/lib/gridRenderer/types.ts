//FILENAME: app/src/lib/gridRenderer/types.ts
//PURPOSE: Core type definitions and theme configuration for grid rendering
//CONTEXT: Defines interfaces used throughout the rendering pipeline

import type {
  GridConfig,
  Viewport,
  Selection,
  EditingCell,
  CellDataMap,
  FormulaReference,
  DimensionOverrides,
  StyleDataMap,
} from "../../types";

/**
 * Theme colors for the grid renderer.
 */
export interface GridTheme {
  /** Background color for cells */
  cellBackground: string;
  /** Grid line color */
  gridLine: string;
  /** Header background color */
  headerBackground: string;
  /** Header text color */
  headerText: string;
  /** Header border color */
  headerBorder: string;
  /** Selection background color (with alpha) */
  selectionBackground: string;
  /** Selection border color */
  selectionBorder: string;
  /** Active cell border color */
  activeCellBorder: string;
  /** Editing cell background */
  editingBackground: string;
  /** Corner cell background (intersection of headers) */
  cornerBackground: string;
  /** Cell text color */
  cellText: string;
  /** Cell text color for numbers (right-aligned) */
  cellTextNumber: string;
  /** Cell text color for errors */
  cellTextError: string;
  /** Cell font family */
  cellFontFamily: string;
  /** Cell font size in pixels */
  cellFontSize: number;
  /** Header highlight color for selected columns/rows */
  headerHighlight: string;
  /** Header highlight text color */
  headerHighlightText: string;
  /** Resize handle color */
  resizeHandle: string;
}

/**
 * Default theme for the grid.
 */
export const DEFAULT_THEME: GridTheme = {
  cellBackground: "#ffffff",
  gridLine: "#e2e2e2",
  headerBackground: "#f8f9fa",
  headerText: "#666666",
  headerBorder: "#d0d0d0",
  selectionBackground: "rgba(33, 115, 215, 0.15)",
  selectionBorder: "#2173d7",
  activeCellBorder: "#1a5fb4",
  editingBackground: "#ffffff",
  cornerBackground: "#f0f0f0",
  cellText: "#000000",
  cellTextNumber: "#000000",
  cellTextError: "#cc0000",
  cellFontFamily: "system-ui, -apple-system, sans-serif",
  cellFontSize: 13,
  headerHighlight: "#cce0f5",
  headerHighlightText: "#1a5fb4",
  resizeHandle: "#1a5fb4",
};

/**
 * Render state passed to all drawing functions.
 * Phase 6 FIX: Added styleCache for proper style rendering.
 */
export interface RenderState {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  config: GridConfig;
  viewport: Viewport;
  selection: Selection | null;
  editing: EditingCell | null;
  theme: GridTheme;
  cells: CellDataMap;
  formulaReferences: FormulaReference[];
  dimensions: DimensionOverrides;
  /** Style cache mapping style indices to StyleData objects */
  styleCache: StyleDataMap;
  fillPreviewRange?: Selection | null;
  clipboardSelection?: Selection | null;
  clipboardMode?: "none" | "copy" | "cut";
  /** Animation offset for marching ants effect (0-20 range) */
  clipboardAnimationOffset?: number;
}