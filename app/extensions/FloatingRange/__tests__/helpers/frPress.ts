//! FILENAME: app/extensions/FloatingRange/__tests__/helpers/frPress.ts
// PURPOSE: ONE mirror of what Core does with a press, a release and a hover
//          over a floating range, for the FloatingRange unit tier. Every test
//          that presses a range goes through `pressInCoreOrder`, so the zone
//          migration (M5 T5b) changed the BODY of this file and nothing else
//          in the tests that use it (bar the one deliberate pointer change).
// CONTEXT: Extension tests may not import src/core (the facade rule has no test
//          exemption), so Core's order is mirrored here and pinned on Core's
//          side by src/core/hooks/useMouseSelection/layout/__tests__/overlayZones.test.ts
//          (the zone order: zoneAt ONCE, before noteObjectPress and
//          floatingObject:selected) and overlayPressParity.test.ts (the canvas
//          press). A change to Core's order changes both, or one of them is lying.
//
//          THE ZONE ORDER (overlayMoveHandlers.ts `pressZone`, for a
//          registration that answers zoneAt -- the range does since M5 T5b):
//            1. the zone is resolved ONCE (resolveFloatingZone -> frZoneAt),
//               before anything selects, from the state the user pressed on;
//            2. floatingObject:selected {regionId, regionType, data, zone,
//               part, canvasX, canvasY, ctrl/shift -- false on content};
//            3. content: floatingObject:bodyDragStart {..., part, the RAW
//               ctrl/shift}, and Core never moves the object;
//            4. frame: Core arms a MOVE when the object can move, otherwise
//               the press only selects.
//          The canvas-only noteObjectPress is not mirrored: these tests press on
//          a worksheet, where Core skips it.
//
//          A REFERENCE PICK (D-PICK) is Core's: while a formula expects a
//          reference Core asks `referenceAt` before any zone, inserts the
//          reference itself and dispatches neither press event (pinned by
//          overlayReferencePick.test.ts). `pressInCoreOrder` deliberately does
//          NOT mirror that branch: a press driven through it during a pick is
//          the old order, and what it proves is the range's SECOND line (its
//          handlers refuse on the shared predicate). The HOVER does mirror it
//          (`hoverCursorLikeCore`): the pointer is what a user sees.

import {
  resolveFloatingZone,
  contentGestureCursorFor,
  referenceAtPoint,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { isFormulaReferencePickActive, getExternalFormulaTarget } from "@api/editing";

/**
 * What Core made of a press:
 *   'content' -- the range owns the press (Core dispatched bodyDragStart and
 *                never moves the object);
 *   'move'    -- Core owns it and a drag MOVES the object;
 *   'select'  -- Core owns it, but the object cannot move: the press only
 *                selects (an immovable, locked or subscribed object).
 */
export type CorePressOutcome = "content" | "move" | "select";

export interface PressModifiers {
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** The mousedown half of a press over a floating range, in Core's order. */
export function pressInCoreOrder(
  ctx: OverlayHitTestContext,
  mods: PressModifiers = {},
): CorePressOutcome {
  const region = ctx.region;
  const ctrlKey = mods.ctrlKey === true;
  const shiftKey = mods.shiftKey === true;

  // ONE zone answer, before the press selects anything.
  const zone = resolveFloatingZone(ctx);
  const content = zone.kind === "content";

  window.dispatchEvent(
    new CustomEvent("floatingObject:selected", {
      detail: {
        regionId: region.id,
        regionType: region.type,
        data: region.data,
        zone: zone.kind,
        part: zone.part,
        canvasX: ctx.canvasX,
        canvasY: ctx.canvasY,
        ctrlKey: content ? false : ctrlKey,
        shiftKey: content ? false : shiftKey,
      },
    }),
  );

  if (content) {
    window.dispatchEvent(
      new CustomEvent("floatingObject:bodyDragStart", {
        detail: {
          regionId: region.id,
          regionType: region.type,
          data: region.data,
          canvasX: ctx.canvasX,
          canvasY: ctx.canvasY,
          part: zone.part,
          ctrlKey,
          shiftKey,
        },
      }),
    );
    return "content";
  }

  return zone.canMove ? "move" : "select";
}

/** The release: Core's and every family's window mouseup. */
export function releaseLikeCore(clientX = 0, clientY = 0): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX, clientY }));
}

/** A press and its release at the same point. */
export function clickInCoreOrder(
  ctx: OverlayHitTestContext,
  mods: PressModifiers = {},
): CorePressOutcome {
  const outcome = pressInCoreOrder(ctx, mods);
  releaseLikeCore(ctx.canvasX, ctx.canvasY);
  return outcome;
}

/**
 * A CLICK during a reference pick, as Core plays it (D-PICK): Core asks the
 * object's `referenceAt` (never the zone), dispatches neither press event, and
 * at the release routes the picked cell -- for an object-space pick with an
 * external editor expecting a reference (a floating grid's cell editor, its
 * formula-bar view), `insertReference({ sheetName: <object name>, ... })`
 * (core useSpreadsheetSelection `handleFloatingReferencePick`). 'inert' where
 * `referenceAt` names nothing.
 *
 * Only that route is mirrored -- the one the floating grid's EDIT tests need.
 * The grid editor's route and the sheet space are Core's own tests
 * (floatingReferencePickRouting.test.tsx); asking this mirror for them throws
 * rather than pretending.
 */
export function pickClickInCoreOrder(ctx: OverlayHitTestContext): "picked" | "inert" {
  if (!isFormulaReferencePickActive()) throw new Error("pickClickInCoreOrder: no formula is picking a reference");
  const pick = referenceAtPoint(ctx);
  if (!pick) {
    releaseLikeCore(ctx.canvasX, ctx.canvasY);
    return "inert";
  }
  if (pick.space !== "object") throw new Error("pickClickInCoreOrder mirrors object-space picks only");
  const target = getExternalFormulaTarget();
  if (!target?.isExpectingReference()) {
    throw new Error("pickClickInCoreOrder mirrors the external editor's route only");
  }
  // Core's pick session listens to the release in the CAPTURE phase, so the
  // insertion lands before any family's own window mouseup hears it.
  target.insertReference({
    sheetName: pick.name,
    startRow: pick.row,
    startCol: pick.col,
    endRow: pick.row,
    endCol: pick.col,
  });
  releaseLikeCore(ctx.canvasX, ctx.canvasY);
  return "picked";
}

/**
 * The pointer Core shows over `ctx` (overlayMoveHandlers `checkOverlayBody`): a
 * live content gesture's held pointer; else, during a reference pick, 'cell'
 * where the object's `referenceAt` names a cell and 'default' where a press
 * would be inert; else the zone's (resolveFloatingZone).
 */
export function hoverCursorLikeCore(ctx: OverlayHitTestContext): string {
  const held = contentGestureCursorFor(ctx.region.id);
  if (held !== null) return held;
  if (isFormulaReferencePickActive()) return referenceAtPoint(ctx) ? "cell" : "default";
  return resolveFloatingZone(ctx).cursor;
}
