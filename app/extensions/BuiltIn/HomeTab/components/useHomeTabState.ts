//! FILENAME: app/extensions/BuiltIn/HomeTab/components/useHomeTabState.ts
// PURPOSE: Shared hook that provides formatting state and actions for Home tab groups.
// CONTEXT: Each layout group renders as its own panel section; this hook lets every
// section component share the same selection/style state and formatting actions.
//
// "THE CELL" IS THE ACTIVE CELL. Every read and write here that is about one
// cell -- the style the ribbon shows, superscript/subscript's rich text, the
// cell Increase/Decrease Decimal reads its format from -- uses activeCellOf
// (@api/activeCell, the one rule Core, Format Cells and the mini toolbar read
// too): activeRow/activeCol, else endRow/endCol, which is where the grid draws
// the active-cell border. It used to read startRow/startCol, the ANCHOR, so
// after a drag the ribbon described the cell the drag began on.
//
// EVERY BLOCK. A WRITE covers every block of the selection (@api/selectionBlocks:
// the main range first, then each Ctrl+click / Go To Special range), several
// blocks as ONE undo step. It used to write the main range only, so after Go
// To Special > Constants, Bold formatted the first match and nothing else,
// while Borders and Clear on the same selection covered every block (review
// finding, 2026-10-04).
//
// EXCEL, MEASURED. Increase/Decrease Font Size walk Excel's ladder (not the
// Size list), Increase Indent is Excel's (General/Center become Left, angled
// text goes horizontal, cap 250), Comma Style is the backend's `comma` preset,
// and Increase/Decrease Decimal are the backend's own step. Each rule's
// measurement is cited where it is applied.
//
// A FLOATING GRID'S CELLS (P3, owner finding G3). Every door here asks
// `resolveCellTarget(action, capability)` (@api/cellTarget) instead of only
// refusing: with nothing else holding the selection it is Core's selection as
// before; with a floating grid's cell selected (and the grid admitting the
// act) it is THAT grid's own selection, written through `{ target }` -- the
// backend resolves the grid's hidden backing sheet. An owner that does not
// admit the act refuses, once, as before (BUG-0185). The ribbon's pressed
// state reads the same cell the doors write (`cellTargetFor("read")` plus
// `readTargetCell`), and re-reads when the owner's selection moves
// (`onCellTargetChanged`), so Bold lights for the floating grid's cell.

