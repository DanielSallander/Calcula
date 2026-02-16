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
  /** Sheet index for cross-sheet updates (undefined = current active sheet) */
  sheetIndex?: number;
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
 * A single border side (top, right, bottom, or left).
 */
export interface BorderSideData {
  style: string;
  color: string;
  width: number;
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
  borderTop: BorderSideData;
  borderRight: BorderSideData;
  borderBottom: BorderSideData;
  borderLeft: BorderSideData;
}

/**
 * Default border side data (no border).
 */
export const DEFAULT_BORDER_SIDE: BorderSideData = {
  style: "none",
  color: "#000000",
  width: 0,
};

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
  borderTop: { ...DEFAULT_BORDER_SIDE },
  borderRight: { ...DEFAULT_BORDER_SIDE },
  borderBottom: { ...DEFAULT_BORDER_SIDE },
  borderLeft: { ...DEFAULT_BORDER_SIDE },
};

/**
 * Border side parameter for formatting.
 */
export interface BorderSideParam {
  style: string;
  color: string;
}

/**
 * Formatting options for applying styles to cells.
 */
export interface FormattingOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "general";
  verticalAlign?: "top" | "middle" | "bottom";
  numberFormat?: string;
  wrapText?: boolean;
  textRotation?: "none" | "rotate90" | "rotate270";
  borderTop?: BorderSideParam;
  borderRight?: BorderSideParam;
  borderBottom?: BorderSideParam;
  borderLeft?: BorderSideParam;
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
 * FIX: Added isPassive flag for faint highlighting when selecting (not editing)
 * a formula cell.
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
  /** True if this is a passive highlight (cell selected but not being edited) */
  isPassive?: boolean;
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

// ============================================================================
// Named Ranges
// ============================================================================

/**
 * A named range definition.
 * Can be workbook-scoped (sheetIndex = null) or sheet-scoped.
 */
export interface NamedRange {
  /** The name identifier (e.g., "SalesData", "TaxRate") */
  name: string;
  /** Sheet index for sheet-scoped names, null for workbook-scoped */
  sheetIndex: number | null;
  /** Start row of the range (0-indexed) */
  startRow: number;
  /** Start column of the range (0-indexed) */
  startCol: number;
  /** End row of the range (0-indexed, inclusive) */
  endRow: number;
  /** End column of the range (0-indexed, inclusive) */
  endCol: number;
  /** Optional comment/description */
  comment?: string;
}

/**
 * Result of a named range operation.
 */
export interface NamedRangeResult {
  success: boolean;
  namedRange: NamedRange | null;
  error: string | null;
}

/**
 * Resolved range coordinates for formula evaluation.
 */
