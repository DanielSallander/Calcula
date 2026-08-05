//! FILENAME: app/extensions/TextToColumns/lib/splitProvider.ts
// PURPOSE: The @api/textToColumnsService provider — the SCRIPT-FACING door to
//          this extension's split logic (Wave 4, RANGE-OPS cluster).
// CONTEXT: Registered at activation (index.ts). Runs the SAME parser the
//          wizard's Finish button runs (parser.ts splitDelimited) and the SAME
//          write path (one undo transaction + updateCellsBatch + grid
//          refresh), so a scripted split and a wizard split can never
//          disagree. Differences from the wizard, on purpose:
//            - NO region auto-detection: the script named an explicit range,
//              and silently growing it would write rows nobody asked about.
//            - NO overwrite confirmation: a script is not a dialog; the
//              caller chose its destination. Protection and writeback claims
//              still refuse through the backend, and the refusal propagates.

import {
  getViewportCells,
  updateCellsBatch,
  beginUndoTransaction,
  commitUndoTransaction,
  cancelUndoTransaction,
} from "@api";
import type { CellUpdateInput } from "@api";
import type {
  TextToColumnsController,
  TextToColumnsRequest,
  TextToColumnsResult,
} from "@api/textToColumnsService";
import { splitDelimited, type DelimitedConfig } from "./parser";

/**
 * Build the wizard's DelimitedConfig from a flat delimiter list.
 *
 * The parser models Excel's wizard exactly: four standard checkboxes plus ONE
 * "other" character. More than one non-standard character cannot be expressed
 * (the wizard cannot either), so it is refused with the fix spelled out
 * rather than silently dropping delimiters. Exported for tests.
 */
export function delimitersToConfig(
  delimiters: string[] | undefined,
  consecutiveAsOne: boolean,
): DelimitedConfig {
  const config: DelimitedConfig = {
    tab: false,
    semicolon: false,
    comma: false,
    space: false,
    other: "",
    treatConsecutiveAsOne: consecutiveAsOne,
    textQualifier: '"',
  };
  const list = delimiters === undefined || delimiters.length === 0 ? [","] : delimiters;
  for (const d of list) {
    if (typeof d !== "string" || d.length !== 1) {
      throw new Error(`each delimiter must be exactly one character (got ${JSON.stringify(d)})`);
    }
    switch (d) {
      case "\t": config.tab = true; break;
      case ";": config.semicolon = true; break;
      case ",": config.comma = true; break;
      case " ": config.space = true; break;
      default:
        if (config.other !== "" && config.other !== d) {
          throw new Error(
            `at most one custom delimiter is supported (got "${config.other}" and "${d}"); ` +
              "tab, semicolon, comma and space combine freely",
          );
        }
        config.other = d;
    }
  }
  return config;
}

/** Run one split as a single undo step. See the seam contract in
 *  @api/textToColumnsService. */
export async function splitTextToColumns(
  request: TextToColumnsRequest,
): Promise<TextToColumnsResult> {
  const { startRow, startCol, endRow, endCol } = request;
  if (startCol !== endCol) {
    throw new Error("Text to Columns requires a single-column source range.");
  }
  if (endRow < startRow) {
    throw new Error("Text to Columns source range is empty (endRow before startRow).");
  }
  const config = delimitersToConfig(
    request.delimiters,
    request.consecutiveAsOne === true,
  );

  // Read the source column as DISPLAYED — the wizard's own semantics: Text to
  // Columns operates on the text the user sees.
  const cells = await getViewportCells(startRow, startCol, endRow, startCol);
  const values: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const cell = cells.find((c) => c.row === r && c.col === startCol);
    values.push(cell?.display ?? "");
  }

  const parsed = values.map((v) => splitDelimited(v, config));
  const columnsProduced = parsed.reduce((max, row) => Math.max(max, row.length), 0);
  const destination = request.destination ?? { row: startRow, col: startCol };

  if (columnsProduced === 0) {
    return { rowsProcessed: values.length, columnsProduced: 0, cellsWritten: 0, writtenCells: [] };
  }

  // Every destination cell of the rectangle is written — a row with fewer
  // fields blanks its tail cells, exactly like the wizard (a stale value left
  // beside a shorter row would look like a split result).
  const updates: CellUpdateInput[] = [];
  const writtenCells: Array<{ row: number; col: number }> = [];
  for (let rowIdx = 0; rowIdx < parsed.length; rowIdx++) {
    const fields = parsed[rowIdx];
    const absRow = destination.row + rowIdx;
    for (let colIdx = 0; colIdx < columnsProduced; colIdx++) {
      const absCol = destination.col + colIdx;
      updates.push({ row: absRow, col: absCol, value: fields[colIdx] ?? "" });
      writtenCells.push({ row: absRow, col: absCol });
    }
  }

  try {
    await beginUndoTransaction("Text to Columns");
    await updateCellsBatch(updates);
    await commitUndoTransaction();
  } catch (err) {
    // Close the transaction — left open, later edits silently join it — and
    // propagate the BACKEND's reason (it names the refusing cell/region).
    try { await cancelUndoTransaction(); } catch { /* already closed */ }
    throw err;
  }

  // Same refresh the wizard fires: refetch cell data and redraw the canvas.
  window.dispatchEvent(new CustomEvent("grid:refresh"));

  return {
    rowsProcessed: values.length,
    columnsProduced,
    cellsWritten: updates.length,
    writtenCells,
  };
}

/** The controller the extension registers with @api/textToColumnsService. */
export const textToColumnsController: TextToColumnsController = {
  split: splitTextToColumns,
};
