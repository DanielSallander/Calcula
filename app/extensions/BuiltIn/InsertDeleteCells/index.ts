//! FILENAME: app/extensions/BuiltIn/InsertDeleteCells/index.ts
// PURPOSE: Excel's Insert / Delete commands and the Insert / Delete dialogs.
// CONTEXT: Registers the four commands the Home tab's Cells group runs (and the
//          Ctrl+Plus / Ctrl+Minus keys bind to):
//            core.grid.insert / core.grid.delete -- the split buttons' main
//              halves: whole rows -> rows, whole columns -> columns, otherwise
//              cells shifted by Excel's shape rule (lib/cellShift.ts);
//            core.grid.insertCells / core.grid.deleteCells -- "Insert Cells..."
//              / "Delete Cells...": `{ shift }` runs that shift ("right" | "down"
//              | "entireRow" | "entireColumn", delete: "left" | "up" | ...); no
//              argument opens the dialog (whole rows / columns skip it, as
//              Excel's do).
//          The cell shift is the backend's `insert_cells` / `delete_cells`,
//          reached through the @api wrappers; this extension decides only WHAT
//          to run. Path A lifecycle.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { CoreCommands } from "@api/commands";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { showDialog } from "@api/ui";
import { CellShiftDialog } from "./components/CellShiftDialog";
import {
  currentSelection,
  gestureLabel,
  readShiftArg,
  runChoice,
  runMainHalf,
  wholeLineChoice,
  type CellShiftChoice,
  type CellShiftMode,
} from "./lib/cellShift";

/** The Insert dialog ("Insert Cells..."). */
export const INSERT_CELLS_DIALOG_ID = "insert-cells";
/** The Delete dialog ("Delete Cells..."). */
export const DELETE_CELLS_DIALOG_ID = "delete-cells";

// The last choice made in each dialog this session. Excel opens a fresh
// session on the FIRST option (measured: "Shift cells right" / "Shift cells
// left", whatever the selection's shape).
const lastChoice: Record<CellShiftMode, CellShiftChoice> = { insert: "right", delete: "left" };

/** Test seam: forget the remembered dialog choices. */
export function resetRememberedChoices(): void {
  lastChoice.insert = "right";
  lastChoice.delete = "left";
}

const cleanupFns: (() => void)[] = [];

/**
 * INSERT_CELLS / DELETE_CELLS. A named shift runs at once; none opens the
 * dialog, except over whole rows / columns, where there is nothing to ask.
 */
async function runCellsCommand(mode: CellShiftMode, args: unknown): Promise<void> {
  const parsed = readShiftArg(mode, args);
  if (parsed.kind === "invalid") {
    await alertAsync(parsed.message);
    return;
  }
  if (refuseIfSelectionOwned(gestureLabel(mode))) return;
  const selection = currentSelection();
  if (!selection) return;
  if (parsed.kind === "choice") {
    await runChoice(mode, selection, parsed.choice);
    return;
  }
  const line = wholeLineChoice(selection);
  if (line) {
    await runChoice(mode, selection, line);
    return;
  }
  showDialog(mode === "insert" ? INSERT_CELLS_DIALOG_ID : DELETE_CELLS_DIALOG_ID, {
    mode,
    initial: lastChoice[mode],
    onChoose: (choice: CellShiftChoice) => {
      lastChoice[mode] = choice;
      // The selection the dialog was opened over: the dialog is modal, so it
      // is still the user's selection when OK is pressed.
      void runChoice(mode, selection, choice);
    },
  });
}

function activate(context: ExtensionContext): void {
  console.log("[InsertDeleteCells] Activating...");

  for (const id of [INSERT_CELLS_DIALOG_ID, DELETE_CELLS_DIALOG_ID]) {
    context.ui.dialogs.register({ id, component: CellShiftDialog, priority: 100 });
    cleanupFns.push(() => context.ui.dialogs.unregister(id));
  }

  context.commands.register(CoreCommands.INSERT, () => runMainHalf("insert"));
  cleanupFns.push(() => context.commands.unregister(CoreCommands.INSERT));
  context.commands.register(CoreCommands.DELETE, () => runMainHalf("delete"));
  cleanupFns.push(() => context.commands.unregister(CoreCommands.DELETE));
  context.commands.register(CoreCommands.INSERT_CELLS, (args?: unknown) => runCellsCommand("insert", args));
  cleanupFns.push(() => context.commands.unregister(CoreCommands.INSERT_CELLS));
  context.commands.register(CoreCommands.DELETE_CELLS, (args?: unknown) => runCellsCommand("delete", args));
  cleanupFns.push(() => context.commands.unregister(CoreCommands.DELETE_CELLS));

  console.log("[InsertDeleteCells] Activated successfully.");
}

function deactivate(): void {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[InsertDeleteCells] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.insert-delete-cells",
    name: "Insert / Delete Cells",
    version: "1.0.0",
    description: "Excel's Insert and Delete: shift cells right, down, left or up, or insert/delete entire rows and columns.",
  },
  activate,
  deactivate,
};

export default extension;
