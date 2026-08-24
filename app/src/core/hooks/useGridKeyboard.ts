//! FILENAME: app/src/core/hooks/useGridKeyboard.ts
// PURPOSE: Custom hook for handling keyboard navigation in the grid.
// CONTEXT: This hook manages keyboard events for cell navigation including
// arrow keys, Tab, Enter, Page Up/Down, Home, End, modifier combinations,
// clipboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z), DELETE key, and ESC to clear clipboard.
// FIX: Added check for getGlobalIsEditing() to catch editing state synchronously
//      before React state updates, preventing keystrokes from starting new edits.
// FIX: Added DELETE key handler to clear selection contents.
// FIX: Added merge-aware navigation - when landing on a merged cell, expands selection.
// FIX: When navigating FROM a merged cell, calculate target from the edge of the merge
//      in the direction of movement to avoid getting stuck.
// FIX: Preserve entry column/row when exiting merged cells vertically/horizontally.
// FIX: Ctrl+End goes to the last USED cell — the same getUsedRange answer
//      Ctrl+Shift+End extends to — instead of clamping a totalRows/totalCols
//      delta onto XFD1048576; bare End arms Excel's End mode rather than
//      jumping to the sheet's last column.
// FIX: Ctrl+A / Ctrl+Shift+Space / Ctrl+Space / Shift+Space are PROGRESSIVE
//      when the active cell sits inside a grid region that declares how they
//      should narrow. They were four ways of selecting the whole sheet, so an
//      object on the grid was invisible to every selection shortcut.

import { useCallback, useEffect, useRef } from "react";
import { useGridContext } from "../state/GridContext";
import { setSelection } from "../state/gridActions";
import { findCtrlArrowTarget, getMergeInfo, getUsedRange, type ArrowDirection } from "../lib/tauri-api";
import { fnLog, stateLog, eventLog } from '../../utils/component-logger';
import { getGlobalIsEditing } from "./useEditing";
import { handleCellTypeKeyDown } from "../../api/cellTypes";
import { getGridRegions } from "../../api/gridOverlays";

/**
 * Options for the useGridKeyboard hook.
 */
interface UseGridKeyboardOptions {
  /** Reference to the container element for event attachment */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Callback when selection changes (for scroll-into-view) */
  onSelectionChange?: () => void;
  /** Whether keyboard handling is enabled */
  enabled?: boolean;
  /** Whether editing is active (if true, skip navigation) */
  isEditing?: boolean;
  /** Callback for clearing clipboard (ESC key) */
  onClearClipboard?: () => void;
  /** Whether clipboard has content (for ESC handling) */
  hasClipboardContent?: boolean;
  /** Callback for delete/clear contents operation */
  onDelete?: () => Promise<void>;
  /** Callback for selecting an entire column (Ctrl+Space) */
  onSelectColumn?: (col: number) => void;
  /** Callback for selecting an entire row (Shift+Space) */
  onSelectRow?: (row: number) => void;
  /** Callback for executing a named command (formatting, fill, etc.) */
  onCommand?: (command: string) => Promise<void>;
}

/**
 * MODULE-LEVEL state for F8 "Extend Mode".
 * When active, arrow keys extend the selection without holding Shift.
 * Deactivated by pressing F8 again or Escape.
 */
let extendModeActive = false;

/** Get the current extend mode state. */
export function getExtendMode(): boolean {
  return extendModeActive;
}

/** Set the extend mode state. */
export function setExtendMode(value: boolean): void {
  extendModeActive = value;
}

/**
 * MODULE-LEVEL state for Excel's "End mode" (the bare End key).
 * Armed by End and spent by the very next key: an arrow then jumps to the edge
 * of the data the way Ctrl+Arrow does, Home goes to the last used cell, and
 * anything else merely cancels it.
 *
 * Bare End used to travel `deltaCol = config.totalCols` and land on column XFD
 * — a place no user asked to go, and one the sheet's own data never reaches.
 */
let endModeActive = false;

/**
 * Read and clear End mode from outside the keydown path — the pair extend mode
 * already needs: `getExtendMode` feeds the status bar's mode indicator and
 * `useEditing` calls `setExtendMode(false)` when an edit begins. The flag is
 * module-level, so it outlives any one grid instance and must be clearable.
 */
export function getEndMode(): boolean {
  return endModeActive;
}

/** Set the End mode state. */
export function setEndMode(value: boolean): void {
  endModeActive = value;
}

/**
 * Keys that are not "the next key" for End mode: a keydown fires for the
 * modifier itself, so treating Shift as a keypress would disarm End mode
 * between End and Shift+ArrowDown — the extend gesture Excel supports.
 */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

/**
 * Clamp a value between min and max bounds.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// Region-scoped selection (Ctrl+Space / Shift+Space / Ctrl+A)
// ============================================================================
//
// WHAT WAS WRONG. All four selection shortcuts selected the whole sheet.
// Ctrl+A took every cell, Ctrl+Shift+Space took every cell a second way,
// Ctrl+Space took the whole sheet column and Shift+Space the whole sheet row —
// inside a table exactly as outside one. Excel narrows first and widens on the
// next press: the table's column, then the whole table column, then the sheet
// column; the table's data, then the whole table, then the sheet.
//
// THE GEOMETRY IS NOT DECIDED HERE. A grid region may DECLARE the blocks each
// gesture offers inside it, and the extension that owns the region computes
// them — the Table extension knows which of its rows are headers and which are
// totals, and Core must never learn that recipe. Core asks only "is there
// something narrower than the whole sheet here, and have I already offered it?"
// It never asks what KIND of object the region is, so a pivot or a floating
// range gets the same behaviour the day it declares the same field.
//
// THE STEP IS DERIVED, NOT COUNTED. Which press this is comes from comparing
// the CURRENT selection against the blocks the region declared, not from a
// counter: click away and press again and you are back at step one, and a
// selection that already equals a step moves on to the next one instead of
// spending a keypress selecting what is selected. A counter would have to be
// reset from every other gesture in this file, and the one that was forgotten
// would be a shortcut that silently did nothing.

/** A row band for the column gesture; the gesture supplies the column. */
interface RegionColumnStep {
  startRow: number;
  endRow: number;
}

