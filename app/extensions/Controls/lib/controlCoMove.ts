//! FILENAME: app/extensions/Controls/lib/controlCoMove.ts
// PURPOSE: Where the controls a control-led drag CO-MOVES go (the rest of the
//          selection and the dragged control's group), frame by frame.
// CONTEXT: Controls moves its own multi-selection along with a dragged member
//          (`coMovesOwnSelection`, so a canvas group drag leaves them to it).
//          It used to add each frame's INCREMENT to every member's current
//          position and clamp it at 0 -- so on a canvas a member was pushed off
//          the page that a Core-led group drag of the very same selection kept
//          it on, a locked member moved, and a member pushed against an edge
//          and brought back ended up displaced (the clamp ate part of one
//          increment and the next one did not give it back).
//
//          Now the drag SNAPSHOTS every member's rect when it begins, and each
//          frame places a member at its press-time rect shifted by the lead's
//          TOTAL (snapped) move, through the seam's one co-move rule
//          (`coMovedMemberRect`, @api/objectGeometry): kept on the page, a
//          locked member stays put, and off a page the old clamp at 0.

import { coMovedMemberRect, type ObjectRect } from "@api/objectGeometry";
import type { GridRegion } from "@api/gridOverlays";

/** One drag's press-time picture: the lead and every member's rect then. */
export interface ControlDragSnapshot {
  leadId: string;
  /** Every control the drag moves, the lead included, by id. */
  rects: ReadonlyMap<string, ObjectRect>;
}

/**
 * Snapshot the rects of `ids` (the lead among them) as the drag begins. A
 * control `rectOf` does not know is left out.
 */
export function snapshotControlDrag(
  leadId: string,
  ids: Iterable<string>,
  rectOf: (id: string) => ObjectRect | null,
): ControlDragSnapshot {
  const rects = new Map<string, ObjectRect>();
  for (const id of ids) {
    const r = rectOf(id);
    if (r) rects.set(id, { x: r.x, y: r.y, width: r.width, height: r.height });
  }
  return { leadId, rects };
}

/**
 * Where every co-moved control (every member but the lead) goes when the lead
 * now sits at `leadNow`: its press-time rect shifted by the lead's total move,
 * placed by `coMovedMemberRect` on `sheetIndex`'s surface. `regionOf` names a
 * member's published region for the lock check (null: not locked). Returns an
 * empty map when the snapshot has no lead rect.
 */
export function coMovedControlPositions(
  snapshot: ControlDragSnapshot,
  leadNow: { x: number; y: number },
  sheetIndex: number,
  regionOf: (id: string) => GridRegion | null,
): Map<string, ObjectRect> {
  const out = new Map<string, ObjectRect>();
  const leadStart = snapshot.rects.get(snapshot.leadId);
  if (!leadStart) return out;
  const delta = { dx: leadNow.x - leadStart.x, dy: leadNow.y - leadStart.y };
  for (const [id, from] of snapshot.rects) {
    if (id === snapshot.leadId) continue;
    out.set(id, coMovedMemberRect(sheetIndex, from, delta, regionOf(id)));
  }
  return out;
}
