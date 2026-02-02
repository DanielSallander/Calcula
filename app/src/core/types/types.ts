//! FILENAME: app/src/core/types/types.ts
// PURPOSE: Shared TypeScript type definitions for the Calcula frontend.
// CONTEXT: This module contains interfaces and types used across the
// React application for type-safe component props and state management.
// Includes selection, viewport, grid configuration, editing state,
// cell data representation, scroll behavior types, and the combined
// grid state used by the state management system.
// UPDATED: Added FreezeConfig for freeze panes support
// UPDATED: Added rowSpan/colSpan to EditingCell for merged cell editing
// UPDATED: Removed FindState - Find state now lives in the FindReplaceDialog extension
//          per Microkernel Architecture (Find is a feature, not a kernel primitive)

/**
 * Type of selection: cells, entire column(s), or entire row(s).
 */
export type SelectionType = "cells" | "columns" | "rows";
/**
 * Clipboard mode for visual feedback.
 */
export type ClipboardMode = "none" | "copy" | "cut";

/**
 * Represents the currently selected cell or range.
 * startRow/startCol is the anchor point, endRow/endCol is the active cell.
 */
export interface Selection {
  /** Starting row (0-based) - anchor point */
  startRow: number;
  /** Starting column (0-based) - anchor point */
  startCol: number;
  /** Ending row (0-based) - active cell */
  endRow: number;
  /** Ending column (0-based) - active cell */
  endCol: number;
  /** Type of selection (cells, columns, or rows) */
  type: SelectionType;
}

/**
 * Represents the visible viewport in the grid.
 */
export interface Viewport {
  /** First visible row index (0-based) */
  startRow: number;
  /** First visible column index (0-based) */
  startCol: number;
  /** Number of visible rows */
  rowCount: number;
  /** Number of visible columns */
  colCount: number;
  /** Scroll offset in pixels (horizontal) */
  scrollX: number;
  /** Scroll offset in pixels (vertical) */
  scrollY: number;
}

/**
 * Custom dimension overrides for columns/rows.
 */
export interface DimensionOverrides {
  /** Custom column widths (col index -> width) */
  columnWidths: Map<number, number>;
  /** Custom row heights (row index -> height) */
  rowHeights: Map<number, number>;
}

/**
 * Create empty dimension overrides.
 */
export function createEmptyDimensionOverrides(): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
  };
}

/**
 * Freeze panes configuration.
 * freezeRow/freezeCol indicate the FIRST scrollable row/column.
 * Example: freezeRow=1 means row 0 is frozen, freezeCol=2 means columns 0-1 are frozen.
 */
export interface FreezeConfig {
  /** First scrollable row (null = no frozen rows) */
  freezeRow: number | null;
  /** First scrollable column (null = no frozen columns) */
  freezeCol: number | null;
}

/**
 * Default freeze config (no frozen panes).
 */
export const DEFAULT_FREEZE_CONFIG: FreezeConfig = {
  freezeRow: null,
  freezeCol: null,
};

/**
 * Configuration for grid dimensions.
 */
export interface GridConfig {
  /** Default cell width in pixels */
  defaultCellWidth: number;
  /** Default cell height in pixels */
  defaultCellHeight: number;
  /** Row header width in pixels */
  rowHeaderWidth: number;
  /** Column header height in pixels */
  colHeaderHeight: number;
  /** Total number of rows supported */
  totalRows: number;
  /** Total number of columns supported */
  totalCols: number;
  /** Minimum column width when resizing */
  minColumnWidth: number;
  /** Minimum row height when resizing */
  minRowHeight: number;
}

/**
 * Default grid configuration values.
 */
export const DEFAULT_GRID_CONFIG: GridConfig = {
  defaultCellWidth: 100,
  defaultCellHeight: 24,
  rowHeaderWidth: 50,
  colHeaderHeight: 24,
  totalRows: 1048576, // Excel's row limit
  totalCols: 16384, // Excel's column limit (XFD)
  minColumnWidth: 20,
  minRowHeight: 16,
};

/**
 * Represents a cell being edited.
 * UPDATED: Added rowSpan/colSpan for merged cell editing support.
 */
