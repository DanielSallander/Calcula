// FILENAME: app/src/hooks/useMouseSelection/types.ts
// PURPOSE: Type definitions for the mouse selection hook and its sub-modules.
// CONTEXT: Contains all interfaces and types used across the useMouseSelection
// module, including configuration, state, props, and return types.

import type { GridConfig, Viewport, Selection, SelectionType, DimensionOverrides } from "../../types";

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
  /** Callback to select a single cell */
  onSelectCell: (row: number, col: number, type?: SelectionType) => void;
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
}

/**
 * Return type for the useMouseSelection hook.
 */
export interface UseMouseSelectionReturn {
  /** Whether a drag selection is in progress */
  isDragging: boolean;
  /** Whether a formula reference drag is in progress */
  isFormulaDragging: boolean;
  /** Whether a resize operation is in progress */
  isResizing: boolean;
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