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
} from "../../api";
import type {
  SheetInfo,
  SheetsResult,
  SheetContext,
  SheetContextMenuItem,
} from "../../api";
import * as S from './SheetTabs.styles';

export interface SheetTabsProps {
  onSheetChange?: (sheetIndex: number, sheetName: string) => void;
}

// Register core context menu items once
let coreMenuRegistered = false;

export function SheetTabs({ onSheetChange }: SheetTabsProps): React.ReactElement {
  const { state, dispatch } = useGridContext();
  const { editing } = state;
  
  const [sheets, setSheets] = useState<SheetInfo[]>([{ index: 0, name: "Sheet1" }]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sheetIndex: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Check if we're in formula reference mode
  const isInFormulaMode = editing !== null && isFormulaExpectingReference(editing.value);

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
  }, []);

  // Listen for custom events from context menu actions
  useEffect(() => {
    const handleRename = async (e: Event) => {
      const { index, newName } = (e as CustomEvent).detail;
      await handleRenameSheet(index, newName);
    };

    const handleDelete = async (e: Event) => {
      const { index } = (e as CustomEvent).detail;
      await handleDeleteSheet(index);
    };

    const handleAdd = async () => {
      await handleAddSheet();
    };

    window.addEventListener("sheet:requestRename", handleRename);
    window.addEventListener("sheet:requestDelete", handleDelete);
    window.addEventListener("sheet:requestAdd", handleAdd);

    return () => {
      window.removeEventListener("sheet:requestRename", handleRename);
      window.removeEventListener("sheet:requestDelete", handleDelete);
      window.removeEventListener("sheet:requestAdd", handleAdd);
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
      const activeSheet = result.sheets[result.activeIndex];
      if (activeSheet) {
        dispatch(setSheetContext(result.activeIndex, activeSheet.name));
      }
      setError(null);
    } catch (err) {
      console.error("[SheetTabs] getSheets error:", err);
      setError(String(err));
      setSheets([{ index: 0, name: "Sheet1" }]);
      setActiveIndex(0);
    } finally {
      setIsLoading(false);
    }
  }, [dispatch]);

  /**
   * Handle mousedown on sheet tabs.
   * CRITICAL: When in formula mode, set the global flag to prevent blur commit.
   * This flag is checked by InlineEditor's blur handler.
   */
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, sheetIndex: number) => {
      if (isInFormulaMode && sheetIndex !== activeIndex) {
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
    async (index: number) => {
      if (index === activeIndex) return;

      console.log("[SheetTabs] Sheet click, index:", index, "isInFormulaMode:", isInFormulaMode);

      try {
        // When in formula mode, we need special handling
        if (isInFormulaMode) {
          console.log("[SheetTabs] Formula mode - switching without reload");
          
          // Just update the backend's active sheet for cell selection
          // but DON'T reload the page or exit edit mode
          const result: SheetsResult = await setActiveSheetApi(index);
          setSheets(result.sheets);
          setActiveIndex(result.activeIndex);
          
          const newActiveSheet = result.sheets[result.activeIndex];
          
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
          setTimeout(() => {
            const formulaBar = document.querySelector('[data-formula-bar="true"]') as HTMLInputElement;
            if (formulaBar) {
              formulaBar.focus();
              const len = formulaBar.value.length;
              formulaBar.setSelectionRange(len, len);
            }
          }, 50);
          
          // DO NOT reload - stay in edit mode for formula reference selection
          return;
        }

        // Normal mode: switch sheets with full reload
        const result: SheetsResult = await setActiveSheetApi(index);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);
        
        const newActiveSheet = result.sheets[result.activeIndex];
        
        if (newActiveSheet) {
          dispatch(setActiveSheet(result.activeIndex, newActiveSheet.name));
        }

        onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");

        // Reload to refresh grid data (only in non-formula mode)
        window.location.reload();
      } catch (err) {
        console.error("[SheetTabs] setActiveSheet error:", err);
        // Clear the prevent flag on error
        emitAppEvent(AppEvents.PREVENT_BLUR_COMMIT, false);
        alert("Failed to switch sheet: " + String(err));
      }
    },
    [activeIndex, sheets, onSheetChange, isInFormulaMode, dispatch]
  );

  const handleAddSheet = useCallback(async () => {
    // Don't allow adding sheets while in formula mode
    if (isInFormulaMode) {
      return;
    }

    try {
      const result = await addSheet();
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);

      onSheetChange?.(result.activeIndex, result.sheets[result.activeIndex]?.name || "");
      window.location.reload();
    } catch (err) {
      console.error("[SheetTabs] addSheet error:", err);
      alert("Failed to add sheet: " + String(err));
    }
  }, [onSheetChange, isInFormulaMode]);

  const handleDeleteSheet = useCallback(
    async (index: number) => {
      if (sheets.length <= 1) return;

      // Don't allow deleting sheets while in formula mode
      if (isInFormulaMode) {
        return;
      }

      try {
        const result = await deleteSheet(index);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        onSheetChange?.(result.activeIndex, result.sheets[result.activeIndex]?.name || "");
        window.location.reload();
      } catch (err) {
        console.error("[SheetTabs] deleteSheet error:", err);
        alert("Failed to delete sheet: " + String(err));
      }
    },
    [sheets.length, onSheetChange, isInFormulaMode]
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
        alert("Failed to rename sheet: " + String(err));
      }
    },
    [isInFormulaMode]
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
    (index: number) => {
      // Don't allow rename while in formula mode
      if (isInFormulaMode) {
        return;
      }
      const currentName = sheets[index]?.name || "";
      const newName = prompt("Enter new sheet name:", currentName);
      if (newName && newName.trim() !== "" && newName !== currentName) {
        handleRenameSheet(index, newName.trim());
      }
    },
    [sheets, handleRenameSheet, isInFormulaMode]
  );

  const getContextMenuItems = useCallback(
    (sheetIndex: number): SheetContextMenuItem[] => {
      const sheet = sheets[sheetIndex];
      if (!sheet) return [];

      const context: SheetContext = {
        sheet,
        index: sheetIndex,
        isActive: sheetIndex === activeIndex,
        totalSheets: sheets.length,
      };

      return sheetExtensions.getContextMenuItemsForContext(context);
    },
    [sheets, activeIndex]
  );

  const handleContextMenuItemClick = useCallback(
    async (item: SheetContextMenuItem) => {
      if (!contextMenu) return;

      const sheet = sheets[contextMenu.sheetIndex];
      if (!sheet) return;

      const context: SheetContext = {
        sheet,
        index: contextMenu.sheetIndex,
        isActive: contextMenu.sheetIndex === activeIndex,
        totalSheets: sheets.length,
      };

      setContextMenu(null);

      if (!item.disabled) {
        await item.onClick(context);
      }
    },
    [contextMenu, sheets, activeIndex]
  );

  // Determine if we're viewing a different sheet than the formula source
  const isViewingDifferentSheet = isInFormulaMode && 
    editing?.sourceSheetIndex !== undefined && 
    editing.sourceSheetIndex !== activeIndex;

  return (
    <S.Container>
      {/* Navigation arrows */}
      <S.NavArea>
        <S.NavButton title="First sheet" disabled>
          |&lt;
        </S.NavButton>
        <S.NavButton title="Previous sheet" disabled>
          &lt;
        </S.NavButton>
        <S.NavButton title="Next sheet" disabled>
          &gt;
        </S.NavButton>
        <S.NavButton title="Last sheet" disabled>
          &gt;|
        </S.NavButton>
      </S.NavArea>

      {/* Sheet tabs */}
      <S.TabsArea>
        {isLoading ? (
          <S.LoadingText>Loading...</S.LoadingText>
        ) : (
          sheets.map((sheet) => {
            const isSourceSheet = isInFormulaMode &&
              editing?.sourceSheetIndex === sheet.index;
            const isTargetSheet = isInFormulaMode &&
              sheet.index === activeIndex &&
              !isSourceSheet;

            return (
              <S.Tab
                key={sheet.index}
                type="button"
                tabIndex={-1}
                $isActive={sheet.index === activeIndex}
                $isFormulaSource={isSourceSheet}
                $isFormulaTarget={isTargetSheet}
                onMouseDown={(e) => handleTabMouseDown(e, sheet.index)}
                onClick={() => handleSheetClick(sheet.index)}
                onContextMenu={(e) => handleContextMenu(e, sheet.index)}
                onDoubleClick={() => handleDoubleClick(sheet.index)}
                title={
                  isInFormulaMode
                    ? isSourceSheet
                      ? `Formula source: ${sheet.name}`
                      : `Click to select cells from ${sheet.name}`
                    : `${sheet.name} (right-click for options)`
                }
              >
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
          Selecting from: {sheets[activeIndex]?.name} 
          {" --> "}
          {editing?.sourceSheetName || sheets[editing?.sourceSheetIndex ?? 0]?.name}
        </S.FormulaModeIndicator>
      )}

      {/* Scroll bar area */}
      <S.ScrollArea />

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
    </S.Container>
  );
}