export interface ResolvedRange {
  sheetIndex: number;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ============================================================================
// Data Validation
// ============================================================================

/**
 * The type of validation applied to a cell or range.
 */
export type DataValidationType =
  | "none"
  | "wholeNumber"
  | "decimal"
  | "list"
  | "date"
  | "time"
  | "textLength"
  | "custom";

/**
 * Comparison operators for validation rules.
 */
export type DataValidationOperator =
  | "between"
  | "notBetween"
  | "equal"
  | "notEqual"
  | "greaterThan"
  | "lessThan"
  | "greaterThanOrEqual"
  | "lessThanOrEqual";

/**
 * Error alert style when invalid data is entered.
 */
export type DataValidationAlertStyle = "stop" | "warning" | "information";

/**
 * Numeric validation rule (for WholeNumber, Decimal, TextLength).
 */
export interface NumericRule {
  /** First formula/value for comparison */
  formula1: number;
  /** Second formula/value for comparison (used with Between/NotBetween) */
  formula2?: number;
  /** Comparison operator */
  operator: DataValidationOperator;
}

/**
 * Date validation rule.
 */
export interface DateRule {
  /** First date value (as Excel serial date number) */
  formula1: number;
  /** Second date value (used with Between/NotBetween) */
  formula2?: number;
  /** Comparison operator */
  operator: DataValidationOperator;
}

/**
 * Time validation rule.
 */
export interface TimeRule {
  /** First time value (as fraction of day, e.g., 0.5 = 12:00) */
  formula1: number;
  /** Second time value (used with Between/NotBetween) */
  formula2?: number;
  /** Comparison operator */
  operator: DataValidationOperator;
}

/**
 * Source of list values.
 */
export type ListSource =
  | { values: string[] }
  | {
      range: {
        sheetIndex?: number;
        startRow: number;
        startCol: number;
        endRow: number;
        endCol: number;
      };
    };

/**
 * List validation rule (dropdown).
 */
export interface ListRule {
  /** Source values for the dropdown */
  source: ListSource;
  /** Whether to show the in-cell dropdown arrow */
  inCellDropdown: boolean;
}

/**
 * Custom formula validation rule.
 */
export interface CustomRule {
  /** Formula that must evaluate to TRUE for valid data */
  formula: string;
}

/**
 * The complete validation rule (union of all rule types).
 */
export type DataValidationRule =
  | { none: true }
  | { wholeNumber: NumericRule }
  | { decimal: NumericRule }
  | { list: ListRule }
  | { date: DateRule }
  | { time: TimeRule }
  | { textLength: NumericRule }
  | { custom: CustomRule };

/**
 * Error alert configuration shown when invalid data is entered.
 */
export interface DataValidationErrorAlert {
  /** Alert title */
  title: string;
  /** Alert message */
  message: string;
  /** Alert style (Stop, Warning, Information) */
  style: DataValidationAlertStyle;
  /** Whether to show the alert (default true) */
  showAlert: boolean;
}

/**
 * Input prompt shown when the cell is selected.
 */
export interface DataValidationPrompt {
  /** Prompt title */
  title: string;
  /** Prompt message */
  message: string;
  /** Whether to show the prompt (default true) */
  showPrompt: boolean;
}

/**
 * Complete data validation definition for a cell or range.
 */
export interface DataValidation {
  /** The validation rule */
  rule: DataValidationRule;
  /** Error alert configuration */
  errorAlert: DataValidationErrorAlert;
  /** Input prompt configuration */
  prompt: DataValidationPrompt;
  /** Whether to allow blank cells (default true) */
  ignoreBlanks: boolean;
}

/**
 * A cell range with its validation rule.
 */
export interface ValidationRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  validation: DataValidation;
}

/**
 * Result of a validation operation.
 */
export interface DataValidationResult {
  success: boolean;
  validation: DataValidation | null;
  error: string | null;
}

/**
 * Result of getting invalid cells.
 */
export interface InvalidCellsResult {
  /** List of invalid cell coordinates [row, col] */
  cells: [number, number][];
  /** Total count of invalid cells */
  count: number;
}

/**
 * Result of validating a single cell value.
 */
export interface CellValidationResult {
  isValid: boolean;
  errorAlert: DataValidationErrorAlert | null;
}

/**
 * Default error alert for data validation.
 */
export const DEFAULT_ERROR_ALERT: DataValidationErrorAlert = {
  title: "",
  message: "",
  style: "stop",
  showAlert: true,
};

/**
 * Default prompt for data validation.
 */
export const DEFAULT_PROMPT: DataValidationPrompt = {
  title: "",
  message: "",
  showPrompt: true,
};

/**
 * Default data validation (no validation).
 */
export const DEFAULT_VALIDATION: DataValidation = {
  rule: { none: true },
  errorAlert: DEFAULT_ERROR_ALERT,
  prompt: DEFAULT_PROMPT,
  ignoreBlanks: true,
};

/**
 * Helper to create a whole number validation rule.
 */
export function createWholeNumberRule(
  operator: DataValidationOperator,
  formula1: number,
  formula2?: number
): DataValidationRule {
  return {
    wholeNumber: {
      formula1,
      formula2,
      operator,
    },
  };
}

/**
 * Helper to create a decimal validation rule.
 */
