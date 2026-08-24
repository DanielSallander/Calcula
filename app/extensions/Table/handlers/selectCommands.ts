//! FILENAME: app/extensions/Table/handlers/selectCommands.ts
// PURPOSE: "Select this table" as a named command.
// CONTEXT: The Table extension had no way to SELECT a table at all — not from
//          the ribbon, not from a macro, not from a script. Everything that
//          wanted a table's data body walked the geometry itself, which is how
//          the header/totals arithmetic ended up written more than once.
//          These two commands are the seam: a caller says WHICH table and
//          WHETHER it wants the header and totals row, and this extension —
//          which owns the answer — decides where that is.
// NOTE:    The grid KEYBOARD does not go through here. Ctrl+Space / Shift+Space
//          / Ctrl+A are progressive (narrow, then wider, then the sheet), and a
//          command that can only produce one block cannot express that; Core
//          reads the same `tableSelectionScope` off the table's grid region
//          instead. Both routes end at `tableBands`, so they cannot disagree.

import { dispatchGridAction, scrollToCell, setSelection } from "@api";
import type { ICommandRegistry } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { getAllTables, getTableAtCell, type Table } from "../lib/tableStore";
import { tableDataBlock, tableWholeBlock, type CellBlock } from "../lib/tableBands";

/** Command id: select the table's data rows (Excel's `Table1`). */
export const TABLE_SELECT_DATA_COMMAND = "table.selectData";
/** Command id: select the whole table, header and totals row included. */
export const TABLE_SELECT_ALL_COMMAND = "table.selectAll";

/** What a caller may pass to either command. */
export interface TableSelectArgs {
  /** Table to select. Omitted = the table the active cell is in. */
  tableId?: string;
  /** Table to select by name (case-insensitive). Ignored when `tableId` is set. */
  name?: string;
}

/**
 * Resolve which table a command call means.
 *
 * Falls back to the table under the ACTIVE CELL (`endRow`/`endCol`, the
 * selection's active corner) so the ribbon and a keyboard user need pass
 * nothing. Returns null when there is no such table — the caller reports that;
 * selecting an arbitrary table would be worse than selecting nothing.
 */
function resolveTable(args: TableSelectArgs | undefined): Table | null {
  if (args?.tableId) {
    return getAllTables().find((t) => t.id === args.tableId) ?? null;
  }
  if (args?.name) {
    const wanted = args.name.toUpperCase();
    return getAllTables().find((t) => t.name.toUpperCase() === wanted) ?? null;
  }
  const selection = getGridStateSnapshot()?.selection;
  if (!selection) return null;
  return getTableAtCell(selection.endRow, selection.endCol);
}

/** Select a block and bring its top-left corner into view. */
function selectBlock(block: CellBlock): void {
  dispatchGridAction(
    setSelection({
      startRow: block.startRow,
      startCol: block.startCol,
      endRow: block.endRow,
      endCol: block.endCol,
      type: "cells",
    }),
  );
  dispatchGridAction(scrollToCell(block.startRow, block.startCol, false));
}

/**
 * Select a table's data rows. Returns false when no table could be resolved, so
 * a caller can say so rather than assume it worked.
 */
export function selectTableData(args?: TableSelectArgs): boolean {
  const table = resolveTable(args);
  if (!table) return false;
  selectBlock(tableDataBlock(table));
  return true;
}

/** Select a whole table, header and totals row included. */
export function selectWholeTable(args?: TableSelectArgs): boolean {
  const table = resolveTable(args);
  if (!table) return false;
  selectBlock(tableWholeBlock(table));
  return true;
}

/**
 * Register both commands. Returns the cleanup the extension's `deactivate`
 * needs — a command left registered after unload runs against a store that has
 * been reset to empty.
 */
export function registerTableSelectCommands(commands: ICommandRegistry): () => void {
  commands.register(
    TABLE_SELECT_DATA_COMMAND,
    (args?: unknown) => selectTableData(args as TableSelectArgs | undefined),
    { scriptSafe: true },
  );
  commands.register(
    TABLE_SELECT_ALL_COMMAND,
    (args?: unknown) => selectWholeTable(args as TableSelectArgs | undefined),
    { scriptSafe: true },
  );
  return () => {
    commands.unregister(TABLE_SELECT_DATA_COMMAND);
    commands.unregister(TABLE_SELECT_ALL_COMMAND);
  };
}
