//! FILENAME: app/src/core/lib/merge/mergeText.ts
// PURPOSE: The words of the Merge menu -- labels, Excel's data-loss warning,
//          the refusals -- in ONE place, shared by the gestures and the ribbon.

/** Excel's own data-loss warning, verbatim (Microsoft 365, observed live in
 *  build 20326 on 2026-10-02). Shown with OK / Cancel; Cancel changes nothing. */
export const MERGE_DISCARDS_VALUES =
  "Merging cells only keeps the upper-left value and discards other values.";

/** Why every merge command refuses on a protected sheet. Excel disables the
 *  whole Merge control there, even when Format Cells is allowed. */
export const MERGE_ON_PROTECTED_SHEET =
  "Merging isn't available on a protected sheet. Unprotect the sheet to merge or unmerge cells.";

/** The four commands of Excel's Merge menu, in its order. */
export type MergeGestureKind = "mergeCenter" | "mergeAcross" | "mergeCells" | "unmergeCells";

/** The label of each command -- the menu row, the refusal and the undo step. */
export const MERGE_LABELS: Readonly<Record<MergeGestureKind, string>> = {
  mergeCenter: "Merge & Center",
  mergeAcross: "Merge Across",
  mergeCells: "Merge Cells",
  unmergeCells: "Unmerge Cells",
};

/**
 * The most cells a merge gesture writes an ALIGNMENT to. `apply_formatting`
 * materialises a styled cell at every coordinate it is given, so centring
 * whole columns A:C would create three million cells and ship them back over
 * IPC. Above this, only the merge's top-left cell is aligned -- which renders
 * the same, because the other cells of a merge are empty and the merged cell
 * is drawn from its top-left cell's style. The same bound as Merge Across.
 */
export const MERGE_ALIGN_CELL_LIMIT = 10_000;
