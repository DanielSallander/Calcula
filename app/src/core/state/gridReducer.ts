// FILENAME: app/src/state/gridReducer.ts
// PURPOSE: Reducer function for grid state management.
// CONTEXT: This module implements the state transition logic for the spreadsheet grid.
// It handles all state updates for selection, viewport scrolling, cell editing, and configuration.
// The reducer ensures immutable state updates and enforces grid boundaries.

import type { GridState, Selection, ClipboardMode } from "../types";
import { createInitialGridState, DEFAULT_VIRTUAL_BOUNDS, DEFAULT_VIRTUAL_BOUNDS_CONFIG } from "../types";
import type { GridAction } from "./gridActions";
import { GRID_ACTIONS } from "./gridActions";
import { clampScroll, cellToCenteredScroll, scrollToMakeVisible } from "../lib/scrollUtils";

/**
 * Clamp a value between min and max bounds.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate the maximum scroll position for given bounds and viewport.
 */
function calculateMaxScrollForBounds(
  bounds: { maxRow: number; maxCol: number },
  config: { defaultCellWidth: number; defaultCellHeight: number; rowHeaderWidth: number; colHeaderHeight: number },
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
  state: GridState
): { scrollX: number; scrollY: number; startRow: number; startCol: number } {
  const { config, viewportDimensions, virtualBounds } = state;

  // Use viewport dimensions if available, otherwise estimate from viewport cell count
  const viewportWidth = viewportDimensions.width > 0
    ? viewportDimensions.width
    : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
  const viewportHeight = viewportDimensions.height > 0
    ? viewportDimensions.height
    : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

  // Create a temporary config with virtual bounds for scroll clamping
  const virtualConfig = {
    ...config,
    totalRows: virtualBounds.maxRow + 1,
    totalCols: virtualBounds.maxCol + 1,
  };

  return clampScroll(scrollX, scrollY, virtualConfig, viewportWidth, viewportHeight);
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

      // Expand virtual bounds if selection is near edge
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        Math.max(clampedSelection.startRow, clampedSelection.endRow),
        Math.max(clampedSelection.startCol, clampedSelection.endCol),
        state.config.totalRows,
        state.config.totalCols
      );

      return {
        ...state,
        selection: clampedSelection,
        virtualBounds: newBounds,
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

      // Expand virtual bounds if extending near edge
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        Math.max(state.selection.startRow, clampedRow),
        Math.max(state.selection.startCol, clampedCol),
        state.config.totalRows,
        state.config.totalCols
      );

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
      const maxRow = state.config.totalRows - 1;
      const maxCol = state.config.totalCols - 1;

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

      // Expand virtual bounds if moving near edge
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        Math.max(newSelection.startRow, newSelection.endRow),
        Math.max(newSelection.startCol, newSelection.endCol),
        state.config.totalRows,
        state.config.totalCols
      );

      return {
        ...state,
        selection: newSelection,
        virtualBounds: newBounds,
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
      const viewportWidth = viewportDimensions.width > 0 
        ? viewportDimensions.width 
        : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
      const viewportHeight = viewportDimensions.height > 0 
        ? viewportDimensions.height 
        : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

      // Calculate maximum scroll positions for current bounds
      const maxScroll = calculateMaxScrollForBounds(virtualBounds, config, viewportWidth, viewportHeight);

      // Detect if user is at or very near the maximum scroll position
      // Use a threshold of 2 pixels to account for rounding
      const scrollThreshold = 2;
      const atMaxScrollY = scrollY >= maxScroll.maxScrollY - scrollThreshold && maxScroll.maxScrollY > 0;
      const atMaxScrollX = scrollX >= maxScroll.maxScrollX - scrollThreshold && maxScroll.maxScrollX > 0;

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

      const scrollState = calculateScrollState(scrollX, scrollY, {
        ...state,
        virtualBounds: newBounds,
      });

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
      const viewportWidth = viewportDimensions.width > 0 
        ? viewportDimensions.width 
        : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
      const viewportHeight = viewportDimensions.height > 0 
        ? viewportDimensions.height 
        : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

      // Calculate maximum scroll positions for current bounds
      const maxScroll = calculateMaxScrollForBounds(virtualBounds, config, viewportWidth, viewportHeight);

      // Detect if scroll delta would push us to the max
      const scrollThreshold = 2;
      const atMaxScrollY = newScrollY >= maxScroll.maxScrollY - scrollThreshold && maxScroll.maxScrollY > 0;
      const atMaxScrollX = newScrollX >= maxScroll.maxScrollX - scrollThreshold && maxScroll.maxScrollX > 0;

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

      const scrollState = calculateScrollState(newScrollX, newScrollY, {
        ...state,
        virtualBounds: newBounds,
      });

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
      const { config, viewportDimensions } = state;

      // Expand virtual bounds to include target cell
      const newBounds = calculateExpandedBounds(
        state.virtualBounds,
        row,
        col,
        config.totalRows,
        config.totalCols
      );

      // Get viewport dimensions
      const viewportWidth = viewportDimensions.width > 0
        ? viewportDimensions.width
        : state.viewport.colCount * config.defaultCellWidth + config.rowHeaderWidth;
      const viewportHeight = viewportDimensions.height > 0
        ? viewportDimensions.height
        : state.viewport.rowCount * config.defaultCellHeight + config.colHeaderHeight;

      let targetScroll;
      if (center) {
        // Center the cell in viewport
        targetScroll = cellToCenteredScroll(row, col, config, viewportWidth, viewportHeight);
      } else {
        // Scroll just enough to make cell visible
        const makeVisible = scrollToMakeVisible(row, col, state.viewport, config, viewportWidth, viewportHeight);
        if (!makeVisible) {
          // Cell already visible, just update bounds if needed
          if (newBounds.maxRow !== state.virtualBounds.maxRow || newBounds.maxCol !== state.virtualBounds.maxCol) {
            return {
              ...state,
              virtualBounds: newBounds,
            };
          }
          return state;
        }
        targetScroll = makeVisible;
      }

      const scrollState = calculateScrollState(targetScroll.scrollX, targetScroll.scrollY, {
        ...state,
        virtualBounds: newBounds,
      });

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
      const scrollState = calculateScrollState(scrollX, scrollY, state);

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
      const { mode, selection } = action.payload as { mode: ClipboardMode; selection: Selection | null };
      return {
        ...state,
        clipboard: {
          mode,
          selection,
        },
      };
    }

    case GRID_ACTIONS.CLEAR_CLIPBOARD: {
      return {
        ...state,
        clipboard: {
          mode: "none",
          selection: null,
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