//! FILENAME: app/extensions/BuiltIn/ObjectPane/lib/objectPanePolicy.ts
// PURPOSE: WHEN the object pane opens, follows and closes by itself (D-PANE).
// CONTEXT: The owner's rule, kept narrow on purpose:
//
//            1. AUTO-OPEN only on a CANVAS page, at the RELEASE of a press on
//               an object that did not MOVE (a click). Never on a worksheet
//               (there the pane opens only through a door), never on the grip
//               (a grip press is a move handle), never on a Ctrl/Shift press
//               (that edits the selection set), never for an object whose
//               family says a press must not open it (a run-mode button or page
//               navigator: `opensOnPress`). "Moved" is a move or resize that
//               completed OR pointer travel past Core's drag threshold
//               (OBJECT_DRAG_THRESHOLD_PX) -- a drag-select across a pivot's
//               cells or a slicer item drag completes no move, and must open
//               nothing either. The decision is deferred one task after the
//               mouseup so objectSelection's own press finish and every
//               family's release handler have run, and it needs the object to
//               still be the PRIMARY selected object.
//            2. KEYBOARD selection (Tab) and every other selection change only
//               RETARGET an open pane ("follow", keeping the tab when the new
//               object offers it), or close it when nothing with a pane is
//               selected. A closed pane is never opened from here; only the
//               "object" context key follows the selection, so View > Show can
//               list the pane.
//            3. View > Show "Object pane" (`taskpane:requestReopen`) is a door.
//            4. File > New / Open closes the pane and drops Core's painted
//               container layouts (@api/visualContainerPaint).
//
//          The pointer listeners are SESSION-SCOPED (the global input census,
//          app/src/core/lib/globalInputListeners.ts): bound by an object press
//          Core already filtered, removed at its release or by the next press.
//          They only observe the pointer and decide whether the release opens
//          the pane; they never preventDefault and write nothing.

import { AppEvents, onAppEvent } from "@api/events";
import { getGridRegions, onRegionChange } from "@api/gridOverlays";
import { getGridStateSnapshot } from "@api/grid";
import {
  OBJECT_DRAG_THRESHOLD_PX,
  getPrimaryObjectRegion,
  isObjectInSelection,
  onObjectSelectionChanged,
} from "@api/objectSelection";
import {
  OBJECT_PANE_ID,
  closeObjectPane,
  getObjectPaneProvider,
  getObjectPaneState,
  openObjectPane,
} from "@api/objectPane";
import { endObjectFormatPreview } from "@api/objectFormat";
import { resetPaintedContainerLayouts } from "@api/visualContainerPaint";
import { addTaskPaneContextKey, onTaskPaneStateChange, removeTaskPaneContextKey } from "@api/ui";
import { pressMayOpen, reconcileWithTaskPane } from "./objectPaneHost";

/** The detail Core's `floatingObject:selected` carries (the fields this file reads). */
interface SelectedDetail {
  regionId?: unknown;
  part?: unknown;
  ctrlKey?: unknown;
  shiftKey?: unknown;
}

/** One armed press: its object, the pointer travel, and how it ends. */
interface PressArm {
  regionId: string;
  originX: number | null;
  originY: number | null;
  moved: boolean;
  released: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
}

let arm: PressArm | null = null;

/**
 * Keep the pane in step with the object selection (rule 2). The census
 * reconciliation for the "object" context key (cascadeAnnouncementCensus):
 * every family's delete deselects through its provider and announces the
 * selection change, and this is what takes the pane and the key down.
 */
export function syncObjectPaneToSelection(): void {
  const primary = getPrimaryObjectRegion();
  const withPane = primary && getObjectPaneProvider(primary) ? primary : null;
  const state = getObjectPaneState();

  if (state.open) {
    if (!withPane) {
      closeObjectPane();
      removeTaskPaneContextKey("object");
      return;
    }
    if (withPane.id !== state.regionId) {
      // Retarget in place. Refused only when no provider answers any more.
      if (!openObjectPane({ region: withPane, reason: "follow" })) {
        closeObjectPane();
        removeTaskPaneContextKey("object");
      }
    }
    return;
  }

  if (withPane) addTaskPaneContextKey("object");
  else removeTaskPaneContextKey("object");
}

/** End the armed press: finish it now if its release already came, else forget it. */
function settleArm(): void {
  const a = arm;
  if (!a) return;
  if (a.released) {
    finishArm(a);
    return;
  }
  a.detach();
  arm = null;
}

/** The deferred release decision (rule 1). */
function finishArm(a: PressArm): void {
  if (arm !== a) return;
  a.detach();
  arm = null;
  if (a.moved) return;
  const primary = getPrimaryObjectRegion();
  if (!primary || primary.id !== a.regionId) return;
  if (!isObjectInSelection(primary)) return;
  openObjectPane({ region: primary, reason: "press" });
}

