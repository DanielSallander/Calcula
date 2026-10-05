//! FILENAME: app/src/api/selectionBlocks.ts
// PURPOSE: The ONE way to split a selection into its rectangles: the MAIN range
//          (the block holding the active cell) first, then every Ctrl+click /
//          Go To Special range, each normalised (start <= end on both axes),
//          a block that repeats an earlier one exactly dropped.
// CONTEXT: Review finding (h), 2026-10-04. Three copies existed -- Core's
//          (merge, clear, AutoFit, Insert/Delete Sheet Rows), the Home tab's
//          editing rules and its Borders runner -- and the Borders one did not
//          de-duplicate, so the same Ctrl+click selection was formatted
//          differently depending on the button. A pure re-export of Core's
//          (core/lib/merge/mergeGeometry.ts): a command that formats "every
//          block" iterates exactly what Core's own clears and merges iterate.

export { selectionBlocks, normaliseBlock } from "../core/lib/merge/mergeGeometry";
export type { Block as SelectionBlock } from "../core/lib/merge/mergeGeometry";
