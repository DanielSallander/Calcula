//! FILENAME: app/extensions/Charts/lib/chartParamWriteBack.ts
// PURPOSE: Write a chart parameter's selected value back to its `writeTo` cell
//          (S7c) -- on the sheet the chart reads -- or say why it cannot.
// CONTEXT: A point-selection / brush param may name an unqualified cell to
//          write the clicked label into, so formulas and other charts can
//          react. WHICH SHEET is `locateParamCell`'s answer (the rule the
//          param's READ follows too, dataSourceResolver.ts):
//            - a chart on a worksheet: its own sheet -- the active sheet while
//              it is being clicked, written exactly as before (`updateCell`);
//            - a chart on a CANVAS, which has no cells: the sheet its DATA
//              comes from, written as a background-sheet write (the
//              `CellRange` door, which also announces the change so every
//              chart reading that sheet repaints). It used to be refused with
//              a message, and the param never left its literal default;
//            - a canvas chart whose data does not come from a sheet (a pivot,
//              a model query): there is no sheet to write to, so the write is
//              not attempted and the reader is told once, through the async
//              dialog (never `window.alert`, which under Tauri does not wait).

import { updateCell } from "@api/lib";
import { CellRange } from "@api/range";
import { getGridStateSnapshot } from "@api/grid";
import { alertAsync } from "@api/dialogs";
import { locateParamCell, type ParamCellHost } from "./dataSourceResolver";

/** What happened to one write-back request. */
export type ParamWriteBackOutcome = "written" | "skipped" | "refused";

/** The sentence a refusal on a canvas with NO chart named shows. Exported for the tests. */
export function canvasParamWriteBackMessage(writeTo: string, paramName?: string): string {
  const who = paramName ? `The chart parameter "${paramName}"` : "This chart parameter";
  const cell = writeTo.startsWith("=") ? writeTo.slice(1) : writeTo;
  return (
    `${who} writes the selected value to cell ${cell.trim()} on the sheet the chart is on, ` +
    "but this is a canvas sheet, which has no cells, so nothing was written. " +
    "Place the chart on a worksheet to use write-back."
  );
}

/** The sentence a canvas chart whose data has no sheet shows. Exported for the tests. */
export function noDataSheetParamWriteBackMessage(writeTo: string, paramName?: string): string {
  const who = paramName ? `The chart parameter "${paramName}"` : "This chart parameter";
  const cell = writeTo.startsWith("=") ? writeTo.slice(1) : writeTo;
  return (
    `${who} writes the selected value to cell ${cell.trim()} on the sheet the chart reads its data from, ` +
    "but this chart is on a canvas sheet, which has no cells, and its data does not come from a sheet " +
    "(it comes from a PivotTable or the data model), so nothing was written. " +
    "Chart a worksheet range, or place the chart on a worksheet, to use write-back."
  );
}

/** True while a refusal is on screen, so a burst of clicks shows ONE box. */
let refusalOpen = false;

function refuse(message: string): ParamWriteBackOutcome {
  if (!refusalOpen) {
    refusalOpen = true;
    void alertAsync(message, { title: "Charts", kind: "warning" }).finally(() => {
      refusalOpen = false;
    });
  }
  return "refused";
}

/**
 * Write `value` to the param's `writeTo` cell on the sheet the chart reads.
 *
 * - "skipped": `writeTo` is not a single unqualified cell (nothing to write --
 *   the long-standing S7c rule).
 * - "refused": there is no sheet to write to (a canvas chart with no data
 *   sheet, or -- with no chart named -- a canvas as the active sheet); nothing
 *   was attempted and the reader was told (at most one box at a time). Also
 *   the answer when the backend refused the write itself (logged).
 * - "written": the write landed. The active sheet's cell goes through
 *   `updateCell` exactly as before; another sheet's (a canvas chart's data
 *   sheet) through the background-sheet write, which announces itself. Its
 *   CELLS_UPDATED only re-renders, so the ephemeral selection survives.
 *   Callers do not await it: a click never waits on a cell write.
 */
export async function writeParamValueToCell(
  writeTo: string,
  value: string,
  paramName?: string,
  host: ParamCellHost | null = null,
): Promise<ParamWriteBackOutcome> {
  const at = await locateParamCell(writeTo, host);
  if (at.kind === "invalid") return "skipped";
  if (at.kind === "noSheet") return refuse(noDataSheetParamWriteBackMessage(writeTo, paramName));
  const grid = getGridStateSnapshot();
  const activeIndex = grid?.sheetContext?.activeSheetIndex;
  try {
    if (at.sheetIndex === activeIndex) {
      // With no chart named, the active sheet is the target -- and a canvas
      // has no cells: the backend would refuse the write in silence.
      if (grid?.surface === "canvas") return refuse(canvasParamWriteBackMessage(writeTo, paramName));
      await updateCell(at.row, at.col, value);
    } else {
      await CellRange.fromCell(at.row, at.col, at.sheetIndex).setValue(value);
    }
  } catch (err) {
    // A backend refusal (a protected sheet) is the backend's to explain; the
    // param's own selection is unaffected.
    console.error(`[Charts] param write-back to ${writeTo} failed:`, err);
    return "refused";
  }
  return "written";
}
