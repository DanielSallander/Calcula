//! FILENAME: app/extensions/CellTypes/index.ts
// PURPOSE: Standard Cell Types extension — dogfoods the cell-type brick
//          (context.grid.cellTypes) with three starter types: checkbox,
//          progress bar, button. Adds Insert-menu and context-menu wiring.
// CONTEXT: The registry + per-cell assignment store are platform primitives
//          (app/src/api/cellTypes.ts + app/src-tauri/src/cell_types.rs); this
//          extension only registers definitions and UI — proof that the brick
//          is buildable through the public API alone.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import type { Selection } from "@api";
import {
  ExtensionRegistry,
  gridExtensions,
  IconControls,
  IconCheckbox,
  getCellTypeAt,
} from "@api";
import { checkboxCellType, CHECKBOX_TYPE_ID } from "./types/checkbox";
import { progressCellType, PROGRESS_TYPE_ID } from "./types/progress";
import { buttonCellType, BUTTON_TYPE_ID, type ButtonAction } from "./types/button";
import { ButtonActionDialog } from "./components/ButtonActionDialog";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { ownUndoTransaction } from "@api/undoTicket";

const BUTTON_DIALOG_ID = "cellTypes.buttonAction";

const cleanupFns: (() => void)[] = [];
let currentSelection: Selection | null = null;
let extensionContext: ExtensionContext | null = null;

// ============================================================================
// Range helpers
// ============================================================================

