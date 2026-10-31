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
import { CommandRegistry, CoreCommands } from "@api/commands";
import { gridExtensions, GridMenuGroups, type GridMenuContext } from "@api";
import { insertCopiedCellsLabel } from "@api/lib";
import { alertAsync } from "@api/dialogs";
import { showDialog } from "@api/ui";
import { CellShiftDialog } from "./components/CellShiftDialog";
import {
  copyToInsert,
  insertCopiedMenuLabel,
  readShiftArg,
  resolveShiftPlace,
  runChoice,
  runInsertCopiedPlan,
  runMainHalf,
  wholeLineChoice,
  type CellShiftChoice,
  type CellShiftMode,
} from "./lib/cellShift";

/** The Insert dialog ("Insert Cells..."). */
export const INSERT_CELLS_DIALOG_ID = "insert-cells";
/** The Delete dialog ("Delete Cells..."). */
export const DELETE_CELLS_DIALOG_ID = "delete-cells";

/** The grid right-click items: "Insert..." (or "Insert Copied Cells...") and "Delete...". */
export const CONTEXT_INSERT_ID = "insertDeleteCells.context.insert";
export const CONTEXT_DELETE_ID = "insertDeleteCells.context.delete";

// The last choice made in each dialog this session. Excel opens a fresh
// session on the FIRST option (measured: "Shift cells right" / "Shift cells
// left", whatever the selection's shape).
const lastChoice: Record<CellShiftMode, CellShiftChoice> = { insert: "right", delete: "left" };
// The Insert dialog over a COPY opens on "Shift cells right" too (Excel
// [LIVE]: Ctrl+Plus then Enter shifted right), then remembers the session's.
let lastCopiedChoice: "right" | "down" = "right";

/** Test seam: forget the remembered dialog choices. */
export function resetRememberedChoices(): void {
  lastChoice.insert = "right";
  lastChoice.delete = "left";
  lastCopiedChoice = "right";
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
  // The door's question (lib/cellShift): a floating grid's cells, Core's
  // selection, or a refusal announced once.
  const place = resolveShiftPlace(mode);
  if (!place) return;
  const { selection, size } = place;
  // A COPY pending: Excel's Insert Copied Cells (lib/cellShift.ts) -- the
  // copied lines without a dialog, a block through the "Insert" dialog's two
  // shifts, or Excel's refusal.
  const copied = mode === "insert" ? copyToInsert(place) : null;
  if (copied) {
    const named = parsed.kind === "choice" ? parsed.choice : null;
    const shift = named === "right" || named === "down" ? named : null;
    const forced = named === "entireRow" || named === "entireColumn" ? named : undefined;
    await runInsertCopiedPlan(copied, place, shift, forced, named
      ? undefined
      : (run) => {
          showDialog(INSERT_CELLS_DIALOG_ID, {
            mode,
            copied: true,
            initial: lastCopiedChoice,
            onChoose: (choice: CellShiftChoice) => {
              if (choice !== "right" && choice !== "down") return;
              lastCopiedChoice = choice;
              void run(choice);
            },
          });
        });
    return;
  }
  if (parsed.kind === "choice") {
    await runChoice(mode, selection, parsed.choice, size);
    return;
  }
  const line = wholeLineChoice(selection, size);
  if (line) {
    await runChoice(mode, selection, line, size);
    return;
  }
  showDialog(mode === "insert" ? INSERT_CELLS_DIALOG_ID : DELETE_CELLS_DIALOG_ID, {
    mode,
    initial: lastChoice[mode],
    onChoose: (choice: CellShiftChoice) => {
      lastChoice[mode] = choice;
      // The selection the dialog was opened over: the dialog is modal, so it
      // is still the user's selection when OK is pressed.
      void runChoice(mode, selection, choice, size);
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

  // Excel's cell right-click menu: "Insert..." -- "Insert Copied Cells..."
  // while a copied block is pending, "Insert Copied Cells" for copied whole
  // lines [LIVE] -- and "Delete...", the two dialogs. On a row or column
  // header the item is Core's Insert Row / Column, except while a copy is
  // pending: then it is "Insert Copied Cells" here, and inserts the copy
  // (Excel [LIVE 2026-10-30, clip6/probe-menu.ps1]: row 6 or F6 copied, row 2
  // right-clicked -> "Insert Copied Cells"; a copied cell into whole rows is
  // then refused, as the ribbon's is).
  gridExtensions.registerContextMenuItems([
    {
      id: CONTEXT_INSERT_ID,
      label: (ctx: GridMenuContext) => insertCopiedMenuLabel(ctx.selection) ?? "Insert...",
      group: GridMenuGroups.INSERT,
      order: 5,
      visible: (ctx: GridMenuContext) =>
        ctx.selection?.type === "cells" ||
        ((ctx.selection?.type === "rows" || ctx.selection?.type === "columns") && insertCopiedCellsLabel(true) !== null),
      // On a header it stands in for Core's Insert Row / Insert Column (one
      // Insert item, as Excel's header menu has); on cells those never show.
      replaces: ["core:insertRow", "core:insertColumn"],
      onClick: async (ctx: GridMenuContext) => {
        // Over whole rows / columns there is no dialog: the main Insert,
        // which with a copy pending is Insert Copied Cells.
        const lines = ctx.selection?.type === "rows" || ctx.selection?.type === "columns";
        await CommandRegistry.execute(lines ? CoreCommands.INSERT : CoreCommands.INSERT_CELLS);
      },
    },
    {
      id: CONTEXT_DELETE_ID,
      label: "Delete...",
      group: GridMenuGroups.INSERT,
      order: 6,
      separatorAfter: true,
      visible: (ctx: GridMenuContext) => ctx.selection?.type === "cells",
      onClick: async () => {
        await CommandRegistry.execute(CoreCommands.DELETE_CELLS);
      },
    },
  ]);
  cleanupFns.push(() => {
    gridExtensions.unregisterContextMenuItem(CONTEXT_INSERT_ID);
    gridExtensions.unregisterContextMenuItem(CONTEXT_DELETE_ID);
  });

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