export function createDecimalRule(
  operator: DataValidationOperator,
  formula1: number,
  formula2?: number
): DataValidationRule {
  return {
    decimal: {
      formula1,
      formula2,
      operator,
    },
  };
}

/**
 * Helper to create a list validation rule with literal values.
 */
export function createListRule(
  values: string[],
  inCellDropdown: boolean = true
): DataValidationRule {
  return {
    list: {
      source: { values },
      inCellDropdown,
    },
  };
}

/**
 * Helper to create a list validation rule with a range source.
 */
export function createListRuleFromRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sheetIndex?: number,
  inCellDropdown: boolean = true
): DataValidationRule {
  return {
    list: {
      source: {
        range: {
          sheetIndex,
          startRow,
          startCol,
          endRow,
          endCol,
        },
      },
      inCellDropdown,
    },
  };
}

/**
 * Helper to create a text length validation rule.
 */
export function createTextLengthRule(
  operator: DataValidationOperator,
  formula1: number,
  formula2?: number
): DataValidationRule {
  return {
    textLength: {
      formula1,
      formula2,
      operator,
    },
  };
}

/**
 * Helper to create a custom formula validation rule.
 */
export function createCustomRule(formula: string): DataValidationRule {
  return {
    custom: {
      formula,
    },
  };
}

/**
 * Helper to create a date validation rule.
 */
export function createDateRule(
  operator: DataValidationOperator,
  formula1: number,
  formula2?: number
): DataValidationRule {
  return {
    date: {
      formula1,
      formula2,
      operator,
    },
  };
}

/**
 * Helper to create a time validation rule.
 */
export function createTimeRule(
  operator: DataValidationOperator,
  formula1: number,
  formula2?: number
): DataValidationRule {
  return {
    time: {
      formula1,
      formula2,
      operator,
    },
  };
}

// ============================================================================
// Comments / Notes
// ============================================================================

/**
 * A mention within a comment's rich content.
 */
export interface CommentMention {
  /** The email of the mentioned user */
  email: string;
  /** The display name of the mentioned user */
  name: string;
  /** Start index in the rich content string */
  startIndex: number;
  /** Length of the mention placeholder in the rich content */
  length: number;
}

/**
 * A reply to a comment thread.
 */
export interface CommentReply {
  /** Unique identifier for the reply */
  id: string;
  /** Email of the reply author */
  authorEmail: string;
  /** Display name of the reply author */
  authorName: string;
  /** Plain text content of the reply */
  content: string;
  /** Rich content with mention placeholders (for parsing mentions) */
  richContent?: string;
  /** Mentions within this reply */
  mentions: CommentMention[];
  /** Creation timestamp (ISO 8601 format) */
  createdAt: string;
  /** Last modified timestamp (ISO 8601 format) */
  modifiedAt?: string;
}

/**
 * Content type of a comment or reply.
 */
export type CommentContentType = "plain" | "mention";

/**
 * A comment thread attached to a cell.
 */
export interface Comment {
  /** Unique identifier for the comment */
  id: string;
  /** Row of the cell this comment is attached to (0-indexed) */
  row: number;
  /** Column of the cell this comment is attached to (0-indexed) */
  col: number;
  /** Sheet index this comment belongs to */
  sheetIndex: number;
  /** Email of the comment author */
  authorEmail: string;
  /** Display name of the comment author */
  authorName: string;
  /** Plain text content of the comment */
  content: string;
  /** Rich content with mention placeholders (for parsing mentions) */
  richContent?: string;
  /** Content type (plain or mention) */
  contentType: CommentContentType;
  /** Mentions within this comment */
  mentions: CommentMention[];
  /** Whether the comment thread is resolved */
  resolved: boolean;
  /** Replies to this comment */
  replies: CommentReply[];
  /** Creation timestamp (ISO 8601 format) */
  createdAt: string;
  /** Last modified timestamp (ISO 8601 format) */
  modifiedAt?: string;
}

/**
 * Result of a comment operation.
 */