/** A column band for the row gesture; the gesture supplies the row. */
interface RegionRowStep {
  startCol: number;
  endCol: number;
}

/** A whole block, in the grid's 0-based inclusive coordinates. */
interface RegionBlock {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * What a region declares about the three selection gestures, NARROWEST FIRST.
 * Read off `GridRegion.data.selectionScope` — the generic extension-metadata
 * bag — because there is no typed @api seam for it yet. Every field is
 * optional and every value is validated below: this data crosses a boundary
 * and an extension that publishes nonsense must degrade to the old sheet-wide
 * behaviour, never to an inverted or off-grid selection.
 */
export interface RegionSelectionScope {
  columnSteps?: RegionColumnStep[];
  rowSteps?: RegionRowStep[];
  allSteps?: RegionBlock[];
}

/** The three gestures that scope, named once. */
type ScopedGesture = "column" | "row" | "all";

function isGridIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Identity of a block, for "is this what the last press produced?". */
function blockKey(block: RegionBlock): string {
  const startRow = Math.min(block.startRow, block.endRow);
  const endRow = Math.max(block.startRow, block.endRow);
  const startCol = Math.min(block.startCol, block.endCol);
  const endCol = Math.max(block.startCol, block.endCol);
  return `${startRow}:${startCol}:${endRow}:${endCol}`;
}

/**
 * The blocks the region under (row, col) offers for one gesture, narrowest
 * first, already turned into whole blocks against the active cell.
 *
 * Returns an empty list when no region claims the cell, when the region
 * declares nothing for this gesture, or when what it declared does not survive
 * validation. Duplicate consecutive blocks are dropped — a step that selects
 * what the previous step selected reads as a dead keypress.
 */
function regionStepsFor(
  gesture: ScopedGesture,
  row: number,
  col: number,
): RegionBlock[] {
  for (const region of getGridRegions()) {
    // A floating region is positioned in pixels and owns no cells at all, so it
    // can neither contain the active cell nor scope a selection.
    if (region.floating) continue;
    if (row < region.startRow || row > region.endRow) continue;
    if (col < region.startCol || col > region.endCol) continue;

    const declared = (region.data as { selectionScope?: unknown } | undefined)?.selectionScope;
    if (!declared || typeof declared !== "object") continue;
    const scope = declared as RegionSelectionScope;

    let blocks: RegionBlock[] = [];
    if (gesture === "column" && Array.isArray(scope.columnSteps)) {
      blocks = scope.columnSteps
        .filter((s) => s && isGridIndex(s.startRow) && isGridIndex(s.endRow) && s.startRow <= s.endRow)
        .map((s) => ({ startRow: s.startRow, startCol: col, endRow: s.endRow, endCol: col }));
    } else if (gesture === "row" && Array.isArray(scope.rowSteps)) {
      blocks = scope.rowSteps
        .filter((s) => s && isGridIndex(s.startCol) && isGridIndex(s.endCol) && s.startCol <= s.endCol)
        .map((s) => ({ startRow: row, startCol: s.startCol, endRow: row, endCol: s.endCol }));
    } else if (gesture === "all" && Array.isArray(scope.allSteps)) {
      blocks = scope.allSteps.filter(
        (b) =>
          b &&
          isGridIndex(b.startRow) &&
          isGridIndex(b.startCol) &&
          isGridIndex(b.endRow) &&
          isGridIndex(b.endCol) &&
          b.startRow <= b.endRow &&
          b.startCol <= b.endCol,
      );
    }

    const deduped: RegionBlock[] = [];
    for (const block of blocks) {
      if (deduped.length && blockKey(deduped[deduped.length - 1]) === blockKey(block)) continue;
      deduped.push(block);
    }
    if (deduped.length > 0) return deduped;
  }

  return [];
}

/**
 * Hook for handling keyboard navigation in the grid.
 *
 * @param options - Configuration options
 */
export function useGridKeyboard(options: UseGridKeyboardOptions): void {
  const {
    containerRef,
    onSelectionChange,
    enabled = true,
    isEditing = false,
    onClearClipboard,
    hasClipboardContent = false,
    onDelete,
    onSelectColumn,
    onSelectRow,
    onCommand,
  } = options;
  const { state, dispatch } = useGridContext();
  const { config, viewport, selection, dimensions } = state;

  // ==========================================================================
  // Serialised navigation
  // ==========================================================================
  //
  // THE BUG THIS EXISTS FOR. Every keyboard navigation asks the backend for
  // merge information before it dispatches (`getMergeInfo`), so a keypress does
  // not change the selection until an IPC round trip completes. The handler,
  // meanwhile, computed its target from the `selection` captured in the React
  // render that was current when the key arrived. Two keys inside one round
  // trip therefore BOTH started from the same cell, and the second one's
  // dispatch landed last and won — so the first navigation was silently
  // discarded.
  //
  // Ctrl+Home followed quickly by ArrowRight is the case that was reported as
  // "Ctrl+Home is intermittently swallowed": from A5 it produced B5 (ArrowRight
  // applied to the PRE-Ctrl+Home selection) instead of B1. Nothing was swallowed
  // — the navigation ran and was then overwritten.
  //
  // The fix is two refs and no timing assumptions:
  //   * `liveSelectionRef` is the selection keyboard navigation reasons from. It
  //     is updated the moment a navigation resolves, so the next one chains off
  //     the real result rather than off a React render that has not happened yet.
  //   * `navChainRef` serialises the navigations themselves, so a slow one can
  //     never be overtaken by a later, faster one.
  //
  // While the chain is busy the ref is authoritative; when it drains, React
  // state takes over again so a mouse click or a Name Box jump is picked up.
  const liveSelectionRef = useRef(selection);
  const navChainRef = useRef<Promise<void>>(Promise.resolve());
  const navPendingRef = useRef(0);

  useEffect(() => {
    if (navPendingRef.current === 0) {
      liveSelectionRef.current = selection;
    }
  }, [selection]);

  /**
   * Dispatch a new selection AND make it the basis for the next navigation.
   * Every keyboard navigation must go through this — a bare `dispatch` leaves
   * the chain reasoning from a stale cell.
   */
  const commitSelection = useCallback(
    (next: NonNullable<typeof selection>) => {
      liveSelectionRef.current = next;
      dispatch(setSelection(next));
    },
    [dispatch]
  );

  /**
   * Queue a navigation behind whatever is already in flight.
   */
  const enqueueNavigation = useCallback((run: () => Promise<void>) => {
    navPendingRef.current += 1;
    navChainRef.current = navChainRef.current
      .then(run)
      .catch((error) => {
        console.error("[useGridKeyboard] navigation failed:", error);
      })
      .finally(() => {
        navPendingRef.current -= 1;
      });
  }, []);

  /**
   * Take one step of a progressive, region-scoped selection gesture.
   *
   * Returns true when a region's block was selected, and false when the caller
   * should do its own sheet-wide selection — so `onSelectColumn` /
   * `onSelectRow` keep owning the whole-column and whole-row selections, header
   * highlight and all, exactly as before.
   *
   * WHY THE WIDEST STOP IS TERMINAL, since nothing here says so. Every
   * sheet-wide selection parks the ACTIVE cell on the sheet's edge — the last
   * cell for select-all, the last row for a column, the last column for a row —
   * and a region that no longer contains the active cell declares nothing, so
   * the next press finds no steps and falls straight through again. It is worth
   * knowing that this is what makes a fourth press stay put; a "stop if the
   * whole sheet is already selected" line looks like the thing that does it and
   * is in fact unreachable, which is why there isn't one.
   */
  const advanceScopedGesture = useCallback(
    (
      gesture: ScopedGesture,
      activeRow: number,
      activeCol: number,
    ): boolean => {
      const steps = regionStepsFor(gesture, activeRow, activeCol);
      if (steps.length === 0) return false;

      const current = liveSelectionRef.current;
      const currentKey = current ? blockKey(current) : null;

      // The step is where the current selection sits in the region's own list,
      // not a press count. Searched from the END so a list that repeats a block
      // still moves forward.
      let matched = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (currentKey !== null && blockKey(steps[i]) === currentKey) {
          matched = i;
          break;
        }
      }

      const step = matched + 1;
      if (step >= steps.length) return false;

      const block = steps[step];
      commitSelection({ ...block, type: "cells" });
      if (onSelectionChange) {
        setTimeout(onSelectionChange, 0);
      }
      return true;
    },
    [commitSelection, onSelectionChange]
  );

