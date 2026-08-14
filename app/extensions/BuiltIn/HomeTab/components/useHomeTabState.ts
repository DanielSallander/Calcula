//! FILENAME: app/extensions/BuiltIn/HomeTab/components/useHomeTabState.ts
// PURPOSE: Shared hook that provides formatting state and actions for Home tab groups.
// CONTEXT: Each layout group renders as its own panel section; this hook lets every
// section component share the same selection/style state and formatting actions.

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
import type { CellStyleDefinition } from "../../../_shared/components/CellStylesGallery";
import { FONT_SIZES } from "../../../_shared/lib/fontList";
import { alertAsync } from "@api/dialogs";

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

  /**
   * Bumped whenever the DOCUMENT changes under a selection that did not move,
   * so the read below runs again. See the effect for why this exists.
   */
  const [documentRevision, setDocumentRevision] = useState(0);
  useEffect(() => {
    // COALESCED, and not as a micro-optimisation. `grid:refresh` is dispatched
    // per edit, and a burst of them (typing, a paste, a bulk format) would
    // otherwise put two IPC reads on the wire per event, behind the same
    // keystrokes the user is still sending. One read per quiet 120 ms answers
    // every case this exists for -- File > New, undo, Clear Formats, a sheet
    // switch -- because all of them end in a quiet moment.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setDocumentRevision((n) => n + 1), 120);
    };
    // `grid:refresh`  - cell content/format changed (undo, redo, clear, paste,
    //                   a script write, File > New via the E2E reset helper).
    // `styles:refresh`- a named style or the style table changed.
    // `app:sheet-changed` - a different sheet is now active, so A1 here is not
    //                   the A1 the ribbon last read.
    for (const name of ["grid:refresh", "styles:refresh", "app:sheet-changed"]) {
      window.addEventListener(name, bump);
    }
    return () => {
      if (timer) clearTimeout(timer);
      for (const name of ["grid:refresh", "styles:refresh", "app:sheet-changed"]) {
        window.removeEventListener(name, bump);
      }
    };
  }, []);

  /**
   * Load the style of the active cell.
   *
   * THIS IS THE RIBBON'S ONLY SOURCE OF FORMATTING TRUTH, and it used to run on
   * `gridState.selection` alone, keeping whatever it last read whenever that
   * object did not change. Two consequences, both measured:
   *
   *  - AN EMPTY CELL INHERITED THE PREVIOUS CELL'S FORMATTING IN THE RIBBON.
   *    `getCell` resolves to null for a cell that holds nothing, and the old
   *    body did `if (cancelled || !cell) return;` -- so selecting a bold cell
   *    and then an empty one left Bold lit, and `isActive` (which reads only
   *    `currentStyle`) had no way to know. Excel clears.
   *  - THE RIBBON SURVIVED THE DOCUMENT. Undo, Clear Formats, a script write
   *    and File > New (through the E2E `resetToNewWorkbook` helper, which calls
   *    `new_file` without the product's full page reload) all leave the
   *    selection object untouched, so nothing re-read. That is what made
   *    `core-empty-grid` a picture of the PREVIOUS run: the font box read
   *    `Calibri` and Center-Vertically was lit on a workbook that had just been
   *    emptied. Ledgered as BUG-0028 in docs/design/open-decisions-2026-08.md.
   *
   * Both are the same defect -- ribbon state that is not a function of the
   * document -- so both are fixed here rather than at the call sites.
   */
  useEffect(() => {
    const sel = gridState.selection;
    if (!sel) {
      setCurrentCellData(null);
      setCurrentStyle(null);
      return;
    }
    let cancelled = false;
    getCell(sel.startRow, sel.startCol).then((cell) => {
      if (cancelled) return;
      if (!cell) {
        // The cell holds nothing: the ribbon must not keep the last cell that
        // did (BUG-0028) — but a null style is not the truth either. A null
        // made the font box fall back to "system-ui", a font no cell in the
        // document renders in, for EVERY empty cell (BUG-0062; the default
        // grid font is Calibri 11 and the renderer paints exactly that). What
        // an empty cell truly carries is the DOCUMENT DEFAULT style — style
        // index 0 — which is also what a value typed here will be written
        // with. Loading it clears Bold/Italic/etc. just as BUG-0028 requires,
        // and reports Calibri 11 as Excel does.
        setCurrentCellData(null);
        return getStyle(0).then((style) => {
          if (!cancelled) setCurrentStyle(style);
        });
      }
      setCurrentCellData(cell);
      return getStyle(cell.styleIndex).then((style) => {
        if (!cancelled) setCurrentStyle(style);
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [gridState.selection, documentRevision]);

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
      try {
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
        case "increaseFontSize": {
          const size = currentStyle?.fontSize ?? 11;
          const next = FONT_SIZES.find((s) => s > size) ?? FONT_SIZES[FONT_SIZES.length - 1];
          await applyFormat({ fontSize: next });
          break;
        }
        case "decreaseFontSize": {
          const size = currentStyle?.fontSize ?? 11;
          const smaller = FONT_SIZES.filter((s) => s < size);
          const next = smaller.length > 0 ? smaller[smaller.length - 1] : FONT_SIZES[0];
          await applyFormat({ fontSize: next });
          break;
        }
        // Vertical alignment is exclusive; clicking the active state returns
        // to the spreadsheet default (bottom), mirroring the h-align toggles.
        case "alignTop": await applyFormat({ verticalAlign: currentStyle?.verticalAlign === "top" ? "bottom" : "top" }); break;
        case "alignMiddle": await applyFormat({ verticalAlign: currentStyle?.verticalAlign === "middle" ? "bottom" : "middle" }); break;
        case "alignBottom": await applyFormat({ verticalAlign: "bottom" }); break;
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
      } catch (err) {
        // Backend refusals (sheet protection, most commonly) must reach the
        // user, not the console — the message says which cell and why.
        void alertAsync(err instanceof Error ? err.message : String(err));
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

  // Ribbon font pickers (Font group row 1)
  const handleFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      await applyFormat({ fontFamily });
    },
    [applyFormat]
  );

  const handleFontSizeChange = useCallback(
    async (fontSize: number) => {
      if (Number.isFinite(fontSize) && fontSize > 0) {
        await applyFormat({ fontSize });
      }
    },
    [applyFormat]
  );

  // Number-format dropdown (Number group row 1)
  const handleNumberFormatChange = useCallback(
    async (numberFormat: string) => {
      await applyFormat({ numberFormat });
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
        case "alignTop": return currentStyle.verticalAlign === "top";
        case "alignMiddle": return currentStyle.verticalAlign === "middle";
        case "alignBottom": return currentStyle.verticalAlign === "bottom";
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

  // Get current color for color items. Falls back per-field so a partial
  // style object can never surface undefined to color consumers.
  const getCurrentColor = useCallback(
    (itemId: string): string => {
      if (itemId === "textColor") return currentStyle?.textColor ?? "#000000";
      if (itemId === "backgroundColor") return currentStyle?.backgroundColor ?? "#ffffff";
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
    handleFontFamilyChange,
    handleFontSizeChange,
    handleNumberFormatChange,
    isActive,
    getCurrentColor,
    applyFormat,
    getItemById: (id: string) => ITEMS_BY_ID.get(id),
  };
}
