//! FILENAME: app/extensions/_shared/lib/offsetSearch.ts
// PURPOSE: Binary searches over an axis's PREFIX-SUM offsets -- the lookups a
//          scrolled, clipped grid painter needs to turn a pixel range into the
//          rows or columns it shows, and a pixel back into the index under it.
// CONTEXT: Moved here from the canvas pivot box (Pivot/rendering/
//          pivotVisualRenderer.ts), where they were module-private, so that the
//          floating grid (FloatingRange, M7) can scroll with the SAME arithmetic
//          instead of a copy: an extension may not import another extension, and
//          a second spelling of an off-by-one-prone search is exactly the kind of
//          copy that drifts.
//
//          The shape every function assumes: `offsets[i]` is the leading edge of
//          index i and `offsets[i + 1]` its trailing edge, so an array for `n`
//          indexes has `n + 1` entries and `offsets[n]` is the total extent. A
//          zero-size index (a hidden row) has `offsets[i] === offsets[i + 1]` and
//          is never "at" any point.

/** Smallest i in [from, to) with offsets[i + 1] > value, or `to` when none. */
export function firstEndingAfter(offsets: ArrayLike<number>, from: number, to: number, value: number): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Largest i in [from, to) with offsets[i] < value, or `from - 1` when none. */
export function lastStartingBefore(offsets: ArrayLike<number>, from: number, to: number, value: number): number {
  let lo = from;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** The index whose [offsets[i], offsets[i+1]) holds `v` within [from, to), or -1. */
export function indexAt(offsets: ArrayLike<number>, from: number, to: number, v: number): number {
  if (from >= to || v < offsets[from] || v >= offsets[to]) return -1;
  const i = firstEndingAfter(offsets, from, to, v);
  return i < to && offsets[i] <= v ? i : -1;
}