export interface CommentResult {
  success: boolean;
  comment: Comment | null;
  error: string | null;
}

/**
 * Result of a reply operation.
 */
export interface ReplyResult {
  success: boolean;
  reply: CommentReply | null;
  comment: Comment | null;
  error: string | null;
}

/**
 * Parameters for adding a comment.
 */
export interface AddCommentParams {
  row: number;
  col: number;
  authorEmail: string;
  authorName: string;
  content: string;
  richContent?: string;
  mentions?: CommentMention[];
}

/**
 * Parameters for updating a comment.
 */
export interface UpdateCommentParams {
  commentId: string;
  content: string;
  richContent?: string;
  mentions?: CommentMention[];
}

/**
 * Parameters for adding a reply.
 */
export interface AddReplyParams {
  commentId: string;
  authorEmail: string;
  authorName: string;
  content: string;
  richContent?: string;
  mentions?: CommentMention[];
}

/**
 * Parameters for updating a reply.
 */
export interface UpdateReplyParams {
  commentId: string;
  replyId: string;
  content: string;
  richContent?: string;
  mentions?: CommentMention[];
}

/**
 * Information about cells with comments (for indicators).
 */
export interface CommentIndicator {
  row: number;
  col: number;
  resolved: boolean;
  replyCount: number;
}

/**
 * Default comment author info (can be customized per session).
 */
export const DEFAULT_COMMENT_AUTHOR = {
  email: "user@local",
  name: "User",
};

// ============================================================================
// Clear Range Options (Excel-compatible)
// ============================================================================

/**
 * Specifies what to clear from a range.
 * Matches Excel's ClearApplyTo enum.
 */
export type ClearApplyTo =
  | "all"
  | "contents"
  | "formats"
  | "hyperlinks"
  | "removeHyperlinks"
  | "resetContents";

/**
 * Parameters for clear_range_with_options command.
 */
export interface ClearRangeParams {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  applyTo?: ClearApplyTo;
}

/**
 * Result of clear_range_with_options command.
 */
export interface ClearRangeResult {
  /** Number of cells affected */
  count: number;
  /** Updated cells (with new display values if only formatting was cleared) */
  updatedCells: CellData[];
}

// ============================================================================
// Sort Range (Excel-compatible)
// ============================================================================

/**
 * Specifies what to sort on.
 * Matches Excel's SortOn enum.
 */
export type SortOn = "value" | "cellColor" | "fontColor" | "icon";

/**
 * Additional sort data options.
 * Matches Excel's SortDataOption enum.
 */
export type SortDataOption = "normal" | "textAsNumber";

/**
 * Sort orientation (by rows or columns).
 * Matches Excel's SortOrientation enum.
 */
export type SortOrientation = "rows" | "columns";

/**
 * A single sort field/condition.
 * Matches Excel's SortField interface.
 */
export interface SortField {
  /** Column (or row) offset from the first column (or row) being sorted (0-based). Required. */
  key: number;
  /** Sort direction: true for ascending (A-Z, 0-9), false for descending. Default: true */
  ascending?: boolean;
  /** What to sort on (value, cell color, font color, or icon). Default: "value" */
  sortOn?: SortOn;
  /** The color to sort by when sortOn is cellColor or fontColor (CSS color string). */
  color?: string;
  /** Additional data options (e.g., treat text as numbers). Default: "normal" */
  dataOption?: SortDataOption;
  /** For sorting rich values - the subfield/property name to sort on. */
  subField?: string;
}

/**
 * Parameters for sort_range command.
 */
export interface SortRangeParams {
  /** Start row of range to sort (0-based) */
  startRow: number;
  /** Start column of range to sort (0-based) */
  startCol: number;
  /** End row of range to sort (0-based, inclusive) */
  endRow: number;
  /** End column of range to sort (0-based, inclusive) */
  endCol: number;
  /** Sort fields (criteria) - at least one required */
  fields: SortField[];
  /** Whether sorting is case-sensitive. Default: false */
  matchCase?: boolean;
  /** Whether the range has a header row/column that should not be sorted. Default: false */
  hasHeaders?: boolean;
  /** Sort orientation (rows or columns). Default: "rows" */
  orientation?: SortOrientation;
}

