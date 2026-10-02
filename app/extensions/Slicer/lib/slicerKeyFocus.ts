//! FILENAME: app/extensions/Slicer/lib/slicerKeyFocus.ts
// PURPOSE: The keyboard's INNER focus in a selected slicer (M8 S7, BUG-0258
//          design part 2 "Keyboard and touch"): which item the arrow keys are
//          on, and which item Shift+Space extends a run from.
// CONTEXT: Enter on a selected slicer goes INTO it (lib/slicerKeys.ts); the
//          arrows then move a focus ring between its items, Space applies the
//          focused one with the slicer's own click rules, and Escape leaves.
//          This module is only the state and its change listeners -- a LEAF
//          (no store, no @api), so the renderer, the key handler and the
//          object-selection provider can all read it without a cycle.
//
//          THE RULES THIS FILE KEEPS:
//            - VIEW state (plan decision KD2): never saved, never undone, no
//              DocumentEffect, no Tauri command -- the scroll offset's
//              precedent. Nothing here writes to the backend.
//            - An item is identified by its VALUE, never by its index: a
//              refresh can reorder the items, and an index then names another
//              item (the content drag's rule, slicerItemDrag.ts). The slot is
//              kept only as a HINT -- where to look for the nearest item when
//              the focused value is gone.
//            - "Select all" is a slot of its own (slot 0 when it is shown),
//              named by a symbol so no item value can ever collide with it.

/** The focus is on the "Select all" row. */
export const SLICER_SELECT_ALL_FOCUS: unique symbol = Symbol("slicer.keyFocus.selectAll");

/** What the focus is on: an item, by its value, or "Select all". */
export type SlicerFocusValue = string | typeof SLICER_SELECT_ALL_FOCUS;

export interface SlicerKeyFocus {
  /** The slicer the keyboard is inside. */
  readonly slicerId: string;
  /** The item the focus ring is on (by value), or "Select all". */
  readonly value: SlicerFocusValue;
  /**
   * The item last APPLIED from the keyboard (Space / Enter / Ctrl+Space):
   * Shift+Space selects the run from here to the focus. Null before any.
   */
  readonly anchorValue: string | null;
  /** The slot the focus was last resolved at: the nearest-item hint. */
  readonly slotHint: number;
}

let focus: SlicerKeyFocus | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (err) {
      console.error("[Slicer] a key-focus listener threw:", err);
    }
  }
}

/** The live inner focus, or null when the keyboard is not inside a slicer. */
export function getSlicerKeyFocus(): SlicerKeyFocus | null {
  return focus;
}

/** Whether the keyboard is inside some slicer (it owns the arrows and Escape). */
export function isSlicerKeyFocusActive(): boolean {
  return focus !== null;
}

/** Enter a slicer, or move within it. Listeners hear every change. */
export function setSlicerKeyFocus(next: SlicerKeyFocus): void {
  focus = { ...next };
  changed();
}

/** Leave the slicer (no-op, and silent, when the keyboard is not inside one). */
export function leaveSlicerKeyFocus(): void {
  if (focus === null) return;
  focus = null;
  changed();
}

/** Hear every change of the inner focus (enter, move, leave). Returns the unsubscribe. */
export function onSlicerKeyFocusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop the focus WITHOUT telling anyone (deactivation, tests). */
export function resetSlicerKeyFocus(): void {
  focus = null;
}

/**
 * Where the focus is NOW, against the slicer's current items: the slot (0 is
 * "Select all" when it is shown) and the value there. PURE: the painter and
 * the key handler both ask this, so the ring is drawn where the next key
 * acts.
 *
 * - The focused value is still listed: its slot, wherever a refresh moved it.
 * - It is gone (a refresh removed it, or "Select all" was switched off): the
 *   item now at the hinted slot, clamped into the list -- the nearest one.
 * - Nothing is left to focus: null (the focus ends).
 */
export function resolveSlicerFocusSlot(
  f: Pick<SlicerKeyFocus, "value" | "slotHint">,
  itemValues: readonly string[],
  selectAllShown: boolean,
): { slot: number; value: SlicerFocusValue } | null {
  const offset = selectAllShown ? 1 : 0;
  const total = itemValues.length + offset;
  if (total === 0) return null;
  if (f.value === SLICER_SELECT_ALL_FOCUS) {
    if (selectAllShown) return { slot: 0, value: SLICER_SELECT_ALL_FOCUS };
  } else {
    const index = itemValues.indexOf(f.value);
    if (index >= 0) return { slot: index + offset, value: f.value };
  }
  const slot = Math.max(0, Math.min(Math.trunc(f.slotHint), total - 1));
  return { slot, value: slot < offset ? SLICER_SELECT_ALL_FOCUS : itemValues[slot - offset] };
}
