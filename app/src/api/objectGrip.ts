//! FILENAME: app/src/api/objectGrip.ts
// PURPOSE: The GRIP seam for extensions (BUG-0258 design phase 5): the event
//          Core dispatches when a floating object's six-dot grip is CLICKED,
//          and its detail.
// CONTEXT: Core owns the grip entirely: it decides when it shows
//          (core/lib/floatingGrip.ts `floatingGripShown`), paints it, moves the
//          object when it is dragged, and dispatches FLOATING_GRIP_CLICK_EVENT
//          on a click (button 0: a press released within the move threshold)
//          or on a right-click that no family's own context menu claimed
//          (button 2). What a click MEANS is a feature: the grip's menu, led by
//          Size and Position (the no-drag route WCAG 2.2 SC 2.5.7 requires),
//          listens here and anchors itself at the detail's `anchor`. Nothing
//          here is on @api/index.ts; import it as "@api/objectGrip".
//
//          WHOSE point a client point is -- a visible grip's object included --
//          is @api/gridOverlays' question (`topFloatingRegionAtClient`, grip-
//          aware through Core's probe: plan decision D6), and whether another
//          object covers a point before a given one is
//          `isFloatingRegionCoveredAtClient`. A grip-only client-point door
//          that once stood here (`floatingGripAtClient`) had no consumer and
//          was removed (M7 review): a consumer door with no consumer is a
//          contract nobody exercises.
//
//          A family's own `floatingObject:selected` listener sees a grip press
//          as a FRAME press with `part: "grip"`: it selects (and may move) the
//          object and must never act -- no pending click, no filter, no run.

import {
  FLOATING_GRIP_CLICK_EVENT,
  type FloatingGripAnchor,
  type FloatingGripClickDetail,
} from "../core/lib/floatingGrip";

export { FLOATING_GRIP_CLICK_EVENT };
export type { FloatingGripAnchor, FloatingGripClickDetail };
