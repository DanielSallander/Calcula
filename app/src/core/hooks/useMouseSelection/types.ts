//! FILENAME: app/src/core/hooks/useMouseSelection/types.ts
// PURPOSE: Type definitions for the mouse selection hook and its sub-modules.
// CONTEXT: Contains all interfaces and types used across the useMouseSelection
// module, including configuration, state, props, and return types.

import type { GridConfig, Viewport, Selection, SelectionType, DimensionOverrides, FormulaReference } from "../../types";
import type { ReferenceCorner } from "../../lib/gridRenderer";

/**
 * Configuration for auto-scroll behavior during drag selection.
 */
export interface AutoScrollConfig {
  /** Distance from edge in pixels to trigger auto-scroll */
  edgeThreshold: number;
  /** Base scroll speed in pixels per frame */
  baseSpeed: number;
  /** Maximum scroll speed multiplier */
  maxSpeedMultiplier: number;
  /** Interval in milliseconds between auto-scroll updates */
  intervalMs: number;
}

/**
 * Resize operation state.
 */
export interface ResizeState {
  type: "column" | "row";
  index: number;
  startPos: number;
  startSize: number;
}

/**
 * Header drag state for column/row selection.
 */
export interface HeaderDragState {
  type: "column" | "row";
  startIndex: number;
}

/**
 * Formula header drag state for column/row reference insertion.
 */
export interface FormulaHeaderDragState {
  type: "column" | "row";
  index: number;
}

/**
 * Selection drag state for moving cells, rows, or columns.
 */
export interface SelectionDragState {
  /** The original selection being dragged */
  sourceSelection: Selection;
  /** Which edge was clicked to start the drag */
  dragHandle: "top" | "right" | "bottom" | "left";
  /** Current target row (top-left of where selection would land) */
  targetRow: number;
  /** Current target column (top-left of where selection would land) */
  targetCol: number;
  /** Offset from mouse position to selection top-left (for smooth dragging) */
  offsetRow: number;
  /** Offset from mouse position to selection top-left (for smooth dragging) */
  offsetCol: number;
}

/**
 * Cell position reference.
 */
export interface CellPosition {
  row: number;
  col: number;
}

/**
 * Mouse position reference.
 */
export interface MousePosition {
  x: number;
  y: number;
}

/**
 * Scroll delta for auto-scroll calculation.
 */
export interface ScrollDelta {
  deltaX: number;
  deltaY: number;
}

/**
 * Props for the useMouseSelection hook.
 */