  /**
   * Ctrl+A and Ctrl+Shift+Space. ONE implementation for both, because in Excel
   * they are one command — leaving Ctrl+Shift+Space as a second, flat copy of
   * select-all is how it came to disagree with Ctrl+A about what a table is.
   *
   * Returns whether a region's block was selected (the whole sheet otherwise).
   */
  const runSelectAllGesture = useCallback((): boolean => {
    const sheetWide: RegionBlock = {
      startRow: 0,
      startCol: 0,
      endRow: config.totalRows - 1,
      endCol: config.totalCols - 1,
    };
    const active = liveSelectionRef.current;
    if (active && advanceScopedGesture("all", active.endRow, active.endCol)) {
      return true;
    }
    commitSelection({ ...sheetWide, type: "cells" });
    if (onSelectionChange) {
      setTimeout(onSelectionChange, 0);
    }
    return false;
  }, [advanceScopedGesture, commitSelection, config.totalRows, config.totalCols, onSelectionChange]);

  /**
   * Handle navigation to a cell, expanding to merged region if needed.
   * This is an async helper that checks for merges and dispatches the appropriate selection.
   * 
   * IMPORTANT: When landing on a merged cell, we preserve the entry point (row, col) as
   * startRow/startCol, and set endRow/endCol to cover the merge extent. This allows
   * subsequent navigation to exit from the correct position.
   */
  const navigateToCell = useCallback(
    async (row: number, col: number, extend: boolean) => {
      // The anchor comes from the LIVE selection, not the render-time one: a
      // navigation queued behind another must extend from where that one landed.
      const anchor = liveSelectionRef.current;
      try {
        const mergeInfo = await getMergeInfo(row, col);

        if (mergeInfo) {
          // Cell is part of a merge - expand selection to cover it
          if (extend && anchor) {
            // When extending, keep the start anchor and extend to the merge bounds
            // Use the corner of the merge that's furthest from the start
            const endRow = row >= anchor.startRow ? mergeInfo.endRow : mergeInfo.startRow;
            const endCol = col >= anchor.startCol ? mergeInfo.endCol : mergeInfo.startCol;
            commitSelection({
              startRow: anchor.startRow,
              startCol: anchor.startCol,
              endRow,
              endCol,
              type: anchor.type,
            });
          } else {
            // Not extending - select the entire merged region
            // Keep startRow/startCol at the entry point (row, col)
            // Set endRow/endCol to the opposite corner to cover the full merge
            commitSelection({
              startRow: row,
              startCol: col,
              // Set end to opposite corner of merge to ensure full coverage
              endRow: row <= mergeInfo.startRow ? mergeInfo.endRow : mergeInfo.startRow,
              endCol: col <= mergeInfo.startCol ? mergeInfo.endCol : mergeInfo.startCol,
              type: "cells",
            });
          }
        } else {
          // Regular cell - normal selection
          if (extend && anchor) {
            commitSelection({
              startRow: anchor.startRow,
              startCol: anchor.startCol,
              endRow: row,
              endCol: col,
              type: anchor.type,
            });
          } else {
            commitSelection({
              startRow: row,
              startCol: col,
              endRow: row,
              endCol: col,
              type: "cells",
            });
          }
        }
      } catch (error) {
        console.error('[useGridKeyboard] Failed to get merge info:', error);
        // Fallback to regular selection on error
        if (extend && anchor) {
          commitSelection({
            startRow: anchor.startRow,
            startCol: anchor.startCol,
            endRow: row,
            endCol: col,
            type: anchor.type,
          });
        } else {
          commitSelection({
            startRow: row,
            startCol: col,
            endRow: row,
            endCol: col,
            type: "cells",
          });
        }
      }

      if (onSelectionChange) {
        setTimeout(onSelectionChange, 0);
      }
    },
    [commitSelection, onSelectionChange]
  );

