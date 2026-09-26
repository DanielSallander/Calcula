//! FILENAME: app/extensions/Controls/lib/controlGeometry.ts
// PURPOSE: Controls' provider for the `@api/objectGeometry` seam -- move and
//          resize floating controls (buttons, shapes, pictures, text boxes)
//          for a caller that is NOT a pointer gesture: the canvas's align /
//          distribute, its arrow-key nudge, and a group drag that carries a
//          control along with another family's object -- plus the ONE batch
//          every geometry persist of this extension goes through.
// CONTEXT: A control's geometry used to be persisted as four to six
//          `set_control_property` calls per control (x, y, width, height, and
//          a pinned control's offsets), none of them undoable. The backend's
//          `set_control_geometry` takes a whole BATCH: one snapshot, one write,
//          ONE undo record (joining an open transaction), atomic -- refused
//          whole, with nothing written, when a control is on a protected sheet
//          that disallows editing objects.
//
//          The store holds the pixels; `recalcPinnedOffset` re-derives a pinned
//          control's offset from its anchor after every move, so a later
//          row/column resize replays where the user actually put it.
//
//          REFUSAL. The batch is atomic, so a refused commit changed nothing on
//          the backend: the provider puts every control back where the change
//          says it was (`from`, else the region's geometry at the call) and
//          then rejects -- the seam's revert contract; the seam tells the user
//          once for the whole arrange.
//
//          Controls co-moves its OWN multi-selection (and group members) when
//          one of its controls is dragged, so a canvas group drag led by a
//          control leaves the other selected controls to it.

import type { ObjectGeometryChange, ObjectGeometryProvider, ObjectRect } from "@api/objectGeometry";
import type { ControlGeometryChange } from "./types";
import { FLOATING_CONTROL_REGION_TYPE } from "./controlHitTest";
import {
  getFloatingControl,
  recalcPinnedOffset,
  resizeFloatingControl,
  syncFloatingControlRegions,
} from "./floatingStore";
import { setControlGeometry } from "./controlApi";

/** A cell's top-left in sheet px (the extension owns row/column geometry). */
export type CellOrigin = (row: number, col: number) => { x: number; y: number };

/**
 * The `set_control_geometry` batch for the controls' CURRENT store geometry:
 * pixel x / y / width / height, plus both offsets for a pinned control (the
 * backend requires both or neither). Unknown ids are skipped.
 */
export function controlGeometryChangesOf(controlIds: readonly string[]): ControlGeometryChange[] {
  const out: ControlGeometryChange[] = [];
  const seen = new Set<string>();
  for (const id of controlIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ctrl = getFloatingControl(id);
    if (!ctrl) continue;
    const change: ControlGeometryChange = {
      sheetIndex: ctrl.sheetIndex,
      row: ctrl.row,
      col: ctrl.col,
      x: ctrl.x,
      y: ctrl.y,
      width: ctrl.width,
      height: ctrl.height,
    };
    if (ctrl.pinToGrid === true) {
      change.offsetX = ctrl.offsetX ?? 0;
      change.offsetY = ctrl.offsetY ?? 0;
    }
    out.push(change);
  }
  return out;
}

/** The side effects a geometry change needs, injected by activate(). */
export interface ControlGeometryDeps {
  /** Where a cell starts (for a pinned control's offset). */
  cellOrigin: CellOrigin;
  /** A control's cached raster was drawn at the old size; drop it. */
  invalidate: (controlId: string) => void;
  /** Repaint the grid. */
  refresh: () => void;
  /** After a batch landed: tell the Properties pane to re-read the metadata. */
  afterPersist?: (controlIds: readonly string[]) => void;
}

/** Apply rects to the store (a pinned control's offset re-derived). Returns the ids moved. */
function applyToStore(
  entries: ReadonlyArray<{ id: string; rect: ObjectRect }>,
  deps: ControlGeometryDeps,
): string[] {
  const ids: string[] = [];
  for (const { id, rect } of entries) {
    const ctrl = getFloatingControl(id);
    if (!ctrl) continue;
    const resized = ctrl.width !== rect.width || ctrl.height !== rect.height;
    resizeFloatingControl(id, rect.x, rect.y, rect.width, rect.height);
    recalcPinnedOffset(id, deps.cellOrigin);
    if (resized) deps.invalidate(id);
    ids.push(id);
  }
  return ids;
}

/** Build the provider registered for region type "floating-control". */
export function createControlGeometryProvider(deps: ControlGeometryDeps): ObjectGeometryProvider {
  return {
    types: [FLOATING_CONTROL_REGION_TYPE],
    coMovesOwnSelection: true,

    preview(changes: readonly ObjectGeometryChange[]): void {
      const ids = applyToStore(
        changes.map((c) => ({ id: c.region.id, rect: c })),
        deps,
      );
      if (ids.length === 0) return;
      syncFloatingControlRegions();
      deps.refresh();
    },

    async commit(changes: readonly ObjectGeometryChange[]): Promise<void> {
      const ids = applyToStore(
        changes.map((c) => ({ id: c.region.id, rect: c })),
        deps,
      );
      if (ids.length === 0) return;
      syncFloatingControlRegions();
      deps.refresh();
      const batch = controlGeometryChangesOf(ids);
      try {
        await setControlGeometry(batch);
      } catch (err) {
        // Atomic refusal: nothing was written, so where each control WAS is
        // exactly what the backend holds.
        applyToStore(
          changes
            .map((c) => ({ id: c.region.id, rect: c.from ?? c.region.floating }))
            .filter((e): e is { id: string; rect: ObjectRect } => !!e.rect),
          deps,
        );
        syncFloatingControlRegions();
        deps.refresh();
        throw err instanceof Error ? err : new Error(String(err));
      }
      deps.afterPersist?.(ids);
    },
  };
}