export interface EditingCell {
  /** Row index (0-based) */
  row: number;
  /** Column index (0-based) */
  col: number;
  /** Current value in the editor */
  value: string;
  /** Source sheet index where editing started (for cross-sheet references) */
  sourceSheetIndex?: number;
  /** Source sheet name where editing started (for cross-sheet references) */
  sourceSheetName?: string;
  /** Number of rows this cell spans (for merged cells, default 1) */
  rowSpan?: number;
  /** Number of columns this cell spans (for merged cells, default 1) */
  colSpan?: number;
}

/**
 * Sheet information for tracking active/editing context.
 */
export interface SheetContext {
  activeSheetIndex: number;
  activeSheetName: string;
}

/**
 * Represents cell data from the backend.
 * Uses camelCase to match Rust's serde(rename_all = "camelCase").
 */
export interface CellData {
  /** Row index (0-based) */
  row: number;
  /** Column index (0-based) */
  col: number;
  /** Display value (formatted for presentation) */
  display: string;
  /** Original formula if cell contains a formula */
  formula: string | null;
  /** Style index for looking up formatting */
  styleIndex: number;
  /** Number of rows this cell spans (for merged cells) */
  rowSpan?: number;
  /** Number of columns this cell spans (for merged cells) */
  colSpan?: number;
}

/**
 * Dimension data for columns/rows from backend.
 */
export interface DimensionData {
  /** Index of the column or row */
  index: number;
  /** Size (width or height) in pixels */
  size: number;
}

/**
 * Style data from the backend.
 * Uses camelCase to match Rust's serde(rename_all = "camelCase").
 */
export interface StyleData {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSize: number;
  fontFamily: string;
  textColor: string;
  backgroundColor: string;
  textAlign: string;
  verticalAlign: string;
  numberFormat: string;
  wrapText: boolean;
  textRotation: string;
}

/**
 * Default style data for cells without custom styling.
 */
export const DEFAULT_STYLE: StyleData = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  fontSize: 11,
  fontFamily: "system-ui",
  textColor: "#000000",
  backgroundColor: "#ffffff",
  textAlign: "general",
  verticalAlign: "middle",
  numberFormat: "General",
  wrapText: false,
  textRotation: "none",
};

/**
 * Formatting options for applying styles to cells.
 */
export interface FormattingOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  textColor?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "general";
  numberFormat?: string;
  wrapText?: boolean;
  textRotation?: "none" | "rotate90" | "rotate270";
}

/**
 * Style entry with index and style data.
 */
export interface StyleEntry {
  index: number;
  style: StyleData;
}

/**
 * Result from applying formatting to cells.
 */
export interface FormattingResult {
  /** Updated cell data */
  cells: CellData[];
  /** New or modified styles */
  styles: StyleEntry[];
}

/**
 * Information about a spreadsheet function.
 */
export interface FunctionInfo {
  /** Function name (e.g., "SUM") */
  name: string;
  /** Function syntax (e.g., "SUM(number1, [number2], ...)") */
  syntax: string;
  /** Brief description of what the function does */
  description: string;
  /** Category (e.g., "Math", "Logical", "Text") */
  category: string;
}

/**
 * Number format presets for the format picker.
 * Phase 6.4: Used by the Ribbon UI.
 */
export const NUMBER_FORMAT_PRESETS = [
  { id: "general", label: "General", example: "1234.5" },
  { id: "number", label: "Number", example: "1234.50" },
  { id: "number_sep", label: "Number (with separators)", example: "1,234.50" },
  { id: "currency_usd", label: "Currency (USD)", example: "$1,234.50" },
  { id: "currency_eur", label: "Currency (EUR)", example: "EUR 1,234.50" },
  { id: "currency_sek", label: "Currency (SEK)", example: "1,234.50 kr" },
  { id: "percentage", label: "Percentage", example: "12.34%" },
  { id: "percentage_0", label: "Percentage (no decimals)", example: "12%" },
  { id: "scientific", label: "Scientific", example: "1.23E3" },
  { id: "date_iso", label: "Date (ISO)", example: "2025-01-15" },
  { id: "date_us", label: "Date (US)", example: "01/15/2025" },
  { id: "date_eu", label: "Date (EU)", example: "15/01/2025" },
  { id: "time_24", label: "Time (24h)", example: "14:30:00" },
  { id: "time_12", label: "Time (12h)", example: "02:30:00 PM" },
] as const;

