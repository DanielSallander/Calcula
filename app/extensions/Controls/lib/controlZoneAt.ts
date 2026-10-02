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
//          Everything else answers null -- whole-body FRAME: a Design-Mode
//          button (selected and moved; moving a button still needs Design
//          Mode), a shape and a picture show Core's 'move', or 'default' where
//          they are locked or on a subscribed page. PURE: it reads the region's
//          published data only.

import type { OverlayZoneFn } from "@api/gridOverlays";

export const floatingControlZoneAt: OverlayZoneFn = (ctx) => {
  const data = ctx.region.data;
  if (data?.controlType === "button" && data.movable === false) {
    return { kind: "content", cursor: "pointer", part: "button" };
  }
  return null;
};
