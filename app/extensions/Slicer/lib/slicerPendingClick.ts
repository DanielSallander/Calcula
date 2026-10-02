//! FILENAME: app/extensions/Slicer/lib/slicerPendingClick.ts
// PURPOSE: The slicer's PENDING CLICK — armed by a left press on a slicer body
//          (`floatingObject:selected`), completed by the next `mouseup`
//          anywhere, which narrows a kept multi-selection to the slicer
//          pressed. A press on the slicer's CONTENT (an item, a button, the
//          scrollbar) TAKES it at `floatingObject:bodyDragStart`: that press is
//          the item drag's (lib/slicerItemDrag.ts), which acts at its own
//          release. It used to toggle whatever item sat under the pointer at
//          the mouseup -- a press on an item could not also be a drag.
// CONTEXT: It lived as a private `let` in index.ts. It is a module of its own so
//          the one rule about it can be tested: ONLY a real mouse press may arm
//          it. A keyboard or script selection (@api/objectSelection) that armed
//          it would turn the user's next unrelated mouseup — anywhere on screen
//          — into a click on this slicer (it once toggled the item under the
//          pointer; today it would narrow the user's multi-selection).

export interface PendingSlicerClick {
  slicerId: string;
  /** Narrow a kept multi-selection to this slicer on mouseup (the press did
   *  not, because the user might have been starting a group drag). */
  deferNarrow?: boolean;
}

let pending: PendingSlicerClick | null = null;

/** Arm the click a mouse press on a slicer body starts. */
export function armPendingSlicerClick(click: PendingSlicerClick): void {
  pending = click;
}

/** Take (and clear) the armed click, if any — the mouseup's job. */
export function takePendingSlicerClick(): PendingSlicerClick | null {
  const click = pending;
  pending = null;
  return click;
}

/** Drop an armed click (a drag completed, the extension deactivated). */
export function clearPendingSlicerClick(): void {
  pending = null;
}

/** The armed click, left in place. For tests and diagnostics. */
export function peekPendingSlicerClick(): PendingSlicerClick | null {
  return pending;
}
