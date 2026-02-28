//! FILENAME: app/src/core/state/gridReducer.ts
// PURPOSE: Reducer function for grid state management.
// CONTEXT: This module implements the state transition logic for the spreadsheet grid.
// It handles all state updates for selection, viewport scrolling, cell editing, and configuration.
// The reducer ensures immutable state updates and enforces grid boundaries.
// UPDATED: Removed Find actions - Find state now lives in the FindReplaceDialog extension.
// FIX: Skip scroll-to-visible for column/row selections to match Excel behavior.

import type { GridState, Selection, ClipboardMode, GridConfig } from "../types";
import {
  createInitialGridState,
  DEFAULT_VIRTUAL_BOUNDS,
  DEFAULT_VIRTUAL_BOUNDS_CONFIG,
} from "../types";
import type { GridAction } from "./gridActions";
import { GRID_ACTIONS } from "./gridActions";
import {
  clampScroll,
  cellToCenteredScroll,
  scrollToMakeVisible,
  getColumnXPosition,
  getRowYPosition,
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
} from "../lib/scrollUtils";

// Debug logging for viewport tracking
const DEBUG_VIEWPORT = false;

function logViewport(label: string, data: Record<string, unknown>): void {
  if (DEBUG_VIEWPORT) {
    console.log(`[VIEWPORT] ${label}:`, JSON.stringify(data, null, 2));
  }
}

/**
 * Clamp a value between min and max bounds.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate the maximum scroll position for given bounds and viewport.
 */
function calculateMaxScrollForBounds(
  bounds: { maxRow: number; maxCol: number },
  config: {
    defaultCellWidth: number;
    defaultCellHeight: number;
    rowHeaderWidth: number;
    colHeaderHeight: number;
  },
  viewportWidth: number,
  viewportHeight: number
): { maxScrollX: number; maxScrollY: number } {
  const contentWidth = (bounds.maxCol + 1) * config.defaultCellWidth;
  const contentHeight = (bounds.maxRow + 1) * config.defaultCellHeight;

  const availableWidth = Math.max(1, viewportWidth - config.rowHeaderWidth);
  const availableHeight = Math.max(1, viewportHeight - config.colHeaderHeight);

  return {
    maxScrollX: Math.max(0, contentWidth - availableWidth),
    maxScrollY: Math.max(0, contentHeight - availableHeight),
  };
}

/**
 * Calculate expanded virtual bounds if target cell is near or beyond current bounds.
 * Also expands if scroll position is at or near the maximum for current bounds.
 */
function calculateExpandedBounds(
  currentBounds: { maxRow: number; maxCol: number },
  targetRow: number,
  targetCol: number,
  totalRows: number,
  totalCols: number,
  atMaxScrollY: boolean = false,
  atMaxScrollX: boolean = false
): { maxRow: number; maxCol: number } {
  const cfg = DEFAULT_VIRTUAL_BOUNDS_CONFIG;
  let { maxRow, maxCol } = currentBounds;

  // Check if we need to expand rows
  // Expand if: target is near edge OR user has scrolled to maximum position
  if (targetRow >= maxRow - cfg.expansionThreshold || atMaxScrollY) {
    // Expand to include target plus buffer
    const newMaxRow = Math.max(targetRow, maxRow) + cfg.rowBuffer;
    maxRow = Math.min(totalRows - 1, newMaxRow);
  }

  // Check if we need to expand columns
  // Expand if: target is near edge OR user has scrolled to maximum position
  if (targetCol >= maxCol - cfg.expansionThreshold || atMaxScrollX) {
    // Expand to include target plus buffer
    const newMaxCol = Math.max(targetCol, maxCol) + cfg.colBuffer;
    maxCol = Math.min(totalCols - 1, newMaxCol);
  }

  return { maxRow, maxCol };
}

/**
 * Calculate scroll and viewport state from a scroll position.
 * Uses virtual bounds for scroll clamping instead of full grid size.
 */