/**
 * Map of cell data keyed by "row,col" string for fast lookup.
 */
export type CellDataMap = Map<string, CellData>;

/**
 * Map of style data keyed by style index.
 * Phase 6: Used for caching styles from the backend.
 */
export type StyleDataMap = Map<number, StyleData>;

/**
 * Create a default style cache with the default style at index 0.
 * Phase 6 FIX: Helper function to ensure style cache always has a default.
 */
export function createDefaultStyleCache(): StyleDataMap {
  const cache = new Map<number, StyleData>();
  cache.set(0, DEFAULT_STYLE);
  return cache;
}

/**
 * Create a cell key for use in Maps/Sets.
 */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * Scroll target specification for scroll-to operations.
 */
export interface ScrollTarget {
  /** Target row index */
  row: number;
  /** Target column index */
  col: number;
  /** Whether to center the cell in viewport */
  center?: boolean;
}

/**
 * Scroll delta for relative scrolling operations.
 */
export interface ScrollDelta {
  /** Horizontal scroll delta in pixels */
  deltaX: number;
  /** Vertical scroll delta in pixels */
  deltaY: number;
}

/**
 * Viewport dimensions in pixels.
 */
export interface ViewportDimensions {
  /** Viewport width in pixels */
  width: number;
  /** Viewport height in pixels */
  height: number;
}

/**
 * Virtual bounds for dynamic scrollbar behavior.
 * The scrollbar only represents this range, not the full grid.
 * Bounds expand as the user explores the grid.
 */
export interface VirtualBounds {
  /** Maximum row index currently accessible via scrollbar */
  maxRow: number;
  /** Maximum column index currently accessible via scrollbar */
  maxCol: number;
}

/**
 * Default virtual bounds - starts with a reasonable working area.
 * Increased from original 100x26 to provide more breathing room.
 */
export const DEFAULT_VIRTUAL_BOUNDS: VirtualBounds = {
  maxRow: 199, // 200 rows initially (0-199)
  maxCol: 51, // 52 columns initially (A-AZ)
};

/**
 * Configuration for virtual bounds expansion behavior.
 */
export interface VirtualBoundsConfig {
  /** Minimum rows to show initially */
  initialRows: number;
  /** Minimum columns to show initially */
  initialCols: number;
  /** Buffer rows to add when expanding */
  rowBuffer: number;
  /** Buffer columns to add when expanding */
  colBuffer: number;
  /** Threshold (in cells from edge) to trigger expansion */
  expansionThreshold: number;
}

/**
 * Default configuration for virtual bounds.
 * Increased buffers and threshold for smoother expansion experience.
 */
export const DEFAULT_VIRTUAL_BOUNDS_CONFIG: VirtualBoundsConfig = {
  initialRows: 200,
  initialCols: 52,
  rowBuffer: 100, // Add 100 rows when expanding (increased from 50)
  colBuffer: 26, // Add 26 columns when expanding (increased from 10)
  expansionThreshold: 20, // Trigger expansion 20 cells from edge (increased from 5)
};

/**
 * A formula reference for visual highlighting.
 * FIX: Added isFullColumn and isFullRow flags to indicate full column/row
 * references. When set, the visual bounds are limited but the actual
 * formula references the entire column/row.
 */
export interface FormulaReference {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  color: string;
  /** Optional sheet name for cross-sheet references */
  sheetName?: string;
  /** True if this represents a full column reference (e.g., A:A) */
  isFullColumn?: boolean;
  /** True if this represents a full row reference (e.g., 1:1) */
  isFullRow?: boolean;
}

/**
 * Animation state for row/column insertion or deletion.
 * Used to create smooth "flow" effect when structure changes.
 */
export interface InsertionAnimation {
  /** Type of structural change */
  type: "row" | "column";
  /** Whether this is an insert or delete operation */
  direction: "insert" | "delete";
  /** Index where the change starts (0-based) */
  index: number;
  /** Number of rows/columns being inserted or deleted */
  count: number;
  /** Animation progress from 0 to 1 */
  progress: number;
  /** Target size of each inserted/deleted row or column in pixels */
  targetSize: number;
}

