//! FILENAME: app/src/core/components/Spreadsheet/useSpreadsheetSelection.ts
// PURPOSE: Handles mouse/keyboard interaction and selection state.
// CONTEXT: Coordinates global selection hooks with local canvas events.
// Includes fill handle and clipboard support with marching ants.

import { useState, useCallback, useEffect, useRef } from "react";
import {
  useSelection,
  useMouseSelection,
  useGridKeyboard,
  useCellEvents,
  useEditing,
  useViewport,
  useClipboard,
  useFillHandle,
} from "../../hooks";
import { useGridState, useGridContext } from "../../state";
import {
  getCell,
  setColumnWidth as setColumnWidthApi,
  setRowHeight as setRowHeightApi,
  clearRange,
  clearRangeOnSheets,
  undo as undoApi,
  redo as redoApi,
  applyFormatting,
  getStyle,
  getAllStyles,
  getCellsInCols,
  getCellsInRows,
  updateCell,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  fillRange,
  calculateNow,
  calculateSheet,
  recalcControlDependents,
  getAllColumnWidths,
  getAllRowHeights,
  getDefaultDimensions,
} from "../../lib/tauri-api";
import type { UndoResult } from "../../lib/tauri-api";
import type { FormattingOptions } from "../../types";
import { measureOptimalColumnWidth, measureOptimalRowHeight } from "../../lib/gridRenderer";
import { getActiveGridTheme } from "../../theme/skinLoader";
import { checkCellClickInterceptors } from "../../lib/cellClickInterceptors";
import { checkCellDoubleClickInterceptors } from "../../lib/cellDoubleClickInterceptors";
import { checkEditGuards, checkRangeGuards } from "../../lib/editGuards";
import { isSheetGroupingActive, getSelectedSheetIndices } from "../../state/sheetGrouping";
import {
  setColumnWidth,
  setRowHeight,
  setAllDimensions,
  updateConfig,
  setActiveSheet as setActiveSheetAction,
  setSelection as setSelectionAction,
  clearFormulaReferences,
} from "../../state/gridActions";
import { getExternalFormulaTarget } from "../../lib/formulaEditTarget";
import { applyRowsHidden, applyColsHidden, refreshUserHidden } from "../../lib/hiddenRowsCols";
import { primeSheetSwitch } from "../../lib/sheetSwitchPrefetch";
import { cellEvents, cellToChange } from "../../lib/cellEvents";
import { gridCommands } from "../../lib/gridCommands";
import { CommandRegistry, CoreCommands } from "../../../api/commands";
import { emitAppEvent, AppEvents, type MutationDomain } from "../../../api/events";
import type { GridCanvasHandle } from "../Grid";
import { alertAsync } from "../../lib/dialogs";

type GridState = ReturnType<typeof useGridState>;
type GridDispatch = ReturnType<typeof useGridContext>["dispatch"];

interface UseSpreadsheetSelectionProps {
  canvasRef: React.RefObject<GridCanvasHandle | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** FIX: Separate ref for keyboard focus container */
  focusContainerRef: React.RefObject<HTMLDivElement | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  state: GridState;
  dispatch: GridDispatch;
  isFocused: boolean;
  onCommitBeforeSelect: () => Promise<void>;
}

