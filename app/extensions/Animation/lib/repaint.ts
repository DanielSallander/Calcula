//! FILENAME: app/extensions/Animation/lib/repaint.ts
// PURPOSE: Push a frame's recalculated cells to the repaint path so the grid AND
//          charts update live.
// CONTEXT: anim_apply_frame / anim_restore return the changed CellData. To repaint
//          we (1) emit CELLS_UPDATED with the changes so charts run their scoped
//          invalidation (chartIntersectsChanges), and (2) emit the raw "grid:refresh"
//          signal that GridCanvas listens to in order to RE-FETCH the viewport cells
//          (so the new transient values are shown) — the same signal scenario "show"
//          and undo/redo use. (AppEvents.GRID_REFRESH only redraws the cached
//          viewport; it does NOT re-fetch, so it is not sufficient on its own.)
import { emitAppEvent, AppEvents, type CellValueChange } from "@api/events";
import type { CellData } from "@api";

export function repaintFromCells(updatedCells: CellData[]): void {
  if (updatedCells.length > 0) {
    const changes: CellValueChange[] = updatedCells.map((c) => ({
      row: c.row,
      col: c.col,
      sheetIndex: c.sheetIndex,
      newValue: c.display,
      formula: c.formula ?? null,
    }));
    emitAppEvent(AppEvents.CELLS_UPDATED, { changes });
  }
  emitAppEvent("grid:refresh");
}
