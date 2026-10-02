//! FILENAME: app/extensions/FloatingRange/lib/frObjectSelection.ts
// PURPOSE: The Floating Range's provider for @api/objectSelection — select,
//          deselect and report floating ranges for a caller that is NOT a mouse
//          press (a canvas sheet's Tab / Shift+Tab / Escape, its click on the
//          empty page), and answer whether the range's INNER cell selection
//          owns Tab or Escape right now.
// CONTEXT: A floating range has two selections (lib/frSelection.ts): the
//          OBJECT (its chrome) and a LOCAL cell selection inside it. While the
//          local one exists, the range's own capture-phase key handler
//          (index.ts, `handleFrKeyDown`) moves the inner cell on Tab and drops
//          the inner selection on Escape — and a window-capture listener cannot
//          be stopped by another window-capture listener. So a canvas-level
//          Tab/Escape binding must ASK before it acts, or one key press would
//          both move the inner cell and cycle to the next object. `ownsKey` is
//          that answer, from the family that owns the state.

import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectSelectionProvider,
  type ObjectSelectionKey,
  type ObjectSelectionProvider,
} from "@api/objectSelection";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { canvasObjectRef } from "@api/canvasSheet";
import { FLOATING_RANGE_REGION_TYPE, getFloatingRangeById } from "./floatingRangeStore";
import { isFrContextMenuOpen } from "./frContextMenu";
import { frSelectionOnScreen } from "./frKeyRouting";
import {
  clearLocalSelection,
  deselectAllFloatingRanges,
  getLocalSelection,
  hasFloatingRangeSelection,
  isFloatingRangeSelected,
  selectFloatingRange,
} from "./frSelection";

/** The floating-range id a published region carries, or null. */
export function frIdOf(region: GridRegion): string | null {
  const id = region.data?.frId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** What the provider needs from the extension that it cannot import itself. */
export interface FrObjectSelectionDeps {
  /**
   * Delete these ranges the way the range's own Delete does (one confirmation,
   * because a delete ends the undo history). Resolves when every deletion has
   * LANDED; rejects -- the ranges stay -- when the user declines or the
   * backend refuses (the @api/objectSelection `deleteObjects` contract).
   */
  deleteRanges?: (frIds: readonly string[]) => Promise<void>;
}

/** The provider object (exported for tests; register it through
 *  `registerFloatingRangeObjectSelection`). */
export function createFloatingRangeSelectionProvider(
  deps: FrObjectSelectionDeps = {},
): ObjectSelectionProvider {
  const deleteRanges = deps.deleteRanges;
  return {
    types: [FLOATING_RANGE_REGION_TYPE],

    // A canvas-wide Delete (@api/objectSelection `deleteSelectedObjects`)
    // hands the range's share of a multi-selection here -- set-held members
    // included -- so a floating range is deleted with the chart beside it
    // instead of being left standing and named in a "not deleted" toast.
    ...(deleteRanges
      ? {
          async deleteObjects(regions: readonly GridRegion[]): Promise<void> {
            const ids = Array.from(
              new Set(regions.map(frIdOf).filter((id): id is string => id !== null)),
            );
            if (ids.length === 0) return;
            await deleteRanges(ids);
          },
        }
      : {}),

    isSelected(region: GridRegion): boolean {
      const id = frIdOf(region);
      return id !== null && isFloatingRangeSelected(id);
    },

    select(region: GridRegion): void {
      const id = frIdOf(region);
      if (id === null || !getFloatingRangeById(id)) return;
      // The mouse route's rule: an inner selection belongs to ONE range, so it
      // cannot survive the object selection moving to another.
      const local = getLocalSelection();
      if (local && local.frId !== id) clearLocalSelection();
      selectFloatingRange(id);
      requestOverlayRedraw();
    },

    deselectAll(): void {
      // No-op (and no repaint) when nothing is selected.
      if (!hasFloatingRangeSelection() && getLocalSelection() === null) return;
      deselectAllFloatingRanges();
      clearLocalSelection();
      requestOverlayRedraw();
    },

    ownsKey(key: ObjectSelectionKey): boolean {
      // The range's right-click menu, while open, owns Escape: it closes
      // itself (a document-capture listener). A canvas's Escape binding runs
      // EARLIER, in the dispatcher's window-capture listener, and stops the
      // key -- so unless the range claims it here, Escape cleared the
      // selection behind the menu and left the menu open (fix round 4, F5).
      if (key === "Escape" && isFrContextMenuOpen()) return true;
      // Delete / Backspace are the range's own door's while the range -- a
      // cell of it, or the range itself -- is selected on the sheet shown
      // (frKeyRouting.ts: it clears the cell, or deletes the range). The
      // generic object Delete (BUG-0270) asks this and stands down, so it can
      // never delete the whole range where its door would clear a cell,
      // whichever extension happens to activate first.
      if (key === "Delete") return frSelectionOnScreen();
      // Tab moves the inner cell, the arrows move (or Shift-extend) it, and
      // Escape drops the inner selection — all only while an inner selection
      // exists (handleFrKeyDown). Without one, the range has no use for them.
      // Copy / Paste / Duplicate ("Clipboard") are the CELLS' keys while a
      // cell is selected: the canvas's object clipboard (W25) must not copy
      // the range as an object from under a cell selection (today those keys
      // are refused for the range's cells, frKeyRouting.ts, and the refusal
      // is what the user must hear).
      if (key !== "Tab" && key !== "Escape" && key !== "Arrow" && key !== "Clipboard") return false;
      const local = getLocalSelection();
      return local !== null && getFloatingRangeById(local.frId) !== null;
    },

    refOf(region: GridRegion) {
      const id = frIdOf(region);
      return id === null ? null : canvasObjectRef("floatingRange", id);
    },

    // The name the range is published with (syncFloatingRangeRegions).
    labelOf(region: GridRegion): string | null {
      const name = region.data?.name;
      return typeof name === "string" && name !== "" ? name : null;
    },
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerFloatingRangeObjectSelection(deps: FrObjectSelectionDeps = {}): () => void {
  return registerObjectSelectionProvider(createFloatingRangeSelectionProvider(deps));
}
