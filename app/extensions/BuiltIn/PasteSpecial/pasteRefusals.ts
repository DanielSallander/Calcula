//! FILENAME: app/extensions/BuiltIn/PasteSpecial/pasteRefusals.ts
// PURPOSE: WHEN a paste variant must not paste, and the ONE sentence it says.
// CONTEXT: Home tab = Excel's Home tab, clipboard lane (2026-10-04; survey
//          clipboard.md section 9, defects 3 and 4). Every paste variant --
//          the quick pastes (Values, Formulas, Formatting, Link), the Home
//          menu's rows (Transpose, No Borders, Keep Source Column Widths, ...)
//          and the Paste Special dialog's OK -- pastes the INTERNAL clipboard
//          into Core's selection. Plain Paste refuses or changes course in
//          situations the variants used to sail through:
//
//            - AFTER A CUT. Excel greys every Paste menu row but Paste, and the
//              Paste Special dialog, until the cut is pasted (measured live
//              through COM 2026-10-04: GetEnabledMso of PasteValues,
//              PasteFormulas, PasteFormatting, PasteLink, PasteTranspose,
//              PasteNoBorders, PasteValuesAndSourceFormatting and
//              PasteSpecialDialog are False after Range.Cut, True after
//              Range.Copy). The variants here never clear a cut's source, so
//              pasting a cut through them was a silent COPY.
//            - A STALE internal clipboard: another program copied text after
//              Calcula did. Plain Paste pastes that text; the variants pasted
//              the old cells (@api/cellClipboard holds the one rule).
//            - A PROTECTED REGION under the paste area (a pivot table): plain
//              Paste asks the range guards; the variants did not.
//            - Nothing copied, a canvas sheet (no cells), no selection: the
//              variants returned SILENTLY.
//
//          Every refusal is said with alertAsync -- the console is not the
//          user -- and ends in "Nothing was changed.", the house sentence for
//          a refused gesture.

import type { ClipboardData } from "@api/lib";
import { checkRangeGuards } from "@api/editGuards";
import { internalClipboardIsCurrent } from "@api/cellClipboard";

/** The cells a paste would write: top-left and size, already clamped to the grid. */
export interface PasteArea {
  row: number;
  col: number;
  height: number;
  width: number;
}

const NOTHING_CHANGED = "Nothing was changed.";

/** The sentences, one per refusal (exported so every door says the same). */
export const pasteRefusalSentence = {
  afterCut: (label: string): string =>
    `${label} is not available after Cut: only Paste (Ctrl+V) moves cut cells. ${NOTHING_CHANGED}`,
  stale: (label: string): string =>
    `${label} cannot paste the copied cells: another program has put newer text on the clipboard since. ` +
    `Use Paste (Ctrl+V) to paste that text, or copy the cells again. ${NOTHING_CHANGED}`,
  guardFallback: (label: string): string =>
    `${label}: the paste area overlaps a protected region. ${NOTHING_CHANGED}`,
  nothingCopied: (label: string): string =>
    `${label}: there is nothing to paste. Copy cells first (Ctrl+C). ${NOTHING_CHANGED}`,
  canvas: (label: string): string =>
    `${label} is not available on a canvas sheet: a canvas has no cells to paste into. ${NOTHING_CHANGED}`,
  noSelection: (label: string): string =>
    `${label}: select the cells to paste into first. ${NOTHING_CHANGED}`,
  /** A paste with no route onto a floating grid's cells (style only, comments, validation, column widths). */
  notOnFloatingGrid: (label: string): string =>
    `${label} is not available inside a floating grid yet. ${NOTHING_CHANGED}`,
};

/**
 * Why `clipboard` must not be pasted into `area` by the door named `label`,
 * or null when it may. Asked AFTER the selection-owner check (which toasts its
 * own sentence) and BEFORE any write or undo step:
 *   1. a cut clipboard (Excel: only plain Paste after a Cut);
 *   2. a stale internal clipboard (another program copied newer text);
 *   3. a range guard blocking `area` (a pivot table, a protected report) --
 *      skipped when `area` is null (Paste Special > Column widths writes no
 *      cell).
 */
export async function pasteRefusal(
  clipboard: ClipboardData,
  area: PasteArea | null,
  label: string,
): Promise<string | null> {
  if (clipboard.isCut) return pasteRefusalSentence.afterCut(label);
  if (!(await internalClipboardIsCurrent(clipboard))) return pasteRefusalSentence.stale(label);
  if (area && area.height > 0 && area.width > 0) {
    const guard = checkRangeGuards(area.row, area.col, area.row + area.height - 1, area.col + area.width - 1);
    if (guard?.blocked) return guard.message || pasteRefusalSentence.guardFallback(label);
  }
  return null;
}
