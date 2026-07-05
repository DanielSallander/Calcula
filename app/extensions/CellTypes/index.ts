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
  const { beginUndoTransaction, commitUndoTransaction, getCell, updateCellsBatch } = await import(
    "../../src/api/lib"
  );
  const { restoreFocusToGrid } = await import("../../src/api/events");

  await beginUndoTransaction("Insert cell type");
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
  } finally {
    await commitUndoTransaction();
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

async function insertCheckbox(range: CellRange | null = selectionRange()): Promise<void> {
  if (!range) return;
  await applyTypeToRange(range, CHECKBOX_TYPE_ID, {}, "FALSE");
}

async function insertProgress(
  max: number,
  range: CellRange | null = selectionRange()
): Promise<void> {
  if (!range) return;
  await applyTypeToRange(range, PROGRESS_TYPE_ID, max === 1 ? {} : { max });
}

function insertButton(range: CellRange | null = selectionRange()): void {
  if (!range || !extensionContext) return;
  extensionContext.ui.dialogs.show(BUTTON_DIALOG_ID, {
    onApply: (action: ButtonAction, label: string) => {
      void applyTypeToRange(range, BUTTON_TYPE_ID, label ? { label, action } : { action });
    },
  });
}

async function clearCellTypes(range: CellRange | null = selectionRange()): Promise<void> {
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

  // 4. Commands (also usable from buttons/scripts/keyboard customization).
  ExtensionRegistry.registerCommand({
    id: "cellTypes.insertCheckbox",
    name: "Insert Checkbox Cells",
    execute: async () => insertCheckbox(),
  });
  ExtensionRegistry.registerCommand({
    id: "cellTypes.insertProgress",
    name: "Insert Progress Bar Cells",
    execute: async () => insertProgress(1),
  });
  ExtensionRegistry.registerCommand({
    id: "cellTypes.insertButton",
    name: "Insert Button Cell",
    execute: async () => insertButton(),
  });
  ExtensionRegistry.registerCommand({
    id: "cellTypes.clear",
    name: "Clear Cell Type",
    execute: async () => clearCellTypes(),
  });

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
        action: () => void insertCheckbox(),
      },
      {
        id: "insert.cellTypes.progress",
        label: "Progress Bar (values 0–1)",
        action: () => void insertProgress(1),
      },
      {
        id: "insert.cellTypes.progress100",
        label: "Progress Bar (values 0–100)",
        action: () => void insertProgress(100),
      },
      {
        id: "insert.cellTypes.button",
        label: "Button…",
        action: () => insertButton(),
      },
      {
        id: "insert.cellTypes.clear",
        label: "Clear Cell Type",
        action: () => void clearCellTypes(),
      },
    ],
  });

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
