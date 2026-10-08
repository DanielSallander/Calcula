//! FILENAME: app/src/shell/SheetTabs/SheetTabs.tsx
// PURPOSE: Sheet tabs component for switching between worksheets
// CONTEXT: Enhanced to support sheet switching during formula editing without page reload.
//          Key fix: Uses global flag to prevent blur commit during formula mode navigation.
// REFACTOR: Imports from api layer instead of core internals to comply with architecture rules.
// FIX (2026-09-27): a floating grid's cell edit (an EXTERNAL session) is formula
//      mode too. What a click means is decided by `resolveTabClick` (pure,
//      tested); the switch itself is Core's one `switchSheetForPointMode`, which
//      PARKS the session so it survives the trip and is brought back by a click
//      on its host tab (a canvas included) or ended through the formula bar.

import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
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
  setSheetSurfaces,
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
import { isGlobalFormulaMode, getGlobalCursorPosition, getExternalFormulaTarget } from "../../api/editing";
// The SUBPATH (NameBox.tsx precedent): a dependency-free store plus Core's one
// point-mode switch, kept out of any test's `@api/editing` double.
import {
  subscribeExternalEdit,
  getCrossSheetPointModeKey,
  isCrossSheetPointMode,
  getExternalEditSession,
  isExternalSessionParked,
  switchSheetForPointMode,
  focusExternalSessionView,
} from "../../api/externalEdit";
import { resolveTabClick } from "./resolveTabClick";
import { sheetRangePrefix } from "./sheetRangePrefix";
import { registerSheetTabsController } from "./sheetCommands";
import { promptForSheetName } from "./renameSheetPrompt";
import { sheetDeleteNeedsConfirmation } from "./sheetDeletePolicy";
import { insertSheetBefore, moveOrCopySheet } from "./sheetTabFlows";
import { insertionReorderDetail, removalReorderDetail } from "./sheetPlacement";
import type {
  SheetInfo,
  SheetsResult,
  SheetContext,
  ResolvedSheetContextMenuItem,
  SheetKindName,
  SheetSurface,
} from "../../api";
import * as S from './SheetTabs.styles';
import { alertAsync } from "@api/dialogs";

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

/**
 * The Core surface a listed sheet paints as. Every sheet switch below passes
 * it in the SAME dispatch that moves the sheet context, so the canvas surface
 * can never tear against the sheet it belongs to (BUG-0052's one flush).
 */
const surfaceOf = (sheet: SheetInfo | undefined): SheetSurface =>
  sheet?.kind === "canvas" ? "canvas" : "grid";

/** Every listed sheet's surface, keyed by TRUE index (never list position). */
const surfacesOf = (sheets: SheetInfo[]): Record<number, SheetSurface> => {
  const out: Record<number, SheetSurface> = {};
  for (const s of sheets) out[s.index] = surfaceOf(s);
  return out;
};

/**
 * Tell Core's per-sheet view cache (selection + scroll, keyed by TRUE index;
 * Spreadsheet.tsx `handleSheetReorder`) that sheets were renumbered. A move is
 * a rotate; an insertion or a removal is told the same way through
 * sheetPlacement.ts's `insertionReorderDetail` / `removalReorderDetail`.
 */
