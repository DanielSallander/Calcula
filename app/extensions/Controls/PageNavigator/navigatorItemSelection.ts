//! FILENAME: app/extensions/Controls/PageNavigator/navigatorItemSelection.ts
// PURPOSE: Design Mode's second rung on a Page Navigator: ONE ITEM of an
//          already-selected navigator is selected by a second press, the
//          chart-ladder model (WP-B, D-NAV, S7).
// CONTEXT: A first press selects the WHOLE navigator (Controls/index.ts
//          `handleFloatingSelected`, as for any control). A plain second press
//          on the navigator that was already selected ARMS an item click here;
//          the item is selected at the release, and only when the press was a
//          CLICK on that item:
//            1. the release, mapped into canvas space by
//               `floatingControlCanvasPoint`, is within NAV_CLICK_SLOP_PX of
//               the press on both axes;
//            2. the item under the release is the item under the press (a gap
//               press selects "no item" -- the whole navigator again);
//            3. no `floatingObject:moveComplete` for this region arrived.
//          The session measures the drag ITSELF because Core reports a drag only
//          for an ARMED move: on a Lock Objects page, a subscribed page or any
//          region whose zone says `canMove === false`, Core arms no move, so no
//          moveComplete ever comes -- and a 40 px drag there must not select
//          an item. When a move IS armed, Core's capture-phase mouseup
//          dispatches moveComplete before this file's bubble-phase mouseup
//          runs, and condition 3 agrees with condition 1.
//
//          THE SELECTION IS STATE, NEVER A WRITE: nothing here touches the
//          backend, the document or the undo stack. It is cleared when its
//          navigator stops being selected (any path: a cell click, Tab, the
//          canvas Escape, a Ctrl+click toggle), when its page leaves the list,
//          on a sheet reload, when Design Mode ends and on deactivation.
//
//          ESCAPE CLIMBS ONE RUNG: while an item is selected Controls'
//          object-selection provider owns "Escape" (lib/controlObjectSelection.ts),
//          so the canvas's capture-phase Escape binding leaves the key alone,
//          and the session `keydown` bound here (only while an item is
//          selected) clears the ITEM; the navigator stays selected. The next
//          Escape is not owned and deselects the navigator as today. Delete,
//          Tab, the arrows and the clipboard keys are never owned: they act on
//          the WHOLE navigator, which is the one object.
//
//          Window listeners: one `mouseup` + one `floatingObject:moveComplete`
//          per armed click (removed at that release, at a moveComplete, at the
//          next arm, at `cancelNavigatorItemClick` and on deactivation), and one
//          `keydown` only while an item is selected. Both input listeners are
//          rows of the global input listener census (src/core/lib/globalInputListeners.ts).

import { requestOverlayRedraw } from "@api/gridOverlays";
import { isGridFocused } from "@api/keybindings";
import { onObjectSelectionChanged } from "@api/objectSelection";
import { onReportPagesChanged } from "@api/reportPages";
import { isFloatingControlSelected } from "../Button/floatingSelection";
import { floatingControlCanvasPoint } from "../lib/controlHitTest";
import { describePageNavigatorView } from "./describe";
import { navigatorItemAt } from "./navigatorModel";
import { getControlContainer } from "../lib/controlContainer";

/** The item selected inside a navigator (Design Mode's second rung). */
export interface SelectedNavigatorItem {
  /** The navigator's control id (the floating store's key, = its region id). */
  controlId: string;
  /** The item's key (`navigatorItemKey`: the sheet id, or `name:<name>`). */
  itemKey: string;
}

/**
 * Core's click slop (`overlayMoveHandlers.ts`, `Math.abs(delta) > 3` starts a
 * move), restated ONCE here for the one gesture Core does not measure for us:
 * a press on an object Core arms no move for.
 */
export const NAV_CLICK_SLOP_PX = 3;

type SelectionListener = (selected: SelectedNavigatorItem | null) => void;

let selected: SelectedNavigatorItem | null = null;
const listeners = new Set<SelectionListener>();
let escapeBound = false;

/** The selected navigator item, or null (no navigator has an item selected). */
export function getSelectedNavigatorItem(): SelectedNavigatorItem | null {
  return selected;
}

/**
 * Select one item of navigator `next.controlId`, or none (`null`). Notifies the
 * listeners and repaints only on a real change. Binds the Escape climb while an
 * item is selected and unbinds it when none is.
 */
export function setSelectedNavigatorItem(next: SelectedNavigatorItem | null): void {
  const normal =
    next && typeof next.controlId === "string" && next.controlId !== "" && typeof next.itemKey === "string" && next.itemKey !== ""
      ? Object.freeze({ controlId: next.controlId, itemKey: next.itemKey })
      : null;
  if (normal === null && selected === null) return;
  if (normal && selected && normal.controlId === selected.controlId && normal.itemKey === selected.itemKey) return;
  selected = normal;
  syncEscapeBinding();
  for (const listener of [...listeners]) {
    try {
      listener(selected);
    } catch (err) {
      console.error("[Controls] A navigator item selection listener failed:", err);
    }
  }
  requestOverlayRedraw();
}