/**
 * Colors for formula reference highlighting.
 * Matches Excel's formula reference colors.
 */
export const FORMULA_REFERENCE_COLORS = [
  "#0066CC", // Blue
  "#CC0066", // Magenta
  "#00CC66", // Green
  "#CC6600", // Orange
  "#6600CC", // Purple
  "#00CCCC", // Cyan
  "#CC0000", // Red
  "#66CC00", // Lime
];

/**
 * Resize handle hit detection result.
 */
export interface ResizeHandle {
  /** Type of resize: column or row */
  type: "column" | "row";
  /** Index of the column or row being resized */
  index: number;
}

/**
 * Clipboard state for rendering marching ants / dotted border.
 */
export interface ClipboardState {
  mode: ClipboardMode;
  selection: Selection | null;
}

// ============================================================================
// NOTE: FindState has been removed from Core.
// Find/Replace is a FEATURE, not a kernel primitive.
// The Find state now lives in the FindReplaceDialog extension:
// app/extensions/BuiltIn/FindReplaceDialog/useFindStore.ts
//
// The Core only provides search PRIMITIVES via the Tauri API:
// - findAll(query, options) -> returns matching cell coordinates
// - replaceAll(query, replacement, options) -> performs replacement
// - replaceSingle(row, col, query, replacement, options) -> single replace
//
// The DIALOG STATE (isOpen, currentIndex, etc.) is managed by the extension.
// ============================================================================

/**
 * Grid state for the spreadsheet component.
 * NOTE: Find state has been moved to the FindReplaceDialog extension.
 */
export interface GridState {
  /** Current selection (null if nothing selected) */
  selection: Selection | null;
  /** Cell currently being edited (null if not editing) */
  editing: EditingCell | null;
  /** Current viewport position and size */
  viewport: Viewport;
  /** Grid configuration */
  config: GridConfig;
  /** Viewport dimensions in pixels (for scroll calculations) */
  viewportDimensions: ViewportDimensions;
  /** Virtual bounds for dynamic scrollbar */
  virtualBounds: VirtualBounds;
  /** Formula references being highlighted during formula entry */
  formulaReferences: FormulaReference[];
  /** Custom dimension overrides */
  dimensions: DimensionOverrides;
  /** Clipboard state for visual feedback */
  clipboard: ClipboardState;
  /** Current sheet context */
  sheetContext: SheetContext;
  /** Freeze panes configuration */
  freezeConfig: FreezeConfig;
}

/**
 * Create initial grid state with default values.
 * Sets up an empty selection, no editing, and default viewport/config.
 * NOTE: Find state has been moved to the FindReplaceDialog extension.
 */
export function createInitialGridState(): GridState {
  return {
    selection: {
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
      type: "cells",
    },
    editing: null,
    viewport: {
      startRow: 0,
      startCol: 0,
      rowCount: 50,
      colCount: 20,
      scrollX: 0,
      scrollY: 0,
    },
    config: { ...DEFAULT_GRID_CONFIG },
    viewportDimensions: {
      width: 0,
      height: 0,
    },
    virtualBounds: { ...DEFAULT_VIRTUAL_BOUNDS },
    formulaReferences: [],
    dimensions: createEmptyDimensionOverrides(),
    clipboard: {
      mode: "none",
      selection: null,
    },
    sheetContext: {
      activeSheetIndex: 0,
      activeSheetName: "Sheet1",
    },
    freezeConfig: { ...DEFAULT_FREEZE_CONFIG },
  };
}

export interface CellUpdateResult {
  success: boolean;
  row: number;
  col: number;
  display: string;
  formula: string | null;
  error?: string;
  updatedCells?: CellData[];
}

/**
 * Event emitted when a cell changes.
 * Phase 4.3: Used for notifying components of cell updates.
 */
export interface CellChangeEvent {
  row: number;
  col: number;
  oldValue?: string;
  newValue: string;
  formula: string | null;
}

/**
 * Check if a string value is a formula (starts with =).
 */
export function isFormula(value: string): boolean {
  return value.trim().startsWith("=");
}