interface CellRange {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

/**
 * Core's selection as the target range of an Insert > Cell Type item or a
 * cellTypes.* command -- or null, refused and announced once, while something
 * else owns the selection (a floating grid's selected cell): Core's selection
 * is HIDDEN under it then (D4, BUG-0185 class). The grid context menu passes
 * the range it was opened on instead, which the user pointed at.
 */
function selectionRangeUnlessOwned(action: string): CellRange | null {
  if (refuseIfSelectionOwned(action)) return null;
  return selectionRange();
}

function selectionRange(): CellRange | null {
  const sel = currentSelection;
  if (!sel) return null;
  return {
    minRow: Math.min(sel.startRow, sel.endRow),
    maxRow: Math.max(sel.startRow, sel.endRow),
    minCol: Math.min(sel.startCol, sel.endCol),
    maxCol: Math.max(sel.startCol, sel.endCol),
  };
}

/**
 * Apply a cell type to a range as ONE undo step. For checkboxes, empty cells
 * are initialized to FALSE (unchecked) inside the same transaction.
 */
async function applyTypeToRange(
  range: CellRange,
  typeId: string,
  params: Record<string, unknown>,
  initializeEmptyTo?: string
): Promise<void> {
  const { setCellTypeRange } = await import("../../src/api/cellTypes");
  const lib = await import("../../src/api/lib");
  const { beginUndoTransaction, getCell, updateCellsBatch } = lib;
  const { restoreFocusToGrid } = await import("../../src/api/events");

  // Closes ONLY what its own begin opened: inside a script's open batch the
  // insert JOINS, and the script closes that step (wave F, Z6).
  // The closes are read when a close runs, not here (a module without a
  // cancel is never touched unless a cancel is needed).
  const tx = ownUndoTransaction(await beginUndoTransaction("Insert cell type"), {
    commitUndoTransaction: (...ticket) => lib.commitUndoTransaction(...ticket),
    cancelUndoTransaction: (...ticket) => lib.cancelUndoTransaction(...ticket),
  });
  try {
    await setCellTypeRange(range.minRow, range.minCol, range.maxRow, range.maxCol, typeId, params);

    if (initializeEmptyTo !== undefined) {
      const updates: Array<{ row: number; col: number; value: string }> = [];
      for (let r = range.minRow; r <= range.maxRow; r++) {
        for (let c = range.minCol; c <= range.maxCol; c++) {
          const cellData = await getCell(r, c);
          if (!cellData || (cellData.display ?? "") === "") {
            updates.push({ row: r, col: c, value: initializeEmptyTo });
          }
        }
      }
      if (updates.length > 0) {
        await updateCellsBatch(updates);
      }
    }
  } catch (err) {
    // Surface backend refusals (sheet protection, most commonly); the commit
    // in `finally` still closes OUR transaction so nothing is left open (a
    // joined insert closes nothing: its holder does).
    void alertAsync(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await tx.commit();
  }
  window.dispatchEvent(new CustomEvent("grid:refresh"));
  restoreFocusToGrid();
}

async function clearTypeOnRange(range: CellRange): Promise<void> {
  const { clearCellTypeRange } = await import("../../src/api/cellTypes");
  const { restoreFocusToGrid } = await import("../../src/api/events");
  await clearCellTypeRange(range.minRow, range.minCol, range.maxRow, range.maxCol);
  restoreFocusToGrid();
}

// ============================================================================
// Insert actions
// ============================================================================

async function insertCheckbox(range: CellRange | null): Promise<void> {
  if (!range) return;
  await applyTypeToRange(range, CHECKBOX_TYPE_ID, {}, "FALSE");
}

async function insertProgress(max: number, range: CellRange | null): Promise<void> {
  if (!range) return;
  await applyTypeToRange(range, PROGRESS_TYPE_ID, max === 1 ? {} : { max });
}

function insertButton(range: CellRange | null): void {
  if (!range || !extensionContext) return;
  extensionContext.ui.dialogs.show(BUTTON_DIALOG_ID, {
    onApply: (action: ButtonAction, label: string) => {
      void applyTypeToRange(range, BUTTON_TYPE_ID, label ? { label, action } : { action });
    },
  });
}

async function clearCellTypes(range: CellRange | null): Promise<void> {
  if (!range) return;
  await clearTypeOnRange(range);
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[CellTypes] Activating...");
  extensionContext = context;

  // 1. Register the three starter type definitions through the public brick.
  cleanupFns.push(context.grid.cellTypes.register(checkboxCellType));
  cleanupFns.push(context.grid.cellTypes.register(progressCellType));
  cleanupFns.push(context.grid.cellTypes.register(buttonCellType));

  // 2. Pull the active sheet's assignments so typed cells paint immediately.
  void context.grid.cellTypes.refresh();

  // 3. Track selection for the insert commands.
  cleanupFns.push(
    ExtensionRegistry.onSelectionChange((sel) => {
      currentSelection = sel;
    })
  );

  // 4. Commands (also usable from buttons/scripts/keyboard customization),
  //    taken back on deactivate: a button bound to one must not go on running
  //    this extension after it is disabled (X20).
  const commands = [
    {
      id: "cellTypes.insertCheckbox",
      name: "Insert Checkbox Cells",
      execute: async () => insertCheckbox(selectionRangeUnlessOwned("Insert Checkbox")),
    },
    {
      id: "cellTypes.insertProgress",
      name: "Insert Progress Bar Cells",
      execute: async () => insertProgress(1, selectionRangeUnlessOwned("Insert Progress Bar")),
    },
    {
      id: "cellTypes.insertButton",
      name: "Insert Button Cell",
      execute: async () => insertButton(selectionRangeUnlessOwned("Insert Button")),
    },
    {
      id: "cellTypes.clear",
      name: "Clear Cell Type",
      execute: async () => clearCellTypes(selectionRangeUnlessOwned("Clear Cell Type")),
    },
  ];
  for (const command of commands) {
    ExtensionRegistry.registerCommand(command);
    // The object, not the id: never another extension's command of that id.
    cleanupFns.push(() => ExtensionRegistry.unregisterCommand(command));
  }

  // 5. Button-action dialog.
  context.ui.dialogs.register({
    id: BUTTON_DIALOG_ID,
    title: "Insert Button",
    component: ButtonActionDialog,
    width: 420,
  });

  // 6. Insert menu.
  context.ui.menus.registerItem("insert", {
    id: "insert.cellTypes",
    label: "Cell Type",
    icon: IconControls,
    children: [
      {
        id: "insert.cellTypes.checkbox",
        label: "Checkbox",
        icon: IconCheckbox,
        action: () => void insertCheckbox(selectionRangeUnlessOwned("Insert Checkbox")),
      },
      {
        id: "insert.cellTypes.progress",
        label: "Progress Bar (values 0–1)",
        action: () => void insertProgress(1, selectionRangeUnlessOwned("Insert Progress Bar")),
      },
      {
        id: "insert.cellTypes.progress100",
        label: "Progress Bar (values 0–100)",
        action: () => void insertProgress(100, selectionRangeUnlessOwned("Insert Progress Bar")),
      },
      {
        id: "insert.cellTypes.button",
        label: "Button…",
        action: () => insertButton(selectionRangeUnlessOwned("Insert Button")),
      },
      {
        id: "insert.cellTypes.clear",
        label: "Clear Cell Type",
        action: () => void clearCellTypes(selectionRangeUnlessOwned("Clear Cell Type")),
      },
    ],
  });
  // The whole Cell Type submenu is this extension's own (no one else adds to it).
  cleanupFns.push(() => context.ui.menus.unregisterItem("insert", "insert.cellTypes"));

  // 7. Grid context menu.
  gridExtensions.registerContextMenuItems([
    {
      id: "cellTypes.menu",
      label: "Cell Type",
      group: "cellTypes",
      visible: (ctx) => ctx.clickedCell != null,
      onClick: () => {},
      children: [
        {
          id: "cellTypes.menu.checkbox",
          label: "Checkbox",
          onClick: (ctx) => void insertCheckbox(contextRange(ctx)),
        },
        {
          id: "cellTypes.menu.progress",
          label: "Progress Bar (0–1)",
          onClick: (ctx) => void insertProgress(1, contextRange(ctx)),
        },
        {
          id: "cellTypes.menu.progress100",
          label: "Progress Bar (0–100)",
          onClick: (ctx) => void insertProgress(100, contextRange(ctx)),
        },
        {
          id: "cellTypes.menu.button",
          label: "Button…",
          onClick: (ctx) => insertButton(contextRange(ctx)),
        },
        {
          id: "cellTypes.menu.clear",
          label: "Clear Cell Type",
          disabled: (ctx) => !contextHasAssignment(ctx),
          onClick: (ctx) => void clearCellTypes(contextRange(ctx)),
        },
      ],
    },
  ]);
  cleanupFns.push(() => gridExtensions.unregisterContextMenuItem("cellTypes.menu"));

  console.log("[CellTypes] Activated");
}

/** Range for a context-menu action: the selection when the click landed in it,
 *  otherwise just the clicked cell. */
function contextRange(ctx: {
  selection: Selection | null;
  clickedCell: { row: number; col: number } | null;
  isWithinSelection: boolean;
}): CellRange | null {
  if (ctx.isWithinSelection && ctx.selection) {
    return {
      minRow: Math.min(ctx.selection.startRow, ctx.selection.endRow),
      maxRow: Math.max(ctx.selection.startRow, ctx.selection.endRow),
      minCol: Math.min(ctx.selection.startCol, ctx.selection.endCol),
      maxCol: Math.max(ctx.selection.startCol, ctx.selection.endCol),
    };
  }
  if (ctx.clickedCell) {
    return {
      minRow: ctx.clickedCell.row,
      maxRow: ctx.clickedCell.row,
      minCol: ctx.clickedCell.col,
      maxCol: ctx.clickedCell.col,
    };
  }
  return null;
}

function contextHasAssignment(ctx: {
  clickedCell: { row: number; col: number } | null;
}): boolean {
  if (!ctx.clickedCell) return false;
  // Synchronous check against the active-sheet assignment index.
  return getCellTypeAt(ctx.clickedCell.row, ctx.clickedCell.col) !== null;
}

function deactivate(): void {
  console.log("[CellTypes] Deactivating...");
  extensionContext?.ui.dialogs.unregister(BUTTON_DIALOG_ID);
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  cleanupFns.length = 0;
  extensionContext = null;
  console.log("[CellTypes] Deactivated");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.cell-types-standard",
    name: "Standard Cell Types",
    version: "1.0.0",
    description:
      "Checkbox, progress bar, and button cell types built on the cell-type brick (granular bricks).",
  },
  activate,
  deactivate,
};

export default extension;
