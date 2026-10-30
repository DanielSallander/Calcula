//! FILENAME: app/extensions/Controls/lib/controlSideState.ts
// PURPOSE: The id-keyed state this extension keeps BESIDE the floating store --
//          a shape's renderer, html, frame and hit rectangles, its script badge,
//          the properties its script declared, a control's resolved container --
//          and how it follows a row/column edit, on the sheet on screen AND on
//          a sheet the user is not looking at.
// CONTEXT: A control's id IS its anchor cell (`control-{sheet}-{row}-{col}`,
//          floatingStore.ts), and the backend re-keys a control that moves with
//          its cells, together with its object script's binding, on EVERY
//          structural route (structure.rs `shift_controls`) -- the off-sheet one
//          a script's or the command line's `sheetIndex` takes included. On the
//          sheet on screen the floating store re-anchors and its `onRename`
//          hook carries this state along (index.ts, 6c). An edit on another
//          sheet announces STRUCTURAL_EDIT_ELSEWHERE instead, and the store
//          holds one sheet only, so until round 7 nothing re-keyed this state
//          there: a scripted shape on Log came back without its renderer, html
//          or declared properties after `api.insertRows(r, n, "Log")`, and the
//          state stayed filed under the dead id, where a control that later
//          landed on that cell would have painted it. No re-read can fix that --
//          this state is the frontend's own -- so the announced edits are
//          replayed here, on the side state's ids, with the same mapping and the
//          same rename order the store uses.

import { AppEvents, onAppEvent } from "@api/events";
import type { StructuralEditElsewhereEdit, StructuralEditElsewherePayload } from "@api/events";
import { structuralAnchorShift } from "@api/scriptHost/embeddedFormPlacements";
import { applyRenamesVacatedFirst, makeFloatingControlId, parseFloatingControlId } from "./floatingStore";
import {
  migrateShapeInstanceId,
  removeCustomCanvasRenderer,
  removeShapeHtmlOverlay,
  shapeStateIds,
  unmarkShapeHasScript,
} from "../Shape/shapeRenderer";
import { shapeHitRegionIds } from "../Shape/shapeHitRegions";
import { clearDeclaredProperties, declaredPropertyIds, migrateDeclaredProperties } from "../Shape/shapeProperties";
import { controlContainerIds, forgetControlContainer, migrateControlContainer } from "./controlContainer";
import { getAllControls } from "./controlApi";

/** What a re-key does to the side state of one control. */
export interface ControlSideStateHooks {
  /** The control's anchor moved: everything filed under `oldId` moves to `newId`. */
  onRename: (oldId: string, newId: string) => void;
  /** The control's row or column was deleted, and the control with it: release its state. */
  onRemove: (id: string) => void;
}

/**
 * THE migration, for both routes. The on-screen route passes it to
 * `reanchorFloatingControls`; the off-sheet route below applies it to the ids
 * it finds. One list, so a new id-keyed table is added to both at once.
 */
export const CONTROL_SIDE_STATE_HOOKS: ControlSideStateHooks = {
  onRename: (oldId, newId) => {
    // A scripted pinned shape otherwise loses its renderer/HTML content and
    // leaks its iframe under the old id.
    migrateShapeInstanceId(oldId, newId);
    migrateDeclaredProperties(oldId, newId);
    migrateControlContainer(oldId, newId);
  },
  onRemove: (id) => {
    removeShapeHtmlOverlay(id);
    removeCustomCanvasRenderer(id);
    clearDeclaredProperties(id);
    forgetControlContainer(id);
    // The backend clears a dropped control's script binding (`shift_controls`).
    unmarkShapeHasScript(id);
  },
};

/** Every control id some side table holds right now, on any sheet. */
export function controlSideStateIds(): Set<string> {
  return new Set<string>([
    ...shapeStateIds(),
    ...shapeHitRegionIds(),
    ...declaredPropertyIds(),
    ...controlContainerIds(),
  ]);
}

/** `"row,col"` -- how a held anchor is looked up. */
function anchorKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * The anchors on `sheetIndex` whose control HOLDS ITS PLACE when the grid moves
 * under it, read from the backend: Rust's `controls::moves_with_cells` is false
 * exactly when the control's `pinToGrid` property is the text "false" (an
 * absent or unreadable value MOVES). A structural edit never moves such a
 * control and never drops it, so the answer is the same before and after the
 * edit -- which is what lets it be read after the edit landed.
 */
export async function readHeldAnchors(sheetIndex: number): Promise<Set<string>> {
  const held = new Set<string>();
  for (const entry of await getAllControls(sheetIndex)) {
    if (entry.metadata.properties?.pinToGrid?.value === "false") held.add(anchorKey(entry.row, entry.col));
  }
  return held;
}