/**
 * Result of sort_range command.
 */
export interface SortRangeResult {
  /** Whether the sort was successful */
  success: boolean;
  /** Number of rows (or columns) sorted */
  sortedCount: number;
  /** Updated cells after sorting */
  updatedCells: CellData[];
  /** Error message if sort failed */
  error: string | null;
}

/**
 * Helper to create a simple ascending sort field.
 */
export function createSortField(
  key: number,
  ascending: boolean = true,
  options?: Partial<Omit<SortField, "key" | "ascending">>
): SortField {
  return {
    key,
    ascending,
    ...options,
  };
}

/**
 * Helper to create sort params for a common case: single column sort.
 */
export function createSimpleSortParams(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  sortColumn: number,
  ascending: boolean = true,
  hasHeaders: boolean = false
): SortRangeParams {
  return {
    startRow,
    startCol,
    endRow,
    endCol,
    fields: [{ key: sortColumn - startCol, ascending }],
    hasHeaders,
    orientation: "rows",
  };
}

// ============================================================================
// AutoFilter (Excel-compatible)
// ============================================================================

/**
 * What aspect of the cell to filter on.
 * Matches Excel's FilterOn enum.
 */
export type FilterOn =
  | "values"
  | "topItems"
  | "topPercent"
  | "bottomItems"
  | "bottomPercent"
  | "cellColor"
  | "fontColor"
  | "dynamic"
  | "custom"
  | "icon";

/**
 * Dynamic filter criteria for date and average-based filtering.
 * Matches Excel's DynamicFilterCriteria enum.
 */
export type DynamicFilterCriteria =
  | "aboveAverage"
  | "belowAverage"
  | "today"
  | "tomorrow"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "nextWeek"
  | "thisMonth"
  | "lastMonth"
  | "nextMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "nextQuarter"
  | "thisYear"
  | "lastYear"
  | "nextYear"
  | "yearToDate"
  | "allDatesInPeriodJanuary"
  | "allDatesInPeriodFebruary"
  | "allDatesInPeriodMarch"
  | "allDatesInPeriodApril"
  | "allDatesInPeriodMay"
  | "allDatesInPeriodJune"
  | "allDatesInPeriodJuly"
  | "allDatesInPeriodAugust"
  | "allDatesInPeriodSeptember"
  | "allDatesInPeriodOctober"
  | "allDatesInPeriodNovember"
  | "allDatesInPeriodDecember"
  | "allDatesInPeriodQuarter1"
  | "allDatesInPeriodQuarter2"
  | "allDatesInPeriodQuarter3"
  | "allDatesInPeriodQuarter4"
  | "unknown";

/**
 * Operator for combining criterion1 and criterion2 in custom filters.
 * Matches Excel's FilterOperator enum.
 */
export type FilterOperator = "and" | "or";

/**
 * Icon filter criteria for conditional formatting icons.
 */
export interface IconFilter {
  /** The icon set name (e.g., "3Arrows", "4TrafficLights") */
  iconSet: string;
  /** The icon index within the set (0-based) */
  iconIndex: number;
}

/**
 * Filter criteria for a single column.
 * Matches Excel's FilterCriteria interface.
 */
export interface FilterCriteria {
  /** First criterion value (string for values, number for top/bottom items/percent) */
  criterion1?: string;
  /** Second criterion value (used with custom filters when operator is specified) */
  criterion2?: string;
  /** What aspect of the cell to filter on */
  filterOn: FilterOn;
  /** Dynamic filter criteria (when filterOn is "dynamic") */
  dynamicCriteria?: DynamicFilterCriteria;
  /** Operator for combining criterion1 and criterion2 (for custom filters) */
  operator?: FilterOperator;
  /** Color to filter by (CSS color string, when filterOn is "cellColor" or "fontColor") */
  color?: string;
  /** Icon to filter by (when filterOn is "icon") */
  icon?: IconFilter;
  /** Specific values to filter (when filterOn is "values") */
  values: string[];
  /** Whether to filter out blank cells */
  filterOutBlanks: boolean;
}

