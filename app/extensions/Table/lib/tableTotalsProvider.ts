//! FILENAME: app/extensions/Table/lib/tableTotalsProvider.ts
// PURPOSE: The Table extension's side of @api/tableTotalsService (BUG-0769):
//          a table's total at a cell, put there by the totals row's own
//          machinery -- never a formula a caller composed.
// CONTEXT: Excel [LIVE, Excel 16, 2026-11-06, lane uimisc probe3]: AutoSum on
//          a totals-row cell of a table writes =SUBTOTAL(109,[H]) (the column's
//          totals function becomes Sum); AutoSum on the cell just BELOW a table
//          whose totals row is off turns the totals row ON and writes the same.
//          The function and the formula it stands for are the totals row's
//          (`set_totals_row_function` / `toggle_totals_row`, tables.rs
//          `build_subtotal_formula`), so an AutoSum total and a total picked
//          from the totals row's own list are one and the same.

import {
  getAllTables,
  setTotalsRowFunction,
  toggleTotalsRow,
  type Table,
  type TotalsRowFunction,
} from "@api/backend";
import { beginUndoTransaction, commitUndoTransaction, cancelUndoTransaction } from "@api/lib";
import { ownUndoTransaction, type UndoTransactionCloses } from "@api/undoTicket";
import { getGridStateSnapshot } from "@api/grid";
import { showToast } from "@api/notifications";
import type { TableTotalFunction, TableTotalsProvider } from "@api/tableTotalsService";
import { refreshCache } from "./tableStore";

const UNDO_CLOSES: UndoTransactionCloses = {
  commitUndoTransaction: (...ticket) => commitUndoTransaction(...ticket),
  cancelUndoTransaction: (...ticket) => cancelUndoTransaction(...ticket),
};

/** AutoSum's functions as the totals row names them (Count Numbers is COUNT). */
const TOTALS_FUNCTION: Record<TableTotalFunction, TotalsRowFunction> = {
  sum: "sum",
  average: "average",
  countNumbers: "countNumbers",
  max: "max",
  min: "min",
};

/** Where (row, col) stands to a table of the sheet: its totals row, or just below it. */
export interface TotalsCellOfTable {
  table: Table;
  columnName: string;
  /** The totals row is off: the total turns it on first. */
  turnOn: boolean;
}

/**
 * The table whose totals cell (row, col) is, or null: a cell of a SHOWN
 * totals row (the table's last row), or a cell of the row just below a table
 * whose totals row is off.
 */
export function totalsCellOf(tables: readonly Table[], sheetIndex: number, row: number, col: number): TotalsCellOfTable | null {
  for (const table of tables) {
    if (table.sheetIndex !== sheetIndex) continue;
    if (col < table.startCol || col > table.endCol) continue;
    const column = table.columns[col - table.startCol];
    if (!column) continue;
    const shown = table.styleOptions.totalRow === true;
    if (shown && row === table.endRow) return { table, columnName: column.name, turnOn: false };
    if (!shown && row === table.endRow + 1) return { table, columnName: column.name, turnOn: true };
  }
  return null;
}

function reasonOf(result: { error?: string } | null | undefined): string {
  return result?.error || "the table refused it";
}

export function createTableTotalsProvider(): TableTotalsProvider {
  return {
    async applyTotal(row, col, fn) {
      const sheetIndex = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
      if (sheetIndex === undefined) return null;
      const at = totalsCellOf(await getAllTables(), sheetIndex, row, col);
      if (!at) return null;
      // ONE undo step: turning the totals row on and choosing the function.
      const tx = ownUndoTransaction(await beginUndoTransaction("AutoSum"), UNDO_CLOSES);
      try {
        if (at.turnOn) {
          const shown = await toggleTotalsRow(at.table.id, true);
          if (!shown.success) {
            await tx.cancel();
            showToast(`AutoSum: the table's totals row could not be shown -- ${reasonOf(shown)}`, { variant: "error" });
            return false;
          }
        }
        const set = await setTotalsRowFunction({
          tableId: at.table.id,
          columnName: at.columnName,
          function: TOTALS_FUNCTION[fn],
        });
        if (!set.success) {
          // What landed (the totals row shown) stays, in its own step.
          await tx.commit();
          showToast(`AutoSum: the table's total could not be set -- ${reasonOf(set)}`, { variant: "error" });
          return false;
        }
        await tx.commit();
      } catch (err) {
        await tx.commit().catch(() => {});
        showToast(`AutoSum: ${err instanceof Error ? err.message : String(err)}`, { variant: "error" });
        return false;
      }
      await refreshCache();
      return true;
    },
  };
}
