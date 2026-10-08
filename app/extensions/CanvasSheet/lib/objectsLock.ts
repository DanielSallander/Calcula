//! FILENAME: app/extensions/CanvasSheet/lib/objectsLock.ts
// PURPOSE: LOCK OBJECTS for a whole page (Power BI's View > Lock objects: "Lock
//          all objects on the canvas so that they can't be moved or resized"),
//          as the UI enforces it -- and the ONE sentence that tells the user
//          why a move did nothing.
// CONTEXT: The authority is the backend: `CanvasLayout::objects_locked`
//          (core/persistence, rust-canvas lane) refuses every geometry write on
//          a locked page, from every door -- the UI, a script, the CLI, the AI.
//          The UI's job is to not OFFER a move it knows will be refused, and to
//          say so when the user tries one anyway:
//            - the layout surface answers LOCKED for every object while it is
//              on (lib/canvasLocks.ts `isFixedOnLayout`), so Core arms no drag,
//              paints no grip and no resize handle -- the exact treatment a
//              per-object Lock already gets;
//            - align / distribute / the nudge / a group drag skip immovable
//              objects (lib/arrange.ts `isArrangeMovable`);
//            - the Arrange group disables Align; Size & Position still opens,
//              READ-ONLY, and says the PAGE is locked (the surface's
//              `pageLockedReason`, which @api/objectPosition shows instead of
//              the per-object "unlock it");
//            - a drag ATTEMPT (a frame press that travels past Core's click
//              threshold) and a nudge keystroke are told, in ONE toast.
//
//          WHAT STAYS ALLOWED, as the backend has it (and Power BI's wording,
//          which names moving and resizing only): selecting, formatting,
//          restacking, the per-object Lock, inserting -- and DELETING. The
//          contract asked for delete to be refused too; it is not, on purpose,
//          see the canvas-tab lane report: the backend and the @api reader
//          (`canvasObjectsLocked`, "deletable") allow it, and the UI has no
//          feature-neutral door to refuse a family's own Delete without also
//          refusing a floating grid's "clear this cell" -- the same key, the
//          same command, one family's choice.
//
//          ONE TOAST PER GESTURE. A held arrow key auto-repeats thirty times a
//          second and a drag fires a mousemove per pixel; a toast per event
//          would bury the page. The notice is said once and then stays quiet
//          while attempts keep coming: the quiet window SLIDES, measured from
//          the last ATTEMPT (told or not), so a key held for ten seconds is
//          one toast, and a fresh gesture after OBJECTS_LOCKED_NOTICE_MS of
//          calm is told again.
//
//          NOT ON A SUBSCRIBED PAGE. A pulled report page is the publisher's
//          layout and not the reader's to edit at all, lock or no lock, and
//          the Lock Objects toggle is disabled for them -- so the notice, which
//          says "turn Lock Objects off", is never said there (the drag notice
//          asks the surface; the nudge never gets this far on a page that is
//          not editable).
//
//          The drag notice listens to the grid area element for the life of
//          one locked press only (see installObjectsLockedNotice).

import { showToast } from "@api/notifications";
import { getGridStateSnapshot } from "@api/grid";
import { canvasObjectsLocked } from "@api/canvasSheet";
import { canvasAt, isSubscribedCanvas } from "./canvasSheetStore";

/**
 * Why nothing moved. It names the menu path the backend's own refusal names
 * ("Canvas > View > Lock Objects", app/src-tauri/src/sheets.rs), so the toast
 * and a refused script say the same thing.
 */
export const OBJECTS_LOCKED_NOTE =
  "The objects on this page are locked (Canvas > View > Lock Objects), so they cannot be moved or resized. Turn Lock Objects off to move them.";

/** How long the notice stays quiet after the last attempt, in ms (a sliding window). */
export const OBJECTS_LOCKED_NOTICE_MS = 2000;

/** Core's click-vs-drag dead zone, in logical px (the marquee's threshold). */
const DRAG_THRESHOLD_PX = 3;

/** The event Core dispatches for every press on an object (its frame or its content). */
const OBJECT_PRESS_EVENT = "floatingObject:selected";

/** When an attempt was last made (told or not): the sliding quiet window. */
let lastAttemptAt = Number.NEGATIVE_INFINITY;

/** Whether the canvas at `index` has Lock Objects on (false for a worksheet). */
export function canvasObjectsLockedAt(index: number): boolean {
  const entry = canvasAt(index);
  return entry !== null && canvasObjectsLocked(entry.layout);
}

