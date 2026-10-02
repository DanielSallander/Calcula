//! FILENAME: app/extensions/Controls/lib/buttonPress.ts
// PURPOSE: A press on a RUN-MODE floating button RUNS IT WHEN IT IS RELEASED
//          inside the button (BUG-0258 design phase 4c, the owner's answer
//          "on release, and sliding off cancels; moving still needs Design
//          Mode") -- the standard Windows button rule.
// CONTEXT: A run-mode button is CONTENT in the control's one zone answer
//          (controlZoneAt.ts), so Core hands the press to
//          `floatingObject:bodyDragStart` (part 'button') and never moves the
//          button from it. The press used to RUN the button at once, from
//          `floatingObject:selected` (Controls/index.ts `handleFloatingSelected`):
//          a press the user meant to take back could not be, and a drag that
//          happened to start on a button ran its macro.
//
//          THE RULES THIS FILE KEEPS:
//            - The press only ARMS: the button shows PRESSED (the renderer asks
//              `isFloatingButtonPressed`), nothing runs.
//            - The pressed look follows the pointer: on while it is INSIDE the
//              button, off while it is outside (sliding back in presses it
//              again), as a Windows button does.
//            - The release runs `run()` ONCE, and only INSIDE: the release point
//              is on the button's rectangle AND the button is the topmost
//              floating object there (`topFloatingRegionAtClient`), so a release
//              over an object stacked on top of the button runs nothing.
//            - Escape, a window blur, a move with the primary button UP (a
//              release this page never heard), a release of ANOTHER button with
//              the primary one up (a middle press arms a press too: Core hands
//              every non-secondary press over), the next press and the
//              extension's deactivation end the press with NOTHING run.
//            - While the press is held it holds Core's pointer over the button
//              (`holdContentGestureCursor`, the slicer and timeline gestures'
//              seam), released on EVERY end path: no grip shows and no resize
//              handle answers under a held button, and the button keeps its
//              hand (BUG-0258 M7 review).
//            - The window listeners live only as long as the press.
//          WHAT RUNS is the caller's (Controls/index.ts): the `button:clicked`
//          hook and `runFloatingButtonClick` -- the M4 click path with its
//          macro link, application approval and audit gates -- unchanged, only
//          later. A secondary press never gets here: Core returns before any
//          dispatch for button 2 (overlayMoveHandlers.ts).

import { holdContentGestureCursor, requestOverlayRedraw, topFloatingRegionAtClient } from "@api/gridOverlays";

/** A run-mode button press, as Controls' bodyDragStart listener hands it over. */
export interface FloatingButtonPress {
  /** The floating control's id (the store's and the renderer's key). */
  controlId: string;
  /** Its published region id (the hit test's answer at the release). */
  regionId: string;
  /** What a click on the button does; called once, at a release inside it. */
  run: () => void;
}

interface Session {
  controlId: string;
  regionId: string;
  run: () => void;
  /** Is the pointer inside the button (the pressed look)? */
  inside: boolean;
  /** Lets go of Core's pointer this press holds (every end path runs it). */
  releaseCursor: () => void;
}

let session: Session | null = null;

/** Whether the release point is INSIDE the button: on it, and nothing floating on top of it there. */
function insideAt(regionId: string, clientX: number, clientY: number): boolean {
  return topFloatingRegionAtClient(clientX, clientY)?.id === regionId;
}

/**
 * Start a press on a run-mode button. It never runs anything: the release
 * inside the button does. A press still live (its release was never heard) is
 * cancelled first.
 */
export function beginFloatingButtonPress(press: FloatingButtonPress): void {
  cancelFloatingButtonPress();
  session = {
    controlId: press.controlId,
    regionId: press.regionId,
    run: press.run,
    inside: true,
    releaseCursor: holdContentGestureCursor(press.regionId, "pointer"),
  };
  window.addEventListener("mousemove", onPressMove);
  window.addEventListener("mouseup", onPressUp);
  window.addEventListener("keydown", onPressKey, true);
  window.addEventListener("blur", onPressBlur);
  requestOverlayRedraw();
}

/** Is this button showing PRESSED (a press on it is held, and the pointer is inside)? */
export function isFloatingButtonPressed(controlId: string): boolean {
  return session !== null && session.controlId === controlId && session.inside;
}

/** Whether a button press is held at all (inside or not). */
export function isFloatingButtonPressActive(): boolean {
  return session !== null;
}

/** End a live press WITHOUT running it (Escape, blur, a lost release, deactivation). */
export function cancelFloatingButtonPress(): void {
  if (endPress()) requestOverlayRedraw();
}

function endPress(): Session | null {
  const s = session;
  if (!s) return null;
  session = null;
  s.releaseCursor();
  window.removeEventListener("mousemove", onPressMove);
  window.removeEventListener("mouseup", onPressUp);
  window.removeEventListener("keydown", onPressKey, true);
  window.removeEventListener("blur", onPressBlur);
  return s;
}

const onPressMove = (e: MouseEvent): void => {
  if (!session) return;
  // The press exists only while the primary button is HELD: a move with it up
  // means its release was never heard. Nothing runs.
  if ((e.buttons & 1) === 0) {
    cancelFloatingButtonPress();
    return;
  }
  const inside = insideAt(session.regionId, e.clientX, e.clientY);
  if (inside !== session.inside) {
    session.inside = inside;
    requestOverlayRedraw();
  }
};

const onPressUp = (e: MouseEvent): void => {
  if (!session) return;
  if (e.button !== 0) {
    // Another button let go. With the primary one still held (`buttons` bit
    // 1) the press goes on; with it up this was never a primary press -- a
    // MIDDLE press arms one too -- and it ends here, running nothing, rather
    // than staying pressed until the pointer happens to move.
    if ((e.buttons & 1) === 0) cancelFloatingButtonPress();
    return;
  }
  const s = endPress();
  if (!s) return;
  requestOverlayRedraw();
  // Released INSIDE the button it was pressed on, or nothing runs.
  if (!insideAt(s.regionId, e.clientX, e.clientY)) return;
  s.run();
};

const onPressKey = (e: KeyboardEvent): void => {
  if (!session || e.key !== "Escape") return;
  // The Escape is the press's: nothing else acts on it too.
  e.preventDefault();
  e.stopPropagation();
  cancelFloatingButtonPress();
};

const onPressBlur = (): void => {
  cancelFloatingButtonPress();
};
