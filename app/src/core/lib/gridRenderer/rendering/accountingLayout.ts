//! FILENAME: app/src/core/lib/gridRenderer/rendering/accountingLayout.ts
// PURPOSE: Where each run of an ACCOUNTING value goes inside its cell.
// CONTEXT: Pure. Excel's accounting code is three runs -- text pinned to the
//          cell's LEFT edge, a fill (`*` + space), text pinned to the RIGHT edge
//          -- and the backend hands the runs' text over as `AccountingLayout`
//          (core/types/types.ts carries the contract). This function only
//          decides positions; it never re-formats a number.
//
// SURVEY DEFECT A, and why symbol-AFTER is not the mirror image of BEFORE. The
// painter used to treat it as one: value at the left edge, symbol at the right.
// Excel's symbol-after code is `_-* # ##0,00 kr_-` -- the FILL comes first and
// the whole "number, space, symbol, pad" group is the right-edge run. Measured
// live on sv-SE: 1234.5 shows "   1 234,50 kr " and -42 shows
// "-         42,00 kr " (that one minus is the only thing pinned left; it
// precedes the fill in `-* # ##0,00 kr_-`). A column of amounts therefore
// lines its decimals up against the symbol, which the old layout could not do.
//
// The run text, symbol after:
//   - `value` ends with the trailing pad " " for positives, zeros and minus
//     negatives (Excel's `_-`); that pad goes AFTER the symbol, and the space
//     before the symbol is Excel's literal " kr";
//   - a minus negative's `value` starts with "-" FOLLOWED BY A DIGIT, and only
//     that character is split off to the left edge. A zero is "-" + U+2007
//     (digit-width spaces), never a digit, so its dash stays in the number;
//   - a parenthesised negative ends with ")" and has no pad.

import type { AccountingLayout } from "../../../types";

/** One run of an accounting value: draw `text` with its LEFT edge at `x`. */
export interface AccountingRun {
  text: string;
  x: number;
}

/**
 * Position the runs of an accounting value inside the content box `left`..
 * `right` (the cell minus its padding). `width` is the runs' total width --
 * the number the caller compares with the box to decide on Excel's '####'.
 */
export function layoutAccountingRuns(
  layout: AccountingLayout,
  left: number,
  right: number,
  measure: (text: string) => number,
): { runs: AccountingRun[]; width: number } {
  let leftRun = "";
  let rightRun: string;

  if (layout.symbolBefore) {
    leftRun = layout.symbol;
    rightRun = layout.value;
  } else {
    let rest = layout.value;
    if (/^-\d/.test(rest)) {
      leftRun = "-";
      rest = rest.substring(1);
    }
    const pad = rest.endsWith(" ") ? " " : "";
    const number = pad ? rest.substring(0, rest.length - 1) : rest;
    rightRun = layout.symbol ? `${number} ${layout.symbol}${pad}` : `${number}${pad}`;
  }

  const runs: AccountingRun[] = [];
  let width = 0;
  if (leftRun !== "") {
    runs.push({ text: leftRun, x: left });
    width += measure(leftRun);
  }
  const rightWidth = measure(rightRun);
  runs.push({ text: rightRun, x: right - rightWidth });
  width += rightWidth;
  return { runs, width };
}