  /**
   * Handle Ctrl+Arrow navigation by querying the backend for the target cell.
   */
  const handleCtrlArrow = useCallback(
    async (direction: ArrowDirection, extend: boolean) => {
      const selection = liveSelectionRef.current;
      if (!selection) {
        return;
      }

      // For Ctrl+Arrow from a merged cell, we need to start from the appropriate edge
      // Get the normalized bounds of the current selection
      const minRow = Math.min(selection.startRow, selection.endRow);
      const maxRow = Math.max(selection.startRow, selection.endRow);
      const minCol = Math.min(selection.startCol, selection.endCol);
      const maxCol = Math.max(selection.startCol, selection.endCol);

      // Determine starting position based on direction and extend mode
      let currentRow: number;
      let currentCol: number;

      if (extend) {
        // When extending (Ctrl+Shift+Arrow), start from the active cell
        currentRow = selection.endRow;
        currentCol = selection.endCol;
      } else {
        // When not extending, use selection bounds for merged cell edge exit
        switch (direction) {
          case "up":
            currentRow = minRow;
            currentCol = selection.startCol;
            break;
          case "down":
            currentRow = maxRow;
            currentCol = selection.startCol;
            break;
          case "left":
            currentRow = selection.startRow;
            currentCol = minCol;
            break;
          case "right":
            currentRow = selection.startRow;
            currentCol = maxCol;
            break;
          default:
            currentRow = selection.startRow;
            currentCol = selection.startCol;
        }
      }

      const maxRowBound = config.totalRows - 1;
      const maxColBound = config.totalCols - 1;

      try {
        let [targetRow, targetCol] = await findCtrlArrowTarget(
          currentRow,
          currentCol,
          direction,
          maxRowBound,
          maxColBound
        );

        // Skip hidden rows/cols if the target lands on one
        if (dimensions.hiddenRows && dimensions.hiddenRows.size > 0 &&
            (direction === "up" || direction === "down")) {
          const dir = direction === "down" ? 1 : -1;
          while (targetRow >= 0 && targetRow <= maxRowBound && dimensions.hiddenRows.has(targetRow)) {
            targetRow += dir;
          }
          targetRow = clamp(targetRow, 0, maxRowBound);
        }
        if (dimensions.hiddenCols && dimensions.hiddenCols.size > 0 &&
            (direction === "left" || direction === "right")) {
          const dir = direction === "right" ? 1 : -1;
          while (targetCol >= 0 && targetCol <= maxColBound && dimensions.hiddenCols.has(targetCol)) {
            targetCol += dir;
          }
          targetCol = clamp(targetCol, 0, maxColBound);
        }

        fnLog.exit('handleCtrlArrow', `target=(${targetRow}, ${targetCol})`);

        // Use merge-aware navigation
        await navigateToCell(targetRow, targetCol, extend);
      } catch (error) {
        console.error("[useGridKeyboard] Ctrl+Arrow navigation failed:", error);
      }
    },
    [config.totalRows, config.totalCols, dimensions, navigateToCell]
  );

  /**
   * Handle regular arrow key navigation with merge awareness.
   * When navigating FROM a merged cell, we calculate the target from the edge
   * of the merge in the direction of movement, while preserving the entry
   * column (for vertical movement) or entry row (for horizontal movement).
   */
  const handleArrowNavigation = useCallback(
    async (deltaRow: number, deltaCol: number, extend: boolean) => {
      const selection = liveSelectionRef.current;
      if (!selection) {
        // No selection - start at origin
        await navigateToCell(0, 0, false);
        return;
      }

      const maxRow = config.totalRows - 1;
      const maxCol = config.totalCols - 1;

      let startRow: number;
      let startCol: number;

      if (extend) {
        // EXTENDING: Always start from the active cell (endRow/endCol).
        // This ensures that pressing a perpendicular arrow while extending
        // preserves the selection extent on both axes.
        // e.g., Shift+Down from A1 gives A1:A2, then Shift+Right gives A1:B2 (not A1:B1)
        startRow = selection.endRow;
        startCol = selection.endCol;
      } else {
        // NOT EXTENDING: Use selection bounds to exit from the correct edge
        // of a merged cell, preserving entry point for the perpendicular axis
        const minRow = Math.min(selection.startRow, selection.endRow);
        const maxRowSel = Math.max(selection.startRow, selection.endRow);
        const minCol = Math.min(selection.startCol, selection.endCol);
        const maxColSel = Math.max(selection.startCol, selection.endCol);

        if (deltaRow < 0) {
          startRow = minRow;       // Moving up - start from top edge
        } else if (deltaRow > 0) {
          startRow = maxRowSel;    // Moving down - start from bottom edge
        } else {
          startRow = selection.startRow; // No vertical movement - preserve entry row
        }

        if (deltaCol < 0) {
          startCol = minCol;       // Moving left - start from left edge
        } else if (deltaCol > 0) {
          startCol = maxColSel;    // Moving right - start from right edge
        } else {
          startCol = selection.startCol; // No horizontal movement - preserve entry column
        }
      }

      // Calculate target position from the appropriate edge
      let targetRow = clamp(startRow + deltaRow, 0, maxRow);
      let targetCol = clamp(startCol + deltaCol, 0, maxCol);

      // Skip hidden rows when navigating vertically
      if (deltaRow !== 0 && dimensions.hiddenRows && dimensions.hiddenRows.size > 0) {
        const dir = deltaRow > 0 ? 1 : -1;
        while (targetRow >= 0 && targetRow <= maxRow && dimensions.hiddenRows.has(targetRow)) {
          targetRow += dir;
        }
        targetRow = clamp(targetRow, 0, maxRow);
      }

      // Skip hidden columns when navigating horizontally
      if (deltaCol !== 0 && dimensions.hiddenCols && dimensions.hiddenCols.size > 0) {
        const dir = deltaCol > 0 ? 1 : -1;
        while (targetCol >= 0 && targetCol <= maxCol && dimensions.hiddenCols.has(targetCol)) {
          targetCol += dir;
        }
        targetCol = clamp(targetCol, 0, maxCol);
      }

      // Use merge-aware navigation
      await navigateToCell(targetRow, targetCol, extend);
    },
    [config.totalRows, config.totalCols, dimensions, navigateToCell]
  );

