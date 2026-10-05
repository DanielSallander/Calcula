//! FILENAME: app/src/api/announceFormatting.ts
// PURPOSE: The ONE announcement after a formatting write lands: a cell event for
//          every cell the backend reports, then "styles:refresh" (the grid's
//          style cache re-reads) and "grid:refresh" (everything that shows the
//          active cell's state re-reads -- the Home ribbon's pressed buttons,
//          the number-format box, the mini toolbar).
// CONTEXT: Review finding (h), 2026-10-04. The same three steps were copied
//          into the Home tab's applyFormat, its decimals step, its Borders
//          runner and the mini format toolbar; a copy that drops one of them is
//          a ribbon that keeps showing the old state (the defect the clear
//          gestures had). Accepts the backend's FormattingResult, or several of
//          them for a command that wrote block by block (a Ctrl+click / Go To
//          Special selection): every cell is announced, the refreshes once.

import { cellEvents } from "./cellEvents";
import type { FormattingResult } from "../core/types/types";

/** Announce one or more landed formatting writes (see the file header). */
export function announceFormattingResult(
  result: FormattingResult | readonly FormattingResult[] | null | undefined,
): void {
  const results: readonly FormattingResult[] =
    result == null ? [] : Array.isArray(result) ? (result as readonly FormattingResult[]) : [result as FormattingResult];
  for (const one of results) {
    for (const cell of one?.cells ?? []) {
      cellEvents.emit({
        row: cell.row,
        col: cell.col,
        oldValue: undefined,
        newValue: cell.display,
        formula: cell.formula,
      });
    }
  }
  window.dispatchEvent(new CustomEvent("styles:refresh"));
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}
