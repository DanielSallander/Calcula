//! FILENAME: app/src/api/activeCell.ts
// PURPOSE: The ONE active-cell rule, for every extension that reads or writes
//          "the cell" of a selection: `activeRow ?? endRow`, `activeCol ??
//          endCol` -- the cell the grid draws as active, never the anchor
//          (`startRow/startCol`) and never the top-left corner.
// CONTEXT: Review finding (g), 2026-10-04. A pure re-export of Core's rule
//          (core/lib/activeCell.ts), which Core's own Ctrl+B / Ctrl+; read too,
//          so the ribbon, the mini toolbar, Format Cells and the keyboard cannot
//          disagree about which cell a selection is "on".

export { activeCellOf } from "../core/lib/activeCell";
export type { ActiveCellSource } from "../core/lib/activeCell";