export interface UseMouseSelectionProps {
  /** Reference to the container element for bounds calculation */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Reference to the scroll container element */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Grid configuration */
  config: GridConfig;
  /** Current viewport state */
  viewport: Viewport;
  /** Current selection */
  selection: Selection | null;
  /** Current dimension overrides */
  dimensions?: DimensionOverrides;
  /** Whether currently in formula editing mode expecting a reference */
  isFormulaMode?: boolean;
  /** Current formula references for hit testing borders */
  formulaReferences?: FormulaReference[];
  /** Current sheet name for cross-sheet reference matching */
  currentSheetName?: string;
  /** Sheet where the formula is being edited */
  formulaSourceSheetName?: string;
  /** Callback to select a single cell (or range if endRow/endCol provided) */
  onSelectCell: (row: number, col: number, type?: SelectionType, endRow?: number, endCol?: number) => void;
  /** Callback to extend selection to a cell */
  onExtendTo: (row: number, col: number) => void;
  /** Callback when scroll position should change */
  onScroll: (scrollX: number, scrollY: number) => void;
  /** Callback when selection drag ends */
  onDragEnd?: () => void;
  /** Callback to insert a cell reference (formula mode) */
  onInsertReference?: (row: number, col: number) => void;
  /** Callback to insert a range reference (formula mode) */
  onInsertRangeReference?: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  /** Callback to insert a column reference (formula mode) */
  onInsertColumnReference?: (col: number) => void;
  /** Callback to insert a column range reference (formula mode) */
  onInsertColumnRangeReference?: (startCol: number, endCol: number) => void;
  /** Callback to insert a row reference (formula mode) */
  onInsertRowReference?: (row: number) => void;
  /** Callback to insert a row range reference (formula mode) */
  onInsertRowRangeReference?: (startRow: number, endRow: number) => void;
  /** Callback to update pending reference during drag (formula mode) */
  onUpdatePendingReference?: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  /** Callback to update pending column reference during drag (formula mode) */
  onUpdatePendingColumnReference?: (startCol: number, endCol: number) => void;
  /** Callback to update pending row reference during drag (formula mode) */
  onUpdatePendingRowReference?: (startRow: number, endRow: number) => void;
  /** Callback to clear pending reference */
  onClearPendingReference?: () => void;
  /** Callback to commit current edit before selecting new cell */
  onCommitBeforeSelect?: () => Promise<void>;
  /** Callback when column width changes */
  onColumnResize?: (col: number, width: number) => void;
  /** Callback when row height changes */
  onRowResize?: (row: number, height: number) => void;
  /** Callback to select entire column */
  onSelectColumn?: (col: number, extend?: boolean) => void;
  /** Callback to select entire row */
  onSelectRow?: (row: number, extend?: boolean) => void;
  /** Callback when fill handle is double-clicked (auto-fill to edge) */
  onFillHandleDoubleClick?: () => void;
  /** Callback to start dragging an existing reference (returns true if drag started) */
  onStartRefDrag?: (row: number, col: number) => boolean;
  /** Callback to update reference position during drag */
  onUpdateRefDrag?: (row: number, col: number) => void;
  /** Callback to complete reference drag */
  onCompleteRefDrag?: (row: number, col: number) => void;
  /** Callback to cancel reference drag */
  onCancelRefDrag?: () => void;
  /** Callback to start resizing an existing reference by a corner handle (returns true if resize started) */
  onStartRefResize?: (row: number, col: number, corner: ReferenceCorner) => boolean;
  /** Callback to update reference bounds during resize */
  onUpdateRefResize?: (row: number, col: number) => void;
  /** Callback to complete reference resize */
  onCompleteRefResize?: (row: number, col: number) => void;
  /** Callback to cancel reference resize */
  onCancelRefResize?: () => void;
  /** Callback to move cells to a new position */
  onMoveCells?: (source: Selection, targetRow: number, targetCol: number) => Promise<void>;
  /** Callback to reorder rows (structural move) */
  onMoveRows?: (sourceStartRow: number, sourceEndRow: number, targetRow: number) => Promise<void>;
  /** Callback to reorder columns (structural move) */
  onMoveColumns?: (sourceStartCol: number, sourceEndCol: number, targetCol: number) => Promise<void>;
}

/**
 * Return type for the useMouseSelection hook.
 */
export interface UseMouseSelectionReturn {
  /** Whether a drag selection is in progress */
  isDragging: boolean;
  /** Whether a formula reference drag is in progress (adding new references) */
  isFormulaDragging: boolean;
  /** Whether a resize operation is in progress */
  isResizing: boolean;
  /** Whether an existing reference is being dragged to move it */
  isRefDragging: boolean;
  /** Whether an existing reference is being resized via corner handle */
  isRefResizing: boolean;
  /** Whether a selection is being dragged to move cells */
  isSelectionDragging: boolean;
  /** Whether an overlay region (table) is being resized */
  isOverlayResizing: boolean;
  /** Preview selection showing where cells would land during drag */
  selectionDragPreview: Selection | null;
  /** Current cursor style to use */
  cursorStyle: string;
  /** Handle mouse down on the grid */
  handleMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  /** Handle mouse move on the grid */
  handleMouseMove: (event: React.MouseEvent<HTMLElement>) => void;
  /** Handle mouse up on the grid */
  handleMouseUp: () => void;
  /** Handle double-click on the grid */
  handleDoubleClick: (event: React.MouseEvent<HTMLElement>) => { row: number; col: number } | null;
}

/**
 * Shared refs used across mouse selection handlers.
 */
export interface MouseSelectionRefs {
  autoScrollRef: React.MutableRefObject<number | null>;
  lastMousePosRef: React.MutableRefObject<MousePosition | null>;
  dragStartRef: React.MutableRefObject<CellPosition | null>;
  formulaDragStartRef: React.MutableRefObject<CellPosition | null>;
  formulaHeaderDragStartRef: React.MutableRefObject<FormulaHeaderDragState | null>;
  resizeStateRef: React.MutableRefObject<ResizeState | null>;
  headerDragRef: React.MutableRefObject<HeaderDragState | null>;
}