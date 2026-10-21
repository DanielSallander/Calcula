// FILENAME: app/extensions/Collaboration/lib/writebackTab.ts
// PURPOSE: Shows the contextual "Writeback" ribbon tab while Core's ACTIVE cell
//          is inside a writeback region on the active sheet -- with the
//          SUBSCRIBER's commands in a subscribed region, the PUBLISHER's in one
//          this workbook designated itself -- and keeps the subscriber badge
//          (unsent values across the workbook) current.
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
import {
  getActiveRegionAt,
  getActiveDesignatedRegionAt,
  hasWritebackRegions,
  hasWritebackFrames,
  totalUnsentDrafts,
} from "./writebackStore";
import {
  setWritebackTabRegionId,
  setWritebackPublisherRegionId,
  countText,
  type WritebackTabRole,
} from "./writebackTabModel";
import {
  WritebackPanelDefinition,
  WritebackPublisherPanelDefinition,
  WRITEBACK_TAB_ID,
} from "../manifest";

/** Which definition of the tab is registered now, or null when it is down. */
let tabRole: WritebackTabRole | null = null;

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

/** The tab badge: the workbook's unsent values, or nothing at zero. Only the
 *  subscriber's tab carries it -- a publisher has nothing to send. */
function syncBadge(): void {
  if (tabRole !== "subscriber") {
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
function showWritebackTab(role: WritebackTabRole | null): void {
  if (role && !isSelectionOwned()) {
    if (tabRole !== role) {
      // One id, two definitions: moving between a subscribed region and one of
      // the workbook's own swaps the section list.
      if (tabRole) unregisterPanel(WRITEBACK_TAB_ID);
      registerPanel(role === "publisher" ? WritebackPublisherPanelDefinition : WritebackPanelDefinition);
      tabRole = role;
    }
  } else if (tabRole) {
    unregisterPanel(WRITEBACK_TAB_ID);
    tabRole = null;
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
  // The workbook's OWN region is asked only when no subscribed one is there (a
  // cell is never both: a working copy cannot subscribe to its application).
  const own =
    cell && !region && hasWritebackFrames() ? getActiveDesignatedRegionAt(cell.row, cell.col) : null;
  // The region the tab's buttons address follows the cursor even while the
  // tab stands aside for a selection owner, so it is right when it returns.
  setWritebackTabRegionId(region ? region.regionId : null);
  setWritebackPublisherRegionId(own ? own.id : null);
  showWritebackTab(region ? "subscriber" : own ? "publisher" : null);
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
  setWritebackPublisherRegionId(null);
  showWritebackTab(null);
}

/** Whether the tab is registered now (tests, diagnostics). */
export function isWritebackTabShown(): boolean {
  return tabRole !== null;
}

/** Which commands the registered tab shows, or null when it is down. */
export function getWritebackTabRole(): WritebackTabRole | null {
  return tabRole;
}

/** Deactivation: take the tab and its badge down and forget the cursor. */
export function resetWritebackTab(): void {
  lastCoreCell = null;
  setWritebackTabRegionId(null);
  setWritebackPublisherRegionId(null);
  if (tabRole) {
    unregisterPanel(WRITEBACK_TAB_ID);
    tabRole = null;
  }
  setBadge(null);
  lastBadge = null;
}
