// FILENAME: shell/SheetTabs/SheetTabs.tsx
// PURPOSE: Sheet tabs component for switching between worksheets
// CONTEXT: Enhanced to support sheet switching during formula editing without page reload.
//          Key fix: Uses global flag to prevent blur commit during formula mode navigation.

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  getSheets,
  setActiveSheet as setActiveSheetApi,
  addSheet,
  deleteSheet,
  renameSheet,
  type SheetInfo,
  type SheetsResult,
} from "../../core/lib/tauri-api";
import {
  sheetExtensions,
  registerCoreSheetContextMenu,
  type SheetContext,
  type SheetContextMenuItem,
} from "../../core/extensions";
import { useGridContext } from "../../core/state/GridContext";
import { setActiveSheet, setSheetContext } from "../../core/state/gridActions";
import { isFormulaExpectingReference } from "../../core/types";
import { setPreventBlurCommit } from "../../core/components/InlineEditor/InlineEditor";

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
        setPreventBlurCommit(true);
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

      // Emit before event
      await sheetExtensions.emit({
        type: "sheet:beforeSwitch",
        sheetIndex: index,
        sheetName: sheets[index]?.name || "",
        previousIndex: activeIndex,
      });

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

          // Emit after event
          await sheetExtensions.emit({
            type: "sheet:afterSwitch",
            sheetIndex: result.activeIndex,
            sheetName: newActiveSheet?.name || "",
            previousIndex: activeIndex,
          });

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

        await sheetExtensions.emit({
          type: "sheet:afterSwitch",
          sheetIndex: result.activeIndex,
          sheetName: newActiveSheet?.name || "",
          previousIndex: activeIndex,
        });

        onSheetChange?.(result.activeIndex, newActiveSheet?.name || "");
        
        // Reload to refresh grid data (only in non-formula mode)
        window.location.reload();
      } catch (err) {
        console.error("[SheetTabs] setActiveSheet error:", err);
        // Clear the prevent flag on error
        setPreventBlurCommit(false);
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

    await sheetExtensions.emit({
      type: "sheet:beforeAdd",
      sheetIndex: sheets.length,
      sheetName: "",
    });

    try {
      const result = await addSheet();
      setSheets(result.sheets);
      setActiveIndex(result.activeIndex);

      await sheetExtensions.emit({
        type: "sheet:afterAdd",
        sheetIndex: result.activeIndex,
        sheetName: result.sheets[result.activeIndex]?.name || "",
        newIndex: result.activeIndex,
      });

      onSheetChange?.(result.activeIndex, result.sheets[result.activeIndex]?.name || "");
      window.location.reload();
    } catch (err) {
      console.error("[SheetTabs] addSheet error:", err);
      alert("Failed to add sheet: " + String(err));
    }
  }, [sheets.length, onSheetChange, isInFormulaMode]);

  const handleDeleteSheet = useCallback(
    async (index: number) => {
      if (sheets.length <= 1) return;
      
      // Don't allow deleting sheets while in formula mode
      if (isInFormulaMode) {
        return;
      }

      await sheetExtensions.emit({
        type: "sheet:beforeDelete",
        sheetIndex: index,
        sheetName: sheets[index]?.name || "",
      });

      try {
        const result = await deleteSheet(index);
        setSheets(result.sheets);
        setActiveIndex(result.activeIndex);

        await sheetExtensions.emit({
          type: "sheet:afterDelete",
          sheetIndex: index,
          sheetName: "",
        });

        onSheetChange?.(result.activeIndex, result.sheets[result.activeIndex]?.name || "");
        window.location.reload();
      } catch (err) {
        console.error("[SheetTabs] deleteSheet error:", err);
        alert("Failed to delete sheet: " + String(err));
      }
    },
    [sheets, onSheetChange, isInFormulaMode]
  );

  const handleRenameSheet = useCallback(
    async (index: number, newName: string) => {
      // Don't allow renaming sheets while in formula mode
      if (isInFormulaMode) {
        return;
      }

      const oldName = sheets[index]?.name || "";

      await sheetExtensions.emit({
        type: "sheet:beforeRename",
        sheetIndex: index,
        sheetName: newName,
        previousName: oldName,
      });

      try {
        const result = await renameSheet(index, newName);
        setSheets(result.sheets);

        await sheetExtensions.emit({
          type: "sheet:afterRename",
          sheetIndex: index,
          sheetName: newName,
          previousName: oldName,
        });
      } catch (err) {
        console.error("[SheetTabs] renameSheet error:", err);
        alert("Failed to rename sheet: " + String(err));
      }
    },
    [sheets, isInFormulaMode]
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
    <div style={styles.container}>
      {/* Navigation arrows */}
      <div style={styles.navArea}>
        <button style={styles.navButton} title="First sheet" disabled>
          |&lt;
        </button>
        <button style={styles.navButton} title="Previous sheet" disabled>
          &lt;
        </button>
        <button style={styles.navButton} title="Next sheet" disabled>
          &gt;
        </button>
        <button style={styles.navButton} title="Last sheet" disabled>
          &gt;|
        </button>
      </div>

      {/* Sheet tabs */}
      <div style={styles.tabsArea}>
        {isLoading ? (
          <span style={styles.loadingText}>Loading...</span>
        ) : (
          <>
            {sheets.map((sheet) => {
              const isSourceSheet = isInFormulaMode && 
                editing?.sourceSheetIndex === sheet.index;
              const isTargetSheet = isInFormulaMode && 
                sheet.index === activeIndex && 
                !isSourceSheet;
              
              return (
                <button
                  key={sheet.index}
                  type="button"
                  tabIndex={-1}
                  style={{
                    ...styles.tab,
                    ...(sheet.index === activeIndex ? styles.activeTab : {}),
                    ...(isSourceSheet ? styles.formulaSourceTab : {}),
                    ...(isTargetSheet ? styles.formulaTargetTab : {}),
                  }}
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
                  {isSourceSheet && <span style={styles.sourceIndicator}> [*]</span>}
                </button>
              );
            })}
            <button
              type="button"
              tabIndex={-1}
              style={{
                ...styles.addButton,
                ...(isInFormulaMode ? styles.disabledButton : {}),
              }}
              onClick={handleAddSheet}
              title={isInFormulaMode ? "Finish formula editing first" : "Add new sheet"}
              disabled={isInFormulaMode}
            >
              +
            </button>
          </>
        )}
        {error && (
          <span style={styles.errorText} title={error}>
            [API Error]
          </span>
        )}
      </div>

      {/* Formula mode indicator */}
      {isViewingDifferentSheet && (
        <div style={styles.formulaModeIndicator}>
          Selecting from: {sheets[activeIndex]?.name} 
          {" --> "}
          {editing?.sourceSheetName || sheets[editing?.sourceSheetIndex ?? 0]?.name}
        </div>
      )}

      {/* Scroll bar area */}
      <div style={styles.scrollArea}></div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            ...styles.contextMenu,
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          {getContextMenuItems(contextMenu.sheetIndex).map((item, idx) => (
            <React.Fragment key={item.id}>
              <button
                type="button"
                style={{
                  ...styles.contextMenuItem,
                  ...(item.disabled ? styles.contextMenuItemDisabled : {}),
                }}
                onClick={() => handleContextMenuItemClick(item)}
                disabled={!!item.disabled}
              >
                {item.icon && <span style={styles.contextMenuIcon}>{item.icon}</span>}
                {item.label}
              </button>
              {item.separatorAfter && <div style={styles.contextMenuSeparator} />}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    height: "26px",
    backgroundColor: "#f0f0f0",
    borderTop: "1px solid #d0d0d0",
    userSelect: "none",
    fontSize: "12px",
    position: "relative",
  },
  navArea: {
    display: "flex",
    alignItems: "center",
    padding: "0 4px",
    borderRight: "1px solid #d0d0d0",
  },
  navButton: {
    width: "20px",
    height: "20px",
    padding: 0,
    border: "none",
    backgroundColor: "transparent",
    color: "#666",
    cursor: "pointer",
    fontSize: "10px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  tabsArea: {
    display: "flex",
    alignItems: "center",
    flex: "0 1 auto",
    overflow: "hidden",
    padding: "0 4px",
  },
  tab: {
    padding: "4px 12px",
    border: "1px solid #c0c0c0",
    borderBottom: "none",
    borderRadius: "4px 4px 0 0",
    backgroundColor: "#e8e8e8",
    color: "#333",
    cursor: "pointer",
    fontSize: "11px",
    marginRight: "2px",
    whiteSpace: "nowrap",
    maxWidth: "120px",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  activeTab: {
    backgroundColor: "#ffffff",
    borderBottom: "1px solid #ffffff",
    marginBottom: "-1px",
    fontWeight: 500,
  },
  formulaSourceTab: {
    backgroundColor: "#fff3e0",
    borderColor: "#ff9800",
  },
  formulaTargetTab: {
    backgroundColor: "#e3f2fd",
    borderColor: "#2196f3",
  },
  sourceIndicator: {
    color: "#ff9800",
    fontWeight: "bold",
  },
  addButton: {
    width: "22px",
    height: "20px",
    padding: 0,
    border: "1px solid #c0c0c0",
    borderRadius: "4px",
    backgroundColor: "#e8e8e8",
    color: "#666",
    cursor: "pointer",
    fontSize: "14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "4px",
  },
  disabledButton: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  scrollArea: {
    flex: 1,
    minWidth: "50px",
  },
  loadingText: {
    color: "#888",
    fontStyle: "italic",
    padding: "0 8px",
  },
  errorText: {
    color: "#c00",
    fontStyle: "italic",
    padding: "0 8px",
    cursor: "help",
  },
  formulaModeIndicator: {
    padding: "0 8px",
    color: "#1976d2",
    fontSize: "11px",
    fontStyle: "italic",
    backgroundColor: "#e3f2fd",
    borderRadius: "3px",
    marginLeft: "4px",
  },
  contextMenu: {
    position: "fixed",
    backgroundColor: "#ffffff",
    border: "1px solid #c0c0c0",
    borderRadius: "4px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
    padding: "4px 0",
    minWidth: "150px",
    zIndex: 10000,
  },
  contextMenuItem: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    padding: "6px 12px",
    border: "none",
    backgroundColor: "transparent",
    cursor: "pointer",
    fontSize: "12px",
    color: "#333",
    textAlign: "left",
  },
  contextMenuItemDisabled: {
    color: "#999",
    cursor: "default",
  },
  contextMenuIcon: {
    marginRight: "8px",
    width: "16px",
  },
  contextMenuSeparator: {
    height: "1px",
    backgroundColor: "#e0e0e0",
    margin: "4px 0",
  },
};