//! FILENAME: app/extensions/Controls/lib/controlZoneAt.ts
// PURPOSE: The floating control's `zoneAt` (BUG-0258 design phases 2 and 4c):
//          the ONE answer Core derives the press, the hover pointer and the
//          meaning of Ctrl/Shift from (@api/gridOverlays `resolveFloatingZone`).
// CONTEXT: A RUN-MODE button is CONTENT, with a hand: a click on it is the
//          button's, not the frame's. It is published `movable: false` outside
//          Design Mode (lib/floatingStore.ts), so it cannot be moved, and as
//          content Core hands its press to `floatingObject:bodyDragStart` (part
//          'button') -- where the press only arms, and the button RUNS AT THE
//          RELEASE inside it (lib/buttonPress.ts); sliding off cancels. It stays
//          content on a locked object and a subscribed page: running a report's
//          button is using the report, not editing it.
//
//          A PAGE NAVIGATOR (WP-B, D-NAV) answers per point: in run mode an
//          ITEM is content with a hand and part `navItem:<key>` (its press
//          navigates at the release over the same item, PageNavigator/
//          navigatorPress.ts), and the space between items is content with the
//          plain pointer and part `navGap` (a press there does nothing -- it is
//          not the frame either, so a reader's stray press never selects the
//          navigator). In Design Mode the whole navigator is FRAME (Core selects
//          and moves it), carrying the item part on `floatingObject:selected`
//          for the second-press item selection.
//
//          Everything else answers null -- whole-body FRAME: a Design-Mode
//          button (selected and moved; moving a button still needs Design
//          Mode), a shape and a picture show Core's 'move', or 'default' where
//          they are locked or on a subscribed page.
//
//          PURE: it reads the region's published data and the navigator's
//          read-only description (`describePageNavigatorView` fetches nothing,
//          writes nothing, dispatches nothing).

import type { OverlayZoneFn } from "@api/gridOverlays";
import type { ContainerRegion } from "@api/visualContainerPaint";
import { PAGE_NAVIGATOR_CONTROL_TYPE } from "@api/buttonControlService";
import { describePageNavigatorView } from "../PageNavigator/describe";
import { NAV_GAP_PART, navItemPart, navigatorItemAt } from "../PageNavigator/navigatorModel";

export const floatingControlZoneAt: OverlayZoneFn = (ctx) => {
  const data = ctx.region.data;
  if (data?.controlType === PAGE_NAVIGATOR_CONTROL_TYPE) {
    const box = ctx.floatingCanvasBounds;
    const { props, items } = describePageNavigatorView(ctx.region.id);
    const area = { regionId: ctx.region.id, container: (ctx.region as ContainerRegion).container };
    const item = box ? navigatorItemAt(box, items, props, { x: ctx.canvasX, y: ctx.canvasY }, area) : null;
    const part = item ? navItemPart(item.key) : NAV_GAP_PART;
    if (data.movable === false) {
      return item
        ? { kind: "content", cursor: "pointer", part }
        : { kind: "content", cursor: "default", part };
    }
    return { kind: "frame", part };
  }
  if (data?.controlType === "button" && data.movable === false) {
    return { kind: "content", cursor: "pointer", part: "button" };
  }
  return null;
};