function calculateScrollState(
  scrollX: number,
  scrollY: number,
  state: GridState,
  dimensions?: { columnWidths: Map<number, number>; rowHeights: Map<number, number> }
): { scrollX: number; scrollY: number; startRow: number; startCol: number } {
  const { config, viewportDimensions, virtualBounds } = state;

  // Use viewport dimensions if available, otherwise estimate from viewport cell count
  const viewportWidth =
    viewportDimensions.width > 0
      ? viewportDimensions.width
      : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
  const viewportHeight =
    viewportDimensions.height > 0
      ? viewportDimensions.height
      : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

  // Create a temporary config with virtual bounds for scroll clamping
  const virtualConfig = {
    ...config,
    totalRows: virtualBounds.maxRow + 1,
    totalCols: virtualBounds.maxCol + 1,
  };

  return clampScroll(
    scrollX,
    scrollY,
    virtualConfig,
    viewportWidth,
    viewportHeight,
    dimensions
  );
}

/**
 * Get viewport dimensions from state with fallback calculation.
 */
function getViewportDimensions(state: GridState): { width: number; height: number } {
  const { config, viewportDimensions, viewport } = state;

  // Ensure we have reasonable defaults
  const defaultWidth = 800;
  const defaultHeight = 600;

  let width = viewportDimensions.width;
  let height = viewportDimensions.height;

  if (width <= 0) {
    width =
      viewport.colCount > 0
        ? viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth
        : defaultWidth;
  }

  if (height <= 0) {
    height =
      viewport.rowCount > 0
        ? viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight
        : defaultHeight;
  }

  return { width, height };
}

/**
 * Calculate scroll position to make a cell visible, using cell coordinates directly.
 * This ensures the viewport scrolls to show the target cell.
 */
function calculateScrollForCell(
  row: number,
  col: number,
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number,
  dimensions?: { columnWidths: Map<number, number>; rowHeights: Map<number, number> }
): { scrollX: number; scrollY: number } {
  // Calculate cell position
  const cellX = getColumnXPosition(col, config, dimensions);
  const cellY = getRowYPosition(row, config, dimensions);

  // Calculate available viewport area (account for headers and scrollbars)
  const SCROLLBAR_SIZE = 17;
  const availableWidth = Math.max(
    1,
    viewportWidth - config.rowHeaderWidth - SCROLLBAR_SIZE
  );
  const availableHeight = Math.max(
    1,
    viewportHeight - config.colHeaderHeight - SCROLLBAR_SIZE
  );

  // Get cell dimensions
  const cellWidth = getColumnWidthFromDimensions(col, config, dimensions);
  const cellHeight = getRowHeightFromDimensions(row, config, dimensions);

  // Calculate scroll position to show the cell
  // For cells near the end, align the cell's right/bottom edge with viewport edge
  // For cells near the start, align the cell's left/top edge with viewport edge
  let scrollX: number;
  let scrollY: number;

  if (cellWidth >= availableWidth) {
    // Cell is wider than viewport - show left edge
    scrollX = cellX;
  } else {
    // Position so cell's right edge is at viewport's right edge
    // This ensures we see the cell when jumping to far columns
    scrollX = Math.max(0, cellX + cellWidth - availableWidth);
  }

  if (cellHeight >= availableHeight) {
    // Cell is taller than viewport - show top edge
    scrollY = cellY;
  } else {
    // Position so cell's bottom edge is at viewport's bottom edge
    // This ensures we see the cell when jumping to far rows
    scrollY = Math.max(0, cellY + cellHeight - availableHeight);
  }

  logViewport("calculateScrollForCell", {
    targetCell: { row, col },
    cellPosition: { cellX, cellY },
    cellSize: { cellWidth, cellHeight },
    viewportArea: { availableWidth, availableHeight },
    calculatedScroll: { scrollX, scrollY },
  });

  return { scrollX, scrollY };
}

/**
 * Check if a cell is visible within the current viewport.
 */
function isCellInViewport(
  row: number,
  col: number,
  viewport: { scrollX: number; scrollY: number },
  config: GridConfig,
  viewportWidth: number,
  viewportHeight: number,
  dimensions?: { columnWidths: Map<number, number>; rowHeights: Map<number, number> }
): boolean {
  const SCROLLBAR_SIZE = 17;

  const cellX = getColumnXPosition(col, config, dimensions);
  const cellY = getRowYPosition(row, config, dimensions);
  const cellWidth = getColumnWidthFromDimensions(col, config, dimensions);
  const cellHeight = getRowHeightFromDimensions(row, config, dimensions);

  const viewLeft = viewport.scrollX;
  const viewTop = viewport.scrollY;
  const viewRight = viewLeft + viewportWidth - config.rowHeaderWidth - SCROLLBAR_SIZE;
  const viewBottom = viewTop + viewportHeight - config.colHeaderHeight - SCROLLBAR_SIZE;

  // Check if cell is fully visible
  const isVisible =
    cellX >= viewLeft &&
    cellX + cellWidth <= viewRight &&
    cellY >= viewTop &&
    cellY + cellHeight <= viewBottom;

  return isVisible;
}

