//! FILENAME: app/src/core/components/Spreadsheet/gridPointerEntry.ts
// PURPOSE: The grid's OUTERMOST pointer entries — everything `S.GridArea`'s
//          `onMouseDown` and `onDoubleClick` do before any grid gesture is
//          chosen.
// CONTEXT: This is the single door. `wrappedMouseDown` (Spreadsheet.tsx) →
//          `handleMouseDown` (useSpreadsheetSelection.ts: fill handle, cell
//          click interceptors) → `handleMouseDown` (useMouseSelection.ts:
//          resize, overlay move, formula refs, headers, cells). Two of those
//          three layers call `preventDefault()` on paths of their own, so a
//          rule that has to stop the grid from taking a press CANNOT live in
//          the innermost one: the fill-handle branch preventDefaults before it
//          is ever reached, and the interceptor branch acts on the cell under
//          the pointer. It lives here, at the DOM binding, where nothing
//          downstream can be got round.
//
//          Extracted from Spreadsheet.tsx so the door itself is testable
//          without mounting the grid — the same reason every handler below it
//          is a factory taking its dependencies.
//
// ===========================================================================
// THE CENSUS OF CORE'S DOORS — every entry that can ACT on a gesture, and what
// was decided about it. Taken 2026-09-04, when the claim went from ONE door to
// all of them. If you add a door, add a row.
// ===========================================================================
//
// On `S.GridArea` (Spreadsheet.tsx ~1399-1414), the element every on-grid
// surface is stacked INSIDE:
//
//   onMouseDown   GUARDED  `gridPointerMouseDown`, below. The original door.
//                          It is also where the grid TAKES THE KEYBOARD back
//                          (`gridShouldTakeKeyboardFocus`), because it is the
//                          only place that knows the grid accepted the press.
//   onDoubleClick GUARDED  `gridPointerDoubleClick`, below. NEW — it is bound
//                          to the same element but is NOT reached through
//                          mousedown, so the first guard did nothing for it.
//   onMouseMove   NOT GUARDED, deliberately. It cannot START anything: it
//                          continues a gesture that began at a mousedown the
//                          claim already refused, or paints a hover cursor.
//                          Guarding it would FREEZE a legitimate drag the
//                          moment the pointer crossed a claimed card — the user
//                          drag-selecting a range past an on-grid form.
//   onMouseUp     NOT GUARDED, and this one is load-bearing. It TERMINATES a
//                          gesture. A claim check here strands a drag that
//                          began in the grid and was released over a card: the
//                          selection would keep following the mouse with no
//                          button held. "Whoever started the gesture ends it."
//   onWheel       NOT GUARDED, deliberately. An anchored card scrolls WITH the
//                          sheet; taking the wheel would pin it in place while
//                          the cells it is anchored to slid away.
//   onContextMenu NOT GUARDED, deliberately, and the pointer rule exempts the
//                          secondary button for the same reason: an object's
//                          own right-click menu depends on this, and the
//                          orphaned-form remedy is "right-click and pick a grid
//                          menu item". A claimant that could take the secondary
//                          button could trap the user in its own rectangle.
//
// Downstream of `onDoubleClick`, and a door although it is not a DOM binding —
// it is where Core hands a gesture to EXTENSION code:
//
//   overlay       GUARDED  `handleOverlayDoubleClick`
//   onDoubleClick          (hooks/useMouseSelection/layout/overlayMoveHandlers.ts).
//                          A double-click that lands on a floating overlay is
//                          offered to that overlay's owner through
//                          `OverlayRegistration.onDoubleClick` (@api/gridOverlays)
//                          — the only seam that can reach an extension over a
//                          floating object, since the cell double-click
//                          interceptors are asked about a CELL and there is none
//                          here. It re-checks `isPointerClaimed` itself rather
//                          than inheriting the door's answer, because it is a new
//                          actor on the gesture; and it ALSO refuses an
//                          INPUT/TEXTAREA/SELECT/contentEditable target, which the
//                          claim cannot see: an on-canvas cell editor (the
//                          Floating Range's own <textarea>) carries no claim
//                          attribute yet sits inside the overlay's rect, so
//                          without it a double-click on a word being edited would
//                          be re-offered to the overlay as a fresh double-click on
//                          the cell underneath. Neither guard preventDefaults.
//
// On `S.SpreadsheetContainer` (the focus container, one level up):
//
//   onKeyDown     GUARDED  `useSpreadsheetEditing.handleContainerKeyDown`.
//                          NEW — opens the cell editor on a printable key and
//                          moves the active cell on Enter.
//   keydown       GUARDED  `useGridKeyboard`, a NATIVE listener on the same
//                          element. NEW — and the one that lost data:
//                          `onDelete` is clear-contents over the selection.
//
// Window/document listeners, all HARMLESS and none guarded:
//
//   useMouseSelection.ts ~1044/~1170  mouseup/mousemove, registered only while
//                          a drag is in flight — i.e. only after an unclaimed
//                          mousedown started one. Same reasoning as the React
//                          move/up above, and the same regression if guarded.
//   useMouseSelection.ts ~1062        capture-phase `mousedown` whose whole body
//                          is `pendingMouseUpRef.current = false`. It cancels a
//                          STALE latch and starts nothing; letting a claimed
//                          press clear it is correct, since that press is
//                          genuinely a new gesture.
//   useMouseSelection.ts ~1223/~1224  keydown/keyup registered only during a
//                          selection DRAG, and only Ctrl/Meta/Escape are read.
//                          Nothing can be focused inside a claimant while the
//                          user is mid-drag with the button down.
//   useSpreadsheetSelection.ts ~1152/~1243/~1244  the same drag-scoped
//                          mouseup/mousemove pair, plus a one-shot early
//                          mouseup latch. Drag-scoped, so unreachable without
//                          an unclaimed mousedown.
//   useSpreadsheetLayout.ts ~161      capture-phase keydown that only schedules
//                          a repaint of the status bar's mode readout. It reads
//                          no target and changes no document state.
//   Scrollbar.tsx ~150/~151           document mousemove/mouseup registered
//                          only while a scrollbar thumb is being dragged.
//
// ONE rule, one predicate: `isPointerClaimed` / `isKeyClaimed`, both in
// core/lib/pointerClaims.ts, both the same ancestor walk. A door that needs a
// different answer is a signal that the rule is wrong, not that the door
// deserves its own copy of it.