/**
 * Check if a formula is expecting a reference to be inserted.
 * This is true when:
 * - The value starts with "="
 * - AND ends with an operator, open paren, comma, or is just "="
 *
 * Examples that return true:
 * - "="
 * - "=SUM("
 * - "=A1+"
 * - "=IF(A1>0,"
 *
 * Examples that return false:
 * - "=A1"
 * - "=SUM(A1:B2)"
 * - "Hello"
 */
export function isFormulaExpectingReference(value: string): boolean {
  if (!isFormula(value)) {
    return false;
  }

  const trimmed = value.trim();

  // Just "=" - definitely expecting a reference
  if (trimmed === "=") {
    return true;
  }

  // Get the last character
  const lastChar = trimmed[trimmed.length - 1];

  // Check if last char is an operator or delimiter that expects a reference
  const expectingChars = [
    "+",
    "-",
    "*",
    "/",
    "^",
    "&", // Operators
    "(",
    ",", // Function delimiters
    "=",
    "<",
    ">", // Comparison operators (also handles <=, >=, <>)
    ":", // Range operator (partial range like "A1:")
  ];

  return expectingChars.includes(lastChar);
}

/**
 * Convert a column index to letter(s) (0 -> A, 25 -> Z, 26 -> AA, etc.)
 */
export function columnToLetter(col: number): string {
  let result = "";
  let c = col;
  while (c >= 0) {
    result = String.fromCharCode((c % 26) + 65) + result;
    c = Math.floor(c / 26) - 1;
  }
  return result;
}

/**
 * Convert column letter(s) to index (A -> 0, Z -> 25, AA -> 26, etc.)
 */
export function letterToColumn(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result - 1;
}

/**
 * Visible range for a single viewport zone.
 */
export interface VisibleRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Freeze pane zone identifier.
 * - topLeft: frozen corner (no scroll)
 * - topRight: frozen rows (scrollX only)
 * - bottomLeft: frozen columns (scrollY only)
 * - bottomRight: main scrollable area (both scrollX and scrollY)
 */
export type FreezeZone = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/**
 * Freeze pane layout with pixel boundaries for each zone.
 */
export interface FreezePaneLayout {
  /** Width of frozen columns area in pixels (0 if no frozen cols) */
  frozenColsWidth: number;
  /** Height of frozen rows area in pixels (0 if no frozen rows) */
  frozenRowsHeight: number;
  /** Whether there are frozen rows */
  hasFrozenRows: boolean;
  /** Whether there are frozen columns */
  hasFrozenCols: boolean;
  /** Number of frozen rows */
  frozenRowCount: number;
  /** Number of frozen columns */
  frozenColCount: number;
}

/**
 * Calculate the pixel dimensions of frozen areas.
 */
export function calculateFreezePaneLayout(
  freezeConfig: FreezeConfig,
  config: GridConfig,
  dimensions: DimensionOverrides
): FreezePaneLayout {
  const { freezeRow, freezeCol } = freezeConfig;
  const defaultCellWidth = config.defaultCellWidth || 100;
  const defaultCellHeight = config.defaultCellHeight || 24;

  let frozenColsWidth = 0;
  let frozenRowsHeight = 0;
  const frozenColCount = freezeCol ?? 0;
  const frozenRowCount = freezeRow ?? 0;

  // Calculate width of frozen columns
  if (freezeCol !== null && freezeCol > 0) {
    for (let col = 0; col < freezeCol; col++) {
      const customWidth = dimensions.columnWidths.get(col);
      frozenColsWidth +=
        customWidth !== undefined && customWidth > 0 ? customWidth : defaultCellWidth;
    }
  }

  // Calculate height of frozen rows
  if (freezeRow !== null && freezeRow > 0) {
    for (let row = 0; row < freezeRow; row++) {
      const customHeight = dimensions.rowHeights.get(row);
      frozenRowsHeight +=
        customHeight !== undefined && customHeight > 0 ? customHeight : defaultCellHeight;
    }
  }

  return {
    frozenColsWidth,
    frozenRowsHeight,
    hasFrozenRows: freezeRow !== null && freezeRow > 0,
    hasFrozenCols: freezeCol !== null && freezeCol > 0,
    frozenRowCount,
    frozenColCount,
  };
}

/** A merged cell region */
export interface MergedRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Result of merge operations */
export interface MergeResult {
  success: boolean;
  mergedRegions: MergedRegion[];
  updatedCells: CellData[];
}