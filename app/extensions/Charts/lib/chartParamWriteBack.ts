//! FILENAME: app/extensions/Charts/lib/chartParamWriteBack.ts
// PURPOSE: Write a chart parameter's selected value back to its `writeTo` cell
//          (S7c) -- or, on a canvas sheet, say why it cannot.
// CONTEXT: A point-selection / brush param may name a same-sheet cell to write
//          the clicked label into, so formulas and other charts can react. The
//          write goes to the ACTIVE sheet (`updateCell` has no sheet argument,
//          and `parseParamCellTarget` refuses a sheet-qualified target), which
//          is the sheet the chart is showing on. A CANVAS sheet has no cells:
//          the backend refuses every cell write there, and a fire-and-forget
//          write that is refused is a silent no-op the reader cannot explain.
//          So on a canvas the write is not attempted, and the reader is told
//          once, through the async dialog (never `window.alert`, which under
//          Tauri does not even wait).

import { updateCell } from "@api/lib";
import { getGridStateSnapshot } from "@api/grid";
import { alertAsync } from "@api/dialogs";
import { parseParamCellTarget } from "./dataSourceResolver";

/** What happened to one write-back request. */
export type ParamWriteBackOutcome = "written" | "skipped" | "refused";

/** The sentence a canvas refusal shows. Exported for the tests. */
export function canvasParamWriteBackMessage(writeTo: string, paramName?: string): string {
  const who = paramName ? `The chart parameter "${paramName}"` : "This chart parameter";
  const cell = writeTo.startsWith("=") ? writeTo.slice(1) : writeTo;
  return (
    `${who} writes the selected value to cell ${cell.trim()} on the sheet the chart is on, ` +
    "but this is a canvas sheet, which has no cells, so nothing was written. " +
    "Place the chart on a worksheet to use write-back."
  );
}

/** True while a refusal is on screen, so a burst of clicks shows ONE box. */
let refusalOpen = false;

/**
 * Write `value` to the param's `writeTo` cell on the active sheet.
 *
 * - "skipped": `writeTo` is not a single same-sheet cell (nothing to write --
 *   the long-standing S7c rule).
 * - "refused": the active sheet is a canvas; nothing was attempted and the
 *   reader was told (at most one box at a time).
 * - "written": the write was issued (fire-and-forget, as before; its
 *   CELLS_UPDATED only re-renders, so the ephemeral selection survives).
 */
export function writeParamValueToCell(
  writeTo: string,
  value: string,
  paramName?: string,
): ParamWriteBackOutcome {
  const target = parseParamCellTarget(writeTo);
  if (!target) return "skipped";
  if (getGridStateSnapshot()?.surface === "canvas") {
    if (!refusalOpen) {
      refusalOpen = true;
      void alertAsync(canvasParamWriteBackMessage(writeTo, paramName), {
        title: "Charts",
        kind: "warning",
      }).finally(() => {
        refusalOpen = false;
      });
    }
    return "refused";
  }
  void updateCell(target.row, target.col, value);
  return "written";
}
