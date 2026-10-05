//! FILENAME: app/extensions/BuiltIn/HomeTab/components/groupPieces.ts
// PURPOSE: Split a Home group's items into what HomeTabGroupComponent draws, IN
//          LAYOUT ORDER: each hero alone, each run of the items between heroes
//          as one two-row ControlGrid.
// CONTEXT: Kept out of the component file so that file exports only its
//          component (React Fast Refresh), and so the split can be tested as
//          data. See HomeTabGroupComponent's header for why the order is the
//          layout's and not "heroes first".

import { ITEMS_BY_ID, isMultiInstanceItem } from "../homeTabConfig";

/** One piece of a group, in layout order: a hero, or a run of the items
 *  between heroes (row breaks included) that becomes one ControlGrid. */
export type GroupPiece =
  | { kind: "hero"; id: string; index: number }
  | { kind: "run"; entries: Array<{ id: string; index: number }> };

/**
 * Split a group's items into pieces IN LAYOUT ORDER. A run holding nothing
 * but row breaks (a break right before a hero, say) paints no control, so it
 * is dropped rather than drawn as an empty grid. Ids the catalog does not
 * know are dropped here too -- renderItem would draw nothing for them, and
 * they must not split a run in two.
 */
export function groupPieces(itemIds: readonly string[]): GroupPiece[] {
  const pieces: GroupPiece[] = [];
  let run: Array<{ id: string; index: number }> = [];
  const flush = () => {
    if (run.some((e) => !isMultiInstanceItem(ITEMS_BY_ID.get(e.id)))) {
      pieces.push({ kind: "run", entries: run });
    }
    run = [];
  };
  itemIds.forEach((id, index) => {
    const item = ITEMS_BY_ID.get(id);
    if (!item) return;
    if (item.hero) {
      flush();
      pieces.push({ kind: "hero", id, index });
    } else {
      run.push({ id, index });
    }
  });
  flush();
  return pieces;
}