/**
 * Grid state reducer - handles all state transitions.
 */
export function gridReducer(state: GridState, action: GridAction): GridState {
  switch (action.type) {
    case GRID_ACTIONS.SET_SELECTION: {
      const { startRow, startCol, endRow, endCol, type } = action.payload;
      const maxRow = state.config.totalRows - 1;
      const maxCol = state.config.totalCols - 1;

      const clampedSelection: Selection = {
        startRow: clamp(startRow, 0, maxRow),
        startCol: clamp(startCol, 0, maxCol),
        endRow: clamp(endRow, 0, maxRow),
        endCol: clamp(endCol, 0, maxCol),
        type: type || "cells",
      };

      // FIX: For column/row selections, do NOT expand virtual bounds to include the full range.
      // This matches Excel behavior where selecting a column doesn't expand the used range.
      // Only expand bounds for regular cell selections.
      let newBounds = state.virtualBounds;
      if (type !== "columns" && type !== "rows") {
        newBounds = calculateExpandedBounds(
          state.virtualBounds,
          Math.max(clampedSelection.startRow, clampedSelection.endRow),
          Math.max(clampedSelection.startCol, clampedSelection.endCol),
          state.config.totalRows,
          state.config.totalCols
        );
      }

      // FIX: For column/row selections, do NOT scroll to make the "active cell" visible.
      // In Excel, selecting column B does NOT scroll to the bottom of the sheet.
      // Only perform scroll-to-visible for regular cell selections.
      // Also skip scroll for "select all" (entire sheet selected) - viewport should stay put.
      const isSelectAll = clampedSelection.startRow === 0 && clampedSelection.startCol === 0
        && clampedSelection.endRow === maxRow && clampedSelection.endCol === maxCol;
      if (type === "columns" || type === "rows" || isSelectAll) {
        return {
          ...state,
          selection: clampedSelection,
          virtualBounds: newBounds,
        };
      }

      // --- SCROLL LOGIC START (only for regular cell selections) ---
      // Ensure the active cell (endRow, endCol) is visible
      const activeRow = clampedSelection.endRow;
      const activeCol = clampedSelection.endCol;
      const dims = getViewportDimensions(state);

      // Check if the cell is currently visible
      const cellCurrentlyVisible = isCellInViewport(
        activeRow,
        activeCol,
        state.viewport,
        state.config,
        dims.width,
        dims.height,
        state.dimensions
      );

      let newViewport = state.viewport;

      // If not visible, scroll to it
      if (!cellCurrentlyVisible) {
        logViewport("SET_SELECTION ensuring visibility", {
          activeCell: { activeRow, activeCol },
          currentlyVisible: cellCurrentlyVisible,
        });

        // Try standard make visible
        let scrollResult = scrollToMakeVisible(
          activeRow,
          activeCol,
          state.viewport,
          state.config,
          dims.width,
          dims.height,
          state.dimensions
        );

        // If standard check failed (e.g. large jump or logic quirk), force calculation
        if (!scrollResult) {
          scrollResult = calculateScrollForCell(
            activeRow,
            activeCol,
            state.config,
            dims.width,
            dims.height,
            state.dimensions
          );
        }

        if (scrollResult) {
          // Calculate new scroll state with the updated bounds
          const scrollState = calculateScrollState(
            scrollResult.scrollX,
            scrollResult.scrollY,
            { ...state, virtualBounds: newBounds },
            state.dimensions
          );

          newViewport = {
            ...state.viewport,
            scrollX: scrollState.scrollX,
            scrollY: scrollState.scrollY,
            startRow: scrollState.startRow,
            startCol: scrollState.startCol,
          };
        }
      }
      // --- SCROLL LOGIC END ---

      return {
        ...state,
        selection: clampedSelection,
        virtualBounds: newBounds,
        viewport: newViewport,
      };
    }

    case GRID_ACTIONS.ADD_TO_SELECTION: {
      const { row, col, endRow: payloadEndRow, endCol: payloadEndCol } = action.payload;
      const maxRow = state.config.totalRows - 1;
      const maxCol = state.config.totalCols - 1;

      // Accumulate all previous ranges (existing additional + current main selection)
      const previousRanges: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }> = [];
      if (state.selection) {
        if (state.selection.additionalRanges) {
          previousRanges.push(...state.selection.additionalRanges);
        }
        previousRanges.push({
          startRow: state.selection.startRow,
          startCol: state.selection.startCol,
          endRow: state.selection.endRow,
          endCol: state.selection.endCol,
        });
      }

      const newSelection: Selection = {
        startRow: clamp(row, 0, maxRow),
        startCol: clamp(col, 0, maxCol),
        endRow: clamp(payloadEndRow ?? row, 0, maxRow),
        endCol: clamp(payloadEndCol ?? col, 0, maxCol),
        type: "cells",
        additionalRanges: previousRanges.length > 0 ? previousRanges : undefined,
      };

      return {
        ...state,
        selection: newSelection,
      };
    }

    case GRID_ACTIONS.CLEAR_SELECTION: {
      return {
        ...state,
        selection: null,
      };
    }

    case GRID_ACTIONS.EXTEND_SELECTION: {
      if (!state.selection) {
        return state;
      }

      const { row, col } = action.payload;
      const maxRow = state.config.totalRows - 1;
      const maxCol = state.config.totalCols - 1;

      const clampedRow = clamp(row, 0, maxRow);
      const clampedCol = clamp(col, 0, maxCol);

      // FIX: For column/row selections, do NOT expand virtual bounds
      let newBounds = state.virtualBounds;
      if (state.selection.type !== "columns" && state.selection.type !== "rows") {
        newBounds = calculateExpandedBounds(
          state.virtualBounds,
          Math.max(state.selection.startRow, clampedRow),
          Math.max(state.selection.startCol, clampedCol),
          state.config.totalRows,
          state.config.totalCols
        );
      }

      return {
        ...state,
        selection: {
          ...state.selection,
          endRow: clampedRow,
          endCol: clampedCol,
        },
        virtualBounds: newBounds,
      };
    }

    case GRID_ACTIONS.MOVE_SELECTION: {
      const { deltaRow, deltaCol, extend } = action.payload;
      const { config, dimensions } = state;
      const maxRow = config.totalRows - 1;
      const maxCol = config.totalCols - 1;

      logViewport("MOVE_SELECTION start", {
        deltaRow,
        deltaCol,
        extend,
        currentSelection: state.selection,
        currentViewport: {
          scrollX: state.viewport.scrollX,
          scrollY: state.viewport.scrollY,
          startRow: state.viewport.startRow,
          startCol: state.viewport.startCol,
        },
      });

      if (!state.selection) {
        // If no selection, start at origin
        return {
          ...state,
          selection: {
            startRow: 0,
            startCol: 0,
            endRow: 0,
            endCol: 0,
            type: "cells",
          },
        };
      }

      let newSelection: Selection;
      if (extend) {
        // Extend the selection range
        const newEndRow = clamp(state.selection.endRow + deltaRow, 0, maxRow);
        const newEndCol = clamp(state.selection.endCol + deltaCol, 0, maxCol);

        newSelection = {
          ...state.selection,
          endRow: newEndRow,
          endCol: newEndCol,
        };
      } else {
        // Move the entire selection
        const newRow = clamp(state.selection.endRow + deltaRow, 0, maxRow);
        const newCol = clamp(state.selection.endCol + deltaCol, 0, maxCol);

        newSelection = {
          startRow: newRow,
          startCol: newCol,
          endRow: newRow,
          endCol: newCol,
          type: "cells",
        };
      }

      // The active cell is always the end of the selection
      const activeRow = newSelection.endRow;
      const activeCol = newSelection.endCol;

      logViewport("MOVE_SELECTION new selection", {
        newSelection,
        activeCell: { activeRow, activeCol },
      });

      // Expand virtual bounds to include target cell
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        Math.max(newSelection.startRow, newSelection.endRow),
        Math.max(newSelection.startCol, newSelection.endCol),
        config.totalRows,
        config.totalCols
      );

      logViewport("MOVE_SELECTION expanded bounds", {
        oldBounds: state.virtualBounds,
        newBounds,
      });

      // Get viewport dimensions for scroll calculations
      const dims = getViewportDimensions(state);

      logViewport("MOVE_SELECTION viewport dimensions", dims);

      // Check if this is a large jump (Ctrl+Arrow or similar)
      const isLargeJump = Math.abs(deltaRow) > 1 || Math.abs(deltaCol) > 1;

      // Check if the cell is currently visible
      const cellCurrentlyVisible = isCellInViewport(
        activeRow,
        activeCol,
        state.viewport,
        config,
        dims.width,
        dims.height,
        dimensions
      );

      logViewport("MOVE_SELECTION visibility check", {
        isLargeJump,
        cellCurrentlyVisible,
      });

      // Try to calculate scroll to make the new active cell visible
      let scrollResult = scrollToMakeVisible(
        activeRow,
        activeCol,
        state.viewport,
        config,
        dims.width,
        dims.height,
        dimensions
      );

      logViewport("MOVE_SELECTION scrollToMakeVisible result", {
        scrollResult,
      });

      // For large jumps or if scrollToMakeVisible returned null but cell isn't visible,
      // force calculate the scroll position
      if (!scrollResult && (isLargeJump || !cellCurrentlyVisible)) {
        logViewport("MOVE_SELECTION forcing scroll calculation", {
          reason: isLargeJump ? "large jump" : "cell not visible",
        });

        scrollResult = calculateScrollForCell(
          activeRow,
          activeCol,
          config,
          dims.width,
          dims.height,
          dimensions
        );
      }

      if (!scrollResult) {
        // Cell is already visible, just update selection and bounds
        logViewport("MOVE_SELECTION no scroll needed", {
          finalSelection: newSelection,
        });

        return {
          ...state,
          selection: newSelection,
          virtualBounds: newBounds,
        };
      }

      // Need to scroll - calculate new scroll state with updated bounds
      const stateWithNewBounds = {
        ...state,
        virtualBounds: newBounds,
      };

      const scrollState = calculateScrollState(
        scrollResult.scrollX,
        scrollResult.scrollY,
        stateWithNewBounds,
        dimensions
      );

      logViewport("MOVE_SELECTION final scroll state", {
        requestedScroll: scrollResult,
        clampedScroll: scrollState,
        finalSelection: newSelection,
      });

      return {
        ...state,
        selection: newSelection,
        virtualBounds: newBounds,
        viewport: {
          ...state.viewport,
          scrollX: scrollState.scrollX,
          scrollY: scrollState.scrollY,
          startRow: scrollState.startRow,
          startCol: scrollState.startCol,
        },
      };
    }

    case GRID_ACTIONS.SET_VIEWPORT: {
      return {
        ...state,
        viewport: action.payload,
      };
    }

    case GRID_ACTIONS.UPDATE_SCROLL: {
      const { scrollX, scrollY } = action.payload;

      const { config, virtualBounds, viewportDimensions } = state;

      // Get viewport dimensions (with fallback)
      const viewportWidth =
        viewportDimensions.width > 0
          ? viewportDimensions.width
          : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
      const viewportHeight =
        viewportDimensions.height > 0
          ? viewportDimensions.height
          : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

      // Calculate maximum scroll positions for current bounds
      const maxScroll = calculateMaxScrollForBounds(
        virtualBounds,
        config,
        viewportWidth,
        viewportHeight
      );

      // Detect if user is at or very near the maximum scroll position
      // Use a threshold of 2 pixels to account for rounding
      const scrollThreshold = 2;
      const atMaxScrollY =
        scrollY >= maxScroll.maxScrollY - scrollThreshold && maxScroll.maxScrollY > 0;
      const atMaxScrollX =
        scrollX >= maxScroll.maxScrollX - scrollThreshold && maxScroll.maxScrollX > 0;

      // Calculate visible row/column based on scroll position
      const visibleRows = Math.ceil(viewportHeight / config.defaultCellHeight);
      const visibleCols = Math.ceil(viewportWidth / config.defaultCellWidth);

      const currentEndRow = Math.floor(scrollY / config.defaultCellHeight) + visibleRows;
      const currentEndCol = Math.floor(scrollX / config.defaultCellWidth) + visibleCols;

      // Expand bounds if scrolling near edge OR at maximum scroll position
      const newBounds = calculateExpandedBounds(
        virtualBounds,
        currentEndRow,
        currentEndCol,
        config.totalRows,
        config.totalCols,
        atMaxScrollY,
        atMaxScrollX
      );

      const scrollState = calculateScrollState(
        scrollX,
        scrollY,
        {
          ...state,
          virtualBounds: newBounds,
        },
        state.dimensions
      );

      return {
        ...state,
        viewport: {
          ...state.viewport,
          scrollX: scrollState.scrollX,
          scrollY: scrollState.scrollY,
          startRow: scrollState.startRow,
          startCol: scrollState.startCol,
        },
        virtualBounds: newBounds,
      };
    }

    case GRID_ACTIONS.SCROLL_BY: {
      const { deltaX, deltaY } = action.payload;
      const newScrollX = state.viewport.scrollX + deltaX;
      const newScrollY = state.viewport.scrollY + deltaY;

      const { config, virtualBounds, viewportDimensions } = state;

      // Get viewport dimensions (with fallback)
      const viewportWidth =
        viewportDimensions.width > 0
          ? viewportDimensions.width
          : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
      const viewportHeight =
        viewportDimensions.height > 0
          ? viewportDimensions.height
          : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

      // Calculate maximum scroll positions for current bounds
      const maxScroll = calculateMaxScrollForBounds(
        virtualBounds,
        config,
        viewportWidth,
        viewportHeight
      );

      // Detect if scroll delta would push us to the max
      const scrollThreshold = 2;
      const atMaxScrollY =
        newScrollY >= maxScroll.maxScrollY - scrollThreshold && maxScroll.maxScrollY > 0;
      const atMaxScrollX =
        newScrollX >= maxScroll.maxScrollX - scrollThreshold && maxScroll.maxScrollX > 0;

      const visibleRows = Math.ceil(viewportHeight / config.defaultCellHeight);
      const visibleCols = Math.ceil(viewportWidth / config.defaultCellWidth);

      const currentEndRow = Math.floor(newScrollY / config.defaultCellHeight) + visibleRows;
      const currentEndCol = Math.floor(newScrollX / config.defaultCellWidth) + visibleCols;

      // Expand bounds if scrolling near edge OR at maximum scroll position
      const newBounds = calculateExpandedBounds(
        virtualBounds,
        currentEndRow,
        currentEndCol,
        config.totalRows,
        config.totalCols,
        atMaxScrollY,
        atMaxScrollX
      );

      const scrollState = calculateScrollState(
        newScrollX,
        newScrollY,
        {
          ...state,
          virtualBounds: newBounds,
        },
        state.dimensions
      );

      return {
        ...state,
        viewport: {
          ...state.viewport,
          scrollX: scrollState.scrollX,
          scrollY: scrollState.scrollY,
          startRow: scrollState.startRow,
          startCol: scrollState.startCol,
        },
        virtualBounds: newBounds,
      };
    }

    case GRID_ACTIONS.SCROLL_TO_CELL: {
      const { row, col, center } = action.payload;
      const { config, viewportDimensions, dimensions } = state;

      // Expand virtual bounds to include target cell
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        row,
        col,
        config.totalRows,
        config.totalCols
      );

      // Get viewport dimensions
      const viewportWidth =
        viewportDimensions.width > 0
          ? viewportDimensions.width
          : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
      const viewportHeight =
        viewportDimensions.height > 0
          ? viewportDimensions.height
          : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

      let targetScroll;
      if (center) {
        // Center the cell in viewport
        targetScroll = cellToCenteredScroll(
          row,
          col,
          config,
          viewportWidth,
          viewportHeight,
          dimensions
        );
      } else {
        // Scroll just enough to make cell visible (with dimension support)
        const makeVisible = scrollToMakeVisible(
          row,
          col,
          state.viewport,
          config,
          viewportWidth,
          viewportHeight,
          dimensions // Pass dimension overrides
        );
        if (!makeVisible) {
          // Cell already visible, just update bounds if needed
          if (
            newBounds.maxRow !== state.virtualBounds.maxRow ||
            newBounds.maxCol !== state.virtualBounds.maxCol
          ) {
            return {
              ...state,
              virtualBounds: newBounds,
            };
          }
          return state;
        }
        targetScroll = makeVisible;
      }

      const scrollState = calculateScrollState(
        targetScroll.scrollX,
        targetScroll.scrollY,
        {
          ...state,
          virtualBounds: newBounds,
        },
        dimensions
      );

      return {
        ...state,
        viewport: {
          ...state.viewport,
          scrollX: scrollState.scrollX,
          scrollY: scrollState.scrollY,
          startRow: scrollState.startRow,
          startCol: scrollState.startCol,
        },
        virtualBounds: newBounds,
      };
    }

    case GRID_ACTIONS.SCROLL_TO_POSITION: {
      const { scrollX, scrollY } = action.payload;
      const scrollState = calculateScrollState(scrollX, scrollY, state, state.dimensions);

      return {
        ...state,
        viewport: {
          ...state.viewport,
          scrollX: scrollState.scrollX,
          scrollY: scrollState.scrollY,
          startRow: scrollState.startRow,
          startCol: scrollState.startCol,
        },
      };
    }

    case GRID_ACTIONS.START_EDITING: {
      return {
        ...state,
        editing: action.payload,
      };
    }

    case GRID_ACTIONS.UPDATE_EDITING: {
      if (!state.editing) {
        return state;
      }

      return {
        ...state,
        editing: {
          ...state.editing,
          value: action.payload.value,
        },
      };
    }

    case GRID_ACTIONS.STOP_EDITING: {
      return {
        ...state,
        editing: null,
        formulaReferences: [],
      };
    }

    case GRID_ACTIONS.UPDATE_CONFIG: {
      return {
        ...state,
        config: {
          ...state.config,
          ...action.payload,
        },
      };
    }

    case GRID_ACTIONS.SET_VIEWPORT_SIZE: {
      const { rowCount, colCount } = action.payload;

      return {
        ...state,
        viewport: {
          ...state.viewport,
          rowCount,
          colCount,
        },
      };
    }

    case GRID_ACTIONS.SET_VIEWPORT_DIMENSIONS: {
      return {
        ...state,
        viewportDimensions: action.payload,
      };
    }

    case GRID_ACTIONS.EXPAND_VIRTUAL_BOUNDS: {
      const { targetRow, targetCol } = action.payload;
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        targetRow,
        targetCol,
        state.config.totalRows,
        state.config.totalCols
      );

      return {
        ...state,
        virtualBounds: newBounds,
      };
    }

    case GRID_ACTIONS.SET_VIRTUAL_BOUNDS: {
      return {
        ...state,
        virtualBounds: action.payload,
      };
    }

    case GRID_ACTIONS.RESET_VIRTUAL_BOUNDS: {
      return {
        ...state,
        virtualBounds: { ...DEFAULT_VIRTUAL_BOUNDS },
      };
    }

    case GRID_ACTIONS.SET_FORMULA_REFERENCES: {
      return {
        ...state,
        formulaReferences: action.payload,
      };
    }

    case GRID_ACTIONS.CLEAR_FORMULA_REFERENCES: {
      return {
        ...state,
        formulaReferences: [],
      };
    }

    case GRID_ACTIONS.SET_COLUMN_WIDTH: {
      const { col, width } = action.payload;
      const newColumnWidths = new Map(state.dimensions.columnWidths);
      if (width > 0) {
        newColumnWidths.set(col, width);
      } else {
        newColumnWidths.delete(col);
      }
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          columnWidths: newColumnWidths,
        },
      };
    }

    case GRID_ACTIONS.SET_ROW_HEIGHT: {
      const { row, height } = action.payload;
      const newRowHeights = new Map(state.dimensions.rowHeights);
      if (height > 0) {
        newRowHeights.set(row, height);
      } else {
        newRowHeights.delete(row);
      }
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          rowHeights: newRowHeights,
        },
      };
    }

    case GRID_ACTIONS.SET_ALL_DIMENSIONS: {
      return {
        ...state,
        dimensions: {
          columnWidths: action.payload.columnWidths,
          rowHeights: action.payload.rowHeights,
        },
      };
    }

    case GRID_ACTIONS.SET_CLIPBOARD: {
      const { mode, selection, sourceSheetIndex } = action.payload as {
        mode: ClipboardMode;
        selection: Selection | null;
        sourceSheetIndex?: number;
      };
      return {
        ...state,
        clipboard: {
          mode,
          selection,
          sourceSheetIndex: sourceSheetIndex ?? state.sheetContext.activeSheetIndex,
        },
      };
    }

    case GRID_ACTIONS.CLEAR_CLIPBOARD: {
      return {
        ...state,
        clipboard: {
          mode: "none",
          selection: null,
          sourceSheetIndex: null,
        },
      };
    }

    case GRID_ACTIONS.SET_SHEET_CONTEXT: {
      return {
        ...state,
        sheetContext: action.payload,
      };
    }

    case GRID_ACTIONS.SET_ACTIVE_SHEET: {
      const { index, name } = action.payload;
      return {
        ...state,
        sheetContext: {
          activeSheetIndex: index,
          activeSheetName: name,
        },
      };
    }

    case GRID_ACTIONS.SET_FREEZE_CONFIG: {
      return {
        ...state,
        freezeConfig: action.payload,
      };
    }

    case GRID_ACTIONS.SET_HIDDEN_ROWS: {
      // Union filter-hidden rows with manually-hidden rows
      const filterHiddenRows = new Set(action.payload.rows);
      const manuallyHidden = state.dimensions.manuallyHiddenRows ?? new Set<number>();
      const combinedHidden = new Set([...filterHiddenRows, ...manuallyHidden]);
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          hiddenRows: combinedHidden,
        },
      };
    }

    case GRID_ACTIONS.SET_HIDDEN_COLS: {
      const hiddenCols = new Set(action.payload.cols);
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          hiddenCols,
        },
      };
    }

    case GRID_ACTIONS.SET_MANUALLY_HIDDEN_ROWS: {
      const manuallyHiddenRows = new Set(action.payload.rows);
      // Derive filter-hidden rows: old hiddenRows minus old manuallyHiddenRows minus old groupHiddenRows
      const oldManual = state.dimensions.manuallyHiddenRows ?? new Set<number>();
      const oldGroup = state.dimensions.groupHiddenRows ?? new Set<number>();
      const oldHidden = state.dimensions.hiddenRows ?? new Set<number>();
      const filterHidden = new Set<number>();
      oldHidden.forEach((r) => {
        if (!oldManual.has(r) && !oldGroup.has(r)) filterHidden.add(r);
      });
      // Recompute combined: filter + new manual + group
      const hiddenRows = new Set([...filterHidden, ...manuallyHiddenRows, ...oldGroup]);
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          manuallyHiddenRows,
          hiddenRows,
        },
      };
    }

    case GRID_ACTIONS.SET_MANUALLY_HIDDEN_COLS: {
      const manuallyHiddenCols = new Set(action.payload.cols);
      // hiddenCols = manuallyHiddenCols ∪ groupHiddenCols
      const groupHiddenColsForManual = state.dimensions.groupHiddenCols ?? new Set<number>();
      const hiddenColsForManual = new Set([...manuallyHiddenCols, ...groupHiddenColsForManual]);
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          manuallyHiddenCols,
          hiddenCols: hiddenColsForManual,
        },
      };
    }

    case GRID_ACTIONS.SET_GROUP_HIDDEN_ROWS: {
      const groupHiddenRows = new Set(action.payload.rows);
      // Combined hiddenRows = filterHidden ∪ manuallyHidden ∪ groupHidden
      // Derive filter-hidden: old hiddenRows minus old manuallyHiddenRows minus old groupHiddenRows
      const oldManualRows = state.dimensions.manuallyHiddenRows ?? new Set<number>();
      const oldGroupRows = state.dimensions.groupHiddenRows ?? new Set<number>();
      const oldHiddenRows = state.dimensions.hiddenRows ?? new Set<number>();
      const filterHiddenRows = new Set<number>();
      oldHiddenRows.forEach((r) => {
        if (!oldManualRows.has(r) && !oldGroupRows.has(r)) filterHiddenRows.add(r);
      });
      const combinedHiddenRows = new Set([...filterHiddenRows, ...oldManualRows, ...groupHiddenRows]);
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          groupHiddenRows,
          hiddenRows: combinedHiddenRows,
        },
      };
    }

    case GRID_ACTIONS.SET_GROUP_HIDDEN_COLS: {
      const groupHiddenCols = new Set(action.payload.cols);
      // hiddenCols = manuallyHiddenCols ∪ groupHiddenCols
      const manualColsForGroup = state.dimensions.manuallyHiddenCols ?? new Set<number>();
      const hiddenColsForGroup = new Set([...manualColsForGroup, ...groupHiddenCols]);
      return {
        ...state,
        dimensions: {
          ...state.dimensions,
          groupHiddenCols,
          hiddenCols: hiddenColsForGroup,
        },
      };
    }

    default: {
      return state;
    }
  }
}

/**
 * Create the initial state for the grid reducer.
 */
export function getInitialState(): GridState {
  return createInitialGridState();
}