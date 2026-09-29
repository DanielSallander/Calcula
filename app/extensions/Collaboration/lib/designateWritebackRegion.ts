//! FILENAME: app/extensions/Collaboration/lib/designateWritebackRegion.ts
// PURPOSE: Writeback > Designate Writeback Region...: open the designate
//          dialog on the SELECTED range of the active sheet.
// CONTEXT: The menu item's action, lifted out of index.ts so the door can be
//          driven on its own (the extension's activation wires listeners,
//          guards and panes that have nothing to do with it). It refuses while
//          something else owns the selection -- a floating grid's selected
//          cell, with Core's selection HIDDEN under it -- because the region
//          it designates IS that selection (D4, BUG-0185 class).

import type { ExtensionContext } from "@api/contract";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { DESIGNATE_WRITEBACK_DIALOG_ID } from "../manifest";

/** The selected range the region is designated on. */
export interface DesignateSelection {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/**
 * Open the Designate Writeback Region dialog on `selection` (Core's selection
 * on the active sheet), whose sheet id `resolveSheetId` looks up.
 */
export async function designateWritebackRegion(
  context: ExtensionContext,
  selection: DesignateSelection | null,
  resolveSheetId: () => Promise<string>,
): Promise<void> {
  if (refuseIfSelectionOwned("Designate Writeback Region")) return;
  if (!selection) {
    context.ui.notifications.showToast(
      "Select the cell range to designate first, then run this command again.",
      { type: "info", duration: 4000 },
    );
    return;
  }
  try {
    const sheetId = await resolveSheetId();
    context.ui.dialogs.show(DESIGNATE_WRITEBACK_DIALOG_ID, {
      sheetId,
      startRow: selection.startRow,
      endRow: selection.endRow,
      startCol: selection.startCol,
      endCol: selection.endCol,
    });
  } catch (err) {
    context.ui.notifications.showToast(
      `Cannot designate writeback region: ${err}`,
      { type: "error", duration: 5000 },
    );
  }
}