/**
 * AutoFilter info returned from the backend.
 */
export interface AutoFilterInfo {
  /** Start row of the AutoFilter range (0-based, typically header row) */
  startRow: number;
  /** Start column of the AutoFilter range (0-based) */
  startCol: number;
  /** End row of the AutoFilter range (0-based) */
  endRow: number;
  /** End column of the AutoFilter range (0-based) */
  endCol: number;
  /** Whether the AutoFilter is enabled (showing filter dropdowns) */
  enabled: boolean;
  /** Whether the AutoFilter has any active filter criteria */
  isDataFiltered: boolean;
  /** Filter criteria array (indexed by column, null if no filter) */
  criteria: (FilterCriteria | null)[];
}

/**
 * Result of an AutoFilter operation.
 */
export interface AutoFilterResult {
  success: boolean;
  autoFilter?: AutoFilterInfo;
  error?: string;
  /** Rows that are now hidden (filtered out) */
  hiddenRows: number[];
  /** Rows that are now visible */
  visibleRows: number[];
}

/**
 * A unique value in a column with its count.
 */
export interface UniqueValue {
  value: string;
  count: number;
}

/**
 * Result of getting unique values for filtering.
 */
export interface UniqueValuesResult {
  success: boolean;
  values: UniqueValue[];
  hasBlanks: boolean;
  error?: string;
}

/**
 * Default filter criteria (no filter).
 */
export const DEFAULT_FILTER_CRITERIA: FilterCriteria = {
  filterOn: "values",
  values: [],
  filterOutBlanks: false,
};

/**
 * Helper to create a values filter criteria.
 */
export function createValuesFilter(
  values: string[],
  includeBlanks: boolean = true
): FilterCriteria {
  const filterValues = includeBlanks ? [...values, "(Blanks)"] : values;
  return {
    filterOn: "values",
    values: filterValues,
    filterOutBlanks: !includeBlanks,
  };
}

/**
 * Helper to create a top N items filter.
 */
export function createTopItemsFilter(count: number): FilterCriteria {
  return {
    filterOn: "topItems",
    criterion1: count.toString(),
    values: [],
    filterOutBlanks: false,
  };
}

/**
 * Helper to create a top N percent filter.
 */
export function createTopPercentFilter(percent: number): FilterCriteria {
  return {
    filterOn: "topPercent",
    criterion1: percent.toString(),
    values: [],
    filterOutBlanks: false,
  };
}

/**
 * Helper to create a bottom N items filter.
 */
export function createBottomItemsFilter(count: number): FilterCriteria {
  return {
    filterOn: "bottomItems",
    criterion1: count.toString(),
    values: [],
    filterOutBlanks: false,
  };
}

/**
 * Helper to create a bottom N percent filter.
 */
export function createBottomPercentFilter(percent: number): FilterCriteria {
  return {
    filterOn: "bottomPercent",
    criterion1: percent.toString(),
    values: [],
    filterOutBlanks: false,
  };
}

/**
 * Helper to create a custom filter with one or two criteria.
 */
export function createCustomFilter(
  criterion1: string,
  criterion2?: string,
  operator: FilterOperator = "and"
): FilterCriteria {
  return {
    filterOn: "custom",
    criterion1,
    criterion2,
    operator,
    values: [],
    filterOutBlanks: false,
  };
}

/**
 * Helper to create a dynamic filter (e.g., above average).
 */
export function createDynamicFilter(
  dynamicCriteria: DynamicFilterCriteria
): FilterCriteria {
  return {
    filterOn: "dynamic",
    dynamicCriteria,
    values: [],
    filterOutBlanks: false,
  };
}