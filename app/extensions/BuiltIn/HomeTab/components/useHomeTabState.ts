//! FILENAME: app/extensions/BuiltIn/HomeTab/components/useHomeTabState.ts
// PURPOSE: Shared hook that provides formatting state and actions for Home tab groups.
// CONTEXT: Extracted from HomeTabComponent so each group can be a separate registered
// component while sharing the same selection/style state.

import { useState, useEffect, useCallback, useRef } from "react";
import { useGridState, cellEvents } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { CommandRegistry, CoreCommands } from "@api/commands";
import { DialogExtensions } from "@api/ui";
import {
  getCell,
  getStyle,
  applyFormatting,
  setCellRichText,
} from "@api/lib";
import type { RichTextRun, CellData } from "@api/types";
import type { StyleData } from "@api/types";
import {
  ITEMS_BY_ID,
  type HomeTabItem,
} from "../homeTabConfig";
import type { CellStyleDefinition } from "./CellStylesGallery";

export function useHomeTabState() {
  const gridState = useGridState();
  const [currentStyle, setCurrentStyle] = useState<StyleData | null>(null);
  const [currentCellData, setCurrentCellData] = useState<CellData | null>(null);

  // Cache the last known non-null selection so ribbon button clicks
  // (which steal focus and may clear gridState.selection) still work.
  const lastSelectionRef = useRef(gridState.selection);
  useEffect(() => {
    if (gridState.selection) {
      lastSelectionRef.current = gridState.selection;
    }
  }, [gridState.selection]);

  // Load style of active cell when selection changes
  useEffect(() => {
    const sel = gridState.selection;
    if (!sel) {
      setCurrentStyle(null);
      return;
    }
    let cancelled = false;
    getCell(sel.startRow, sel.startCol).then((cell) => {
      if (cancelled || !cell) return;
      setCurrentCellData(cell);
      return getStyle(cell.styleIndex).then((style) => {
        if (!cancelled) setCurrentStyle(style);
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [gridState.selection]);

  // Get the rows/cols arrays for current selection
  const getSelectionRange = useCallback(() => {
    const snapshot = getGridStateSnapshot();
    const sel = snapshot?.selection ?? lastSelectionRef.current;
    if (!sel) return null;
    const startRow = Math.min(sel.startRow, sel.endRow);
    const endRow = Math.max(sel.startRow, sel.endRow);
    const startCol = Math.min(sel.startCol, sel.endCol);
    const endCol = Math.max(sel.startCol, sel.endCol);
    const rows: number[] = [];
    const cols: number[] = [];
    for (let r = startRow; r <= endRow; r++) rows.push(r);
    for (let c = startCol; c <= endCol; c++) cols.push(c);
    return { rows, cols };
  }, []);

  // Apply formatting and refresh
  const applyFormat = useCallback(
    async (formatting: Record<string, unknown>) => {
      const range = getSelectionRange();
      if (!range) return;
      try {
        const result = await applyFormatting(
          range.rows,
          range.cols,
          formatting as Parameters<typeof applyFormatting>[2]
        );
        for (const cell of result.cells) {
          cellEvents.emit({
            row: cell.row,
            col: cell.col,
            oldValue: undefined,
            newValue: cell.display,
            formula: cell.formula,
          });
        }
        window.dispatchEvent(new CustomEvent("styles:refresh"));
        window.dispatchEvent(new CustomEvent("grid:refresh"));
        const freshSnapshot = getGridStateSnapshot();
        const sel = freshSnapshot?.selection ?? lastSelectionRef.current;
        if (sel) {
          const cell = await getCell(sel.startRow, sel.startCol);
          if (cell) {
            const style = await getStyle(cell.styleIndex);
            setCurrentStyle(style);
          }
        }
      } catch (err) {
        console.error("[HomeTab] Failed to apply formatting:", err);
      }
    },
    [getSelectionRange]
  );

  // Handle item click
  const handleItemClick = useCallback(
    async (item: HomeTabItem) => {
      switch (item.id) {
        case "cut": await CommandRegistry.execute(CoreCommands.CUT); break;
        case "copy": await CommandRegistry.execute(CoreCommands.COPY); break;
        case "paste": await CommandRegistry.execute(CoreCommands.PASTE); break;
        case "formatPainter": await CommandRegistry.execute(CoreCommands.FORMAT_PAINTER); break;
        case "bold": await applyFormat({ bold: !(currentStyle?.bold ?? false) }); break;
        case "italic": await applyFormat({ italic: !(currentStyle?.italic ?? false) }); break;
        case "underline": await applyFormat({ underline: (currentStyle?.underline ?? "none") !== "none" ? "none" : "single" }); break;
        case "strikethrough": await applyFormat({ strikethrough: !(currentStyle?.strikethrough ?? false) }); break;
        case "superscript":
        case "subscript": {
          const sel = gridState.selection ?? lastSelectionRef.current;
          if (!sel) break;
          const isSuperscript = item.id === "superscript";
          const cellData = await getCell(sel.startRow, sel.startCol);
          const cellText = cellData?.display ?? "";
          if (!cellText) break;
          const runs = cellData?.richText;
          const isCurrentlyActive = runs?.length === 1 &&
            (isSuperscript ? runs[0].superscript : runs[0].subscript);
          if (isCurrentlyActive) {
            await setCellRichText(sel.startRow, sel.startCol, null);
          } else {
            const run: RichTextRun = { text: cellText, superscript: isSuperscript, subscript: !isSuperscript };
            await setCellRichText(sel.startRow, sel.startCol, [run]);
          }
          const updated = await getCell(sel.startRow, sel.startCol);
          if (updated) setCurrentCellData(updated);
          break;
        }
        case "formatCells": await CommandRegistry.execute(CoreCommands.FORMAT_CELLS); break;
        case "alignLeft": await applyFormat({ textAlign: currentStyle?.textAlign === "left" ? "general" : "left" }); break;
        case "alignCenter": await applyFormat({ textAlign: currentStyle?.textAlign === "center" ? "general" : "center" }); break;
        case "alignRight": await applyFormat({ textAlign: currentStyle?.textAlign === "right" ? "general" : "right" }); break;
        case "wrapText": await applyFormat({ wrapText: !(currentStyle?.wrapText ?? false) }); break;
        case "increaseIndent": await applyFormat({ indent: Math.min(15, (currentStyle?.indent ?? 0) + 1) }); break;
        case "decreaseIndent": await applyFormat({ indent: Math.max(0, (currentStyle?.indent ?? 0) - 1) }); break;
        case "mergeCells": await CommandRegistry.execute(CoreCommands.MERGE_CELLS); break;
        case "percentFormat": await applyFormat({ numberFormat: "0%" }); break;
        case "commaFormat": await applyFormat({ numberFormat: "#,##0" }); break;
        case "increaseDecimal": {
          const fmt = currentStyle?.numberFormat ?? "General";
          const decMatch = fmt.match(/(\d+)\s*decimal/i);
          const currentDecimals = decMatch ? parseInt(decMatch[1], 10) : 0;
          const hasSep = fmt.includes("separator");
          const newDecimals = currentDecimals + 1;
          const decPart = newDecimals > 0 ? "." + "0".repeat(newDecimals) : "";
          await applyFormat({ numberFormat: hasSep ? `#,##0${decPart}` : `0${decPart}` });
          break;
        }
        case "decreaseDecimal": {
          const fmt = currentStyle?.numberFormat ?? "General";
          const decMatch = fmt.match(/(\d+)\s*decimal/i);
          const currentDecimals = decMatch ? parseInt(decMatch[1], 10) : 0;
          if (currentDecimals > 0) {
            const hasSep = fmt.includes("separator");
            const newDecimals = currentDecimals - 1;
            const decPart = newDecimals > 0 ? "." + "0".repeat(newDecimals) : "";
            await applyFormat({ numberFormat: hasSep ? `#,##0${decPart}` : `0${decPart}` });
          }
          break;
        }
        case "undo": await CommandRegistry.execute(CoreCommands.UNDO); break;
        case "redo": await CommandRegistry.execute(CoreCommands.REDO); break;
        case "find": await CommandRegistry.execute(CoreCommands.FIND); break;
        case "clearContents": await CommandRegistry.execute(CoreCommands.CLEAR_CONTENTS); break;
        case "clearFormatting": await CommandRegistry.execute(CoreCommands.CLEAR_FORMATTING); break;
        case "clearAll": await CommandRegistry.execute(CoreCommands.CLEAR_ALL); break;
        case "insertRow": await CommandRegistry.execute(CoreCommands.INSERT_ROW); break;
        case "insertColumn": await CommandRegistry.execute(CoreCommands.INSERT_COLUMN); break;
        case "deleteRow": await CommandRegistry.execute(CoreCommands.DELETE_ROW); break;
        case "deleteColumn": await CommandRegistry.execute(CoreCommands.DELETE_COLUMN); break;
      }
    },
    [applyFormat, currentStyle, gridState.selection]
  );

  // Handle color selection
  const handleColorSelect = useCallback(
    async (itemId: string, color: string) => {
      if (itemId === "textColor") {
        await applyFormat({ textColor: color });
      } else if (itemId === "backgroundColor") {
        await applyFormat({ backgroundColor: color });
      }
    },
    [applyFormat]
  );

  // Handle cell style gallery selection
  const handleCellStyleApply = useCallback(
    async (formatting: CellStyleDefinition["formatting"]) => {
      await applyFormat(formatting as Record<string, unknown>);
    },
    [applyFormat]
  );

  // Check if a toggle item is active
  const isActive = useCallback(
    (itemId: string): boolean => {
      if (!currentStyle) return false;
      switch (itemId) {
        case "bold": return currentStyle.bold;
        case "italic": return currentStyle.italic;
        case "underline": return currentStyle.underline !== "none";
        case "strikethrough": return currentStyle.strikethrough;
        case "wrapText": return currentStyle.wrapText;
        case "alignLeft": return currentStyle.textAlign === "left";
        case "alignCenter": return currentStyle.textAlign === "center";
        case "alignRight": return currentStyle.textAlign === "right";
        case "superscript": {
          const runs = currentCellData?.richText;
          return !!(runs?.length === 1 && runs[0].superscript);
        }
        case "subscript": {
          const runs = currentCellData?.richText;
          return !!(runs?.length === 1 && runs[0].subscript);
        }
        default: return false;
      }
    },
    [currentStyle, currentCellData]
  );

  // Get current color for color items
  const getCurrentColor = useCallback(
    (itemId: string): string => {
      if (!currentStyle) return itemId === "textColor" ? "#000000" : "#ffffff";
      if (itemId === "textColor") return currentStyle.textColor;
      if (itemId === "backgroundColor") return currentStyle.backgroundColor;
      return "#000000";
    },
    [currentStyle]
  );

  return {
    currentStyle,
    currentCellData,
    handleItemClick,
    handleColorSelect,
    handleCellStyleApply,
    isActive,
    getCurrentColor,
    applyFormat,
    getItemById: (id: string) => ITEMS_BY_ID.get(id),
  };
}
