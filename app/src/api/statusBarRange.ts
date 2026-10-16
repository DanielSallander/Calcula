//! FILENAME: app/src/api/statusBarRange.ts
// PURPOSE: The cells the status bar aggregates (Sum / Count / Average / ...)
//          INSTEAD of Core's selection, when a floating object owns an inner
//          selection whose cells live in the active sheet's own grid.
// CONTEXT: WP-A (canvas owner findings 2026-10-15, D-CELLS): a canvas pivot's
//          cells are written to the canvas sheet's hidden grid, and a click
//          inside the pivot selects those cells WITHOUT moving Core's
//          selection (the box is a floating object; Core's cursor stays where
//          it was). The status bar only ever read Core's selection, so a
//          selected block of pivot values showed nothing -- or, worse, the
//          aggregate of whatever Core still had selected under the canvas.
//
//          Feature-neutral on purpose: the pivot is the first publisher, any
//          object whose inner selection maps onto cells of the ACTIVE sheet
//          may publish here. The status-bar widget
//          (extensions/BuiltIn/StatusBarAggregation) reads it and nothing
//          else needs to know who published.
//
//          ONE slot, last writer wins -- the same owner rule as
//          `publishExternalCellTarget` (core/lib/formulaEditTarget.ts): a
//          range always replaces the slot; `null` withdraws it only while the
//          caller still holds it, so an object that clears its selection late
//          can never withdraw a range another object published since.
//
//          Imported by its own path (`@api/statusBarRange`), like the Home-tab
//          modules (`@api/cellClipboard`): the barrel belongs to other lanes.

/**
 * Cells of the ACTIVE sheet the status bar aggregates instead of Core's
 * selection (an inner selection of a floating object whose cells live in that
 * sheet's grid -- a canvas pivot's hidden grid). Zero-based, inclusive.
 */
export interface StatusBarRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

interface Slot {
  owner: string;
  range: StatusBarRange;
}

let slot: Slot | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  // A COPY: a listener that unsubscribes (or subscribes) while being notified
  // must not change who hears this notification.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[statusBarRange] listener threw:", err);
    }
  }
}

function isCellIndex(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * The stored form: corners ordered (a drag that ran up-left publishes the
 * same block as one that ran down-right) and frozen, so the value
 * `getStatusBarRange` returns is a stable snapshot no caller can mutate.
 */
function normalize(range: StatusBarRange): StatusBarRange {
  const { startRow, startCol, endRow, endCol } = range;
  if (![startRow, startCol, endRow, endCol].every(isCellIndex)) {
    throw new RangeError(
      `[statusBarRange] a range is four non-negative integer cell indexes; got ${JSON.stringify(range)}`,
    );
  }
  return Object.freeze({
    startRow: Math.min(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    endCol: Math.max(startCol, endCol),
  });
}

function sameRange(a: StatusBarRange, b: StatusBarRange): boolean {
  return a.startRow === b.startRow && a.startCol === b.startCol && a.endRow === b.endRow && a.endCol === b.endCol;
}

/**
 * Single slot, last writer wins; `null` withdraws only when `owner` still
 * holds it (publishExternalCellTarget's rule). Republishing the range the same
 * owner already holds is silent.
 */
export function publishStatusBarRange(owner: string, range: StatusBarRange | null): void {
  if (range === null) {
    if (slot === null || slot.owner !== owner) return;
    slot = null;
    notify();
    return;
  }
  const next = normalize(range);
  const previous = slot;
  slot = { owner, range: next };
  if (previous && previous.owner === owner && sameRange(previous.range, next)) {
    // Keep the snapshot the readers already hold: same owner, same cells.
    slot = previous;
    return;
  }
  notify();
}

/** The published range, or null when Core's selection is what the status bar shows. */
export function getStatusBarRange(): StatusBarRange | null {
  return slot?.range ?? null;
}

/** Called after every change of the slot (publish of a new range, withdrawal). Returns the unsubscribe. */
export function subscribeStatusBarRange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Empty the slot whoever holds it, and tell the listeners if it held a range.
 * Subscriptions are kept: a mounted reader must keep hearing later publishes.
 * Tests only.
 */
export function __resetStatusBarRangeForTests(): void {
  if (slot === null) return;
  slot = null;
  notify();
}