function armPress(regionId: string): void {
  const a: PressArm = {
    regionId,
    originX: null,
    originY: null,
    moved: false,
    released: false,
    timer: null,
    detach: () => {},
  };
  const onMove = (e: MouseEvent): void => {
    if (typeof e.clientX !== "number" || typeof e.clientY !== "number") return;
    // The selected event carries canvas coordinates, not the pointer's: the
    // first move after the press is the origin the travel is measured from.
    if (a.originX === null || a.originY === null) {
      a.originX = e.clientX;
      a.originY = e.clientY;
      return;
    }
    if (
      Math.abs(e.clientX - a.originX) > OBJECT_DRAG_THRESHOLD_PX ||
      Math.abs(e.clientY - a.originY) > OBJECT_DRAG_THRESHOLD_PX
    ) {
      a.moved = true;
    }
  };
  const onGeometryDone = (): void => {
    a.moved = true;
  };
  const onUp = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    a.released = true;
    // One task later: objectSelection's press finish, Core's moveComplete and
    // every family's release handler have run by then.
    a.timer = setTimeout(() => finishArm(a), 0);
  };
  a.detach = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("floatingObject:moveComplete", onGeometryDone);
    window.removeEventListener("floatingObject:resizeComplete", onGeometryDone);
    if (a.timer !== null) clearTimeout(a.timer);
    a.timer = null;
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("floatingObject:moveComplete", onGeometryDone);
  window.addEventListener("floatingObject:resizeComplete", onGeometryDone);
  arm = a;
}

/**
 * Core's `floatingObject:selected` (a press on an object, already filtered by
 * Core: primary button, not a reference pick). Arms the release decision when
 * the press may open the pane (rule 1). Exported for the unit tier.
 */
export function handleObjectPress(event: Event): void {
  // A new press settles the previous one first (its listeners are removed).
  settleArm();
  const d = (event as CustomEvent<SelectedDetail>).detail;
  if (!d || typeof d.regionId !== "string") return;
  if (d.part === "grip") return;
  if (d.ctrlKey === true || d.shiftKey === true) return;
  if (getGridStateSnapshot()?.surface !== "canvas") return;
  const region = getGridRegions().find((r) => r.id === d.regionId);
  if (!region) return;
  const provider = getObjectPaneProvider(region);
  if (!provider || !pressMayOpen(provider, region)) return;
  armPress(region.id);
}

function handleRequestReopen(event: Event): void {
  const d = (event as CustomEvent<{ viewId?: unknown }>).detail;
  if (d?.viewId !== OBJECT_PANE_ID) return;
  openObjectPane({ reason: "command" });
}

function handleDocumentReset(): void {
  settleArm();
  endObjectFormatPreview();
  closeObjectPane();
  removeTaskPaneContextKey("object");
  resetPaintedContainerLayouts();
}

/**
 * The open pane's object vanished from the published regions (deleted, its
 * sheet left). Checked one task later, so a family re-publishing its regions
 * in two steps does not close the pane in between.
 */
let vanishTimer: ReturnType<typeof setTimeout> | null = null;
function handleRegionsChanged(): void {
  if (vanishTimer !== null) return;
  if (!getObjectPaneState().open) return;
  vanishTimer = setTimeout(() => {
    vanishTimer = null;
    const s = getObjectPaneState();
    if (!s.open || !s.regionId) return;
    if (getGridRegions().some((r) => r.id === s.regionId)) return;
    closeObjectPane();
    syncObjectPaneToSelection();
  }, 0);
}

/** Install the policy (the extension's activate). Returns the cleanup. */
export function installObjectPanePolicy(): () => void {
  const cleanups: Array<() => void> = [];

  window.addEventListener("floatingObject:selected", handleObjectPress);
  cleanups.push(() => window.removeEventListener("floatingObject:selected", handleObjectPress));

  cleanups.push(onObjectSelectionChanged(syncObjectPaneToSelection));

  window.addEventListener("taskpane:requestReopen", handleRequestReopen);
  cleanups.push(() => window.removeEventListener("taskpane:requestReopen", handleRequestReopen));

  cleanups.push(onAppEvent(AppEvents.AFTER_NEW, handleDocumentReset));
  cleanups.push(onAppEvent(AppEvents.AFTER_OPEN, handleDocumentReset));

  cleanups.push(onRegionChange(handleRegionsChanged));
  cleanups.push(onTaskPaneStateChange(reconcileWithTaskPane));

  // The key follows whatever is selected when the pane arrives.
  syncObjectPaneToSelection();

  return () => {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        cleanups[i]();
      } catch (err) {
        console.error("[ObjectPane] policy cleanup failed:", err);
      }
    }
    if (arm) {
      arm.detach();
      arm = null;
    }
    if (vanishTimer !== null) {
      clearTimeout(vanishTimer);
      vanishTimer = null;
    }
  };
}
