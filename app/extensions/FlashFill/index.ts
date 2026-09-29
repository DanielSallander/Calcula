//! FILENAME: app/extensions/FlashFill/index.ts
// PURPOSE: Flash Fill extension entry point.
// CONTEXT: Registers the `flashfill.execute` command (the keybinding
//          registry's Ctrl+E runs it) and the Data menu item.
//          Detects patterns from user-provided examples and fills remaining cells.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  getCell,
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
  registerMenuItem,
  unregisterMenuItem,
  emitAppEvent,
  AppEvents,
  showToast,
  IconFlashFill,
} from "@api";
import { getGridBounds } from "@api/lib";
import { getGridStateSnapshot } from "@api/grid";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { ownUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { learn, applyProgram } from "./lib/patternEngine";
import type { Example, Program } from "./lib/patternEngine";
import type { CellData } from "@api/types";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

/** Flash Fill's closes, read when a close runs (see ownUndoTransaction). */
const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

// ============================================================================
// Flash Fill Logic
// ============================================================================

/**
 * Execute Flash Fill from the current selection.
 *
 * Algorithm:
 * 1. Determine the active cell's column (target column).
 * 2. Scan upward from active cell to find example outputs already typed by the user.
 * 3. For each example row, read source values from adjacent columns.
 * 4. Learn a transformation pattern from the examples.
 * 5. Apply the pattern to all remaining rows in the data region.
 */
async function executeFlashFill(): Promise<void> {
  // Every door (Data menu, Ctrl+E, a script) comes through here. It fills the
  // column of Core's active cell -- HIDDEN while something else owns the
  // selection (a floating grid's selected cell) -- so refuse, once (D4,
  // BUG-0185 class).
  if (refuseIfSelectionOwned("Flash Fill")) return;
  const snapshot = getGridStateSnapshot();
  if (!snapshot) return;
  const selection = snapshot.selection;
  if (!selection) {
    showToast("Select a cell in the column you want to fill.", { variant: "warning" });
    return;
  }

  const targetCol = selection.startCol;
  const activeRow = selection.startRow;

  // Find the data region bounds
  const [maxRow, maxCol] = await getGridBounds();
  if (maxRow === 0 && maxCol === 0) {
    showToast("No data found for Flash Fill.", { variant: "warning" });
    return;
  }

  // Determine the data region: find first row (header detection)
  const dataStartRow = await findDataStartRow(targetCol, activeRow);

  // Determine which adjacent columns contain source data
  const sourceCols = await findSourceColumns(targetCol, dataStartRow, maxRow, maxCol);
  if (sourceCols.length === 0) {
    showToast("No source data found adjacent to the selected column.", { variant: "warning" });
    return;
  }

  // Find the last row with data in any source column
  const dataEndRow = await findDataEndRow(sourceCols, dataStartRow, maxRow);
  if (dataEndRow < dataStartRow) {
    showToast("No source data found for Flash Fill.", { variant: "warning" });
    return;
  }

  // Collect examples: rows where target column already has a value
  const examples: Example[] = [];
  const emptyRows: number[] = [];

  for (let row = dataStartRow; row <= dataEndRow; row++) {
    const targetCell = await getCell(row, targetCol);
    const targetValue = getCellDisplayValue(targetCell);

    // Read source values for this row
    const sourceValues = await readSourceValues(row, sourceCols);

    // Skip rows where all sources are empty
    if (sourceValues.every((v) => v === "")) continue;

    if (targetValue !== "") {
      examples.push({ sources: sourceValues, output: targetValue });
    } else {
      emptyRows.push(row);
    }
  }

  if (examples.length === 0) {
    showToast("Type at least one example value, then press Ctrl+E.", { variant: "warning" });
    return;
  }

  if (emptyRows.length === 0) {
    showToast("All cells in the target column already have values.");
    return;
  }

  // Learn pattern from examples
  const program = learn(examples);
  if (!program) {
    showToast("Could not detect a pattern. Try adding more examples.", { variant: "warning" });
    return;
  }

  // Apply pattern to empty rows
  const updates = await buildUpdates(program, emptyRows, sourceCols, targetCol);
  if (updates.length === 0) {
    showToast("No cells to fill.");
    return;
  }

  // Commit as undoable batch. The batch can now be REFUSED (sheet protection),
  // and neither call site awaits this function, so an unguarded throw would
  // surface as an unhandled rejection AND leave the transaction open for later
  // edits to join. It closes ONLY what its own begin opened: run inside a
  // script's open batch it JOINS, and the script closes that step -- a
  // refusal never drops the batch's undo record (wave F, Z6).
  const tx = ownUndoTransaction(await beginUndoTransaction("Flash Fill"), UNDO_CLOSES);
  try {
    await updateCellsBatch(updates);
  } catch (err) {
    await tx.cancel().catch(() => {});
    const msg = typeof err === "string" ? err : (err as Error)?.message || String(err);
    showToast(msg, { variant: "error" });
    return;
  }
  await tx.commit();

  emitAppEvent(AppEvents.GRID_REFRESH);
  showToast(
    `Flash Fill: ${updates.length} cell${updates.length !== 1 ? "s" : ""} filled.`,
    { variant: "success" },
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function getCellDisplayValue(cell: CellData | null): string {
  if (!cell) return "";
  return cell.display ?? "";
}

/**
 * Find the first row of the data region by scanning upward from the active row.
 * Stops at row 0 or when encountering an empty row.
 */
async function findDataStartRow(col: number, fromRow: number): Promise<number> {
  let row = fromRow;
  while (row > 0) {
    const cell = await getCell(row - 1, col);
    const above = getCellDisplayValue(cell);
    if (above === "") {
      // Check if the row above has data in adjacent columns - it might be a header
      break;
    }
    row--;
  }
  // Also scan source columns to find the true start
  return row;
}

/**
 * Find adjacent columns that contain source data.
 * Checks columns to the left and right of the target column.
 */
async function findSourceColumns(
  targetCol: number,
  dataStartRow: number,
  maxRow: number,
  maxCol: number,
): Promise<number[]> {
  const sourceCols: number[] = [];
  const checkRows = Math.min(dataStartRow + 5, maxRow);

  // Check columns to the left (most common: source is to the left)
  for (let col = targetCol - 1; col >= Math.max(0, targetCol - 5); col--) {
    let hasData = false;
    for (let row = dataStartRow; row <= checkRows; row++) {
      const cell = await getCell(row, col);
      if (getCellDisplayValue(cell) !== "") {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      sourceCols.unshift(col); // Add to front so leftmost is first
    } else {
      break; // Stop at first empty column
    }
  }

  // Check columns to the right
  for (let col = targetCol + 1; col <= Math.min(maxCol, targetCol + 5); col++) {
    let hasData = false;
    for (let row = dataStartRow; row <= checkRows; row++) {
      const cell = await getCell(row, col);
      if (getCellDisplayValue(cell) !== "") {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      sourceCols.push(col);
    } else {
      break;
    }
  }

  return sourceCols;
}

/**
 * Find the last row with data in any of the source columns.
 */
async function findDataEndRow(
  sourceCols: number[],
  startRow: number,
  maxRow: number,
): Promise<number> {
  let lastRow = startRow;
  for (let row = startRow; row <= maxRow; row++) {
    let hasData = false;
    for (const col of sourceCols) {
      const cell = await getCell(row, col);
      if (getCellDisplayValue(cell) !== "") {
        hasData = true;
        break;
      }
    }
    if (hasData) {
      lastRow = row;
    } else {
      // Allow up to 2 consecutive empty rows before stopping
      let allEmpty = true;
      for (let ahead = 1; ahead <= 2 && row + ahead <= maxRow; ahead++) {
        for (const col of sourceCols) {
          const cell = await getCell(row + ahead, col);
          if (getCellDisplayValue(cell) !== "") {
            allEmpty = false;
            break;
          }
        }
        if (!allEmpty) break;
      }
      if (allEmpty) break;
    }
  }
  return lastRow;
}

async function readSourceValues(row: number, sourceCols: number[]): Promise<string[]> {
  const values: string[] = [];
  for (const col of sourceCols) {
    const cell = await getCell(row, col);
    values.push(getCellDisplayValue(cell));
  }
  return values;
}

async function buildUpdates(
  program: Program,
  emptyRows: number[],
  sourceCols: number[],
  targetCol: number,
): Promise<Array<{ row: number; col: number; value: string }>> {
  const updates: Array<{ row: number; col: number; value: string }> = [];

  for (const row of emptyRows) {
    const sourceValues = await readSourceValues(row, sourceCols);
    // Skip if all sources are empty
    if (sourceValues.every((v) => v === "")) continue;

    const result = applyProgram(program, sourceValues);
    if (result !== null && result !== "") {
      updates.push({ row, col: targetCol, value: result });
    }
  }

  return updates;
}

// ============================================================================
// Command
// ============================================================================

/**
 * The Flash Fill command -- script-safe, so scripts call it by this exact
 * spelling, and the keybinding registry's `ext.flashFill` (Ctrl+E) runs it.
 * The registry is the ONE keyboard path ("not-editing": never in a text
 * field, a claim or a cell edit), so a remap in Settings moves the key.
 */
export const FLASH_FILL_COMMAND = "flashfill.execute";

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[FlashFill] Activating...");

  // 1. Register command
  context.commands.register(FLASH_FILL_COMMAND, async () => {
    await executeFlashFill();
  }, { scriptSafe: true });
  cleanupFns.push(() => context.commands.unregister(FLASH_FILL_COMMAND));

  // 2. Register Data menu item
  registerMenuItem("data", {
    id: "flashfill",
    label: "Flash Fill",
    shortcut: "Ctrl+E",
    icon: IconFlashFill,
    action: () => {
      executeFlashFill();
    },
  });
  // Its OWN item back on deactivate (wave E, Y14): the Data menu is AutoFilter's.
  cleanupFns.push(() => unregisterMenuItem("data", "flashfill"));

  console.log("[FlashFill] Activated successfully.");
}

function deactivate(): void {
  console.log("[FlashFill] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[FlashFill] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  console.log("[FlashFill] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.flash-fill",
    name: "Flash Fill",
    version: "1.0.0",
    description: "Detects patterns from user-provided examples and fills remaining cells (Ctrl+E).",
  },
  activate,
  deactivate,
};
export default extension;
