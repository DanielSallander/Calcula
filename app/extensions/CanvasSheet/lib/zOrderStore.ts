//! FILENAME: app/extensions/CanvasSheet/lib/zOrderStore.ts
// PURPOSE: The canvas's STACKING commands -- Bring Forward, Send Backward,
//          Bring to Front, Send to Back -- and LOCK / UNLOCK, written to the
//          active canvas's layout.
// CONTEXT: A canvas persists one paint order for every family
//          (`CanvasLayout.zOrder`, bottom first) and Core paints and hit-tests
//          by it (lib/canvasStacking.ts is the resolver). Objects MISSING from
//          the list paint above every listed one -- a newly inserted object is
//          on top until something places it -- so the order the user SEES is
//          the EFFECTIVE stack (`stackedFloatingRegions`), not the stored list.
//
//          Every command therefore works on the effective stack and ALWAYS
//          writes the FULL ref list back: after one restack every object on
//          the page is listed, in exactly the order it was painted in apart
//          from the move asked for. Writing only the moved refs would push a
//          later-inserted (unlisted) object from "on top" to wherever the
//          patch left it. Refs of objects no longer on the page are dropped
//          (they are dead; the backend caps the list anyway).
//
//          Lock / unlock writes `locked` the same way: the whole list.
//
//          Both go through `patchActiveCanvasLayout` (lib/canvasActions.ts),
//          the one door every layout change takes. Each is ONE undo step: the
//          backend records a `canvas_stacking` restore whenever the order or
//          the lock list changes (W5, `set_canvas_layout_inner`), so Ctrl+Z
//          puts the previous stack / locks back and Ctrl+Y re-applies them.
//          The page, snap grid and background stay non-undoable view state
//          (decision D1).

import type { CanvasObjectRef } from "@api";
import { getGridRegions, stackedFloatingRegions, type GridRegion } from "@api/gridOverlays";
import { canvasObjectRefKey } from "@api/canvasSheet";
import { getSelectedObjectRegions, objectRefOf } from "@api/objectSelection";
import type { ObjectStackingCommand } from "@api/objectStacking";
import { getCanvasSheetSnapshot } from "./canvasSheetStore";
import { patchActiveCanvasLayout } from "./canvasActions";
import { lockedKeysOf } from "./canvasLocks";

/** The display name of each restack command. */
export const STACKING_LABELS: Readonly<Record<ObjectStackingCommand, string>> = {
  bringForward: "Bring Forward",
  bringToFront: "Bring to Front",
  sendBackward: "Send Backward",
  sendToBack: "Send to Back",
};

// ============================================================================
// Pure
// ============================================================================

/**
 * Apply `command` to a bottom-first key list. The `selected` keys move as a
 * block, keeping their relative order:
 *   - bringToFront / sendToBack: to the top / bottom of the stack;
 *   - bringForward: each selected key swaps with the unselected key right
 *     above it (walked top-down, so a selected run moves up one step together);
 *   - sendBackward: the mirror image.
 * Returns a new list; the input is not changed.
 */
export function restackKeys(
  order: readonly string[],
  selected: ReadonlySet<string>,
  command: ObjectStackingCommand,
): string[] {
  const list = [...order];
  switch (command) {
    case "bringToFront":
      return [...list.filter((k) => !selected.has(k)), ...list.filter((k) => selected.has(k))];
    case "sendToBack":
      return [...list.filter((k) => selected.has(k)), ...list.filter((k) => !selected.has(k))];
    case "bringForward":
      for (let i = list.length - 2; i >= 0; i--) {
        if (selected.has(list[i]) && !selected.has(list[i + 1])) {
          [list[i], list[i + 1]] = [list[i + 1], list[i]];
        }
      }
      return list;
    case "sendBackward":
      for (let i = 1; i < list.length; i++) {
        if (selected.has(list[i]) && !selected.has(list[i - 1])) {
          [list[i], list[i - 1]] = [list[i - 1], list[i]];
        }
      }
      return list;
  }
}

// ============================================================================
// The effective stack
// ============================================================================

/** Distinct refs of `regions`, in the given order (unnamed objects skipped). */
function refsOf(regions: readonly GridRegion[]): CanvasObjectRef[] {
  const seen = new Set<string>();
  const out: CanvasObjectRef[] = [];
  for (const r of regions) {
    const ref = objectRefOf(r);
    if (!ref) continue;
    const key = canvasObjectRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: ref.kind, id: ref.id });
  }
  return out;
}

/**
 * The refs of every object on the active page in PAINT order, bottom first --
 * the order Core stacks them in right now (listed refs by their zOrder index,
 * unlisted ones above them).
 */
export function effectiveStackRefs(regions: readonly GridRegion[] = getGridRegions()): CanvasObjectRef[] {
  return refsOf(stackedFloatingRegions(regions));
}

function sameRefList(a: readonly CanvasObjectRef[], b: readonly CanvasObjectRef[]): boolean {
  return a.length === b.length && a.every((r, i) => r.kind === b[i].kind && r.id === b[i].id);
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Restack the objects behind `regions` (default: the selection) on the active
 * canvas and write the FULL resulting order. Resolves true when a new order
 * was stored; false when not on a canvas, nothing named was given, the order
 * would not change, or the write was refused (the user was told).
 */
export async function restackObjects(
  command: ObjectStackingCommand,
  regions: readonly GridRegion[] = getSelectedObjectRegions(),
): Promise<boolean> {
  const active = getCanvasSheetSnapshot().active;
  if (!active) return false;
  const selected = new Set(refsOf(regions).map(canvasObjectRefKey));
  if (selected.size === 0) return false;
  const stack = effectiveStackRefs();
  const byKey = new Map(stack.map((r) => [canvasObjectRefKey(r), r]));
  const next = restackKeys(
    stack.map(canvasObjectRefKey),
    selected,
    command,
  ).map((k) => byKey.get(k)!);
  const stored = active.layout.zOrder ?? [];
  // Nothing to do only when the stack does not move AND every object is
  // already listed in exactly this order.
  if (sameRefList(next, stack) && sameRefList(stored, next)) return false;
  return patchActiveCanvasLayout({ zOrder: next });
}

/** Whether every object behind `regions` is locked on the active canvas (false for none). */
export function allLocked(regions: readonly GridRegion[]): boolean {
  const active = getCanvasSheetSnapshot().active;
  if (!active) return false;
  const keys = lockedKeysOf(active.layout);
  const refs = refsOf(regions);
  return refs.length > 0 && refs.every((r) => keys.has(canvasObjectRefKey(r)));
}

/**
 * Lock (or unlock) the objects behind `regions` (default: the selection) on
 * the active canvas, writing the FULL resulting `locked` list. Resolves true
 * when a new list was stored.
 */
export async function setObjectsLocked(
  locked: boolean,
  regions: readonly GridRegion[] = getSelectedObjectRegions(),
): Promise<boolean> {
  const active = getCanvasSheetSnapshot().active;
  if (!active) return false;
  const targets = refsOf(regions);
  if (targets.length === 0) return false;
  const current = active.layout.locked ?? [];
  const targetKeys = new Set(targets.map(canvasObjectRefKey));
  let next: CanvasObjectRef[];
  if (locked) {
    const have = new Set(current.map(canvasObjectRefKey));
    next = [...current, ...targets.filter((r) => !have.has(canvasObjectRefKey(r)))];
  } else {
    next = current.filter((r) => !targetKeys.has(canvasObjectRefKey(r)));
  }
  if (sameRefList(next, current)) return false;
  return patchActiveCanvasLayout({ locked: next });
}