/** Whether the sheet ON SCREEN is a canvas whose objects are locked. */
export function activeCanvasObjectsLocked(): boolean {
  const state = getGridStateSnapshot();
  if (!state || state.surface !== "canvas") return false;
  return canvasObjectsLockedAt(state.sheetContext?.activeSheetIndex ?? 0);
}

/**
 * Whether the lock notice is the RIGHT thing to say on the sheet on screen: a
 * locked canvas the user may edit. On a subscribed page the reader cannot
 * turn the lock off, and nothing there is theirs to move anyway (see the
 * header), so the notice would be wrong advice.
 */
function lockNoticeApplies(): boolean {
  if (!activeCanvasObjectsLocked()) return false;
  const index = getGridStateSnapshot()?.sheetContext?.activeSheetIndex ?? 0;
  return !isSubscribedCanvas(index);
}

/** Tell the user the page's objects are locked -- once per gesture (see the header). */
export function tellObjectsLocked(): void {
  const now = Date.now();
  const quiet = now - lastAttemptAt < OBJECTS_LOCKED_NOTICE_MS;
  // Every attempt extends the window, told or not: an auto-repeating key
  // never lets it lapse, so the whole hold is one toast.
  lastAttemptAt = now;
  if (quiet) return;
  showToast(OBJECTS_LOCKED_NOTE, { variant: "info" });
}

/** Test hook: forget when the notice was last shown. */
export function resetObjectsLockedNotice(): void {
  lastAttemptAt = Number.NEGATIVE_INFINITY;
}

/**
 * Listen for a DRAG attempt on a locked page: a press on an object's frame
 * (Core's object-press event with zone "frame") followed by a primary-button
 * move past the click threshold. Core has already refused to arm the move (the
 * surface said locked); this only explains it. A press on an object's CONTENT
 * (a slicer item, a run-mode button, a floating grid's cell) is not a drag of
 * the object and is never told. Returns the cleanups.
 *
 * The moves are heard on the GRID AREA element (data-grid-area, where Core
 * measures every press), bound for the one gesture and dropped at its
 * release -- never as a page-wide key or pointer listener, which would be a
 * new door for the census in app/src/core/lib/globalInputListeners.ts. A drag
 * that leaves the grid area first is simply not told.
 */
export function installObjectsLockedNotice(): Array<() => void> {
  let detachSession: (() => void) | null = null;

  const onObjectPress = (e: Event): void => {
    detachSession?.();
    const d = (e as CustomEvent<{ zone?: string; canvasX?: number; canvasY?: number }>).detail ?? {};
    if (d.zone === "content") return;
    if (!lockNoticeApplies()) return;
    if (typeof d.canvasX !== "number" || typeof d.canvasY !== "number") return;
    const area = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-grid-area]");
    if (!area) return;
    const start = { x: d.canvasX, y: d.canvasY };
    // Core's press point is in LOGICAL canvas px (relative to the grid area,
    // divided by the zoom); a move is converted the same way before the
    // threshold is measured.
    const toCanvas = (ev: MouseEvent): { x: number; y: number } => {
      const rect = area.getBoundingClientRect();
      const zoom = getGridStateSnapshot()?.zoom || 1;
      return { x: (ev.clientX - rect.left) / zoom, y: (ev.clientY - rect.top) / zoom };
    };
    const onMove = (ev: MouseEvent): void => {
      // A move with the button up: the release was never heard. Done.
      if ((ev.buttons & 1) === 0) {
        detach();
        return;
      }
      const p = toCanvas(ev);
      if (Math.abs(p.x - start.x) > DRAG_THRESHOLD_PX || Math.abs(p.y - start.y) > DRAG_THRESHOLD_PX) {
        detach();
        tellObjectsLocked();
      }
    };
    const onUp = (): void => detach();
    const detach = (): void => {
      area.removeEventListener("mousemove", onMove);
      area.removeEventListener("mouseup", onUp);
      if (detachSession === detach) detachSession = null;
    };
    area.addEventListener("mousemove", onMove);
    area.addEventListener("mouseup", onUp);
    detachSession = detach;
  };

  window.addEventListener(OBJECT_PRESS_EVENT, onObjectPress);
  return [
    () => window.removeEventListener(OBJECT_PRESS_EVENT, onObjectPress),
    () => detachSession?.(),
  ];
}