export function useSpreadsheetSelection({
  canvasRef,
  containerRef,
  focusContainerRef,
  scrollRef,
  state,
  dispatch,
  isFocused,
  onCommitBeforeSelect
}: UseSpreadsheetSelectionProps) {
  const [selectedCellContent, setSelectedCellContent] = useState<string>("");
  const { viewport, config, selection, dimensions, formulaReferences, sheetContext, freezeConfig, splitConfig, splitViewport } = state;

  // Compute effective freeze config: when split is active, use split config as freeze config
  const hasSplit = splitConfig &&
    ((splitConfig.splitRow !== null && splitConfig.splitRow > 0) ||
     (splitConfig.splitCol !== null && splitConfig.splitCol > 0));
  const effectiveFreezeConfig = hasSplit
    ? { freezeRow: splitConfig!.splitRow ?? null, freezeCol: splitConfig!.splitCol ?? null }
    : (freezeConfig || undefined);
  const effectiveSplitBarSize = hasSplit ? 4 : 0;
  const effectiveSplitViewport = hasSplit ? splitViewport : undefined;

  const { scrollToSelection, scrollToCell, registerScrollContainer } = useViewport();

  const {
    selectCell,
    selectCellWithMergeExpansion,
    extendToWithMergeExpansion,  // FIX: Added for merge-aware drag selection
    moveActiveCell,
    getSelectionReference,
    selectColumn,
    selectRow,
    addCellToSelection,
  } = useSelection();

  const {
    isEditing,
    isFormulaMode,
    startEdit,  // FIX: Added startEdit to avoid stale state issues
    insertReference,
    insertFormulaText,
    insertRangeReference,
    insertColumnReference,
    insertColumnRangeReference,
    insertRowReference,
    insertRowRangeReference,
    updatePendingReference,
    updatePendingColumnReference,
    updatePendingRowReference,
    clearPendingReference,
    startRefDrag,
    updateRefDrag,
    completeRefDrag,
    cancelRefDrag,
    startRefResize,
    updateRefResize,
    completeRefResize,
    cancelRefResize,
  } = useEditing();

  // Clipboard hook
  const {
    cut,
    copy,
    paste,
    clipboardMode,
    clipboardSelection,
    clearClipboardState,
    moveCells,
    moveRows,
    moveColumns,
    copyCellsDrag,
    copyRowsDrag,
    copyColumnsDrag,
  } = useClipboard();

  // Fill handle hook with auto-scroll support
  const {
    fillState,
    isOverFillHandle,
    startFillDrag,
    updateFillDrag,
    completeFill,
    autoFillToEdge,
  } = useFillHandle({
    containerRef,
    config: state.config,
  });

  const pendingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Register the scroll container so useViewport can sync DOM scroll position
  useEffect(() => {
    if (scrollRef.current) {
      registerScrollContainer(scrollRef.current);
    }
  }, [scrollRef, registerScrollContainer]);

  useEffect(() => {
    if (!selection || isEditing) {
      return;
    }

    const fetchCellContent = async () => {
      try {
        const cellData = await getCell(selection.endRow, selection.endCol);
        const content = cellData?.formula || cellData?.display || "";
        setSelectedCellContent(content);
      } catch (error) {
        console.error("Failed to fetch cell content:", error);
        setSelectedCellContent("");
      }
    };

    fetchCellContent();
    // THE ACTIVE SHEET IS A DEPENDENCY, and its absence was a real defect on
    // the ordinary tab click long before undo learned to switch sheets.
    // `getCell` reads the ACTIVE sheet, and a sheet switch that lands on the
    // same coordinates — Sheet2 has no saved state, so the switch selects A1
    // and A1 was already selected — re-ran nothing. The formula bar went on
    // showing the PREVIOUS sheet's cell against the new sheet's grid: the two
    // disagreed, and the only clue was that the value was right for a sheet
    // you were no longer on.
  }, [selection?.endRow, selection?.endCol, isEditing, sheetContext.activeSheetIndex]);

  useCellEvents(
    useCallback(
      (event) => {
        if (pendingRefreshRef.current) {
          clearTimeout(pendingRefreshRef.current);
        }

        pendingRefreshRef.current = setTimeout(async () => {
          pendingRefreshRef.current = null;

          const canvas = canvasRef.current;
          if (canvas) {
            const t0 = performance.now();
            await canvas.refreshCells();
            const t1 = performance.now();
            canvas.redraw();
            const t2 = performance.now();
            console.log(
              `[PERF][cellEvent] debounced refresh+redraw | ` +
              `refreshCells=${(t1 - t0).toFixed(1)}ms ` +
              `redraw=${(t2 - t1).toFixed(1)}ms ` +
              `TOTAL=${(t2 - t0).toFixed(1)}ms`
            );
          }
        }, 10);

        if (
          selection &&
          // Active-sheet changes only (sheetIndex undefined = active sheet); a
          // cross-sheet dependent whose coords happen to match the active
          // selection must not overwrite the formula-bar content.
          event.sheetIndex === undefined &&
          event.row === selection.endRow &&
          event.col === selection.endCol &&
          !isEditing
        ) {
          setSelectedCellContent(event.formula || event.newValue);
        }
      },
      [selection, isEditing, canvasRef]
    )
  );

  useEffect(() => {
    return () => {
      if (pendingRefreshRef.current) {
        clearTimeout(pendingRefreshRef.current);
      }
    };
  }, []);

  const handleScrollUpdate = useCallback(
    (_scrollX: number, _scrollY: number) => {
      if (scrollRef.current) {
        canvasRef.current?.redraw();
      }
    },
    [canvasRef, scrollRef]
  );

  const handleDragEnd = useCallback(() => {
    canvasRef.current?.redraw();
  }, [canvasRef]);

  const handleColumnResize = useCallback(
    (col: number, width: number) => {
      dispatch(setColumnWidth(col, width));
      setColumnWidthApi(col, width).catch(async (err) => {
        console.error("Failed to persist column width:", err);
        // The optimistic dispatch above already resized the frontend; on a
        // backend refusal the two would silently diverge until reload. Re-read
        // the authoritative widths and tell the user why.
        try {
          const widths = await getAllColumnWidths();
          const defaults = await getDefaultDimensions();
          const actual = widths.find((d) => d.index === col)?.size ?? defaults.defaultColumnWidth;
          dispatch(setColumnWidth(col, actual));
          canvasRef.current?.redraw();
        } catch { /* keep the optimistic value if the re-read fails too */ }
        void alertAsync(err instanceof Error ? err.message : String(err));
      });
      canvasRef.current?.redraw();
      emitAppEvent(AppEvents.COLUMN_RESIZED, { sheetIndex: sheetContext.activeSheetIndex, col, width });
    },
    [dispatch, canvasRef, sheetContext.activeSheetIndex]
  );

  const handleRowResize = useCallback(
    (row: number, height: number) => {
      dispatch(setRowHeight(row, height));
      setRowHeightApi(row, height).catch(async (err) => {
        console.error("Failed to persist row height:", err);
        try {
          const heights = await getAllRowHeights();
          const defaults = await getDefaultDimensions();
          const actual = heights.find((d) => d.index === row)?.size ?? defaults.defaultRowHeight;
          dispatch(setRowHeight(row, actual));
          canvasRef.current?.redraw();
        } catch { /* keep the optimistic value if the re-read fails too */ }
        void alertAsync(err instanceof Error ? err.message : String(err));
      });
      canvasRef.current?.redraw();
      emitAppEvent(AppEvents.ROW_RESIZED, { sheetIndex: sheetContext.activeSheetIndex, row, height });
    },
    [dispatch, canvasRef, sheetContext.activeSheetIndex]
  );

  // -------------------------------------------------------------------------
  // Auto-Fit Column (double-click on resize handle)
  // -------------------------------------------------------------------------
  const handleAutoFitColumn = useCallback(
    async (col: number) => {
      // Determine which columns to auto-fit: when a columns-type selection
      // (primary range OR any additional range) contains the clicked column,
      // auto-fit ALL selected columns individually — Excel behavior.
      const columnsToFit: number[] = [];

      if (selection?.type === "columns") {
        const ranges = [
          {
            start: Math.min(selection.startCol, selection.endCol),
            end: Math.max(selection.startCol, selection.endCol),
          },
          ...(selection.additionalRanges ?? []).map((range) => ({
            start: Math.min(range.startCol, range.endCol),
            end: Math.max(range.startCol, range.endCol),
          })),
        ];
        if (ranges.some((r) => col >= r.start && col <= r.end)) {
          for (const r of ranges) {
            for (let c = r.start; c <= r.end; c++) {
              if (!columnsToFit.includes(c)) columnsToFit.push(c);
            }
          }
        } else {
          columnsToFit.push(col);
        }
      } else {
        columnsToFit.push(col);
      }

      try {
        await beginUndoTransaction("Auto-fit columns");
        const styles = await getAllStyles();
        const activeTheme = getActiveGridTheme();
        const theme = { cellFontFamily: activeTheme.cellFontFamily, cellFontSize: activeTheme.cellFontSize };

        let appliedCount = 0;
        for (const c of columnsToFit) {
          const cells = await getCellsInCols(c, c);
          const optimalWidth = measureOptimalColumnWidth(c, cells, styles, theme, config.minColumnWidth);
          // Excel: an empty column keeps its current width
          if (optimalWidth === null) continue;
          dispatch(setColumnWidth(c, optimalWidth));
          await setColumnWidthApi(c, optimalWidth);
          emitAppEvent(AppEvents.COLUMN_RESIZED, {
            sheetIndex: sheetContext.activeSheetIndex,
            col: c,
            width: optimalWidth,
          });
          appliedCount++;
        }

        if (appliedCount > 0) {
          await commitUndoTransaction();
        } else {
          await cancelUndoTransaction();
        }
      } catch (err) {
        console.error("Failed to auto-fit columns:", err);
        // Never leave the transaction open — later edits would silently be
        // folded into it
        try {
          await cancelUndoTransaction();
        } catch {
          // already closed
        }
      }

      canvasRef.current?.redraw();
    },
    [selection, config.minColumnWidth, dispatch, canvasRef, sheetContext.activeSheetIndex]
  );

  // -------------------------------------------------------------------------
  // Auto-Fit Row (double-click on resize handle)
  // -------------------------------------------------------------------------
  const handleAutoFitRow = useCallback(
    async (row: number) => {
      const rowsToFit: number[] = [];

      if (selection?.type === "rows") {
        const ranges = [
          {
            start: Math.min(selection.startRow, selection.endRow),
            end: Math.max(selection.startRow, selection.endRow),
          },
          ...(selection.additionalRanges ?? []).map((range) => ({
            start: Math.min(range.startRow, range.endRow),
            end: Math.max(range.startRow, range.endRow),
          })),
        ];
        if (ranges.some((r) => row >= r.start && row <= r.end)) {
          for (const r of ranges) {
            for (let rr = r.start; rr <= r.end; rr++) {
              if (!rowsToFit.includes(rr)) rowsToFit.push(rr);
            }
          }
        } else {
          rowsToFit.push(row);
        }
      } else {
        rowsToFit.push(row);
      }

      try {
        await beginUndoTransaction("Auto-fit rows");
        const styles = await getAllStyles();
        const activeTheme = getActiveGridTheme();
        const theme = { cellFontFamily: activeTheme.cellFontFamily, cellFontSize: activeTheme.cellFontSize };

        for (const r of rowsToFit) {
          const cells = await getCellsInRows(r, r);
          const optimalHeight = measureOptimalRowHeight(
            cells,
            styles,
            dimensions?.columnWidths ?? new Map(),
            config.defaultCellWidth,
            theme,
            config.minRowHeight,
            config.defaultCellHeight,
            r
          );
          // Excel: an empty row resets to the default height
          const targetHeight = optimalHeight ?? config.defaultCellHeight;
          dispatch(setRowHeight(r, targetHeight));
          await setRowHeightApi(r, targetHeight);
          emitAppEvent(AppEvents.ROW_RESIZED, {
            sheetIndex: sheetContext.activeSheetIndex,
            row: r,
            height: targetHeight,
          });
        }

        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to auto-fit rows:", err);
        // Never leave the transaction open — later edits would silently be
        // folded into it
        try {
          await cancelUndoTransaction();
        } catch {
          // already closed
        }
      }

      canvasRef.current?.redraw();
    },
    [selection, dimensions?.columnWidths, config.defaultCellWidth, config.minRowHeight, config.defaultCellHeight, dispatch, canvasRef, sheetContext.activeSheetIndex]
  );

  // -------------------------------------------------------------------------
  // Batch Column/Row Resize (uniform resize for multi-select + drag)
  // -------------------------------------------------------------------------
  const handleBatchColumnResize = useCallback(
    async (cols: number[], width: number) => {
      try {
        await beginUndoTransaction("Resize columns");
        for (const col of cols) {
          dispatch(setColumnWidth(col, width));
          await setColumnWidthApi(col, width);
        }
        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to batch resize columns:", err);
        // Close the transaction (left open, later edits silently join it) and
        // surface the refusal — the optimistic dispatches above are re-synced
        // by the redraw path on the next dimension fetch.
        try { await cancelUndoTransaction(); } catch { /* already closed */ }
        void alertAsync(err instanceof Error ? err.message : String(err));
      }
      canvasRef.current?.redraw();
    },
    [dispatch, canvasRef]
  );

  const handleBatchRowResize = useCallback(
    async (rows: number[], height: number) => {
      try {
        await beginUndoTransaction("Resize rows");
        for (const row of rows) {
          dispatch(setRowHeight(row, height));
          await setRowHeightApi(row, height);
        }
        await commitUndoTransaction();
      } catch (err) {
        console.error("Failed to batch resize rows:", err);
        try { await cancelUndoTransaction(); } catch { /* already closed */ }
        void alertAsync(err instanceof Error ? err.message : String(err));
      }
      canvasRef.current?.redraw();
    },
    [dispatch, canvasRef]
  );

  // -------------------------------------------------------------------------
  // Hide Columns/Rows (drag the header edge to zero width/height)
  //
  // Same authority as the right-click Hide: the backend owns the user-hidden
  // set (persisted, undoable, marks the document dirty). This used to write the
  // reducer directly, which is how a drag-hide survived only until the next
  // sheet switch and never reached the file.
  // -------------------------------------------------------------------------
  const handleHideColumns = useCallback(
    (cols: number[]) => {
      void (async () => {
        try {
          // One undo step for the whole gesture: the drag left the column at
          // ~0 width, so restore a sane width (it would come back as a 1px
          // sliver on unhide) and hide it inside the same transaction.
          await beginUndoTransaction("Hide columns");
          try {
            for (const col of cols) {
              dispatch(setColumnWidth(col, config.defaultCellWidth));
              await setColumnWidthApi(col, config.defaultCellWidth);
            }
            // Reports its own refusal and re-syncs the mirror; never throws.
            await applyColsHidden(cols, true, dispatch);
          } finally {
            // Commit even on a partial failure: cancelling would DISCARD the
            // undo entries for writes that already landed, leaving them
            // permanently un-undoable. An empty transaction commits to nothing.
            await commitUndoTransaction();
          }
        } catch (err) {
          console.error("Failed to hide columns:", err);
          void alertAsync(err instanceof Error ? err.message : String(err));
        }
        canvasRef.current?.redraw();
      })();
    },
    [dispatch, canvasRef, config.defaultCellWidth]
  );

  const handleHideRows = useCallback(
    (rows: number[]) => {
      void (async () => {
        try {
          // See handleHideColumns — restore the dragged-away height and hide in
          // ONE undo step.
          await beginUndoTransaction("Hide rows");
          try {
            for (const row of rows) {
              dispatch(setRowHeight(row, config.defaultCellHeight));
              await setRowHeightApi(row, config.defaultCellHeight);
            }
            await applyRowsHidden(rows, true, dispatch);
          } finally {
            await commitUndoTransaction();
          }
        } catch (err) {
          console.error("Failed to hide rows:", err);
          void alertAsync(err instanceof Error ? err.message : String(err));
        }
        canvasRef.current?.redraw();
      })();
    },
    [dispatch, canvasRef, config.defaultCellHeight]
  );

  // Handle fill handle double-click (auto-fill to edge)
  const handleFillHandleDoubleClick = useCallback(() => {
    autoFillToEdge();
  }, [autoFillToEdge]);

  // Handle DELETE key - clear contents of selection
  const handleDeleteContents = useCallback(async () => {
    if (!selection) {
      console.log("[useSpreadsheetSelection] No selection to clear");
      return;
    }

    // Check if any cell in the selection is edit-guarded (e.g., pivot region)
    const guardResult = await checkEditGuards(selection.endRow, selection.endCol);
    if (guardResult?.blocked) {
      console.log("[useSpreadsheetSelection] Delete blocked by edit guard");
      return;
    }

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    console.log(`[useSpreadsheetSelection] Clearing contents from (${minRow},${minCol}) to (${maxRow},${maxCol})`);

    try {
      const clearedCount = await clearRange(minRow, minCol, maxRow, maxCol);
      console.log(`[useSpreadsheetSelection] Clear contents complete - ${clearedCount} cells cleared`);

      // Sheet grouping: replicate clear to all grouped (non-active) sheets
      if (isSheetGroupingActive()) {
        try {
          await clearRangeOnSheets(getSelectedSheetIndices(), minRow, minCol, maxRow, maxCol);
          console.log("[useSpreadsheetSelection] Replicated clear to grouped sheets");
        } catch (err) {
          console.error("[useSpreadsheetSelection] Failed to replicate clear to grouped sheets:", err);
          // A grouped sheet refusing (protection) means the sheets have now
          // DIVERGED: the active sheet cleared, that one did not. Silence here
          // would leave the user believing the group edit applied everywhere.
          void alertAsync(err instanceof Error ? err.message : String(err));
        }
      }

      // Emit a single event to trigger refresh
      cellEvents.emit({
        row: minRow,
        col: minCol,
        oldValue: undefined,
        newValue: "",
        formula: null,
      });
    } catch (error) {
      // Show spill protection warning (or other backend errors) to the user
      const message = typeof error === "string" ? error : (error as Error)?.message || String(error);
      void alertAsync(message);
    }
  }, [selection]);

  // Shared helper: refresh dimensions from backend and update Redux store.
  // Must be awaited before refreshing the canvas to avoid stale rendering.
  const refreshDimensionsFromBackend = useCallback(async () => {
    try {
      const [colWidths, rowHeights, defaults] = await Promise.all([
        getAllColumnWidths(),
        getAllRowHeights(),
        getDefaultDimensions(),
      ]);
      const columnWidthsMap = new Map<number, number>();
      for (const item of colWidths) {
        columnWidthsMap.set(item.index, item.size);
      }
      const rowHeightsMap = new Map<number, number>();
      for (const item of rowHeights) {
        rowHeightsMap.set(item.index, item.size);
      }
      dispatch(setAllDimensions(columnWidthsMap, rowHeightsMap));
      dispatch(updateConfig({
        defaultCellWidth: defaults.defaultColumnWidth,
        defaultCellHeight: defaults.defaultRowHeight,
      }));
      // A structural restore renumbers the user-hidden indices in the backend
      // too; re-read the mirror or the wrong rows stay hidden.
      await refreshUserHidden(dispatch);
    } catch (error) {
      console.error("[useSpreadsheetSelection] refreshDimensionsFromBackend failed:", error);
    }
  }, [dispatch]);

  // GET.CONTROLVALUE dependents: control/filter state changed (undo/redo of a
  // pane control or ribbon filter) — run a targeted, spill-aware recalc with
  // no name hint (every GET.CONTROLVALUE cell re-evaluates) and apply the
  // results exactly like calculate_now results (refreshCells + redraw + emit).
  const recalcControlValueCells = useCallback(async () => {
    try {
      const updatedCells = await recalcControlDependents();
      if (updatedCells.length === 0) return;

      const canvas = canvasRef.current;
      if (canvas) {
        await canvas.refreshCells();
        canvas.redraw();
      }

      cellEvents.emit({
        row: updatedCells[0].row,
        col: updatedCells[0].col,
        oldValue: undefined,
        newValue: updatedCells[0].display,
        formula: updatedCells[0].formula ?? null,
      });
    } catch (error) {
      console.error("[useSpreadsheetSelection] Control-dependent recalc failed:", error);
    }
  }, [canvasRef]);

  // -------------------------------------------------------------------------
  // FOLLOW A BACKEND-INITIATED SHEET SWITCH
  // -------------------------------------------------------------------------
  //
  // Excel keeps one undo history and switches to the sheet the undone action
  // happened on, so the user sees what changed. The backend performs that
  // switch (it owns the per-sheet mirrors) and reports the result; this is the
  // frontend half, and everything about it is about ATOMICITY.
  //
  // WHY IT REUSES THE TAB-CLICK CHANNEL RATHER THAN INVENTING ONE. A backend
  // switch the frontend follows only partially is worse than no switch at all:
  // it shows one sheet's tab over another sheet's data. The set of things that
  // must move is large and still growing — the tab strip, the grid's sheet
  // context, the canvas's cell cache, column widths, row heights, the
  // user-hidden sets, zoom, split, freeze panes, gridlines, the four display
  // flags, and every extension that keys off the active sheet. All of them
  // already answer to `sheet:beforeSwitch` / `sheet:normalSwitch` /
  // SHEET_CHANGED, because that is what a tab click fires. A second channel
  // would be a second list to keep in step, and the last time per-sheet state
  // had two hydration paths the second one was mount-only and painted sheet 1's
  // frozen panes on sheet 2.
  //
  // WHY IT IS SYNCHRONOUS. There is no `await` between the first dispatch and
  // the last, so React cannot render — and the browser cannot paint — halfway
  // through: the tab highlight, the sheet context and the refresh triggers all
  // land in one batch. The asynchronous parts (dimension re-read, view
  // hydration, cell fetch) are the SAME ones a tab click defers, so this can be
  // no less atomic than the gesture it imitates.
  //
  // Returns whether it actually switched, so the caller can aim the selection
  // at what was restored.
  const followBackendSheetActivation = useCallback(
    (index: number, name: string): boolean => {
      if (index === sheetContext.activeSheetIndex) return false;

      // Save the sheet we are LEAVING (selection + scroll), exactly as a tab
      // click does, or coming back lands at A1 with the scroll thrown away.
      window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
        detail: { oldSheetIndex: sheetContext.activeSheetIndex, newSheetIndex: index },
      }));

      // The grid's sheet context. The tab strip has no state of its own to
      // update: it syncs its highlight from this.
      dispatch(setActiveSheetAction(index, name));

      // The grid data + every piece of per-sheet chrome.
      window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
        detail: { newSheetIndex: index, newSheetName: name },
      }));

      // Extensions (AutoFilter, Grouping, Protection, ...).
      emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: index, sheetName: name });
      return true;
    },
    [dispatch, sheetContext.activeSheetIndex]
  );

  // -------------------------------------------------------------------------
  // WHAT A RESTORE DOES TO THE VIEW — one implementation for undo AND redo
  // -------------------------------------------------------------------------
  //
  // These two bodies were byte-identical apart from the word "undo"/"redo" in
  // one event payload, and that is not a tidiness observation: every gap this
  // path has ever had was added to one of them and forgotten in the other, and
  // the last two guards written for it (`redoing_an_off_sheet_set_cell_...`,
  // `redoing_a_named_range_definition_...`) exist precisely because "redo is
  // the same function" kept turning out not to be true. Sheet activation is one
  // more thing that has to happen in both, so there is now one place for it.
  const applyRestoreToTheView = useCallback(
    async (result: UndoResult, source: "undo" | "redo") => {
      // THE SHEET FIRST, before anything is repainted or announced.
      //
      // The backend has already switched (Excel's rule: an undo happens on the
      // sheet the action happened on, and it switches there so you can see it),
      // so from this moment every backend read answers about the NEW sheet.
      // Following it first means the dimension re-read, the cell fetch and the
      // domain refreshes below all describe the same sheet the tab strip does.
      // Doing it later would repaint the new sheet's cells under the old
      // sheet's chrome for one frame.
      //
      // BUG-0052: prime the canvas with the target sheet's viewport BEFORE the
      // follow, so the tab strip and the grid commit in ONE paint. The await
      // sits strictly BEFORE the first dispatch — the follow's own
      // beforeSwitch -> context -> normalSwitch -> SHEET_CHANGED sequence
      // stays free of awaits, which is the atomicity §13 pinned. While the
      // prime is in flight the screen still shows the old sheet consistently.
      // Guarded by the same "did the backend actually move" test the follow
      // makes, so a same-sheet undo — the common case — fetches nothing.
      if (result.activeSheetIndex !== sheetContext.activeSheetIndex) {
        await primeSheetSwitch(result.activeSheetIndex);
      }
      const switched = followBackendSheetActivation(
        result.activeSheetIndex,
        result.activeSheetName,
      );

      // AIM THE VIEW AT WHAT CHANGED — only when the sheet moved, and in the
      // SAME synchronous batch as the switch.
      //
      // Switching sheets is only half of "so the user can see what changed":
      // the restored cells can be anywhere on a sheet that was left scrolled
      // somewhere else, and landing on that sheet's saved selection would show
      // a sheet with no visible evidence of the undo. Excel selects the range
      // an undo restored; this does the same for the switch case.
      //
      // It has to be dispatched HERE rather than after the awaits below: the
      // switch itself restores the target sheet's saved selection, so a later
      // dispatch would render that selection first and replace it a frame
      // later — a visible jump. The SCROLL is deferred (see below) because a
      // structural restore changes the dimensions it has to measure against.
      //
      // Deliberately NOT done when the sheet did not move: a same-sheet undo
      // has never moved the selection, several E2E journeys depend on where the
      // cursor is after Ctrl+Z, and widening that is a separate decision.
      const anchor = switched ? result.restoredAnchor : null;
      if (anchor) {
        dispatch(setSelectionAction({
          startRow: anchor.row,
          startCol: anchor.col,
          endRow: anchor.row,
          endCol: anchor.col,
          type: "cells",
        }));
      }

      // For structural restores (insert/delete rows/cols undo), refresh dimensions
      // IMPORTANT: await before refreshing cells so canvas renders with correct dimensions
      // hiddenChanged: a hide/unhide undo changes NOTHING in updatedCells —
      // visibility is not a cell value — so without a re-read the row stays
      // hidden on screen while the backend considers it visible. Sizes come
      // along because a drag-hide restores the row height in the same step.
      if (result.structuralRestore || result.mergeChanged || result.hiddenChanged) {
        await refreshDimensionsFromBackend();
      }

      // Trigger canvas refresh
      const canvas = canvasRef.current;
      if (canvas) {
        await canvas.refreshCells();
        canvas.redraw();
      }

      // Refresh style cache (undo may revert formatting changes)
      // Notify extensions about structural change so they can update their state
      if (result.structuralRestore) {
        emitAppEvent(AppEvents.STRUCTURAL_UNDO, { description: result.description });
      }

      // Report the change DOMAINS this restore touched and let the Shell
      // translator fan out to the concrete per-feature refresh events. Core
      // stays feature-agnostic — no pivot:refresh/slicers:refresh/... literals
      // here. The backend reports the domains; Core no longer re-derives them
      // from a ladder of booleans. That ladder was the reason the NON-CELL
      // domains announced nothing on undo: adding one meant editing a Rust
      // struct, a TS interface and this list in step, and outline / hyperlinks /
      // validations / annotations / controls never were. ("styles" is always
      // included: undo can re-apply formatting, and no restore kind reports it.)
      const domains: MutationDomain[] = [
        "styles",
        ...((result.refreshDomains ?? []) as MutationDomain[]),
      ];
      emitAppEvent(AppEvents.MUTATION_REFRESH, { domains, source });

      // Control/filter state restored: recalc GET.CONTROLVALUE dependents
      // (fire-and-forget; repaints when done).
      if (domains.includes("ribbonFilter") || domains.includes("paneControl")) {
        void recalcControlValueCells();
      }

      // ...and only now scroll to it: the dimensions a structural restore
      // changed have been re-read above, so the measurement is against the
      // geometry the user is actually looking at. `scrollToCell`, not
      // `scrollToSelection` — the latter reads the selection out of state,
      // which React has not necessarily committed yet, so it would scroll to
      // where the cursor used to be.
      if (anchor) {
        scrollToCell(anchor.row, anchor.col, false);
      }

      // Emit event to update any listeners (e.g., formula bar).
      // ACTIVE-SHEET cells only. Now that a restore reports which sheet it
      // wrote, an undo of an off-sheet edit can put a foreign cell first in
      // the list, and the formula bar has no sheet dimension — it would show
      // another sheet's content against the current selection.
      const firstCell = result.updatedCells.find(
        (c) => c.sheetIndex === null || c.sheetIndex === undefined
      );
      if (firstCell) {
        cellEvents.emit({
          row: firstCell.row,
          col: firstCell.col,
          oldValue: undefined,
          newValue: firstCell.display,
          formula: firstCell.formula || null,
        });
      }
    },
    [
      canvasRef,
      dispatch,
      followBackendSheetActivation,
      refreshDimensionsFromBackend,
      recalcControlValueCells,
      scrollToCell,
      sheetContext.activeSheetIndex,
    ]
  );

  // Handle Undo (Ctrl+Z)
  const handleUndo = useCallback(async () => {
    console.log("[useSpreadsheetSelection] Undo requested");
    try {
      const result = await undoApi();
      console.log(`[useSpreadsheetSelection] Undo complete - ${result.updatedCells.length} cells updated, structural=${result.structuralRestore}`);
      await applyRestoreToTheView(result, "undo");
    } catch (error) {
      console.error("[useSpreadsheetSelection] Undo failed:", error);
    }
  }, [applyRestoreToTheView]);

  // Handle Redo (Ctrl+Y or Ctrl+Shift+Z)
  const handleRedo = useCallback(async () => {
    console.log("[useSpreadsheetSelection] Redo requested");
    try {
      const result = await redoApi();
      console.log(`[useSpreadsheetSelection] Redo complete - ${result.updatedCells.length} cells updated, structural=${result.structuralRestore}`);
      await applyRestoreToTheView(result, "redo");
    } catch (error) {
      console.error("[useSpreadsheetSelection] Redo failed:", error);
    }
  }, [applyRestoreToTheView]);

  // FIX: Wrapper for extendTo that uses merge expansion during drag
  // This is passed to useMouseSelection for drag operations
  const handleExtendTo = useCallback(
    (row: number, col: number) => {
      // Use merge-aware extension for drag selection
      // The async nature is fine - selection will update when promise resolves
      extendToWithMergeExpansion(row, col);
    },
    [extendToWithMergeExpansion]
  );

  // External formula edit session routing (formulaEditTarget seam): while a
  // registered external target is expecting a reference, grid picks go to it
  // instead of the internal editor. The ref carries the ACTIVE sheet's name so
  // the target can always produce a sheet-qualified reference (its formula
  // lives outside this sheet's A1 space). The pending-reference preview that
  // was synced into formulaReferences during the pick is cleared here because
  // the internal insert (which normally replaces it) never runs.
  const handleInsertReference = useCallback(
    (row: number, col: number) => {
      const externalTarget = getExternalFormulaTarget();
      if (externalTarget?.isExpectingReference()) {
        externalTarget.insertReference({
          sheetName: sheetContext.activeSheetName,
          startRow: row,
          startCol: col,
          endRow: row,
          endCol: col,
        });
        dispatch(clearFormulaReferences());
        return;
      }
      insertReference(row, col);
    },
    [insertReference, dispatch, sheetContext.activeSheetName]
  );

  const handleInsertRangeReference = useCallback(
    (startRow: number, startCol: number, endRow: number, endCol: number) => {
      const externalTarget = getExternalFormulaTarget();
      if (externalTarget?.isExpectingReference()) {
        // Normalized so targets need not care about drag direction
        externalTarget.insertReference({
          sheetName: sheetContext.activeSheetName,
          startRow: Math.min(startRow, endRow),
          startCol: Math.min(startCol, endCol),
          endRow: Math.max(startRow, endRow),
          endCol: Math.max(startCol, endCol),
        });
        dispatch(clearFormulaReferences());
        return;
      }
      insertRangeReference(startRow, startCol, endRow, endCol);
    },
    [insertRangeReference, dispatch, sheetContext.activeSheetName]
  );

  const {
    isDragging,
    isFormulaDragging,
    isResizing,
    isRefDragging,
    isRefResizing,
    isSelectionDragging,
    isOverlayResizing,
    selectionDragPreview,
    selectionDragMode,
    cursorStyle,
    handleMouseDown: baseHandleMouseDown,
    handleMouseMove: baseHandleMouseMove,
    handleMouseUp: baseHandleMouseUp,
    handleDoubleClick: getDoubleClickCell,
    isOverFloatingOverlay,
  } = useMouseSelection({
    containerRef,
    scrollRef,
    config,
    viewport,
    selection,
    dimensions,
    freezeConfig: effectiveFreezeConfig,
    splitBarSize: effectiveSplitBarSize,
    splitViewport: effectiveSplitViewport,
    isFormulaMode,
    formulaReferences,
    currentSheetName: sheetContext.activeSheetName,
    formulaSourceSheetName: state.editing?.sourceSheetName,
    onSelectCell: selectCell,
    onAddToSelection: addCellToSelection,
    onExtendTo: handleExtendTo,  // FIX: Use merge-aware extension for drag selection
    onScroll: handleScrollUpdate,
    onDragEnd: handleDragEnd,
    onInsertReference: handleInsertReference,
    onInsertFormulaText: insertFormulaText,
    onInsertRangeReference: handleInsertRangeReference,
    onInsertColumnReference: insertColumnReference,
    onInsertColumnRangeReference: insertColumnRangeReference,
    onInsertRowReference: insertRowReference,
    onInsertRowRangeReference: insertRowRangeReference,
    onUpdatePendingReference: updatePendingReference,
    onUpdatePendingColumnReference: updatePendingColumnReference,
    onUpdatePendingRowReference: updatePendingRowReference,
    onClearPendingReference: clearPendingReference,
    onCommitBeforeSelect: onCommitBeforeSelect,
    onColumnResize: handleColumnResize,
    onRowResize: handleRowResize,
    onAutoFitColumn: handleAutoFitColumn,
    onAutoFitRow: handleAutoFitRow,
    onBatchColumnResize: handleBatchColumnResize,
    onBatchRowResize: handleBatchRowResize,
    onHideColumns: handleHideColumns,
    onHideRows: handleHideRows,
    onSelectColumn: selectColumn,
    onSelectRow: selectRow,
    onFillHandleDoubleClick: handleFillHandleDoubleClick,
    onStartRefDrag: startRefDrag,
    onUpdateRefDrag: updateRefDrag,
    onCompleteRefDrag: completeRefDrag,
    onCancelRefDrag: cancelRefDrag,
    onStartRefResize: startRefResize,
    onUpdateRefResize: updateRefResize,
    onCompleteRefResize: completeRefResize,
    onCancelRefResize: cancelRefResize,
    onMoveCells: moveCells,
    onMoveRows: moveRows,
    onMoveColumns: moveColumns,
    onCopyCells: copyCellsDrag,
    onCopyRows: copyRowsDrag,
    onCopyColumns: copyColumnsDrag,
    zoom: state.zoom,
  });

  // Wrap mouse handlers to include fill handle logic and extension click interception
  const handleMouseDown = useCallback(
    async (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const z = state.zoom;
      const mouseX = (event.clientX - rect.left) / z;
      const mouseY = (event.clientY - rect.top) / z;

      // Check if clicking on fill handle
      if (isOverFillHandle(mouseX, mouseY)) {
        event.preventDefault();
        startFillDrag(mouseX, mouseY);
        return;
      }

      // Check if clicking on a floating overlay (e.g., chart) - skip cell interceptor logic
      // and go directly to baseHandleMouseDown which handles overlay move/resize
      if (isOverFloatingOverlay(mouseX, mouseY)) {
        baseHandleMouseDown(event);
        return;
      }

      // Get cell from click position to check for extension click interceptors.
      //
      // THE PANE OPTIONS ARE NOT OPTIONAL. Without them getCellFromPixel maps
      // the pixel as if nothing were frozen, so with a frozen header row (or a
      // split) every interceptor — the note editor, the validation dropdown,
      // the hyperlink follow, a button cell — was handed a DIFFERENT cell from
      // the one the click actually selected, and acted on it. Every other
      // caller of this function already passes them; this one did not.
      const { getCellFromPixel } = await import("../../lib/gridRenderer");
      const clickedCell = getCellFromPixel(mouseX, mouseY, state.config, state.viewport, state.dimensions, {
        freezeConfig: effectiveFreezeConfig,
        splitBarSize: effectiveSplitBarSize,
        splitViewport: effectiveSplitViewport,
      });

      // FIX: Track if mouseup occurs during the async interceptor check.
      // Without this, a fast click-release can leave isDragging stuck at true:
      // 1. mousedown → async interceptor check starts
      // 2. mouseup fires → isDragging is still false → nothing cleaned up
      // 3. interceptor check completes → baseHandleMouseDown sets isDragging=true
      // 4. drag state is stuck because mouseup already fired
      let mouseUpDuringAsyncCheck = false;
      const onEarlyMouseUp = () => { mouseUpDuringAsyncCheck = true; };
      window.addEventListener("mouseup", onEarlyMouseUp, { once: true });

      if (clickedCell && !isEditing) {
        // Let extensions intercept the click (e.g., pivot filter dropdowns)
        // Skip when editing so formula cell references work normally
        const intercepted = await checkCellClickInterceptors(
          clickedCell.row,
          clickedCell.col,
          { clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey, metaKey: event.metaKey }
        );
        if (intercepted) {
          window.removeEventListener("mouseup", onEarlyMouseUp);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      window.removeEventListener("mouseup", onEarlyMouseUp);

      // FIX: Await baseHandleMouseDown so that drag state (isDragging, refs) is fully
      // initialized before we check mouseUpDuringAsyncCheck. Without await, the async
      // operations inside baseHandleMouseDown (onCommitBeforeSelect, getMergeInfo) haven't
      // completed yet, so isDragging is still false when baseHandleMouseUp runs — leaving
      // the drag state stuck and causing "sticky shift" selection behavior.
      await baseHandleMouseDown(event);

      // If mouseup already occurred during the async gap, immediately end the drag
      // so the drag state doesn't get stuck. The cell selection still happened above.
      if (mouseUpDuringAsyncCheck) {
        baseHandleMouseUp();
      }
    },
    [baseHandleMouseDown, baseHandleMouseUp, isOverFillHandle, startFillDrag, isOverFloatingOverlay, isEditing, state.config, state.viewport, state.dimensions, state.zoom, effectiveFreezeConfig, effectiveSplitBarSize, effectiveSplitViewport]
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const z = state.zoom;
      const mouseX = (event.clientX - rect.left) / z;
      const mouseY = (event.clientY - rect.top) / z;

      // Handle fill drag
      if (fillState.isDragging) {
        updateFillDrag(mouseX, mouseY);
        return;
      }

      baseHandleMouseMove(event);
    },
    [baseHandleMouseMove, fillState.isDragging, updateFillDrag, state.zoom]
  );

  const handleMouseUp = useCallback(() => {
    // Complete fill if dragging
    if (fillState.isDragging) {
      completeFill();
      return;
    }

    baseHandleMouseUp();
  }, [baseHandleMouseUp, fillState.isDragging, completeFill]);

  // Get cursor style including fill handle
  const getCursorStyle = useCallback((): string => {
    if (fillState.isDragging) {
      return "crosshair";
    }
    return cursorStyle;
  }, [fillState.isDragging, cursorStyle]);

  // Global mouse handlers for fill handle dragging
  // This allows fill drag to continue even when mouse leaves the canvas
  useEffect(() => {
    if (!fillState.isDragging) return;

    const handleGlobalMouseMove = (event: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const z = state.zoom;
      const mouseX = (event.clientX - rect.left) / z;
      const mouseY = (event.clientY - rect.top) / z;
      updateFillDrag(mouseX, mouseY);
    };

    const handleGlobalMouseUp = () => {
      completeFill();
    };

    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [fillState.isDragging, containerRef, updateFillDrag, completeFill, state.zoom]);

  // -------------------------------------------------------------------------
  // Command handler for formatting, fill, and data entry shortcuts
  // -------------------------------------------------------------------------

  /**
   * Helper: Get rows and cols arrays from the current selection.
   */
  const getSelectionRowsCols = useCallback((): { rows: number[]; cols: number[] } | null => {
    if (!selection) return null;
    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = minRow; r <= maxRow; r++) rows.push(r);
    for (let c = minCol; c <= maxCol; c++) cols.push(c);
    return { rows, cols };
  }, [selection]);

  /**
   * Helper: Apply formatting to the current selection and refresh canvas.
   */
  const applyFormattingToSelection = useCallback(async (formatting: FormattingOptions) => {
    const rc = getSelectionRowsCols();
    if (!rc) return;

    try {
      await applyFormatting(rc.rows, rc.cols, formatting);

      // Refresh canvas to show updated styles
      const canvas = canvasRef.current;
      if (canvas) {
        await canvas.refreshCells();
        canvas.redraw();
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] applyFormatting failed:", error);
    }
  }, [getSelectionRowsCols, canvasRef]);

  /**
   * Helper: Toggle a boolean formatting property (bold, italic, underline, strikethrough).
   * Reads the active cell's current style to determine the toggle direction.
   * If the active cell has the property ON, turns it OFF for the entire selection (and vice versa).
   */
  const toggleFormatProperty = useCallback(async (property: "bold" | "italic" | "underline" | "strikethrough") => {
    if (!selection) return;

    try {
      // Read the active cell's style to determine current state
      const activeCell = await getCell(selection.startRow, selection.startCol);
      const styleIndex = activeCell?.styleIndex ?? 0;
      const style = await getStyle(styleIndex);

      const formatting: FormattingOptions = {};

      if (property === "underline") {
        // Underline uses UnderlineStyle enum: toggle between "none" and "single"
        formatting.underline = style.underline !== "none" ? "none" : "single";
      } else {
        // Boolean properties: toggle the current state
        const currentValue = style[property] as boolean;
        formatting[property] = !currentValue;
      }

      await applyFormattingToSelection(formatting);
    } catch (error) {
      console.error(`[useSpreadsheetSelection] toggleFormatProperty(${property}) failed:`, error);
    }
  }, [selection, applyFormattingToSelection]);

  /**
   * Handle Ctrl+D - Fill Down.
   * Copies the contents and format of the topmost cell in the selection to cells below.
   */
  const handleFillDown = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Need at least 2 rows selected
    if (maxRow <= minRow) return;

    try {
      // Single IPC call: source = first row, target = rows below
      const updatedCells = await fillRange(
        minRow, minCol, minRow, maxCol,       // source: first row
        minRow + 1, minCol, maxRow, maxCol,   // target: rows below
      );

      if (updatedCells.length > 0) {
        cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Fill Down failed:", error);
    }
  }, [selection]);

  /**
   * Handle Ctrl+R - Fill Right.
   * Copies the contents and format of the leftmost cell in the selection to cells to the right.
   */
  const handleFillRight = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Need at least 2 columns selected
    if (maxCol <= minCol) return;

    try {
      // Single IPC call: source = first column, target = columns to the right
      const updatedCells = await fillRange(
        minRow, minCol, maxRow, minCol,       // source: first column
        minRow, minCol + 1, maxRow, maxCol,   // target: columns to the right
      );

      if (updatedCells.length > 0) {
        cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Fill Right failed:", error);
    }
  }, [selection]);

  /**
   * Handle Fill Up.
   * Copies the contents and format of the bottommost cell in the selection to cells above.
   */
  const handleFillUp = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Need at least 2 rows selected
    if (maxRow <= minRow) return;

    try {
      // Single IPC call: source = last row, target = rows above
      const updatedCells = await fillRange(
        maxRow, minCol, maxRow, maxCol,       // source: last row
        minRow, minCol, maxRow - 1, maxCol,   // target: rows above
      );

      if (updatedCells.length > 0) {
        cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Fill Up failed:", error);
    }
  }, [selection]);

  /**
   * Handle Fill Left.
   * Copies the contents and format of the rightmost cell in the selection to cells to the left.
   */
  const handleFillLeft = useCallback(async () => {
    if (!selection) return;

    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);

    // Need at least 2 columns selected
    if (maxCol <= minCol) return;

    try {
      // Single IPC call: source = last column, target = columns to the left
      const updatedCells = await fillRange(
        minRow, maxCol, maxRow, maxCol,       // source: last column
        minRow, minCol, maxRow, maxCol - 1,   // target: columns to the left
      );

      if (updatedCells.length > 0) {
        cellEvents.emitBatch(updatedCells.map(cellToChange), "fill");
      }
    } catch (error) {
      console.error("[useSpreadsheetSelection] Fill Left failed:", error);
    }
  }, [selection]);

  // Register fill commands as grid commands (for menu execution via CommandRegistry)
  useEffect(() => {
    gridCommands.register("fillDown", handleFillDown);
    gridCommands.register("fillRight", handleFillRight);
    gridCommands.register("fillUp", handleFillUp);
    gridCommands.register("fillLeft", handleFillLeft);

    return () => {
      gridCommands.unregister("fillDown");
      gridCommands.unregister("fillRight");
      gridCommands.unregister("fillUp");
      gridCommands.unregister("fillLeft");
    };
  }, [handleFillDown, handleFillRight, handleFillUp, handleFillLeft]);

  // Register undo/redo with CommandRegistry so keybindings and menu items work.
  // The keybindings system (capture phase) routes Ctrl+Z/Y to CommandRegistry,
  // so these handlers MUST be registered here for undo/redo to function.
  useEffect(() => {
    CommandRegistry.register(CoreCommands.UNDO, handleUndo);
    CommandRegistry.register(CoreCommands.REDO, handleRedo);

    return () => {
      CommandRegistry.unregister(CoreCommands.UNDO);
      CommandRegistry.unregister(CoreCommands.REDO);
    };
  }, [handleUndo, handleRedo]);

  /**
   * Handle inserting current date into the active cell.
   */
  const handleInsertDate = useCallback(async () => {
    if (!selection) return;

    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();
    const dateStr = `${month}/${day}/${year}`;

    try {
      await updateCell(selection.startRow, selection.startCol, dateStr);

      cellEvents.emit({
        row: selection.startRow,
        col: selection.startCol,
        oldValue: undefined,
        newValue: dateStr,
        formula: null,
      });
    } catch (error) {
      console.error("[useSpreadsheetSelection] Insert date failed:", error);
    }
  }, [selection]);

  /**
   * Handle inserting current time into the active cell.
   */
  const handleInsertTime = useCallback(async () => {
    if (!selection) return;

    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const timeStr = `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;

    try {
      await updateCell(selection.startRow, selection.startCol, timeStr);

      cellEvents.emit({
        row: selection.startRow,
        col: selection.startCol,
        oldValue: undefined,
        newValue: timeStr,
        formula: null,
      });
    } catch (error) {
      console.error("[useSpreadsheetSelection] Insert time failed:", error);
    }
  }, [selection]);

  /**
   * Central command handler for keyboard shortcuts.
   * Dispatches formatting, fill, and data entry commands.
   */
  const handleCommand = useCallback(async (command: string) => {
    switch (command) {
      // Font style toggles
      case 'format.toggleBold':
        await toggleFormatProperty('bold');
        break;
      case 'format.toggleItalic':
        await toggleFormatProperty('italic');
        break;
      case 'format.toggleUnderline':
        await toggleFormatProperty('underline');
        break;
      case 'format.toggleStrikethrough':
        await toggleFormatProperty('strikethrough');
        break;

      // Number format shortcuts
      case 'format.numberGeneral':
        await applyFormattingToSelection({ numberFormat: 'general' });
        break;
      case 'format.numberCurrency':
        await applyFormattingToSelection({ numberFormat: 'currency_usd' });
        break;
      case 'format.numberPercentage':
        await applyFormattingToSelection({ numberFormat: 'percentage' });
        break;
      case 'format.numberScientific':
        await applyFormattingToSelection({ numberFormat: 'scientific' });
        break;
      case 'format.numberDate':
        await applyFormattingToSelection({ numberFormat: 'date_us' });
        break;
      case 'format.numberTime':
        await applyFormattingToSelection({ numberFormat: 'time_12h' });
        break;
      case 'format.numberNumber':
        await applyFormattingToSelection({ numberFormat: 'number_sep' });
        break;

      // Data entry
      case 'edit.insertDate':
        await handleInsertDate();
        break;
      case 'edit.insertTime':
        await handleInsertTime();
        break;

      // Fill
      case 'edit.fillDown':
        await handleFillDown();
        break;
      case 'edit.fillRight':
        await handleFillRight();
        break;
      case 'edit.fillUp':
        await handleFillUp();
        break;
      case 'edit.fillLeft':
        await handleFillLeft();
        break;

      // Paste Special
      case 'clipboard.pasteSpecial':
        await CommandRegistry.execute('core.clipboard.pasteSpecial');
        break;

      // Show Formulas toggle
      case 'view.toggleShowFormulas': {
        const currentShowFormulas = state.showFormulas;
        emitAppEvent(AppEvents.SHOW_FORMULAS_TOGGLED, { showFormulas: !currentShowFormulas });
        emitAppEvent(AppEvents.GRID_REFRESH);
        break;
      }

      // Display Zeros toggle
      case 'view.toggleDisplayZeros': {
        const currentDisplayZeros = state.displayZeros;
        emitAppEvent(AppEvents.DISPLAY_ZEROS_TOGGLED, { displayZeros: !currentDisplayZeros });
        emitAppEvent(AppEvents.GRID_REFRESH);
        break;
      }

      // Navigate: Focus Name Box (F5)
      case 'navigate.focusNameBox':
        emitAppEvent(AppEvents.NAMEBOX_FOCUS);
        break;

      // Calculate Now (F9) — the WORKBOOK — and Calculate Sheet (Shift+F9) —
      // the active sheet. EXCEL PARITY: those are Excel's two manual
      // recalculations, and they differ only in scope, so they share one
      // handler and differ only in which backend command they invoke.
      case 'calculate.now':
      case 'calculate.sheet': {
        const workbookScope = command === 'calculate.now';
        const label = workbookScope ? 'Calculate Now' : 'Calculate Sheet';
        try {
          const updatedCells = workbookScope ? await calculateNow() : await calculateSheet();
          console.log(`[useSpreadsheetSelection] ${label} - ${updatedCells.length} cells updated`);

          // Refresh canvas to show updated values. Both commands return the
          // ACTIVE sheet's cells only; a workbook pass's off-sheet writes are
          // picked up when that sheet is next fetched, which every sheet switch
          // does anyway.
          const canvas = canvasRef.current;
          if (canvas) {
            await canvas.refreshCells();
            canvas.redraw();
          }

          // Emit event to update formula bar etc.
          if (updatedCells.length > 0) {
            cellEvents.emit({
              row: updatedCells[0].row,
              col: updatedCells[0].col,
              oldValue: undefined,
              newValue: updatedCells[0].display,
              formula: updatedCells[0].formula ?? null,
            });
          }
        } catch (error) {
          console.error(`[useSpreadsheetSelection] ${label} failed:`, error);
        }
        break;
      }

      // Insert Chart (F11) - emit command for Charts extension to handle
      case 'insert.chart':
        await CommandRegistry.execute('charts.insertChart');
        break;

      // Toggle Ribbon minimize (Ctrl+F1)
      case 'view.toggleRibbon':
        emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE);
        break;

      default:
        console.warn(`[useSpreadsheetSelection] Unknown command: ${command}`);
    }
  }, [toggleFormatProperty, applyFormattingToSelection, handleInsertDate, handleInsertTime, handleFillDown, handleFillRight, handleFillUp, handleFillLeft, state.showFormulas, state.displayZeros, canvasRef]);

  // Keyboard handling with clipboard shortcuts, ESC to clear clipboard, DELETE to clear contents, and undo/redo
  // FIX: Use focusContainerRef instead of containerRef for keyboard events
  // The focusContainerRef points to the focusable outer container that receives keyboard events
  // FIX: Don't use isEditing in enabled prop - it's stale React state after commit.
  // useGridKeyboard internally checks getGlobalIsEditing() synchronously in handleKeyDown,
  // which correctly reflects the current editing state.
  useGridKeyboard({
    containerRef: focusContainerRef,
    enabled: isFocused,
    onClearClipboard: clearClipboardState,
    hasClipboardContent: clipboardMode !== "none",
    onDelete: handleDeleteContents,
    onSelectColumn: selectColumn,
    onSelectRow: selectRow,
    onCommand: handleCommand,
  });

  /**
   * Handle double-click to start editing.
   * FIX: Call startEdit directly with the clicked cell coordinates.
   * This avoids the stale state issue where startEditing reads from
   * state.selection before React has updated it from the prior
   * selectCellWithMergeExpansion call.
   * startEdit will internally resolve to the master cell if this
   * cell is part of a merged region.
   */
  const handleDoubleClickEvent = useCallback(
    async (event: React.MouseEvent<HTMLDivElement>) => {
      const cell = getDoubleClickCell(event);
      if (cell) {
        // Check if any extension intercepts the double-click (e.g., pivot expand/collapse)
        const intercepted = await checkCellDoubleClickInterceptors(
          cell.row,
          cell.col,
          { clientX: event.clientX, clientY: event.clientY }
        );
        if (intercepted) {
          return;
        }

        // Synchronous guard: block editing in protected ranges (e.g., pivot tables)
        const rangeGuard = checkRangeGuards(cell.row, cell.col, cell.row, cell.col);
        if (rangeGuard?.blocked) return;

        // First expand selection to cover merged region (for visual feedback)
        await selectCellWithMergeExpansion(cell.row, cell.col);
        // FIX: Call startEdit directly with the clicked coordinates
        // startEdit will resolve to master cell and fetch content correctly
        // This avoids the stale closure issue where startEditing reads old state
        await startEdit(cell.row, cell.col);
      }
    },
    [getDoubleClickCell, selectCellWithMergeExpansion, startEdit]
  );

  return {
    selectedCellContent,
    setSelectedCellContent,
    mouseHandlers: {
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      cursorStyle: getCursorStyle(),
    },
    mouseState: {
      isDragging,
      isFormulaDragging,
      isResizing,
      isRefDragging,
      isRefResizing,
      isSelectionDragging,
      isOverlayResizing,
      isFillDragging: fillState.isDragging,
    },
    fillState,
    selectionDragPreview,
    selectionDragMode,
    clipboardHandlers: {
      cut,
      copy,
      paste,
    },
    clipboardState: {
      mode: clipboardMode,
      selection: clipboardSelection,
    },
    handleDoubleClickEvent,
    getSelectionReference,
    selectCell,
    moveActiveCell,
    scrollToSelection,
  };
}