import { useState, useEffect, useCallback, useRef } from "react";
import { useGridState } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { CommandRegistry, CoreCommands } from "@api/commands";
import {
  getCell,
  getStyle,
  applyFormatting,
  setCellRichText,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api/lib";
import type { RichTextRun, CellData, FormattingResult, Selection } from "@api/types";
import type { StyleData } from "@api/types";
import { activeCellOf } from "@api/activeCell";
import { selectionBlocks } from "@api/selectionBlocks";
import { announceFormattingResult } from "@api/announceFormatting";
import { ownUndoTransaction } from "@api/undoTicket";
import {
  ITEMS_BY_ID,
  type HomeTabItem,
} from "../homeTabConfig";
import type { CellStyleDefinition } from "../../../_shared/components/CellStylesGallery";
import { alertAsync } from "@api/dialogs";
import {
  resolveCellTarget,
  cellTargetFor,
  targetRefOf,
  readTargetCell,
  onCellTargetChanged,
  type CellTargetCapability,
} from "@api/cellTarget";
import { clipboardDoorCommand } from "@api/objectClipboard";
import type { MergeMenuCommand } from "./homeTabIcons";
import { FONT_SIZE_LADDER, fontSizeStep } from "../../../_shared/lib/fontList";
import { COMMA_STYLE_PRESET, rowsColsOf, stepNumberFormatDecimals } from "./alignment/numberGroupCommands";

/** The CoreCommand behind each row of the Merge & Center menu. */
export const MERGE_MENU_COMMAND_IDS: Readonly<Record<MergeMenuCommand, string>> = {
  mergeCenter: CoreCommands.MERGE_CENTER,
  mergeAcross: CoreCommands.MERGE_ACROSS,
  mergeCells: CoreCommands.MERGE_CELLS,
  unmergeCells: CoreCommands.UNMERGE_CELLS,
};

/**
 * Excel's Increase / Decrease Font Size ladder and its step live in ONE place,
 * @api/fontSizeLadder (re-exported by _shared/lib/fontList, imported above),
 * which the mini format toolbar's Grow / Shrink use too: its own copy had
 * already drifted (no 26, wrote past both ends). Re-exported here for this
 * file's existing readers.
 */
export { FONT_SIZE_LADDER, fontSizeStep };

/** Excel's largest indent (measured: 250 sets, 251 is refused; probe9). */
export const MAX_INDENT = 250;

/**
 * What Excel's Increase Indent writes, given the active cell's style; null
 * when it changes nothing (already at MAX_INDENT). Measured live (alignment
 * survey, probes 6-8):
 *  - General and Center become LEFT; Right stays right, Left stays left;
 *  - ANGLED text (any rotation but stacked) goes back to horizontal, and the
 *    alignment is left as it was -- the indent rule and an angle cannot both
 *    hold (Excel greys the angle rows while indent > 0);
 *  - STACKED text keeps its orientation and becomes Left like any other.
 */
export function increaseIndentFormatting(style: StyleData | null): Record<string, unknown> | null {
  const indent = style?.indent ?? 0;
  if (indent >= MAX_INDENT) return null;
  const formatting: Record<string, unknown> = { indent: indent + 1 };
  const rotation = style?.textRotation ?? "none";
  if (rotation !== "none" && rotation !== "vertical") {
    formatting.textRotation = "none";
    return formatting;
  }
  const align = style?.textAlign ?? "general";
  if (align === "general" || align === "center") formatting.textAlign = "left";
  return formatting;
}

/**
 * The capability a formatting write asks for: a write of the number format
 * alone is the Number group's ("numberFormat": the dropdown, Percent, Comma,
 * Accounting); anything else is "format".
 */
export function formatCapabilityOf(formatting: Record<string, unknown>): CellTargetCapability {
  const keys = Object.keys(formatting).filter((k) => formatting[k] !== undefined);
  return keys.length === 1 && keys[0] === "numberFormat" ? "numberFormat" : "format";
}

/**
 * The cell the ribbon describes, read where the doors would write: a floating
 * grid's active cell (through its target) when its owner admits a read, else
 * Core's active cell of `gridSelection`. `null`: there is no active cell.
 * `cell: null`: the active cell stores nothing.
 */
export async function readRibbonCell(
  gridSelection: Selection | null | undefined,
): Promise<{ cell: CellData | null } | null> {
  const answer = cellTargetFor("read");
  if ("kind" in answer && answer.kind === "object") {
    const active = activeCellOf(answer.selection);
    if (!active) return null;
    return { cell: await readTargetCell(answer.ref, active.row, active.col) };
  }
  const active = activeCellOf(gridSelection);
  if (!active) return null;
  return { cell: await getCell(active.row, active.col) };
}

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
    // A floating grid's selection moved (or its cells were written through a
    // target): the ribbon describes ITS active cell, which Core's selection
    // object does not follow.
    const stopTarget = onCellTargetChanged(bump);
    return () => {
      if (timer) clearTimeout(timer);
      stopTarget();
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
    let cancelled = false;
    readRibbonCell(gridState.selection).then((read) => {
      if (cancelled) return;
      if (!read) {
        setCurrentCellData(null);
        setCurrentStyle(null);
        return;
      }
      const cell = read.cell;
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

  /** Every block of the current selection, the main one first, each as the
   *  rows and columns applyFormatting takes (see "EVERY BLOCK" above). */
  const getSelectionBlocks = useCallback(() => {
    const snapshot = getGridStateSnapshot();
    const sel = snapshot?.selection ?? lastSelectionRef.current;
    return selectionBlocks(sel).map(rowsColsOf);
  }, []);

  /**
   * Re-read the ACTIVE cell's style straight after a write, so the ribbon
   * shows what was just applied without waiting for the coalesced
   * `grid:refresh` re-read. Never throws: a failed re-read must not turn a
   * write that LANDED into a reported failure.
   */
  const rereadActiveStyle = useCallback(async () => {
    try {
      const read = await readRibbonCell(getGridStateSnapshot()?.selection ?? lastSelectionRef.current);
      if (!read?.cell) return;
      setCurrentStyle(await getStyle(read.cell.styleIndex));
    } catch {
      // The coalesced document re-read (above) will catch up.
    }
  }, []);

  /**
   * Apply formatting and refresh. THE Home tab's formatting door: every
   * button, picker, colour and the cell-style gallery come through here, so
   * this is where a selection owner (a floating grid's selected cell, with
   * Core's selection HIDDEN under it -- BUG-0185) is asked WHICH cells: its
   * own, when it admits the act (written through `{ target }`), else it
   * refuses, once. A write of the number format alone asks "numberFormat".
   *
   * EVERY BLOCK of the selection, one applyFormatting call each, inside ONE
   * owned undo transaction when there are several (so one Ctrl+Z restores
   * every area). A block refused part-way stops the gesture: what landed is
   * COMMITTED -- a cancel would drop the undo record and keep the writes --
   * and an empty step is cancelled.
   *
   * ANSWERS WHETHER IT WROTE: true when a write landed (in at least one
   * block); false when a selection owner refused it, there is no selection, or
   * the backend refused it before anything landed. The Orientation menu reads
   * that answer to skip the AutoFit after a refused rotation.
   *
   * A BACKEND REFUSAL REACHES THE USER HERE. It used to be logged to the
   * console only, so on a protected sheet Bold, Underline, the colours, the
   * pickers and every other formatting button did nothing at all, silently
   * (number.md, home-font, home-alignment-number). It is shown HERE and never
   * re-thrown: callers that also catch (handleItemClick, the group lanes'
   * runners) would otherwise show it twice.
   */
  const applyFormat = useCallback(
    async (formatting: Record<string, unknown>, action = "Formatting"): Promise<boolean> => {
      // WHICH cells: Core's selection, or a floating grid's own (P3). A refusal
      // has been announced once; nothing is written.
      const t = resolveCellTarget(action, formatCapabilityOf(formatting));
      if (t === null) return false;
      const target = targetRefOf(t);
      const blocks = t.kind === "object" ? selectionBlocks(t.selection).map(rowsColsOf) : getSelectionBlocks();
      if (blocks.length === 0) return false;
      // One block: the backend's own step is the one undo step. A begin that
      // fails still lets the write apply (as several steps); a begin that
      // JOINS a script's batch closes nothing -- the holder closes it.
      const tx =
        blocks.length > 1
          ? ownUndoTransaction(await beginUndoTransaction(action).catch(() => null), {
              commitUndoTransaction,
              cancelUndoTransaction,
            })
          : null;
      const landed: FormattingResult[] = [];
      try {
        for (const block of blocks) {
          landed.push(
            await applyFormatting(block.rows, block.cols, formatting as Parameters<typeof applyFormatting>[2], { target }),
          );
        }
        await tx?.commit();
      } catch (err) {
        console.error("[HomeTab] Failed to apply formatting:", err);
        void alertAsync(err instanceof Error ? err.message : String(err));
        const close = landed.length > 0 ? tx?.commit() : tx?.cancel();
        await close?.catch((closeErr: unknown) =>
          console.error("[HomeTab] Formatting: closing the undo step failed:", closeErr),
        );
      }
      if (landed.length === 0) return false;
      announceFormattingResult(landed, { target });
      await rereadActiveStyle();
      return true;
    },
    [getSelectionBlocks, rereadActiveStyle]
  );

  /**
   * Excel's Increase (+1) / Decrease (-1) Decimal: the backend's own step
   * (`adjustNumberFormatDecimals`), which keeps the format's KIND and reads the
   * ACTIVE cell from the first row and column it is sent -- so the active
   * cell goes first (numberGroupCommands.activeCellFirst). The same refusal
   * (selection owner, one toast) and announcement as applyFormat; a backend
   * refusal reaches the user through alertAsync there. This replaced a step
   * computed HERE from the cell's display name, which rebuilt a plain "0.00"
   * and so turned a Currency, Accounting, Percentage or Scientific cell into a
   * plain number.
   */
  const stepDecimals = useCallback(
    async (delta: 1 | -1, action: string) => {
      if (await stepNumberFormatDecimals(delta, action, lastSelectionRef.current)) {
        await rereadActiveStyle();
      }
    },
    [rereadActiveStyle]
  );

  // Handle item click
  const handleItemClick = useCallback(
    async (item: HomeTabItem) => {
      // What a refusal calls this action ("Bold", "Wrap Text").
      const action = item.label || "Formatting";
      try {
      switch (item.id) {
        case "cut": await CommandRegistry.execute(CoreCommands.CUT); break;
        // On a canvas, the canvas's object clipboard -- what Ctrl+C / Ctrl+V
        // run there -- else the cell clipboard: ONE rule, shared with the Edit
        // menu and the canvas key guard (@api/objectClipboard, wave E Y11).
        case "copy": await CommandRegistry.execute(clipboardDoorCommand("copy")); break;
        case "paste": await CommandRegistry.execute(clipboardDoorCommand("paste")); break;
        case "formatPainter": await CommandRegistry.execute(CoreCommands.FORMAT_PAINTER); break;
        case "bold": await applyFormat({ bold: !(currentStyle?.bold ?? false) }, action); break;
        case "italic": await applyFormat({ italic: !(currentStyle?.italic ?? false) }, action); break;
        // (Underline is its own split, font/UnderlineSplitButton, with Excel's
        // measured single/double toggle; it never reaches this door.)
        case "strikethrough": await applyFormat({ strikethrough: !(currentStyle?.strikethrough ?? false) }, action); break;
        case "superscript":
        case "subscript": {
          // Its own write path (rich text, not applyFormat), so its own ask --
          // and its own READ: the cell's text comes from the same place the
          // rich text is written (a floating grid's cell through its target).
          const t = resolveCellTarget(action, "format");
          if (t === null) break;
          const target = targetRefOf(t);
          const active = activeCellOf(
            t.kind === "object" ? t.selection : (gridState.selection ?? lastSelectionRef.current),
          );
          if (!active) break;
          const readCell = (row: number, col: number): Promise<CellData | null> =>
            target ? readTargetCell(target, row, col) : getCell(row, col);
          const isSuperscript = item.id === "superscript";
          const cellData = await readCell(active.row, active.col);
          const cellText = cellData?.display ?? "";
          if (!cellText) break;
          const runs = cellData?.richText;
          const isCurrentlyActive = runs?.length === 1 &&
            (isSuperscript ? runs[0].superscript : runs[0].subscript);
          if (isCurrentlyActive) {
            await setCellRichText(active.row, active.col, null, { target });
          } else {
            const run: RichTextRun = { text: cellText, superscript: isSuperscript, subscript: !isSuperscript };
            await setCellRichText(active.row, active.col, [run], { target });
          }
          // A floating grid repaints from its own read: tell it (and the
          // ribbon) that its cell changed. Core's grid hears the backend.
          if (target) announceFormattingResult(null, { target });
          const updated = await readCell(active.row, active.col);
          if (updated) setCurrentCellData(updated);
          break;
        }
        case "formatCells": await CommandRegistry.execute(CoreCommands.FORMAT_CELLS); break;
        // Excel's ladder (FONT_SIZE_LADDER). Past either end Excel changes
        // nothing, so nothing is written: a same-size write would still dirty
        // the document and add an undo step that undoes nothing.
        case "increaseFontSize":
        case "decreaseFontSize": {
          const next = fontSizeStep(currentStyle?.fontSize ?? 11, item.id === "increaseFontSize" ? 1 : -1);
          if (next !== null) await applyFormat({ fontSize: next }, action);
          break;
        }
        // Vertical alignment is exclusive; clicking the active state returns
        // to the spreadsheet default (bottom), mirroring the h-align toggles.
        case "alignTop": await applyFormat({ verticalAlign: currentStyle?.verticalAlign === "top" ? "bottom" : "top" }, action); break;
        case "alignMiddle": await applyFormat({ verticalAlign: currentStyle?.verticalAlign === "middle" ? "bottom" : "middle" }, action); break;
        case "alignBottom": await applyFormat({ verticalAlign: "bottom" }, action); break;
        case "alignLeft": await applyFormat({ textAlign: currentStyle?.textAlign === "left" ? "general" : "left" }, action); break;
        case "alignCenter": await applyFormat({ textAlign: currentStyle?.textAlign === "center" ? "general" : "center" }, action); break;
        case "alignRight": await applyFormat({ textAlign: currentStyle?.textAlign === "right" ? "general" : "right" }, action); break;
        case "wrapText": await applyFormat({ wrapText: !(currentStyle?.wrapText ?? false) }, action); break;
        // Excel's Increase Indent (increaseIndentFormatting): General/Center
        // become Left, angled text goes horizontal, the cap is 250 (it was 15).
        case "increaseIndent": {
          const formatting = increaseIndentFormatting(currentStyle);
          if (formatting) await applyFormat(formatting, action);
          break;
        }
        // At 0 Excel's Decrease Indent is enabled and changes nothing; so does
        // this (no same-value write, no empty undo step).
        case "decreaseIndent": {
          const indent = currentStyle?.indent ?? 0;
          if (indent > 0) await applyFormat({ indent: indent - 1 }, action);
          break;
        }
        // The Merge & Center split button's icon half: Excel's toggle (merges
        // and centres, or unmerges while the selection holds a merge).
        case "mergeCells": await CommandRegistry.execute(CoreCommands.MERGE_CENTER); break;
        case "percentFormat": await applyFormat({ numberFormat: "0%" }, action); break;
        // Excel's Comma Style: Accounting with no symbol and two decimals, the
        // backend's `comma` preset (it wrote "#,##0", a plain number format).
        case "commaFormat": await applyFormat({ numberFormat: COMMA_STYLE_PRESET }, action); break;
        case "increaseDecimal": await stepDecimals(1, action); break;
        case "decreaseDecimal": await stepDecimals(-1, action); break;
        // The Accounting split's face (alignment/AccountingSplitButton) writes
        // this itself; kept for a path that renders the item as a plain button.
        case "accountingFormat": await applyFormat({ numberFormat: "accounting" }, action); break;
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
    [applyFormat, stepDecimals, currentStyle, gridState.selection]
  );

  /**
   * One row of the Merge & Center menu. Each runs its CoreCommand -- the ONE
   * door the ribbon, Ctrl+M and scripts share, so the warning, the refusals
   * and the undo step are the same from everywhere -- and a refusal that
   * escapes as an error reaches the user, as handleItemClick's do.
   */
  const handleMergeCommand = useCallback(async (command: MergeMenuCommand) => {
    try {
      await CommandRegistry.execute(MERGE_MENU_COMMAND_IDS[command]);
    } catch (err) {
      void alertAsync(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // (Fill Color / Font Color write through applyFormat from their own split,
  // font/ColorSplitButton, which keeps a theme pick a theme slot.)

  // Ribbon font pickers (Font group row 1)
  const handleFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      await applyFormat({ fontFamily }, "Font");
    },
    [applyFormat]
  );

  const handleFontSizeChange = useCallback(
    async (fontSize: number) => {
      if (Number.isFinite(fontSize) && fontSize > 0) {
        await applyFormat({ fontSize }, "Font Size");
      }
    },
    [applyFormat]
  );

  // Number-format dropdown (Number group row 1)
  const handleNumberFormatChange = useCallback(
    async (numberFormat: string) => {
      await applyFormat({ numberFormat }, "Number Format");
    },
    [applyFormat]
  );

  // Handle cell style gallery selection
  const handleCellStyleApply = useCallback(
    async (formatting: CellStyleDefinition["formatting"]) => {
      await applyFormat(formatting as Record<string, unknown>, "Cell Style");
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

  // (The colour bars no longer show the active cell's colour: Excel's bar is
  // the LAST colour applied from that button, which its face re-applies --
  // font/colorChoice.ts keeps it per session.)

  return {
    currentStyle,
    currentCellData,
    handleItemClick,
    handleCellStyleApply,
    handleFontFamilyChange,
    handleFontSizeChange,
    handleNumberFormatChange,
    handleMergeCommand,
    isActive,
    applyFormat,
    getItemById: (id: string) => ITEMS_BY_ID.get(id),
  };
}