import type React from "react";
import { isPointerClaimed } from "../../lib/pointerClaims";

export interface SplitDragStart {
  axis: "row" | "col";
  startPixel: number;
  startValue: number;
}

export interface GridPointerEntryDeps {
  /** The element the pointer coordinates are measured against. */
  containerRef: React.RefObject<HTMLElement | null>;
  zoom: number;
  /** Which split bar (if any) is under these canvas pixels. */
  hitTestSplitBar: (mouseX: number, mouseY: number) => "row" | "col" | null;
  splitRow: number | null;
  splitCol: number | null;
  /** Begin dragging a split bar. */
  beginSplitDrag: (start: SplitDragStart) => void;
  /** The grid's own mousedown pipeline (selection, overlays, formula refs). */
  onGridMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  /**
   * `[data-focus-container="spreadsheet"]` — the element that HOLDS the grid's
   * keyboard focus. See {@link gridShouldTakeKeyboardFocus}.
   */
  focusContainerRef: React.RefObject<HTMLElement | null>;
  /** True while a cell or formula edit is open. */
  isEditing: () => boolean;
}

/**
 * Elements that take keyboard focus FOR THEMSELVES when they are pressed.
 *
 * Deliberately concrete tags rather than `[tabindex]`: the grid's own focus
 * container carries `tabIndex={0}`, so a `[tabindex]` selector would match it
 * from every target inside the grid and this rule would never fire at all.
 */
const SELF_FOCUSING_SELECTOR =
  'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"])';

/**
 * Should this press move the keyboard to the grid?
 *
 * THE PRESS AND THE KEYBOARD HAD COME APART, and the symptom is a dead app
 * rather than a wrong pixel. `S.SpreadsheetContainer` has `tabIndex={0}` and is
 * where every grid key listener lives, but the grid's cell path calls
 * `preventDefault()` on the mousedown before its first await — which CANCELS the
 * browser's own focus move. Nothing put it back. So once DOM focus had been
 * taken by a `<button>` outside the grid — a task pane's tab, a ribbon control,
 * the Format pane the chart itself opens — clicking back on the grid did
 * everything a click does (moved the cell cursor, selected the chart, walked the
 * element ladder) while the keyboard stayed on the button. Measured live: with
 * the Format pane's Options tab focused, clicking a bar selected that bar and
 * then Escape did NOTHING, because `chartOwnsKeystroke`'s `isGridFocused()` gate
 * — correctly — refused every chart keystroke. A reader has no way to see that,
 * and no way to guess that the cure is to click a CELL first.
 *
 * The grid took the gesture, so the grid takes the keyboard. Three exemptions,
 * each of them a case where somebody else is the rightful subject:
 *
 *  1. AN OPEN EDIT. Clicking a cell while the formula bar or the inline editor
 *     is open is how a reference is PICKED; blurring the editor would break the
 *     gesture it is part of.
 *  2. FOCUS ALREADY INSIDE THE CONTAINER. Then there is nothing to restore, and
 *     moving it would be a change rather than a repair — the inline editor lives
 *     inside this container.
 *  3. A SELF-FOCUSING TARGET. The browser is about to focus that element itself
 *     (the Floating Range's on-canvas `<textarea>`, any widget an extension
 *     stacks on the grid without a pointer claim); pre-empting it would take a
 *     keystroke the user aimed somewhere specific.
 *
 * A CLAIMED press never reaches here — `gridPointerMouseDown` returns first, and
 * for the same reason its header already gives: the claimant and the browser own
 * that press entirely.
 */
