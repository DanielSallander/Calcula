//! FILENAME: app/src/shell/SheetTabs/SheetTabs.tsx
// PURPOSE: Sheet tabs component for switching between worksheets
// CONTEXT: Enhanced to support sheet switching during formula editing without page reload.
//          Key fix: Uses global flag to prevent blur commit during formula mode navigation.
// REFACTOR: Imports from api layer instead of core internals to comply with architecture rules.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  // Tauri API functions
  getSheets,
  setActiveSheetApi,
  addSheet,
  deleteSheet,
  renameSheet,
  moveSheet,
  copySheet,
  hideSheet,
  unhideSheet,
  setTabColor,
  // Extension registry
  sheetExtensions,
  registerCoreSheetContextMenu,
  // State hooks and actions
  useGridContext,
  setActiveSheet,
  setSheetContext,
  // Events
  emitAppEvent,
  AppEvents,
  // Types and utilities
  isFormulaExpectingReference,
  // Sheet grouping
  setSelectedSheetIndices,
  clearSheetGrouping,
  toggleSheetInGroup,
  isSheetGroupingActive,
  getSelectedSheetIndices,
  // Sheet-switch prefetch (BUG-0052)
  primeSheetSwitch,
  // Extension-contributed tab marks (subscribed sheets, and whatever comes next)
  getSheetTabDecorations,
  onSheetTabDecorationsChanged,
  MAX_SHEET_TAB_DECORATION_GLYPHS,
} from "../../api";
import { isGlobalFormulaMode, getGlobalCursorPosition } from "../../api/editing";
import type {
  SheetInfo,
  SheetsResult,
  SheetContext,
  ResolvedSheetContextMenuItem,
} from "../../api";
import * as S from './SheetTabs.styles';
import { alertAsync, promptAsync } from "@api/dialogs";

export interface SheetTabsProps {
  onSheetChange?: (sheetIndex: number, sheetName: string) => void;
}

// Register core context menu items once
let coreMenuRegistered = false;

/**
 * The sheet a TRUE workbook index names — by the `index` FIELD, never by list
 * position.
 *
 * `getSheets()` omits object-backed sheets (a floating range's cell store) from
 * the list while keeping every row's true state-vector index
 * (`build_sheet_list`, sheets.rs). `sheets[i].index === i` therefore holds only
 * while every object sheet sits at the tail — an invariant `add_sheet_inner`
 * maintains and which a `.calp` pull, a drill-through sheet and a report-pages
 * sheet all break by appending PAST it.
 *
 * Every index this component handles is a true one: `activeIndex` is
 * `state.active_sheet`, and the tabs pass `sheet.index`. So a subscript here is
 * wrong the moment a workbook has both a floating range and pulled sheets, and
 * wrong SILENTLY — it returns a real sheet, just not that one. It named the
 * wrong tab in the detach confirm while the command detached the right one,
 * broadcast `SHEET_CHANGED` with one sheet's index and another's name, and
 * built `Sheet1:Detail!` for a shift-click on KPIs.
 */
const sheetAt = (sheets: SheetInfo[], index: number): SheetInfo | undefined =>
  sheets.find((s) => s.index === index);

