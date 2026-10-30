// FILENAME: app/extensions/Collaboration/lib/designatedRegionsFollowEdits.ts
// PURPOSE: Re-read the writeback snapshot after every structural edit that can
//          have moved the regions THIS workbook designated (the author's own,
//          `calp_get_writeback_draft_regions`), wherever the edit landed.
// CONTEXT: The backend moves a designated region with its cells
//          (`shift_writeback_draft_regions`, commands/structure.rs) on every
//          route: Insert/Delete Rows and Columns on the sheet on screen, their
//          undo, Insert/Delete Cells, AND an insert/delete on a sheet the user is
//          not looking at -- a script's or the command line's `sheetIndex`
//          (`off_sheet_structural_edit`). The snapshot is keyed by sheet id and
//          holds EVERY sheet's regions (writebackStore.ts), and a tab click
//          re-reads nothing, so a region the edit moved off screen kept its old
//          rows: the frame was painted there, and the publisher's Writeback tab
//          (`getActiveDesignatedRegionAt`) answered for the wrong cells. Only the
//          four on-screen events were heard before (rev4A#1); an undo of one of
//          them was not either.
//
//          One list of structural events for every store that caches ranges the
//          backend moves: extensions/_shared/lib/structuralEditReload.ts. An
//          edit OFF the sheet on screen re-reads the LOCAL snapshot only -- the
//          moved regions are this workbook's own, so asking the workspace again
//          (a reconcile) would buy nothing, and a script loop of such edits would
//          otherwise reconcile once per burst. A workbook that designated no
//          region reads nothing (the subscriber's regions refuse a structural
//          edit through them, so they never move) -- EXCEPT on an undo or
//          redo (STRUCTURAL_UNDO): a delete that took a region's every cell
//          drops the region, and its undo puts it back (the
//          `obj_writeback_regions` restore). When that was the workbook's LAST
//          region, the count read 0 after the delete, so the undo's re-read was
//          skipped: the frame stayed missing and the Writeback tab answered
//          "no region" until a reopen, inviting a duplicate designation
//          (rev6B#4). That re-read is local: the regions an undo puts back are
//          this workbook's own.

import { AppEvents } from "@api";
import { onStructuralEdit, type EventSubscribe } from "../../_shared/lib/structuralEditReload";
import { getDesignatedRegionCount, refreshWriteback, refreshWritebackLocal } from "./writebackStore";

/** Subscribe the designated-region re-read; returns the one cleanup. */
export function followStructuralEditsForDesignatedRegions(subscribe: EventSubscribe): () => void {
  const offEdits = onStructuralEdit(subscribe, (where) => {
    if (getDesignatedRegionCount() === 0) return;
    if (where === "elsewhere") void refreshWritebackLocal();
    else void refreshWriteback();
  });
  // The one edit that can bring a region back to a workbook that has none: an
  // undo / redo. (With regions, the listener above already re-reads it.)
  const offUndo = subscribe(AppEvents.STRUCTURAL_UNDO, () => {
    if (getDesignatedRegionCount() === 0) void refreshWritebackLocal();
  });
  return () => {
    offEdits();
    offUndo();
  };
}