  /**
   * Handle keydown events for navigation and shortcuts.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const { key, shiftKey, ctrlKey, metaKey, altKey } = event;
      
      fnLog.enter('handleKeyDown', `key=${key}`);

      if (!enabled) {
        fnLog.exit('handleKeyDown', 'skipped (disabled)');
        return;
      }

      // Skip if focus is inside an input, textarea, contenteditable, or Monaco editor
      // (e.g. file editor in the side panel, task pane, or notebook cells)
      const target = event.target as HTMLElement;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          fnLog.exit('handleKeyDown', 'skipped (focus in form element)');
          return;
        }
        if (target.closest(".monaco-editor")) {
          fnLog.exit('handleKeyDown', 'skipped (focus in Monaco editor)');
          return;
        }
      }
      // Fallback: check document.activeElement (Monaco may route events through
      // a hidden textarea whose event.target doesn't match the editor DOM tree)
      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl?.closest(".monaco-editor")) {
        fnLog.exit('handleKeyDown', 'skipped (activeElement in Monaco editor)');
        return;
      }

      // FIX: Check the global editing flag synchronously
      // The isEditing prop may be stale (from React state that hasn't re-rendered yet)
      // but the global flag is updated immediately when editing starts
      const isCurrentlyEditing = isEditing || getGlobalIsEditing();

      if (isCurrentlyEditing) {
        fnLog.exit('handleKeyDown', 'skipped (editing active - global check)');
        return;
      }

      const modKey = ctrlKey || metaKey;

      // Read End mode ONCE per keypress and disarm it here, not in the branches
      // that use it: Excel's End mode lasts exactly one key, so every branch
      // below either consumes `endModeArmed` or simply lets the mode lapse.
      // Escape needs no case of its own for the same reason.
      let endModeArmed = false;
      if (!MODIFIER_KEYS.has(key)) {
        endModeArmed = endModeActive;
        endModeActive = false;
      }

      // Handle ESC key - deactivate extend mode, then clear clipboard
      if (key === "Escape") {
        if (extendModeActive) {
          event.preventDefault();
          event.stopPropagation();
          extendModeActive = false;
          eventLog.keyboard('Grid', 'handleKeyDown', 'Escape', []);
          fnLog.exit('handleKeyDown', 'extend mode off (Escape)');
          return;
        }
        if (hasClipboardContent && onClearClipboard) {
          event.preventDefault();
          event.stopPropagation();
          eventLog.keyboard('Grid', 'handleKeyDown', 'Escape', []);
          onClearClipboard();
          fnLog.exit('handleKeyDown', 'cleared clipboard');
          return;
        }
      }

      // Handle F8 - Toggle Extend Mode
      if (key === "F8") {
        event.preventDefault();
        event.stopPropagation();
        extendModeActive = !extendModeActive;
        eventLog.keyboard('Grid', 'handleKeyDown', 'F8', []);
        fnLog.exit('handleKeyDown', `extend mode ${extendModeActive ? 'on' : 'off'}`);
        return;
      }

      // Handle bare End (and Shift+End) - arm End mode. It MOVES NOTHING by
      // itself, as in Excel; the jump belongs to the key that follows.
      // `endModeArmed` has already disarmed the flag, so a second End turns the
      // mode back off instead of re-arming it.
      if (key === "End" && !modKey && !altKey) {
        event.preventDefault();
        event.stopPropagation();
        endModeActive = !endModeArmed;
        eventLog.keyboard('Grid', 'handleKeyDown', shiftKey ? 'Shift+End' : 'End', shiftKey ? ['Shift'] : []);
        fnLog.exit('handleKeyDown', `end mode ${endModeActive ? 'on' : 'off'}`);
        return;
      }

      // Handle F5 - Focus Name Box (Go To)
      if (key === "F5" && !modKey && !altKey && !shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'F5', []);
        if (onCommand) {
          onCommand('navigate.focusNameBox');
        }
        fnLog.exit('handleKeyDown', 'focus name box');
        return;
      }

      // Handle F9 - Calculate Now (recalculate the WORKBOOK, as Excel's F9 does)
      if (key === "F9" && !modKey && !altKey && !shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'F9', []);
        if (onCommand) {
          onCommand('calculate.now');
        }
        fnLog.exit('handleKeyDown', 'calculate now');
        return;
      }

      // Handle Shift+F9 - Calculate Sheet (the ACTIVE sheet alone).
      // EXCEL PARITY: Excel's two manual recalculations are F9 = Calculate Now
      // = workbook and Shift+F9 = Calculate Sheet = sheet. Handled here rather
      // than in the keybinding registry because its partner F9 is, and the two
      // must be reachable under exactly the same focus conditions — a
      // Shift+F9 that fired where F9 did not would be worse than neither.
      if (key === "F9" && !modKey && !altKey && shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Shift+F9', ['Shift']);
        if (onCommand) {
          onCommand('calculate.sheet');
        }
        fnLog.exit('handleKeyDown', 'calculate sheet');
        return;
      }

      // Handle F11 - Insert Chart
      if (key === "F11" && !modKey && !altKey && !shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'F11', []);
        if (onCommand) {
          onCommand('insert.chart');
        }
        fnLog.exit('handleKeyDown', 'insert chart');
        return;
      }

      // Handle Ctrl+F1 - Toggle Ribbon Minimize
      if (key === "F1" && modKey && !altKey && !shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+F1', ['Ctrl']);
        if (onCommand) {
          onCommand('view.toggleRibbon');
        }
        fnLog.exit('handleKeyDown', 'toggle ribbon');
        return;
      }

      // Handle DELETE/Backspace key - clear selection contents
      if ((key === "Delete" || key === "Backspace") && onDelete) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', key, []);
        onDelete();
        fnLog.exit('handleKeyDown', 'delete contents');
        return;
      }

      // Handle Ctrl+Alt+V - Paste Special
      if (modKey && altKey && key.toLowerCase() === 'v' && onCommand) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Alt+V', ['Ctrl', 'Alt']);
        onCommand('clipboard.pasteSpecial');
        fnLog.exit('handleKeyDown', 'paste special');
        return;
      }

      // Clipboard (Ctrl+C/X/V) and undo/redo (Ctrl+Z/Y) are owned by the
      // centralized keybinding registry. Its capture-phase handler matches these
      // grid-scoped commands and stopPropagation()s before this bubble-phase
      // handler runs whenever the grid is focused, so cases for them here would be
      // dead. See app/src/api/keybindings.ts.
      if (modKey && !altKey) {
        switch (key.toLowerCase()) {
          case 'a': {
            // Ctrl+A - select all, narrowing to the region under the cursor
            // first. Inside a table that is the table's data, then the whole
            // table, then the sheet; outside one it is the sheet, as before.
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+A', ['Ctrl']);
            fnLog.exit('handleKeyDown', runSelectAllGesture() ? 'select all (region step)' : 'select all');
            return;
          }

          case 'b':
            // Ctrl+B - Toggle bold
            if (!shiftKey && onCommand) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+B', ['Ctrl']);
              onCommand('format.toggleBold');
              fnLog.exit('handleKeyDown', 'toggle bold');
              return;
            }
            break;

          case 'i':
            // Ctrl+I - Toggle italic
            if (!shiftKey && onCommand) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+I', ['Ctrl']);
              onCommand('format.toggleItalic');
              fnLog.exit('handleKeyDown', 'toggle italic');
              return;
            }
            break;

          case 'u':
            // Ctrl+U - Toggle underline
            if (!shiftKey && onCommand) {
              event.preventDefault();
              event.stopPropagation();
              eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+U', ['Ctrl']);
              onCommand('format.toggleUnderline');
              fnLog.exit('handleKeyDown', 'toggle underline');
              return;
            }
            break;

          // Fill down/right (Ctrl+D/R) are owned by the keybinding registry
          // (bridged to gridCommands.fillDown/fillRight); dead here — see above.
        }
      }

      // Handle Ctrl+number shortcuts (formatting)
      if (modKey && !altKey && !shiftKey && onCommand) {
        switch (key) {
          case '2':
            // Ctrl+2 - Toggle bold (alternative)
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+2', ['Ctrl']);
            onCommand('format.toggleBold');
            fnLog.exit('handleKeyDown', 'toggle bold (Ctrl+2)');
            return;

          case '3':
            // Ctrl+3 - Toggle italic (alternative)
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+3', ['Ctrl']);
            onCommand('format.toggleItalic');
            fnLog.exit('handleKeyDown', 'toggle italic (Ctrl+3)');
            return;

          case '4':
            // Ctrl+4 - Toggle underline (alternative)
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+4', ['Ctrl']);
            onCommand('format.toggleUnderline');
            fnLog.exit('handleKeyDown', 'toggle underline (Ctrl+4)');
            return;

          case '5':
            // Ctrl+5 - Toggle strikethrough
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+5', ['Ctrl']);
            onCommand('format.toggleStrikethrough');
            fnLog.exit('handleKeyDown', 'toggle strikethrough');
            return;
        }
      }

      // Handle Ctrl+; - Insert current date
      if (modKey && !altKey && !shiftKey && key === ';' && onCommand) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+;', ['Ctrl']);
        onCommand('edit.insertDate');
        fnLog.exit('handleKeyDown', 'insert date');
        return;
      }

      // Handle Ctrl+` - Toggle Show Formulas mode
      if (modKey && !altKey && !shiftKey && key === '`' && onCommand) {
        event.preventDefault();
        event.stopPropagation();
        eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+`', ['Ctrl']);
        onCommand('view.toggleShowFormulas');
        fnLog.exit('handleKeyDown', 'toggle show formulas');
        return;
      }

      // Handle Ctrl+Shift shortcuts for number formats and time insertion
      // On US keyboard, Shift+digit produces the symbol (e.g., Shift+4 = $)
      // Browsers report the shifted symbol as event.key when Ctrl+Shift is held
      if (modKey && shiftKey && !altKey && onCommand) {
        switch (key) {
          case ':':
            // Ctrl+Shift+: - Insert current time
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+:', ['Ctrl', 'Shift']);
            onCommand('edit.insertTime');
            fnLog.exit('handleKeyDown', 'insert time');
            return;

          case '~':
          case '`':
            // Ctrl+Shift+~ - General number format
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+~', ['Ctrl', 'Shift']);
            onCommand('format.numberGeneral');
            fnLog.exit('handleKeyDown', 'format general');
            return;

          case '$':
            // Ctrl+Shift+$ - Currency format
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+$', ['Ctrl', 'Shift']);
            onCommand('format.numberCurrency');
            fnLog.exit('handleKeyDown', 'format currency');
            return;

          case '%':
            // Ctrl+Shift+% - Percentage format
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+%', ['Ctrl', 'Shift']);
            onCommand('format.numberPercentage');
            fnLog.exit('handleKeyDown', 'format percentage');
            return;

          case '^':
            // Ctrl+Shift+^ - Scientific format
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+^', ['Ctrl', 'Shift']);
            onCommand('format.numberScientific');
            fnLog.exit('handleKeyDown', 'format scientific');
            return;

          case '#':
            // Ctrl+Shift+# - Date format
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+#', ['Ctrl', 'Shift']);
            onCommand('format.numberDate');
            fnLog.exit('handleKeyDown', 'format date');
            return;

          case '@':
            // Ctrl+Shift+@ - Time format
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+@', ['Ctrl', 'Shift']);
            onCommand('format.numberTime');
            fnLog.exit('handleKeyDown', 'format time');
            return;

          case '!':
            // Ctrl+Shift+! - Number format (with thousands separator)
            event.preventDefault();
            event.stopPropagation();
            eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+!', ['Ctrl', 'Shift']);
            onCommand('format.numberNumber');
            fnLog.exit('handleKeyDown', 'format number');
            return;
        }
      }

      // Handle Ctrl+End / Ctrl+Shift+End / End-mode Home - the last used cell.
      //
      // ONE await of getUsedRange serves all three, because "the end" must be
      // one place. Plain Ctrl+End used to be a MOVE instead: deltaRow/deltaCol
      // of config.totalRows/totalCols, which handleArrowNavigation clamps to the
      // sheet bounds — so it landed on XFD1048576 while Ctrl+Shift+End, decided
      // right here, extended to the last cell that actually holds data. The two
      // gestures visibly disagreed about where the end of the sheet is.
      const wantsLastUsedCell =
        (modKey && !altKey && key === "End") ||
        (endModeArmed && !modKey && !altKey && key === "Home");
      if (wantsLastUsedCell) {
        event.preventDefault();
        event.stopPropagation();

        const extend = shiftKey || extendModeActive;
        const mods: string[] = modKey ? ['Ctrl'] : [];
        if (shiftKey) mods.push('Shift');
        eventLog.keyboard('Grid', 'handleKeyDown', modKey ? `Ctrl+${key}` : 'End,Home', mods);

        enqueueNavigation(async () => {
          // Anchor on the LIVE selection: this key can be pressed while an
          // earlier navigation is still resolving.
          const anchor = liveSelectionRef.current;
          try {
            // An empty sheet answers {0,0,0,0,empty:true}, so this goes to A1
            // the way Excel does without a case of its own.
            const usedRange = await getUsedRange();
            if (extend && anchor) {
              commitSelection({
                startRow: anchor.startRow,
                startCol: anchor.startCol,
                endRow: usedRange.endRow,
                endCol: usedRange.endCol,
                type: anchor.type,
              });
              if (onSelectionChange) {
                setTimeout(onSelectionChange, 0);
              }
            } else {
              // Not extending: go there merge-aware, so landing inside a merge
              // selects the whole merge like every other navigation does.
              await navigateToCell(usedRange.endRow, usedRange.endCol, false);
            }
          } catch (error) {
            console.error("[useGridKeyboard] navigation to last used cell failed:", error);
          }
        });

        fnLog.exit('handleKeyDown', extend ? 'extend to last used cell' : 'go to last used cell');
        return;
      }

      // Handle Ctrl+Arrow for Excel-like navigation (async).
      // An armed End mode routes a BARE arrow down the same path: in Excel,
      // End followed by an arrow is Ctrl+Arrow, so it must be the same code and
      // not a second edge-finding rule that can drift from this one.
      if ((modKey || endModeArmed) && !altKey) {
        let direction: ArrowDirection | null = null;
        
        switch (key) {
          case "ArrowUp":
            direction = "up";
            break;
          case "ArrowDown":
            direction = "down";
            break;
          case "ArrowLeft":
            direction = "left";
            break;
          case "ArrowRight":
            direction = "right";
            break;
        }
        
        if (direction) {
          event.preventDefault();
          event.stopPropagation();
          
          const mods: string[] = modKey ? ['Ctrl'] : [];
          if (shiftKey) mods.push('Shift');
          eventLog.keyboard('Grid', 'handleKeyDown', modKey ? `Ctrl+${key}` : `End,${key}`, mods);
          
          // Queued, not fired-and-forgotten: a Ctrl+Arrow still in flight must
          // finish and publish its landing cell before the next key computes
          // from it.
          const ctrlArrowExtend = shiftKey || extendModeActive;
          enqueueNavigation(() => handleCtrlArrow(direction, ctrlArrowExtend));
          fnLog.exit('handleKeyDown', 'ctrl+arrow (async)');
          return;
        }
      }

      // Handle Spacebar shortcuts (before navigation switch since Space is not a nav key)
      if (key === " ") {
        if (modKey && shiftKey && !altKey) {
          // Ctrl+Shift+Space - the same command as Ctrl+A, not a second flat
          // select-all. Inside a table it selects the table before the sheet.
          event.preventDefault();
          event.stopPropagation();
          eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Shift+Space', ['Ctrl', 'Shift']);
          fnLog.exit(
            'handleKeyDown',
            runSelectAllGesture()
              ? 'select all (region step, Ctrl+Shift+Space)'
              : 'select all (Ctrl+Shift+Space)',
          );
          return;
        }

        if (modKey && !shiftKey && !altKey) {
          // Ctrl+Space - the table column's data, then the whole table column,
          // then the sheet column. Outside a table: the sheet column, as before.
          event.preventDefault();
          event.stopPropagation();
          eventLog.keyboard('Grid', 'handleKeyDown', 'Ctrl+Space', ['Ctrl']);
          const columnAnchor = liveSelectionRef.current;
          if (columnAnchor) {
            const activeCol = columnAnchor.endCol;
            if (advanceScopedGesture("column", columnAnchor.endRow, activeCol)) {
              fnLog.exit('handleKeyDown', 'select column (region step)');
              return;
            }
            if (onSelectColumn) {
              onSelectColumn(activeCol);
            }
          }
          fnLog.exit('handleKeyDown', 'select column');
          return;
        }

        if (shiftKey && !modKey && !altKey) {
          // Shift+Space - the table's row, then the sheet row.
          event.preventDefault();
          event.stopPropagation();
          eventLog.keyboard('Grid', 'handleKeyDown', 'Shift+Space', ['Shift']);
          const rowAnchor = liveSelectionRef.current;
          if (rowAnchor) {
            const activeRow = rowAnchor.endRow;
            if (advanceScopedGesture("row", activeRow, rowAnchor.endCol)) {
              fnLog.exit('handleKeyDown', 'select row (region step)');
              return;
            }
            if (onSelectRow) {
              onSelectRow(activeRow);
            }
          }
          fnLog.exit('handleKeyDown', 'select row');
          return;
        }

        if (!modKey && !shiftKey && !altKey) {
          // Bare Space - generic cell-type keydown hook (checkbox toggle etc.).
          // Falls back to the legacy style-flag checkbox command when no cell
          // type handles it (removed when that extension retires).
          event.preventDefault();
          event.stopPropagation();
          eventLog.keyboard('Grid', 'handleKeyDown', 'Space', []);
          // endRow/endCol is the active cell (same convention as the legacy
          // checkbox.toggle command).
          const activeRow = selection?.endRow;
          const activeCol = selection?.endCol;
          void (async () => {
            const handled =
              activeRow !== undefined && activeCol !== undefined
                ? await handleCellTypeKeyDown(activeRow, activeCol, " ")
                : false;
            if (!handled && onCommand) {
              onCommand('checkbox.toggle');
            }
          })();
          fnLog.exit('handleKeyDown', 'cell-type space');
          return;
        }
      }

      let deltaRow = 0;
      let deltaCol = 0;
      let handled = false;

      switch (key) {
        case "ArrowUp":
          deltaRow = -1;
          handled = true;
          break;

        case "ArrowDown":
          deltaRow = 1;
          handled = true;
          break;

        case "ArrowLeft":
          deltaCol = -1;
          handled = true;
          break;

        case "ArrowRight":
          deltaCol = 1;
          handled = true;
          break;

        case "Tab":
          if (shiftKey) {
            deltaCol = -1;
          } else {
            deltaCol = 1;
          }
          handled = true;
          break;

        case "PageUp":
          deltaRow = -Math.max(1, viewport.rowCount - 1);
          handled = true;
          break;

        case "PageDown":
          deltaRow = Math.max(1, viewport.rowCount - 1);
          handled = true;
          break;

        case "Home":
          if (modKey) {
            deltaRow = -config.totalRows;
            deltaCol = -config.totalCols;
          } else {
            deltaCol = -config.totalCols;
          }
          handled = true;
          break;

        // No "End" case: every End that this handler acts on is decided above —
        // Ctrl+End against the used range, bare End as a mode. Travelling
        // config.totalCols columns is exactly the bug that put Ctrl+End on
        // XFD1048576, so the delta path must never learn that trick again.

        default:
          fnLog.exit('handleKeyDown', 'not a navigation key');
          return;
      }

      if (handled) {
        const mods: string[] = [];
        if (ctrlKey) mods.push('Ctrl');
        if (shiftKey) mods.push('Shift');
        if (altKey) mods.push('Alt');
        if (metaKey) mods.push('Meta');
        
        eventLog.keyboard('Grid', 'handleKeyDown', key, mods);

        event.preventDefault();
        event.stopPropagation();

        const extend = (shiftKey || extendModeActive) && key !== "Tab";
        
        stateLog.action('GridContext', 'dispatch(handleArrowNavigation)', `dRow=${deltaRow}, dCol=${deltaCol}, extend=${extend}`);

        // Use merge-aware navigation, QUEUED behind anything still in flight.
        // Firing it bare let a fast follow-up key start from the pre-navigation
        // selection and then overwrite this one's result — the "Ctrl+Home did
        // not land" report.
        enqueueNavigation(() => handleArrowNavigation(deltaRow, deltaCol, extend));

        fnLog.exit('handleKeyDown', 'handled');
      }
    },
    [enabled, isEditing, config.totalRows, config.totalCols, viewport.rowCount, selection, onSelectionChange, onClearClipboard, hasClipboardContent, onDelete, onSelectColumn, onSelectRow, onCommand, handleCtrlArrow, handleArrowNavigation, navigateToCell, enqueueNavigation, commitSelection, advanceScopedGesture, runSelectAllGesture]
  );

  /**
   * Attach keyboard event listener to the container.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) {
      return;
    }

    fnLog.enter('useGridKeyboard.effect', 'adding listener');

    container.addEventListener("keydown", handleKeyDown, { capture: false });

    return () => {
      fnLog.exit('useGridKeyboard.effect', 'removing listener');
      container.removeEventListener("keydown", handleKeyDown, { capture: false });
    };
  }, [containerRef, enabled, handleKeyDown]);
}