/**
 * Re-key the side state of ONE sheet for one structural edit, without the
 * floating store: every id filed under `sheetIndex` is mapped by `shift`
 * unless its anchor `holdsPlace` -- `null` releases it (`onRemove`), a new
 * anchor renames it (`onRename`), in the store's order (removals first, then
 * renames with vacated destinations first, `applyRenamesVacatedFirst`).
 *
 * An id no control owns any more (state leaked by an older defect) is mapped
 * the same way: the backend has nothing at that anchor to disagree with.
 * Returns true when anything was re-keyed or released.
 */
export function reanchorSideStateOnSheet(
  sheetIndex: number,
  shift: (row: number, col: number) => { row: number; col: number } | null,
  holdsPlace: (row: number, col: number) => boolean,
  hooks: ControlSideStateHooks = CONTROL_SIDE_STATE_HOOKS,
): boolean {
  const ids = controlSideStateIds();
  const occupied = new Set(ids);
  const renames: Array<{ oldId: string; newId: string }> = [];
  let changed = false;
  for (const id of ids) {
    const at = parseFloatingControlId(id);
    if (at === null || at.sheetIndex !== sheetIndex) continue;
    if (holdsPlace(at.row, at.col)) continue;
    const moved = shift(at.row, at.col);
    if (moved === null) {
      // Released BEFORE any rename lands: a control shifting onto this anchor
      // (a delete pulls the rows below up) moves into an empty slot.
      hooks.onRemove(id);
      occupied.delete(id);
      changed = true;
      continue;
    }
    if (moved.row === at.row && moved.col === at.col) continue;
    renames.push({ oldId: id, newId: makeFloatingControlId(sheetIndex, moved.row, moved.col) });
  }
  applyRenamesVacatedFirst(renames, occupied, (r) => {
    hooks.onRename(r.oldId, r.newId);
    changed = true;
  });
  return changed;
}

/** Does any side table hold an id on `sheetIndex`? (No backend read when it does not.) */
function hasSideStateOnSheet(sheetIndex: number): boolean {
  for (const id of controlSideStateIds()) {
    if (parseFloatingControlId(id)?.sheetIndex === sheetIndex) return true;
  }
  return false;
}

/**
 * Follow every insert/delete made on a sheet the user is NOT looking at: replay
 * the announced edits (`StructuralEditElsewherePayload.edits`, in order) on the
 * side state filed under that sheet's ids.
 *
 * `enqueue` is the extension's structural queue, so these re-keys and the
 * on-screen ones are applied in the order they were heard. `afterChange` runs
 * once per announcement that changed anything (invalidate the bitmaps, repaint).
 * The floating store is NOT touched: it holds the sheet on screen, which an
 * off-sheet edit did not move -- and when the user has since switched to the
 * edited sheet, the store was loaded from the backend AFTER the edit and is
 * already right.
 *
 * Returns the unsubscribe.
 */
export function followStructuralEditsElsewhere(deps: {
  enqueue: (task: () => Promise<void>) => void;
  afterChange: () => void;
  readHeldAnchors?: (sheetIndex: number) => Promise<ReadonlySet<string>>;
}): () => void {
  const read = deps.readHeldAnchors ?? readHeldAnchors;
  return onAppEvent<StructuralEditElsewherePayload | null>(AppEvents.STRUCTURAL_EDIT_ELSEWHERE, (detail) => {
    const edits = detail?.edits;
    if (!Array.isArray(edits)) return;
    // A floating grid's own lines (sheet null) anchor no control.
    const onSheets = edits.filter(
      (e): e is StructuralEditElsewhereEdit & { sheetIndex: number } => typeof e?.sheetIndex === "number",
    );
    if (onSheets.length === 0) return;
    deps.enqueue(async () => {
      const heldBySheet = new Map<number, ReadonlySet<string>>();
      let changed = false;
      for (const edit of onSheets) {
        if (!hasSideStateOnSheet(edit.sheetIndex)) continue;
        let held = heldBySheet.get(edit.sheetIndex);
        if (held === undefined) {
          held = await read(edit.sheetIndex);
          heldBySheet.set(edit.sheetIndex, held);
        }
        const holds = held;
        if (
          reanchorSideStateOnSheet(
            edit.sheetIndex,
            structuralAnchorShift(edit.kind, edit.at, edit.count),
            (row, col) => holds.has(anchorKey(row, col)),
          )
        ) {
          changed = true;
        }
      }
      if (changed) deps.afterChange();
    });
  });
}
