//! FILENAME: app/extensions/Animation/overlay/playOverlay.ts
// PURPOSE: Install / remove the Animation play pill — the floating transport
//          shown while a driver is loaded.
// MODEL: a DOM overlay registered through @api/ui's overlay registry, shown and
//   hidden from the playback engine's own state (frameCount > 0). It occupies NO
//   grid coordinates and registers NO grid region, which is the whole point of
//   the change: the previous version anchored a hit-testable 172x26 floating
//   GRID REGION at a fixed sheet position, so it sat on top of A1:C2 and ate
//   cell clicks (open-decisions-2026-08.md §2q / D4). See PlayPill.tsx for the
//   placement rationale.
//
// A NOTE ON WHY THE ENGINE, NOT THE OVERLAY REGISTRY, IS THE SOURCE OF TRUTH:
//   the overlay registry has a generic `onClose` (it hides the overlay). Hiding
//   the pill while a driver is still loaded would recreate the old defect in a
//   worse form — an animation running with no visible way to stop it — so the
//   pill's close button unloads the DRIVER (`clearDriver`), and the overlay
//   disappears as a consequence of the engine state changing. There is exactly
//   one lever, and it is the product's.

import { registerOverlay, unregisterOverlay, showOverlay, hideOverlay } from "@api/ui";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { PlayPill } from "./PlayPill";

export const PLAY_PILL_OVERLAY_ID = "animation.playPill";

/**
 * Install the viewport-pinned play control. Returns a cleanup function that
 * hides the pill, drops the engine subscription and unregisters the overlay.
 */
export function installPlayOverlay(): () => void {
  registerOverlay({
    id: PLAY_PILL_OVERLAY_ID,
    component: PlayPill,
    layer: "popover",
  });

  // Visible exactly while a driver is loaded. `subscribe` fires immediately with
  // the current state, so a driver loaded before install (e.g. an extension
  // reload mid-playback) still shows the pill.
  let visible = false;
  const sync = (s: EngineState): void => {
    const show = s.frameCount > 0;
    if (show === visible) return;
    visible = show;
    if (show) showOverlay(PLAY_PILL_OVERLAY_ID, {});
    else hideOverlay(PLAY_PILL_OVERLAY_ID);
  };
  const unsubscribe = playbackEngine.subscribe(sync);

  return () => {
    unsubscribe();
    if (visible) {
      hideOverlay(PLAY_PILL_OVERLAY_ID);
      visible = false;
    }
    unregisterOverlay(PLAY_PILL_OVERLAY_ID);
  };
}