const announceReorder = (detail: { fromIndex: number; toIndex: number }): void => {
  window.dispatchEvent(new CustomEvent("sheet:reorder", { detail }));
};

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

  // Keep Core's per-sheet SURFACE map in step with the list. The switch
  // dispatches below carry the surface themselves; this map is what lets a
  // dispatcher that does NOT hold the list (the Name Box, the script host,
  // bookmarks) still land on the right surface.
  useEffect(() => {
    if (!isLoading) dispatch(setSheetSurfaces(surfacesOf(sheets)));
  }, [sheets, isLoading, dispatch]);

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

  // The "+" caret's kind menu (Worksheet / Canvas), anchored above the caret.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

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
  //
  // A live EXTERNAL session (a floating grid's cell edit) counts when it expects
  // a reference or is parked on another sheet. `pointKey` is a primitive
  // snapshot ("host:parked:expecting"), so the strip re-renders when one of
  // those changes and not on every keystroke of the formula.
  const pointKey = useSyncExternalStore(subscribeExternalEdit, getCrossSheetPointModeKey);
  const externalLive = pointKey !== null;
  const isInFormulaMode =
    (editing !== null && isFormulaExpectingReference(editing.value)) ||
    isGlobalFormulaMode() ||
    isCrossSheetPointMode();
  // Adding, deleting, renaming or reordering sheets is refused while ANY
  // external session is live, expecting or not: the session holds its host's
  // TRUE index, and a structural change would move that sheet underneath it.
  const structuralLocked = isInFormulaMode || externalLive;

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
  // forceSwitch=true runs the switch steps even when the active INDEX did not
  // change: Insert Sheet (before the active sheet) and Move or Copy's copy can
  // leave a DIFFERENT sheet at the same index, and comparing numbers would
  // then keep painting the old sheet's cells under the new sheet's tab.
  const applySheetsResult = useCallback(async (
    result: SheetsResult,
    { switchSheet = true, backendHandledSwitch = false, forceSwitch = false } = {}
  ) => {
    setSheets(result.sheets);
    if (switchSheet && (forceSwitch || result.activeIndex !== activeIndex)) {
      if (backendHandledSwitch) {
        // Backend already swapped - just sync frontend state.
        // BUG-0052: prime the canvas with the new sheet's viewport BEFORE any
        // visible state moves, so strip and grid repaint in one flush. The
        // dispatch sequence below stays free of awaits.
        await primeSheetSwitch(result.activeIndex);
        setActiveIndex(result.activeIndex);
        const newActive = sheetAt(result.sheets, result.activeIndex);
        if (newActive) {
          dispatch(setActiveSheet(result.activeIndex, newActive.name, surfaceOf(newActive)));
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
          dispatch(setActiveSheet(switchResult.activeIndex, newActive.name, surfaceOf(newActive)));
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

  // The strip's operations, reached two ways: the `sheet:request*` window
  // events the tab context menu (and Protection's guarded copies of its items)
  // dispatch, and the controller the core.sheet.* commands call
  // (sheetCommands.ts). ONE body per operation, so the two doors cannot
  // drift. Every handler is read through a ref, so this effect registers once.
  useEffect(() => {
    const moveSheetTo = async (fromIndex: number, toIndex: number) => {
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

    const copySheetAt = async (index: number) => {
      try {
        window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
          detail: { oldSheetIndex: -1, newSheetIndex: -1 },
        }));
        const result = await copySheet(index);
        // The copy lands right after its source, renumbering every sheet past
        // it: untold, each of them restored its NEIGHBOUR's selection and
        // scroll on its next visit.
        announceReorder(insertionReorderDetail(result.activeIndex));
        await applySheetsResultRef.current(result, { backendHandledSwitch: true, forceSwitch: true });
      } catch (err) {
        console.error("[SheetTabs] copySheet error:", err);
        void alertAsync("Failed to copy sheet: " + String(err));
      }
    };

    const hideSheetAt = async (index: number) => {
      try {
        const result = await hideSheet(index);
        await applySheetsResultRef.current(result, { backendHandledSwitch: true });
      } catch (err) {
        console.error("[SheetTabs] hideSheet error:", err);
        void alertAsync("Failed to hide sheet: " + String(err));
      }
    };

    const openUnhideDialog = async () => {
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

    const setTabColorAt = async (index: number, color: string) => {
      try {
        const result = await setTabColor(index, color);
        setSheets(result.sheets);
      } catch (err) {
        console.error("[SheetTabs] setTabColor error:", err);
        void alertAsync("Failed to set tab color: " + String(err));
      }
    };

    const handleRename = async (e: Event) => {
      const { index, newName } = (e as CustomEvent).detail;
      await handleRenameSheetRef.current(index, newName);
    };

    const handleDelete = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      await handleDeleteSheetRef.current(index);
    };

    const handleAdd = async (e: Event) => {
      const kind = (e as CustomEvent<{ kind?: SheetKindName } | null>).detail?.kind;
      await handleAddSheetRef.current(kind === "canvas" ? "canvas" : undefined);
    };

    const handleMove = async (e: Event) => {
      const { fromIndex, toIndex } = (e as CustomEvent).detail;
      await moveSheetTo(fromIndex, toIndex);
    };

    const handleCopy = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      await copySheetAt(index);
    };

    const handleHide = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      await hideSheetAt(index);
    };

    const handleUnhide = async () => {
      await openUnhideDialog();
    };

    const handleTabColor = async (e: Event) => {
      const { index, color } = (e as CustomEvent).detail;
      await setTabColorAt(index, color);
    };

    // The core.sheet.* commands' door (sheetCommands.ts). Seated for as long
    // as the strip is mounted; every method is a handler of the strip's own,
    // so a command runs the same switch steps a click does.
    const releaseController = registerSheetTabsController({
      snapshot: () => controllerStateRef.current,
      insertSheetBefore: (beforeIndex, kind) => handleInsertSheetBeforeRef.current(beforeIndex, kind),
      // The strip's own "+" (append), for the command's `{ atEnd: true }`.
      appendSheet: (kind) => handleAddSheetRef.current(kind),
      // Excel's rule for the command door: a blank sheet goes without asking.
      deleteSheet: (index) => handleDeleteSheetRef.current(index, { confirm: "whenNotBlank" }),
      renameSheet: (index, newName) => handleRenameSheetRef.current(index, newName),
      hideSheet: hideSheetAt,
      openUnhideDialog,
      setTabColor: setTabColorAt,
      moveOrCopySheet: (sourceIndex, beforeIndex, copy) =>
        handleMoveOrCopySheetRef.current(sourceIndex, beforeIndex, copy),
    });

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
      releaseController();
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

  // Close the "+" kind menu on an outside click or Escape.
  useEffect(() => {
    if (!addMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      // The caret is its own toggle: closing here on its press would let its
      // click reopen the menu, so a second click on the caret could never close it.
      if ((e.target as Element | null)?.closest?.("[data-add-sheet-menu-trigger]")) return;
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAddMenu(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [addMenu]);

  const loadSheets = useCallback(async () => {
    try {
      const result = await getSheets();
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);
      // Sync sheet context with state
      const activeSheet = sheetAt(result.sheets, result.activeIndex);
      if (activeSheet) {
        dispatch(setSheetContext(result.activeIndex, activeSheet.name, surfaceOf(activeSheet)));
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
      // An external session is asked at event time too: without the
      // preventDefault the tab button takes focus, and the floating grid's
      // editor blur-commits whatever was typed ("=" included) 150 ms later.
      const isCurrentlyFormulaMode = isInFormulaMode || isGlobalFormulaMode() || isCrossSheetPointMode();
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

  const handleSheetClick = useCallback(
    async (index: number, event?: React.MouseEvent) => {
      // Skip click if we just finished a drag
      if (dragState?.dragging) return;

      // FIX: Check BOTH the closure value AND the synchronous global state at event time.
      // The closure value may be stale if React hasn't re-rendered since the last keystroke.
      const coreFormulaMode =
        (editing !== null && isFormulaExpectingReference(editing.value)) || isGlobalFormulaMode();
      // The external session is read at EVENT time as well, never from the
      // render: a keystroke can have made it expect a reference since.
      const session = getExternalEditSession();
      const sessionInput = session
        ? {
            hostSheetIndex: session.hostSheetIndex,
            parked: isExternalSessionParked(),
            expecting: getExternalFormulaTarget()?.isExpectingReference() === true,
          }
        : null;
      const isCurrentlyFormulaMode =
        coreFormulaMode || (sessionInput !== null && (sessionInput.expecting || sessionInput.parked));

      // A CANVAS never joins a sheet group, from either end (a group replicates
      // cell edits, clears and formats, and the backend refuses every one of
      // those on a canvas -- for the WHOLE group); a CANVAS is never a formula's
      // reference target nor a 3D endpoint, except that a parked session's own
      // host tab brings the edit back. All of it lives in `resolveTabClick`.
      const action = resolveTabClick({
        index,
        activeIndex,
        targetIsCanvas: sheetAt(sheets, index)?.kind === "canvas",
        activeIsCanvas: sheetAt(sheets, activeIndex)?.kind === "canvas",
        ctrlKey: event?.ctrlKey === true,
        shiftKey: event?.shiftKey === true,
        dragging: dragState?.dragging === true,
        coreFormulaMode,
        session: sessionInput,
      });

      // Ctrl+Click: Toggle sheet grouping (multi-select) when NOT in formula mode
      if (action === "group") {
        const newSelection = toggleSheetInGroup(index, activeIndex);
        const newSet = new Set(newSelection);
        setGroupedSheets(newSet);
        setSelectedSheetIndices(newSelection);
        console.log("[SheetTabs] Ctrl+Click: groupedSheets =", newSelection);
        return;
      }

      // Normal click (no Ctrl): clear sheet grouping. A Ctrl+click outside
      // formula mode that was refused (a canvas at either end) leaves it alone.
      if (groupedSheets.size > 1 && !isCurrentlyFormulaMode && !event?.ctrlKey) {
        setGroupedSheets(new Set());
        clearSheetGrouping();
        console.log("[SheetTabs] Normal click: cleared sheet grouping");
      }

      if (action === "ignore") return;

      console.log("[SheetTabs] Sheet click, index:", index, "action:", action, "shift:", event?.shiftKey);

      try {
        // Shift+Click in formula mode: insert 3D reference prefix
        if (action === "prefix3d") {
          const startSheet = sheetAt(sheets, activeIndex)?.name;
          const endSheet = sheetAt(sheets, index)?.name;
          if (startSheet && endSheet) {
            // Build the 3D reference prefix, by the parser's rule (W13).
            const prefix = sheetRangePrefix(startSheet, endSheet);

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
        if (action === "pointMode") {
          console.log("[SheetTabs] Formula mode - switching without reload");

          // Core's ONE point-mode switch: the backend's active sheet moves (so
          // clicks there pick references), the grid shows the new sheet, and the
          // edit stays open. For an external session it also PARKS the session
          // (before the dispatch, so the paint it causes already hides the
          // edit's own objects) -- or un-parks it, on the way back to its host --
          // and refreshes dimensions. GridCanvas refetches on the
          // `sheet:formulaModeSwitch` it emits; InlineEditor refocuses on it.
          const result: SheetsResult = await switchSheetForPointMode(index, dispatch);
          setSheets(result.sheets);
          setActiveIndex(result.activeIndex);

          const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
          onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

          // THE ONE PLACE that decides focus after a point-mode switch. For the
          // grid's own editor: the formula bar (InlineEditor does not render on
          // the target sheet), at the tracked caret -- Excel's behaviour. For an
          // external session: the bar while parked, its own in-place editor back
          // on the host. The two must never both run: each steals focus from
          // the other.
          // FIX: Clear preventBlurCommit AFTER focus is stable on the formula bar.
          // On the target sheet, InlineEditor returns null and can't clear the flag itself.
          setTimeout(() => {
            if (getExternalEditSession()) {
              focusExternalSessionView();
            } else {
              const formulaBar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement;
              if (formulaBar) {
                formulaBar.focus();
                // FIX: Use tracked cursor position instead of always placing at end
                const cursorPos = getGlobalCursorPosition();
                const len = formulaBar.value.length;
                const pos = Math.min(cursorPos, len);
                formulaBar.setSelectionRange(pos, pos);
              }
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
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name, surfaceOf(newActiveSheet)));
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
    [activeIndex, sheets, onSheetChange, editing, dispatch, dragState, groupedSheets]
  );

  const handleAddSheet = useCallback(async (kind?: SheetKindName) => {
    // Don't allow adding sheets while in formula mode
    if (structuralLocked) {
      return;
    }
    setAddMenu(null);

    try {
      // Dispatch event BEFORE adding sheet to save current sheet's state
      window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
        detail: {
          oldSheetIndex: activeIndex,
          newSheetIndex: -1, // New sheet index not known yet
        }
      }));

      const result = await addSheet(undefined, kind);
      // BUG-0052: same prime-before-commit as a tab click — a new sheet's
      // empty viewport still has to replace the old sheet's cells in the
      // same paint as the tab that claims it.
      await primeSheetSwitch(result.activeIndex);
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);

      const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
      if (newActiveSheet) {
        dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name, surfaceOf(newActiveSheet)));
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
  }, [onSheetChange, structuralLocked]);

  /**
   * Excel's Insert Sheet (Shift+F11, Home > Insert > Insert Sheet): a new
   * worksheet immediately BEFORE `beforeIndex`, made active. The "+" button
   * keeps its append (handleAddSheet above); the backend can only append, so
   * this is an add followed by one move (sheetTabFlows.ts), applied through
   * the same commit-before-switch steps. FORCED: the new sheet takes the
   * anchor's index, so the active INDEX can come back unchanged while the
   * active SHEET is a different one.
   */
  const handleInsertSheetBefore = useCallback(async (beforeIndex: number, kind?: SheetKindName) => {
    if (structuralLocked) return;
    const anchor = sheetAt(sheets, beforeIndex);
    try {
      window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
        detail: { oldSheetIndex: activeIndex, newSheetIndex: -1 },
      }));
      const { result, error } = await insertSheetBefore(
        { addSheet: () => addSheet(undefined, kind), copySheet, moveSheet },
        announceReorder,
        anchor,
      );
      await applySheetsResultRef.current(result, { backendHandledSwitch: true, forceSwitch: true });
      if (error !== undefined) {
        // The sheet exists (and is shown); only its position failed.
        console.error("[SheetTabs] insert-before move error:", error);
        void alertAsync(`The new sheet was added at the end: it could not be moved before "${anchor?.name ?? ""}". ` + String(error));
      }
    } catch (err) {
      console.error("[SheetTabs] insertSheetBefore error:", err);
      void alertAsync("Failed to insert sheet: " + String(err));
    }
  }, [sheets, activeIndex, structuralLocked]);

  /**
   * Excel's Move or Copy: the sheet at `sourceIndex` -- or a copy of it --
   * immediately before `beforeIndex`, or at the end (null). A copy is made
   * active (Excel), so its switch is forced (see handleInsertSheetBefore); a
   * move keeps the active sheet, and the backend's index follows it.
   */
  const handleMoveOrCopySheet = useCallback(
    async (sourceIndex: number, beforeIndex: number | null, copy: boolean) => {
      if (structuralLocked) return;
      try {
        if (copy) {
          window.dispatchEvent(new CustomEvent("sheet:beforeSwitch", {
            detail: { oldSheetIndex: activeIndex, newSheetIndex: -1 },
          }));
        }
        const { result, error } = await moveOrCopySheet(
          { addSheet: () => addSheet(), copySheet, moveSheet },
          announceReorder,
          sheets,
          sourceIndex,
          beforeIndex,
          copy,
        );
        if (result) {
          await applySheetsResultRef.current(result, { backendHandledSwitch: true, forceSwitch: copy });
        }
        if (error !== undefined) {
          console.error("[SheetTabs] move-or-copy move error:", error);
          void alertAsync("The copy was made, but it could not be moved: " + String(error));
        }
      } catch (err) {
        console.error("[SheetTabs] moveOrCopySheet error:", err);
        void alertAsync((copy ? "Failed to copy sheet: " : "Failed to move sheet: ") + String(err));
      }
    },
    [sheets, activeIndex, structuralLocked]
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
        // Every sheet past the deleted one moved down an index. Untold, Core's
        // per-sheet view cache restored the DELETED sheet's selection and
        // scroll onto the neighbour that inherited its index, and each later
        // sheet its neighbour's.
        announceReorder(removalReorderDetail(index));
        // BUG-0052: prime-before-commit; deleting the active sheet lands the
        // user on a NEIGHBOUR whose cells must arrive with its tab.
        await primeSheetSwitch(result.activeIndex);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        const newActiveSheet = sheetAt(result.sheets, result.activeIndex);
        if (newActiveSheet) {
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name, surfaceOf(newActiveSheet)));
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

  /**
   * Delete, from either door: the tab menu's `sheet:requestDelete` and
   * core.sheet.delete (Home > Delete > Delete Sheet).
   *
   * `confirm: "whenNotBlank"` is Excel's rule -- ask first only when the sheet
   * holds something, delete a blank one at once; every doubt asks
   * (sheetDeletePolicy.ts: a delete ends the undo history, so a wrong "blank"
   * is unrecoverable). The COMMAND uses it. The tab menu still always asks
   * (`"always"`, the default): three journeys drive its confirmation on sheets
   * that may be blank (fixall-lifecycle X19, orphaned-sheet-state,
   * report-store), so moving that door is an owner's call, not this change's.
   */
  const handleDeleteSheet = useCallback(
    async (index: number, options: { confirm?: "always" | "whenNotBlank" } = {}) => {
      if (sheets.length <= 1) return;
      if (structuralLocked) return;

      const sheet = sheetAt(sheets, index);
      const sheetName = sheet?.name || `Sheet ${index}`;
      const ask =
        options.confirm !== "whenNotBlank" ||
        (await sheetDeleteNeedsConfirmation(
          { index, kind: sheet?.kind === "canvas" ? "canvas" : "worksheet" },
          index === activeIndex,
        ));
      if (ask) {
        // Show confirmation dialog instead of using confirm()
        setDeleteConfirm({ index, name: sheetName });
      } else {
        await executeDeleteSheet(index);
      }
    },
    [sheets, structuralLocked, activeIndex, executeDeleteSheet]
  );

  const handleRenameSheet = useCallback(
    async (index: number, newName: string) => {
      // Don't allow renaming sheets while in formula mode
      if (structuralLocked) {
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
    [structuralLocked]
  );

  // Refs to always access the latest handler versions from stable event listeners.
  // Must be declared AFTER the useCallback definitions to avoid temporal dead zone.
  const handleDeleteSheetRef = useRef(handleDeleteSheet);
  handleDeleteSheetRef.current = handleDeleteSheet;
  const handleRenameSheetRef = useRef(handleRenameSheet);
  handleRenameSheetRef.current = handleRenameSheet;
  const handleAddSheetRef = useRef(handleAddSheet);
  handleAddSheetRef.current = handleAddSheet;
  const handleInsertSheetBeforeRef = useRef(handleInsertSheetBefore);
  handleInsertSheetBeforeRef.current = handleInsertSheetBefore;
  const handleMoveOrCopySheetRef = useRef(handleMoveOrCopySheet);
  handleMoveOrCopySheetRef.current = handleMoveOrCopySheet;
  const applySheetsResultRef = useRef(applySheetsResult);
  applySheetsResultRef.current = applySheetsResult;
  // What the core.sheet.* commands' refusals read SYNCHRONOUSLY (the command-
  // refusal registry cannot await): the list, the active sheet and the
  // structural lock as of this render.
  const controllerStateRef = useRef({ sheets, activeIndex, locked: structuralLocked });
  controllerStateRef.current = { sheets, activeIndex, locked: structuralLocked };

  const sheetByIndex = useCallback(
    (index: number): SheetInfo | undefined => sheetAt(sheets, index),
    [sheets]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      // Don't show context menu while in formula mode
      if (structuralLocked) {
        return;
      }
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        sheetIndex: index,
      });
    },
    [structuralLocked]
  );

  const handleDoubleClick = useCallback(
    async (index: number) => {
      // Don't allow rename while in formula mode
      if (structuralLocked) {
        return;
      }
      const currentName = sheetByIndex(index)?.name || "";
      // THE rename prompt (renameSheetPrompt.ts), shared with the tab menu's
      // Rename and core.sheet.rename; it explains why it is promptAsync and
      // never window.prompt.
      const newName = await promptForSheetName(currentName);
      if (newName !== null) {
        await handleRenameSheet(index, newName);
      }
    },
    [sheetByIndex, handleRenameSheet, structuralLocked]
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

  // Unhide dialog confirm. `index` is the row a DOUBLE-CLICK chose: the
  // double-click handler used to set the selection and call this in the same
  // tick, and this read `unhideDialog.selectedIndex` from its render closure --
  // the PREVIOUS selection -- so double-clicking the second hidden sheet
  // unhid the first. OK passes nothing and reads the selection.
  const handleUnhideConfirm = useCallback(async (index?: number) => {
    const target = typeof index === "number" ? index : unhideDialog?.selectedIndex ?? null;
    if (!unhideDialog || target === null) return;
    try {
      const result = await unhideSheet(target);
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
      if (structuralLocked || e.button !== 0) return;
      // Only start drag on left-click, not on context-menu
      setDragState({
        dragging: false,
        sourceIndex: sheetIndex,
        currentIndex: sheetIndex,
        startX: e.clientX,
      });
    },
    [structuralLocked]
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

  // The sheet the formula being written BELONGS to: the grid editor's source
  // sheet, or a live external session's host (a floating grid's sheet). Read at
  // render; `pointKey` re-renders the strip when the session's host changes.
  const sourceIndex: number | undefined =
    editing?.sourceSheetIndex ?? getExternalEditSession()?.hostSheetIndex;

  // Determine if we're viewing a different sheet than the formula source
  const isViewingDifferentSheet = isInFormulaMode &&
    sourceIndex !== undefined &&
    sourceIndex !== activeIndex;

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
      (isInFormulaMode && sourceIndex === s.index)
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
              sourceIndex === sheet.index;
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

      {/* Add sheet: a SPLIT control. The "+" keeps its one-click worksheet add
          (and its title, which journeys select by); the caret opens the kind
          menu. Outside TabsArea to avoid overflow clipping. */}
      {!isLoading && (
        <S.AddButton
          type="button"
          tabIndex={-1}
          $disabled={structuralLocked}
          onClick={() => void handleAddSheet()}
          title={structuralLocked ? "Finish formula editing first" : "Add new sheet"}
          disabled={structuralLocked}
        >
          +
        </S.AddButton>
      )}
      {!isLoading && (
        <S.AddCaretButton
          type="button"
          tabIndex={-1}
          $disabled={structuralLocked}
          disabled={structuralLocked}
          aria-haspopup="menu"
          aria-expanded={addMenu !== null}
          data-add-sheet-menu-trigger
          title={structuralLocked ? "Finish formula editing first" : "Add a worksheet or a canvas"}
          onClick={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setAddMenu((open) => (open ? null : { x: rect.left, y: rect.top - 2 }));
          }}
        >
          &#9662;
        </S.AddCaretButton>
      )}
      {addMenu && (
        <S.ContextMenu ref={addMenuRef} role="menu" $x={addMenu.x} $y={addMenu.y}>
          <S.ContextMenuItem
            type="button"
            role="menuitem"
            data-add-sheet-kind="worksheet"
            onClick={() => void handleAddSheet("worksheet")}
          >
            Worksheet
          </S.ContextMenuItem>
          <S.ContextMenuItem
            type="button"
            role="menuitem"
            data-add-sheet-kind="canvas"
            onClick={() => void handleAddSheet("canvas")}
          >
            Canvas
          </S.ContextMenuItem>
        </S.ContextMenu>
      )}

      {/* Formula mode indicator */}
      {isViewingDifferentSheet && (
        <S.FormulaModeIndicator>
          Selecting from: {sheetAt(sheets, activeIndex)?.name} 
          {" --> "}
          {editing?.sourceSheetName || sheetAt(sheets, sourceIndex ?? 0)?.name}
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
                    void handleUnhideConfirm(sheet.index);
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
                onClick={() => void handleUnhideConfirm()}
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