export function SheetTabs({ onSheetChange }: SheetTabsProps): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const { editing, sheetContext } = state;

  const [sheets, setSheets] = useState<SheetInfo[]>([{ index: 0, name: "Sheet1", visibility: "visible" as const }]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sheet grouping: tracks which sheets are selected (Ctrl+Click)
  const [groupedSheets, setGroupedSheets] = useState<Set<number>>(new Set());

  // Bumped when an extension registers a tab mark or says its answer changed.
  // The strip renders once; extensions activate AFTER it mounts, and a .calp
  // pull can land while it is up — neither has any other way to reach these
  // pixels. (Same shape as ActivityBar's script-presence tick.)
  const [decorationTick, setDecorationTick] = useState(0);
  useEffect(
    () => onSheetTabDecorationsChanged(() => setDecorationTick((t) => t + 1)),
    [],
  );

  // Sync local activeIndex with Redux state when it changes from outside
  // This handles the case when commitEdit switches back to the source sheet
  useEffect(() => {
    if (sheetContext.activeSheetIndex !== activeIndex && !isLoading) {
      console.log("[SheetTabs] Syncing activeIndex with Redux:", sheetContext.activeSheetIndex);
      setActiveIndex(sheetContext.activeSheetIndex);
    }
  }, [sheetContext.activeSheetIndex, activeIndex, isLoading]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sheetIndex: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Unhide dialog state
  const [unhideDialog, setUnhideDialog] = useState<{
    hiddenSheets: SheetInfo[];
    selectedIndex: number | null;
  } | null>(null);

  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    index: number;
    name: string;
  } | null>(null);

  // Drag-to-reorder state
  const [dragState, setDragState] = useState<{
    dragging: boolean;
    sourceIndex: number;
    currentIndex: number;
    startX: number;
  } | null>(null);
  const tabsAreaRef = useRef<HTMLDivElement>(null);

  // Tab scroll state: how many tabs are hidden on each side
  const [hiddenLeft, setHiddenLeft] = useState(0);
  const [hiddenRight, setHiddenRight] = useState(0);

  // Check if we're in formula reference mode
  // FIX: Use BOTH React state AND synchronous global check. React state may be stale
  // if the user types an operator (e.g., comma) and immediately clicks a sheet tab
  // before React re-renders. The global check uses module-level state updated synchronously.
  const isInFormulaMode = (editing !== null && isFormulaExpectingReference(editing.value)) || isGlobalFormulaMode();

  // Register core menu items on first render
  useEffect(() => {
    if (!coreMenuRegistered) {
      registerCoreSheetContextMenu();
      coreMenuRegistered = true;
    }
  }, []);

  // Load sheets on mount
  useEffect(() => {
    loadSheets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload sheets whenever a SHEET_CHANGED event fires from outside
  // (e.g., when a sheet is added from CreatePivotDialog), or when the sheet
  // COLLECTION itself changed.
  //
  // §3cd: "sheets:refresh" is the `sheets` domain's event. An MCP tool that
  // adds, renames, moves or deletes a sheet runs entirely in the backend, with
  // no frontend call to return from -- it used to emit a bespoke Tauri event of
  // this same name that NOTHING in the app had ever listened to, so an
  // AI-created sheet simply never appeared in the tab bar. It now announces the
  // domain and the Shell translator dispatches this.
  useEffect(() => {
    const handleExternalSheetChange = () => { loadSheets(); };
    window.addEventListener("app:sheet-changed", handleExternalSheetChange);
    window.addEventListener("sheets:refresh", handleExternalSheetChange);
    return () => {
      window.removeEventListener("app:sheet-changed", handleExternalSheetChange);
      window.removeEventListener("sheets:refresh", handleExternalSheetChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper: apply a SheetsResult and trigger sheet switch events.
  // backendHandledSwitch=true means the backend already swapped grids/state for the new active
  // index, so we must NOT call setActiveSheetApi again (which would do a redundant swap).
  const applySheetsResult = useCallback(async (
    result: SheetsResult,
    { switchSheet = true, backendHandledSwitch = false } = {}
  ) => {
    setSheets(result.sheets);
    if (switchSheet && result.activeIndex !== activeIndex) {
      if (backendHandledSwitch) {
        // Backend already swapped - just sync frontend state.
        // BUG-0052: prime the canvas with the new sheet's viewport BEFORE any
        // visible state moves, so strip and grid repaint in one flush. The
        // dispatch sequence below stays free of awaits.
        await primeSheetSwitch(result.activeIndex);
        setActiveIndex(result.activeIndex);
        const newActive = sheetAt(result.sheets, result.activeIndex);
        if (newActive) {
          dispatch(setActiveSheet(result.activeIndex, newActive.name));
        }
        onSheetChange?.(result.activeIndex, newActive?.name || "");
        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: { newSheetIndex: result.activeIndex, newSheetName: newActive?.name || "" },
        }));
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.activeIndex,
          sheetName: newActive?.name || "",
        });
      } else {
        // Need to actually switch sheets in backend
        const switchResult = await setActiveSheetApi(result.activeIndex);
        // BUG-0052: backend is on the new sheet now — prime before the
        // visible commit below, which then runs without awaits.
        await primeSheetSwitch(switchResult.activeIndex);
        setSheets(switchResult.sheets);
        setActiveIndex(switchResult.activeIndex);
        const newActive = sheetAt(switchResult.sheets, switchResult.activeIndex);
        if (newActive) {
          dispatch(setActiveSheet(switchResult.activeIndex, newActive.name));
        }
        onSheetChange?.(switchResult.activeIndex, newActive?.name || "");
        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: { newSheetIndex: switchResult.activeIndex, newSheetName: newActive?.name || "" },
        }));
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: switchResult.activeIndex,
          sheetName: newActive?.name || "",
        });
      }
    } else {
      setActiveIndex(result.activeIndex);
    }
  }, [activeIndex, dispatch, onSheetChange]);

  // Listen for custom events from context menu actions
  useEffect(() => {
    const handleRename = async (e: Event) => {
      const { index, newName } = (e as CustomEvent).detail;
      await handleRenameSheetRef.current(index, newName);
    };

    const handleDelete = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      await handleDeleteSheetRef.current(index);
    };

    const handleAdd = async () => {
      await handleAddSheetRef.current();
    };

    const handleMove = async (e: Event) => {
      const { fromIndex, toIndex } = (e as CustomEvent).detail;
      try {
        window.dispatchEvent(new CustomEvent("sheet:reorder", {
          detail: { fromIndex, toIndex },
        }));
        const result = await moveSheet(fromIndex, toIndex);
        await applySheetsResultRef.current(result, { backendHandledSwitch: true });
      } catch (err) {
        console.error("[SheetTabs] moveSheet error:", err);
        void alertAsync("Failed to move sheet: " + String(err));
      }
    };

    const handleCopy = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      try {
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: { oldSheetIndex: -1, newSheetIndex: -1 },
        }));
        const result = await copySheet(index);
        await applySheetsResultRef.current(result, { backendHandledSwitch: true });
      } catch (err) {
        console.error("[SheetTabs] copySheet error:", err);
        void alertAsync("Failed to copy sheet: " + String(err));
      }
    };

    const handleHide = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      try {
        const result = await hideSheet(index);
        await applySheetsResultRef.current(result, { backendHandledSwitch: true });
      } catch (err) {
        console.error("[SheetTabs] hideSheet error:", err);
        void alertAsync("Failed to hide sheet: " + String(err));
      }
    };

    const handleUnhide = async () => {
      try {
        const current = await getSheets();
        const hiddenSheets = current.sheets.filter(s => s.visibility === "hidden");
        if (hiddenSheets.length === 0) {
          void alertAsync("No hidden sheets to unhide.");
          return;
        }
        // Open the unhide dialog
        setUnhideDialog({ hiddenSheets, selectedIndex: hiddenSheets[0].index });
      } catch (err) {
        console.error("[SheetTabs] unhideSheet error:", err);
        void alertAsync("Failed to unhide sheet: " + String(err));
      }
    };

    const handleTabColor = async (e: Event) => {
      const { index, color } = (e as CustomEvent).detail;
      try {
        const result = await setTabColor(index, color);
        setSheets(result.sheets);
      } catch (err) {
        console.error("[SheetTabs] setTabColor error:", err);
        void alertAsync("Failed to set tab color: " + String(err));
      }
    };

    window.addEventListener("sheet:requestRename", handleRename);
    window.addEventListener("sheet:requestDelete", handleDelete);
    window.addEventListener("sheet:requestAdd", handleAdd);
    window.addEventListener("sheet:requestMove", handleMove);
    window.addEventListener("sheet:requestCopy", handleCopy);
    window.addEventListener("sheet:requestHide", handleHide);
    window.addEventListener("sheet:requestUnhide", handleUnhide);
    window.addEventListener("sheet:requestTabColor", handleTabColor);

    return () => {
      window.removeEventListener("sheet:requestRename", handleRename);
      window.removeEventListener("sheet:requestDelete", handleDelete);
      window.removeEventListener("sheet:requestAdd", handleAdd);
      window.removeEventListener("sheet:requestMove", handleMove);
      window.removeEventListener("sheet:requestCopy", handleCopy);
      window.removeEventListener("sheet:requestHide", handleHide);
      window.removeEventListener("sheet:requestUnhide", handleUnhide);
      window.removeEventListener("sheet:requestTabColor", handleTabColor);
    };
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [contextMenu]);

  const loadSheets = useCallback(async () => {
    try {
      const result = await getSheets();
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);
      // Sync sheet context with state
      const activeSheet = sheetAt(result.sheets, result.activeIndex);
      if (activeSheet) {
        dispatch(setSheetContext(result.activeIndex, activeSheet.name));
      }
      setError(null);
    } catch (err) {
      console.error("[SheetTabs] getSheets error:", err);
      setError(String(err));
      setSheets([{ index: 0, name: "Sheet1", visibility: "visible" as const }]);
      setActiveIndex(0);
    } finally {
      setIsLoading(false);
    }
  }, [dispatch]);

  /**
   * Handle mousedown on sheet tabs.
   * CRITICAL: When in formula mode, set the global flag to prevent blur commit.
   * This flag is checked by InlineEditor's blur handler.
   * FIX: Check isGlobalFormulaMode() at event time for synchronous detection,
   * in addition to the React-derived isInFormulaMode from the render closure.
   */
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, sheetIndex: number) => {
      // FIX: Check BOTH the closure value AND the synchronous global state.
      // The closure value may be stale if React hasn't re-rendered since the last keystroke.
      const isCurrentlyFormulaMode = isInFormulaMode || isGlobalFormulaMode();
      if (isCurrentlyFormulaMode && sheetIndex !== activeIndex) {
        console.log("[SheetTabs] Formula mode mousedown - setting prevent blur flag");
        // Set the global flag BEFORE blur fires
        emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, true);
        // Prevent default to try to keep focus (may not work in all browsers)
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [isInFormulaMode, activeIndex]
  );

  /**
   * Format a sheet name for use in formula references.
   * Quotes the name if it contains spaces or special characters.
   */
  const formatSheetForFormula = useCallback((name: string): string => {
    if (/[\s'![\]]/.test(name) || /^\d/.test(name)) {
      return `'${name.replace(/'/g, "''")}'`;
    }
    return name;
  }, []);

  const handleSheetClick = useCallback(
    async (index: number, event?: React.MouseEvent) => {
      // Skip click if we just finished a drag
      if (dragState?.dragging) return;

      // FIX: Check BOTH the closure value AND the synchronous global state at event time.
      // The closure value may be stale if React hasn't re-rendered since the last keystroke.
      const isCurrentlyFormulaMode = isInFormulaMode || isGlobalFormulaMode();

      // Ctrl+Click: Toggle sheet grouping (multi-select) when NOT in formula mode
      if (event?.ctrlKey && !isCurrentlyFormulaMode) {
        const newSelection = toggleSheetInGroup(index, activeIndex);
        const newSet = new Set(newSelection);
        setGroupedSheets(newSet);
        setSelectedSheetIndices(newSelection);
        console.log("[SheetTabs] Ctrl+Click: groupedSheets =", newSelection);
        return;
      }

      // Normal click (no Ctrl): clear sheet grouping
      if (groupedSheets.size > 1 && !isCurrentlyFormulaMode) {
        setGroupedSheets(new Set());
        clearSheetGrouping();
        console.log("[SheetTabs] Normal click: cleared sheet grouping");
      }

      if (index === activeIndex && !(event?.shiftKey && isCurrentlyFormulaMode)) return;

      console.log("[SheetTabs] Sheet click, index:", index, "isCurrentlyFormulaMode:", isCurrentlyFormulaMode, "shift:", event?.shiftKey);

      try {
        // Shift+Click in formula mode: insert 3D reference prefix
        if (isCurrentlyFormulaMode && event?.shiftKey) {
          const startSheet = sheetAt(sheets, activeIndex)?.name;
          const endSheet = sheetAt(sheets, index)?.name;
          if (startSheet && endSheet) {
            // Build the 3D reference prefix
            const needsQuoting = /[\s'![\]]/.test(startSheet) || /[\s'![\]]/.test(endSheet);
            let prefix: string;
            if (needsQuoting) {
              prefix = `'${startSheet.replace(/'/g, "''")}:${endSheet.replace(/'/g, "''")}'!`;
            } else {
              prefix = `${startSheet}:${endSheet}!`;
            }

            // Insert the 3D prefix into the formula bar
            const formulaBar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement;
            if (formulaBar) {
              const cursorPos = formulaBar.selectionStart ?? formulaBar.value.length;
              const before = formulaBar.value.substring(0, cursorPos);
              const after = formulaBar.value.substring(cursorPos);
              formulaBar.value = before + prefix + after;
              // Trigger input event so React picks up the change
              formulaBar.dispatchEvent(new Event('input', { bubbles: true }));
              // Position cursor after the prefix
              const newPos = cursorPos + prefix.length;
              formulaBar.setSelectionRange(newPos, newPos);
              formulaBar.focus();
            }

            console.log("[SheetTabs] Inserted 3D reference prefix:", prefix);
          }
          return;
        }

        // When in formula mode, we need special handling
        if (isCurrentlyFormulaMode) {
          console.log("[SheetTabs] Formula mode - switching without reload");
          
          // Just update the backend's active sheet for cell selection
          // but DON'T reload the page or exit edit mode
          const result: SheetsResult = await setActiveSheetApi(index);
          setSheets(result.sheets);
          setActiveIndex(result.activeIndex);
          
          const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
          
          // Update the grid state with new sheet context
          // This allows the grid to show the new sheet's cells
          // while keeping the formula editing state intact
          if (newActiveSheet) {
            dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name));
          }

          onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");
          
          // Emit a custom event to trigger grid refresh and editor refocus
          // GridCanvas listens for this to re-fetch cells
          // InlineEditor listens for this to refocus and clear the prevent flag
          console.log("[SheetTabs] Dispatching sheet:formulaModeSwitch event");
          window.dispatchEvent(new CustomEvent("sheet:formulaModeSwitch", {
            detail: {
              newSheetIndex: result.activeIndex,
              newSheetName: newActiveSheet?.name || "",
            }
          }));
          
          // Focus the formula bar since InlineEditor won't render on target sheet
          // This matches Excel behavior where formula bar stays active during cross-sheet selection
          // FIX: Clear preventBlurCommit AFTER focus is stable on the formula bar.
          // On the target sheet, InlineEditor returns null and can't clear the flag itself.
          setTimeout(() => {
            const formulaBar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement;
            if (formulaBar) {
              formulaBar.focus();
              // FIX: Use tracked cursor position instead of always placing at end
              const cursorPos = getGlobalCursorPosition();
              const len = formulaBar.value.length;
              const pos = Math.min(cursorPos, len);
              formulaBar.setSelectionRange(pos, pos);
            }
            // Clear the flag after focus is stable
            emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, false);
          }, 50);
          
          // DO NOT reload - stay in edit mode for formula reference selection
          return;
        }

        // Normal mode: switch sheets with full reload
        // Dispatch event BEFORE switching to save current sheet's state
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: {
            oldSheetIndex: activeIndex,
            newSheetIndex: index,
          }
        }));

        const result: SheetsResult = await setActiveSheetApi(index);
        // BUG-0052: the backend is on the new sheet — fetch its viewport
        // BEFORE the visible swap so the tab strip and the canvas commit in
        // ONE paint. Everything from here to SHEET_CHANGED runs without an
        // await, which is what keeps the switch atomic on screen.
        await primeSheetSwitch(result.activeIndex);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        const newActiveSheet = sheetAt(result.sheets, result.activeIndex);

        if (newActiveSheet) {
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name));
        }

        onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

        // Dispatch event to refresh grid data without full page reload
        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: {
            newSheetIndex: result.activeIndex,
            newSheetName: newActiveSheet?.name || "",
          }
        }));

        // Notify extensions (AutoFilter, Grouping, etc.) that the active sheet changed
        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.activeIndex,
          sheetName: newActiveSheet?.name || "",
        });
      } catch (err) {
        console.error("[SheetTabs] setActiveSheet error:", err);
        // Clear the prevent flag on error
        emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, false);
        void alertAsync("Failed to switch sheet: " + String(err));
      }
    },
    [activeIndex, sheets, onSheetChange, isInFormulaMode, dispatch, dragState, groupedSheets]
  );

  const handleAddSheet = useCallback(async () => {
    // Don't allow adding sheets while in formula mode
    if (isInFormulaMode) {
      return;
    }

    try {
      // Dispatch event BEFORE adding sheet to save current sheet's state
      window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
        detail: {
          oldSheetIndex: activeIndex,
          newSheetIndex: -1, // New sheet index not known yet
        }
      }));

      const result = await addSheet();
      // BUG-0052: same prime-before-commit as a tab click — a new sheet's
      // empty viewport still has to replace the old sheet's cells in the
      // same paint as the tab that claims it.
      await primeSheetSwitch(result.activeIndex);
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);

      const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
      if (newActiveSheet) {
        dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name));
      }
      onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

      // Dispatch event to refresh grid data without full page reload
      window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
        detail: {
          newSheetIndex: result.activeIndex,
          newSheetName: newActiveSheet?.name || "",
        }
      }));

      // Notify extensions that the active sheet changed
      emitAppEvent(AppEvents.SHEET_CHANGED, {
        sheetIndex: result.activeIndex,
        sheetName: newActiveSheet?.name || "",
      });
    } catch (err) {
      console.error("[SheetTabs] addSheet error:", err);
      void alertAsync("Failed to add sheet: " + String(err));
    }
  }, [onSheetChange, isInFormulaMode]);

  const handleDeleteSheet = useCallback(
    (index: number) => {
      if (sheets.length <= 1) return;
      if (isInFormulaMode) return;

      // Show confirmation dialog instead of using confirm()
      const sheetName = sheets.find(s => s.index === index)?.name || `Sheet ${index}`;
      setDeleteConfirm({ index, name: sheetName });
    },
    [sheets, isInFormulaMode]
  );

  const executeDeleteSheet = useCallback(
    async (index: number) => {
      try {
        // Dispatch event BEFORE deleting sheet to save current sheet's state
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: {
            oldSheetIndex: activeIndex,
            newSheetIndex: -1,
          }
        }));

        const result = await deleteSheet(index);
        // BUG-0052: prime-before-commit; deleting the active sheet lands the
        // user on a NEIGHBOUR whose cells must arrive with its tab.
        await primeSheetSwitch(result.activeIndex);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
        if (newActiveSheet) {
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name));
        }
        onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

        window.dispatchEvent(new CustomEvent("sheet:normalSwitch", {
          detail: {
            newSheetIndex: result.activeIndex,
            newSheetName: newActiveSheet?.name || "",
          }
        }));

        emitAppEvent(AppEvents.SHEET_CHANGED, {
          sheetIndex: result.activeIndex,
          sheetName: newActiveSheet?.name || "",
        });
      } catch (err) {
        console.error("[SheetTabs] deleteSheet error:", err);
        void alertAsync("Failed to delete sheet: " + String(err));
      }
    },
    [onSheetChange, activeIndex, dispatch]
  );

  const handleRenameSheet = useCallback(
    async (index: number, newName: string) => {
      // Don't allow renaming sheets while in formula mode
      if (isInFormulaMode) {
        return;
      }

      try {
        const result = await renameSheet(index, newName);
        setSheets(result.sheets);
      } catch (err) {
        console.error("[SheetTabs] renameSheet error:", err);
        void alertAsync("Failed to rename sheet: " + String(err));
      }
    },
    [isInFormulaMode]
  );

  // Refs to always access the latest handler versions from stable event listeners.
  // Must be declared AFTER the useCallback definitions to avoid temporal dead zone.
  const handleDeleteSheetRef = useRef(handleDeleteSheet);
  handleDeleteSheetRef.current = handleDeleteSheet;
  const handleRenameSheetRef = useRef(handleRenameSheet);
  handleRenameSheetRef.current = handleRenameSheet;
  const handleAddSheetRef = useRef(handleAddSheet);
  handleAddSheetRef.current = handleAddSheet;
  const applySheetsResultRef = useRef(applySheetsResult);
  applySheetsResultRef.current = applySheetsResult;

  const sheetByIndex = useCallback(
    (index: number): SheetInfo | undefined => sheetAt(sheets, index),
    [sheets]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      // Don't show context menu while in formula mode
      if (isInFormulaMode) {
        return;
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        sheetIndex: index,
      });
    },
    [isInFormulaMode]
  );

  const handleDoubleClick = useCallback(
    async (index: number) => {
      // Don't allow rename while in formula mode
      if (isInFormulaMode) {
        return;
      }
      const currentName = sheetByIndex(index)?.name || "";
      // window.prompt is the one dialog global Tauri does NOT replace, so
      // whether it appears at all is up to the WebView2 embedder's script-dialog
      // policy — and a suppressed prompt returns null, which is
      // indistinguishable from the user cancelling. promptAsync renders the
      // modal itself, so double-click-to-rename behaves the same in every window.
      const newName = await promptAsync("Enter new sheet name:", {
        title: "Rename sheet",
        defaultValue: currentName,
      });
      if (newName && newName.trim() !== "" && newName !== currentName) {
        handleRenameSheet(index, newName.trim());
      }
    },
    [sheetByIndex, handleRenameSheet, isInFormulaMode]
  );

  const contextFor = useCallback(
    (sheetIndex: number): SheetContext | null => {
      const sheet = sheetByIndex(sheetIndex);
      if (!sheet) return null;
      return {
        sheet,
        index: sheetIndex,
        // The STABLE key. An extension that answers "did this sheet come from
        // an application?" from a cache must key it on identity: the index
        // shifts under an insert, a delete or a move, and nothing tells the
        // extension it did.
        sheetId: sheet.sheetId,
        isActive: sheetIndex === activeIndex,
        totalSheets: sheets.length,
      };
    },
    [sheetByIndex, sheets.length, activeIndex]
  );

  const getContextMenuItems = useCallback(
    (sheetIndex: number): ResolvedSheetContextMenuItem[] => {
      const context = contextFor(sheetIndex);
      if (!context) return [];
      return sheetExtensions.getContextMenuItemsForContext(context);
    },
    [contextFor]
  );

  const handleContextMenuItemClick = useCallback(
    async (item: ResolvedSheetContextMenuItem) => {
      if (!contextMenu) return;

      const context = contextFor(contextMenu.sheetIndex);
      if (!context) return;

      setContextMenu(null);

      if (!item.disabled) {
        await item.onClick(context);
      }
    },
    [contextMenu, contextFor]
  );

  // Unhide dialog confirm
  const handleUnhideConfirm = useCallback(async () => {
    if (!unhideDialog || unhideDialog.selectedIndex === null) return;
    try {
      const result = await unhideSheet(unhideDialog.selectedIndex);
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);
    } catch (err) {
      console.error("[SheetTabs] unhideSheet error:", err);
      void alertAsync("Failed to unhide sheet: " + String(err));
    }
    setUnhideDialog(null);
  }, [unhideDialog]);

  // ---------------------------------------------------------------------------
  // Drag-to-reorder handlers
  // ---------------------------------------------------------------------------

  /** Get visible tab elements within the TabsArea */
  const getVisibleTabs = useCallback((): HTMLElement[] => {
    if (!tabsAreaRef.current) return [];
    return Array.from(tabsAreaRef.current.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
  }, []);

  /** Resolve a clientX position to a visible-tab drop index */
  const resolveDropIndex = useCallback((clientX: number): number => {
    const tabs = getVisibleTabs();
    if (tabs.length === 0) return 0;
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) return i;
    }
    return tabs.length - 1;
  }, [getVisibleTabs]);

  const handleDragStart = useCallback(
    (e: React.MouseEvent, sheetIndex: number) => {
      if (isInFormulaMode || e.button !== 0) return;
      // Only start drag on left-click, not on context-menu
      setDragState({
        dragging: false,
        sourceIndex: sheetIndex,
        currentIndex: sheetIndex,
        startX: e.clientX,
      });
    },
    [isInFormulaMode]
  );

  // Global mousemove / mouseup for drag
  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      setDragState(prev => {
        if (!prev) return null;
        const dragging = prev.dragging || Math.abs(e.clientX - prev.startX) > 5;
        const dropIdx = resolveDropIndex(e.clientX);
        // Map visible index back to real sheet index
        const visibleSheets = sheets.filter(s => s.visibility === "visible");
        const targetSheet = visibleSheets[dropIdx];
        const targetRealIndex = targetSheet ? targetSheet.index : prev.currentIndex;
        return { ...prev, dragging, currentIndex: targetRealIndex };
      });
    };

    const handleMouseUp = async () => {
      if (dragState.dragging && dragState.sourceIndex !== dragState.currentIndex) {
        try {
          window.dispatchEvent(new CustomEvent("sheet:reorder", {
            detail: { fromIndex: dragState.sourceIndex, toIndex: dragState.currentIndex },
          }));
          const result = await moveSheet(dragState.sourceIndex, dragState.currentIndex);
          await applySheetsResult(result, { backendHandledSwitch: true });
        } catch (err) {
          console.error("[SheetTabs] drag moveSheet error:", err);
        }
      }
      setDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, sheets, resolveDropIndex, applySheetsResult]);

  // ---------------------------------------------------------------------------
  // Tab scroll navigation
  // ---------------------------------------------------------------------------

  /** Count how many tabs are hidden on left and right of the visible scroll area */
  const updateHiddenCounts = useCallback(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
    if (tabs.length === 0) {
      setHiddenLeft(0);
      setHiddenRight(0);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    let left = 0;
    let right = 0;
    for (const tab of tabs) {
      const tabRect = tab.getBoundingClientRect();
      // Tab is hidden on the left if its right edge is at or before the container's left
      if (tabRect.right <= containerRect.left + 1) {
        left++;
      }
      // Tab is hidden on the right if its left edge is at or past the container's right
      else if (tabRect.left >= containerRect.right - 1) {
        right++;
      }
    }
    setHiddenLeft(left);
    setHiddenRight(right);
  }, []);

  // Update hidden counts on scroll, resize, and sheet list changes
  useEffect(() => {
    const container = tabsAreaRef.current;
    if (!container) return;

    const handleScroll = () => updateHiddenCounts();
    container.addEventListener('scroll', handleScroll);

    const resizeObserver = new ResizeObserver(() => updateHiddenCounts());
    resizeObserver.observe(container);

    // Initial calculation
    updateHiddenCounts();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
    };
    // `decorationTick`: marks WIDEN tabs, so the overflow counters must be
    // recomputed when one appears. Without it the "(3)" chips go stale the
    // moment an extension activates and stay stale until the next resize.
  }, [updateHiddenCounts, sheets, decorationTick]);

  // Auto-scroll active tab into view when it changes
  useEffect(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const activeTab = container.querySelector(`button[data-sheet-tab="${activeIndex}"]`) as HTMLElement | null;
    if (activeTab) {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeIndex]);

  /** Scroll to show the first tab */
  const scrollToFirst = useCallback(() => {
    const container = tabsAreaRef.current;
    if (container) container.scrollLeft = 0;
  }, []);

  /** Scroll to show the last tab */
  const scrollToLast = useCallback(() => {
    const container = tabsAreaRef.current;
    if (container) container.scrollLeft = container.scrollWidth;
  }, []);

  /** Scroll left by one tab — aligns the hidden tab's left edge with the container's left */
  const scrollPrev = useCallback(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
    // Find the last tab whose left edge is before the container's visible left
    for (let i = tabs.length - 1; i >= 0; i--) {
      const tabLeft = tabs[i].offsetLeft;
      if (tabLeft < container.scrollLeft) {
        container.scrollLeft = tabLeft;
        return;
      }
    }
    container.scrollLeft = 0;
  }, []);

  /** Scroll right by one tab — aligns the hidden tab's right edge with the container's right */
  const scrollNext = useCallback(() => {
    const container = tabsAreaRef.current;
    if (!container) return;
    const tabs = Array.from(container.querySelectorAll('button[data-sheet-tab]')) as HTMLElement[];
    const visibleRight = container.scrollLeft + container.clientWidth;
    // Find the first tab whose right edge extends past the visible area
    for (const tab of tabs) {
      const tabRight = tab.offsetLeft + tab.offsetWidth;
      if (tabRight > visibleRight + 1) {
        container.scrollLeft = tabRight - container.clientWidth;
        return;
      }
    }
    container.scrollLeft = container.scrollWidth;
  }, []);

  // Determine if we're viewing a different sheet than the formula source
  const isViewingDifferentSheet = isInFormulaMode &&
    editing?.sourceSheetIndex !== undefined &&
    editing.sourceSheetIndex !== activeIndex;

  // Visible tabs in render order; shared by the tab map and drag indicator.
  const visibleSheets = sheets.filter(s => s.visibility === "visible");

  // BUG-0052: the index the strip PAINTS as active. The grid sheet context,
  // not the local mirror: every switch — tab click, add/delete, and the
  // backend-initiated follow undo/redo uses — dispatches the context in the
  // same synchronous batch as the canvas's prefetched cell commit, so painting
  // from it puts the bold tab and the new sheet's cells in ONE flush. The
  // local `activeIndex` only catches up via the sync effect above, which runs
  // AFTER the browser has painted — rendering from it gave undo's switch a
  // two-frame window with the new sheet's cells under the old sheet's bold
  // tab. `followBackendSheetActivation` has always said "the tab strip has no
  // state of its own to update: it syncs its highlight from this"; this makes
  // that sentence true of the pixels, not only of the state. The local
  // `activeIndex` remains for behaviour (click guards, drag, scroll-into-view).
  const paintedActiveIndex = isLoading ? activeIndex : sheetContext.activeSheetIndex;

  // True when a tab renders "selected" (raised on the grid background) —
  // used to hide the Excel-style separators next to selected tabs.
  const isTabSelected = (s?: SheetInfo): boolean =>
    !!s && (
      s.index === paintedActiveIndex ||
      groupedSheets.has(s.index) ||
      (isInFormulaMode && editing?.sourceSheetIndex === s.index)
    );

  return (
    <S.Container>
      {/* Navigation arrows */}
      <S.NavArea>
        <S.NavButton title="First sheet" disabled={hiddenLeft === 0} onClick={scrollToFirst}>
          |&lt;
        </S.NavButton>
        <S.NavButton title="Previous sheet" disabled={hiddenLeft === 0} onClick={scrollPrev}>
          &lt;
        </S.NavButton>
        <S.NavButton title="Next sheet" disabled={hiddenRight === 0} onClick={scrollNext}>
          &gt;
        </S.NavButton>
        <S.NavButton title="Last sheet" disabled={hiddenRight === 0} onClick={scrollToLast}>
          &gt;|
        </S.NavButton>
      </S.NavArea>

      {/* Hidden tabs indicator (left) */}
      {hiddenLeft > 0 && <S.HiddenCount>({hiddenLeft})</S.HiddenCount>}

      {/* Sheet tabs */}
      <S.TabsArea ref={tabsAreaRef}>
        {isLoading ? (
          <S.LoadingText>Loading...</S.LoadingText>
        ) : (
          visibleSheets.map((sheet, visIdx) => {
            const isSourceSheet = isInFormulaMode &&
              editing?.sourceSheetIndex === sheet.index;
            const isTargetSheet = isInFormulaMode &&
              sheet.index === paintedActiveIndex &&
              !isSourceSheet;

            // Excel-style separators: only between two unselected neighbors.
            const withSeparator =
              visIdx > 0 &&
              !isTabSelected(sheet) &&
              !isTabSelected(visibleSheets[visIdx - 1]);

            // Extension-contributed marks — "this sheet came from an
            // application", and whatever else asks later. Keyed on `sheetId`,
            // never on the index or the name, both of which move.
            const decorations = getSheetTabDecorations({
              index: sheet.index,
              name: sheet.name,
              sheetId: sheet.sheetId,
            });

            return (
              <S.Tab
                key={sheet.index}
                type="button"
                tabIndex={-1}
                data-sheet-tab={sheet.index}
                $isActive={sheet.index === paintedActiveIndex}
                $isGrouped={groupedSheets.has(sheet.index)}
                $isFormulaSource={isSourceSheet}
                $isFormulaTarget={isTargetSheet}
                $tabColor={sheet.tabColor || ""}
                $withSeparator={withSeparator}
                onMouseDown={(e) => {
                  handleTabMouseDown(e, sheet.index);
                  handleDragStart(e, sheet.index);
                }}
                onClick={(e) => handleSheetClick(sheet.index, e)}
                onContextMenu={(e) => handleContextMenu(e, sheet.index)}
                onDoubleClick={() => void handleDoubleClick(sheet.index)}
                style={dragState?.dragging && dragState.sourceIndex === sheet.index
                  ? { opacity: 0.5 }
                  : undefined
                }
                title={
                  [
                    isInFormulaMode
                      ? isSourceSheet
                        ? `Formula source: ${sheet.name}`
                        : `Click to select cells from ${sheet.name}`
                      : `${sheet.name} (right-click for options)`,
                    // EVERY mark's reason, including any past the glyph cap —
                    // the cap limits pixels, never disclosure.
                    ...decorations.map((d) => d.tooltip).filter(Boolean),
                  ].join("\n\n")
                }
              >
                {/*
                  Marks LEAD, the `[*]` formula-source marker TRAILS. Two glyph
                  runs at the same edge read as one string ("Sales ↓ [*]"); this
                  way "what this sheet permanently IS" and "what it is doing
                  right now" sit on opposite sides of the name. Leading also
                  lines the glyphs up in a column down the strip, which is what
                  makes it scannable.
                */}
                {decorations.slice(0, MAX_SHEET_TAB_DECORATION_GLYPHS).map((d) => (
                  <S.TabDecoration
                    key={d.id}
                    data-sheet-tab-decoration={d.id}
                    $color={d.color}
                    $background={d.background}
                    role="img"
                    aria-label={d.tooltip}
                  >
                    {d.glyph}
                  </S.TabDecoration>
                ))}
                {sheet.name}
                {isSourceSheet && <S.SourceIndicator> [*]</S.SourceIndicator>}
              </S.Tab>
            );
          })
        )}
        {error && (
          <S.ErrorText title={error}>
            [API Error]
          </S.ErrorText>
        )}
      </S.TabsArea>

      {/* Hidden tabs indicator (right) */}
      {hiddenRight > 0 && <S.HiddenCount>({hiddenRight})</S.HiddenCount>}

      {/* Add sheet button - outside TabsArea to avoid overflow clipping */}
      {!isLoading && (
        <S.AddButton
          type="button"
          tabIndex={-1}
          $disabled={isInFormulaMode}
          onClick={handleAddSheet}
          title={isInFormulaMode ? "Finish formula editing first" : "Add new sheet"}
          disabled={isInFormulaMode}
        >
          +
        </S.AddButton>
      )}

      {/* Formula mode indicator */}
      {isViewingDifferentSheet && (
        <S.FormulaModeIndicator>
          Selecting from: {sheetAt(sheets, activeIndex)?.name} 
          {" --> "}
          {editing?.sourceSheetName || sheetAt(sheets, editing?.sourceSheetIndex ?? 0)?.name}
        </S.FormulaModeIndicator>
      )}

      {/* Sheet grouping indicator */}
      {groupedSheets.size > 1 && !isViewingDifferentSheet && (
        <S.FormulaModeIndicator>
          [Group]
        </S.FormulaModeIndicator>
      )}

      {/* Drag indicator */}
      {dragState?.dragging && (() => {
        const tabs = getVisibleTabs();
        const dropVisibleIdx = visibleSheets.findIndex(s => s.index === dragState.currentIndex);
        const sourceVisibleIdx = visibleSheets.findIndex(s => s.index === dragState.sourceIndex);
        if (dropVisibleIdx < 0 || sourceVisibleIdx < 0 || dropVisibleIdx === sourceVisibleIdx) return null;
        const tabEl = tabs[dropVisibleIdx];
        if (!tabEl) return null;
        const tabRect = tabEl.getBoundingClientRect();
        // Place indicator at the edge between tabs:
        // Dropping right of source -> right edge of drop target
        // Dropping left of source -> left edge of drop target
        const left = dropVisibleIdx > sourceVisibleIdx
          ? tabRect.right
          : tabRect.left;
        return <S.DragIndicator style={{ left: left - 1, top: tabRect.top, height: tabRect.height }} />;
      })()}

      {/* Context Menu */}
      {contextMenu && (
        <S.ContextMenu
          ref={contextMenuRef}
          $x={contextMenu.x}
          $y={contextMenu.y}
        >
          {getContextMenuItems(contextMenu.sheetIndex).map((item, _idx) => (
            <React.Fragment key={item.id}>
              <S.ContextMenuItem
                type="button"
                $disabled={!!item.disabled}
                onClick={() => handleContextMenuItemClick(item)}
                disabled={!!item.disabled}
              >
                {item.icon && <S.ContextMenuIcon>{item.icon}</S.ContextMenuIcon>}
                {item.label}
              </S.ContextMenuItem>
              {item.separatorAfter && <S.ContextMenuSeparator />}
            </React.Fragment>
          ))}
        </S.ContextMenu>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <S.DialogOverlay onClick={() => setDeleteConfirm(null)}>
          <S.DialogBox onClick={(e) => e.stopPropagation()}>
            <S.DialogTitle>Delete Sheet</S.DialogTitle>
            <div style={{ fontSize: 12, marginBottom: 16, color: 'var(--text-primary)' }}>
              Are you sure you want to delete &quot;{deleteConfirm.name}&quot;?
            </div>
            <S.DialogButtons>
              <S.DialogButton onClick={() => setDeleteConfirm(null)}>
                Cancel
              </S.DialogButton>
              <S.DialogButtonPrimary onClick={() => {
                const idx = deleteConfirm.index;
                setDeleteConfirm(null);
                executeDeleteSheet(idx);
              }}>
                Delete
              </S.DialogButtonPrimary>
            </S.DialogButtons>
          </S.DialogBox>
        </S.DialogOverlay>
      )}

      {/* Unhide Dialog */}
      {unhideDialog && (
        <S.DialogOverlay onClick={() => setUnhideDialog(null)}>
          <S.DialogBox onClick={(e) => e.stopPropagation()}>
            <S.DialogTitle>Unhide Sheet</S.DialogTitle>
            <S.DialogList>
              {unhideDialog.hiddenSheets.map((sheet) => (
                <S.DialogListItem
                  key={sheet.index}
                  $selected={unhideDialog.selectedIndex === sheet.index}
                  onClick={() => setUnhideDialog(prev =>
                    prev ? { ...prev, selectedIndex: sheet.index } : null
                  )}
                  onDoubleClick={() => {
                    setUnhideDialog(prev =>
                      prev ? { ...prev, selectedIndex: sheet.index } : null
                    );
                    handleUnhideConfirm();
                  }}
                >
                  {sheet.name}
                </S.DialogListItem>
              ))}
            </S.DialogList>
            <S.DialogButtons>
              <S.DialogButton onClick={() => setUnhideDialog(null)}>
                Cancel
              </S.DialogButton>
              <S.DialogButtonPrimary
                onClick={handleUnhideConfirm}
                disabled={unhideDialog.selectedIndex === null}
              >
                OK
              </S.DialogButtonPrimary>
            </S.DialogButtons>
          </S.DialogBox>
        </S.DialogOverlay>
      )}
    </S.Container>
  );
}