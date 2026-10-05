//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/FormatCellsDialog.tsx
// PURPOSE: Main Format Cells dialog component with tab navigation.
// CONTEXT: Opens via Ctrl+1, Format > Format Cells, the ribbon's dialog
// launchers and "More ... Formats" rows (FORMAT_CELLS { tab, category }).
// Loads the active cell's style, allows editing across tabs, and on OK writes
// ONLY what the user changed (lib/formatCellsWrites.ts), as one undo step.

import React, { useEffect, useCallback } from "react";
import type { DialogProps } from "@api/uiTypes";
import { useDialogWindow } from "@api/dialogWindow";
import {
  useGridState,
  cellEvents,
} from "@api";
import {
  getCell,
  getStyle,
  applyFormatting,
  applyBorderPreset,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api/lib";
import { ownUndoTransaction } from "@api/undoTicket";
import { setCellProtection, getCellProtection } from "@api/backend";
import {
  useFormatCellsStore,
  snapshotOf,
  type FillMode,
  type BorderSide,
} from "./hooks/useFormatCellsState";
import { planFormatCellsWrites } from "./lib/formatCellsWrites";
import type { FillData, PatternType, GradientDirection, StyleData, CellData } from "@api";
import { NumberTab } from "./tabs/NumberTab";
import { AlignmentTab } from "./tabs/AlignmentTab";
import { FontTab } from "./tabs/FontTab";
import { BorderTab } from "./tabs/BorderTab";
import { FillTab } from "./tabs/FillTab";
import { ProtectionTab } from "./tabs/ProtectionTab";
import * as S from "./FormatCellsDialog.styles";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { activeCellOf } from "@api/activeCell";

// ============================================================================
// Tab Definitions
// ============================================================================

const TABS = [
  { id: "number", label: "Number", component: NumberTab },
  { id: "alignment", label: "Alignment", component: AlignmentTab },
  { id: "font", label: "Font", component: FontTab },
  { id: "border", label: "Border", component: BorderTab },
  { id: "fill", label: "Fill", component: FillTab },
  { id: "protection", label: "Protection", component: ProtectionTab },
] as const;

// ============================================================================
// Fill Helpers
// ============================================================================

function loadFillFromStyleData(fill: FillData): Partial<{
  fillMode: FillMode;
  backgroundColor: string;
  gradientColor1: string;
  gradientColor2: string;
  gradientDirection: GradientDirection;
  patternType: PatternType;
  patternFgColor: string;
  patternBgColor: string;
}> {
  switch (fill.type) {
    case "solid":
      return { fillMode: "solid", backgroundColor: fill.color };
    case "gradient":
      return {
        fillMode: "gradient",
        gradientColor1: fill.color1,
        gradientColor2: fill.color2,
        gradientDirection: fill.direction,
      };
    case "pattern":
      return {
        fillMode: "pattern",
        patternType: fill.patternType,
        patternFgColor: fill.fgColor,
        patternBgColor: fill.bgColor,
      };
    default:
      return { fillMode: "none" };
  }
}

/** A style's border side as the dialog's Border tab holds it. */
function sideOf(side: StyleData["borderTop"] | undefined): BorderSide {
  return side
    ? { style: side.style as BorderSide["style"], color: side.color }
    : { style: "none", color: "#000000" };
}

/**
 * The style of one cell, an EMPTY cell included. `getCell` answers null for a
 * cell with no data of its own, and the dialog used to load nothing at all for
 * one -- so it showed, and on OK WROTE, its own defaults ("system-ui"). An
 * empty cell shows the default style, exactly as the Home tab reads it.
 */
async function styleAt(row: number, col: number): Promise<StyleData> {
  const cell: CellData | null = await getCell(row, col);
  return getStyle(cell?.styleIndex ?? 0);
}

// ============================================================================
// Main Dialog Component
// ============================================================================

export function FormatCellsDialog(props: DialogProps): React.ReactElement | null {
  const { onClose, data } = props;

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 420, minHeight: 340 });

  const gridState = useGridState();
  const selection = gridState.selection!;

  const store = useFormatCellsStore();
  const { activeTab, setActiveTab, loadFromStyle, reset } = store;

  // Load the active cell's current style when dialog opens
  useEffect(() => {
    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const startCol = Math.min(selection.startCol, selection.endCol);
    const endCol = Math.max(selection.startCol, selection.endCol);
    const multiRow = endRow > startRow;
    const multiCol = endCol > startCol;
    useFormatCellsStore.getState().setRangeShape({ multiRow, multiCol });

    async function loadCurrentStyle() {
      try {
        // The ACTIVE cell (`@api/activeCell`: the cell the grid draws as
        // active), not the anchor: it read the anchor, so after a drag from a
        // bold B2 down to a plain B5 the ribbon showed Bold off while the
        // dialog opened from the Font launcher showed it on (review finding
        // (g), 2026-10-04).
        const { row, col } = activeCellOf(selection)!;

        // Load the active cell's style -- the default style for an empty one.
        const style = await styleAt(row, col);
        loadFromStyle({
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
          strikethrough: style.strikethrough,
          textColor: style.textColor,
          textAlign: style.textAlign,
          verticalAlign: style.verticalAlign,
          wrapText: style.wrapText,
          shrinkToFit: style.shrinkToFit,
          textRotation: style.textRotation,
          indent: style.indent,
          numberFormat: style.numberFormat.toLowerCase().includes("general")
            ? "general"
            : style.numberFormat,
          backgroundColor: style.backgroundColor,
          // Load fill data
          ...(style.fill ? loadFillFromStyleData(style.fill) : {}),
          borderTop: sideOf(style.borderTop),
          borderRight: sideOf(style.borderRight),
          borderBottom: sideOf(style.borderBottom),
          borderLeft: sideOf(style.borderLeft),
          borderDiagonalDown: sideOf(style.borderDiagonalDown),
          borderDiagonalUp: sideOf(style.borderDiagonalUp),
        });

        // On a RANGE the Border tab's four edges are the range's OUTER edges
        // and two more buttons are the lines inside it (Excel), so the edges
        // are read from the corners that own them, and the inside lines from
        // the top-left cell's inner sides.
        if (multiRow || multiCol) {
          const topLeft = await styleAt(startRow, startCol);
          const topRight = multiCol ? await styleAt(startRow, endCol) : topLeft;
          const bottomLeft = multiRow ? await styleAt(endRow, startCol) : topLeft;
          loadFromStyle({
            borderTop: sideOf(topLeft.borderTop),
            borderLeft: sideOf(topLeft.borderLeft),
            borderRight: sideOf(topRight.borderRight),
            borderBottom: sideOf(bottomLeft.borderBottom),
            borderInsideHorizontal: multiRow ? sideOf(topLeft.borderBottom) : sideOf(undefined),
            borderInsideVertical: multiCol ? sideOf(topLeft.borderRight) : sideOf(undefined),
          });
        }

        // Load cell protection
        const protection = await getCellProtection(row, col);
        loadFromStyle({
          locked: protection.locked,
          formulaHidden: protection.formulaHidden,
        });
      } catch (err) {
        console.error("[FormatCellsDialog] Failed to load style:", err);
      }
      // What OK compares against: whatever actually loaded (and the dialog's
      // own defaults where a load failed, so a failure still writes only what
      // the user changed).
      useFormatCellsStore.getState().markBaseline();
    }

    loadCurrentStyle();

    // If data contains an initial tab, switch to it. A `category` (the
    // Number tab's category list, e.g. "accounting" from "More Accounting
    // Formats...") implies the Number tab when no tab is named.
    const category = typeof data?.category === "string" && data.category !== "" ? data.category : null;
    useFormatCellsStore.getState().setNumberCategory(category);
    if (data?.tab && typeof data.tab === "string") {
      setActiveTab(data.tab);
    } else if (category !== null) {
      setActiveTab("number");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- only on mount

  // Handle OK - write what changed
  const handleOK = useCallback(async () => {
    // The selection read below is Core's. If something else took the
    // selection while the dialog was open (BUG-0185), that is a cell the user
    // cannot see: refuse, write nothing, and keep the dialog (and the user's
    // choices) open.
    if (refuseIfSelectionOwned("Format Cells")) return;
    const startRow = Math.min(selection.startRow, selection.endRow);
    const endRow = Math.max(selection.startRow, selection.endRow);
    const startCol = Math.min(selection.startCol, selection.endCol);
    const endCol = Math.max(selection.startCol, selection.endCol);

    // ONLY WHAT CHANGED (survey D5). See lib/formatCellsWrites.ts.
    const state = useFormatCellsStore.getState();
    const plan = planFormatCellsWrites(
      state.baseline,
      snapshotOf(state),
      { startRow, startCol, endRow, endCol },
      state.borderClearAll,
      // What the user CHOSE is written even when it equals the active cell's
      // value -- the dialog has no "mixed" state (review finding (k)).
      state.touched,
    );
    if (plan.calls.length === 0 && plan.protection === null) {
      // Nothing changed: Excel's OK closes, and no empty undo step is left.
      reset();
      onClose();
      return;
    }

    // ONE UNDO STEP for the whole OK, however many calls the plan needs (an
    // outline plus a font change is two). A begin that JOINED a caller's
    // transaction closes nothing; a failure part-way COMMITS what landed, so
    // the half that was written can still be undone (cancel would drop the
    // undo record and keep the writes).
    // A begin that itself fails still lets OK apply -- as separate steps, which
    // is what every OK was before this transaction existed.
    const tx = ownUndoTransaction(await beginUndoTransaction("Format Cells").catch(() => null), {
      commitUndoTransaction,
      cancelUndoTransaction,
    });
    const touched: CellData[] = [];
    const refresh = () => {
      // `grid:refresh` matters for border presets on whole rows/columns, whose
      // `cells` list only the cells that needed a style of their own.
      window.dispatchEvent(new CustomEvent("styles:refresh"));
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    };
    try {
      for (const call of plan.calls) {
        const result =
          call.kind === "format"
            ? await applyFormatting(call.rows, call.cols, call.formatting)
            : await applyBorderPreset(startRow, startCol, endRow, endCol, call.preset, call.style, call.color, call.width);
        touched.push(...result.cells);
      }

      // Protection: only when it changed. The backend refuses a REAL change on
      // a protected sheet; report that rather than closing as if the whole
      // dialog had applied -- the formatting did apply, so the user needs to
      // know which half did not.
      if (plan.protection) {
        const protResult = await setCellProtection({
          startRow,
          startCol,
          endRow,
          endCol,
          locked: plan.protection.locked,
          formulaHidden: plan.protection.formulaHidden,
        });
        if (!protResult.success && protResult.error) {
          void alertAsync(
            `Formatting was applied, but the cell locking change was not:\n\n${protResult.error}`
          );
        }
      }
      await tx.commit();
    } catch (err) {
      // A refusal (a protected sheet, a canvas sheet, a size outside 1..409)
      // used to be written to the console only, so OK simply did nothing. Keep
      // what landed undoable, show it, say why, and keep the dialog -- and the
      // user's choices -- open.
      await tx.commit().catch(() => undefined);
      console.error("[FormatCellsDialog] Failed to apply formatting:", err);
      refresh();
      void alertAsync(`Format Cells could not apply the formatting:\n\n${String(err)}`);
      return;
    }

    // Emit cell change events for each updated cell
    for (const cell of touched) {
      cellEvents.emit({
        row: cell.row,
        col: cell.col,
        oldValue: undefined,
        newValue: cell.display,
        formula: cell.formula,
      });
    }

    // Trigger style cache and grid data refresh so the canvas picks up new styles
    refresh();

    reset();
    onClose();
  }, [selection, onClose, reset]);

  // Handle Cancel
  const handleCancel = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  // Keyboard handling.
  //
  // React bubbles key events through the COMPONENT tree, not the DOM, so a key
  // pressed in a surface this dialog portals to <body> (a colour palette, its
  // hex field, any future dropdown) arrives here too. That key is not the
  // dialog's: Escape there means "close the palette" and Enter "pick this
  // swatch / commit this hex". Treating them as Cancel / OK discarded or
  // applied the whole dialog from inside a popover. So only keys that start in
  // the dialog's own DOM carry the dialog's meaning. The handler sits on the
  // dialog container, so `currentTarget` IS that container's element (the
  // node `win.ref` holds) — no ref read needed.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const box = e.currentTarget;
      const ownKey = e.target instanceof Node && box.contains(e.target);

      if (!ownKey) {
        // Escape from a portalled surface keeps travelling, so that surface's
        // own document-level Escape handling (the popover closing itself)
        // still hears it; every other key stays contained, as before.
        if (e.key !== "Escape") e.stopPropagation();
        return;
      }

      e.stopPropagation();

      if (e.key === "Escape") {
        handleCancel();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Enter confirms unless focus is in a specific input
        const target = e.target as HTMLElement;
        if (target.tagName !== "SELECT") {
          e.preventDefault();
          handleOK();
        }
      }
    },
    [handleCancel, handleOK]
  );

  // Find active tab component
  const activeTabDef = TABS.find((t) => t.id === activeTab) || TABS[0];
  const TabComponent = activeTabDef.component;

  return (
    <S.Backdrop onClick={handleCancel}>
      <S.DialogContainer
        ref={win.ref}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{ position: "relative", ...win.style }}
      >
        {/* Header — drag handle */}
        <S.Header onMouseDown={win.onHeaderMouseDown}>
          <S.Title>Format Cells</S.Title>
          <S.CloseButton onClick={handleCancel} title="Close (Esc)">
            X
          </S.CloseButton>
        </S.Header>

        {/* Tab bar */}
        <S.TabBar>
          {TABS.map((tab) => (
            <S.Tab
              key={tab.id}
              $active={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </S.Tab>
          ))}
        </S.TabBar>

        {/* Tab content */}
        <S.TabContent>
          <TabComponent />
        </S.TabContent>

        {/* Footer */}
        <S.Footer>
          <S.Button onClick={handleCancel}>Cancel</S.Button>
          <S.Button $primary onClick={handleOK}>
            OK
          </S.Button>
        </S.Footer>
        {win.resizeHandles}
      </S.DialogContainer>
    </S.Backdrop>
  );
}

export default FormatCellsDialog;