export function gridShouldTakeKeyboardFocus(
  target: EventTarget | null,
  activeElement: Element | null,
  focusContainer: HTMLElement | null,
  editing: boolean,
): boolean {
  if (focusContainer === null) return false;
  if (editing) return false;
  // `Node.contains` counts the node itself, so an already-focused container
  // answers "nothing to do" here rather than needing a case of its own.
  if (activeElement !== null && focusContainer.contains(activeElement)) return false;
  const el = target as Partial<Element> | null;
  if (el !== null && typeof el.closest === "function") {
    const self = (el as Element).closest(SELF_FOCUSING_SELECTOR);
    if (self !== null && self !== focusContainer) return false;
  }
  return true;
}

/**
 * Handle a mousedown on the grid area.
 *
 * THE CLAIM CHECK IS FIRST, and it returns WITHOUT `preventDefault()`. That is
 * not an omission — it is the point. An `<input>` inside a claimed rectangle
 * only receives real browser focus if nothing on the way cancelled the default
 * action, and the grid's cell path cancels it before its first await. Returning
 * here leaves the press entirely to the claimant and to the browser.
 */
export function gridPointerMouseDown(
  event: React.MouseEvent<HTMLElement>,
  deps: GridPointerEntryDeps,
): void {
  // A press inside an element that CLAIMED the pointer is not the grid's press.
  // Core does not know, and must not know, what the claimant is: the rule is
  // "an ancestor of the target carries the claim attribute", and any extension
  // can make that claim on its own element (see core/lib/pointerClaims.ts).
  if (isPointerClaimed(event)) return;

  // THE GRID TOOK THE PRESS, SO THE GRID TAKES THE KEYBOARD — restoring the
  // focus move the cell path's own `preventDefault()` cancels. Done BEFORE the
  // split bar and before the grid pipeline, because both of those are equally
  // the grid's gesture and the pipeline is where the `preventDefault()` is.
  // `preventScroll` because this element is the whole viewport: focusing it must
  // never scroll the sheet under the reader.
  const focusContainer = deps.focusContainerRef.current;
  if (
    gridShouldTakeKeyboardFocus(
      event.target,
      typeof document === "undefined" ? null : document.activeElement,
      focusContainer,
      deps.isEditing(),
    )
  ) {
    focusContainer?.focus({ preventScroll: true });
  }

  const rect = deps.containerRef.current?.getBoundingClientRect();
  if (!rect) {
    deps.onGridMouseDown(event);
    return;
  }

  const mouseX = (event.clientX - rect.left) / deps.zoom;
  const mouseY = (event.clientY - rect.top) / deps.zoom;

  const hitBar = deps.hitTestSplitBar(mouseX, mouseY);
  if (hitBar) {
    event.preventDefault();
    event.stopPropagation();
    deps.beginSplitDrag({
      axis: hitBar,
      startPixel: hitBar === "row" ? mouseY : mouseX,
      startValue: hitBar === "row" ? (deps.splitRow ?? 0) : (deps.splitCol ?? 0),
    });
    return;
  }

  deps.onGridMouseDown(event);
}

/**
 * Handle a double-click on the grid area.
 *
 * THE SECOND DOOR THAT CAN ACT. `onDoubleClick` is bound to the very same
 * element as `onMouseDown` and is NOT reached through it, so the claim check in
 * `gridPointerMouseDown` above does nothing for it: double-clicking a word in an
 * on-grid form's text field moved the cell selection to the cell hidden UNDER
 * the card and opened the inline editor on it, while the browser's own
 * select-the-word was still happening in the field.
 *
 * Its only pre-existing guard was `checkOverlayBody` — pure geometry, and it
 * SKIPS every overlay region that publishes no `floating` box
 * (hooks/useMouseSelection/overlayMoveHandlers.ts). An embedded form publishes
 * none deliberately. A shape's control does publish one, which is the only
 * reason M3b's shim was spared: incidentally, by a rule about something else.
 *
 * Guarded here rather than inside `handleDoubleClickEvent` for the reason the
 * module header gives about mousedown: the layer that acts also
 * `preventDefault`s and awaits, so a rule that must stop the grid taking the
 * gesture belongs at the DOM binding, where nothing downstream can get round it.
 * And, as above, it returns WITHOUT `preventDefault()` — cancelling the default
 * action here would kill the text field's own word selection, which is the
 * gesture the user made.
 */
export function gridPointerDoubleClick<E extends HTMLElement>(
  event: React.MouseEvent<E>,
  onGridDoubleClick: (event: React.MouseEvent<E>) => void | Promise<void>,
): void {
  if (isPointerClaimed(event)) return;
  void onGridDoubleClick(event);
}
