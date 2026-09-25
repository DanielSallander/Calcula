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
import { FLOATING_RANGE_REGION_TYPE, getFloatingRangeById } from "./floatingRangeStore";
import {
  clearLocalSelection,
  deselectAllFloatingRanges,
  getLocalSelection,
  hasFloatingRangeSelection,
  isFloatingRangeSelected,
  selectFloatingRange,
} from "./frSelection";

/** The floating-range id a published region carries, or null. */
function frIdOf(region: GridRegion): string | null {
  const id = region.data?.frId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** The provider object (exported for tests; register it through
 *  `registerFloatingRangeObjectSelection`). */
export function createFloatingRangeSelectionProvider(): ObjectSelectionProvider {
  return {
    types: [FLOATING_RANGE_REGION_TYPE],

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
      // Tab moves the inner cell and Escape drops the inner selection — both
      // only while an inner selection exists (handleFrKeyDown). Without one,
      // the range has no use for either key.
      if (key !== "Tab" && key !== "Escape") return false;
      const local = getLocalSelection();
      return local !== null && getFloatingRangeById(local.frId) !== null;
    },
  };
}

/** Register the provider; returns the cleanup for the extension's list. */
export function registerFloatingRangeObjectSelection(): () => void {
  return registerObjectSelectionProvider(createFloatingRangeSelectionProvider());
}
