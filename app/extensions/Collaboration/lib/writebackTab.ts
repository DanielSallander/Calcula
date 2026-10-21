// FILENAME: app/extensions/Collaboration/lib/writebackTab.ts
// PURPOSE: Shows the contextual "Writeback" ribbon tab while Core's ACTIVE cell
//          is inside a subscribed writeback region on the active sheet, and
//          keeps its badge (unsent values across the workbook) current.
// CONTEXT: The Table Design shape (Table/handlers/selectionHandler.ts), minus
//          its dedupe cache:
//            - ONE gate (`showWritebackTab`): shown only while no selection
//              owner (a floating grid's cell, @api/selectionOwner) holds the
//              selection, registered at most once;
//            - the hide is unconditional -- the tab is a function of the
//              CURRENT state, never of how it was switched on;
//            - re-derived for Core's active cell NOW when a selection owner's
//              claim starts or ends, when the active sheet changes, and when
//              the region list changes under a cursor that did not move
//              (`syncWritebackTabToRegions`, the BUG-0026 shape).
//          There is no (row, col) dedupe, so the stale-sheet defect Table's
//          `recheckDesignTabAfterSheetChange` fixes cannot occur here: the
//          membership test is an in-memory lookup keyed by the ACTIVE sheet's
//          id at the moment of asking (writebackStore).

import { registerPanel, unregisterPanel, PanelExtensions } from "@api/ui";
import { getGridStateSnapshot } from "@api/grid";
import { isSelectionOwned } from "@api/selectionOwner";
import { getActiveRegionAt, hasWritebackRegions, totalUnsentDrafts } from "./writebackStore";
import { setWritebackTabRegionId, countText } from "./writebackTabModel";
import { WritebackPanelDefinition, WRITEBACK_TAB_ID } from "../manifest";

/** Whether the contextual panel is registered now. */
let tabRegistered = false;

/** The last active cell Core announced to this handler (used only when the
 *  grid state is not readable, e.g. before the grid mounted). */
let lastCoreCell: { row: number; col: number } | null = null;

/** The badge text last set, so an unchanged count does not re-render the strip. */
let lastBadge: string | null = null;

function setBadge(text: string | null): void {
  if (text === lastBadge) return;
  lastBadge = text;
  PanelExtensions.setBadge(WRITEBACK_TAB_ID, text);
}

/** The tab badge: the workbook's unsent values, or nothing at zero. */
function syncBadge(): void {
  if (!tabRegistered) {
    setBadge(null);
    return;
  }
  const n = totalUnsentDrafts();
  setBadge(n > 0 ? countText(n) : null);
}

/**
 * The single gate. Shown for a writeback region under Core's active cell, and
 * never while a selection owner holds the selection: that cell is then hidden
 * under the owner, and a tab whose Submit acts on a region nobody can see is
 * not Excel's rule (W22).
 */
function showWritebackTab(show: boolean): void {
  if (show && !isSelectionOwned()) {
    if (!tabRegistered) {
      registerPanel(WritebackPanelDefinition);
      tabRegistered = true;
    }
  } else if (tabRegistered) {
    unregisterPanel(WRITEBACK_TAB_ID);
    tabRegistered = false;
  }
  syncBadge();
}

/** Core's active cell now: the grid's own state, else the last announced cell. */
function coreActiveCell(): { row: number; col: number } | null {
  const sel = getGridStateSnapshot()?.selection;
  if (sel) return { row: sel.endRow, col: sel.endCol };
  return lastCoreCell;
}

function deriveForCell(cell: { row: number; col: number } | null): void {
  const region = cell && hasWritebackRegions() ? getActiveRegionAt(cell.row, cell.col) : null;
  // The region the tab's buttons address follows the cursor even while the
  // tab stands aside for a selection owner, so it is right when it returns.
  setWritebackTabRegionId(region ? region.regionId : null);
  showWritebackTab(region !== null);
}

/**
 * Core's selection changed (ExtensionRegistry.onSelectionChange). The active
 * cell is the selection's END cell, as for every cell-driven tab.
 */
export function handleWritebackSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) return;
  lastCoreCell = { row: selection.endRow, col: selection.endCol };
  deriveForCell(lastCoreCell);
}

/**
 * Re-derive the tab for Core's active cell NOW. Called when a selection
 * owner's claim starts or ends, when the active sheet changes, and whenever
 * the writeback snapshot changes (a region list arriving after a subscribe, a
 * detach taking regions away, a submit changing the badge) -- Core's cursor
 * did not move in any of those, so the selection handler was never asked.
 * The hide is unconditional: no cell, or no region under it, takes the tab down.
 */
export function syncWritebackTabToRegions(): void {
  const cell = coreActiveCell();
  if (cell) {
    handleWritebackSelectionChange({ endRow: cell.row, endCol: cell.col });
    return;
  }
  setWritebackTabRegionId(null);
  showWritebackTab(false);
}

/** Whether the tab is registered now (tests, diagnostics). */
export function isWritebackTabShown(): boolean {
  return tabRegistered;
}

/** Deactivation: take the tab and its badge down and forget the cursor. */
export function resetWritebackTab(): void {
  lastCoreCell = null;
  setWritebackTabRegionId(null);
  if (tabRegistered) {
    unregisterPanel(WRITEBACK_TAB_ID);
    tabRegistered = false;
  }
  setBadge(null);
  lastBadge = null;
}
