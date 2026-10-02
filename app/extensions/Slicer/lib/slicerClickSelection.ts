//! FILENAME: app/extensions/Slicer/lib/slicerClickSelection.ts
// PURPOSE: What a click does to a slicer's selection -- pure, so a QUEUED
//          click (slicerStore.queueSlicerClick) computes it from the selection
//          the previous click COMMITTED, not from the one on screen when the
//          mouse went down. Computed at click time, a Ctrl+click toggle issued
//          while the previous click was still applying read the old selection
//          and dropped the item that click had just added.

import type { Slicer, SlicerItem } from "./slicerTypes";

/** The new selection (null = every item, no filter), or `undefined` when the
 *  click changes nothing and must write nothing (a write would record an
 *  undo step that changes nothing). */
export type SlicerSelectionChange = string[] | null | undefined;

/**
 * A click on one item. The slicer's selectionMode decides:
 * - "standard": click = exclusive, Ctrl+click = toggle
 * - "single": click = exclusive only, Ctrl+click ignored
 * - "multi": click = toggle (like Ctrl+click in standard mode)
 *
 * `items` is the slicer's item list; without one a toggle cannot tell "all
 * but this one", so the click is ignored (as it always was).
 */
export function selectionAfterItemClick(
  slicer: Pick<Slicer, "selectedItems" | "selectionMode" | "forceSelection">,
  items: readonly SlicerItem[] | undefined,
  itemValue: string,
  ctrlHeld: boolean,
): SlicerSelectionChange {
  if (!items) return undefined;
  const mode = slicer.selectionMode ?? "standard";
  const isToggle = mode === "multi" || (mode === "standard" && ctrlHeld);

  if (isToggle) {
    if (slicer.selectedItems === null) {
      // All selected -> deselect this one item (select all except this one).
      return items.map((i) => i.value).filter((v) => v !== itemValue);
    }
    if (slicer.selectedItems.includes(itemValue)) {
      const next = slicer.selectedItems.filter((v) => v !== itemValue);
      if (next.length === 0) {
        // Force selection: the last item cannot be deselected. Otherwise
        // deselecting the last one selects all (clears the filter).
        return slicer.forceSelection ? undefined : null;
      }
      return next;
    }
    const next = [...slicer.selectedItems, itemValue];
    // Every item selected is no filter at all.
    return next.length >= items.length ? null : next;
  }

  // Exclusive: only this item.
  if (
    slicer.selectedItems !== null &&
    slicer.selectedItems.length === 1 &&
    slicer.selectedItems[0] === itemValue
  ) {
    // Clicking the only selected item again selects all (clears the filter),
    // unless the slicer forces a selection.
    return slicer.forceSelection ? undefined : null;
  }
  return [itemValue];
}

/** Clear the filter (the Clear button, Select All, the context menu): a
 *  slicer that filters nothing is left alone. */
export function selectionAfterClear(slicer: Pick<Slicer, "selectedItems">): SlicerSelectionChange {
  return slicer.selectedItems === null ? undefined : null;
}

/**
 * Whether a slicer carries a filter -- the ONE predicate the renderer (the
 * clear button lit or dimmed), the zone answer (the clear button is content
 * or header) and the button's release all read (BUG-0258 design D9, the
 * timeline's `isTimelineFiltered` precedent).
 */
export function isSlicerFiltered(slicer: Pick<Slicer, "selectedItems">): boolean {
  return slicer.selectedItems !== null;
}

/**
 * A DRAG across items (BUG-0258 design phase 4, owner decision D4): `values`
 * is the run the drag covered, in the order the pointer swept it -- the LAST
 * value is the item under the release. The slicer's selectionMode decides:
 * - "standard": a plain drag selects exactly the run; Ctrl+drag (`additive`)
 *   ADDS the run to the selection (never toggles: a run is not a click);
 * - "single": the item the button was released on, alone (Ctrl is ignored,
 *   as it is for a click);
 * - "multi": the run is added (a click there toggles, a drag adds).
 *
 * FROM AN UNFILTERED SLICER (`selectedItems` null: every item shows
 * selected) an ADDING run -- Ctrl+drag, or any drag in 'multi' -- selects
 * exactly the run, as a plain drag does. Adding to "every item" is every item:
 * the drag would write nothing and show nothing while the button is held, and
 * the user cannot have meant that; "a drag across items selects the run" is
 * the grammar's sentence. (A CLICK there still toggles its item OFF:
 * `selectionAfterItemClick`. Fixer decision after the M7 review, refining D4;
 * flagged to the owner beside D4 in docs/design/canvas-sheets.md section 2c.)
 *
 * A result that selects every item is no filter at all (null). A result equal
 * to the current selection is `undefined`: nothing is written, so no undo step
 * that changes nothing. Values the item list does not hold are ignored, and
 * without an item list nothing happens (the click's rule).
 *
 * The drag's preview paints exactly this (`selectionShownDuringRun`), so what
 * the user sees while the button is held is what the release commits.
 */
export function selectionAfterItemRun(
  slicer: Pick<Slicer, "selectedItems" | "selectionMode">,
  items: readonly SlicerItem[] | undefined,
  values: readonly string[],
  additive: boolean,
): SlicerSelectionChange {
  if (!items) return undefined;
  const known = new Set(items.map((i) => i.value));
  const run = values.filter((v) => known.has(v));
  if (run.length === 0) return undefined;
  const mode = slicer.selectionMode ?? "standard";

  let chosen: Set<string>;
  if (mode === "single") {
    chosen = new Set([run[run.length - 1]]);
  } else if ((mode === "multi" || additive) && slicer.selectedItems !== null) {
    chosen = new Set(slicer.selectedItems);
    for (const v of run) chosen.add(v);
  } else {
    // A plain drag -- or an adding one from an unfiltered slicer (above).
    chosen = new Set(run);
  }

  // In the item list's order, so the stored selection reads like the slicer.
  const next = items.map((i) => i.value).filter((v) => chosen.has(v));
  const result = next.length >= known.size ? null : next;
  return sameSelection(slicer.selectedItems, result) ? undefined : result;
}

/**
 * The selection a live (or landing) drag PAINTS: what its release would
 * commit, or the current selection when that commits nothing.
 */
export function selectionShownDuringRun(
  slicer: Pick<Slicer, "selectedItems" | "selectionMode">,
  items: readonly SlicerItem[] | undefined,
  values: readonly string[],
  additive: boolean,
): string[] | null {
  const next = selectionAfterItemRun(slicer, items, values, additive);
  return next === undefined ? slicer.selectedItems : next;
}

/** Two selections name the same items (order ignored; null = every item). */
function sameSelection(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}