/** Subscribe to item selection changes. Returns the unsubscribe. */
export function onSelectedNavigatorItemChange(cb: SelectionListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ============================================================================
// The Escape climb (bound only while an item is selected)
// ============================================================================

const onEscapeKey = (e: KeyboardEvent): void => {
  if (e.key !== "Escape" || selected === null) return;
  // Escape typed into the Properties pane (a caption being edited) is that
  // field's; only the GRID's Escape climbs the ladder.
  if (!isGridFocused()) return;
  setSelectedNavigatorItem(null);
};

function syncEscapeBinding(): void {
  if (selected !== null && !escapeBound) {
    window.addEventListener("keydown", onEscapeKey);
    escapeBound = true;
  } else if (selected === null && escapeBound) {
    window.removeEventListener("keydown", onEscapeKey);
    escapeBound = false;
  }
}

// ============================================================================
// The armed second press
// ============================================================================

interface ArmedClick {
  controlId: string;
  itemKey: string | null;
  press: { x: number; y: number };
}

let armed: ArmedClick | null = null;

const onArmedMoveComplete = (e: Event): void => {
  if (!armed) return;
  const detail = (e as CustomEvent).detail as { regionId?: unknown } | undefined;
  // The navigator was DRAGGED: a move is never a click.
  if (detail?.regionId === armed.controlId) cancelNavigatorItemClick();
};

const onArmedMouseUp = (e: MouseEvent): void => {
  const click = armed;
  cancelNavigatorItemClick();
  if (!click || e.button !== 0) return;
  // A press whose navigator is no longer selected (Core narrowed a
  // multi-selection, a script deselected it) selects no item of it.
  if (!isFloatingControlSelected(click.controlId)) return;
  const at = floatingControlCanvasPoint(click.controlId, e.clientX, e.clientY);
  if (!at) return;
  if (Math.abs(at.point.x - click.press.x) > NAV_CLICK_SLOP_PX) return;
  if (Math.abs(at.point.y - click.press.y) > NAV_CLICK_SLOP_PX) return;
  const { props, items } = describePageNavigatorView(click.controlId);
  const area = { regionId: click.controlId, container: getControlContainer(click.controlId) };
  const under = navigatorItemAt(at.bounds, items, props, at.point, area)?.key ?? null;
  if (under !== click.itemKey) return;
  setSelectedNavigatorItem(click.itemKey ? { controlId: click.controlId, itemKey: click.itemKey } : null);
};

/**
 * Arm a Design-Mode second press on navigator `controlId`, which was already
 * selected when the press came. `itemKey` is the item under the press (null on
 * a gap); `pressCanvas` is the press point in canvas space (the zone context's
 * canvasX / canvasY that `floatingObject:selected` carries). At the release the
 * item is selected only when all three conditions in the file header hold;
 * otherwise nothing is selected and nothing is written.
 */
export function armNavigatorItemClick(
  controlId: string,
  itemKey: string | null,
  pressCanvas: { x: number; y: number },
): void {
  cancelNavigatorItemClick();
  armed = { controlId, itemKey, press: { x: pressCanvas.x, y: pressCanvas.y } };
  window.addEventListener("mouseup", onArmedMouseUp);
  window.addEventListener("floatingObject:moveComplete", onArmedMoveComplete);
}

/** Drop an armed second press without selecting anything. */
export function cancelNavigatorItemClick(): void {
  if (!armed) return;
  armed = null;
  window.removeEventListener("mouseup", onArmedMouseUp);
  window.removeEventListener("floatingObject:moveComplete", onArmedMoveComplete);
}

// ============================================================================
// Lifetime
// ============================================================================

/**
 * Keep the item selection honest for the extension's life: drop it when its
 * navigator leaves the Controls selection, and when its page leaves the
 * navigator's list. Returns the cleanup, which also cancels an armed click and
 * clears the selection (deactivation).
 */
export function startNavigatorItemSelection(): () => void {
  const offSelection = onObjectSelectionChanged(() => {
    if (selected && !isFloatingControlSelected(selected.controlId)) setSelectedNavigatorItem(null);
  });
  const offPages = onReportPagesChanged(() => {
    if (!selected) return;
    const { controlId, itemKey } = selected;
    if (!describePageNavigatorView(controlId).items.some((item) => item.key === itemKey)) {
      setSelectedNavigatorItem(null);
    }
  });
  return () => {
    offSelection();
    offPages();
    resetNavigatorItemSelection();
  };
}

/** Cancel an armed click and clear the selection, notifying (deactivation, tests). */
export function resetNavigatorItemSelection(): void {
  cancelNavigatorItemClick();
  setSelectedNavigatorItem(null);
}
